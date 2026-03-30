# sst/opencode Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in adapter for sst/opencode to OpenLobby, enabling management of OpenCode sessions through the unified IM-style interface.

**Architecture:** The adapter spawns `opencode serve` as a subprocess via `@opencode-ai/sdk`, communicates over HTTP REST for commands, and subscribes to SSE for real-time streaming events. One server process is shared across all sessions.

**Tech Stack:** TypeScript, `@opencode-ai/sdk@^1.3.7`, SSE (AsyncGenerator), HTTP REST

---

### Task 1: Add `@opencode-ai/sdk` dependency

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add the dependency**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/core add @opencode-ai/sdk@^1.3.7
```

- [ ] **Step 2: Verify installation**

Run: `ls node_modules/@opencode-ai/sdk/dist/index.js`
Expected: File exists

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json pnpm-lock.yaml
git commit -m "chore: add @opencode-ai/sdk dependency to core package"
```

---

### Task 2: Implement `OpenCodeProcess` (AgentProcess)

**Files:**
- Create: `packages/core/src/adapters/opencode.ts`

- [ ] **Step 1: Create the file with imports, helpers, and OpenCodeProcess class**

Create `packages/core/src/adapters/opencode.ts` with the full content below:

```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import type {
  AgentAdapter,
  AgentProcess,
  SpawnOptions,
  ResumeOptions,
  LobbyMessage,
  SessionSummary,
  ControlDecision,
  AdapterCommand,
} from '../types.js';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeLobbyMessage(
  sessionId: string,
  type: LobbyMessage['type'],
  content: string | Record<string, unknown>,
  meta?: LobbyMessage['meta'],
): LobbyMessage {
  return {
    id: randomUUID(),
    sessionId,
    timestamp: Date.now(),
    type,
    content,
    meta,
  };
}

const PLAN_MODE_SYSTEM_PROMPT = `You are in PLAN MODE. Only explore the codebase and produce a detailed implementation plan. Do NOT modify any files. Use only read-only tools.`;

/** Static fallback commands before server is available */
const FALLBACK_COMMANDS: AdapterCommand[] = [
  { name: '/compact', description: 'Compact conversation to save context' },
  { name: '/help', description: 'Show help information' },
];

// ──────────────────────────────────────────────
// OpenCodeProcess
// ──────────────────────────────────────────────

class OpenCodeProcess extends EventEmitter implements AgentProcess {
  sessionId: string;
  readonly adapter = 'opencode';
  status: AgentProcess['status'] = 'idle';

  private spawnOptions: SpawnOptions;
  private planMode = false;
  private sseAbortController = new AbortController();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  /** Track seen TextPart IDs to distinguish delta vs final */
  private seenTextParts = new Set<string>();
  /** Track seen ToolPart IDs to avoid duplicate tool_use emissions */
  private emittedToolUseIds = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(sessionId: string, options: SpawnOptions, client: any) {
    super();
    this.sessionId = sessionId;
    this.spawnOptions = options;
    this.client = client;
  }

  /**
   * Subscribe to the SSE event stream and dispatch events.
   * Called once after construction.
   */
  async subscribeSSE(): Promise<void> {
    try {
      const result = await this.client.event.subscribe({
        signal: this.sseAbortController.signal,
      });

      // Process SSE events in background (don't await — it's infinite)
      this.consumeStream(result.stream).catch((err: unknown) => {
        if (this.sseAbortController.signal.aborted) return;
        console.error('[OpenCode] SSE stream error:', err);
        this.status = 'error';
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    } catch (err) {
      if (this.sseAbortController.signal.aborted) return;
      console.error('[OpenCode] SSE subscribe failed:', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async consumeStream(stream: AsyncGenerator<any>): Promise<void> {
    for await (const event of stream) {
      if (this.sseAbortController.signal.aborted) break;
      this.handleSSEEvent(event);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSSEEvent(event: any): void {
    const type = event.type as string;

    // Filter events to only this session
    const sessionID =
      event.properties?.sessionID ??
      event.properties?.info?.sessionID ??
      event.properties?.part?.sessionID;
    if (sessionID && sessionID !== this.sessionId) return;

    switch (type) {
      case 'message.part.updated':
        this.handlePartUpdated(event.properties);
        break;

      case 'message.updated':
        this.handleMessageUpdated(event.properties);
        break;

      case 'permission.updated':
        this.handlePermissionUpdated(event.properties);
        break;

      case 'session.status':
        this.handleSessionStatus(event.properties);
        break;

      case 'session.idle':
        console.log('[OpenCode] Session idle:', this.sessionId);
        this.status = 'idle';
        this.emit('idle');
        break;

      case 'session.error':
        this.handleSessionError(event.properties);
        break;

      default:
        // Ignore other events (lsp.*, pty.*, tui.*, file.edited, etc.)
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlePartUpdated(props: any): void {
    const part = props.part;
    const delta = props.delta as string | undefined;

    if (!part) return;

    switch (part.type) {
      case 'text': {
        if (delta) {
          // Streaming text delta
          this.emit('message', makeLobbyMessage(this.sessionId, 'stream_delta', delta));
        } else if (part.text && !this.seenTextParts.has(part.id)) {
          // Final text content (no delta = completed text part)
          this.seenTextParts.add(part.id);
          this.emit('message', makeLobbyMessage(this.sessionId, 'assistant', part.text));
        }
        break;
      }

      case 'tool': {
        const state = part.state;
        if (!state) break;

        if (state.status === 'pending' || state.status === 'running') {
          // Only emit tool_use once per tool call
          if (!this.emittedToolUseIds.has(part.callID)) {
            this.emittedToolUseIds.add(part.callID);
            this.emit(
              'message',
              makeLobbyMessage(
                this.sessionId,
                'tool_use',
                JSON.stringify(state.input ?? {}, null, 2),
                { toolName: part.tool },
              ),
            );
          }
        } else if (state.status === 'completed') {
          this.emit(
            'message',
            makeLobbyMessage(
              this.sessionId,
              'tool_result',
              state.output ?? '',
              { toolName: part.tool },
            ),
          );
        } else if (state.status === 'error') {
          this.emit(
            'message',
            makeLobbyMessage(
              this.sessionId,
              'tool_result',
              state.error ?? 'Tool execution failed',
              { toolName: part.tool, isError: true },
            ),
          );
        }
        break;
      }

      // Ignore reasoning, step-start, step-finish, snapshot, patch, agent, retry, compaction
      default:
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessageUpdated(props: any): void {
    const info = props.info;
    if (!info || info.role !== 'assistant') return;

    // Only emit result when the message is completed (has time.completed)
    if (!info.time?.completed) return;

    this.emit(
      'message',
      makeLobbyMessage(
        this.sessionId,
        'result',
        {
          cost: info.cost,
          tokens: info.tokens,
          finish: info.finish,
        },
        {
          model: info.modelID,
          costUsd: info.cost,
          tokenUsage: info.tokens
            ? { input: info.tokens.input, output: info.tokens.output }
            : undefined,
        },
      ),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlePermissionUpdated(props: any): void {
    if (!props.id) return;

    console.log('[OpenCode] Permission requested:', props.title, 'id:', props.id);
    this.status = 'awaiting_approval';

    this.emit(
      'message',
      makeLobbyMessage(this.sessionId, 'control', {
        requestId: props.id,
        toolName: props.title ?? props.type ?? 'unknown',
        toolInput: props.metadata ?? {},
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSessionStatus(props: any): void {
    const statusType = props.status?.type;
    if (statusType === 'busy') {
      this.status = 'running';
    } else if (statusType === 'idle') {
      this.status = 'idle';
    }
    // 'retry' status — keep current status
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSessionError(props: any): void {
    console.error('[OpenCode] Session error:', props.error ?? props);
    this.status = 'error';

    this.emit(
      'message',
      makeLobbyMessage(
        this.sessionId,
        'system',
        { error: props.error ?? 'Unknown session error' },
        { isError: true },
      ),
    );
    this.emit('error', new Error(props.error ?? 'Unknown session error'));
  }

  // ── Public API (AgentProcess) ──

  sendMessage(content: string): void {
    console.log('[OpenCode] sendMessage:', content.slice(0, 100));
    this.status = 'running';

    // Reset tracking sets for new turn
    this.seenTextParts.clear();
    this.emittedToolUseIds.clear();

    // Build prompt body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      parts: [{ type: 'text' as const, text: content }],
    };

    if (this.planMode) {
      body.system = PLAN_MODE_SYSTEM_PROMPT;
    }

    this.client.session
      .promptAsync({
        path: { id: this.sessionId },
        body,
      })
      .then(() => {
        console.log('[OpenCode] promptAsync accepted');
      })
      .catch((err: unknown) => {
        console.error('[OpenCode] promptAsync failed:', err);
        this.status = 'error';
        this.emit(
          'message',
          makeLobbyMessage(
            this.sessionId,
            'system',
            { error: err instanceof Error ? err.message : String(err) },
            { isError: true },
          ),
        );
      });
  }

  respondControl(requestId: string, decision: ControlDecision): void {
    console.log('[OpenCode] Control response:', requestId, decision);

    const reply = decision === 'allow' ? 'once' : 'reject';

    this.client
      .postSessionIdPermissionsPermissionId({
        path: { id: this.sessionId, permissionID: requestId },
        body: { response: reply },
      })
      .then(() => {
        console.log('[OpenCode] Permission replied:', requestId, reply);
      })
      .catch((err: unknown) => {
        console.warn('[OpenCode] Permission reply failed:', err);
      });
  }

  updateOptions(opts: Partial<SpawnOptions>): void {
    Object.assign(this.spawnOptions, opts);
    console.log('[OpenCode] Options updated:', Object.keys(opts));
  }

  setPlanMode(enabled: boolean): void {
    this.planMode = enabled;
    console.log('[OpenCode] Plan mode:', enabled ? 'ON' : 'OFF');
  }

  kill(): void {
    console.log('[OpenCode] Killing process');
    this.sseAbortController.abort();

    // Abort the session (best-effort, don't block)
    this.client.session
      .abort({ path: { id: this.sessionId } })
      .catch(() => {});

    this.status = 'stopped';
    this.emit('exit', 0);
  }
}

// ──────────────────────────────────────────────
// OpenCodeAdapter
// ──────────────────────────────────────────────

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';

  private serverInstance: { url: string; close(): void } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientInstance: any | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async ensureServer(): Promise<any> {
    if (this.clientInstance) return this.clientInstance;

    const { createOpencode } = await import('@opencode-ai/sdk');
    const { client, server } = await createOpencode();
    this.serverInstance = server;
    this.clientInstance = client;

    console.log('[OpenCode] Server started at:', server.url);
    return this.clientInstance;
  }

  async detect(): Promise<{ installed: boolean; version?: string; path?: string }> {
    try {
      const version = execSync('opencode --version', { encoding: 'utf-8' }).trim();
      const cliPath = execSync('which opencode', { encoding: 'utf-8' }).trim();
      return { installed: true, version, path: cliPath };
    } catch {
      return { installed: false };
    }
  }

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const client = await this.ensureServer();

    // Create a new session
    const result = await client.session.create({
      body: { title: `OpenLobby session` },
    });

    const session = result.data;
    const sessionId = session.id as string;
    console.log('[OpenCodeAdapter] Session created:', sessionId);

    const proc = new OpenCodeProcess(sessionId, options, client);

    // Subscribe to SSE in background
    await proc.subscribeSSE();

    // Fetch commands in background
    this.fetchCommands(client, proc);

    return proc;
  }

  async resume(sessionId: string, options?: ResumeOptions): Promise<AgentProcess> {
    const client = await this.ensureServer();

    // Verify session exists
    const result = await client.session.get({
      path: { id: sessionId },
    });

    if (!result.data) {
      throw new Error(`OpenCode session not found: ${sessionId}`);
    }

    console.log('[OpenCodeAdapter] Resuming session:', sessionId);

    const proc = new OpenCodeProcess(sessionId, {
      cwd: options?.cwd ?? process.cwd(),
      systemPrompt: options?.systemPrompt,
      permissionMode: options?.permissionMode,
      model: options?.model,
    }, client);

    await proc.subscribeSSE();
    this.fetchCommands(client, proc);

    return proc;
  }

  getSessionStoragePath(): string {
    return '.opencode';
  }

  async readSessionHistory(sessionId: string): Promise<LobbyMessage[]> {
    let client;
    try {
      client = await this.ensureServer();
    } catch {
      return [];
    }

    try {
      const result = await client.session.messages({
        path: { id: sessionId },
      });

      const messages: LobbyMessage[] = [];
      const items = result.data as Array<{
        info: { id: string; role: string; sessionID: string; time: { created: number; completed?: number }; modelID?: string; cost?: number; tokens?: { input: number; output: number } };
        parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string }; callID?: string; id: string }>;
      }>;

      if (!Array.isArray(items)) return [];

      for (const item of items) {
        const info = item.info;
        const timestamp = info.time?.created ? info.time.created * 1000 : Date.now();

        if (info.role === 'user') {
          // Extract text from user message parts
          for (const part of item.parts) {
            if (part.type === 'text' && part.text) {
              messages.push({
                id: part.id ?? randomUUID(),
                sessionId,
                timestamp,
                type: 'user',
                content: part.text,
              });
            }
          }
        } else if (info.role === 'assistant') {
          for (const part of item.parts) {
            if (part.type === 'text' && part.text) {
              messages.push({
                id: part.id ?? randomUUID(),
                sessionId,
                timestamp,
                type: 'assistant',
                content: part.text,
                meta: { model: info.modelID },
              });
            } else if (part.type === 'tool' && part.state) {
              if (part.state.status === 'completed' || part.state.status === 'error') {
                messages.push({
                  id: `${part.id}-use`,
                  sessionId,
                  timestamp,
                  type: 'tool_use',
                  content: JSON.stringify(part.state.input ?? {}, null, 2),
                  meta: { toolName: part.tool },
                });
                messages.push({
                  id: `${part.id}-result`,
                  sessionId,
                  timestamp,
                  type: 'tool_result',
                  content: part.state.output ?? part.state.error ?? '',
                  meta: { toolName: part.tool, isError: part.state.status === 'error' },
                });
              }
            }
          }
        }
      }

      return messages;
    } catch {
      return [];
    }
  }

  async discoverSessions(): Promise<SessionSummary[]> {
    let client;
    try {
      client = await this.ensureServer();
    } catch {
      return [];
    }

    try {
      const result = await client.session.list();
      const sessions = result.data as Array<{
        id: string;
        title: string;
        directory: string;
        time: { created: number; updated: number };
      }>;

      if (!Array.isArray(sessions)) return [];

      return sessions.map((s) => ({
        id: s.id,
        adapterName: this.name,
        displayName: s.title || s.id.slice(0, 8),
        status: 'stopped',
        lastActiveAt: s.time.updated * 1000,
        messageCount: 0,
        cwd: s.directory ?? process.cwd(),
        origin: 'cli' as const,
        resumeCommand: this.getResumeCommand(s.id),
      }));
    } catch {
      return [];
    }
  }

  getResumeCommand(sessionId: string): string {
    return `opencode --session=${sessionId}`;
  }

  async listCommands(): Promise<AdapterCommand[]> {
    return FALLBACK_COMMANDS;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private fetchCommands(client: any, proc: OpenCodeProcess): void {
    client.command
      .list()
      .then((result: { data: Array<{ name: string; description?: string }> }) => {
        if (!Array.isArray(result.data)) {
          proc.emit('commands', FALLBACK_COMMANDS);
          return;
        }
        const commands: AdapterCommand[] = result.data.map(
          (c: { name: string; description?: string }) => ({
            name: c.name.startsWith('/') ? c.name : `/${c.name}`,
            description: c.description ?? '',
          }),
        );
        console.log(`[OpenCode] Commands fetched: ${commands.length}`);
        proc.emit('commands', commands);
      })
      .catch(() => {
        proc.emit('commands', FALLBACK_COMMANDS);
      });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/core build`
Expected: Compilation succeeds (the file is not yet exported, so no downstream issues)

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/adapters/opencode.ts
git commit -m "feat: implement OpenCode adapter (AgentProcess + AgentAdapter)"
```

---

### Task 3: Export and register as built-in adapter

**Files:**
- Modify: `packages/core/src/adapters/index.ts`
- Modify: `packages/server/src/adapters/index.ts`

- [ ] **Step 1: Export from core adapters index**

In `packages/core/src/adapters/index.ts`, add the export:

```typescript
export { ClaudeCodeAdapter } from './claude-code.js';
export { CodexCliAdapter } from './codex-cli.js';
export { OpenCodeAdapter } from './opencode.js';
```

- [ ] **Step 2: Register in server's built-in adapters**

In `packages/server/src/adapters/index.ts`, import and register:

```typescript
import type { AgentAdapter, AdapterPluginModule } from '@openlobby/core';
import { ClaudeCodeAdapter, CodexCliAdapter, OpenCodeAdapter } from '@openlobby/core';

/** Built-in adapters — always available */
export function createBuiltinAdapters(): AgentAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexCliAdapter(), new OpenCodeAdapter()];
}
```

- [ ] **Step 3: Build all packages to verify**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm -r build`
Expected: All packages compile successfully

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/adapters/index.ts packages/server/src/adapters/index.ts
git commit -m "feat: register OpenCode as built-in adapter"
```

---

### Task 4: Integration test using adapter contract

**Files:**
- Create: `packages/core/src/adapters/__tests__/opencode.integration.test.ts`

- [ ] **Step 1: Create the integration test file**

Create `packages/core/src/adapters/__tests__/opencode.integration.test.ts`:

```typescript
/**
 * OpenCode Adapter Integration Tests
 *
 * Requires `opencode` CLI to be installed.
 * Run with: pnpm --filter @openlobby/core test -- --grep "opencode"
 */
import { createAdapterIntegrationTests } from './adapter-contract.js';
import { OpenCodeAdapter } from '../opencode.js';

createAdapterIntegrationTests(() => new OpenCodeAdapter(), {
  simplePrompt: 'Reply with exactly the word: HELLO_TEST',
});
```

- [ ] **Step 2: Verify test file compiles**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/core build`
Expected: Compilation succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/adapters/__tests__/opencode.integration.test.ts
git commit -m "test: add OpenCode adapter integration test using contract suite"
```

---

### Task 5: Build verification

**Files:** None (verification only)

- [ ] **Step 1: Full build**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm -r build`
Expected: All packages build successfully

- [ ] **Step 2: Run unit tests (excluding integration)**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/core test`
Expected: Existing tests pass. The new integration test may skip if `opencode` is not installed.

- [ ] **Step 3: Verify adapter is detected at runtime**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && node -e "import('@openlobby/core').then(m => { const a = new m.OpenCodeAdapter(); a.detect().then(r => console.log('detect:', r)); })"`
Expected: `{ installed: true, version: '...', path: '...' }` if opencode is installed, or `{ installed: false }` if not.

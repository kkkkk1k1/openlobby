# GSD Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a built-in OpenLobby adapter for GSD-2 CLI (`gsd` binary, `gsd-pi` npm package) using headless supervised subprocess mode.

**Architecture:** Single-file adapter at `packages/core/src/adapters/gsd.ts` containing `GsdProcess` (EventEmitter-based subprocess manager with JSONL protocol) and `GsdAdapter` (implements AgentAdapter interface). Uses `gsd headless --supervised --output-format stream-json` for bidirectional JSONL communication over stdin/stdout.

**Tech Stack:** TypeScript, Node.js child_process, JSONL parsing

---

### Task 1: Implement GsdProcess and GsdAdapter

**Files:**
- Create: `packages/core/src/adapters/gsd.ts`

- [ ] **Step 1: Create the GSD adapter file with all imports and constants**

```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn as spawnChild, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type {
  AgentAdapter,
  AgentProcess,
  SpawnOptions,
  ResumeOptions,
  LobbyMessage,
  SessionSummary,
  ControlDecision,
  AdapterCommand,
  AdapterPermissionMeta,
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

/** System prompt injected when plan mode is active */
const GSD_PLAN_MODE_PROMPT = `You are in PLAN MODE. Only analyze, explore (read files, search), and plan. Do NOT write, edit, create, or delete any files. Do NOT execute any commands that modify the system. Only use read-only tools.`;

/** Static commands for GSD CLI */
const GSD_COMMANDS: AdapterCommand[] = [
  { name: '/gsd', description: 'Open GSD menu' },
  { name: '/gsd auto', description: 'Run autonomous mode' },
  { name: '/gsd quick', description: 'Quick task execution' },
  { name: '/gsd discuss', description: 'Discuss phase approach' },
  { name: '/gsd status', description: 'Show project status' },
  { name: '/gsd queue', description: 'Show task queue' },
  { name: '/gsd prefs', description: 'Open preferences' },
  { name: '/gsd stop', description: 'Stop current execution' },
  { name: '/gsd logs', description: 'View execution logs' },
  { name: '/gsd doctor', description: 'Run diagnostics' },
];
```

- [ ] **Step 2: Implement GsdProcess class**

```typescript
// ──────────────────────────────────────────────
// GsdProcess
// ──────────────────────────────────────────────

/**
 * Represents a running GSD CLI session via `gsd headless --supervised --output-format stream-json`.
 *
 * Communication: JSONL over stdin/stdout.
 * - Stdout: Streaming events (init_result, message_update, tool_execution_*, etc.)
 * - Stdin: extension_ui_response messages for approval handling
 */
class GsdProcess extends EventEmitter implements AgentProcess {
  sessionId: string;
  readonly adapter = 'gsd';
  status: AgentProcess['status'] = 'idle';

  private childProcess: ChildProcess | null = null;
  private pendingControls = new Map<
    string,
    { resolve: (decision: ControlDecision) => void; timer: NodeJS.Timeout }
  >();
  private lineBuffer = '';
  private spawnOptions: SpawnOptions;
  private killedIntentionally = false;
  private lastCost: { total?: number; input_tokens?: number; output_tokens?: number } = {};
  /** Accumulated text from text_delta events, flushed on text_end */
  private textBuffer = '';
  private resumeId: string | undefined;

  constructor(sessionId: string, options: SpawnOptions, resumeId?: string) {
    super();
    this.sessionId = sessionId;
    this.spawnOptions = options;
    this.resumeId = resumeId;
  }

  /**
   * Start the headless subprocess. Does NOT send a prompt — the caller
   * must wire event listeners first, then call sendMessage().
   */
  async init(mode: 'spawn' | 'resume', resumeSessionId?: string): Promise<void> {
    // Build command arguments
    const args = ['headless'];

    // Add flags
    args.push('--supervised');
    args.push('--output-format', 'stream-json');

    if (mode === 'resume' && resumeSessionId) {
      args.push('--resume', resumeSessionId);
      this.resumeId = resumeSessionId;
    }

    if (this.spawnOptions.model) {
      args.push('--model', this.spawnOptions.model);
    }

    const env = { ...process.env };
    if (this.spawnOptions.apiKey) {
      env.ANTHROPIC_API_KEY = this.spawnOptions.apiKey;
    }

    console.log('[GSD] Spawning:', 'gsd', args.join(' '));

    this.childProcess = spawnChild('gsd', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.spawnOptions.cwd,
      env,
    });

    this.childProcess.stdout!.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk.toString('utf-8'));
    });

    this.childProcess.stderr!.on('data', (chunk: Buffer) => {
      console.error('[GSD stderr]', chunk.toString('utf-8'));
    });

    this.childProcess.on('exit', (code) => {
      console.log(`[GSD] Process exited with code ${code}`);
      if (!this.killedIntentionally) {
        this.status = code === 0 ? 'stopped' : 'error';
      }
      this.childProcess = null;
      this.emit('exit', code ?? 1);
    });

    this.childProcess.on('error', (err) => {
      console.error('[GSD] Process error:', err);
      this.status = 'error';
      this.emit('error', err);
    });

    this.status = 'idle';

    // Emit system message with initial session ID
    this.emit('message', makeLobbyMessage(this.sessionId, 'system', {
      sessionId: this.sessionId,
      adapter: 'gsd',
    }));

    // Emit static commands
    this.emit('commands', GSD_COMMANDS);
  }

  // ── Public API (AgentProcess) ──

  sendMessage(content: string): void {
    if (!this.childProcess?.stdin?.writable) {
      console.warn('[GSD] stdin not writable');
      return;
    }

    this.status = 'running';
    console.log('[GSD] Sending message:', content.slice(0, 100));

    // GSD headless expects the prompt as a JSONL message on stdin
    // or as the positional argument. For multi-turn, write to stdin.
    const msg = JSON.stringify({ type: 'user_message', content }) + '\n';
    this.childProcess.stdin.write(msg);
  }

  respondControl(requestId: string, decision: ControlDecision): void {
    const pending = this.pendingControls.get(requestId);
    if (!pending) {
      console.warn('[GSD] No pending control for:', requestId);
      return;
    }

    console.log('[GSD] Control response:', requestId, decision);
    clearTimeout(pending.timer);
    this.pendingControls.delete(requestId);

    // Send extension_ui_response back to GSD
    const response = {
      type: 'extension_ui_response',
      id: requestId,
      confirmed: decision === 'allow',
      cancelled: decision === 'deny',
    };
    this.writeRaw(response);

    this.status = 'running';
  }

  updateOptions(opts: Partial<SpawnOptions>): void {
    Object.assign(this.spawnOptions, opts);
    console.log('[GSD] Options updated:', Object.keys(opts));
  }

  interrupt(): void {
    if (this.status !== 'running' && this.status !== 'awaiting_approval') return;
    console.log('[GSD] Interrupting current generation');
    this.killedIntentionally = true;
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.status = 'idle';
    this.emit('idle');
  }

  kill(): void {
    console.log('[GSD] Killing process');
    this.killedIntentionally = true;

    // Resolve all pending controls with deny
    for (const [requestId, pending] of this.pendingControls) {
      clearTimeout(pending.timer);
      pending.resolve('deny');
      this.pendingControls.delete(requestId);
    }

    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.status = 'stopped';
    this.emit('exit', 0);
  }

  // ── Internal transport ──

  private writeRaw(obj: unknown): void {
    if (!this.childProcess?.stdin?.writable) {
      console.warn('[GSD] stdin not writable');
      return;
    }
    const line = JSON.stringify(obj) + '\n';
    this.childProcess.stdin.write(line);
  }

  // ── JSONL parsing from stdout ──

  private handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        console.warn('[GSD] Failed to parse line:', line.slice(0, 200));
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleEvent(event: any): void {
    const type = event.type as string;
    console.log('[GSD] <<', type, JSON.stringify(event).slice(0, 300));

    switch (type) {
      case 'init_result': {
        // Sync session ID from GSD
        const realId = event.sessionId ?? event.session_id;
        if (realId && realId !== this.sessionId) {
          this.sessionId = realId;
          this.emit('message', makeLobbyMessage(realId, 'system', JSON.stringify({ sessionId: realId })));
        }
        this.status = 'running';
        break;
      }

      case 'message_update': {
        const subType = event.subType ?? event.sub_type ?? event.event;
        if (subType === 'text_delta' || subType === 'thinking_delta') {
          const text = event.text ?? event.delta ?? '';
          if (text) {
            this.textBuffer += text;
            this.emit('message', makeLobbyMessage(this.sessionId, 'stream_delta', text));
          }
        } else if (subType === 'text_end' || subType === 'thinking_end') {
          if (this.textBuffer) {
            this.emit('message', makeLobbyMessage(this.sessionId, 'assistant', this.textBuffer));
            this.textBuffer = '';
          }
        } else if (subType === 'text_start' || subType === 'thinking_start') {
          this.textBuffer = '';
        }
        break;
      }

      case 'tool_execution_start': {
        const toolName = event.toolName ?? event.tool_name ?? event.name ?? 'unknown';
        const toolInput = event.input ?? event.arguments ?? event.params ?? {};
        this.emit('message', makeLobbyMessage(
          this.sessionId,
          'tool_use',
          typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2),
          { toolName },
        ));
        break;
      }

      case 'tool_execution_end': {
        const toolName = event.toolName ?? event.tool_name ?? event.name;
        const output = event.output ?? event.result ?? '';
        this.emit('message', makeLobbyMessage(
          this.sessionId,
          'tool_result',
          typeof output === 'string' ? output : JSON.stringify(output),
          { toolName, isError: event.isError ?? event.is_error ?? false },
        ));
        break;
      }

      case 'extension_ui_request': {
        const requestId = event.id ?? randomUUID();
        const requestType = event.requestType ?? event.request_type ?? 'confirm';
        const message = event.message ?? event.prompt ?? event.title ?? '';
        const toolName = `gsd:${requestType}`;

        console.log('[GSD] Approval requested:', requestType, message);

        const mode = this.spawnOptions.permissionMode ?? 'supervised';

        // Auto mode: approve immediately
        if (mode === 'auto') {
          console.log('[GSD] Auto mode: approved', requestType);
          this.writeRaw({
            type: 'extension_ui_response',
            id: requestId,
            confirmed: true,
            cancelled: false,
            value: event.options?.[0]?.value ?? '',
          });
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_result',
            `[Auto] Approved: ${message}`,
            { toolName },
          ));
          return;
        }

        // Readonly mode: auto-deny
        if (mode === 'readonly') {
          console.log('[GSD] Readonly mode: auto-denying', requestType);
          this.writeRaw({
            type: 'extension_ui_response',
            id: requestId,
            confirmed: false,
            cancelled: true,
          });
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_result',
            `[Readonly mode] Denied: ${message}`,
            { toolName },
          ));
          return;
        }

        // Supervised mode: emit control and wait
        this.status = 'awaiting_approval';
        this.emit('message', makeLobbyMessage(this.sessionId, 'control', {
          requestId,
          toolName,
          toolInput: { requestType, message, options: event.options },
        }));

        // Set up timeout (5 minutes)
        const timer = setTimeout(() => {
          if (this.pendingControls.has(requestId)) {
            console.log('[GSD] Approval timeout, auto-denying:', requestId);
            this.pendingControls.delete(requestId);
            this.writeRaw({
              type: 'extension_ui_response',
              id: requestId,
              confirmed: false,
              cancelled: true,
            });
            this.status = 'running';
          }
        }, 5 * 60 * 1000);

        this.pendingControls.set(requestId, {
          resolve: (decision: ControlDecision) => {
            this.writeRaw({
              type: 'extension_ui_response',
              id: requestId,
              confirmed: decision === 'allow',
              cancelled: decision === 'deny',
            });
          },
          timer,
        });
        break;
      }

      case 'cost_update': {
        // Store cost info for the result message
        if (event.total != null) this.lastCost.total = event.total;
        if (event.input_tokens != null) this.lastCost.input_tokens = event.input_tokens;
        if (event.output_tokens != null) this.lastCost.output_tokens = event.output_tokens;
        break;
      }

      case 'execution_complete':
      case 'agent_end': {
        // Flush any remaining text buffer
        if (this.textBuffer) {
          this.emit('message', makeLobbyMessage(this.sessionId, 'assistant', this.textBuffer));
          this.textBuffer = '';
        }

        this.status = 'idle';
        this.emit('message', makeLobbyMessage(this.sessionId, 'result', {
          subtype: 'success',
          sessionId: event.sessionId ?? this.sessionId,
        }, {
          costUsd: this.lastCost.total,
          tokenUsage: (this.lastCost.input_tokens != null || this.lastCost.output_tokens != null)
            ? { input: this.lastCost.input_tokens ?? 0, output: this.lastCost.output_tokens ?? 0 }
            : undefined,
        }));
        this.lastCost = {};
        this.emit('idle');
        break;
      }

      default:
        // Unknown event — log for debugging
        console.log('[GSD] Unknown event:', type, JSON.stringify(event).slice(0, 200));
        break;
    }
  }
}
```

- [ ] **Step 3: Implement GsdAdapter class**

```typescript
// ──────────────────────────────────────────────
// GsdAdapter
// ──────────────────────────────────────────────

export class GsdAdapter implements AgentAdapter {
  readonly name = 'gsd';
  readonly displayName = 'GSD';
  readonly permissionMeta: AdapterPermissionMeta = {
    modeLabels: {
      auto: 'auto-approve',
      supervised: 'supervised',
      readonly: 'readonly + plan',
    },
  };

  async detect(): Promise<{ installed: boolean; version?: string; path?: string }> {
    try {
      const version = execSync('gsd --version', { encoding: 'utf-8' }).trim();
      const cliPath = execSync('which gsd', { encoding: 'utf-8' }).trim();
      return { installed: true, version, path: cliPath };
    } catch {
      return { installed: false };
    }
  }

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const sessionId = randomUUID();
    console.log('[GsdAdapter] Spawning session:', sessionId);
    const proc = new GsdProcess(sessionId, options);
    await proc.init('spawn');
    return proc;
  }

  async resume(sessionId: string, options?: ResumeOptions): Promise<AgentProcess> {
    const proc = new GsdProcess(sessionId, {
      cwd: options?.cwd ?? process.cwd(),
      systemPrompt: options?.systemPrompt,
      model: options?.model,
      mcpServers: options?.mcpServers,
      apiKey: options?.apiKey,
      permissionMode: options?.permissionMode,
    }, sessionId);
    await proc.init('resume', sessionId);
    return proc;
  }

  getSessionStoragePath(): string {
    return join(homedir(), '.gsd', 'sessions');
  }

  async readSessionHistory(sessionId: string): Promise<LobbyMessage[]> {
    const filePath = this.findSessionFile(sessionId);
    if (!filePath) return [];

    const messages: LobbyMessage[] = [];
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const converted = this.eventToLobbyMessages(sessionId, obj);
        messages.push(...converted);
      } catch {
        // skip malformed lines
      }
    }

    return messages;
  }

  async discoverSessions(filterCwd?: string): Promise<SessionSummary[]> {
    const storagePath = this.getSessionStoragePath();
    if (!existsSync(storagePath)) return [];

    const results: SessionSummary[] = [];
    this.walkSessionDirs(storagePath, results, filterCwd);
    results.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return results;
  }

  getResumeCommand(sessionId: string): string {
    return `gsd --resume ${sessionId}`;
  }

  async listCommands(): Promise<AdapterCommand[]> {
    return GSD_COMMANDS;
  }

  // ── Private helpers ──

  private findSessionFile(sessionId: string): string | null {
    const storagePath = this.getSessionStoragePath();
    if (!existsSync(storagePath)) return null;

    try {
      return this.walkForSession(storagePath, sessionId);
    } catch {
      return null;
    }
  }

  private walkForSession(dir: string, sessionId: string): string | null {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }

    for (const name of names) {
      const fullPath = join(dir, name);
      try {
        const s = statSync(fullPath);
        if (s.isDirectory()) {
          const found = this.walkForSession(fullPath, sessionId);
          if (found) return found;
        } else if (name.includes(sessionId)) {
          return fullPath;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private walkSessionDirs(
    dir: string,
    results: SessionSummary[],
    filterCwd?: string,
  ): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      const fullPath = join(dir, name);
      try {
        const s = statSync(fullPath);
        if (s.isDirectory()) {
          // GSD uses sanitized project path as directory name
          // e.g. --Users-me-project-- for /Users/me/project
          this.walkSessionDirs(fullPath, results, filterCwd);
          continue;
        }
      } catch {
        continue;
      }

      // Process session files (JSONL or other formats)
      try {
        const meta = this.extractSessionMeta(fullPath, name);
        if (!meta) continue;
        if (filterCwd && meta.cwd !== filterCwd) continue;

        const stat = statSync(fullPath);
        results.push({
          id: meta.sessionId,
          adapterName: this.name,
          displayName: meta.displayName || meta.sessionId.slice(0, 8),
          status: 'stopped',
          lastActiveAt: stat.mtimeMs,
          lastMessage: meta.lastMessage,
          messageCount: meta.messageCount,
          model: meta.model,
          cwd: meta.cwd || '',
          origin: 'cli',
          resumeCommand: this.getResumeCommand(meta.sessionId),
          jsonlPath: fullPath,
        });
      } catch {
        // skip unreadable files
      }
    }
  }

  private extractSessionMeta(filePath: string, fileName: string): {
    sessionId: string;
    cwd: string;
    model?: string;
    displayName?: string;
    lastMessage?: string;
    messageCount: number;
  } | null {
    try {
      // Read first 64KB to find metadata
      const fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(65536);
      const bytesRead = readSync(fd, buf, 0, 65536, 0);
      closeSync(fd);

      const content = buf.toString('utf-8', 0, bytesRead);
      const lines = content.split('\n').filter((l: string) => l.trim());

      let sessionId: string | null = null;
      let cwd = '';
      let model: string | undefined;
      let messageCount = 0;
      let lastMessage: string | undefined;

      // Try to derive cwd from parent directory name
      // GSD stores sessions in ~/.gsd/sessions/--<sanitized-path>--/
      const parentDir = basename(join(filePath, '..'));
      if (parentDir.startsWith('--') && parentDir.endsWith('--')) {
        // Convert sanitized path back: --Users-me-project-- -> /Users/me/project
        cwd = '/' + parentDir.slice(2, -2).replace(/-/g, '/');
      }

      for (const line of lines.slice(0, 30)) {
        try {
          const obj = JSON.parse(line);
          if (obj.sessionId && !sessionId) sessionId = obj.sessionId;
          if (obj.session_id && !sessionId) sessionId = obj.session_id;
          if (obj.type === 'init_result' && obj.sessionId) sessionId = obj.sessionId;
          if (obj.cwd && !cwd) cwd = obj.cwd;
          if (obj.model && !model) model = obj.model;
          if (obj.type === 'message_update') messageCount++;
          if (obj.type === 'user_message' && obj.content) {
            lastMessage = typeof obj.content === 'string'
              ? obj.content.slice(0, 100)
              : JSON.stringify(obj.content).slice(0, 100);
          }
        } catch {
          // skip malformed lines
        }
      }

      if (!sessionId) {
        sessionId = basename(fileName, '.jsonl');
      }

      return { sessionId, cwd, model, messageCount, displayName: lastMessage?.slice(0, 30), lastMessage };
    } catch {
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private eventToLobbyMessages(sessionId: string, event: any): LobbyMessage[] {
    const type = event.type as string | undefined;
    if (!type) return [];

    const timestamp = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();

    switch (type) {
      case 'init_result':
        return [makeLobbyMessage(sessionId, 'system', {
          sessionId: event.sessionId ?? sessionId,
        })];

      case 'message_update': {
        const subType = event.subType ?? event.sub_type ?? event.event;
        if (subType === 'text_end' || subType === 'thinking_end') {
          const text = event.text ?? event.fullText ?? '';
          if (text) {
            return [{ id: randomUUID(), sessionId, timestamp, type: 'assistant', content: text }];
          }
        }
        return [];
      }

      case 'user_message':
        return [{
          id: randomUUID(),
          sessionId,
          timestamp,
          type: 'user',
          content: typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
        }];

      case 'tool_execution_start':
        return [{
          id: randomUUID(),
          sessionId,
          timestamp,
          type: 'tool_use',
          content: JSON.stringify(event.input ?? event.arguments ?? {}, null, 2),
          meta: { toolName: event.toolName ?? event.tool_name ?? event.name },
        }];

      case 'tool_execution_end':
        return [{
          id: randomUUID(),
          sessionId,
          timestamp,
          type: 'tool_result',
          content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output ?? {}),
          meta: {
            toolName: event.toolName ?? event.tool_name ?? event.name,
            isError: event.isError ?? event.is_error,
          },
        }];

      case 'execution_complete':
      case 'agent_end':
        return [{
          id: randomUUID(),
          sessionId,
          timestamp,
          type: 'result',
          content: 'Completed',
          meta: {
            costUsd: event.cost?.total,
            tokenUsage: event.cost ? {
              input: event.cost.input_tokens ?? 0,
              output: event.cost.output_tokens ?? 0,
            } : undefined,
          },
        }];

      default:
        return [];
    }
  }
}
```

- [ ] **Step 4: Verify the file compiles**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && npx tsc --noEmit --project packages/core/tsconfig.json 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/gsd.ts
git commit -m "feat: add GSD adapter (gsd-pi headless supervised mode)"
```

---

### Task 2: Export and register the adapter

**Files:**
- Modify: `packages/core/src/adapters/index.ts`
- Modify: `packages/server/src/adapters/index.ts`

- [ ] **Step 1: Add export to core adapters index**

In `packages/core/src/adapters/index.ts`, add:

```typescript
export { GsdAdapter } from './gsd.js';
```

After the existing exports.

- [ ] **Step 2: Add to server builtin adapters**

In `packages/server/src/adapters/index.ts`:

Add import:
```typescript
import { ClaudeCodeAdapter, CodexCliAdapter, OpenCodeAdapter, GsdAdapter } from '@openlobby/core';
```

Update return:
```typescript
return [new ClaudeCodeAdapter(), new CodexCliAdapter(), new OpenCodeAdapter(), new GsdAdapter()];
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/adapters/index.ts packages/server/src/adapters/index.ts
git commit -m "feat: register GSD adapter in core exports and server builtins"
```

---

### Task 3: Update MCP server and LobbyManager

**Files:**
- Modify: `packages/server/src/mcp-server.ts:65,168`
- Modify: `packages/server/src/lobby-manager.ts:47`

- [ ] **Step 1: Add 'gsd' to MCP server z.enum() lists**

In `packages/server/src/mcp-server.ts`:

Line 65 — change:
```typescript
adapter: z.enum(['claude-code', 'codex-cli', 'opencode']).default('claude-code')
```
to:
```typescript
adapter: z.enum(['claude-code', 'codex-cli', 'opencode', 'gsd']).default('claude-code')
```

Line 168 — change:
```typescript
adapterName: z.enum(['claude-code', 'codex-cli', 'opencode'])
```
to:
```typescript
adapterName: z.enum(['claude-code', 'codex-cli', 'opencode', 'gsd'])
```

- [ ] **Step 2: Update LobbyManager system prompt**

In `packages/server/src/lobby-manager.ts`, line 47 — change:
```
adapter: claude-code (default), codex-cli, or opencode
```
to:
```
adapter: claude-code (default), codex-cli, opencode, or gsd
```

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/mcp-server.ts packages/server/src/lobby-manager.ts
git commit -m "feat: add GSD to MCP tool schemas and LobbyManager system prompt"
```

---

### Task 4: Update frontend UI labels

**Files:**
- Modify: `packages/web/src/components/NewSessionDialog.tsx`
- Modify: `packages/web/src/components/DiscoverDialog.tsx:116,161,217`
- Modify: `packages/web/src/components/Sidebar.tsx:146`
- Modify: `packages/web/src/components/RoomHeader.tsx:87`

- [ ] **Step 1: Add GSD button to NewSessionDialog**

In `packages/web/src/components/NewSessionDialog.tsx`:

Line 11 — update type:
```typescript
const defaultAdapter = (serverConfig.defaultAdapter ?? 'claude-code') as 'claude-code' | 'codex-cli' | 'opencode' | 'gsd';
```

Line 16 — update state type:
```typescript
const [adapter, setAdapter] = useState<'claude-code' | 'codex-cli' | 'opencode' | 'gsd'>(defaultAdapter);
```

After the OpenCode button (after line ~89), add:
```tsx
<button
  type="button"
  onClick={() => setAdapter('gsd')}
  className={`flex-1 rounded-lg px-3 py-2 text-sm text-center transition-colors ${
    adapter === 'gsd'
      ? 'bg-amber-900/40 border border-amber-500/50 text-amber-200'
      : 'bg-gray-800 border border-gray-700 text-gray-400 hover:text-gray-200'
  }`}
>
  GSD
</button>
```

Line 132 — update placeholder:
```typescript
placeholder={adapter === 'codex-cli' ? 'What would you like Codex to do?' : adapter === 'opencode' ? 'What would you like OpenCode to do?' : adapter === 'gsd' ? 'What would you like GSD to do?' : 'What would you like Claude to do?'}
```

Line 147 — update model placeholder:
```typescript
placeholder={adapter === 'codex-cli' ? 'e.g. o3, o4-mini, codex-mini' : adapter === 'opencode' ? 'e.g. claude-4-sonnet, gpt-4o' : adapter === 'gsd' ? 'e.g. claude-4-sonnet, gpt-4o' : 'e.g. opus, sonnet'}
```

- [ ] **Step 2: Add GSD label to DiscoverDialog**

In `packages/web/src/components/DiscoverDialog.tsx`:

Line 116 — update:
```typescript
const label = name === 'claude-code' ? 'CC' : name === 'codex-cli' ? 'CX' : name === 'opencode' ? 'OC' : name === 'gsd' ? 'GSD' : name;
```

Line 161 — update:
```typescript
Select all {adapterFilter !== 'all' ? `(${adapterFilter === 'claude-code' ? 'CC' : adapterFilter === 'codex-cli' ? 'CX' : adapterFilter === 'opencode' ? 'OC' : adapterFilter === 'gsd' ? 'GSD' : adapterFilter})` : ''}
```

Line 217 — update:
```typescript
const adapterLabel = session.adapterName === 'claude-code' ? 'CC' : session.adapterName === 'codex-cli' ? 'CX' : session.adapterName === 'opencode' ? 'OC' : session.adapterName === 'gsd' ? 'GSD' : session.adapterName;
```

- [ ] **Step 3: Add GSD label to Sidebar**

In `packages/web/src/components/Sidebar.tsx`, line 146 — update:
```typescript
{session.adapterName === 'claude-code' ? 'CC' : session.adapterName === 'codex-cli' ? 'CX' : session.adapterName === 'opencode' ? 'OC' : session.adapterName === 'gsd' ? 'GSD' : session.adapterName}
```

- [ ] **Step 4: Add GSD label to RoomHeader**

In `packages/web/src/components/RoomHeader.tsx`, line 87 — update:
```typescript
const adapterLabel = session.adapterName === 'claude-code' ? 'Claude Code' : session.adapterName === 'codex-cli' ? 'Codex CLI' : session.adapterName === 'opencode' ? 'OpenCode' : session.adapterName === 'gsd' ? 'GSD' : session.adapterName;
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/NewSessionDialog.tsx packages/web/src/components/DiscoverDialog.tsx packages/web/src/components/Sidebar.tsx packages/web/src/components/RoomHeader.tsx
git commit -m "feat: add GSD adapter labels to frontend UI components"
```

---

### Task 5: Add contract test and verify build

**Files:**
- Create: `packages/core/src/adapters/__tests__/gsd.test.ts`

- [ ] **Step 1: Create the contract test file**

```typescript
import { createAdapterIntegrationTests } from './adapter-contract.js';
import { GsdAdapter } from '../gsd.js';

createAdapterIntegrationTests(() => new GsdAdapter(), {
  spawnOverrides: { permissionMode: 'auto' },
});
```

- [ ] **Step 2: Verify full build passes**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm -r build 2>&1 | tail -20`
Expected: All packages build successfully

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/adapters/__tests__/gsd.test.ts
git commit -m "test: add GSD adapter contract test"
```

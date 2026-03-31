# Permission Mode Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken permission system with a unified three-mode enum (`auto`/`supervised`/`readonly`), two-layer config (adapter defaults + session override), and immediate-effect enforcement in all three adapters.

**Architecture:** Define `PermissionMode` type and `AdapterPermissionMeta` interface in core types. Each adapter declares its own `permissionMeta` and enforces permission checks in its approval handler. Server manages a new `adapter_defaults` SQLite table and resolves effective permission via `session.permissionMode ?? adapterDefault ?? 'supervised'`. Frontend displays always-visible permission badges and uses unified mode selectors with native CLI labels from adapter metadata.

**Tech Stack:** TypeScript, SQLite (better-sqlite3), React + Zustand, WebSocket protocol, Vitest

---

### Task 1: Add Unified PermissionMode Type and AdapterPermissionMeta Interface

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Add PermissionMode type and AdapterPermissionMeta interface to types.ts**

In `packages/core/src/types.ts`, add after the `McpServerConfig` interface (after line 32):

```typescript
/** Unified permission mode across all adapters */
export type PermissionMode = 'auto' | 'supervised' | 'readonly';

/** Each adapter declares how OpenLobby modes map to its native CLI labels */
export interface AdapterPermissionMeta {
  /** Human-readable native label for each OpenLobby permission mode */
  modeLabels: Record<PermissionMode, string>;
}
```

Change `SpawnOptions.permissionMode` from `string` to `PermissionMode`:

```typescript
export interface SpawnOptions {
  cwd: string;
  prompt?: string;
  model?: string;
  permissionMode?: PermissionMode;
  systemPrompt?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  apiKey?: string;
}
```

Change `SessionSummary.permissionMode` from `string` to `PermissionMode`:

```typescript
  permissionMode?: PermissionMode;
```

Add `permissionMeta` to `AgentAdapter`:

```typescript
export interface AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  /** Permission mode metadata — native labels for each unified mode */
  readonly permissionMeta: AdapterPermissionMeta;

  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  spawn(options: SpawnOptions): Promise<AgentProcess>;
  resume(sessionId: string, options?: ResumeOptions): Promise<AgentProcess>;
  getSessionStoragePath(): string;
  readSessionHistory(sessionId: string): Promise<LobbyMessage[]>;
  discoverSessions(cwd?: string): Promise<SessionSummary[]>;
  getResumeCommand(sessionId: string): string;
  listCommands?(): Promise<AdapterCommand[]>;
}
```

Remove `setPlanMode` from `AgentProcess` (readonly is now handled via permissionMode):

```typescript
export interface AgentProcess extends EventEmitter {
  sessionId: string;
  readonly adapter: string;
  status: 'running' | 'idle' | 'stopped' | 'error' | 'awaiting_approval';

  sendMessage(content: string): void;
  respondControl(requestId: string, decision: ControlDecision, payload?: Record<string, unknown>): void;
  updateOptions(opts: Partial<SpawnOptions>): void;
  interrupt(): void;
  kill(): void;
}
```

- [ ] **Step 2: Export new types from index.ts**

In `packages/core/src/index.ts`, add `PermissionMode` and `AdapterPermissionMeta` to the export list:

```typescript
export type {
  LobbyMessage,
  SpawnOptions,
  ResumeOptions,
  ControlDecision,
  ControlQuestion,
  ControlRequest,
  AgentProcess,
  SessionSummary,
  AgentAdapter,
  AdapterCommand,
  McpServerConfig,
  AdapterPluginModule,
  MessageMode,
  PermissionMode,
  AdapterPermissionMeta,
} from './types.js';
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/index.ts
git commit -m "feat(core): add unified PermissionMode type and AdapterPermissionMeta interface"
```

---

### Task 2: Add adapter_defaults Table and DB Methods

**Files:**
- Modify: `packages/server/src/db.ts`

- [ ] **Step 1: Add adapter_defaults table creation in initDb**

In `packages/server/src/db.ts`, add after the `server_config` table creation (after line 110):

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS adapter_defaults (
      adapter_name    TEXT PRIMARY KEY,
      permission_mode TEXT NOT NULL DEFAULT 'supervised'
    )
  `);
```

- [ ] **Step 2: Add migration for existing permission_mode values**

Add after the new table creation:

```typescript
  // Migration: convert old CLI-specific permission_mode values to unified enum
  db.exec(`
    UPDATE sessions SET permission_mode = 'auto'
      WHERE permission_mode IN ('bypassPermissions', 'dontAsk');
    UPDATE sessions SET permission_mode = 'readonly'
      WHERE permission_mode = 'plan';
    UPDATE sessions SET permission_mode = NULL
      WHERE permission_mode IN ('default', '');
  `);
```

- [ ] **Step 3: Add AdapterDefaultRow interface and CRUD functions**

Add at the end of the file, before the last closing comment or at the bottom:

```typescript
// ─── Adapter Defaults ────────────────────────────────────────────────

export interface AdapterDefaultRow {
  adapter_name: string;
  permission_mode: string;
}

export function getAdapterDefault(db: Database.Database, adapterName: string): AdapterDefaultRow | undefined {
  return db.prepare('SELECT * FROM adapter_defaults WHERE adapter_name = ?').get(adapterName) as AdapterDefaultRow | undefined;
}

export function setAdapterDefault(db: Database.Database, adapterName: string, permissionMode: string): void {
  db.prepare(`
    INSERT OR REPLACE INTO adapter_defaults (adapter_name, permission_mode)
    VALUES (?, ?)
  `).run(adapterName, permissionMode);
}

export function getAllAdapterDefaults(db: Database.Database): AdapterDefaultRow[] {
  return db.prepare('SELECT * FROM adapter_defaults ORDER BY adapter_name').all() as AdapterDefaultRow[];
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/db.ts
git commit -m "feat(server): add adapter_defaults table, migration, and CRUD methods"
```

---

### Task 3: Update Claude Code Adapter — Permission Enforcement and Metadata

**Files:**
- Modify: `packages/core/src/adapters/claude-code.ts`

- [ ] **Step 1: Add permissionMeta to ClaudeCodeAdapter**

In `packages/core/src/adapters/claude-code.ts`, add the import for the new types at the top (update the existing import):

```typescript
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
```

Add a `READONLY_TOOLS` constant (rename/expand the existing `PLAN_MODE_TOOLS`):

```typescript
/** Read-only tools allowed in readonly mode */
const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch'];
```

Remove the old `PLAN_MODE_TOOLS` constant (line 119) and update any references.

In the `ClaudeCodeAdapter` class, add `permissionMeta`:

```typescript
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly permissionMeta: AdapterPermissionMeta = {
    modeLabels: {
      auto: 'bypassPermissions',
      supervised: 'default',
      readonly: 'plan',
    },
  };
  private detectedCliPath: string | undefined;
```

- [ ] **Step 2: Update handleToolApproval to check permissionMode**

Replace the `handleToolApproval` method (lines 334-407) with:

```typescript
  private handleToolApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseID: string,
  ): Promise<{
    behavior: string;
    updatedInput?: Record<string, unknown>;
    message?: string;
    interrupt?: boolean;
    toolUseID?: string;
  }> {
    const mode = this.spawnOptions.permissionMode ?? 'supervised';

    // Auto mode: approve everything immediately
    if (mode === 'auto') {
      console.log('[ClaudeCode] Auto mode: approved tool', toolName);
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput, toolUseID });
    }

    // Readonly mode: deny non-read-only tools
    if (mode === 'readonly' && !READONLY_TOOLS.includes(toolName)) {
      console.log('[ClaudeCode] Readonly mode: denied tool', toolName);
      return Promise.resolve({
        behavior: 'deny',
        message: 'Readonly mode: only read-only tools are allowed',
        toolUseID,
      });
    }

    // Supervised mode: emit control message and wait for user approval
    const requestId = randomUUID();
    console.log('[ClaudeCode] Tool approval requested:', toolName, 'toolUseID:', toolUseID);

    // Extract structured questions for AskUserQuestion tool
    const questions = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions)
      ? (toolInput.questions as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>)
      : undefined;

    const controlMsg = makeLobbyMessage(this.sessionId, 'control', {
      requestId,
      toolName,
      toolInput,
      toolUseID,
      questions,
    });
    this.emit('message', controlMsg);

    // Check if user already responded (pre-responded before canUseTool was called)
    const preResponded = this.preRespondedControls.get(requestId);
    if (preResponded) {
      this.preRespondedControls.delete(requestId);
      console.log('[ClaudeCode] Using pre-responded decision for:', requestId, preResponded.decision);
      if (preResponded.decision === 'allow') {
        const updatedInput = preResponded.payload?.answers
          ? { ...toolInput, answers: preResponded.payload.answers }
          : toolInput;
        return Promise.resolve({ behavior: 'allow' as const, updatedInput, toolUseID });
      } else {
        return Promise.resolve({ behavior: 'deny' as const, message: 'User denied the tool', interrupt: true, toolUseID });
      }
    }

    return new Promise((resolve) => {
      this.pendingControls.set(requestId, {
        toolInput,
        resolve: (result) => resolve({ ...result, toolUseID }),
      });

      // Auto-deny after 5 minutes if no response arrives (e.g., connection dropped)
      setTimeout(() => {
        if (this.pendingControls.has(requestId)) {
          console.warn('[ClaudeCode] Approval timed out for:', requestId);
          this.pendingControls.delete(requestId);
          resolve({ behavior: 'deny', message: 'Approval timed out', interrupt: true, toolUseID });
        }
      }, 5 * 60 * 1000);
    });
  }
```

- [ ] **Step 3: Remove planMode field and setPlanMode method**

Remove `private planMode = false;` from the class fields (line 169).

Remove the `setPlanMode` method (lines 459-462).

In `runQuery`, remove the planMode system prompt injection (lines 256-258):
```typescript
      // REMOVE these lines:
      // if (this.planMode) {
      //   queryOpts.systemPrompt = (queryOpts.systemPrompt ?? '') + PLAN_MODE_SYSTEM_PROMPT;
      // }
```

Instead, add readonly mode system prompt injection based on permissionMode:
```typescript
      if (this.spawnOptions.permissionMode === 'readonly') {
        queryOpts.systemPrompt = (queryOpts.systemPrompt ?? '') + PLAN_MODE_SYSTEM_PROMPT;
      }
```

- [ ] **Step 4: Map permissionMode to Claude SDK native value in runQuery**

The SDK's `permissionMode` option (line 239) should use the native CLI value. Update:

```typescript
        // Map unified PermissionMode to Claude Code SDK native value
        permissionMode: (() => {
          switch (this.spawnOptions.permissionMode) {
            case 'auto': return 'bypassPermissions';
            case 'readonly': return 'plan';
            case 'supervised': return 'default';
            default: return 'default';
          }
        })(),
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/claude-code.ts
git commit -m "feat(claude-code): enforce unified PermissionMode with immediate effect in handleToolApproval"
```

---

### Task 4: Update Codex CLI Adapter — Permission Enforcement and Metadata

**Files:**
- Modify: `packages/core/src/adapters/codex-cli.ts`

- [ ] **Step 1: Add permissionMeta to CodexCliAdapter and update mapPermissionMode**

Add import for `AdapterPermissionMeta`:

```typescript
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
```

In `CodexCliAdapter`, add `permissionMeta`:

```typescript
export class CodexCliAdapter implements AgentAdapter {
  readonly name = 'codex-cli';
  readonly displayName = 'Codex CLI';
  readonly permissionMeta: AdapterPermissionMeta = {
    modeLabels: {
      auto: 'never',
      supervised: 'on-request',
      readonly: 'on-request + plan',
    },
  };
```

Update the private `mapPermissionMode` method in `CodexCliProcess` (lines 843-850):

```typescript
  private mapPermissionMode(mode?: string): string {
    switch (mode) {
      case 'auto': return 'never';
      // Legacy values (backward compat during transition)
      case 'bypassPermissions': return 'never';
      case 'dontAsk': return 'never';
      case 'readonly': return 'on-request';
      case 'plan': return 'on-request';
      default: return 'on-request';
    }
  }
```

- [ ] **Step 2: Add permission enforcement in handleServerRequest**

In the `handleServerRequest` method, inside the `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` handler block (around line 527), add permission mode checks BEFORE the existing planMode check:

```typescript
    } else if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      const requestId = randomUUID();
      const toolName = params.command ?? params.fileName ?? method;
      const toolInput = { ...params };

      console.log('[Codex] Approval requested:', toolName);

      // Emit tool_use so the UI shows what tool is being called (real-time)
      this.emit('message', makeLobbyMessage(
        this.sessionId,
        'tool_use',
        JSON.stringify(toolInput, null, 2),
        { toolName: typeof toolName === 'string' ? toolName : String(toolName) },
      ));

      const mode = this.spawnOptions.permissionMode ?? 'supervised';

      // Auto mode: approve immediately
      if (mode === 'auto') {
        console.log('[Codex] Auto mode: approved', toolName);
        this.writeRaw({
          jsonrpc: '2.0',
          id: msg.id,
          result: { decision: 'accept' },
        });
        this.emit('message', makeLobbyMessage(
          this.sessionId,
          'tool_result',
          `[Auto] Approved: ${toolName}`,
          { toolName: typeof toolName === 'string' ? toolName : String(toolName) },
        ));
        return;
      }

      // Readonly mode: auto-deny file changes and command executions
      if (mode === 'readonly') {
        console.log('[Codex] Readonly mode: auto-denying', toolName);
        this.writeRaw({
          jsonrpc: '2.0',
          id: msg.id,
          result: { decision: 'decline' },
        });
        this.emit('message', makeLobbyMessage(
          this.sessionId,
          'tool_result',
          `[Readonly mode] Denied: ${toolName}`,
          { toolName: typeof toolName === 'string' ? toolName : String(toolName) },
        ));
        return;
      }

      // Supervised mode: emit control and wait for user
      this.status = 'awaiting_approval';
      this.emit('message', makeLobbyMessage(this.sessionId, 'control', {
        requestId,
        toolName: typeof toolName === 'string' ? toolName : String(toolName),
        toolInput,
      }));

      this.pendingControls.set(requestId, {
        rpcId: msg.id,
        resolve: () => {},
      });
```

Remove the old separate `planMode` check block that was before (lines 546-561).

- [ ] **Step 3: Remove planMode field and setPlanMode method from CodexCliProcess**

Remove `private planMode = false;` from the class.

Remove the `setPlanMode` method.

Update the `mcpServer/elicitation/request` handler to use `this.spawnOptions.permissionMode === 'readonly'` instead of `this.planMode`.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/adapters/codex-cli.ts
git commit -m "feat(codex-cli): enforce unified PermissionMode with immediate effect"
```

---

### Task 5: Update OpenCode Adapter — Permission Enforcement and Metadata

**Files:**
- Modify: `packages/core/src/adapters/opencode.ts`

- [ ] **Step 1: Add permissionMeta to OpenCodeAdapter**

Add import for `AdapterPermissionMeta` and update the `OpenCodeAdapter` class:

```typescript
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
```

```typescript
export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly permissionMeta: AdapterPermissionMeta = {
    modeLabels: {
      auto: 'auto-approve',
      supervised: 'prompt',
      readonly: 'plan + auto-reject',
    },
  };
```

- [ ] **Step 2: Add permission enforcement in handlePermissionUpdated**

Replace the `handlePermissionUpdated` method:

```typescript
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlePermissionUpdated(props: any): void {
    if (!props.id) return;

    const mode = this.spawnOptions.permissionMode ?? 'supervised';
    const toolName = props.title ?? props.type ?? 'unknown';

    console.log('[OpenCode] Permission requested:', toolName, 'id:', props.id, 'mode:', mode);

    // Auto mode: immediately approve
    if (mode === 'auto') {
      console.log('[OpenCode] Auto mode: approved', toolName);
      this.client
        .postSessionIdPermissionsPermissionId({
          path: { id: this.sessionId, permissionID: props.id },
          body: { response: 'once' },
        })
        .catch((err: unknown) => {
          console.warn('[OpenCode] Auto-approve failed:', err);
        });
      return;
    }

    // Readonly mode: auto-reject
    if (mode === 'readonly') {
      console.log('[OpenCode] Readonly mode: rejected', toolName);
      this.client
        .postSessionIdPermissionsPermissionId({
          path: { id: this.sessionId, permissionID: props.id },
          body: { response: 'reject' },
        })
        .catch((err: unknown) => {
          console.warn('[OpenCode] Auto-reject failed:', err);
        });
      return;
    }

    // Supervised mode: emit control message for user approval
    this.status = 'awaiting_approval';
    this.emit(
      'message',
      makeLobbyMessage(this.sessionId, 'control', {
        requestId: props.id,
        toolName,
        toolInput: props.metadata ?? {},
      }),
    );
  }
```

- [ ] **Step 3: Remove planMode field and setPlanMode method from OpenCodeProcess**

Remove `private planMode = false;`.

Remove the `setPlanMode` method.

In `sendMessage`, replace `if (this.planMode)` with `if (this.spawnOptions.permissionMode === 'readonly')`:

```typescript
    if (this.spawnOptions.permissionMode === 'readonly') {
      body.system = PLAN_MODE_SYSTEM_PROMPT;
    }
```

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/adapters/opencode.ts
git commit -m "feat(opencode): enforce unified PermissionMode with immediate effect"
```

---

### Task 6: Update SessionManager — Two-Layer Resolution, Remove planMode

**Files:**
- Modify: `packages/server/src/session-manager.ts`

- [ ] **Step 1: Update imports and add resolvePermissionMode helper**

Add imports for the new DB functions:

```typescript
import {
  upsertSession,
  deleteSession as dbDeleteSession,
  updateSessionStatus,
  updateSessionDisplayName,
  getAllSessions,
  getSessionCommands,
  upsertSessionCommands,
  getServerConfig,
  getAdapterDefault,
  getAllAdapterDefaults,
  setAdapterDefault,
} from './db.js';
```

Add import for `PermissionMode`:

```typescript
import type {
  AgentAdapter,
  AgentProcess,
  SpawnOptions,
  LobbyMessage,
  SessionSummary,
  ControlDecision,
  AdapterCommand,
  MessageMode,
  PermissionMode,
} from '@openlobby/core';
```

Change `ManagedSession.permissionMode` type and remove `planMode`:

```typescript
export interface ManagedSession {
  id: string;
  adapterName: string;
  displayName: string;
  status: 'running' | 'idle' | 'stopped' | 'error' | 'awaiting_approval';
  createdAt: number;
  lastActiveAt: number;
  cwd: string;
  process: AgentProcess;
  messageCount: number;
  model?: string;
  permissionMode?: PermissionMode;
  lastMessage?: string;
  origin: 'lobby' | 'cli' | 'lobby-manager';
  messageMode: MessageMode;
}
```

Add the `resolvePermissionMode` method to `SessionManager`:

```typescript
  /** Resolve effective permission mode: session override → adapter default → 'supervised' */
  resolvePermissionMode(session: ManagedSession): PermissionMode;
  resolvePermissionMode(adapterName: string, sessionPermission?: PermissionMode | null): PermissionMode;
  resolvePermissionMode(
    sessionOrAdapterName: ManagedSession | string,
    sessionPermission?: PermissionMode | null,
  ): PermissionMode {
    if (typeof sessionOrAdapterName === 'string') {
      if (sessionPermission) return sessionPermission;
      if (this.db) {
        const row = getAdapterDefault(this.db, sessionOrAdapterName);
        if (row) return row.permission_mode as PermissionMode;
      }
      return 'supervised';
    }
    const session = sessionOrAdapterName;
    if (session.permissionMode) return session.permissionMode;
    if (this.db) {
      const row = getAdapterDefault(this.db, session.adapterName);
      if (row) return row.permission_mode as PermissionMode;
    }
    return 'supervised';
  }
```

- [ ] **Step 2: Remove pendingPlanMode and setPlanMode**

Remove `private pendingPlanMode = new Map<string, boolean>();` (line 59).

Remove the entire `setPlanMode` method (lines 410-429).

- [ ] **Step 3: Update createSession to resolve permission mode**

In `createSession`, update the session creation to resolve and pass effective permission:

```typescript
    const effectivePermission = this.resolvePermissionMode(adapterName, options.permissionMode as PermissionMode);
    const spawnOptions = { ...options, permissionMode: effectivePermission };
    const process = await adapter.spawn(spawnOptions);

    const session: ManagedSession = {
      id: process.sessionId,
      adapterName,
      displayName: displayName ?? `Session ${this.sessions.size + 1}`,
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      cwd: options.cwd,
      process,
      messageCount: 0,
      model: options.model,
      permissionMode: options.permissionMode as PermissionMode | undefined,
      origin,
      messageMode: (options as any).messageMode ?? (this.db ? (getServerConfig(this.db, 'defaultMessageMode') as MessageMode | undefined) : undefined) ?? 'msg-tidy',
    };
```

Note: `session.permissionMode` stores the user's explicit choice (or undefined for "use default"). The effective value is passed to spawn via `spawnOptions`.

- [ ] **Step 4: Update lazyResume to resolve permission mode**

In `lazyResume`, update:

```typescript
    const sessionPermission = row.permission_mode as PermissionMode | null ?? undefined;
    const effectivePermission = this.resolvePermissionMode(row.adapter_name, sessionPermission);
    const process = await adapter.resume(sessionId, {
      prompt,
      cwd: row.cwd,
      permissionMode: effectivePermission,
    });

    const session: ManagedSession = {
      id: sessionId,
      adapterName: row.adapter_name,
      displayName: row.display_name ?? sessionId.slice(0, 8),
      status: 'running',
      createdAt: row.created_at,
      lastActiveAt: Date.now(),
      cwd: row.cwd,
      process,
      messageCount: 0,
      model: row.model ?? undefined,
      permissionMode: sessionPermission ?? undefined,
      origin: row.origin as 'lobby' | 'cli' | 'lobby-manager',
      messageMode: (row.message_mode as MessageMode) ?? 'msg-tidy',
    };
```

Remove the `pendingPlanMode` application block (lines 492-500).

- [ ] **Step 5: Update toSummary to remove planMode and add effective permissionMode**

```typescript
  private toSummary(s: ManagedSession): SessionSummary {
    return {
      id: s.id,
      adapterName: s.adapterName,
      displayName: s.displayName,
      status: s.status,
      lastActiveAt: s.lastActiveAt,
      lastMessage: s.lastMessage,
      messageCount: s.messageCount,
      model: s.model,
      permissionMode: s.permissionMode ?? undefined,
      cwd: s.cwd,
      origin: s.origin,
      messageMode: s.messageMode,
      resumeCommand: this.buildResumeCommand(s),
    };
  }
```

- [ ] **Step 6: Update buildResumeCommand to use new permission values**

```typescript
  private buildResumeCommand(s: ManagedSession): string {
    const parts: string[] = [`cd ${s.cwd}`];
    const adapter = this.adapters.get(s.adapterName);
    let cmd = adapter ? adapter.getResumeCommand(s.id) : `claude --resume ${s.id}`;
    if (s.model) cmd += ` --model ${s.model}`;
    const effectiveMode = this.resolvePermissionMode(s);
    if (effectiveMode !== 'supervised') {
      // Map back to native CLI value for the resume command
      const nativeLabel = adapter?.permissionMeta.modeLabels[effectiveMode];
      if (nativeLabel) {
        cmd += ` --permission-mode ${nativeLabel}`;
      }
    }
    parts.push(cmd);
    return parts.join(' && ');
  }
```

- [ ] **Step 7: Add adapter defaults getter/setter methods**

```typescript
  /** Get all adapter defaults (for frontend global settings UI) */
  getAdapterDefaults(): Array<{ adapterName: string; permissionMode: PermissionMode; displayName: string }> {
    const defaults = this.db ? getAllAdapterDefaults(this.db) : [];
    const defaultMap = new Map(defaults.map((d) => [d.adapter_name, d.permission_mode as PermissionMode]));

    const result: Array<{ adapterName: string; permissionMode: PermissionMode; displayName: string }> = [];
    for (const adapter of this.adapters.values()) {
      result.push({
        adapterName: adapter.name,
        permissionMode: defaultMap.get(adapter.name) ?? 'supervised',
        displayName: adapter.displayName,
      });
    }
    return result;
  }

  /** Set default permission mode for an adapter type */
  setAdapterDefault(adapterName: string, permissionMode: PermissionMode): void {
    if (!this.db) return;
    setAdapterDefault(this.db, adapterName, permissionMode);
  }

  /** Get all registered adapter permission metadata (for frontend labels) */
  getAdapterPermissionMeta(): Record<string, { displayName: string; modeLabels: Record<string, string> }> {
    const meta: Record<string, { displayName: string; modeLabels: Record<string, string> }> = {};
    for (const adapter of this.adapters.values()) {
      meta[adapter.name] = {
        displayName: adapter.displayName,
        modeLabels: adapter.permissionMeta.modeLabels,
      };
    }
    return meta;
  }
```

- [ ] **Step 8: Update resumeSession and rebuildSession to remove planMode**

In `resumeSession`, remove `planMode: false` from session creation.

In `rebuildSession`, update `spawnOptions` to use current effective permission mode:

```typescript
    const spawnOptions: SpawnOptions = {
      cwd: session.cwd,
      model: session.model,
      permissionMode: this.resolvePermissionMode(session),
      ...(currentOpts ? {
        systemPrompt: currentOpts.systemPrompt,
        allowedTools: currentOpts.allowedTools,
        mcpServers: currentOpts.mcpServers,
        apiKey: currentOpts.apiKey,
      } : {}),
    };
```

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/session-manager.ts
git commit -m "feat(server): two-layer permission resolution, remove planMode tracking"
```

---

### Task 7: Update WebSocket Handler and Protocol

**Files:**
- Modify: `packages/core/src/protocol.ts`
- Modify: `packages/server/src/ws-handler.ts`

- [ ] **Step 1: Add new message types to protocol**

In `packages/core/src/protocol.ts`, add to `ClientMessage`:

```typescript
  | { type: 'adapter.get-defaults' }
  | { type: 'adapter.set-default'; adapterName: string; permissionMode: string }
  | { type: 'adapter.get-meta' }
```

Add to `ServerMessage`:

```typescript
  | { type: 'adapter.defaults'; defaults: Array<{ adapterName: string; permissionMode: string; displayName: string }> }
  | { type: 'adapter.meta'; meta: Record<string, { displayName: string; modeLabels: Record<string, string> }> }
```

Import `PermissionMode`:

```typescript
import type {
  SpawnOptions,
  ControlDecision,
  SessionSummary,
  LobbyMessage,
  ControlRequest,
  AdapterCommand,
  PermissionMode,
} from './types.js';
```

- [ ] **Step 2: Add handlers for new commands in ws-handler**

In `packages/server/src/ws-handler.ts`, add these cases inside the `switch (data.type)` block:

```typescript
        case 'adapter.get-defaults': {
          send({
            type: 'adapter.defaults',
            defaults: sessionManager.getAdapterDefaults(),
          } as any);
          break;
        }

        case 'adapter.set-default': {
          const d = data as { adapterName: string; permissionMode: string };
          sessionManager.setAdapterDefault(d.adapterName, d.permissionMode as any);
          send({
            type: 'adapter.defaults',
            defaults: sessionManager.getAdapterDefaults(),
          } as any);
          break;
        }

        case 'adapter.get-meta': {
          send({
            type: 'adapter.meta',
            meta: sessionManager.getAdapterPermissionMeta(),
          } as any);
          break;
        }
```

- [ ] **Step 3: Translate session.plan-mode to configureSession**

Replace the `session.plan-mode` handler:

```typescript
        case 'session.plan-mode': {
          console.log('[WS] session.plan-mode (legacy):', data.sessionId, data.enabled);
          try {
            // Translate plan mode toggle to permission mode change
            const newMode = data.enabled ? 'readonly' : 'supervised';
            sessionManager.configureSession(data.sessionId, { permissionMode: newMode as any });
          } catch (err) {
            console.error('[WS] plan-mode toggle error:', err);
            send({ type: 'error', sessionId: data.sessionId, error: String(err) });
          }
          break;
        }
```

- [ ] **Step 4: Send adapter meta on new WebSocket connection**

After the existing `send({ type: 'lm.status', ... })` block, add:

```typescript
  // Send adapter permission metadata so frontend can render native labels
  send({
    type: 'adapter.meta',
    meta: sessionManager.getAdapterPermissionMeta(),
  } as any);

  // Send adapter defaults
  send({
    type: 'adapter.defaults',
    defaults: sessionManager.getAdapterDefaults(),
  } as any);
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol.ts packages/server/src/ws-handler.ts
git commit -m "feat(server): add WebSocket commands for adapter defaults and permission meta"
```

---

### Task 8: Update SessionSummary — Remove planMode

**Files:**
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Remove planMode from SessionSummary**

In `packages/core/src/types.ts`, remove `planMode?: boolean;` from `SessionSummary` interface.

The `permissionMode` field already serves this purpose — `readonly` replaces `planMode: true`.

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/types.ts
git commit -m "refactor(core): remove planMode from SessionSummary, subsumed by PermissionMode"
```

---

### Task 9: Update Frontend Store and WebSocket Hooks

**Files:**
- Modify: `packages/web/src/stores/lobby-store.ts`
- Modify: `packages/web/src/hooks/useWebSocket.ts`

- [ ] **Step 1: Update SessionSummaryData in lobby-store**

In `packages/web/src/stores/lobby-store.ts`, update `SessionSummaryData`:

```typescript
export interface SessionSummaryData {
  id: string;
  adapterName: string;
  displayName: string;
  status: string;
  lastActiveAt: number;
  lastMessage?: string;
  messageCount: number;
  model?: string;
  permissionMode?: string;  // 'auto' | 'supervised' | 'readonly' | undefined (= use global default)
  cwd: string;
  origin: string;
  resumeCommand: string;
  jsonlPath?: string;
  messageMode?: string;
  channelBinding?: {
    channelName: string;
    peerId: string;
    peerDisplayName?: string;
  };
}
```

Remove `planMode?: boolean;` from the interface.

Add new state fields to `LobbyState`:

```typescript
  // Adapter permission metadata
  adapterPermissionMeta: Record<string, { displayName: string; modeLabels: Record<string, string> }>;
  adapterDefaults: Array<{ adapterName: string; permissionMode: string; displayName: string }>;

  setAdapterPermissionMeta: (meta: Record<string, { displayName: string; modeLabels: Record<string, string> }>) => void;
  setAdapterDefaults: (defaults: Array<{ adapterName: string; permissionMode: string; displayName: string }>) => void;
```

Add the initial state and setters in the `create` call:

```typescript
  adapterPermissionMeta: {},
  adapterDefaults: [],

  setAdapterPermissionMeta: (meta) => set({ adapterPermissionMeta: meta }),
  setAdapterDefaults: (defaults) => set({ adapterDefaults: defaults }),
```

- [ ] **Step 2: Update useWebSocket to handle new server messages**

In `packages/web/src/hooks/useWebSocket.ts`, in the `onmessage` handler, add cases for the new message types:

```typescript
        case 'adapter.meta': {
          const { meta } = msg as { meta: Record<string, { displayName: string; modeLabels: Record<string, string> }> };
          store.setAdapterPermissionMeta(meta);
          break;
        }

        case 'adapter.defaults': {
          const { defaults } = msg as { defaults: Array<{ adapterName: string; permissionMode: string; displayName: string }> };
          store.setAdapterDefaults(defaults);
          break;
        }
```

Add new send helpers:

```typescript
export function wsGetAdapterDefaults(): void {
  wsSend({ type: 'adapter.get-defaults' });
}

export function wsSetAdapterDefault(adapterName: string, permissionMode: string): void {
  wsSend({ type: 'adapter.set-default', adapterName, permissionMode });
}

export function wsGetAdapterMeta(): void {
  wsSend({ type: 'adapter.get-meta' });
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/stores/lobby-store.ts packages/web/src/hooks/useWebSocket.ts
git commit -m "feat(web): add adapter permission meta and defaults to store and WebSocket hooks"
```

---

### Task 10: Update RoomHeader — Permission Badge and Settings

**Files:**
- Modify: `packages/web/src/components/RoomHeader.tsx`

- [ ] **Step 1: Add permission badge next to session name**

Import the store selectors for adapter meta:

```typescript
import { useLobbyStore } from '../stores/lobby-store';
import { wsDestroySession, wsConfigureSession, wsTogglePlanMode } from '../hooks/useWebSocket';
```

Add state selectors in the component:

```typescript
  const adapterMeta = useLobbyStore((s) => s.adapterPermissionMeta);
  const adapterDefaults = useLobbyStore((s) => s.adapterDefaults);
```

Add a helper to compute effective permission mode:

```typescript
  const effectivePermission = (() => {
    if (session.permissionMode) return session.permissionMode;
    const def = adapterDefaults.find((d) => d.adapterName === session.adapterName);
    return def?.permissionMode ?? 'supervised';
  })();
  const isInherited = !session.permissionMode;
  const meta = adapterMeta[session.adapterName];
  const nativeLabel = meta?.modeLabels?.[effectivePermission] ?? '';
```

Replace the existing `planMode` badge block (lines 84-95) with a permission badge:

```tsx
        {(() => {
          const badgeConfig: Record<string, { color: string; label: string }> = {
            auto: { color: 'text-green-400 bg-green-900/30 border-green-500/30', label: 'Auto' },
            supervised: { color: 'text-yellow-400 bg-yellow-900/30 border-yellow-500/30', label: 'Supervised' },
            readonly: { color: 'text-blue-400 bg-blue-900/30 border-blue-500/30', label: 'Readonly' },
          };
          const cfg = badgeConfig[effectivePermission] ?? badgeConfig.supervised;
          return (
            <span
              className={`text-xs ${cfg.color} border px-2 py-0.5 rounded`}
              title={nativeLabel ? `Maps to '${nativeLabel}' in ${adapterLabel}` : undefined}
            >
              {cfg.label}{isInherited ? ' (default)' : ''}
            </span>
          );
        })()}
```

- [ ] **Step 2: Update Settings panel permission select**

Replace the permission mode select (lines 148-158):

```tsx
              <div>
                <label className="text-xs text-gray-400 block mb-1">Permission Mode</label>
                <select
                  value={permissionMode}
                  onChange={(e) => setPermissionMode(e.target.value)}
                  className="w-full bg-gray-800 text-gray-100 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">
                    Use global default ({(() => {
                      const def = adapterDefaults.find((d) => d.adapterName === session.adapterName);
                      const defMode = def?.permissionMode ?? 'supervised';
                      const defLabel = defMode.charAt(0).toUpperCase() + defMode.slice(1);
                      return defLabel;
                    })()})
                  </option>
                  {(['auto', 'supervised', 'readonly'] as const).map((mode) => {
                    const native = meta?.modeLabels?.[mode] ?? '';
                    const label = mode.charAt(0).toUpperCase() + mode.slice(1);
                    return (
                      <option key={mode} value={mode}>
                        {label}{native ? ` (${native})` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
```

- [ ] **Step 3: Fix Settings initialization to use current permission mode**

Update the Settings button onClick (line 118):

```typescript
          onClick={() => {
            setShowSettings(!showSettings);
            setModel(session.model ?? '');
            setPermissionMode(session.permissionMode ?? '');
            setMessageMode(session.messageMode ?? 'msg-tidy');
          }}
```

This already correctly sets empty string for "use global default" and the actual mode for session overrides.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/RoomHeader.tsx
git commit -m "feat(web): add permission badge and unified mode selector in RoomHeader"
```

---

### Task 11: Update NewSessionDialog

**Files:**
- Modify: `packages/web/src/components/NewSessionDialog.tsx`

- [ ] **Step 1: Update permission mode select to use unified modes**

In `packages/web/src/components/NewSessionDialog.tsx`, update the initial state:

```typescript
  const [permissionMode, setPermissionMode] = useState('');  // '' = use global default
```

Add store selectors:

```typescript
  const adapterMeta = useLobbyStore((s) => s.adapterPermissionMeta);
  const adapterDefaults = useLobbyStore((s) => s.adapterDefaults);
```

Update `handleSubmit` to pass new permission mode:

```typescript
    wsCreateSession(
      adapter,
      {
        cwd: cwd.trim(),
        prompt: initialPrompt.trim() || undefined,
        model: model.trim() || undefined,
        permissionMode: permissionMode || undefined,  // '' means use default (don't send)
        systemPrompt: systemPrompt.trim() || undefined,
        messageMode,
      },
      name.trim() || undefined,
    );
```

Replace the permission mode select (lines 165-173):

```tsx
                  <select
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value)}
                    className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">
                      Use global default ({(() => {
                        const def = adapterDefaults.find((d) => d.adapterName === adapter);
                        const defMode = def?.permissionMode ?? 'supervised';
                        return defMode.charAt(0).toUpperCase() + defMode.slice(1);
                      })()})
                    </option>
                    {(['auto', 'supervised', 'readonly'] as const).map((mode) => {
                      const meta = adapterMeta[adapter];
                      const native = meta?.modeLabels?.[mode] ?? '';
                      const label = mode.charAt(0).toUpperCase() + mode.slice(1);
                      return (
                        <option key={mode} value={mode}>
                          {label}{native ? ` (${native})` : ''}
                        </option>
                      );
                    })}
                  </select>
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/NewSessionDialog.tsx
git commit -m "feat(web): update NewSessionDialog with unified permission modes and native labels"
```

---

### Task 12: Update LobbyManager

**Files:**
- Modify: `packages/server/src/lobby-manager.ts`

- [ ] **Step 1: Update LobbyManager to use 'auto' instead of 'dontAsk'**

In `packages/server/src/lobby-manager.ts`, update `buildSpawnOptions` (line 149):

```typescript
      permissionMode: 'auto',
```

Change the type annotation to use `PermissionMode`:

```typescript
  private buildSpawnOptions(): {
    cwd: string;
    systemPrompt: string;
    permissionMode: PermissionMode;
    allowedTools: string[];
    mcpServers: Record<string, import('@openlobby/core').McpServerConfig>;
  } {
```

Add import at the top:

```typescript
import type { PermissionMode } from '@openlobby/core';
```

- [ ] **Step 2: Commit**

```bash
git add packages/server/src/lobby-manager.ts
git commit -m "refactor(server): update LobbyManager to use 'auto' PermissionMode"
```

---

### Task 13: Update Existing Tests

**Files:**
- Modify: `packages/core/src/adapters/__tests__/claude-code.test.ts`
- Modify: `packages/core/src/adapters/__tests__/codex-cli.test.ts`
- Modify: `packages/core/src/adapters/__tests__/adapter-contract.ts`

- [ ] **Step 1: Update claude-code.test.ts**

```typescript
import { createAdapterIntegrationTests } from './adapter-contract.js';
import { ClaudeCodeAdapter } from '../claude-code.js';

createAdapterIntegrationTests(() => new ClaudeCodeAdapter(), {
  spawnOverrides: { permissionMode: 'auto' },
});
```

- [ ] **Step 2: Update codex-cli.test.ts**

Check current content and update any `permissionMode: 'dontAsk'` or `'bypassPermissions'` to `'auto'`.

- [ ] **Step 3: Update adapter-contract.ts if it references planMode**

Check and update any `planMode` or old permission mode references.

- [ ] **Step 4: Run tests to verify**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm -r build`

Expected: Build succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/adapters/__tests__/
git commit -m "test: update adapter tests to use unified PermissionMode"
```

---

### Task 14: Add Global Defaults Settings UI

**Files:**
- Create: `packages/web/src/components/GlobalSettingsDialog.tsx`
- Modify: `packages/web/src/components/Sidebar.tsx` (or wherever the sidebar lives)

- [ ] **Step 1: Find where to add the global settings entry point**

Search for the sidebar component that contains session list and "New Session" button:

```bash
grep -r "New Session\|newSession\|NewSessionDialog" packages/web/src/components/ --include='*.tsx' -l
```

- [ ] **Step 2: Create GlobalSettingsDialog component**

Create `packages/web/src/components/GlobalSettingsDialog.tsx`:

```tsx
import React from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { wsSetAdapterDefault } from '../hooks/useWebSocket';

interface Props {
  onClose: () => void;
}

export default function GlobalSettingsDialog({ onClose }: Props) {
  const adapterDefaults = useLobbyStore((s) => s.adapterDefaults);
  const adapterMeta = useLobbyStore((s) => s.adapterPermissionMeta);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-xl p-6 w-full max-w-md border border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold mb-5 text-gray-100">Global Settings</h2>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-300">Default Permission Mode per Adapter</h3>
          {adapterDefaults.map((def) => {
            const meta = adapterMeta[def.adapterName];
            return (
              <div key={def.adapterName}>
                <label className="block text-sm text-gray-400 mb-1">{def.displayName}</label>
                <select
                  value={def.permissionMode}
                  onChange={(e) => wsSetAdapterDefault(def.adapterName, e.target.value)}
                  className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {(['auto', 'supervised', 'readonly'] as const).map((mode) => {
                    const native = meta?.modeLabels?.[mode] ?? '';
                    const label = mode.charAt(0).toUpperCase() + mode.slice(1);
                    return (
                      <option key={mode} value={mode}>
                        {label}{native ? ` (${native})` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
            );
          })}
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add a "Settings" button to the sidebar that opens GlobalSettingsDialog**

Find the sidebar component and add a state + button. The button should be at the bottom of the sidebar, next to or below the "New Session" button:

```tsx
const [showGlobalSettings, setShowGlobalSettings] = useState(false);

// In the JSX, near the bottom:
<button
  onClick={() => setShowGlobalSettings(true)}
  className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800"
>
  ⚙ Global Settings
</button>

{showGlobalSettings && (
  <GlobalSettingsDialog onClose={() => setShowGlobalSettings(false)} />
)}
```

Add the import:
```tsx
import GlobalSettingsDialog from './GlobalSettingsDialog';
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/GlobalSettingsDialog.tsx packages/web/src/components/Sidebar.tsx
git commit -m "feat(web): add global adapter defaults settings dialog"
```

---

### Task 15: ChannelRouter Safety Net

**Files:**
- Modify: `packages/server/src/channel-router.ts`

- [ ] **Step 1: Find the approval message routing in ChannelRouter**

Search for where control messages are routed to IM channels:

```bash
grep -n "case 'control'" packages/server/src/channel-router.ts
```

- [ ] **Step 2: Add permission mode check before sending approval to IM**

In the control message handler, before formatting and sending the approval card to IM, check the effective permission mode. If `auto`, skip sending since the adapter already auto-approved:

```typescript
      case 'control': {
        // Safety net: if session is in auto mode, adapter already approved — skip IM routing
        const sessionInfo = this.sessionManager.getSessionInfo(sessionId);
        if (sessionInfo) {
          const effectiveMode = this.sessionManager.resolvePermissionMode(
            sessionInfo.adapterName,
            sessionInfo.permissionMode as any,
          );
          if (effectiveMode === 'auto') {
            console.log('[ChannelRouter] Skipping approval routing — session in auto mode');
            break;
          }
        }

        // ... existing approval routing code ...
```

Note: The `sessionManager` reference is already available in the ChannelRouter class. The `resolvePermissionMode` method was added in Task 6.

- [ ] **Step 3: Also handle readonly mode — no approval card needed (auto-rejected by adapter)**

Add a similar check for `readonly`:

```typescript
          if (effectiveMode === 'auto' || effectiveMode === 'readonly') {
            console.log(`[ChannelRouter] Skipping approval routing — session in ${effectiveMode} mode`);
            break;
          }
```

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/channel-router.ts
git commit -m "feat(server): skip IM approval routing for auto/readonly permission modes"
```

---

### Task 16: Build and Verify

**Files:** None (verification only)

- [ ] **Step 1: Build all packages**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm -r build`

Expected: All packages build successfully with no TypeScript errors.

- [ ] **Step 2: Fix any build errors**

Address any type errors from the migration. Common issues:
- `planMode` references in components not yet updated
- Old permission mode string literals in other files

Search for remaining references:

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby
grep -r "planMode\|plan_mode\|bypassPermissions\|dontAsk" --include='*.ts' --include='*.tsx' packages/ | grep -v node_modules | grep -v dist
```

Fix any remaining occurrences. Specifically check:
- `packages/web/src/components/` for any `planMode` badge/toggle references
- `packages/server/src/channel-router.ts` for any old permission mode strings
- `packages/server/src/slash-commands.ts` for any plan mode handling

- [ ] **Step 3: Run tests**

Run: `cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm -r test 2>&1 || true`

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve build and test issues from permission mode migration"
```

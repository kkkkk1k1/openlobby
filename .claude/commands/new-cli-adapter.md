---
name: new-cli-adapter
description: Generate a complete OpenLobby CLI adapter package for a new Agentic CLI tool. Triggered when the user asks to add, integrate, or support a new CLI agent (e.g. Aider, Continue, Cursor Agent). Produces a tested, pluggable adapter package.
---

# New CLI Adapter Generator

Generate a complete, tested OpenLobby adapter package for a new Agentic CLI. Follow every phase in order. Do NOT skip or reorder phases.

---

## Phase 1: Research the Target CLI

Before writing any code, investigate the target CLI thoroughly:

1. **Communication protocol** — How does the CLI expose a programmatic interface?
   - SDK / library (npm package with async API)
   - Subprocess with JSON-RPC over stdio
   - Subprocess with line-based stdout/stderr
   - HTTP / REST API + SSE (Server-Sent Events)
   - WebSocket

2. **Authentication** — API keys, environment variables, config files, OAuth tokens.

3. **Session management** — How are sessions created, identified, and resumed? What is the session ID format?

4. **Message / response format** — Streaming vs. batch, JSON vs. plain text, event types.

5. **Tool approval system** — Does the CLI ask for permission before running tools? What is the callback/hook mechanism?

6. **History storage** — Where does the CLI persist conversation history on disk? (e.g. `~/.cli-name/sessions/`)
   - **CRITICAL**: Verify the actual storage format (JSONL files, SQLite database, etc.)
   - **CRITICAL**: Check if storage is per-project or centralized (e.g. `~/.cli-name/global.db` vs. `project/.cli/session.jsonl`)

7. **Commands / skills listing** — Is there an API to enumerate available slash commands or skills?

8. **API scoping behavior** — If the CLI has a REST/RPC API:
   - Is `session.list()` global or scoped to the current project/directory?
   - Can you query sessions across all projects, or only within the server's working directory?
   - **Test empirically**: Start the CLI server in one directory, query for sessions created in another directory

Document your findings in a brief summary before proceeding.

---

## Phase 2: Scaffold the Package

Create the following structure:

```
packages/adapter-<name>/
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── src/
    ├── index.ts
    ├── <name>-process.ts
    ├── <name>-adapter.ts
    └── __tests__/
        └── <name>.test.ts
```

### package.json

```json
{
  "name": "openlobby-adapter-<name>",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "peerDependencies": {
    "@openlobby/core": "workspace:*"
  },
  "devDependencies": {
    "@openlobby/core": "workspace:*",
    "typescript": "^5.7.3",
    "vitest": "^3.1.1"
  }
}
```

Add any CLI-specific SDK or library to `dependencies`.

**CRITICAL — Monorepo Dependency Boundaries**:
- Adapter code lives in `@openlobby/core`, which has minimal dependencies
- If you need a heavy native dependency (e.g. `better-sqlite3`), consider using system tools instead (e.g. `sqlite3` CLI via `execSync`)
- Only add dependencies to `@openlobby/core` if they're truly required and lightweight
- Server-only dependencies belong in `@openlobby/server`, not core

### tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

### vitest.config.ts

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 120_000,
  },
});
```

---

## Phase 3: Implement the AgentAdapter

File: `src/<name>-adapter.ts`

Implement all 8 methods of the `AgentAdapter` interface from `@openlobby/core`:

```ts
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  AgentAdapter,
  AgentProcess,
  SpawnOptions,
  ResumeOptions,
  LobbyMessage,
  SessionSummary,
  AdapterCommand,
} from '@openlobby/core';
```

### Method-by-method guide:

#### `detect()`
Check if the CLI binary is installed. Use `execSync('<cli> --version')` wrapped in try/catch plus `which('<cli>')` equivalent. Return `{ installed, version, path }`.

#### `spawn(options: SpawnOptions)`
Create a new `<Name>Process` instance. Pass spawn options. **DO NOT start execution in the constructor.** The caller (SessionManager) wires event listeners first, then calls `sendMessage()`.

#### `resume(sessionId, options?)`
Create a `<Name>Process` with the `resumeId` set. The process will resume the existing CLI session when `sendMessage()` is called.

#### `getSessionStoragePath()`
Return the CLI-specific history path, e.g. `join(homedir(), '.<cli-name>', 'sessions')`.

#### `readSessionHistory(sessionId)`
Read the session's JSONL/log file from disk. Parse each entry and map to `LobbyMessage[]`. Return `[]` for non-existent sessions — never throw.

#### `discoverSessions(cwd?)`
Scan the CLI's session storage directory. Parse metadata from filenames or file contents. Return `SessionSummary[]`.

**CRITICAL**: Prefer reading from disk storage directly over using the CLI's API:
- If the CLI stores sessions in SQLite, use `execSync('sqlite3 -json <db_path> "SELECT ..."')` to query directly
- If the CLI stores sessions in JSONL files, read and parse them directly from disk
- **Why**: CLI APIs (especially REST/RPC) are often scoped to the current project/directory and won't return sessions from other projects
- **Example**: OpenCode's `session.list()` only returns sessions for the server's working directory, not all sessions in `~/.local/share/opencode/opencode.db`
- Reading from disk ensures you discover ALL sessions, not just those visible to a running server instance

#### `getResumeCommand(sessionId)`
Return the shell command string to resume, e.g. `'<cli> --resume <sessionId>'`.

#### `listCommands()`
Return a static array of known `AdapterCommand[]` as a fallback. If the CLI has an API to list commands at runtime, prefer that.

---

## Phase 4: Implement the AgentProcess

File: `src/<name>-process.ts`

Extend `EventEmitter` and implement `AgentProcess` from `@openlobby/core`.

```ts
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  AgentProcess,
  ControlDecision,
  SpawnOptions,
  LobbyMessage,
  AdapterCommand,
} from '@openlobby/core';
```

### Properties

```ts
sessionId: string;        // starts as randomUUID(), updated when CLI returns real ID
readonly adapter: string; // adapter name, e.g. 'aider'
status: AgentProcess['status'];
```

### Methods

#### `sendMessage(content: string)`
Convert the user message to the CLI's protocol and send it. This is the method that starts execution — the constructor must NOT auto-start.

#### `respondControl(requestId: string, decision: ControlDecision)`
Look up the pending approval in the `pendingControls` Map. Resolve the stored Promise with the decision. Remove from Map.

#### `updateOptions(opts: Partial<SpawnOptions>)`
Update runtime configuration (model, allowed tools, etc.) by calling the CLI's config API or storing for next query.

#### `setPlanMode(enabled: boolean)`
When enabled, inject system prompt: `"You are in PLAN MODE. Only explore the codebase and produce a detailed implementation plan. Do NOT modify any files. Use only read-only tools."` Auto-deny write tools in the approval handler.

#### `kill()`
1. Set `this.killedIntentionally = true`
2. Resolve ALL pending controls with `{ behavior: 'deny', message: 'Session killed', interrupt: true }`
3. Terminate the child process / close the SDK connection
4. Set `this.status = 'stopped'`
5. Emit `'exit'`

### Events to emit

| Event        | Payload              | When                                     |
|------------- |--------------------- |----------------------------------------- |
| `'message'`  | `LobbyMessage`       | Every CLI output (text, tool, control)   |
| `'idle'`     | `void`               | Turn complete, CLI waiting for input     |
| `'exit'`     | `void`               | Process terminated                       |
| `'error'`    | `Error`              | Process error                            |
| `'commands'` | `AdapterCommand[]`   | After first query, emit available cmds   |

### Critical Patterns (MANDATORY)

#### 1. Session ID Sync
Start with a placeholder UUID via `randomUUID()`. When the CLI returns the real session ID (in an init/handshake message or first response metadata), update `this.sessionId` and emit a `system` message:

```ts
const realId = /* extract from CLI response */;
this.sessionId = realId;
this.emit('message', {
  id: randomUUID(),
  sessionId: realId,
  timestamp: Date.now(),
  type: 'system',
  content: JSON.stringify({ sessionId: realId }),
} satisfies LobbyMessage);
```

SessionManager watches for this to update its internal mappings.

#### 2. Wire-Before-Send
The constructor MUST NOT start execution. It only stores options and initializes the SDK/subprocess connection. The first call to `sendMessage()` triggers the first query. This ensures the caller has time to wire event listeners before any messages are emitted.

#### 3. Approval Timeout
Store pending approvals in a Map keyed by `requestId`:

```ts
private pendingControls = new Map<string, {
  resolve: (decision: ControlDecision) => void;
  timer: NodeJS.Timeout;
}>();
```

Set a 5-minute timeout per entry. On timeout, auto-deny with interrupt:

```ts
const timer = setTimeout(() => {
  this.pendingControls.delete(requestId);
  resolve('deny'); // or resolve with interrupt behavior
}, 5 * 60 * 1000);
```

In `kill()`, resolve ALL pending controls before terminating.

#### 4. Plan Mode
When plan mode is enabled:
- Inject the read-only system prompt into the next query
- In the approval handler, auto-deny any tool that writes files (check tool name for write/edit/create patterns)

#### 5. Settings Loading
- If using an SDK with a `settingSources` option, pass `['user', 'project', 'local']`
- If subprocess-based, the CLI loads its own config automatically

#### 6. Commands Event
After the first query/init completes, fetch available commands from the CLI (via SDK API, RPC method, or a static fallback list). Emit `'commands'` with `AdapterCommand[]`:

```ts
this.emit('commands', commands);
```

#### 7. Kill Safety
Set `killedIntentionally = true` before killing. In the exit/close handler, check this flag — if true, force `status = 'stopped'` regardless of exit code. If false, set `status = 'error'`.

---

## Phase 5: Implement the Plugin Entry Point

File: `src/index.ts`

```ts
import type { AdapterPluginModule } from '@openlobby/core';
import { <Name>Adapter } from './<name>-adapter.js';

const plugin: AdapterPluginModule = {
  adapterName: '<name>',
  displayName: '<Display Name>',
  createAdapter: () => new <Name>Adapter(),
};

export default plugin;
export { plugin };
export { <Name>Adapter } from './<name>-adapter.js';
export { <Name>Process } from './<name>-process.js';
```

---

## Phase 6: Write the Test File

File: `src/__tests__/<name>.test.ts`

```ts
import { createAdapterIntegrationTests } from '@openlobby/core/src/adapters/__tests__/adapter-contract.js';
import { <Name>Adapter } from '../<name>-adapter.js';

createAdapterIntegrationTests(() => new <Name>Adapter(), {
  spawnOverrides: { permissionMode: 'dontAsk' },
});
```

This runs the shared 13-test contract suite against the new adapter.

---

## Phase 7: Test Gate (HARD REQUIREMENT)

Run:

```bash
pnpm install
pnpm --filter openlobby-adapter-<name> test
```

**ALL tests must pass.** If any test fails:
1. Read the failure output carefully
2. Fix the implementation
3. Re-run `pnpm --filter openlobby-adapter-<name> test`
4. Repeat until all 13+ tests pass

**Do NOT proceed to Phase 8 until every test passes.**

---

## Phase 8: Registration and Build

After all tests pass:

```bash
pnpm -r build
```

The server auto-discovers packages named `openlobby-adapter-<name>` at startup via the plugin loader. No manual registration step is needed.

---

## Phase 9: Frontend and System Integration Checklist

After the adapter is built and working, update these locations to fully integrate it into OpenLobby:

### 9.1 Frontend UI Labels

Add the new adapter to all UI components that display adapter names:

1. **`packages/web/src/components/DiscoverDialog.tsx`**:
   - Line ~113: Add adapter abbreviation mapping (e.g. `'new-cli' → 'NC'`) in filter tab label
   - Line ~214: Add same mapping in `SessionRow` component's `adapterLabel`

2. **`packages/web/src/components/Sidebar.tsx`**:
   - Add adapter abbreviation mapping in session card label rendering

3. **`packages/web/src/components/RoomHeader.tsx`**:
   - Add full adapter name mapping (e.g. `'new-cli' → 'New CLI'`)

4. **`packages/web/src/components/NewSessionDialog.tsx`**:
   - Add new adapter button with appropriate color theme
   - Update prompt placeholder text to include new adapter
   - Update model placeholder text with adapter-specific model examples

### 9.2 LobbyManager System Prompt

**`packages/server/src/lobby-manager.ts`**:
- Update the system prompt to mention the new adapter in the adapter list (around line 45)
- Example: Change `adapter: claude-code (default), codex-cli, or opencode` to include your new adapter

### 9.3 MCP Tool Schemas

**`packages/server/src/mcp-server.ts`**:
- Add the new adapter name to the `z.enum()` in `lobby_create_session` tool schema
- Add the new adapter name to the `z.enum()` in `lobby_import_session` tool schema

**Why this matters**: Without these updates, the LobbyManager (meta-agent) won't know about the new adapter and will refuse to create sessions for it.

---

## Phase 10: Port Conflict Prevention

If your adapter spawns a server subprocess (HTTP/WebSocket):

- **Use dynamic port allocation**: Pass `port: 0` or equivalent to let the OS assign an available port
- **Why**: Default ports may already be in use from previous test runs or other services
- **Example**: `createServer({ port: 0 })` instead of `createServer({ port: 4096 })`

---

## Message Type Mapping Reference

When converting CLI output to `LobbyMessage`, use this mapping:

| CLI Output              | LobbyMessage.type | Notes                                        |
|------------------------ |------------------- |--------------------------------------------- |
| Init / handshake        | `system`           | MUST include `{ sessionId }` for ID sync     |
| Text response           | `assistant`        | Full assembled text                          |
| Streaming text chunk    | `stream_delta`     | Partial text, merged by frontend             |
| Tool call               | `tool_use`         | `meta.toolName` + JSON input as content      |
| Tool result             | `tool_result`      | `meta.isError` + output as content           |
| Approval request        | `control`          | content: `{requestId, toolName, toolInput}`  |
| Turn complete           | `result`           | `meta: {costUsd, tokenUsage}`                |
| Error                   | `system`           | `meta.isError = true`                        |

---

## Existing Adapter Reference

Use these as implementation examples. Source files are in `packages/core/src/adapters/`.

| Aspect            | Claude Code (`claude-code.ts`)                                | Codex CLI (`codex-cli.ts`)                                | OpenCode (`opencode.ts`)                                  |
|------------------ |-------------------------------------------------------------- |---------------------------------------------------------- |---------------------------------------------------------- |
| Communication     | SDK `query()` async generator                                 | `app-server --stdio` subprocess + JSON-RPC                | HTTP REST + SSE via `@opencode-ai/sdk`                    |
| Session ID        | From `system` message `session_id` field                      | From `thread/start` result `thread.id`                    | From `createOpencode()` initial session or REST response  |
| Tool approval     | `canUseTool` callback returning Promise                       | `requestApproval` RPC resolved via JSON-RPC response      | SSE `permission.updated` event + REST POST response       |
| History storage   | `~/.claude/projects/<dir>/<id>.jsonl`                         | `~/.codex/sessions/YYYY/MM/DD/<id>.jsonl`                 | `~/.local/share/opencode/opencode.db` (SQLite, centralized)|
| Discovery method  | Read JSONL files from disk                                    | Read JSONL files from disk                                | Query SQLite via `sqlite3` CLI (NOT REST API)             |
| Commands          | `query.supportedCommands()` SDK API                           | `skills/list` JSON-RPC method                             | Static fallback list                                      |
| Settings          | `settingSources: ['user', 'project', 'local']`                | Automatic (native subprocess)                             | Automatic (native subprocess)                             |
| Plan mode         | System prompt injection + tool filtering in `canUseTool`      | System prompt injection via `config/value/write` RPC      | System prompt injection + tool filtering in approval      |
| Resume            | SDK `resume` option                                           | `thread/resume` RPC                                       | `client.session.promptAsync()` with existing session ID   |

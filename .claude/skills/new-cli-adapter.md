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
   - HTTP / REST API
   - WebSocket

2. **Authentication** — API keys, environment variables, config files, OAuth tokens.

3. **Session management** — How are sessions created, identified, and resumed? What is the session ID format?

4. **Message / response format** — Streaming vs. batch, JSON vs. plain text, event types.

5. **Tool approval system** — Does the CLI ask for permission before running tools? What is the callback/hook mechanism?

6. **History storage** — Where does the CLI persist conversation history on disk? (e.g. `~/.cli-name/sessions/`)

7. **Commands / skills listing** — Is there an API to enumerate available slash commands or skills?

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

| Aspect            | Claude Code (`claude-code.ts`)                                | Codex CLI (`codex-cli.ts`)                                |
|------------------ |-------------------------------------------------------------- |---------------------------------------------------------- |
| Communication     | SDK `query()` async generator                                 | `app-server --stdio` subprocess + JSON-RPC                |
| Session ID        | From `system` message `session_id` field                      | From `thread/start` result `thread.id`                    |
| Tool approval     | `canUseTool` callback returning Promise                       | `requestApproval` RPC resolved via JSON-RPC response      |
| History storage   | `~/.claude/projects/<dir>/<id>.jsonl`                         | `~/.codex/sessions/YYYY/MM/DD/<id>.jsonl`                 |
| Commands          | `query.supportedCommands()` SDK API                           | `skills/list` JSON-RPC method                             |
| Settings          | `settingSources: ['user', 'project', 'local']`                | Automatic (native subprocess)                             |
| Plan mode         | System prompt injection + tool filtering in `canUseTool`      | System prompt injection via `config/value/write` RPC      |
| Resume            | SDK `resume` option                                           | `thread/resume` RPC                                       |

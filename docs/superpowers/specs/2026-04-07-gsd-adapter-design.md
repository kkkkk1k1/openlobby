# GSD Adapter Design

## Overview

Add a built-in OpenLobby adapter for [GSD-2](https://github.com/gsd-build/gsd-2) (`gsd-pi` on npm, binary: `gsd`). GSD is an autonomous coding agent with hierarchical task execution (Milestone > Slice > Task), git worktree isolation, crash recovery, and cost tracking.

## Communication Protocol

**Headless supervised mode**: Spawn `gsd headless --supervised --output-format stream-json` as a child process. Bidirectional JSONL over stdin/stdout.

- Stdout: JSONL events (one JSON object per line)
- Stdin: `extension_ui_response` messages for approval/interactive prompts

## File Structure

Single file at `packages/core/src/adapters/gsd.ts` containing both `GsdProcess` and `GsdAdapter` classes (same pattern as codex-cli.ts, opencode.ts).

## GsdProcess

Extends `EventEmitter`, implements `AgentProcess`.

### Subprocess Lifecycle

1. Constructor stores options only — does NOT start the process
2. `init()` spawns the subprocess, sets up stdout JSONL parsing and event handlers
3. First `sendMessage()` call sends the user prompt via stdin (as a JSONL message or as the initial command argument)
4. `kill()` sets `killedIntentionally`, resolves all pending controls, kills child process

### Spawn Command

```
gsd headless "<prompt>" --supervised --output-format stream-json [--resume <id>] [--model <model>]
```

The prompt is passed as a positional argument to `gsd headless`.

### Event Mapping

| GSD Event | LobbyMessage.type | Notes |
|---|---|---|
| `init_result` | `system` | Contains `sessionId` — update `this.sessionId` |
| `message_update` (text_start) | (ignored) | Signals start of text block |
| `message_update` (text_delta) | `stream_delta` | Partial streaming text |
| `message_update` (text_end) | `assistant` | Full assembled text |
| `tool_execution_start` | `tool_use` | `meta.toolName` from event |
| `tool_execution_end` | `tool_result` | Tool output as content |
| `extension_ui_request` | `control` | Approval request — store in pendingControls map |
| `cost_update` | (stored internally) | Captured for result message |
| `execution_complete` / `agent_end` | `result` | `meta: {costUsd, tokenUsage}`, then emit `idle` |

### Approval Flow

1. GSD emits `extension_ui_request` with `id`, request type (`confirm`/`input`/`select`/`editor`), and details
2. Adapter emits `control` LobbyMessage with `requestId = event.id`
3. User responds via `respondControl(requestId, decision)`
4. Adapter writes `extension_ui_response` to stdin:
   ```json
   {"type": "extension_ui_response", "id": "<event_id>", "confirmed": true/false, "cancelled": false}
   ```
5. Timeout: 5 minutes, then auto-deny

### Permission Mode Mapping

| OpenLobby Mode | GSD Behavior |
|---|---|
| `auto` | Auto-approve all `extension_ui_request` events |
| `supervised` | Forward to user via control messages |
| `readonly` | Auto-deny write operations, inject plan-mode system prompt |

### Resume

Spawn with `--resume <sessionId>` flag. The `init_result` event will contain the resumed session's ID.

### Subsequent Messages

After the initial prompt (passed as CLI argument), subsequent `sendMessage()` calls write a JSONL message to stdin. The exact format depends on GSD's stdin protocol for the supervised mode — likely a simple `{"type": "user_message", "content": "..."}` or the prompt is passed directly as text.

**Fallback approach**: If GSD headless doesn't support multi-turn via stdin, each `sendMessage()` spawns a new subprocess with `--resume <sessionId>` and the new prompt. This matches how headless CLI tools typically work.

## GsdAdapter

### Properties

- `name: 'gsd'`
- `displayName: 'GSD'`
- `permissionMeta.modeLabels`: `{ auto: 'auto-approve', supervised: 'supervised', readonly: 'readonly + plan' }`

### Methods

- `detect()`: `execSync('gsd --version')` + `which gsd`
- `spawn(options)`: Create `GsdProcess`, call `init('spawn')`, return process
- `resume(sessionId, options)`: Create `GsdProcess` with `--resume`, call `init('resume', sessionId)`
- `getSessionStoragePath()`: `join(homedir(), '.gsd', 'sessions')`
- `discoverSessions(cwd?)`: Walk `~/.gsd/sessions/` subdirectories, parse session files for metadata (session ID, cwd, timestamps, message counts)
- `readSessionHistory(sessionId)`: Find and parse session JSONL file from `~/.gsd/sessions/`
- `getResumeCommand(sessionId)`: `'gsd --resume <sessionId>'`
- `listCommands()`: Static list of known GSD commands

### Session Storage

GSD stores sessions at `~/.gsd/sessions/<sanitized-project-path>/`. The project path is sanitized by stripping leading slashes and replacing path separators with hyphens (e.g., `/Users/me/project` becomes `Users-me-project`).

### Static Commands

```typescript
const GSD_COMMANDS: AdapterCommand[] = [
  { name: '/gsd', description: 'Open GSD menu' },
  { name: '/gsd auto', description: 'Run autonomous mode' },
  { name: '/gsd quick', description: 'Quick task execution' },
  { name: '/gsd discuss', description: 'Discuss phase approach' },
  { name: '/gsd status', description: 'Show project status' },
  { name: '/gsd queue', description: 'Show task queue' },
  { name: '/gsd prefs', description: 'Open preferences' },
  { name: '/gsd stop', description: 'Stop current execution' },
];
```

## Integration Points

### packages/core/src/adapters/index.ts

Add `export { GsdAdapter } from './gsd.js';`

### packages/server/src/adapters/index.ts

Add `GsdAdapter` to imports and `createBuiltinAdapters()` return array.

### packages/server/src/mcp-server.ts

Add `'gsd'` to both `z.enum()` lists (lobby_create_session and lobby_import_session).

### packages/server/src/lobby-manager.ts

Update system prompt adapter list: `adapter: claude-code (default), codex-cli, opencode, or gsd`

### packages/web/src/components/

- **NewSessionDialog.tsx**: Add GSD button with color theme
- **DiscoverDialog.tsx**: Add `'gsd' -> 'GSD'` abbreviation mapping
- **Sidebar.tsx**: Add `'gsd' -> 'GSD'` label
- **RoomHeader.tsx**: Add `'gsd' -> 'GSD'` full name mapping

## Testing

Use the shared contract test suite:

```typescript
import { createAdapterIntegrationTests } from '@openlobby/core/src/adapters/__tests__/adapter-contract.js';
import { GsdAdapter } from '../gsd.js';

createAdapterIntegrationTests(() => new GsdAdapter(), {
  spawnOverrides: { permissionMode: 'auto' },
});
```

Requires `gsd` CLI to be installed for integration tests.

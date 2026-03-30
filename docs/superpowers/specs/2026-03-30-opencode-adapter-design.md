# sst/opencode Adapter Design

## Overview

Add a new built-in adapter for [sst/opencode](https://github.com/sst/opencode) to OpenLobby. This is the third adapter type, using a **subprocess + HTTP REST + SSE** communication pattern via `@opencode-ai/sdk`.

## Context

| Adapter | Protocol | Streaming | Approval |
|---|---|---|---|
| Claude Code | In-process SDK (async generator) | `query()` yields events | `canUseTool` callback |
| Codex CLI | Subprocess + JSON-RPC (stdio) | JSON-RPC notifications | `requestApproval` JSON-RPC |
| **OpenCode** | **Subprocess + HTTP REST + SSE** | **SSE event stream** | **HTTP POST permission reply** |

The `@opencode-ai/sdk@1.3.7` provides:
- `createOpencode()` / `createOpencodeServer()` — spawns `opencode serve` subprocess
- `createOpencodeClient()` / `OpencodeClient` — typed HTTP client (auto-generated from OpenAPI)
- SSE event stream at `/event` for real-time updates

## Architecture

```
OpenLobby                          opencode serve (Go binary)
+-----------------+                +---------------------+
| OpenCodeProcess  |--HTTP POST-->| REST API (port auto) |
| (AgentProcess)  |               |                     |
|                 |<---SSE--------| /event (SSE stream)  |
|                 |               |                     |
| OpenCodeAdapter |--HTTP GET---->| /session (CRUD)      |
| (AgentAdapter)  |               |                     |
+-----------------+                +---------------------+
       ^ uses
  @opencode-ai/sdk
```

### Server Lifecycle

One `opencode serve` process is shared across all sessions within an adapter instance. The server starts lazily on the first `spawn()` or `resume()` call and is kept alive until explicitly shut down.

```typescript
class OpenCodeAdapter {
  private serverInstance: { url: string; close(): void } | null = null;
  private clientInstance: OpencodeClient | null = null;

  private async ensureServer(): Promise<OpencodeClient> {
    if (!this.clientInstance) {
      const { client, server } = await createOpencode({ port: 0 });
      this.serverInstance = server;
      this.clientInstance = client;
    }
    return this.clientInstance;
  }
}
```

## AgentAdapter Interface Mapping

| Method | Implementation |
|---|---|
| `detect()` | `execSync('opencode --version')` + `which opencode` |
| `spawn(options)` | `ensureServer()` -> `client.session.create()` -> subscribe SSE -> return `OpenCodeProcess` |
| `resume(sessionId)` | `ensureServer()` -> `client.session.get({ path: { id } })` -> subscribe SSE -> return `OpenCodeProcess` |
| `readSessionHistory(sessionId)` | `client.session.messages({ path: { id } })` -> convert to `LobbyMessage[]` |
| `discoverSessions(cwd?)` | `client.session.list()` -> convert to `SessionSummary[]` |
| `getSessionStoragePath()` | `.opencode/` in project directory |
| `getResumeCommand(sessionId)` | `opencode --session=${sessionId}` |
| `listCommands()` | `client.command.list()` -> convert to `AdapterCommand[]` |

## AgentProcess Interface Mapping

| Method/Event | Implementation |
|---|---|
| `sendMessage(content)` | `client.session.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text }] } })` |
| `respondControl(requestId, decision)` | `client.postSessionIdPermissionsPermissionId({ path: { id, permissionId: requestId }, body: { reply } })` |
| `kill()` | `client.session.abort({ path: { id } })` -> close SSE subscription |
| `updateOptions(opts)` | Update local cached options |
| `setPlanMode(enabled)` | Set flag; inject system prompt on next `promptAsync` call |
| `emit('message')` | From SSE events (see mapping below) |
| `emit('idle')` | From SSE `session.idle` |
| `emit('error')` | From SSE `session.error` |
| `emit('commands')` | After `client.command.list()` resolves |

## SSE Event to LobbyMessage Mapping

### Text Streaming

```
SSE: message.part.updated { part: TextPart, delta: "..." }
  -> if delta exists: LobbyMessage { type: 'stream_delta', content: delta }
  -> if no delta (final): LobbyMessage { type: 'assistant', content: part.text }
```

### Tool Calls

```
SSE: message.part.updated { part: ToolPart }
  -> state.status === 'pending' | 'running':
     LobbyMessage { type: 'tool_use', content: JSON.stringify(state.input), meta: { toolName: part.tool } }
  -> state.status === 'completed':
     LobbyMessage { type: 'tool_result', content: state.output, meta: { toolName: part.tool } }
  -> state.status === 'error':
     LobbyMessage { type: 'tool_result', content: state.error, meta: { toolName: part.tool, isError: true } }
```

### Message Completion

```
SSE: message.updated { info: AssistantMessage }
  -> LobbyMessage { type: 'result', content: { cost, tokens, finish }, meta: { model: info.modelID, costUsd: info.cost, tokenUsage: { input, output } } }
```

### Permission Requests

```
SSE: permission.updated { id, type, title, metadata, sessionID, messageID, callID }
  -> LobbyMessage { type: 'control', content: { requestId: id, toolName: title, toolInput: metadata } }
  -> status = 'awaiting_approval'
```

### Session Status

```
SSE: session.status { status: { type: 'busy' } }   -> status = 'running'
SSE: session.status { status: { type: 'idle' } }    -> status = 'idle'
SSE: session.idle { sessionID }                      -> emit('idle')
SSE: session.error { sessionID, error }              -> emit('error'), LobbyMessage { type: 'system', isError: true }
```

### Ignored Events

The following SSE events are received but not mapped to LobbyMessages:
- `message.part.updated` with `ReasoningPart` — internal thinking, not surfaced
- `message.part.updated` with `StepStartPart`/`StepFinishPart` — step boundaries
- `message.part.updated` with `SnapshotPart`/`PatchPart` — file tracking internals
- `file.edited`, `todo.updated`, `session.compacted` — informational only
- `pty.*`, `lsp.*`, `tui.*` — TUI-specific, not relevant

## ControlDecision Mapping

| OpenLobby | OpenCode Permission Reply |
|---|---|
| `'allow'` | `'once'` |
| `'deny'` | `'reject'` |

Note: OpenCode also supports `'always'` (persistent allow) which could be mapped from a future `ControlDecision` variant.

## Plan Mode

When `setPlanMode(true)` is called:
1. Set an internal `planMode` flag
2. On the next `sendMessage()`, inject a system prompt via the `system` field in `promptAsync` body:
   > "You are in PLAN MODE. Only explore the codebase and produce a detailed implementation plan. Do NOT modify any files."
3. Optionally restrict tools via the `tools` field: `{ [readOnlyTool]: true, [writeTool]: false }`

## SSE Subscription Management

Each `OpenCodeProcess` subscribes to the SSE event stream filtered by its session ID:

```typescript
const stream = await client.event.subscribe();
// Filter events by sessionID matching this process
// Handle reconnection on disconnect
```

The SSE stream is shared per server instance. A single subscription filters events by `sessionID` for each active process.

## File Structure

```
packages/core/src/adapters/
  opencode.ts          # NEW: OpenCodeAdapter + OpenCodeProcess
  index.ts             # ADD: export { OpenCodeAdapter }

packages/core/package.json
  # ADD: "@opencode-ai/sdk": "^1.3.7" to dependencies

packages/server/src/adapters/index.ts
  # ADD: OpenCodeAdapter to createBuiltinAdapters()
```

## Error Handling

- **Server startup failure**: `createOpencode()` throws if binary not found or port conflict. Caught in `ensureServer()`, emits error.
- **SSE disconnection**: Implement reconnection with exponential backoff (1s, 2s, 4s, max 30s).
- **HTTP request failure**: Catch and emit as `LobbyMessage { type: 'system', isError: true }`.
- **Session not found on resume**: `client.session.get()` returns 404, throw descriptive error.
- **Permission timeout**: If no SSE `permission.replied` arrives within 5 minutes, auto-deny.

## Testing

Implement adapter contract tests using the existing `createAdapterIntegrationTests()` framework:

```typescript
// packages/core/src/adapters/__tests__/opencode.integration.test.ts
import { createAdapterIntegrationTests } from './adapter-contract.js';
import { OpenCodeAdapter } from '../opencode.js';
createAdapterIntegrationTests(() => new OpenCodeAdapter());
```

This validates all 13 contract tests: detect, spawn, sendMessage, resume, kill, readSessionHistory, discoverSessions, commands, etc.

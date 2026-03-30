# Session Enhancements Design

**Date:** 2026-03-30
**Status:** Approved
**Scope:** `/new` command, message modes, default adapter switching

---

## Overview

Three independent enhancements to OpenLobby's session management:

1. **`/new` command** — Rebuild the underlying CLI session while keeping the same lobby session
2. **Message modes** — Control message push volume per session (`msg-only` / `msg-tidy` / `msg-total`)
3. **Default adapter switching** — Global default adapter config; switching also rebuilds LobbyManager

---

## Feature 1: `/new` Command

### Behavior

`/new` rebuilds the underlying CLI session without changing the lobby session identity.

- **Lobby session ID unchanged** — Web/IM sees the same session throughout
- **CLI process rebuilt** — Current CLI process stopped, new one spawned with identical config (adapter, cwd, model, permissionMode, systemPrompt, mcpServers)
- **Original CLI session preserved** — The old CLI session's history remains in the CLI tool's storage (e.g., `~/.cache/claude/` JSONL files)
- **No navigation or binding changes** — User stays in the same session; IM binding unaffected
- **Works everywhere** — Available in all sessions including LobbyManager

### Flow

1. User inputs `/new`
2. Server stops the current CLI process (graceful shutdown, not destroy)
3. Server calls `adapter.spawn()` with the same SpawnOptions to create a new CLI process
4. New process wired to the same lobby session via `wireProcessEvents()`
5. A `system` message is posted: "CLI session rebuilt"

### Implementation

- **`packages/server/src/slash-commands.ts`** — Add `/new` handler
- **`packages/server/src/session-manager.ts`** — Add `rebuildSession(sessionId)` method:
  1. Read current session's SpawnOptions and adapterName
  2. Call `process.stop()` on the existing CLI process (without deleting session from DB)
  3. Call `adapter.spawn(options)` to get a new process
  4. Replace the session's process reference and re-run `wireProcessEvents()`
  5. Broadcast a system message to all viewers/channels

---

## Feature 2: Message Modes

### Mode Definitions

| Mode | Pushed messages | Suppressed messages |
|---|---|---|
| `msg-total` | All message types (current behavior) | None |
| `msg-only` | `assistant`, `result`, `system`, `stream_delta` | `tool_use`, `tool_result` |
| `msg-tidy` | `assistant`, `result`, `system`, `stream_delta`, plus one aggregated tool summary | Individual `tool_use` / `tool_result` collapsed into a live summary |

**Exception:** `control` type messages (approval requests) are **always pushed** regardless of mode.

### `msg-tidy` Detailed Behavior

#### Real-time Display (during tool calls)

**Web:**
```
🔧 正在处理... Read(3) → Grep(2) → Edit(1)
┄┄┄
📄 Edit: src/server/session-manager.ts
  + export function rebuildSession(sessionId: string)...
```
- Top: tool call statistics chain, grows in real-time
- Bottom: last tool's content preview (truncated to ~200 chars if too long)
- Each new tool call replaces the bottom section

**IM (ChannelRouter):**
```
【SessionName】正在处理... 🔧 Read(3) → Grep(2)
──
📄 Edit: src/server/session-manager.ts
  + export function rebuildSession...
```
- Reuses existing StreamState think message refresh mechanism
- Last tool content truncated more aggressively (~100 chars) due to IM message length limits

#### After Tool Calls Complete

**Both Web and IM** retain a final statistics message:
```
🔧 已完成 6 次工具调用: Read(3), Grep(2), Edit(1)
```
Then the `assistant` reply is sent/rendered normally.

### Switching

1. **Slash commands:** `/msg-only`, `/msg-tidy`, `/msg-total` — available in Web and IM
2. **Web UI Settings:** Dropdown in RoomHeader settings panel per session
3. **Default for new sessions:** Configurable in Web UI, defaults to `msg-tidy`

### Data Changes

- `SessionSummary` — new field: `messageMode: 'msg-total' | 'msg-tidy' | 'msg-only'`
- `sessions` table — new column: `message_mode TEXT DEFAULT 'msg-tidy'`
- `session.configure` protocol message — supports `messageMode` option
- `server_config` table (or reuse) — stores `defaultMessageMode` for new sessions

### Implementation

#### Server-side filtering (`packages/server/src/session-manager.ts`)

The message broadcast method checks `session.messageMode` before forwarding:
- `msg-total`: pass all messages through (no change)
- `msg-only`: suppress `tool_use` and `tool_result`; pass `control` always
- `msg-tidy`: suppress individual `tool_use` / `tool_result`; maintain per-session tool call counter; emit synthetic summary messages

#### Web-side aggregation (`packages/web/`)

- `lobby-store.ts`: per-session `toolCallAggregator` state:
  - `isAggregating: boolean`
  - `toolCounts: Record<string, number>` (e.g., `{ Read: 3, Grep: 2 }`)
  - `lastToolContent: string` (truncated preview of last tool)
- `MessageBubble` or new `ToolSummaryBubble` component renders the live summary
- On `assistant` or `result` message: finalize aggregator → render fixed summary → reset

#### IM-side aggregation (`packages/server/src/channel-router.ts`)

- Reuse existing `StreamState` think message mechanism
- During tool calls: format think message as `【SessionName】正在处理... 🔧 Read(3) → Grep(2)\n──\n📄 ToolName: content_preview`
- On `assistant` message: send final statistics message, then send the reply

#### Slash commands (`packages/server/src/slash-commands.ts`)

- `/msg-only`, `/msg-tidy`, `/msg-total` handlers
- Call `sessionManager.configureSession(sessionId, { messageMode })` to persist

#### Web UI (`packages/web/src/components/`)

- `RoomHeader` settings: add message mode dropdown
- `NewSessionDialog`: add message mode selector (default from global config)

---

## Feature 3: Default Adapter Switching

### Global Configuration

New server-level config `defaultAdapter`:
- Stored in `server_config` table (new key-value table in SQLite)
- Default value: `'claude-code'`
- Read/written via new protocol messages `config.set` / `config.get`

### Schema: `server_config` Table

```sql
CREATE TABLE IF NOT EXISTS server_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Keys: `defaultAdapter`, `defaultMessageMode`

### Impact

| Scenario | Behavior |
|---|---|
| Web UI new session | NewSessionDialog adapter dropdown defaults to `defaultAdapter` |
| IM `/add` command | Creates session with `defaultAdapter` |
| LM `lobby_create_session` tool | Uses `defaultAdapter` when adapter not specified |
| LM itself | Destroyed and recreated with new adapter (see below) |

### LM Rebuild Flow

When user changes `defaultAdapter`:

1. Persist new value to `server_config`
2. Destroy current LM session: `sessionManager.destroySession(lmSessionId)`
3. Recreate LM with new adapter: `lobbyManager.init(newAdapterName)`
   - Same MCP server config (stdio MCP server for lobby tools)
   - Same system prompt (meta-agent rules)
   - `origin` remains `'lobby-manager'`
4. Clear LM message history in Web client
5. Broadcast `lm.status` with new `lmSessionId` to all WebSocket clients

### MCP Cross-Adapter Compatibility

LM's MCP tools (`lobby_list_sessions`, `lobby_create_session`, etc.) are served via `mcpServers` in SpawnOptions:
- **Claude Code**: native MCP server support via `@anthropic-ai/claude-agent-sdk`
- **Codex CLI**: supports `--mcp-servers` parameter at spawn
- **OpenCode**: supports MCP server configuration at spawn

All adapters already accept `mcpServers` in SpawnOptions — no Adapter interface changes needed.

### Web UI

- New global settings area (Sidebar footer or dedicated Settings panel)
- "Default Adapter" dropdown listing all available adapters
- Confirmation dialog on change: "切换默认 Adapter 将重建 Lobby Manager，历史记录不保留。确认？"
- "Default Message Mode" dropdown (`msg-total` / `msg-tidy` / `msg-only`)

### Protocol Changes (`packages/core/src/protocol.ts`)

New ClientMessage types:
- `config.get` — `{ type: 'config.get', key: string }`
- `config.set` — `{ type: 'config.set', key: string, value: string }`

New ServerMessage types:
- `config.value` — `{ type: 'config.value', key: string, value: string }`

### Implementation

- **`packages/server/src/db.ts`** — Add `server_config` table, get/set helpers
- **`packages/server/src/lobby-manager.ts`** — `init()` accepts adapter name parameter; `rebuild(newAdapter)` method
- **`packages/server/src/ws-handler.ts`** — Handle `config.set` / `config.get`; trigger LM rebuild on `defaultAdapter` change
- **`packages/core/src/protocol.ts`** — Add protocol message types
- **`packages/web/src/stores/lobby-store.ts`** — Track `defaultAdapter`, `defaultMessageMode`
- **`packages/web/src/components/`** — Global settings UI

---

## Cross-Cutting Concerns

### Database Migration

Two schema changes:
1. `sessions` table: `ALTER TABLE sessions ADD COLUMN message_mode TEXT DEFAULT 'msg-tidy'`
2. New `server_config` table

Both handled in `db.ts` init with `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE` guarded by column existence check.

### Backward Compatibility

- Existing sessions without `message_mode` default to `'msg-tidy'` (new default)
- `server_config` empty → `defaultAdapter = 'claude-code'`, `defaultMessageMode = 'msg-tidy'`

### Testing Strategy

- Unit tests for `rebuildSession()` in session-manager
- Unit tests for message filtering logic per mode
- Unit tests for tool call aggregation state machine
- Integration test for `/new` slash command
- Integration test for `/msg-*` slash commands
- Integration test for default adapter switch + LM rebuild

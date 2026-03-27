# OpenLobby -- Architecture Design Document

> Agentic CLI Unified Session Manager: manage your AI coding agent sessions like an IM app

## 1. Project Overview

OpenLobby is a web-based Agentic CLI session management tool. Users can manage multiple Agentic CLI sessions (Claude Code, Codex CLI, etc.) simultaneously in an IM (instant messaging)-style interface, quickly switch between sessions via a dashboard, chat in real time, and rely on a built-in Lobby Manager to manage sessions and route tasks. Additionally, OpenLobby supports connecting IM channels (such as WeCom) so users can interact with coding agents from their phones.

### Core Metaphors

- **Lobby**: The dashboard interface -- see all active sessions at a glance
- **Room**: Each session is a room -- step in and start chatting
- **Lobby Manager**: A built-in meta-agent that only manages and routes sessions, never performs actual tasks
- **Channel**: The integration layer for external IM platforms, bridging messages from WeCom and others into OpenLobby sessions

---

## 2. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Language | TypeScript | Full-stack unified |
| Frontend | React + Tailwind CSS + Vite | Web interface, IM-style |
| Backend | Node.js + Fastify + WebSocket | HTTP + WebSocket + MCP Internal API |
| Real-time | WebSocket | Streaming message transport between frontend and backend |
| CLI Integration | SDK + app-server | Claude Code: `@anthropic-ai/claude-agent-sdk`; Codex CLI: `codex app-server` subprocess + JSON-RPC |
| Persistence | SQLite (better-sqlite3) | Session index + channel provider config + channel bindings |
| Build | Vite (frontend) + tsx (backend) | |
| Package Manager | pnpm workspace | Monorepo, scoped packages `@openlobby/*` |

---

## 3. Overall Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Web Browser (Frontend)                       │
│                                                                  │
│  ┌──────────┐  ┌──────────────────────────────────────────────┐ │
│  │  Sidebar  │  │         Room (Active Session)                 │ │
│  │  Dashboard│  │                                              │ │
│  │          │  │  Message Stream (IM-style)                   │ │
│  │ [LM]    │  │  ┌─────────────────────────────┐            │ │
│  │ [Room 1] │  │  │ assistant: Analysis done...   │            │ │
│  │ [Room 2] │  │  │ tool_use: Read file.ts       │            │ │
│  │  ...     │  │  │ user: Continue optimizing     │            │ │
│  │          │  │  └─────────────────────────────┘            │ │
│  │ [+ New]  │  │  ┌─────────────────────────────┐            │ │
│  │ [⚙ Chan] │  │  │ Input box          [Plan] [Send]│            │ │
│  └──────────┘  │  └─────────────────────────────┘            │ │
│                 └──────────────────────────────────────────────┘ │
└──────────────┬──────────────────────────────────────────────────┘
               │ WebSocket (bidirectional streaming)
               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Node.js Server (Backend)                      │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                Session Manager                              │  │
│  │                                                             │  │
│  │  session_id → AgentProcess mapping                         │  │
│  │  Lifecycle management (create / resume / destroy / recover) │  │
│  │  Message routing (frontend ↔ CLI subprocess, IM ↔ CLI subprocess) │  │
│  └───────┬──────────────┬──────────────┬──────────────────────┘  │
│          │              │              │                          │
│          ▼              ▼              ▼                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐             │
│  │ ClaudeCode   │ │ CodexCLI     │ │ (Future      │             │
│  │ Adapter      │ │ Adapter      │ │  Extension)  │             │
│  │              │ │              │ │ Adapter      │             │
│  │ claude-agent │ │ app-server   │ │              │             │
│  │ -sdk         │ │ JSON-RPC     │ │              │             │
│  └──────┬───────┘ └──────┬───────┘ └──────────────┘             │
│         │                │                                       │
│         ▼ SDK spawn      ▼ Direct spawn                          │
│  ┌────────────┐   ┌────────────┐                                 │
│  │ claude CLI │   │ codex CLI  │    ← Locally installed CLI binaries │
│  └────────────┘   └────────────┘                                 │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Lobby Manager          Channel Router                     │  │
│  │  (Special session,     (IM inbound → session routing       │  │
│  │   drives session        session messages → IM outbound)    │  │
│  │   management Agent)                                        │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  MCP Server (stdio)     MCP Internal API (:3002)           │  │
│  │  lobby_* tools          REST endpoints for MCP Server      │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  SQLite                                                     │  │
│  │  sessions / channel_providers / channel_bindings            │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  CLI Native JSONL (source of truth for messages)            │  │
│  │  ~/.claude/projects/<cwd>/*.jsonl                           │  │
│  │  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl              │  │
│  └────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
         ▲
         │ Webhook / HTTP
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  ChannelProvider(s)                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                      │
│  │  WeCom   │  │ Telegram │  │  Feishu  │   ← External IM platforms │
│  └──────────┘  └──────────┘  └──────────┘                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Core Module Design

### 4.1 Adapter Abstraction Layer

The Adapter is the core mechanism for supporting different Agentic CLIs. Each Adapter encapsulates the integration approach for a specific CLI and exposes a unified `AgentProcess` interface to upper layers.

- **Claude Code**: Via `@anthropic-ai/claude-agent-sdk` (the SDK internally spawns a CLI subprocess)
- **Codex CLI**: Via `codex app-server` subprocess + JSON-RPC bidirectional communication

The reason for choosing different integration approaches is to **ensure a consistent user experience**: both must support runtime per-tool approval (blocking until the user decides), approval recovery after frontend disconnection, and the ability for users to return to the terminal and resume sessions at any time. The Claude Code SDK's `canUseTool` callback meets these requirements, while the Codex SDK's `runStreamed()` does not expose runtime approval events, so Codex uses app-server instead.

Both approaches share session files and authentication credentials with the terminal CLI.

#### AgentAdapter Interface

```typescript
// @openlobby/core — packages/core/src/types.ts

interface AgentAdapter {
  readonly name: string;           // 'claude-code' | 'codex-cli'
  readonly displayName: string;    // 'Claude Code' | 'Codex CLI'

  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  spawn(options: SpawnOptions): Promise<AgentProcess>;
  resume(sessionId: string, options?: ResumeOptions): Promise<AgentProcess>;
  getSessionStoragePath(): string;
  readSessionHistory(sessionId: string): Promise<LobbyMessage[]>;
  discoverSessions(cwd?: string): Promise<SessionSummary[]>;
  getResumeCommand(sessionId: string): string;
}
```

#### AgentProcess Interface

```typescript
interface AgentProcess extends EventEmitter {
  sessionId: string;
  readonly adapter: string;
  status: 'running' | 'idle' | 'stopped' | 'error' | 'awaiting_approval';

  sendMessage(content: string): void;
  respondControl(requestId: string, decision: ControlDecision): void;
  updateOptions(opts: Partial<SpawnOptions>): void;
  setPlanMode?(enabled: boolean): void;
  kill(): void;
}
```

Key changes from the initial design:
- **`awaiting_approval` status**: When the CLI subprocess blocks waiting for tool approval, the status switches to this value. Both the UI and IM channels rely on this status to display approval cards.
- **`updateOptions()`**: Updates SpawnOptions at runtime (e.g., systemPrompt, allowedTools), supporting dynamic Plan Mode injection.
- **`setPlanMode?()`**: Optional method -- some Adapters can natively support plan mode toggling.

#### SpawnOptions

```typescript
interface SpawnOptions {
  cwd: string;
  prompt?: string;
  model?: string;
  permissionMode?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  apiKey?: string;
}
```

`mcpServers` is used for Lobby Manager to inject the OpenLobby MCP Server; `apiKey` is used to inject `ANTHROPIC_AUTH_TOKEN` (supporting multi-tenant scenarios).

### 4.2 Claude Code Adapter

Uses `@anthropic-ai/claude-agent-sdk`. The SDK internally spawns a `claude` CLI subprocess and implements runtime interactive approval via the `canUseTool` callback.

Integration details:
- The SDK spawns a `claude` CLI subprocess under the hood, encapsulating the NDJSON communication protocol
- Reuses CLI authentication (claude.ai login or ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN)
- Sessions are stored at `~/.claude/projects/<encoded-cwd>/*.jsonl`, shared with the terminal CLI
- `query()` returns an async generator; SDK messages are converted to `LobbyMessage[]` via `sdkMessageToLobby()`
- Plan Mode is controlled directly via `setPlanMode()` which sets the SDK's `--plan-mode` flag

### 4.3 Codex CLI Adapter

Uses `codex app-server` subprocess + JSON-RPC bidirectional communication.

The Codex SDK (`@openai/codex-sdk`) `runStreamed()` does not expose runtime approval events -- when an approval request is encountered, the underlying `codex exec` simply fails. To ensure the same per-tool approval experience as Claude Code, the Codex Adapter uses `codex app-server`, which supports the full `requestApproval` bidirectional approval flow.

Integration details:
- Subprocess: `codex app-server` (stdio mode)
- Protocol: JSON-RPC 2.0, bidirectional communication via stdin/stdout
- Reuses CLI authentication (ChatGPT OAuth or OPENAI_API_KEY, stored in `~/.codex/auth.json`)
- Sessions are stored at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, shared with the terminal CLI
- `thread/start` creates sessions, `thread/resume` resumes sessions
- `item/commandExecution/requestApproval` implements interactive approval
- `extractTextFromContent()` handles various Codex content formats (string / array / object)

### 4.2 & 4.3 Comparison

| Feature | Claude Code | Codex CLI |
|---------|------------|-----------|
| Integration | `@anthropic-ai/claude-agent-sdk` | `codex app-server` subprocess + JSON-RPC |
| Underlying Impl | SDK spawns `claude` CLI | Directly spawns `codex app-server` |
| Session Storage | `~/.claude/projects/<cwd>/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Auth Reuse | CLI login / `ANTHROPIC_API_KEY` | ChatGPT OAuth / `~/.codex/auth.json` |
| Terminal Resume | `claude --resume <id>` | `codex resume <id>` |
| Runtime Approval | `canUseTool` callback (blocking Promise) | `requestApproval` JSON-RPC (blocking wait for reply) |
| Approval Disconnect Recovery | Promise held in backend memory | JSON-RPC request blocks waiting |
| Plan Mode | `setPlanMode()` native support | System prompt injection |

### 4.4 Session Manager

SessionManager is the core of the OpenLobby backend, managing the lifecycle of all active sessions.

```typescript
// packages/server/src/session-manager.ts

interface ManagedSession {
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
  permissionMode?: string;
  lastMessage?: string;
  origin: 'lobby' | 'cli' | 'lobby-manager';
  planMode: boolean;
}
```

Key responsibilities:
- **Session creation / resumption / destruction**: Creates AgentProcess via Adapter, maintains the `sessions` Map
- **Message routing**: Both WebSocket handler and Channel Router send and receive messages through SessionManager
- **Event broadcasting**: Three listener groups -- `onMessage`, `onSessionUpdate`, `onNavigate` -- supporting multiple consumers (ws-handler, channel-router) listening in parallel
- **Session ID synchronization**: When creating a session, a UUID placeholder is used initially; once the CLI subprocess returns the real session ID, all consumers are notified via `session.updated` (with `previousId`)
- **Plan Mode state**: The `pendingPlanMode` Map stores plan mode settings temporarily when a session has not yet loaded
- **Message cache**: The `messageCache` Map serves as a fallback when the Adapter cannot read history from disk
- **SQLite persistence**: Every state change is synchronously written to SQLite; on server restart, `markAllSessionsStopped()` marks all active sessions as stopped

### 4.5 WebSocket Communication Protocol

Frontend and backend communicate via WebSocket using JSON messages. The complete protocol is defined in `protocol.ts` within `@openlobby/core`.

#### Frontend -> Backend (ClientMessage)

| Message Type | Purpose |
|-------------|---------|
| `session.create` | Create a new session (specify adapter, options, displayName) |
| `session.resume` | Resume a stopped session |
| `session.destroy` | Destroy a session |
| `session.list` | Request the current session list |
| `session.history` | Request history messages for a specific session |
| `session.discover` | Scan for CLI native sessions (optional cwd filter) |
| `session.import` | Import a discovered CLI native session |
| `session.configure` | Update a session's SpawnOptions at runtime |
| `session.plan-mode` | Toggle Plan Mode for a specific session |
| `session.recover` | Attempt to recover a stopped/error session |
| `message.send` | Send a user message to a specific session |
| `control.respond` | Respond to a tool approval request (allow / deny) |
| `channel.list-providers` | List configured IM Providers |
| `channel.add-provider` | Add a new IM Provider configuration |
| `channel.remove-provider` | Remove an IM Provider |
| `channel.toggle-provider` | Enable/disable an IM Provider |
| `channel.list-bindings` | List all IM user bindings |
| `channel.bind` | Bind an IM user to a specific session or lobby-manager |
| `channel.unbind` | Unbind an IM user |

#### Backend -> Frontend (ServerMessage)

| Message Type | Purpose |
|-------------|---------|
| `session.created` | Session created successfully |
| `session.updated` | Session state change (includes optional `previousId` for ID synchronization) |
| `session.destroyed` | Session has been destroyed |
| `session.list` | Session list response |
| `session.history` | History messages response |
| `session.discovered` | CLI native session scan results |
| `session.navigate` | Instruct frontend to switch to a specific session (triggered by Lobby Manager) |
| `message` | Session message push (LobbyMessage) |
| `control.request` | Tool approval request |
| `lm.status` | Lobby Manager availability status and sessionId |
| `error` | Error notification |
| `channel.providers-list` | Provider list response |
| `channel.provider-status` | Provider health status change |
| `channel.bindings-list` | Bindings list response |
| `channel.binding-updated` | Binding relationship change |
| `channel.binding-removed` | Binding has been removed |

### 4.6 Unified Message Format (LobbyMessage)

All Adapter outputs are converted to the unified `LobbyMessage` format:

```typescript
interface LobbyMessage {
  id: string;
  sessionId: string;
  timestamp: number;
  type: 'system' | 'user' | 'assistant' | 'tool_use' | 'tool_result'
      | 'control' | 'stream_delta' | 'result';
  content: string | Record<string, unknown>;
  meta?: {
    model?: string;
    tokenUsage?: { input: number; output: number };
    costUsd?: number;
    toolName?: string;
    isError?: boolean;
  };
}
```

OpenLobby does not store message history -- it only reads the CLI native JSONL files. The sole source of truth for message history is the JSONL written by the CLI itself. This means:
1. Messages seen in OpenLobby = what `claude --resume` / `codex resume` shows, with zero discrepancy
2. Users can close OpenLobby at any time and return to the terminal to continue working without losing any context
3. There will never be messages that "exist in OpenLobby but not in the terminal"

When the Adapter cannot read history from disk (e.g., the session file has not been flushed yet), SessionManager's `messageCache` provides a fallback.

---

## 5. Lobby Manager

Lobby Manager (LM) is OpenLobby's built-in meta-agent. It **is itself a standard CLI session** (origin: `'lobby-manager'`), managed through SessionManager, sharing the same message stream and UI as regular sessions.

### Design Philosophy

LM is not a standalone API call or UI panel -- it is a Claude Code / Codex CLI session with a strictly constrained system prompt. The benefits:
- **Zero extra configuration**: Reuses the user's already-installed CLI authentication, no separate API key needed
- **Cross-CLI compatible**: Prefers Codex CLI (lower cost), but can also use Claude Code
- **Unified experience**: Appears alongside other sessions in the Sidebar, click to chat

### Responsibilities

LM is a **pure router** -- it does not execute any concrete tasks, only session management:
- List / search sessions
- Create new sessions (auto-select adapter, generate names)
- Discover and import terminal-created CLI sessions
- Navigate the Web UI to a specific session
- Rename / destroy sessions
- Clean up idle sessions

When a user sends a coding task (e.g., "write me a script"), LM will not execute it itself -- instead, it creates or finds an appropriate session, then navigates to it.

### Implementation

```typescript
// packages/server/src/lobby-manager.ts

class LobbyManager {
  private sessionManager: SessionManager;
  private adapters: Map<string, AgentAdapter>;
  private mcpApiPort: number;

  sessionId: string | null = null;
  adapterName: string | null = null;
}
```

Startup flow:
1. Detect installed CLIs by priority (codex-cli > claude-code)
2. Attempt to restore the previous LM session from SQLite (`getSessionByOrigin('lobby-manager')`)
3. If restoration fails, create a new session with injected:
   - system prompt: strictly limited to session router role
   - `permissionMode: 'dontAsk'`: LM does not need approval
   - `allowedTools`: only `mcp__openlobby__lobby_*` series tools allowed
   - `mcpServers`: inject OpenLobby MCP Server, providing `lobby_*` tools
4. Listen for `session.updated` events to track session ID changes (UUID -> real CLI session ID)

### MCP Server

OpenLobby exposes a stdio-mode MCP Server (`packages/server/src/mcp-server.ts`) that registers session management operations as standard MCP tools:

| Tool | Purpose |
|------|---------|
| `lobby_list_sessions` | List all sessions |
| `lobby_create_session` | Create a new session (supports initialPrompt) |
| `lobby_rename_session` | Rename a session |
| `lobby_destroy_session` | Destroy a session |
| `lobby_session_info` | Get session details |
| `lobby_cleanup_idle` | Clean up idle sessions |
| `lobby_discover_sessions` | Scan for CLI native sessions |
| `lobby_import_session` | Import a discovered session |
| `lobby_navigate_session` | Navigate UI to a specific session |

The MCP Server communicates with the OpenLobby backend via the MCP Internal API (default port 3002). This API is REST-style -- the MCP Server runs as a stdio process spawned by the CLI, calling the backend via HTTP.

MCP tools are not limited to LM usage -- users in any terminal coding session can also call them (e.g., "show me the status of other sessions").

---

## 6. Channel Integration

The Channel system allows users to interact with OpenLobby sessions through external IM platforms (WeCom, Telegram, Feishu, etc.).

### Core Concepts

- **ChannelProvider**: Each IM platform implements a Provider, responsible for receiving webhooks and sending messages
- **ChannelRouter**: The router that dispatches inbound messages to the correct session and relays session messages back to IM users
- **ChannelIdentity**: A `channelName:accountId:peerId` triple that uniquely identifies an IM user
- **ChannelBinding**: The binding relationship between an IM user and a session, determining where messages are routed

### ChannelProvider Interface

```typescript
// @openlobby/core — packages/core/src/channel.ts

interface ChannelProvider {
  readonly channelName: string;   // 'wecom' | 'telegram' | 'feishu'
  readonly accountId: string;

  start(router: ChannelRouter): Promise<void>;
  stop(): Promise<void>;
  sendMessage(msg: OutboundChannelMessage): Promise<void>;
  isHealthy(): boolean;
  updateCard?(peerId: string, taskId: string, resultText: string): Promise<void>;
  getWebhookHandlers?(): Array<{ method: string; path: string; handler: Function }>;
}
```

Currently, the WeCom Provider (`packages/server/src/channels/wecom.ts`) is implemented.

### ChannelRouter

`ChannelRouterImpl` (`packages/server/src/channel-router.ts`) bridges IM and SessionManager:

**Inbound flow** (IM user sends message -> OpenLobby):
1. Provider receives webhook, constructs `InboundChannelMessage`
2. Router's `handleInbound()` looks up or creates a binding
3. Routes based on the binding's target:
   - `'lobby-manager'`: Route to the LM session (user creates/switches sessions via LM)
   - Specific sessionId: Route directly to the specified session
4. Send typing indicator to IM (`<think>` tag format)
5. Call `sessionManager.sendMessage()` to forward the message to the target session

**Outbound flow** (session messages -> IM user):
1. Router listens to SessionManager's `onMessage` and `onSessionUpdate` events
2. Reverse-looks up the IM user to reply to via the `lastSenderBySession` Map
3. Handles throttling and buffering of streaming messages (stream_delta)
4. Converts assistant messages, tool approval requests, etc. to IM format and sends them
5. Approval requests include inline action buttons, supporting in-IM approval

**Special commands**:
- `/exit`: IM user sends this command to return from the current session to Lobby Manager

### Binding Model

Each IM user is bound to `lobby-manager` by default. When LM creates/switches sessions based on user intent, it updates the binding's `activeSessionId`. This way, IM users don't need to manually manage bindings -- they can switch between sessions using natural language.

Binding relationships are persisted in SQLite's `channel_bindings` table. `activeSessionId` has a unique index (a session can only be bound to one IM user at a time).

---

## 7. Plan Mode

Plan Mode makes a CLI session output only plans without executing actions, suitable for scenarios where the approach needs to be reviewed before execution.

### Implementation

- **Frontend**: Plan/Act toggle button in RoomHeader, sent to backend via `session.plan-mode` message
- **Backend**: SessionManager calls `process.updateOptions()` or `process.setPlanMode()` to update CLI behavior
- **Claude Code Adapter**: Natively supports the `--plan-mode` flag, toggled directly via `setPlanMode()`
- **Codex CLI Adapter**: Implemented via system prompt injection, appending a "plan only" instruction to the system prompt

Plan Mode state is stored in the `ManagedSession.planMode` field and conveyed to the frontend for display via `SessionSummary.planMode`.

---

## 8. Data Persistence

### SQLite Schema

OpenLobby only stores lightweight metadata in SQLite -- no message history. The database is located at `~/.openlobby/sessions.db`.

#### sessions table

```sql
CREATE TABLE sessions (
  id             TEXT PRIMARY KEY,
  adapter_name   TEXT NOT NULL,
  display_name   TEXT,
  cwd            TEXT NOT NULL,
  jsonl_path     TEXT,
  origin         TEXT DEFAULT 'lobby',    -- 'lobby' | 'cli' | 'lobby-manager'
  status         TEXT DEFAULT 'idle',
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  model          TEXT,
  tags           TEXT                      -- JSON array, user-defined tags
);
```

#### channel_providers table

```sql
CREATE TABLE channel_providers (
  id            TEXT PRIMARY KEY,          -- "channelName:accountId"
  channel_name  TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  config_json   TEXT NOT NULL,             -- Full ChannelProviderConfig JSON
  enabled       INTEGER DEFAULT 1,
  created_at    INTEGER NOT NULL
);
```

#### channel_bindings table

```sql
CREATE TABLE channel_bindings (
  identity_key       TEXT PRIMARY KEY,     -- "channelName:accountId:peerId"
  channel_name       TEXT NOT NULL,
  account_id         TEXT NOT NULL,
  peer_id            TEXT NOT NULL,
  peer_display_name  TEXT,
  target             TEXT NOT NULL,        -- 'lobby-manager' | sessionId
  active_session_id  TEXT,                 -- Currently active sessionId
  created_at         INTEGER NOT NULL,
  last_active_at     INTEGER NOT NULL
);

-- Ensure a session can only be bound to one IM user at a time
CREATE UNIQUE INDEX idx_binding_active_session
  ON channel_bindings(active_session_id)
  WHERE active_session_id IS NOT NULL;
```

### CLI Native Session Files

| CLI | Storage Path | File Format |
|-----|-------------|-------------|
| Claude Code | `~/.claude/projects/<encoded-cwd>/*.jsonl` | JSONL |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL |

Each Adapter implements `readSessionHistory()` to convert CLI-specific event formats into the unified `LobbyMessage[]`.

---

## 9. Disconnect Recovery and State Resilience

### Scenario Matrix

| Scenario | Backend Subprocess | Frontend Connection | Recovery Strategy |
|----------|-------------------|--------------------|--------------------|
| A. Switch to another Room | Keeps running | Maintained | No action needed when switching back |
| B. Close browser, backend still alive | Keeps running | Disconnected | After reconnecting, `session.list` fetches latest state; entering a Room triggers `session.history` to reload |
| C. Backend also restarted | Process lost | Disconnected | `markAllSessionsStopped()` marks all active sessions as stopped; frontend shows Recover button |
| D. CLI subprocess crashes on its own | Process exits | Maintained | Backend catches exit event, pushes `session.updated`; messages already in JSONL are not lost |

### Recovery Mechanisms

- **Session Recover**: Frontend sends `session.recover`, backend attempts to reconnect to the CLI session via the Adapter's `resume()`
- **Lobby Manager Recovery**: On startup, LM prioritizes restoring the existing LM session from SQLite to maintain conversation history continuity
- **Channel Binding Recovery**: IM bindings are persisted in SQLite, automatically restored after backend restart
- **Tool Approval Recovery**: In scenario B, the CLI subprocess is still blocking on approval; after reconnection, `control.request` is re-pushed to the frontend

---

## 10. Frontend UI

The frontend uses React + Tailwind CSS + Zustand for state management, with the classic IM two-column layout.

### Component Structure

| Component | File | Responsibility |
|-----------|------|----------------|
| App | `App.tsx` | Root component, WebSocket initialization, routing |
| Sidebar | `Sidebar.tsx` | Session list dashboard + new session button |
| RoomHeader | `RoomHeader.tsx` | Current session info, Plan Mode toggle, Resume command |
| MessageList | `MessageList.tsx` | Message list rendering |
| MessageBubble | `MessageBubble.tsx` | Single message rendering (styled by type) |
| MessageInput | `MessageInput.tsx` | Input box + slash command |
| ControlCard | `ControlCard.tsx` | Tool approval card (Allow / Deny) |
| ChoiceCard | `ChoiceCard.tsx` | Choice card (Plan Mode execution confirmation, etc.) |
| NewSessionDialog | `NewSessionDialog.tsx` | New session dialog |
| DiscoverDialog | `DiscoverDialog.tsx` | CLI session discovery and import |
| ChannelManagePanel | `ChannelManagePanel.tsx` | IM Provider and Binding management panel |
| SlashCommandMenu | `SlashCommandMenu.tsx` | Slash command dropdown menu |
| TypingIndicator | `TypingIndicator.tsx` | Typing indicator |

### Message Rendering Rules

Information hierarchy consistent with CLI terminal:
- **system**: Small gray text, session initialization info
- **assistant**: Markdown rendered, code blocks with syntax highlighting
- **tool_use**: Collapsible panel, showing tool name and parameters
- **tool_result**: Collapsible panel, showing result summary
- **stream_delta**: Appended in real-time to the current assistant message block (typewriter effect)
- **control**: Highlighted card with Allow / Deny buttons
- **result**: Session summary card

---

## 11. Project Structure (Monorepo)

```
openlobby/
├── package.json                    # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── CLAUDE.md                       # Claude Code project instructions
├── docs/
│   └── architecture.md             # This document
├── packages/
│   ├── core/                       # @openlobby/core — Core types and interfaces
│   │   ├── src/
│   │   │   ├── types.ts            # LobbyMessage, AgentAdapter, AgentProcess, SessionSummary
│   │   │   ├── protocol.ts         # ClientMessage, ServerMessage (WebSocket protocol)
│   │   │   ├── channel.ts          # ChannelProvider, ChannelRouter, ChannelIdentity, Binding
│   │   │   ├── adapters/
│   │   │   │   ├── claude-code.ts  # Claude Code adapter
│   │   │   │   ├── codex-cli.ts    # Codex CLI adapter
│   │   │   │   └── index.ts
│   │   │   └── index.ts
│   │   └── package.json
│   │
│   ├── server/                     # @openlobby/server — Backend service
│   │   ├── src/
│   │   │   ├── index.ts            # Fastify service entry point
│   │   │   ├── session-manager.ts  # Session lifecycle management
│   │   │   ├── lobby-manager.ts    # Lobby Manager (built-in meta-agent)
│   │   │   ├── channel-router.ts   # IM channel router
│   │   │   ├── channels/
│   │   │   │   ├── wecom.ts        # WeCom Provider
│   │   │   │   └── index.ts        # Provider factory
│   │   │   ├── mcp-server.ts       # MCP Server (stdio) — lobby_* tools
│   │   │   ├── ws-handler.ts       # WebSocket connection handler
│   │   │   └── db.ts               # SQLite persistence
│   │   └── package.json
│   │
│   ├── web/                        # @openlobby/web — Frontend Web UI
│   │   ├── src/
│   │   │   ├── App.tsx
│   │   │   ├── main.tsx
│   │   │   ├── components/         # UI components
│   │   │   ├── hooks/
│   │   │   │   └── useWebSocket.ts # WebSocket connection management
│   │   │   └── stores/
│   │   │       └── lobby-store.ts  # Zustand state management
│   │   └── package.json
│   │
│   └── cli/                        # @openlobby/cli — CLI entry point (planned)
│       └── package.json
│
└── pnpm-lock.yaml
```

---

## 12. Data Flow

### 12.1 Real-time Interaction (Web UI -> CLI Session)

```
1. User types a message in the Room input box and clicks send
2. Frontend sends via WebSocket:
   { type: 'message.send', sessionId: 'xxx', content: 'Help me refactor this function' }

3. Backend ws-handler receives it and calls SessionManager.sendMessage()
4. SessionManager finds the corresponding ManagedSession and calls process.sendMessage()
5. Adapter converts the message to CLI format and writes it to the subprocess

6. CLI subprocess processes the request and outputs an event stream via stdout
   (CLI simultaneously appends messages to the local JSONL file)
7. Adapter parses each line, converts to LobbyMessage, and emits a 'message' event
8. SessionManager receives the message and:
   a. Updates the session index in SQLite (lastActiveAt, etc.)
   b. Broadcasts to all consumers via message listeners
   c. ws-handler pushes to the frontend via WebSocket
   d. channel-router checks for IM bindings and forwards to IM if found

9. Frontend receives the message, updates the Room message list, renders in real-time
```

### 12.2 IM Channel Interaction

```
1. IM user sends a message in WeCom
2. WeCom Provider receives webhook, constructs InboundChannelMessage
3. ChannelRouter.handleInbound():
   a. Look up or create binding
   b. Determine routing target (lobby-manager or specific session)
   c. Send typing indicator to IM
   d. Call sessionManager.sendMessage()

4. CLI finishes processing, message is broadcast via SessionManager
5. ChannelRouter.handleSessionMessage():
   a. Find the corresponding IM user via lastSenderBySession
   b. stream_delta messages: throttled buffering (800ms interval) to avoid IM rate limits
   c. assistant/result messages: formatted as markdown and sent
   d. control messages: sent with inline action buttons

6. Approval flow:
   a. IM user clicks approve/deny button
   b. Provider receives callbackData
   c. Router parses callbackData, calls sessionManager.respondControl()
   d. Provider.updateCard() updates the card to show approval result
```

### 12.3 Lobby Manager Routing

```
1. IM user (or Web UI user) sends to LM session: "Create a session for handling weekly reports"
2. LM (Claude Code/Codex CLI session) parses the intent
3. LM calls MCP tool: lobby_create_session
4. MCP Server calls backend API via HTTP: POST /api/sessions
5. SessionManager creates a new session
6. LM calls MCP tool: lobby_navigate_session
7. Backend pushes session.navigate to frontend (Web UI auto-switches)
8. Channel Router updates the IM user's activeSessionId (subsequent IM messages route to the new session)
```

---

## 13. Key Technical Decision Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Claude Code integration | `@anthropic-ai/claude-agent-sdk` | SDK encapsulates subprocess management; `canUseTool` callback supports runtime approval; session/auth shared with CLI |
| Codex CLI integration | `codex app-server` + JSON-RPC | SDK `runStreamed()` doesn't expose approval events; app-server's `requestApproval` supports per-tool approval |
| Message storage | None -- reads CLI native JSONL | CLI already persists full history; OpenLobby only stores session index |
| Lobby Manager | Reuses installed CLI Adapter | Zero extra configuration; essentially a regular session with a constrained system prompt |
| LM tools | MCP Server | Cross-CLI compatible; structured tool schema; not limited to LM usage |
| IM integration | ChannelProvider + ChannelRouter | Decouples IM platform differences; binding model supports LM routing and direct binding |
| Plan Mode | Adapter native + system prompt fallback | Claude Code natively supports plan mode flag; Codex uses prompt injection |
| Frontend-backend communication | WebSocket | Streaming messages are a natural fit for WS |
| State management | Zustand | Lightweight, TypeScript-friendly |
| Persistence | SQLite | Session index + channel config/bindings, zero configuration |
| Monorepo | pnpm workspace | Native workspace support, `@openlobby/*` scoped packages |

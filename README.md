<p align="center">
  <h1 align="center">OpenLobby</h1>
  <p align="center">Unified session manager for AI coding agents</p>
  <p align="center">
    <a href="README.md">English</a> | <a href="docs/README.zh-CN.md">中文</a>
  </p>
</p>

---

Manage Claude Code and Codex CLI sessions in an IM-style web UI. OpenLobby lets you run, monitor, and switch between multiple AI coding agent sessions from a single browser tab — think of it as a "chat app" for your coding agents.

## Why OpenLobby?

**Run multiple AI agents in parallel, manage them all from one place.**

- **Full session fidelity** — Sessions are 100% compatible with the native CLI. Import existing sessions, or resume any session in the terminal with `claude --resume`. Nothing is lost.
- **Rapid multi-tasking** — Switch between agent sessions instantly in the web UI. One person can run 5, 10, or more coding tasks at the same time, each in its own isolated context.
- **Lobby Manager (LM)** — A dedicated meta-agent that only handles session routing and management. It never touches your code or answers your questions — it just creates, finds, and navigates you to the right session. Every session's context stays clean and separate.
- **Single IM, multiple sessions** — Bind to WeCom or Telegram and switch sessions within one chat thread. No need for a separate bot per project. Use `/goto`, `/add`, `/exit` to navigate, or let the Lobby Manager route you automatically.
- **Interactive approval cards** — Tool execution requires your approval. Rich cards show tool name, input, and allow/deny buttons — on both Web and IM. For `AskUserQuestion` calls, question cards render single-select and multi-select options.

## Features

- **Multi-agent support** — Claude Code (via `claude-agent-sdk`) and Codex CLI (via `codex app-server` + JSON-RPC)
- **IM-style interface** — Real-time streaming, markdown rendering, and tool call visualization
- **Tool approval** — Interactive approve/deny cards with question cards for single/multi-select
- **Session discovery** — Detect and import existing CLI sessions from the terminal
- **Plan mode** — Read-only planning mode that restricts agents to analysis only
- **LobbyManager** — Built-in meta-agent that routes requests to the right session (MCP-powered)
- **IM channel binding** — Bridge sessions to WeCom / Telegram, extensible to Feishu and more
- **Persistent sessions** — SQLite session index; messages read directly from CLI-native JSONL
- **Single command** — `npx openlobby` bundles the full stack

## Architecture

```
Browser (React + Zustand)
  ↕ WebSocket
Node.js Server (Fastify)
  ├─ SessionManager ── session lifecycle, message routing
  ├─ LobbyManager ──── meta-agent for session management (MCP)
  ├─ ChannelRouter ─── IM platform message bridging
  └─ Adapters
       ├─ ClaudeCodeAdapter (claude-agent-sdk)
       └─ CodexCliAdapter   (codex app-server + JSON-RPC)
            ↕
       Local CLI binaries (claude, codex)
```

> For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

## Project Structure

```
packages/
├── core/       @openlobby/core     — Types, Adapter interface, protocol, channel definitions
├── server/     @openlobby/server   — Fastify server, SessionManager, WebSocket, MCP, channels
├── web/        @openlobby/web      — React frontend (Vite + Tailwind)
└── cli/        openlobby          — CLI entry point & esbuild bundled distribution
```

## Prerequisites

### Install AI CLI Tools

OpenLobby requires at least one AI coding CLI installed on your machine.

**Claude Code** (recommended):

```bash
# Install via npm
npm install -g @anthropic-ai/claude-code

# Verify installation
claude --version
```

> Requires an Anthropic API key. Set `ANTHROPIC_API_KEY` in your environment, or authenticate via `claude` on first run. See [Claude Code docs](https://docs.anthropic.com/en/docs/claude-code) for details.

**Codex CLI** (optional):

```bash
# Install via npm
npm install -g @openai/codex

# Verify installation
codex --version
```

> Requires an OpenAI API key. Set `OPENAI_API_KEY` in your environment. See [Codex CLI repo](https://github.com/openai/codex) for details.

### System Requirements

- Node.js >= 20
- pnpm (for development)

## Quick Start

```bash
npx openlobby
```

This starts the OpenLobby server on port 3001 and opens the web UI at `http://localhost:3001`.

```bash
# Custom port
npx openlobby --port 8080

# Custom MCP internal API port (default: server port + 1)
npx openlobby --mcp-port 4002

# Or via environment variable
OPENLOBBY_MCP_PORT=4002 npx openlobby
```

## Usage Scenarios

### Multi-task parallel development

Open the web UI and create multiple sessions — one for a frontend feature, one for a backend API, one for writing tests. Switch between them instantly in the sidebar. Each session has its own isolated AI context. You can monitor all of them progressing simultaneously.

### Import and resume CLI sessions

Already running a Claude Code session in the terminal? Click **Import** in the sidebar to discover and import it into OpenLobby. Later, you can resume that same session back in the terminal:

```bash
# Resume command is shown in the session header
claude --resume <session-id>
```

Sessions are fully portable between OpenLobby and the native CLI.

### IM-powered session management

Bind your WeCom or Telegram account to OpenLobby. All your agent sessions are accessible through a single IM chat thread:

```
You:  帮我写一个 todo app
LM:   建议创建新会话 "todo-app"，确认吗？
You:  确认
LM:   会话已创建并已切换，请在新会话中发送你的指令。
You:  Create a React todo app with localStorage persistence
Agent: [starts working in the todo-app session...]

You:  /goto backend-api
      ✅ 已切换到会话: backend-api
You:  Add pagination to the /users endpoint
Agent: [starts working in the backend-api session...]
```

No need for separate bots per project. One chat, many sessions.

### Tool approval from anywhere

When an agent needs to run a tool that requires approval, you get an interactive card — whether you're in the web UI or on your phone via IM. For `AskUserQuestion` calls, rich question cards let you pick from options (single or multi-select) directly.

## Development

### Setup

```bash
git clone <repo-url>
cd OpenLobby
pnpm install
```

### Dev Mode

```bash
# Start both frontend and backend
pnpm dev

# Or individually
pnpm --filter @openlobby/server dev   # Backend (port 3001)
pnpm --filter @openlobby/web dev      # Frontend (port 5173)
```

### Build

```bash
# Build all packages
pnpm build

# Build CLI distribution (bundles server + web assets)
pnpm build:cli
```

### Testing

```bash
pnpm test
```

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Adapter** | Abstraction layer — each CLI implements an Adapter (ClaudeCode, CodexCLI) |
| **LobbyMessage** | Unified message format — all adapter outputs are normalized to this type |
| **SessionManager** | Manages session lifecycle: create, resume, destroy, message routing |
| **LobbyManager** | Meta-agent that manages sessions via MCP tools (never executes coding tasks) |
| **ChannelRouter** | Routes messages between IM platforms and sessions |

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict, ESM) |
| Frontend | React 19, Zustand, Tailwind CSS, Vite |
| Backend | Fastify, WebSocket, MCP SDK |
| Database | SQLite (better-sqlite3) — session index only |
| CLI integration | claude-agent-sdk, codex app-server (JSON-RPC) |
| Build | Vite (frontend), esbuild (CLI bundle), tsc (packages) |
| Package manager | pnpm workspace |

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes and add tests
4. Run `pnpm build && pnpm test` to verify
5. Submit a pull request

Please follow the existing code conventions: ESM imports, strict TypeScript, interface-first design.

## License

MIT

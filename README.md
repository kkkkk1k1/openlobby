<p align="center">
  <h1 align="center">OpenLobby</h1>
  <p align="center">Unified session manager for AI coding agents</p>
  <p align="center">
    <a href="README.md">English</a> | <a href="docs/README.zh-CN.md">中文</a>
  </p>
</p>

---

Manage Claude Code and Codex CLI sessions in an IM-style web UI. OpenLobby lets you run, monitor, and switch between multiple AI coding agent sessions from a single browser tab — think of it as a "chat app" for your coding agents.

## Features

- **Multi-agent support** — Claude Code (via `claude-agent-sdk`) and Codex CLI (via `codex app-server` + JSON-RPC)
- **IM-style interface** — Real-time streaming, markdown rendering, and tool call visualization
- **Tool approval** — Interactive approve/deny cards, persisted across browser reconnects
- **Session discovery** — Detect and import existing CLI sessions from the terminal
- **Plan mode** — Read-only planning mode that restricts agents to analysis only
- **LobbyManager** — Built-in meta-agent that routes requests to the right session (MCP-powered)
- **IM channel binding** — Bridge sessions to WeCom, extensible to Telegram/Feishu
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

## Usage

### Prerequisites

- Node.js >= 20
- At least one of: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) or [Codex CLI](https://github.com/openai/codex)

### Quick Start

```bash
npx openlobby
```

This starts the OpenLobby server on port 3001 and opens the web UI.

```bash
# Custom port
npx openlobby --port 8080
```

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

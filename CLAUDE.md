# OpenLobby

## Overview
OpenLobby is a Web application for unified Agentic CLI session management.
Users can manage multiple AI coding agent sessions (Claude Code, Codex CLI) through an IM-style interface.

## Tech Stack
- Full-stack TypeScript, pnpm monorepo
- Frontend: React + Tailwind + Vite
- Backend: Node.js + Fastify + WebSocket
- Persistence: SQLite (better-sqlite3)
- CLI communication:
  - Claude Code: `@anthropic-ai/claude-agent-sdk` (query() async generator, canUseTool callback for approvals)
  - Codex CLI: `codex app-server` subprocess + JSON-RPC (requestApproval for approvals)
- IM channels: WeCom implemented, extensible to Telegram / Feishu

## Project Structure
- `packages/core/` — Core type definitions, Adapter interface, protocol, channel types
- `packages/server/` — Backend WebSocket server, SessionManager, ChannelRouter, LobbyManager
- `packages/web/` — React frontend
- `packages/cli/` — CLI entry point & esbuild bundled distribution

## Core Concepts
- **Adapter**: Abstraction layer — each Agentic CLI implements an Adapter
- **LobbyMessage**: Unified message format — all Adapter outputs are normalized to this type
- **SessionManager**: Manages the lifecycle of all active sessions
- **LobbyManager**: Built-in meta-agent that manages sessions via MCP tools (routes user requests to sessions)
- **ChannelRouter**: IM channel router — bridges external IM messages to sessions

## Code Conventions
- ESM (import/export)
- Strict TypeScript (strict: true)
- Interface-first, program to abstractions
- Tests use vitest

## Workflow Rules
- Each bug fix or feature must be committed separately with its own commit message
- Use superpowers skills for structured workflows:
  - `/superpowers:brainstorming` — Before any new feature or design work
  - `/superpowers:writing-plans` — Before multi-step implementation
  - `/superpowers:subagent-driven-development` — Execute plans with per-task subagents
  - `/superpowers:test-driven-development` — Write tests before implementation
  - `/superpowers:systematic-debugging` — Debug before proposing fixes
  - `/superpowers:verification-before-completion` — Verify work before claiming done
- Use project skill `/new-cli-adapter` to generate new Agentic CLI adapter packages
- Use project skill `/new-channel-provider` to generate new IM channel provider packages

## Common Commands
- `pnpm install` — Install dependencies
- `pnpm -r build` — Build all packages
- `pnpm --filter @openlobby/server dev` — Start backend dev server
- `pnpm --filter @openlobby/web dev` — Start frontend dev server
- `pnpm build:cli` — Build CLI distribution package

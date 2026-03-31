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
- **MANDATORY: All feature upgrades and bug fixes MUST follow the superpowers workflow.** Do NOT skip these steps or implement changes directly without going through the process:
  - `/superpowers:brainstorming` — **Required** before any new feature or design work. Produce a design spec first.
  - `/superpowers:writing-plans` — **Required** before multi-step implementation. Produce an implementation plan from the spec.
  - `/superpowers:subagent-driven-development` — **Required** to execute plans with per-task subagents and two-stage review.
  - `/superpowers:test-driven-development` — Write tests before implementation
  - `/superpowers:systematic-debugging` — **Required** before proposing any bug fix. Diagnose root cause first, then fix.
  - `/superpowers:verification-before-completion` — **Required** before claiming work is done. Verify with evidence.
- Use project command `/new-cli-adapter` to generate new Agentic CLI adapter packages
- Use project command `/new-channel-provider` to generate new IM channel provider packages
- Use project command `/release` to publish a new version

## Common Commands
- `pnpm install` — Install dependencies
- `pnpm -r build` — Build all packages
- `pnpm --filter @openlobby/server dev` — Start backend dev server
- `pnpm --filter @openlobby/web dev` — Start frontend dev server
- `pnpm build:cli` — Build CLI distribution package

# Changelog

## v0.3.3 (2026-03-30)

### Bug Fixes

- **[CRITICAL] Codex CLI global config pollution** — LobbyManager's system prompt ("You are a SESSION ROUTER") was written to `~/.codex/config.toml` via `config/value/write` on session resume, permanently turning ALL Codex CLI sessions into Lobby Manager behavior. Removed global config writes on resume; threads inherit their original `developerInstructions` from creation.

## v0.3.2 (2026-03-30)

### Features

- **WeCom image/file decryption** — Download and decrypt WeCom encrypted media using SDK `decryptFile` with per-message `aeskey`. Images and files are now properly saved as readable local files.
- **IM attachment local download** — IM attachments (images, files, voice) are downloaded to session's `.openlobby-cache/` directory and passed as `[Attached: /path]` to agent sessions, matching Web upload behavior.
- **Discover session CLI filter** — DiscoverDialog gains adapter filter tabs (All/CC/CX) when multiple adapter types have sessions.

### Bug Fixes

- **MCP server missing from npm package** — `mcp-server.ts` was bundled into `bin.js` but LobbyManager references it as a separate subprocess file. Now built as standalone `dist/mcp-server.js` and included in npm tarball.
- **Codex session discovery** — `extractCodexMeta` read only 4KB but Codex `session_meta` lines can be 15KB+. Increased to 64KB, extract UUID from filename, relaxed empty session filter. Sessions found: 3 → 25.
- **Discovered sessions sort order** — Sessions were grouped by adapter (all CC then all CX) instead of unified time sort. Now sorted by `lastActiveAt` across all adapters.

### Documentation

- README: npm global install as primary method, FAQ section with 6 common issues

## v0.3.1 (2026-03-29)

### Features

- **LM welcome message** — First-time Web/IM users see a guided introduction with features, examples, and slash commands
- **Dynamic channel provider form** — Web UI now supports adding Telegram providers (and future channels) with per-channel credential fields

### Bug Fixes

- **Telegram callback_data overflow** — Callback data exceeded Telegram's 64-byte limit, causing buttons to silently fall back to plain text. Added callback shortener with auto-cleanup.
- **Telegram button layout** — Option buttons now render horizontally (max 3/row), special buttons on their own row
- **Telegram webhook health** — Webhook mode now correctly reports healthy status after registration
- **Telegram updateCard mapping** — Approval card message IDs are cached for proper card updates
- **Telegram typing timer key** — Normalized chatId to string for consistent Map lookups
- **Telegram not importable** — Added `openlobby-channel-telegram` as optional dependency of server package

## v0.3.0 (2026-03-29)

### Features

- **AskUserQuestion card rendering** — SDK `AskUserQuestion` tool calls now render as interactive question cards with single/multi-select options on both Web and IM
- **MCP API port configurable** — Default changed from fixed 3002 to server port + 1, configurable via `--mcp-port` or `OPENLOBBY_MCP_PORT`
- **LM no-default-initialPrompt** — LM agent no longer sends initial messages when creating/switching sessions; auto-navigates instead (Web + IM)
- **`/release` skill** — Full version publishing workflow with CHANGELOG, GitHub Release, and notification output
- **`/todo` skill** — Quick TODO capture and management
- **Channel plugin system** — Dynamic loading of IM channel providers
- **Telegram channel adapter** — Telegram bot provider with long polling and webhook support
- **Adapter plugin system** — Dynamic loading of external CLI adapter packages
- **Dynamic command completions** — Slash command autocomplete from adapter SDK
- **Source-aware channel routing** — Web-originated messages skip IM delivery; approval cards route to IM when Web is not viewing
- **WeCom rich text** — Quote messages, media directives, and rich formatting
- **Channel management MCP tools** — LobbyManager can manage IM channel providers and bindings via MCP tools
- **Shared slash commands** — `/help`, `/ls`, `/add`, `/goto`, `/rm` work on both Web and IM
- **Per-session command caching** — SQLite-backed command cache for autocomplete
- **New CLI adapter skill** — `/new-cli-adapter` for generating adapter packages
- **New channel provider skill** — `/new-channel-provider` for generating channel packages

### Bug Fixes

- **Codex CLI resume command** — Fixed from `codex --resume` to correct `codex resume` subcommand syntax
- **Resume command hardcoded as Claude** — All 3 occurrences in SessionManager now use `adapter.getResumeCommand()`
- **Tool denial interruption** — Denied tools now properly interrupt execution
- **Sessions stuck in thinking** — Fixed race condition with event wiring
- **Idle session resume** — Resume idle sessions instead of creating duplicates
- **LobbyManager adapter priority** — Prefer Claude Code adapter
- **Codex error status on kill** — Prevent false error status after intentional kill

### Documentation

- **README overhaul** — Product positioning, CLI install instructions, usage scenarios, security description
- **CLAUDE.md** — Mandatory superpowers workflow for all changes

### Other Changes

- Adapter integration test suite
- vitest added to @openlobby/core
- Commit-per-fix workflow rule

# Changelog

## v0.4.5 (2026-04-03)

### Features

- **Terminal detector** — Three-level fallback terminal detection with registry, verification, and fallback dialog with copy button when terminal open fails (a5d4ba8, d3493dc, d825f17)
- **Open in Terminal** — Integrated terminal-detector into session workflow with `open-terminal-result` protocol message (bc6ec6f)

### Bug Fixes

- **fix(core):** Auto-retry transient Claude CLI startup failures (exit code 1) with diagnostic stderr capture (344313c)
- **fix(core):** Read cwd from JSONL instead of lossy directory name decoding (6c8c00d)
- **fix(server):** Fix iTerm2 blank window — use write text instead of command parameter (b6e04b5)
- **fix(server):** Fix Telegram channel ignoring permission mode and msg-tidy settings (12e35b7)
- **fix(server):** Propagate resumeCmd, fix shell quoting, add timeouts (bc6ec6f)
- **fix(opencode):** Fix history not loading — query actual DB schema (066595d)
- **fix(web):** Rename 'Resume Cmd' button to 'Open in Terminal' (6807ac5)
- **fix(web):** Strip protocol XML tags from user message display (325443d)
- **fix(web):** Remove compact conversation button from RoomHeader (344313c)

### Other Changes

- Unit tests for terminal-detector detection, verification, and fallback (76e63d2)
- Add restart-dev.sh helper script (344313c)

## v0.4.4 (2026-04-02)

### Features

- **Session pin & rename** — Pin sessions to sidebar top and rename sessions with inline UI, WebSocket protocol, and SQLite persistence (774089f..4bfa3f4)

### Bug Fixes

- **fix(core):** Enhance Claude Code error diagnostics — capture stderr, spawn diagnostics, auto-fallback on resume failure, remove shell:true to prevent JSON argument corruption (69e6f9f)
- **fix(web):** Refactor slash command menu for synchronous detection and scored sorting (exact > prefix > partial > description match) (021836c)
- **fix(web):** Improve pinned session visual distinction in sidebar (3da8227)
- **fix(web):** Move pin/rename buttons inline to avoid overlap with adapter badge (5fb0446)
- **fix(server):** Add missing pinned field in importSession and getSessionInfo (87fa509)
- **fix(telegram):** Command menu sync failing due to duplicates and payload overflow (a78e412)

### Documentation

- Add session pin & rename design spec and implementation plan (aaf6ea3, 5d4df74)
- Add resume cmd button optimization design spec and implementation plan (8a470ca, 3241dc2)

## v0.4.3 (2026-04-02)

### Features

- **Compact command** — Per-session token tracking with auto-prompt, compact events for Claude Code and OpenCode, WebSocket action, IM notifications, and compact button in session header toolbar (2558d13..f092827)
- **Numbered session list** — `/ls` shows numbered sessions; `/goto` supports selecting by number (c1cf1e9)
- **IM command menu sync** — `CommandGroup` types, `syncCommands` for ChannelProvider, `/cmd` command, WeCom card menu, Telegram `setMyCommands`, and 4 trigger-point wiring (a3db810..fea8d06)
- **Merged settings panel** — Web settings panels merged; version displayed in sidebar (71eab37)

### Bug Fixes

- **fix:** msg-tidy mode not applied in IM due to session resolution and fallback bugs (c7e48e2)
- **fix:** Filter out Claude Code subagent sessions from discovery (11783db)
- **fix:** Import sessions oldest-first so recent ones sort to top (d12d3f6)
- **fix(telegram):** Sanitize command names for `setMyCommands` API (68e3b64)
- **fix(telegram):** Empty description rejection + WeCom `/cmd` compact markdown (7ad9bd3)

### Documentation

- Add compact command design spec and implementation plan (6d5284a, d3aa17d)
- Add `/ls` + `/goto` numbering design spec (7d789b7)
- Add IM command menu design spec and implementation plan (5754759, 46c8fc3)

### Other Changes

- Revert timestamp-related fixes that caused regressions (7cd76d1, c353164)

## v0.4.2 (2026-03-31)

### Features

- **Session ID resolution** — Add `resolveSession()` with alias map and `previousIds` tracking, so stale pre-migration UUIDs auto-resolve to current session IDs (c8b4530)
- **Rebuild from database** — `rebuildSession()` can now resume sessions that exist only in SQLite (e.g., after server reload) (c8b4530)
- **Unified PermissionMode** — New `PermissionMode` type (`auto`/`suggest`/`readonly`) with two-layer resolution (adapter defaults → session override), enforced immediately across Claude Code, Codex CLI, and OpenCode adapters (9d54629..dabfbaf)
- **Adapter defaults settings** — Web UI dialog for configuring global per-adapter default permission modes (fa4a2e0)
- **Permission badge & mode selector** — RoomHeader displays permission badge with unified mode selector (3867cd9)
- **WeCom QR scan login** — Full QR code scanning flow for WeCom channel setup (89e07d5..1f383b5)

### Bug Fixes

- **fix(server):** Stale process events no longer affect new processes after `/new` rebuild (c8b4530)
- **fix(server):** WebSocket handler auto-resolves stale session IDs for all message types (c8b4530)
- **fix(server):** Message cache cleared on rebuild for clean slate; fresh history sent to frontend (c8b4530, 323e64f)
- **fix(opencode):** Extract meaningful tool name from permission metadata (318cce2)
- **fix(opencode):** Prevent idle events from clearing awaiting_approval status (40e6c1d)
- **fix(server):** Correct WeCom QR scan response parsing — `bot_info.botid` not `bot_id` (3d56492)
- **fix(server):** Correct WeCom QR API — use `GET /ai/qc/gen` and parse HTML response (7cd980e)
- **fix:** Replace planMode references with permissionMode in frontend (59f70ba)

### Documentation

- Update CLAUDE.md workflow commands and add project command files (c850bc7)
- Add permission mode redesign spec and implementation plan (69c0295, f9f6d43)
- Add WeCom QR scan design spec and implementation plan (825a7b9, 9aded9d)

### Other Changes

- refactor(web): Extract `getMergedCommands` as reusable helper (323e64f)
- refactor(core): Move `allowedTools` from `SpawnOptions` into Claude Code adapter (e2c6e66)
- test: Update adapter tests to use unified PermissionMode (943275a)

## v0.4.1 (2026-03-31)

### Features

- **`/stop` 中断命令** — 三种 adapter 均实现 `interrupt()`（Claude Code 软中止、Codex CLI 子进程 kill、OpenCode SSE 重订阅），Web 端 Stop 按钮 + IM `/stop` 命令 (a2267f9..a103ce2)
- **消息模式** — 新增 `msg-only`（仅推送回复）/ `msg-tidy`（工具调用折叠为摘要）/ `msg-total`（推送全部），支持 Web 设置面板和 IM `/msg-*` 命令 (6fd2630..e51a5cf)
- **ToolSummaryBubble** — msg-tidy 模式下工具调用渲染为折叠的摘要气泡 (5294a7a)
- **全局设置面板** — Web 端新增全局默认 adapter 和消息模式配置，新建会话自动继承默认值 (82dceb6, 78feec9)
- **RoomHeader 消息模式下拉** — 会话级消息模式快速切换 (7c9070e)
- **`/new` 命令** — 重建当前会话的 CLI 进程 (3ae2c09, 63d26a2)
- **LobbyManager adapter 选择** — 支持按 adapter 创建会话，config 变更触发 rebuild (aa35001)
- **Telegram think 消息** — 思考过程实时推送为可编辑的 typing 消息 (5466c4c)
- **server_config 表** — SQLite 新增服务端配置持久化 (2780cf4)

### Bug Fixes

- **fix(channel-router):** msg-tidy 模式下防止重复发送 assistant 回复 (c40a980)
- **fix(channel-router):** msg-tidy stats 和 reply 发送串行化，防止 WeCom 竞态条件 (2a1cfdc)
- **fix(session-manager):** interrupt 空闲进程时强制设置 idle 状态，避免 UI 卡在 running (2be4c1e)
- **fix(web):** 斜杠命令菜单始终显示 lobby 级命令（/help, /stop, /new 等），与 adapter 命令合并去重 (8629f5b)

### Documentation

- Add session enhancements design spec and implementation plan (e70725c, e84a079)
- Add /stop command implementation plan (f64d61e)

## v0.4.0 (2026-03-30)

### Features

- **OpenCode adapter** — Full integration of OpenCode (sst/opencode) as a third built-in adapter: AgentProcess + AgentAdapter via HTTP REST + SSE, SQLite-based cross-project session discovery
- **OpenCode in Web UI** — DiscoverDialog filter tabs, Sidebar labels, RoomHeader title, NewSessionDialog button all support OpenCode
- **OpenCode in LobbyManager** — System prompt and MCP tool schemas (`lobby_create_session`, `lobby_import_session`) updated to accept `opencode` as adapter type

### Bug Fixes

- **fix(opencode): user messages appearing as assistant replies** — Track user message IDs from `message.updated` events; skip their parts in `handlePartUpdated` to prevent user input echoing in UI (b955cc5)
- **fix(lobby-manager): stale UUID on session resume** — Validate session ID existence before resume to prevent errors with stale UUIDs (d84e8ab)
- **fix(opencode): cross-project session discovery** — Use `sqlite3` CLI to query `~/.local/share/opencode/opencode.db` directly instead of scoped REST API (df80671)
- **fix(opencode): permissionMode not persisted** — Read `permission_mode` from SQLite in `listSessions`/`getSessionInfo` (fe3a410)
- **fix(web): session config not applied optimistically** — Update session config in Zustand store immediately after Apply, without waiting for server push (755029d)
- **fix(claude-code): pre-responded approvals for concurrent tools** — Handle approvals that resolve before the approval card is rendered (bac1314)
- **fix(web): approval cards cleared on single response** — Only remove the individual responded card, not all pending cards (5daef70)
- **fix(web): infinite re-render loop causing black screen** — Fix dependency cycle in useEffect causing blank UI (c36d74f)
- **fix(web): multiple concurrent approval cards** — Support rendering multiple simultaneous tool approval requests per session (b780a7c)
- **fix: permissionMode not restored on lazy resume** — Persist to SQLite and restore on session resume (cb115e2)
- **fix: Telegram provider bundled as dynamic import** — Bundle as built-in to avoid runtime import resolution failures (2943f94)
- **fix(claude-code): ProcessTransport crash on session kill** — Prevent unhandled errors when transport is destroyed (d7c5415)

### Documentation

- Add `/stop` command design spec
- Update `new-cli-adapter` skill with OpenCode lessons: Phase 9 (frontend integration checklist), Phase 10 (port conflict prevention), SQLite discovery pattern, monorepo dependency boundaries

### Other Changes

- OpenCode adapter integration test using contract suite (4384e05)

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

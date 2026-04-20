# Changelog

## v0.5.7 (2026-04-20)

### Bug Fixes
- Fix Windows Codex CLI process launch for npm shim installs (#6, 42d599e)
- Tighten Telegram msg-tidy output to a single evolving message (#7, fa189f9)
- Handle AbortError gracefully to prevent server crash on session kill (d7574a6)

### Other Changes
- Harden Windows Codex launcher handling tests (38dd514)

## v0.5.6 (2026-04-15)

### Features
- Support auto-upgrade under pm2 and other process managers (ae37440)

### Bug Fixes
- Persist resolved permissionMode so Codex sessions survive restart (2e97d13)

## v0.5.5 (2026-04-14)

### Bug Fixes
- Detect installed CLIs and build resume commands on Windows (a2d8d3f)
- Start the dev server correctly under tsx watch (f3203f2)
- Wait for the backend before opening web sockets in dev mode (894d9fc)
- Avoid double-starting the bundled server (06842f6)

## v0.5.4 (2026-04-14)

### Features
- Add VersionChecker with npm registry query and 24h cache (ed8ddfb)
- Add /api/version and /api/update server endpoints (1e961ff)
- Add lobby_check_update and lobby_update_server MCP tools (120698b)
- Add useVersionCheck hook with 30min polling and visibility awareness (c0fd7b6)
- Add UpdateDialog component for version update confirmation (0866f31)
- Refactor CLI to wrapper + child process architecture for auto-update (088dc65)
- Auto-reload frontend after server update restart (8970bb6)
- Show update button in sidebar when new version available (449226f)

### Bug Fixes
- Correct session cwd from CLI-native data before resume/rebuild (c9e1e3e)

### Other Changes
- Remove server-side version cache, always query npm registry (734ff2a)
- Add version check & auto-update design spec (3a5aef4)
- Add version check & auto-update implementation plan (6110f79)

## v0.5.3 (2026-04-13)

### Bug Fixes
- Set IS_SANDBOX=1 to allow bypassPermissions under root for Claude Code (651d67a)

## v0.5.2 (2026-04-13)

### Features
- Add bilingual UI i18n and locale switching (4c848df)

### Bug Fixes
- Expand ~ in session cwd before spawning CLI (f043848)

### Other Changes
- Replace node-pty with @homebridge/node-pty-prebuilt-multiarch for better cross-platform prebuilt support (6573fff)

## v0.5.1 (2026-04-09)

### Features
- Add Codex CLI sandbox mode mapping (permission modes → sandbox parameter) (b4e6dd0)
- Update GSD adapter for v3 JSONL session format with structured message parsing (b4e6dd0)
- Update Codex permission mode labels to reflect sandbox semantics (b4e6dd0)

## v0.5.0 (2026-04-07)

### Features
- Add GSD adapter with GsdProcess and GsdAdapter (cdfaf74)
- Register GSD adapter in core exports and server builtins (579dcc6)

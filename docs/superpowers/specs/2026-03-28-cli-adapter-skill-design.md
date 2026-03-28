# OpenLobby CLI Adapter Skill — Design Spec

## Overview

Create a project-level Claude Code skill (`.claude/skills/new-cli-adapter.md`) that automatically generates a complete, tested, pluggable CLI adapter package for OpenLobby when the user requests integration with a new Agentic CLI.

## Goal

User says "add XXX adapter to OpenLobby" → Claude Code auto-generates a fully working adapter package → tests pass → adapter registered → ready to use.

## Prerequisites (phased)

### P1: Shared Integration Test Suite

A unified test suite that validates any adapter against the real CLI. All adapters share the same test code — each adapter adds one line to invoke the suite.

**Location:** `packages/core/src/adapters/__tests__/adapter-contract.ts`

**Invocation per adapter:**
```ts
import { createAdapterIntegrationTests } from './adapter-contract';
import { ClaudeCodeAdapter } from '../claude-code';
createAdapterIntegrationTests(ClaudeCodeAdapter);
```

**Hard requirement:** CLI must be installed. If `detect()` returns `installed: false`, the entire test suite throws — no skip, no soft-fail.

**Test cases (all real CLI calls):**

| Test | What it validates |
|------|-------------------|
| `detect()` | Returns `installed: true`, version string, path |
| `spawn() + sendMessage()` | Process created, receives `assistant` or `stream_delta` message |
| Session ID sync | Initial UUID replaced by real CLI session ID via `system` message |
| `resume()` | Resumes existing session, receives response |
| Tool approval flow | `control` event emitted with requestId/toolName/toolInput; `respondControl('allow')` resumes; `respondControl('deny')` interrupts |
| Plan mode | `setPlanMode(true)` → write tools denied; read tools allowed |
| `kill()` | Process terminated, pending controls resolved, status = `stopped` |
| `readSessionHistory()` | Returns LobbyMessage[] from disk, handles empty/corrupt files |
| `discoverSessions()` | Returns SessionSummary[] of unmanaged sessions |
| `commands` event | Emitted after first query, contains AdapterCommand[] with name/description |
| Message type mapping | CLI output correctly maps to all LobbyMessage types: system, assistant, tool_use, tool_result, stream_delta, result |

### P2: Adapter Plugin System

Mirror the existing Channel plugin architecture for adapters.

**New interface in `packages/core/src/types.ts`:**
```ts
export interface AdapterPluginModule {
  createAdapter(): AgentAdapter;
  readonly adapterName: string;
  readonly displayName: string;
}
```

**Dynamic loader in `packages/server/src/adapters/index.ts`:**
- Built-in adapters: `claude-code`, `codex-cli` (hardcoded as today)
- Plugin discovery via naming convention: `openlobby-adapter-{name}`, `@openlobby/adapter-{name}`
- Dynamic `import(pkg)` with fallback
- DB table `adapter_plugins` to persist installed adapter configs

**Auto-registration in `packages/server/src/index.ts`:**
- Load built-in adapters
- Load plugin adapters from DB
- `detect()` all → `registerAdapter()` for installed ones
- Update `ADAPTER_PRIORITY` in LobbyManager dynamically

### P3: The Skill Itself

**Location:** `.claude/skills/new-cli-adapter.md`

**Trigger:** User requests adding a new CLI adapter to OpenLobby.

**Mode:** Fully automatic — generates all code, runs tests, registers on success.

## Skill Execution Flow

```
Step 1: Research
  - Investigate the target CLI's communication protocol
  - Identify: SDK/subprocess/HTTP, message format, auth, session management
  - Determine session storage location for history/discovery

Step 2: Generate Package
  packages/adapter-<name>/
  ├── package.json          (deps, scripts, peer deps on @openlobby/core)
  ├── tsconfig.json         (extends ../../tsconfig.base.json)
  └── src/
      ├── index.ts          (AdapterPluginModule export)
      ├── <name>-process.ts (AgentProcess implementation)
      ├── <name>-adapter.ts (AgentAdapter implementation)
      └── __tests__/
          └── <name>.test.ts (one-line: createAdapterIntegrationTests)

Step 3: Implement AgentAdapter
  Required methods:
  - detect()                → execSync('<cli> --version') + which
  - spawn(options)          → create process, wire events, return AgentProcess
  - resume(id, options)     → create process with resumeId, wire events
  - getSessionStoragePath() → CLI-specific path
  - readSessionHistory(id)  → parse JSONL/log files → LobbyMessage[]
  - discoverSessions(cwd?)  → scan filesystem → SessionSummary[]
  - getResumeCommand(id)    → CLI resume command string
  - listCommands()          → return fallback commands

Step 4: Implement AgentProcess
  Required:
  - sendMessage(content)    → convert to CLI protocol, send
  - respondControl(id, dec) → resolve pending approval promise
  - updateOptions(opts)     → apply runtime config changes
  - setPlanMode(enabled)    → inject read-only system prompt
  - kill()                  → terminate process, resolve all pending, emit 'exit'

  Required events:
  - 'message' (LobbyMessage) → all CLI output converted to unified format
  - 'idle'                    → turn/query completed
  - 'exit'                    → process terminated
  - 'error'                   → process error
  - 'commands' (AdapterCommand[]) → available commands/skills from CLI

  Key patterns to implement:
  - Session ID sync: initial UUID → real CLI ID via system message
  - Wire-before-send: constructor must NOT start execution
  - Approval timeout: 5 min auto-deny with interrupt
  - Settings loading: SDK settingSources or CLI config auto-load
  - Message type conversion: CLI native → LobbyMessage (the core complexity)

Step 5: Run Tests
  pnpm install
  pnpm --filter @openlobby/adapter-<name> test
  ALL tests must pass. If any fail → fix and re-run. Do NOT proceed to Step 6.

Step 6: Register (only after Step 5 passes)
  - Install package: add to pnpm-workspace.yaml if needed
  - Register as plugin: add to adapter_plugins DB or built-in list
  - Update LobbyManager ADAPTER_PRIORITY if appropriate
  - pnpm -r build → verify full build succeeds

Step 7: Verify
  - Start server: pnpm --filter @openlobby/server dev
  - Confirm health endpoint shows new adapter
  - Confirm adapter appears in session creation options
```

## Message Type Mapping Reference

The skill must include a reference table showing how to map CLI-specific message types to LobbyMessage types. This is the most complex and error-prone part of adapter development.

```
CLI Output              → LobbyMessage.type    Notes
─────────────────────── ─────────────────────  ──────────────────────────────
Init/handshake          → system               Must include sessionId for ID sync
Text response           → assistant            Full assembled text
Streaming text chunk    → stream_delta         Partial text, merged by frontend
Tool call               → tool_use             meta.toolName + JSON input as content
Tool result             → tool_result          meta.isError + output as content
Approval request        → control              content: {requestId, toolName, toolInput}
Turn complete           → result               meta: {costUsd, tokenUsage}
Error                   → system               meta.isError = true
```

## Existing Adapter Reference

| Aspect | Claude Code | Codex CLI |
|--------|-------------|-----------|
| Communication | SDK `query()` async generator | `app-server --stdio` subprocess + JSON-RPC |
| Session ID | From `system` message `session_id` field | From `thread/start` result `thread.id` |
| Tool approval | `canUseTool` callback → Promise | `requestApproval` RPC → JSON-RPC response |
| History storage | `~/.claude/projects/<dir>/<id>.jsonl` | `~/.codex/sessions/YYYY/MM/DD/<id>.jsonl` |
| Commands source | `query.supportedCommands()` SDK API | `skills/list` JSON-RPC method |
| Settings loading | `settingSources: ['user', 'project', 'local']` | Automatic (native subprocess) |
| Plan mode | System prompt injection + tool filtering | System prompt injection via `config/value/write` |
| Resume | SDK `resume` option | `thread/resume` RPC |

## Success Criteria

1. New adapter package generated with zero manual file editing
2. All integration tests pass against real CLI
3. Server starts and health endpoint reports new adapter
4. Sessions can be created, messaged, and destroyed through the new adapter
5. Tool approval flow works end-to-end
6. Session history readable and discoverable
7. Commands/skills list populated in web UI

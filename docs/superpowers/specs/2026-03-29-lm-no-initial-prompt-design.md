# LM Agent: No Default Initial Prompt on Session Create/Switch

**Date:** 2026-03-29
**Status:** Approved

## Problem

When the LM agent creates or switches to a session, it currently passes the user's original message as `initialPrompt` to the new session. This causes the new session to immediately start working before the user has a chance to review or adjust the context. The desired behavior: auto-switch to the new session (Web UI + IM channel) but let the user send their first message themselves.

## Design

### Decision Summary

- **Confirmation step:** Preserved. LM still asks the user to confirm before creating/switching.
- **initialPrompt:** LM no longer passes it. The parameter stays in the API for other callers.
- **autoNavigate:** New parameter on `lobby_create_session` (default `true`). Triggers `broadcastNavigate` after creation, which handles both Web UI navigation and IM channel binding in one call.

### Changes

#### 1. `mcp-server.ts` — `lobby_create_session` tool

- Add `autoNavigate` boolean parameter, default `true`.
- When `autoNavigate` is true, after the `POST /api/sessions` call, automatically call `POST /api/sessions/navigate` with the new session ID.
- Update `initialPrompt` description to: `"Optional initial message — only pass when explicitly needed, not by default"`.

#### 2. `mcp-api.ts` — `POST /api/sessions` endpoint

- Add optional `navigate: boolean` field to the request body.
- When `navigate` is true, call `sessionManager.broadcastNavigate(session.id)` after successful creation.
- This allows a single HTTP call to achieve create + navigate (used by MCP tool when `autoNavigate` is true).

#### 3. `lobby-manager.ts` — LM system prompt

Update Step 2 instructions:

- **Found match:** After user confirms, call `lobby_navigate_session` to switch. Do not send any message.
- **No match (create new):** After user confirms, call `lobby_create_session` with `autoNavigate` (defaults to true). Do NOT pass `initialPrompt`. Tell the user they have been switched and can now send their message.
- Add explicit rule: "NEVER pass initialPrompt unless the user explicitly asks you to."

### Unchanged

- Slash commands `/add`, `/goto` — already work correctly (no initialPrompt, auto-navigate/bind).
- `handleNavigate` in `channel-router.ts` — already handles IM auto-binding when `broadcastNavigate` fires.
- `lobby_navigate_session` tool — no changes needed.

### Data Flow (Create New Session)

```
User confirms → LM calls lobby_create_session(autoNavigate=true)
  → MCP Server calls POST /api/sessions {navigate: true}
    → SessionManager.createSession()
    → broadcastNavigate(newSessionId)
      → Web: session.navigate event → frontend switches view
      → IM: handleNavigate() → update binding → send switch notification
  → MCP Server returns result to LM
→ LM tells user: "Session created, you have been switched."
```

### Data Flow (Switch to Existing Session)

```
User confirms → LM calls lobby_navigate_session(sessionId)
  → MCP Server calls POST /api/sessions/navigate
    → broadcastNavigate(sessionId)
      → Web: session.navigate event → frontend switches view
      → IM: handleNavigate() → update binding → send switch notification
  → MCP Server returns result to LM
→ LM tells user: "Switched to session X."
```

## Files to Modify

| File | Change |
|------|--------|
| `packages/server/src/lobby-manager.ts` | Update `LM_SYSTEM_PROMPT` Step 2 |
| `packages/server/src/mcp-server.ts` | Add `autoNavigate` param to `lobby_create_session` |
| `packages/server/src/mcp-api.ts` | Add `navigate` field to `POST /api/sessions` |

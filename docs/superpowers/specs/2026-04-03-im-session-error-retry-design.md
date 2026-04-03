# IM Session Error Retry Button Design

## Problem

When an IM-bound session enters `error` or `stopped` state, the ChannelRouter immediately resets the binding and falls back to LobbyManager. This forces users to re-navigate to the session manually, losing context and momentum.

## Solution

Replace the auto-fallback with an in-place error prompt and a "重试/继续" action button. The binding stays intact so the user can resume the interrupted session with one tap, or by sending any message.

## Scope

- **Only `channel-router.ts`** — two methods: `handleSessionUpdate` and `handleCallback`
- No protocol, type, or frontend changes required

## Design

### 1. handleSessionUpdate — Error/Stopped Branch

**Current behavior (lines 1248–1270):**
- For LM-routed bindings (`target === 'lobby-manager'`): reset `active_session_id` to null, notify user with plain text
- For user-bound bindings (`target === sessionId`): no action

**New behavior (unified for all binding types):**
- Do NOT reset `active_session_id`
- Do NOT clear `lastSenderBySession`
- Send an `OutboundChannelMessage` with:
  - `text`: `⚠️ 会话异常 (${session.status})，任务可能已中断。`
  - `kind`: `'message'`
  - `actions`: `[{ label: '🔄 重试/继续', callbackData: 'resume:<sessionId>' }]`

### 2. handleCallback — New `resume:` Prefix

Add a new branch at the top of `handleCallback` (before the existing `askq/askt/askc` branch):

```typescript
if (parts[0] === 'resume') {
  const sessionId = parts[1];
  // Delegate to handleInbound with "继续" as the message text
  await this.handleInbound({
    identity: { channelName: identity.channelName, accountId: identity.accountId, peerId: identity.peerId },
    text: '继续',
    timestamp: Date.now(),
  });
  return;
}
```

This reuses the full `handleInbound` flow, which calls `sessionManager.sendMessage(sessionId, "继续")`.

### 3. Recovery Flow (already implemented in SessionManager)

`SessionManager.sendMessage` (lines 599–606) already handles both cases:

- **Process dead** (`stopped`/`error`): deletes stale session from memory, calls `lazyResume(sessionId, content)` which re-spawns the CLI process with the message as the initial prompt
- **Process alive**: directly calls `process.sendMessage(content)`

No changes to SessionManager are needed.

### 4. User Sends Custom Message Instead of Clicking Button

If the user ignores the button and sends a new message:
- Binding is still intact → `resolveSessionId` returns the error/stopped session's ID
- `sessionManager.sendMessage` detects the dead process and lazy-resumes with the user's custom message
- The user's message becomes the prompt for the resumed session (not "继续")

### 5. Recovery Failure

If `sessionManager.sendMessage` throws (e.g., adapter missing, lazyResume fails):
- The existing `try/catch` in `handleInbound` (around `sendMessage`) catches the error
- Send error message to user: `⚠️ 会话恢复失败，已切换回 Lobby Manager。`
- At this point, reset the binding (`updateBindingActiveSession(db, identityKey, null)`)

### 6. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Button clicked multiple times | First click resumes session; subsequent clicks send "继续" to the now-running session — harmless |
| Multiple users bound to same session | Each user receives their own error prompt with button; each can independently trigger resume |
| Session destroyed while error prompt visible | `handleInbound` → `resolveSessionId` returns null or `sendMessage` throws → fallback to LM |

## Files Changed

| File | Method | Change |
|------|--------|--------|
| `packages/server/src/channel-router.ts` | `handleSessionUpdate` | Replace binding reset + plain text with actions button message; unify LM-routed and user-bound paths |
| `packages/server/src/channel-router.ts` | `handleCallback` | Add `resume:` callback prefix handler |

## Testing

- Unit test: `handleSessionUpdate` with error/stopped session emits message with `actions` array
- Unit test: `handleCallback` with `resume:<sessionId>` delegates to `handleInbound`
- Integration: session error → button click → session resumes → user receives response
- Integration: session error → user sends custom message → session resumes with that message
- Integration: session error → resume fails → fallback to LobbyManager

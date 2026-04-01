# Compact Command — Design Spec

**Date:** 2026-04-01
**Scope:** Transparent compact pass-through with status/result display + token-based auto-prompt

## 1. Goal

Let users trigger `/compact` on any session that supports it, see real-time compact status and results in the chat, and receive a proactive prompt (web + IM) when token usage is high.

## 2. Approach

**Transparent pass-through with enhanced event surfacing.** OpenLobby does NOT implement its own compact logic. It forwards `/compact` to the underlying CLI and properly converts compact-related events into visible LobbyMessages.

## 3. Token Usage Tracking

### 3.1 Session-Level Accumulation

Add `tokenUsage` to `ManagedSession`:

```typescript
interface ManagedSession {
  // ... existing fields ...
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Reset after each compact */
    compactCount: number;
    /** Suppress repeated prompts until next compact or reset */
    compactPrompted: boolean;
  };
}
```

### 3.2 Data Sources

Each adapter already emits `result` messages with `meta.tokenUsage`. SessionManager accumulates these:

| Adapter | Source | Already Emitted? |
|---------|--------|-----------------|
| Claude Code | `result` message → `meta.tokenUsage` | Yes |
| Codex CLI | `turn/completed` → `meta.tokenUsage` | Yes |
| OpenCode | `message.updated` → `meta.tokenUsage` | Yes |

On each `result` message, `SessionManager.wireProcessEvents()` increments the session's cumulative `tokenUsage`. No new adapter work needed for tracking.

### 3.3 Threshold Configuration

Add `compactThreshold` to `server_config` (SQLite):

| Key | Default | Description |
|-----|---------|-------------|
| `compactThreshold` | `150000` | Total tokens before prompting user |

The threshold is a single global value. Per-model context window awareness is out of scope for this iteration.

## 4. Compact Event Conversion

### 4.1 Claude Code SDK Events

The SDK emits two compact-related message types that are currently not surfaced:

**`compact_boundary` system message** — emitted when compact completes:
```typescript
{
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'manual' | 'auto', pre_tokens: number }
}
```

Convert to:
```typescript
makeLobbyMessage(sessionId, 'system', {
  compact: true,
  trigger: metadata.trigger,
  preTokens: metadata.pre_tokens,
})
```

**`compacting` status** — emitted while compact is in progress:
```typescript
{ type: 'system', subtype: 'status', status: 'compacting' }
```

Map to `process.status = 'running'` (no new status value needed; the session is busy). Emit a system message: `{ compacting: true }`.

### 4.2 OpenCode SSE Events

The `session.compacted` event (currently ignored at line 224) should be converted to the same LobbyMessage format as Claude Code's `compact_boundary`.

### 4.3 Codex CLI

No native compact support. No event conversion needed.

### 4.4 Session Token Reset

When a compact event is received (from any adapter), reset the session's `tokenUsage` counters and `compactPrompted` flag. The `compactCount` is incremented.

## 5. Trigger Entry Points

### 5.1 Chat Input (`/compact [instructions]`)

Already works via pass-through. No change needed — `sendMessage()` forwards to the CLI as-is.

### 5.2 WebSocket Compact Action

New WebSocket message type:

```typescript
// Client → Server
{ type: 'compact', sessionId: string, instructions?: string }
```

`ws-handler` converts this to `sendMessage(sessionId, '/compact' + (instructions ? ' ' + instructions : ''))` and forwards to the CLI. This enables the frontend to trigger compact via a button without constructing a text command.

### 5.3 Auto-Prompt (Token Threshold)

In `SessionManager.wireProcessEvents()`, after accumulating token usage from a `result` message:

1. Check if `session.tokenUsage.totalTokens >= compactThreshold`
2. Check if `session.tokenUsage.compactPrompted === false`
3. If both true, set `compactPrompted = true` and:
   - Emit a `system` LobbyMessage with `{ compactSuggestion: true, currentTokens: totalTokens, threshold }` to the session
   - Notify IM via `ChannelRouter` (if session has a bound channel)

The prompt is sent **once** per threshold crossing. After a compact resets the counters, the prompt can fire again.

## 6. Frontend Changes

### 6.1 System Message: Compact Suggestion

When `content.compactSuggestion === true`, render a highlighted system bar:

```
⚠️ Context approaching limit (152K tokens). Consider compacting.  [Compact Now]
```

The `[Compact Now]` button sends `{ type: 'compact', sessionId }` via WebSocket.

### 6.2 System Message: Compacting In Progress

When `content.compacting === true`, render:

```
✂️ Compacting conversation...
```

### 6.3 System Message: Compact Complete

When `content.compact === true`, render:

```
✂️ Conversation compacted (120K → estimate based on reset)
```

If `preTokens` is available (Claude Code), show the before-compact token count. The after-compact count comes from subsequent `result` messages.

### 6.4 Session Header Button

Add a compact icon button (scissors ✂️) to the session header toolbar (next to existing controls). Clicking sends `{ type: 'compact', sessionId }`. Disabled when the adapter has no `/compact` in its command list.

## 7. IM Channel Notification

### 7.1 Compact Suggestion

When the auto-prompt fires and the session has a bound IM channel, send via `ChannelRouter`:

```
⚠️ Session "<displayName>" context approaching limit (152K tokens).
Reply /compact to compress, or /compact <instructions> with custom guidance.
```

### 7.2 Compact Complete

When a compact event is received and the session has a bound IM channel:

```
✂️ Session "<displayName>" compacted. (was 120K tokens)
```

## 8. Adapter Interface

No new methods on `AgentAdapter` or `AgentProcess`. Compact is triggered via `sendMessage('/compact')` and observed via existing message events. The only change is in the event-to-LobbyMessage conversion within each adapter.

## 9. Files to Change

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `tokenUsage` to `ManagedSession` (or define alongside it in session-manager) |
| `packages/core/src/adapters/claude-code.ts` | Handle `compact_boundary` and `compacting` status in `sdkMessageToLobby` |
| `packages/core/src/adapters/opencode.ts` | Handle `session.compacted` SSE event instead of ignoring it |
| `packages/server/src/session-manager.ts` | Accumulate token usage; emit compact suggestion on threshold |
| `packages/server/src/ws-handler.ts` | Handle `{ type: 'compact' }` WebSocket message |
| `packages/server/src/channel-router.ts` | Format and send compact suggestion + compact complete to IM |
| `packages/web/src/components/MessageBubble.tsx` | Render compact-related system messages |
| `packages/web/src/components/SessionHeader.tsx` (or equivalent) | Add compact button |

## 10. Out of Scope

- Implementing compact logic in OpenLobby itself (stays CLI-delegated)
- Per-model context window detection (single global threshold for now)
- Compact support for Codex CLI (it has no native compact; button will be hidden)
- Auto-compact triggering (only suggest; user decides)

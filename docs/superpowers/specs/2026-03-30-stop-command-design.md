# `/stop` Command Design

**Date:** 2026-03-30
**Status:** Approved

---

## Overview

Add a `/stop` command that interrupts the model's current response (including subagents and shell tool calls) without destroying the session or unbinding IM users. The session remains alive and returns to idle, ready to receive a new message.

**Contrast with existing commands:**
- `/exit` — unbinds the IM user from a session, routes them back to Lobby Manager; session keeps running
- `/stop` — stops the current model generation; session stays alive and bound; no routing change

---

## Architecture

### New `interrupt()` Method on `AgentProcess`

Add `interrupt()` to the `AgentProcess` interface in `packages/core/src/types.ts`:

```typescript
export interface AgentProcess extends EventEmitter {
  // ...existing methods...
  interrupt(): void;
}
```

**Semantic contract:**
- Aborts the current query/stream/subprocess immediately
- Sets `status` to `'idle'`, emits `'idle'` event
- Does **not** emit `'exit'`, does **not** delete the DB record, does **not** unbind IM users
- Is a **no-op** if the session is already idle (status is not `'running'` or `'awaiting_approval'`)

### New WebSocket Protocol Message

Add to `packages/core/src/protocol.ts`, client → server:

```typescript
| { type: 'session.interrupt'; sessionId: string }
```

No new server → client message is needed. The existing `session.updated` broadcast (driven by `emit('idle')`) notifies all clients of the status change.

---

## Adapter Implementations

### Claude Code (`packages/core/src/adapters/claude-code.ts`)

```typescript
interrupt(): void {
  if (this.status !== 'running' && this.status !== 'awaiting_approval') return;
  console.log('[ClaudeCode] interrupt');
  this.abortController.abort();       // stops the async generator stream
  this.pendingControls.clear();       // discard pending tool approvals
  this.preRespondedControls.clear();
  this.status = 'idle';
  this.emit('idle');
}
```

The `abortController` is already checked at each iteration step in `runQuery()`, so aborting it causes the stream to exit cleanly at the next checkpoint.

### OpenCode (`packages/core/src/adapters/opencode.ts`)

```typescript
interrupt(): void {
  if (this.status !== 'running') return;
  console.log('[OpenCode] interrupt');
  this.sseAbortController.abort();    // stops the SSE stream
  this.client.session
    .abort({ path: { id: this.sessionId } })
    .catch(() => {});                 // notify the OpenCode server (best-effort)
  this.status = 'idle';
  this.emit('idle');
}
```

### Codex CLI (`packages/core/src/adapters/codex-cli.ts`)

Codex CLI communicates via JSON-RPC over a child process and has no "cancel generation" RPC. The child process is killed and nulled; it is recreated lazily the next time `sendMessage()` is called (existing lazy-resume pattern).

```typescript
interrupt(): void {
  if (this.status !== 'running') return;
  console.log('[Codex] interrupt');
  this.killedIntentionally = true;
  if (this.childProcess) {
    this.childProcess.kill();
    this.childProcess = null;
  }
  this.status = 'idle';
  this.emit('idle');
  // child process is recreated lazily on next sendMessage()
}
```

---

## Server Layer

### `SessionManager.interruptSession()` (`packages/server/src/session-manager.ts`)

```typescript
async interruptSession(sessionId: string): Promise<void> {
  const session = this.sessions.get(sessionId);
  if (!session) return; // session not found — no-op
  session.process.interrupt();
  // status update and broadcast are driven by adapter emit('idle')
  // via the existing wireProcessEvents 'idle' handler
}
```

### `ws-handler.ts` — new message case

```typescript
case 'session.interrupt': {
  const { sessionId } = data;
  await sessionManager.interruptSession(sessionId);
  break;
}
```

### `slash-commands.ts` — `/stop` case

```typescript
case '/stop': {
  const targetSessionId = options?.targetSessionId;
  if (targetSessionId) {
    await options.sessionManager.interruptSession(targetSessionId);
    return { text: '⏹ 已打断模型回复。' };
  }
  return { text: '⚠️ 当前没有正在运行的会话。' };
}
```

`handleSlashCommand` receives a new optional `targetSessionId` field in its `options` parameter, populated by the caller with the currently active session.

### `channel-router.ts` — IM `/stop` dispatch

```typescript
case '/stop':
  return this.cmdStop(identityKey);

private async cmdStop(identityKey: string): Promise<string> {
  const binding = getBinding(this.db, identityKey);
  const sessionId = binding?.active_session_id;
  if (!sessionId) return '⚠️ 当前未绑定任何会话。';
  await this.sessionManager.interruptSession(sessionId);
  return '⏹ 已打断模型回复。';
}
```

---

## Web UI

### Stop button in `MessageInput.tsx`

When the session's status is `'running'` or `'awaiting_approval'`, the Send button is replaced by a Stop button:

```tsx
{isRunning ? (
  <button
    onClick={() => wsInterruptSession(sessionId)}
    className="px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white ..."
  >
    ⏹ Stop
  </button>
) : (
  <button onClick={handleSubmit} ...>Send</button>
)}
```

`isRunning` is derived from the session object in the Lobby store:
```typescript
const isRunning = session?.status === 'running' || session?.status === 'awaiting_approval';
```

### `useWebSocket.ts` — helper function

```typescript
export function wsInterruptSession(sessionId: string): void {
  wsSend({ type: 'session.interrupt', sessionId });
}
```

---

## Data Flow

```
[Web] User clicks Stop
        │
        ▼ wsInterruptSession(sessionId)
[WS]  { type: 'session.interrupt', sessionId }
        │
        ▼ ws-handler.ts
[Server] sessionManager.interruptSession(sessionId)
        │
        ▼ process.interrupt()
[Adapter] abort stream / kill subprocess
        │ emit('idle')
        ▼
[SessionManager] wireProcessEvents 'idle' handler
        → session.status = 'idle'
        → broadcastSessionUpdate()
        │
        ▼ { type: 'session.updated', session }
[Web]  store.updateSession() → isRunning = false → Stop button → Send button

[IM] User sends /stop
        │
        ▼ channel-router.cmdStop()
[Server] sessionManager.interruptSession(sessionId)
        │ (same path as above)
[IM]  Reply: "⏹ 已打断模型回复。"
```

---

## Files Changed

| File | Change |
|------|--------|
| `packages/core/src/types.ts` | Add `interrupt()` to `AgentProcess` interface |
| `packages/core/src/protocol.ts` | Add `session.interrupt` client → server message |
| `packages/core/src/adapters/claude-code.ts` | Implement `interrupt()` |
| `packages/core/src/adapters/opencode.ts` | Implement `interrupt()` |
| `packages/core/src/adapters/codex-cli.ts` | Implement `interrupt()` |
| `packages/server/src/session-manager.ts` | Add `interruptSession()` |
| `packages/server/src/ws-handler.ts` | Handle `session.interrupt` message |
| `packages/server/src/slash-commands.ts` | Add `/stop` case; add `targetSessionId` to options |
| `packages/server/src/channel-router.ts` | Add `/stop` dispatch and `cmdStop()` |
| `packages/web/src/hooks/useWebSocket.ts` | Add `wsInterruptSession()` |
| `packages/web/src/components/MessageInput.tsx` | Replace Send with Stop button when session is running |

---

## Out of Scope

- `/stop` does not affect the Lobby Manager session (LM is never the target)
- No confirmation dialog for Stop — it is immediate
- No "interrupted" message appended to the session chat history

# Terminal Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real terminal mode (xterm.js + node-pty) to the Web IM conversation page with per-session IM/Terminal toggle and a system-level default view mode setting.

**Architecture:** Backend spawns PTY processes via `node-pty` and pipes I/O over the existing WebSocket connection using new message types. Frontend renders via `@xterm/xterm` in a `TerminalView` component, toggled from `RoomHeader`. Default view mode is persisted in SQLite's `server_config` table.

**Tech Stack:** node-pty, @xterm/xterm, @xterm/addon-fit, TypeScript, React, Zustand, Fastify WebSocket, SQLite

---

### Task 1: Install Dependencies

**Files:**
- Modify: `packages/server/package.json`
- Modify: `packages/web/package.json`

- [ ] **Step 1: Add backend dependency**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/server add node-pty
```

- [ ] **Step 2: Add frontend dependencies**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/web add @xterm/xterm @xterm/addon-fit
```

- [ ] **Step 3: Verify installation**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm install && pnpm -r build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/server/package.json packages/web/package.json pnpm-lock.yaml
git commit -m "deps: add node-pty, @xterm/xterm, @xterm/addon-fit for terminal mode"
```

---

### Task 2: Add Protocol Message Types

**Files:**
- Modify: `packages/core/src/protocol.ts`
- Modify: `packages/core/src/types.ts`

- [ ] **Step 1: Add ViewMode type to types.ts**

Add after the `MessageMode` type definition (line 90):

```typescript
export type ViewMode = 'im' | 'terminal';
```

- [ ] **Step 2: Add PTY client messages to ClientMessage**

Add these union members to `ClientMessage` in `packages/core/src/protocol.ts`, before the closing semicolon (after the `session.open-terminal` line):

```typescript
  | { type: 'session.open-pty'; sessionId: string; cols: number; rows: number }
  | { type: 'session.close-pty'; sessionId: string }
  | { type: 'pty.input'; sessionId: string; data: string }
  | { type: 'pty.resize'; sessionId: string; cols: number; rows: number }
```

- [ ] **Step 3: Add PTY server messages to ServerMessage**

Add these union members to `ServerMessage` in `packages/core/src/protocol.ts`, before the closing semicolon:

```typescript
  | { type: 'pty.opened'; sessionId: string }
  | { type: 'pty.output'; sessionId: string; data: string }
  | { type: 'pty.closed'; sessionId: string }
  | { type: 'pty.error'; sessionId: string; error: string }
```

- [ ] **Step 4: Build and verify**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm -r build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/protocol.ts packages/core/src/types.ts
git commit -m "feat: add PTY protocol messages and ViewMode type"
```

---

### Task 3: Implement PtyManager (Backend)

**Files:**
- Create: `packages/server/src/pty-manager.ts`

- [ ] **Step 1: Create PtyManager**

Create `packages/server/src/pty-manager.ts`:

```typescript
import * as pty from 'node-pty';
import type { WebSocket } from '@fastify/websocket';

export interface PtySession {
  pty: pty.IPty;
  sessionId: string;
  /** The WebSocket client that opened this PTY */
  client: WebSocket;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  /**
   * Open a PTY for the given session, running the provided resume command.
   * PTY output is streamed to the client WebSocket as pty.output messages.
   */
  open(
    sessionId: string,
    resumeCommand: string,
    cwd: string,
    cols: number,
    rows: number,
    client: WebSocket,
  ): void {
    // If PTY already exists for this session, just re-attach the client
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.client = client;
      this.sendToClient(client, { type: 'pty.opened', sessionId });
      return;
    }

    // Parse the resume command into command + args
    const parts = resumeCommand.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [resumeCommand];
    const command = parts[0];
    const args = parts.slice(1).map((a) => a.replace(/^"|"$/g, ''));

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env } as Record<string, string>,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.sendToClient(client, { type: 'pty.error', sessionId, error });
      return;
    }

    const session: PtySession = { pty: ptyProcess, sessionId, client };
    this.sessions.set(sessionId, session);

    // Pipe PTY output → WebSocket
    ptyProcess.onData((data: string) => {
      const current = this.sessions.get(sessionId);
      if (current) {
        this.sendToClient(current.client, {
          type: 'pty.output',
          sessionId,
          data,
        });
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      this.sessions.delete(sessionId);
      this.sendToClient(client, { type: 'pty.closed', sessionId });
    });

    this.sendToClient(client, { type: 'pty.opened', sessionId });
  }

  /** Write user input to PTY stdin */
  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.write(data);
    }
  }

  /** Resize PTY */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  /** Close and kill a PTY */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.kill();
      this.sessions.delete(sessionId);
    }
  }

  /** Check if a PTY is active for this session */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Clean up all PTYs (for server shutdown) */
  dispose(): void {
    for (const [id, session] of this.sessions) {
      session.pty.kill();
    }
    this.sessions.clear();
  }

  private sendToClient(client: WebSocket, msg: Record<string, unknown>): void {
    if (client.readyState === 1) {
      client.send(JSON.stringify(msg));
    }
  }
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/server build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/pty-manager.ts
git commit -m "feat: implement PtyManager for PTY lifecycle management"
```

---

### Task 4: Wire PTY Messages in WebSocket Handler

**Files:**
- Modify: `packages/server/src/ws-handler.ts`
- Modify: `packages/server/src/index.ts` (to create and pass PtyManager)

- [ ] **Step 1: Update ws-handler.ts to accept PtyManager and handle PTY messages**

Add `PtyManager` import and parameter to `handleWebSocket`:

In `packages/server/src/ws-handler.ts`, change the import section — add:

```typescript
import type { PtyManager } from './pty-manager.js';
```

Change the function signature from:

```typescript
export function handleWebSocket(
  socket: WebSocket,
  sessionManager: SessionManager,
  lobbyManager?: LobbyManager,
  channelRouter?: ChannelRouterImpl,
): void {
```

to:

```typescript
export function handleWebSocket(
  socket: WebSocket,
  sessionManager: SessionManager,
  lobbyManager?: LobbyManager,
  channelRouter?: ChannelRouterImpl,
  ptyManager?: PtyManager,
): void {
```

Then add these cases in the `switch (data.type)` block, before the `default` case:

```typescript
        case 'session.open-pty': {
          if (!ptyManager) {
            send({ type: 'pty.error', sessionId: data.sessionId, error: 'PTY not available' } as any);
            break;
          }
          const ptyData = data as { sessionId: string; cols: number; rows: number };
          // Look up the session's resume command
          const ptySession = sessionManager.resolveSession(ptyData.sessionId);
          if (!ptySession) {
            send({ type: 'pty.error', sessionId: ptyData.sessionId, error: 'Session not found' } as any);
            break;
          }
          const resumeCmd = ptySession.resumeCommand;
          if (!resumeCmd) {
            send({ type: 'pty.error', sessionId: ptyData.sessionId, error: 'No resume command available' } as any);
            break;
          }
          ptyManager.open(
            ptyData.sessionId,
            resumeCmd,
            ptySession.cwd,
            ptyData.cols,
            ptyData.rows,
            socket,
          );
          break;
        }

        case 'session.close-pty': {
          if (ptyManager) {
            ptyManager.close(data.sessionId);
          }
          break;
        }

        case 'pty.input': {
          if (ptyManager) {
            const inputData = data as { sessionId: string; data: string };
            ptyManager.write(inputData.sessionId, inputData.data);
          }
          break;
        }

        case 'pty.resize': {
          if (ptyManager) {
            const resizeData = data as { sessionId: string; cols: number; rows: number };
            ptyManager.resize(resizeData.sessionId, resizeData.cols, resizeData.rows);
          }
          break;
        }
```

- [ ] **Step 2: Clean up PTY on WebSocket close**

In `packages/server/src/ws-handler.ts`, in the `socket.on('close', ...)` handler, add PTY cleanup. The existing close handler is:

```typescript
  socket.on('close', () => {
    if (activeQrAbort) {
      activeQrAbort.abort();
      activeQrAbort = null;
    }
    sessionManager.removeMessageListener(listenerId);
    sessionManager.removeSessionUpdateListener(listenerId);
    sessionManager.removeNavigateListener(listenerId);
    sessionManager.removeCommandsListener(listenerId);
    sessionManager.unregisterWebViewer(listenerId);
  });
```

No PTY cleanup needed here — PTYs are keyed by sessionId, not by WebSocket client. They persist across reconnects. They are cleaned up when the user explicitly closes PTY or destroys the session.

- [ ] **Step 3: Pass PtyManager from server index.ts**

Find where `handleWebSocket` is called in `packages/server/src/index.ts` and add the `ptyManager` argument. First check the current call site:

Search for `handleWebSocket` in `packages/server/src/index.ts` and update the call to pass the ptyManager instance. The PtyManager should be instantiated once at server startup:

```typescript
import { PtyManager } from './pty-manager.js';

// Near the top of server initialization, after other managers:
const ptyManager = new PtyManager();
```

Then update the `handleWebSocket` call to pass `ptyManager` as the 5th argument.

- [ ] **Step 4: Build and verify**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/server build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/ws-handler.ts packages/server/src/index.ts
git commit -m "feat: wire PTY protocol messages in WebSocket handler"
```

---

### Task 5: Add PTY Message Handling to Frontend WebSocket

**Files:**
- Modify: `packages/web/src/hooks/useWebSocket.ts`
- Modify: `packages/web/src/stores/lobby-store.ts`

- [ ] **Step 1: Add PTY state to lobby-store.ts**

In `packages/web/src/stores/lobby-store.ts`, add to the `LobbyState` interface (after `terminalFailDialog`):

```typescript
  // Terminal mode state
  viewModeBySession: Record<string, 'im' | 'terminal'>;
  ptyReadyBySession: Record<string, boolean>;
  /** Callbacks for pty.output — registered by TerminalView components */
  ptyOutputListeners: Record<string, (data: string) => void>;
  setViewMode: (sessionId: string, mode: 'im' | 'terminal') => void;
  setPtyReady: (sessionId: string, ready: boolean) => void;
  registerPtyOutputListener: (sessionId: string, listener: (data: string) => void) => void;
  unregisterPtyOutputListener: (sessionId: string) => void;
```

Then add the implementations in the `create` call (in the state initializer object):

```typescript
  viewModeBySession: {},
  ptyReadyBySession: {},
  ptyOutputListeners: {},
  setViewMode: (sessionId, mode) =>
    set((s) => ({
      viewModeBySession: { ...s.viewModeBySession, [sessionId]: mode },
    })),
  setPtyReady: (sessionId, ready) =>
    set((s) => ({
      ptyReadyBySession: { ...s.ptyReadyBySession, [sessionId]: ready },
    })),
  registerPtyOutputListener: (sessionId, listener) =>
    set((s) => ({
      ptyOutputListeners: { ...s.ptyOutputListeners, [sessionId]: listener },
    })),
  unregisterPtyOutputListener: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...rest } = s.ptyOutputListeners;
      return { ptyOutputListeners: rest };
    }),
```

- [ ] **Step 2: Handle PTY server messages in useWebSocket.ts**

In `packages/web/src/hooks/useWebSocket.ts`, in the `ws.onmessage` handler's switch block, add these cases (before or after the existing `case 'session.open-terminal-result':`):

```typescript
      case 'pty.opened':
        if (data.sessionId) {
          state.setPtyReady(data.sessionId, true);
        }
        break;
      case 'pty.output':
        if (data.sessionId) {
          const listener = state.ptyOutputListeners[data.sessionId];
          if (listener) {
            listener((data as any).data);
          }
        }
        break;
      case 'pty.closed':
        if (data.sessionId) {
          state.setPtyReady(data.sessionId, false);
        }
        break;
      case 'pty.error':
        if (data.sessionId) {
          state.setPtyReady(data.sessionId, false);
          console.error(`[PTY] Error for session ${data.sessionId}:`, (data as any).error);
        }
        break;
```

- [ ] **Step 3: Add PTY WebSocket sender functions**

In `packages/web/src/hooks/useWebSocket.ts`, add these exported functions alongside the existing `ws*` helpers:

```typescript
export function wsOpenPty(sessionId: string, cols: number, rows: number): void {
  wsSend({ type: 'session.open-pty', sessionId, cols, rows });
}

export function wsClosePty(sessionId: string): void {
  wsSend({ type: 'session.close-pty', sessionId });
}

export function wsPtyInput(sessionId: string, data: string): void {
  wsSend({ type: 'pty.input', sessionId, data });
}

export function wsPtyResize(sessionId: string, cols: number, rows: number): void {
  wsSend({ type: 'pty.resize', sessionId, cols, rows });
}
```

- [ ] **Step 4: Request defaultViewMode on connect**

In the `ws.onopen` handler in `useWebSocket.ts`, add a request for the default view mode config. After the existing `wsSend({ type: 'config.get', key: 'defaultMessageMode' });` line, add:

```typescript
    wsSend({ type: 'config.get', key: 'defaultViewMode' });
```

- [ ] **Step 5: Build and verify**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/web build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/stores/lobby-store.ts packages/web/src/hooks/useWebSocket.ts
git commit -m "feat: add PTY state management and WebSocket handlers in frontend"
```

---

### Task 6: Create TerminalView Component

**Files:**
- Create: `packages/web/src/components/TerminalView.tsx`

- [ ] **Step 1: Create the TerminalView component**

Create `packages/web/src/components/TerminalView.tsx`:

```typescript
import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useLobbyStore } from '../stores/lobby-store';
import { wsOpenPty, wsPtyInput, wsPtyResize } from '../hooks/useWebSocket';

interface TerminalViewProps {
  sessionId: string;
}

// Cache xterm instances so switching back to terminal mode preserves state
const terminalCache = new Map<string, { terminal: Terminal; fitAddon: FitAddon }>();

export default function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyReady = useLobbyStore((s) => s.ptyReadyBySession[sessionId] ?? false);
  const registerListener = useLobbyStore((s) => s.registerPtyOutputListener);
  const unregisterListener = useLobbyStore((s) => s.unregisterPtyOutputListener);

  // Get or create terminal instance
  const getTerminal = useCallback(() => {
    let cached = terminalCache.get(sessionId);
    if (!cached) {
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
        theme: {
          background: '#0c0c0c',
          foreground: '#e0e0e0',
          cursor: '#4ade80',
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      cached = { terminal, fitAddon };
      terminalCache.set(sessionId, cached);
    }
    return cached;
  }, [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { terminal, fitAddon } = getTerminal();

    // Mount terminal to DOM
    terminal.open(container);
    fitAddon.fit();

    // Send user input → PTY
    const inputDisposable = terminal.onData((data) => {
      wsPtyInput(sessionId, data);
    });

    // Register PTY output listener so WebSocket data → xterm
    registerListener(sessionId, (data: string) => {
      terminal.write(data);
    });

    // Request PTY from server (if not already open)
    if (!useLobbyStore.getState().ptyReadyBySession[sessionId]) {
      wsOpenPty(sessionId, terminal.cols, terminal.rows);
    }

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      wsPtyResize(sessionId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(container);

    return () => {
      inputDisposable.dispose();
      resizeObserver.disconnect();
      unregisterListener(sessionId);
      // Don't dispose terminal — keep it cached for re-mount
      // Just detach from DOM by clearing the container
      container.innerHTML = '';
    };
  }, [sessionId, getTerminal, registerListener, unregisterListener]);

  return (
    <div
      ref={containerRef}
      className="flex-1 bg-[#0c0c0c]"
      style={{ minHeight: 0 }}
    />
  );
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/web build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/TerminalView.tsx
git commit -m "feat: create TerminalView component with xterm.js"
```

---

### Task 7: Add IM/Terminal Toggle to RoomHeader and App

**Files:**
- Modify: `packages/web/src/components/RoomHeader.tsx`
- Modify: `packages/web/src/App.tsx`

- [ ] **Step 1: Add toggle button to RoomHeader**

In `packages/web/src/components/RoomHeader.tsx`, add the view mode state hook. After the existing `const isLM = session?.origin === 'lobby-manager';` line, add:

```typescript
  const viewMode = useLobbyStore((s) =>
    activeSessionId ? (s.viewModeBySession[activeSessionId] ?? 'im') : 'im',
  );
  const setViewMode = useLobbyStore((s) => s.setViewMode);
```

Then add the toggle button in the JSX. Find the `<div className="flex items-center gap-2">` section that contains the "Open in Terminal" and "Settings" buttons. Replace the "Open in Terminal" button block:

```typescript
        {session.resumeCommand && (
          <button
            onClick={handleOpenTerminal}
            onContextMenu={(e) => {
              e.preventDefault();
              handleCopyResumeCmd();
            }}
            className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800"
            title={`Click to open in terminal | Right-click to copy: ${session.resumeCommand}`}
          >
            Open in Terminal
          </button>
        )}
```

with:

```typescript
        {!isLM && (
          <div className="flex items-center bg-gray-800 rounded-md p-0.5">
            <button
              onClick={() => activeSessionId && setViewMode(activeSessionId, 'im')}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                viewMode === 'im'
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              IM
            </button>
            <button
              onClick={() => activeSessionId && setViewMode(activeSessionId, 'terminal')}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                viewMode === 'terminal'
                  ? 'bg-indigo-600 text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              Terminal
            </button>
          </div>
        )}
        {session.resumeCommand && (
          <button
            onClick={handleOpenTerminal}
            onContextMenu={(e) => {
              e.preventDefault();
              handleCopyResumeCmd();
            }}
            className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800"
            title={`Click to open in terminal | Right-click to copy: ${session.resumeCommand}`}
          >
            Open in Terminal
          </button>
        )}
```

- [ ] **Step 2: Conditional render in App.tsx**

In `packages/web/src/App.tsx`, add the import for `TerminalView` and the view mode selector. Add to imports:

```typescript
import TerminalView from './components/TerminalView';
```

Add the view mode selector after the existing `const isSessionAlive = ...` line:

```typescript
  const viewMode = useLobbyStore((s) =>
    s.activeSessionId ? (s.viewModeBySession[s.activeSessionId] ?? 'im') : 'im',
  );
```

Then update the active session rendering. Replace the current block:

```typescript
        {activeSessionId ? (
          <>
            <MessageList
              sessionId={activeSessionId}
              onControlRespond={wsRespondControl}
              onChoiceSelect={handleChoiceSelect}
            />
            {!isSessionAlive && activeSession && (activeSession.status === 'stopped' || activeSession.status === 'error') && (
              <div className="flex items-center justify-center gap-3 px-4 py-2 bg-gray-900 border-t border-gray-700">
                <span className="text-xs text-gray-400">
                  Session {activeSession.status === 'error' ? 'errored' : 'stopped'}.
                </span>
                <button
                  onClick={() => wsRecoverSession(activeSessionId)}
                  className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                >
                  Recover to Idle
                </button>
              </div>
            )}
            <MessageInput
              onSend={(content) => wsSendMessage(activeSessionId, content)}
              disabled={!connected || !isSessionAlive}
              placeholder={
                isSessionAlive
                  ? undefined
                  : 'Session has ended. Create a new session to continue.'
              }
            />
          </>
```

with:

```typescript
        {activeSessionId ? (
          <>
            {viewMode === 'terminal' ? (
              <TerminalView sessionId={activeSessionId} />
            ) : (
              <>
                <MessageList
                  sessionId={activeSessionId}
                  onControlRespond={wsRespondControl}
                  onChoiceSelect={handleChoiceSelect}
                />
                {!isSessionAlive && activeSession && (activeSession.status === 'stopped' || activeSession.status === 'error') && (
                  <div className="flex items-center justify-center gap-3 px-4 py-2 bg-gray-900 border-t border-gray-700">
                    <span className="text-xs text-gray-400">
                      Session {activeSession.status === 'error' ? 'errored' : 'stopped'}.
                    </span>
                    <button
                      onClick={() => wsRecoverSession(activeSessionId)}
                      className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                    >
                      Recover to Idle
                    </button>
                  </div>
                )}
                <MessageInput
                  onSend={(content) => wsSendMessage(activeSessionId, content)}
                  disabled={!connected || !isSessionAlive}
                  placeholder={
                    isSessionAlive
                      ? undefined
                      : 'Session has ended. Create a new session to continue.'
                  }
                />
              </>
            )}
          </>
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/web build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/components/RoomHeader.tsx packages/web/src/App.tsx
git commit -m "feat: add IM/Terminal toggle in RoomHeader with conditional rendering"
```

---

### Task 8: Default View Mode Configuration

**Files:**
- Modify: `packages/web/src/hooks/useWebSocket.ts`
- Modify: `packages/web/src/components/RoomHeader.tsx` (Settings panel)

- [ ] **Step 1: Apply default view mode when creating sessions**

In `packages/web/src/hooks/useWebSocket.ts`, in the `case 'session.created':` handler, after `state.setActiveSession(data.session.id);`, add logic to apply the default view mode:

```typescript
          // Apply default view mode from server config
          const defaultViewMode = state.serverConfig['defaultViewMode'];
          if (defaultViewMode === 'terminal') {
            state.setViewMode(data.session.id, 'terminal');
          }
```

Also apply it in the `case 'session.updated':` handler where new sessions are auto-added (the `if (!state.sessions[data.session.id] && !data.previousId)` block), after `wsRequestSessionHistory(data.session.id);`:

```typescript
            // Apply default view mode from server config
            const defaultViewMode2 = state.serverConfig['defaultViewMode'];
            if (defaultViewMode2 === 'terminal') {
              state.setViewMode(data.session.id, 'terminal');
            }
```

- [ ] **Step 2: Add Default View Mode to Settings panel in RoomHeader**

In `packages/web/src/components/RoomHeader.tsx`, add the import for `wsSetConfig`:

```typescript
import { useLobbyStore } from '../stores/lobby-store';
import { wsDestroySession, wsConfigureSession, wsOpenTerminal, wsSetConfig } from '../hooks/useWebSocket';
```

Then in the Settings dropdown panel, after the existing "Message Mode" `<select>` block and before the "Apply" button, add:

```typescript
              <div>
                <label className="text-xs text-gray-400 block mb-1">Default View Mode</label>
                <select
                  value={useLobbyStore.getState().serverConfig['defaultViewMode'] ?? 'im'}
                  onChange={(e) => {
                    wsSetConfig('defaultViewMode', e.target.value);
                    useLobbyStore.getState().setServerConfigValue('defaultViewMode', e.target.value);
                  }}
                  className="w-full bg-gray-800 text-gray-100 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="im">IM (chat bubbles)</option>
                  <option value="terminal">Terminal</option>
                </select>
              </div>
```

- [ ] **Step 3: Build and verify**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/web build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/hooks/useWebSocket.ts packages/web/src/components/RoomHeader.tsx
git commit -m "feat: add default view mode configuration (IM/Terminal)"
```

---

### Task 9: Integration Test — Manual Verification

- [ ] **Step 1: Start backend dev server**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/server dev
```

- [ ] **Step 2: Start frontend dev server**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm --filter @openlobby/web dev
```

- [ ] **Step 3: Verify the following manually**

1. Open the web UI, create or select an existing session
2. Verify the IM/Terminal toggle appears in the RoomHeader
3. Click "Terminal" — verify xterm.js terminal renders and auto-resumes the CLI session
4. Type in the terminal — verify input works
5. Click "IM" — verify chat view returns, terminal state is preserved
6. Click "Terminal" again — verify terminal shows previous state (not a fresh session)
7. Open Settings → change Default View Mode to "Terminal"
8. Create a new session — verify it opens in Terminal mode by default
9. Resize the browser window — verify terminal resizes properly

- [ ] **Step 4: Build full project**

```bash
cd /Users/kone/OtherProjects/mist/OpenLobby && pnpm -r build
```

Expected: Full build succeeds.

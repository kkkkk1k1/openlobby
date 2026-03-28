import { useEffect, useRef } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import type {
  SessionSummaryData,
  LobbyMessageData,
  ControlRequestData,
  ChannelProviderData,
  ChannelBindingData,
} from '../stores/lobby-store';

interface ServerMessage {
  type: string;
  sessionId?: string;
  previousId?: string;
  session?: SessionSummaryData;
  sessions?: SessionSummaryData[];
  message?: LobbyMessageData;
  request?: ControlRequestData;
  error?: string;
  messages?: LobbyMessageData[];
  available?: boolean;
  // Channel messages
  providers?: ChannelProviderData[];
  bindings?: ChannelBindingData[];
  binding?: ChannelBindingData;
  providerId?: string;
  healthy?: boolean;
  identityKey?: string;
  commands?: Array<{ name: string; description: string; args?: string }>;
  cached?: boolean;
}

/**
 * Singleton WebSocket — only one connection and one message handler,
 * no matter how many components exist.
 */
let globalWs: WebSocket | null = null;
let globalWsUrl: string | null = null;

function ensureConnection(url: string) {
  if (globalWs && globalWsUrl === url && globalWs.readyState <= 1) {
    return;
  }

  globalWsUrl = url;
  const ws = new WebSocket(url);
  globalWs = ws;

  ws.onopen = () => {
    console.log('[WS] Connected');
    useLobbyStore.getState().setConnected(true);
    wsSend({ type: 'session.list' });
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected');
    useLobbyStore.getState().setConnected(false);
    globalWs = null;
    setTimeout(() => ensureConnection(url), 2000);
  };

  ws.onerror = (e) => {
    console.error('[WS] Error:', e);
  };

  ws.onmessage = (event) => {
    const data: ServerMessage = JSON.parse(event.data);
    const state = useLobbyStore.getState();

    switch (data.type) {
      case 'session.created':
        if (data.session) {
          state.addSession(data.session);
          // Don't auto-select Lobby Manager session — it's selected via the sidebar button
          if (data.session.origin !== 'lobby-manager') {
            state.setActiveSession(data.session.id);
          }
        }
        break;
      case 'session.updated':
        if (data.session) {
          // If this is a new session we haven't seen, treat as created
          if (!state.sessions[data.session.id] && !data.previousId) {
            state.addSession(data.session);
            if (data.session.origin !== 'lobby-manager') {
              state.setActiveSession(data.session.id);
              wsRequestSessionHistory(data.session.id);
            }
          } else {
            state.updateSession(data.session, data.previousId);
          }
          if (data.session.status === 'idle' || data.session.status === 'stopped' || data.session.status === 'error') {
            state.setTyping(data.session.id, false);
          }
          // Clear pending approval when session is no longer awaiting
          if (data.session.status !== 'awaiting_approval') {
            state.setPendingControl(data.session.id, null);
            // Also clear for previousId in case of session ID sync
            if (data.previousId) {
              state.setPendingControl(data.previousId, null);
            }
          }
          // Track Lobby Manager session ID changes
          if (data.previousId && data.previousId === state.lmSessionId) {
            state.setLmSessionId(data.session.id);
          }
        }
        break;
      case 'session.destroyed':
        if (data.sessionId) state.removeSession(data.sessionId);
        break;
      case 'session.list':
        if (data.sessions) state.setSessions(data.sessions);
        break;
      case 'session.history':
        if (data.sessionId && data.messages)
          state.setSessionHistory(data.sessionId, data.messages);
        break;
      case 'message':
        if (data.sessionId && data.message) {
          state.addMessage(data.sessionId, data.message);
          const msgType = data.message.type;
          // Stop typing on result message
          if (msgType === 'result') {
            state.setTyping(data.sessionId, false);
          }
          // Start/continue typing on stream_delta, tool_use, tool_result
          // These indicate the assistant is actively working
          if (msgType === 'stream_delta' || msgType === 'tool_use' || msgType === 'tool_result') {
            state.setTyping(data.sessionId, true);
          }
        }
        break;
      case 'control.request':
        if (data.sessionId && data.request)
          state.setPendingControl(data.sessionId, data.request);
        break;
      case 'session.discovered':
        if (data.sessions) state.setDiscoveredSessions(data.sessions);
        break;
      case 'session.navigate':
        if (data.sessionId) {
          state.setActiveSession(data.sessionId as string);
          wsRequestSessionHistory(data.sessionId as string);
        }
        break;
      case 'lm.status':
        if (data.available !== undefined) {
          state.setLmAvailable(data.available as boolean);
        }
        if (data.sessionId) {
          state.setLmSessionId(data.sessionId as string);
        }
        break;
      // ─── Channel messages ───
      case 'channel.providers-list':
        if (data.providers) state.setChannelProviders(data.providers);
        break;
      case 'channel.provider-status':
        // Update single provider status in list
        if (data.providerId !== undefined && data.healthy !== undefined) {
          const providers = state.channelProviders.map((p) =>
            p.id === data.providerId ? { ...p, healthy: data.healthy! } : p,
          );
          state.setChannelProviders(providers);
        }
        break;
      case 'channel.bindings-list':
        if (data.bindings) state.setChannelBindings(data.bindings);
        break;
      case 'channel.binding-updated':
        if (data.binding) {
          const bindings = state.channelBindings.filter(
            (b) => b.identityKey !== data.binding!.identityKey,
          );
          bindings.push(data.binding);
          state.setChannelBindings(bindings);
        }
        break;
      case 'channel.binding-removed':
        if (data.identityKey) {
          state.setChannelBindings(
            state.channelBindings.filter((b) => b.identityKey !== data.identityKey),
          );
        }
        break;

      case 'completion.response':
        if (data.sessionId && data.commands) {
          state.setSessionCommands(data.sessionId, data.commands, data.cached);
        }
        break;

      case 'error':
        console.error('[WS] Server error:', data.error);
        break;
    }
  };
}

function wsSend(msg: Record<string, unknown>): void {
  if (globalWs && globalWs.readyState === WebSocket.OPEN) {
    globalWs.send(JSON.stringify(msg));
  } else {
    console.warn('[WS] Not connected, cannot send');
  }
}

// ---- Exported send helpers (callable from any component) ----

export function wsCreateSession(
  adapterName: string,
  options: Record<string, unknown>,
  displayName?: string,
): void {
  wsSend({ type: 'session.create', adapterName, options, displayName });
}

export function wsConfigureSession(sessionId: string, options: Record<string, unknown>): void {
  wsSend({ type: 'session.configure', sessionId, options });
}

export function wsSendMessage(sessionId: string, content: string): void {
  // Optimistic: show user message immediately
  const store = useLobbyStore.getState();
  store.addMessage(sessionId, {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    timestamp: Date.now(),
    type: 'user',
    content,
  });
  store.setTyping(sessionId, true);
  wsSend({ type: 'message.send', sessionId, content });
}

export function wsRespondControl(
  sessionId: string,
  requestId: string,
  decision: 'allow' | 'deny',
): void {
  wsSend({ type: 'control.respond', sessionId, requestId, decision });
  useLobbyStore.getState().setPendingControl(sessionId, null);
}

export function wsDestroySession(sessionId: string): void {
  wsSend({ type: 'session.destroy', sessionId });
}

export function wsRequestSessionHistory(sessionId: string): void {
  wsSend({ type: 'session.history', sessionId });
  wsSend({ type: 'session.view', sessionId });
}

export function wsSetActiveView(sessionId: string | null): void {
  wsSend({ type: 'session.view', sessionId });
}

export function wsRequestSessionList(): void {
  wsSend({ type: 'session.list' });
}

export function wsDiscoverSessions(cwd?: string): void {
  wsSend({ type: 'session.discover', cwd });
}

export function wsImportSession(data: {
  sessionId: string;
  adapterName: string;
  displayName?: string;
  cwd: string;
  jsonlPath?: string;
}): void {
  wsSend({ type: 'session.import', ...data });
}

export function wsRecoverSession(sessionId: string): void {
  wsSend({ type: 'session.recover', sessionId });
}

export function wsTogglePlanMode(sessionId: string, enabled: boolean): void {
  console.log('[WS] Sending plan-mode toggle:', sessionId, enabled);
  wsSend({ type: 'session.plan-mode', sessionId, enabled });
}

// ---- Channel send helpers ----

export function wsListProviders(): void {
  wsSend({ type: 'channel.list-providers' });
}

export function wsAddProvider(config: {
  channelName: string;
  accountId: string;
  credentials: Record<string, string>;
  webhook?: { path: string; secret?: string };
  enabled?: boolean;
}): void {
  wsSend({ type: 'channel.add-provider', config });
}

export function wsRemoveProvider(providerId: string): void {
  wsSend({ type: 'channel.remove-provider', providerId });
}

export function wsToggleProvider(providerId: string, enabled: boolean): void {
  wsSend({ type: 'channel.toggle-provider', providerId, enabled });
}

export function wsListBindings(): void {
  wsSend({ type: 'channel.list-bindings' });
}

export function wsBind(identityKey: string, target: string): void {
  wsSend({ type: 'channel.bind', identityKey, target });
}

export function wsUnbind(identityKey: string): void {
  wsSend({ type: 'channel.unbind', identityKey });
}

export function wsRequestCompletions(sessionId: string): void {
  wsSend({ type: 'completion.request', sessionId });
}

// ---- Hook: call once in App to boot the connection ----

export function useWebSocketInit(url: string): void {
  const booted = useRef(false);
  useEffect(() => {
    if (!booted.current) {
      booted.current = true;
      ensureConnection(url);
    }
  }, [url]);
}

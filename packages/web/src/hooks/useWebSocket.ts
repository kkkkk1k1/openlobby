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
let expectingRestart = false;

export function setExpectingRestart(val: boolean) {
  expectingRestart = val;
}

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
    if (expectingRestart) {
      expectingRestart = false;
      location.reload();
      return;
    }
    wsSend({ type: 'session.list' });
    wsSend({ type: 'config.get', key: 'defaultAdapter' });
    wsSend({ type: 'config.get', key: 'defaultMessageMode' });
    wsSend({ type: 'config.get', key: 'defaultViewMode' });
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
          // Apply default view mode from server config
          const defaultViewMode = state.serverConfig['defaultViewMode'];
          if (defaultViewMode === 'terminal') {
            state.setViewMode(data.session.id, 'terminal');
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
            // Apply default view mode from server config
            const defaultViewMode2 = state.serverConfig['defaultViewMode'];
            if (defaultViewMode2 === 'terminal') {
              state.setViewMode(data.session.id, 'terminal');
            }
          } else {
            state.updateSession(data.session, data.previousId);
          }
          if (data.session.status === 'idle' || data.session.status === 'stopped' || data.session.status === 'error') {
            state.setTyping(data.session.id, false);
          }
          // Clear pending approvals when session terminates (not just status change).
          // Normal approval responses use removePendingControl() to remove one at a time.
          // Only clear ALL when session is fully done (idle/stopped/error).
          if (data.session.status === 'idle' || data.session.status === 'stopped' || data.session.status === 'error') {
            state.setPendingControl(data.session.id, null);
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
          const msgType = data.message.type;
          const msgSession = state.sessions[data.sessionId];
          const messageMode = msgSession?.messageMode ?? 'msg-total';

          // msg-only: filter out tool_use/tool_result on client side too
          if (messageMode === 'msg-only' && (msgType === 'tool_use' || msgType === 'tool_result')) {
            break;
          }

          // msg-tidy: aggregate tool calls instead of showing individually
          if (messageMode === 'msg-tidy' && (msgType === 'tool_use' || msgType === 'tool_result')) {
            if (msgType === 'tool_use') {
              const toolName = (data.message.meta as any)?.toolName ?? 'unknown';
              const content = typeof data.message.content === 'string'
                ? data.message.content
                : JSON.stringify(data.message.content);
              state.updateToolAggregator(data.sessionId, (agg) => ({
                isAggregating: true,
                toolCounts: { ...agg.toolCounts, [toolName]: (agg.toolCounts[toolName] ?? 0) + 1 },
                lastToolName: toolName,
                lastToolContent: content.slice(0, 200),
                totalCalls: agg.totalCalls + 1,
              }));
            }
            state.setTyping(data.sessionId, true);
            break;
          }

          // msg-tidy: finalize aggregator on assistant/result
          if (messageMode === 'msg-tidy' && (msgType === 'assistant' || msgType === 'result')) {
            const agg = state.toolAggregatorBySession[data.sessionId];
            if (agg && agg.totalCalls > 0) {
              const statsList = Object.entries(agg.toolCounts)
                .map(([name, count]) => `${name}(${count})`)
                .join(', ');
              state.addMessage(data.sessionId, {
                id: `tool-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                sessionId: data.sessionId,
                timestamp: Date.now(),
                type: 'tool_summary',
                content: `\u{1F527} 已完成 ${agg.totalCalls} 次工具调用: ${statsList}`,
              });
              state.resetToolAggregator(data.sessionId);
            }
          }

          state.addMessage(data.sessionId, data.message);
          if (msgType === 'result') {
            state.setTyping(data.sessionId, false);
          }
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

      case 'config.value':
        if ((data as any).key && (data as any).value !== undefined) {
          state.setServerConfigValue((data as any).key, (data as any).value);
        }
        break;

      case 'adapter.meta': {
        const { meta } = data as unknown as { meta: Record<string, { displayName: string; modeLabels: Record<string, string> }> };
        state.setAdapterPermissionMeta(meta);
        break;
      }

      case 'adapter.defaults': {
        const { defaults } = data as unknown as { defaults: Array<{ adapterName: string; permissionMode: string; displayName: string }> };
        state.setAdapterDefaults(defaults);
        break;
      }

      case 'wecom.qr-status': {
        const { status, qrUrl, botId, secret, error } = data as any;
        state.setWecomQrStatus({ status, qrUrl, botId, secret, error });
        break;
      }

      case 'session.open-terminal-result': {
        if (!(data as any).ok) {
          const { resumeCommand, reason } = data as any;
          useLobbyStore.getState().setTerminalFailDialog({ resumeCommand, reason });
        }
        break;
      }

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
  payload?: Record<string, unknown>,
): void {
  wsSend({ type: 'control.respond', sessionId, requestId, decision, payload });
  useLobbyStore.getState().removePendingControl(sessionId, requestId);
}

export function wsDestroySession(sessionId: string): void {
  wsSend({ type: 'session.destroy', sessionId });
}

export function wsInterruptSession(sessionId: string): void {
  wsSend({ type: 'session.interrupt', sessionId });
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

export function wsWecomQrStart(): void {
  wsSend({ type: 'wecom.qr-start' });
}

export function wsWecomQrCancel(): void {
  wsSend({ type: 'wecom.qr-cancel' });
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

export function wsCompactSession(sessionId: string): void {
  wsSend({ type: 'compact', sessionId });
}

export function wsPinSession(sessionId: string, pinned: boolean): void {
  wsSend({ type: 'session.pin', sessionId, pinned });
}

export function wsRenameSession(sessionId: string, displayName: string): void {
  wsSend({ type: 'session.rename', sessionId, displayName });
}

export function wsOpenTerminal(sessionId: string): void {
  wsSend({ type: 'session.open-terminal', sessionId });
}

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

export function wsRequestCompletions(sessionId: string): void {
  wsSend({ type: 'completion.request', sessionId });
}

export function wsGetConfig(key: string): void {
  wsSend({ type: 'config.get', key });
}

export function wsSetConfig(key: string, value: string): void {
  wsSend({ type: 'config.set', key, value });
}

export function wsGetAdapterDefaults(): void {
  wsSend({ type: 'adapter.get-defaults' });
}

export function wsSetAdapterDefault(adapterName: string, permissionMode: string): void {
  wsSend({ type: 'adapter.set-default', adapterName, permissionMode });
}

export function wsGetAdapterMeta(): void {
  wsSend({ type: 'adapter.get-meta' });
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

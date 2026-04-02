import { create } from 'zustand';

export interface SessionSummaryData {
  id: string;
  adapterName: string;
  displayName: string;
  status: string;
  lastActiveAt: number;
  lastMessage?: string;
  messageCount: number;
  model?: string;
  permissionMode?: string;
  cwd: string;
  origin: string;
  resumeCommand: string;
  jsonlPath?: string;
  messageMode?: string;
  channelBinding?: {
    channelName: string;
    peerId: string;
    peerDisplayName?: string;
  };
  pinned?: boolean;
}

export interface ChannelProviderData {
  id: string;
  channelName: string;
  accountId: string;
  enabled: boolean;
  healthy: boolean;
}

export interface ChannelBindingData {
  identityKey: string;
  channelName: string;
  accountId: string;
  peerId: string;
  peerDisplayName?: string;
  target: string;
  activeSessionId: string | null;
  createdAt: number;
  lastActiveAt: number;
}

export interface LobbyMessageData {
  id: string;
  sessionId: string;
  timestamp: number;
  type: string;
  content: string | Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface ControlQuestionData {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface ControlRequestData {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Structured questions when toolName === 'AskUserQuestion' */
  questions?: ControlQuestionData[];
}

export interface ToolCallAggregator {
  isAggregating: boolean;
  toolCounts: Record<string, number>;
  lastToolName: string;
  lastToolContent: string;
  totalCalls: number;
}

interface LobbyState {
  sessions: Record<string, SessionSummaryData>;
  activeSessionId: string | null;
  messagesBySession: Record<string, LobbyMessageData[]>;
  pendingControlBySession: Record<string, ControlRequestData[]>;
  typingBySession: Record<string, boolean>;
  connected: boolean;
  discoveredSessions: SessionSummaryData[];
  showDiscoverDialog: boolean;

  // Lobby Manager state
  lmAvailable: boolean;
  lmSessionId: string | null;

  // Channel state
  channelProviders: ChannelProviderData[];
  channelBindings: ChannelBindingData[];

  commandsBySession: Record<string, Array<{ name: string; description: string; args?: string }>>;
  commandsLoadingBySession: Record<string, boolean>;
  setSessionCommands: (sessionId: string, commands: Array<{ name: string; description: string; args?: string }>, cached?: boolean) => void;

  // Tool call aggregation for msg-tidy mode
  toolAggregatorBySession: Record<string, ToolCallAggregator>;
  // Server config cache
  serverConfig: Record<string, string>;

  updateToolAggregator: (sessionId: string, updater: (agg: ToolCallAggregator) => ToolCallAggregator) => void;
  resetToolAggregator: (sessionId: string) => void;
  setServerConfigValue: (key: string, value: string) => void;

  setConnected: (connected: boolean) => void;
  addSession: (session: SessionSummaryData) => void;
  updateSession: (session: SessionSummaryData, previousId?: string) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  addMessage: (sessionId: string, msg: LobbyMessageData) => void;
  setSessionHistory: (sessionId: string, messages: LobbyMessageData[]) => void;
  setPendingControl: (sessionId: string, request: ControlRequestData | null) => void;
  removePendingControl: (sessionId: string, requestId: string) => void;
  setTyping: (sessionId: string, typing: boolean) => void;
  setSessions: (sessions: SessionSummaryData[]) => void;
  setDiscoveredSessions: (sessions: SessionSummaryData[]) => void;
  setShowDiscoverDialog: (show: boolean) => void;

  // Lobby Manager actions
  setLmAvailable: (available: boolean) => void;
  setLmSessionId: (id: string | null) => void;

  // Channel actions
  setChannelProviders: (providers: ChannelProviderData[]) => void;
  setChannelBindings: (bindings: ChannelBindingData[]) => void;

  // Adapter permission metadata
  adapterPermissionMeta: Record<string, { displayName: string; modeLabels: Record<string, string> }>;
  adapterDefaults: Array<{ adapterName: string; permissionMode: string; displayName: string }>;

  setAdapterPermissionMeta: (meta: Record<string, { displayName: string; modeLabels: Record<string, string> }>) => void;
  setAdapterDefaults: (defaults: Array<{ adapterName: string; permissionMode: string; displayName: string }>) => void;

  // WeCom QR scan state
  wecomQrStatus: null | {
    status: 'generating' | 'waiting' | 'success' | 'expired' | 'error';
    qrUrl?: string;
    botId?: string;
    secret?: string;
    error?: string;
  };
  setWecomQrStatus: (status: LobbyState['wecomQrStatus']) => void;
}

// Track seen message IDs per session for deduplication
const seenIdsBySession: Record<string, Set<string>> = {};

function getSeenIds(sessionId: string): Set<string> {
  if (!seenIdsBySession[sessionId]) {
    seenIdsBySession[sessionId] = new Set();
  }
  return seenIdsBySession[sessionId];
}

export const useLobbyStore = create<LobbyState>((set) => ({
  sessions: {},
  activeSessionId: null,
  messagesBySession: {},
  pendingControlBySession: {},
  typingBySession: {},
  connected: false,
  discoveredSessions: [],
  showDiscoverDialog: false,

  lmAvailable: false,
  lmSessionId: null,

  channelProviders: [],
  channelBindings: [],

  commandsBySession: {},
  commandsLoadingBySession: {},

  toolAggregatorBySession: {},
  serverConfig: {},

  updateToolAggregator: (sessionId, updater) =>
    set((state) => {
      const current = state.toolAggregatorBySession[sessionId] ?? {
        isAggregating: false,
        toolCounts: {},
        lastToolName: '',
        lastToolContent: '',
        totalCalls: 0,
      };
      return {
        toolAggregatorBySession: {
          ...state.toolAggregatorBySession,
          [sessionId]: updater(current),
        },
      };
    }),

  resetToolAggregator: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.toolAggregatorBySession;
      return { toolAggregatorBySession: rest };
    }),

  setServerConfigValue: (key, value) =>
    set((state) => ({
      serverConfig: { ...state.serverConfig, [key]: value },
    })),

  setConnected: (connected) => set({ connected }),

  addSession: (session) =>
    set((state) => ({
      sessions: { ...state.sessions, [session.id]: session },
    })),

  updateSession: (session, previousId) =>
    set((state) => {
      // Handle session ID change (e.g., UUID → real CLI session ID)
      if (previousId && previousId !== session.id && state.sessions[previousId]) {
        const { [previousId]: old, ...rest } = state.sessions;
        const { [previousId]: oldMsgs, ...restMsgs } = state.messagesBySession;
        const { [previousId]: oldCtrl, ...restCtrl } = state.pendingControlBySession;
        return {
          sessions: { ...rest, [session.id]: { ...old, ...session } },
          messagesBySession: oldMsgs
            ? { ...restMsgs, [session.id]: oldMsgs }
            : restMsgs,
          pendingControlBySession: oldCtrl !== undefined
            ? { ...restCtrl, [session.id]: oldCtrl }
            : restCtrl,
          activeSessionId:
            state.activeSessionId === previousId ? session.id : state.activeSessionId,
        };
      }

      const existing = state.sessions[session.id];
      if (!existing) {
        // New session from server (e.g. after restart)
        return { sessions: { ...state.sessions, [session.id]: session } };
      }
      return {
        sessions: {
          ...state.sessions,
          [session.id]: { ...existing, ...session },
        },
      };
    }),

  removeSession: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.sessions;
      const { [id]: _m, ...restMessages } = state.messagesBySession;
      const { [id]: _c, ...restControl } = state.pendingControlBySession;
      delete seenIdsBySession[id];
      return {
        sessions: rest,
        messagesBySession: restMessages,
        pendingControlBySession: restControl,
        activeSessionId: state.activeSessionId === id ? null : state.activeSessionId,
      };
    }),

  setActiveSession: (id) => set({ activeSessionId: id }),

  addMessage: (sessionId, msg) =>
    set((state) => {
      const seenIds = getSeenIds(sessionId);
      if (seenIds.has(msg.id)) return state;
      seenIds.add(msg.id);

      const messages = [...(state.messagesBySession[sessionId] ?? [])];

      // Merge stream_delta into the last assistant message
      if (msg.type === 'stream_delta') {
        const last = messages[messages.length - 1];
        if (last && (last.type === 'assistant' || last.type === 'stream_delta')) {
          const lastContent = typeof last.content === 'string' ? last.content : '';
          const deltaContent = typeof msg.content === 'string' ? msg.content : '';
          messages[messages.length - 1] = {
            ...last,
            type: 'assistant',
            content: lastContent + deltaContent,
            timestamp: msg.timestamp,
          };
          return {
            messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
          };
        }
      }

      messages.push(msg);

      // Update session's lastMessage for sidebar preview
      const session = state.sessions[sessionId];
      if (session && typeof msg.content === 'string' && msg.content.length > 0) {
        return {
          messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...session,
              lastMessage: msg.content.slice(0, 100),
              lastActiveAt: msg.timestamp,
              messageCount: (session.messageCount ?? 0) + 1,
            },
          },
        };
      }

      return {
        messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
      };
    }),

  setSessionHistory: (sessionId, messages) =>
    set((state) => {
      // Don't overwrite existing messages with an empty history response
      const existing = state.messagesBySession[sessionId];
      if (messages.length === 0 && existing && existing.length > 0) {
        return state;
      }

      const seenIds = getSeenIds(sessionId);
      seenIds.clear();
      for (const msg of messages) {
        seenIds.add(msg.id);
      }
      return {
        messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
      };
    }),

  setPendingControl: (sessionId, request) =>
    set((state) => {
      const current = state.pendingControlBySession[sessionId] ?? [];
      const updated = request
        ? [...current, request]  // Append new control request
        : [];                     // null clears all
      const session = state.sessions[sessionId];
      const updates: Partial<LobbyState> = {
        pendingControlBySession: {
          ...state.pendingControlBySession,
          [sessionId]: updated,
        },
      };

      // Update session status for cross-session awareness
      if (session) {
        const newStatus = updated.length > 0
          ? 'awaiting_approval'
          : session.status === 'awaiting_approval'
            ? 'running'
            : session.status;
        if (newStatus !== session.status) {
          updates.sessions = {
            ...state.sessions,
            [sessionId]: { ...session, status: newStatus },
          };
        }
      }

      return updates;
    }),

  removePendingControl: (sessionId, requestId) =>
    set((state) => {
      const current = state.pendingControlBySession[sessionId] ?? [];
      const updated = current.filter((c) => c.requestId !== requestId);
      const session = state.sessions[sessionId];
      const updates: Partial<LobbyState> = {
        pendingControlBySession: {
          ...state.pendingControlBySession,
          [sessionId]: updated,
        },
      };

      if (session && updated.length === 0 && session.status === 'awaiting_approval') {
        updates.sessions = {
          ...state.sessions,
          [sessionId]: { ...session, status: 'running' },
        };
      }

      return updates;
    }),

  setTyping: (sessionId, typing) =>
    set((state) => ({
      typingBySession: { ...state.typingBySession, [sessionId]: typing },
    })),

  setSessions: (sessionsList) =>
    set(() => {
      const sessions: Record<string, SessionSummaryData> = {};
      for (const s of sessionsList) {
        sessions[s.id] = s;
      }
      return { sessions };
    }),

  setDiscoveredSessions: (sessions) =>
    set({ discoveredSessions: sessions, showDiscoverDialog: sessions.length > 0 }),

  setShowDiscoverDialog: (show) =>
    set((state) => ({
      showDiscoverDialog: show,
      discoveredSessions: show ? state.discoveredSessions : [],
    })),

  // Lobby Manager actions
  setLmAvailable: (available) => set({ lmAvailable: available }),
  setLmSessionId: (id) => set({ lmSessionId: id }),

  // Channel actions
  setChannelProviders: (providers) => set({ channelProviders: providers }),
  setChannelBindings: (bindings) => set({ channelBindings: bindings }),

  adapterPermissionMeta: {},
  adapterDefaults: [],

  setAdapterPermissionMeta: (meta) => set({ adapterPermissionMeta: meta }),
  setAdapterDefaults: (defaults) => set({ adapterDefaults: defaults }),

  wecomQrStatus: null,
  setWecomQrStatus: (status) => set({ wecomQrStatus: status }),

  setSessionCommands: (sessionId, commands, cached) =>
    set((state) => ({
      commandsBySession: { ...state.commandsBySession, [sessionId]: commands },
      commandsLoadingBySession: { ...state.commandsLoadingBySession, [sessionId]: cached === true },
    })),
}));

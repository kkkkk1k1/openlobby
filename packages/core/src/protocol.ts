import type {
  SpawnOptions,
  ControlDecision,
  SessionSummary,
  LobbyMessage,
  ControlRequest,
  AdapterCommand,
} from './types.js';
import type {
  ChannelProviderConfig,
  ChannelProviderInfo,
  ChannelBinding,
  ChannelPluginInfo,
} from './channel.js';

/** 前端 → 后端 */
export type ClientMessage =
  | { type: 'session.create'; adapterName: string; options: SpawnOptions; displayName?: string }
  | { type: 'session.resume'; sessionId: string }
  | { type: 'session.destroy'; sessionId: string }
  | { type: 'session.interrupt'; sessionId: string }
  | { type: 'session.list' }
  | { type: 'session.history'; sessionId: string }
  | { type: 'message.send'; sessionId: string; content: string }
  | { type: 'session.configure'; sessionId: string; options: Partial<SpawnOptions> }
  | {
      type: 'control.respond';
      sessionId: string;
      requestId: string;
      decision: ControlDecision;
      payload?: Record<string, unknown>;
    }
  | { type: 'session.discover'; cwd?: string }
  | {
      type: 'session.import';
      sessionId: string;
      adapterName: string;
      displayName?: string;
      cwd: string;
      jsonlPath?: string;
    }
  | { type: 'channel.list-providers' }
  | { type: 'channel.add-provider'; config: ChannelProviderConfig }
  | { type: 'channel.remove-provider'; providerId: string }
  | { type: 'channel.toggle-provider'; providerId: string; enabled: boolean }
  | { type: 'channel.list-bindings' }
  | { type: 'channel.bind'; identityKey: string; target: 'lobby-manager' | string }
  | { type: 'channel.unbind'; identityKey: string }
  | { type: 'session.plan-mode'; sessionId: string; enabled: boolean }
  | { type: 'session.recover'; sessionId: string }
  | { type: 'completion.request'; sessionId: string }
  | { type: 'session.view'; sessionId: string | null }
  | { type: 'channel.discover-plugins' }
  | { type: 'config.get'; key: string }
  | { type: 'config.set'; key: string; value: string }
  | { type: 'adapter.get-defaults' }
  | { type: 'adapter.set-default'; adapterName: string; permissionMode: string }
  | { type: 'adapter.get-meta' }
  | { type: 'wecom.qr-start' }
  | { type: 'wecom.qr-cancel' };

/** 后端 → 前端 */
export type ServerMessage =
  | { type: 'session.created'; session: SessionSummary }
  | { type: 'session.updated'; session: SessionSummary; previousId?: string }
  | { type: 'session.destroyed'; sessionId: string }
  | { type: 'session.list'; sessions: SessionSummary[] }
  | {
      type: 'session.history';
      sessionId: string;
      messages: LobbyMessage[];
    }
  | { type: 'message'; sessionId: string; message: LobbyMessage }
  | {
      type: 'control.request';
      sessionId: string;
      request: ControlRequest;
    }
  | { type: 'session.discovered'; sessions: SessionSummary[] }
  | { type: 'session.navigate'; sessionId: string }
  | { type: 'lm.status'; available: boolean; sessionId?: string }
  | { type: 'error'; sessionId?: string; error: string }
  | { type: 'channel.providers-list'; providers: ChannelProviderInfo[] }
  | { type: 'channel.provider-status'; providerId: string; healthy: boolean }
  | { type: 'channel.bindings-list'; bindings: ChannelBinding[] }
  | { type: 'channel.binding-updated'; binding: ChannelBinding }
  | { type: 'channel.binding-removed'; identityKey: string }
  | { type: 'completion.response'; sessionId: string; commands: AdapterCommand[]; cached?: boolean }
  | { type: 'channel.plugins-list'; plugins: ChannelPluginInfo[] }
  | { type: 'config.value'; key: string; value: string }
  | { type: 'adapter.defaults'; defaults: Array<{ adapterName: string; permissionMode: string; displayName: string }> }
  | { type: 'adapter.meta'; meta: Record<string, { displayName: string; modeLabels: Record<string, string> }> }
  | { type: 'wecom.qr-status'; status: 'generating' | 'waiting' | 'success' | 'expired' | 'error'; qrUrl?: string; botId?: string; secret?: string; error?: string };

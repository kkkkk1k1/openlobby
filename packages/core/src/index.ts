export type {
  LobbyMessage,
  SpawnOptions,
  ResumeOptions,
  ControlDecision,
  ControlQuestion,
  ControlRequest,
  AgentProcess,
  SessionSummary,
  AgentAdapter,
  AdapterCommand,
  McpServerConfig,
  AdapterPluginModule,
  MessageMode,
  PermissionMode,
  AdapterPermissionMeta,
} from './types.js';

export type { ClientMessage, ServerMessage } from './protocol.js';

export type {
  ChannelIdentity,
  ChannelIdentityKey,
  InboundChannelMessage,
  OutboundChannelMessage,
  ChannelProviderConfig,
  ChannelProviderInfo,
  ChannelBinding,
  ChannelProvider,
  ChannelRouter,
  ChannelPluginModule,
  ChannelPluginInfo,
} from './channel.js';
export { toIdentityKey } from './channel.js';

export { ClaudeCodeAdapter, CodexCliAdapter, OpenCodeAdapter } from './adapters/index.js';

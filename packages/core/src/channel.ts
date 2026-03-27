/** 标识一个特定通道+账号下的外部用户 */
export interface ChannelIdentity {
  /** Provider 名称: 'wecom' | 'telegram' | 'feishu' */
  channelName: string;
  /** 该通道下的 bot/app ID（支持多账号） */
  accountId: string;
  /** 外部用户 ID */
  peerId: string;
  /** 可选的用户显示名 */
  peerDisplayName?: string;
}

/** 序列化 key："channelName:accountId:peerId" */
export type ChannelIdentityKey = string;

export function toIdentityKey(id: ChannelIdentity): ChannelIdentityKey {
  return `${id.channelName}:${id.accountId}:${id.peerId}`;
}

/** 入站消息（IM → OpenLobby） */
export interface InboundChannelMessage {
  /** 来自 IM 平台的原始消息 ID */
  externalMessageId: string;
  /** 发送者身份 */
  identity: ChannelIdentity;
  /** 文本内容 */
  text: string;
  /** 时间戳 (ms) */
  timestamp: number;
  /** 附件 */
  attachments?: Array<{
    type: 'image' | 'file' | 'voice';
    url?: string;
    base64?: string;
    filename?: string;
    mimeType?: string;
  }>;
  /** 内联审批回调数据（如 "approve:sessionId:requestId"） */
  callbackData?: string;
  /** 原始平台消息对象 */
  raw?: unknown;
}

/** 出站消息（OpenLobby → IM） */
export interface OutboundChannelMessage {
  /** 目标用户 */
  identity: ChannelIdentity;
  /** 文本内容 */
  text: string;
  /** 来源 LobbyMessage ID */
  sourceMessageId?: string;
  /** 文本格式 */
  format?: 'text' | 'markdown';
  /** 消息类型 */
  kind?: 'message' | 'typing' | 'approval';
  /** 内联审批按钮 */
  actions?: Array<{
    label: string;
    callbackData: string;
  }>;
}

/** 通道 Provider 配置（持久化到数据库） */
export interface ChannelProviderConfig {
  channelName: string;
  accountId: string;
  credentials: Record<string, string>;
  webhook?: { path: string; secret?: string };
  enabled?: boolean;
}

/** Provider 状态信息（用于 UI 展示） */
export interface ChannelProviderInfo {
  /** "channelName:accountId" */
  id: string;
  channelName: string;
  accountId: string;
  enabled: boolean;
  healthy: boolean;
}

/** 通道绑定关系（IM 用户 ↔ Session） */
export interface ChannelBinding {
  identityKey: ChannelIdentityKey;
  channelName: string;
  accountId: string;
  peerId: string;
  peerDisplayName?: string;
  /** 'lobby-manager' 或具体 sessionId */
  target: 'lobby-manager' | string;
  /** 当前活跃的 sessionId（lobby-manager 模式下可动态切换） */
  activeSessionId: string | null;
  createdAt: number;
  lastActiveAt: number;
}

/** ChannelProvider 接口 — 每个 IM 平台实现一个 */
export interface ChannelProvider {
  readonly channelName: string;
  readonly accountId: string;

  /** 启动 Provider（建立连接、注册事件） */
  start(router: ChannelRouter): Promise<void>;
  /** 停止 Provider */
  stop(): Promise<void>;
  /** 发送消息到 IM */
  sendMessage(msg: OutboundChannelMessage): Promise<void>;
  /** 健康检查 */
  isHealthy(): boolean;

  /** 更新交互式卡片（审批后反馈） */
  updateCard?(peerId: string, taskId: string, resultText: string): Promise<void>;

  /** 返回需要注册到 Fastify 的 webhook 路由列表 */
  getWebhookHandlers?(): Array<{
    method: 'POST' | 'GET';
    path: string;
    handler: (request: unknown, reply: unknown) => Promise<void>;
  }>;
}

/** 路由器接口，Provider 通过它提交入站消息 */
export interface ChannelRouter {
  handleInbound(msg: InboundChannelMessage): Promise<void>;
}

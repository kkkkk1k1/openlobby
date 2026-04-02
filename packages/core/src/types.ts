import type { EventEmitter } from 'node:events';

/** 统一消息格式 — 所有 Adapter 的输出都转换为此格式 */
export interface LobbyMessage {
  id: string;
  sessionId: string;
  timestamp: number;
  type:
    | 'system'
    | 'user'
    | 'assistant'
    | 'tool_use'
    | 'tool_result'
    | 'control'
    | 'stream_delta'
    | 'result';
  content: string | Record<string, unknown>;
  meta?: {
    model?: string;
    tokenUsage?: { input: number; output: number };
    costUsd?: number;
    toolName?: string;
    isError?: boolean;
  };
}

export interface McpServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** Unified permission mode across all adapters */
export type PermissionMode = 'auto' | 'supervised' | 'readonly';

/** Each adapter declares how OpenLobby modes map to its native CLI labels */
export interface AdapterPermissionMeta {
  /** Human-readable native label for each OpenLobby permission mode */
  modeLabels: Record<PermissionMode, string>;
}

export interface SpawnOptions {
  cwd: string;
  prompt?: string;
  model?: string;
  permissionMode?: PermissionMode;
  systemPrompt?: string;
  mcpServers?: Record<string, McpServerConfig>;
  /** API key to authenticate with the Claude API (injected as ANTHROPIC_AUTH_TOKEN) */
  apiKey?: string;
}

export interface ResumeOptions extends Partial<SpawnOptions> {
  prompt?: string;
}

export type ControlDecision = 'allow' | 'deny';

/** Structured question for AskUserQuestion tool */
export interface ControlQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

export interface ControlRequest {
  requestId: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Structured questions when toolName === 'AskUserQuestion' */
  questions?: ControlQuestion[];
}

/** 代表一个运行中的 CLI 会话 */
export interface AgentProcess extends EventEmitter {
  sessionId: string;
  readonly adapter: string;
  status: 'running' | 'idle' | 'stopped' | 'error' | 'awaiting_approval';

  sendMessage(content: string): void;
  respondControl(requestId: string, decision: ControlDecision, payload?: Record<string, unknown>): void;
  updateOptions(opts: Partial<SpawnOptions>): void;
  interrupt(): void;
  kill(): void;
}

export type MessageMode = 'msg-total' | 'msg-tidy' | 'msg-only';

export interface SessionSummary {
  id: string;
  adapterName: string;
  displayName: string;
  status: string;
  lastActiveAt: number;
  lastMessage?: string;
  messageCount: number;
  model?: string;
  permissionMode?: PermissionMode;
  cwd: string;
  origin: 'lobby' | 'cli' | 'lobby-manager';
  resumeCommand: string;
  jsonlPath?: string;
  messageMode?: MessageMode;
  /** Whether this session is pinned to the top of the list */
  pinned?: boolean;
  /** Channel binding info (if session is bound to an IM channel) */
  channelBinding?: {
    channelName: string;
    peerId: string;
    peerDisplayName?: string;
  };
}

/** Slash command exposed by an adapter */
export interface AdapterCommand {
  name: string;
  description: string;
  args?: string;
}

/** Adapter 接口 — 每个 Agentic CLI 实现一个 */
export interface AgentAdapter {
  readonly name: string;
  readonly displayName: string;
  /** Permission mode metadata — native labels for each unified mode */
  readonly permissionMeta: AdapterPermissionMeta;

  detect(): Promise<{ installed: boolean; version?: string; path?: string }>;
  spawn(options: SpawnOptions): Promise<AgentProcess>;
  resume(sessionId: string, options?: ResumeOptions): Promise<AgentProcess>;
  getSessionStoragePath(): string;
  readSessionHistory(sessionId: string): Promise<LobbyMessage[]>;
  discoverSessions(cwd?: string): Promise<SessionSummary[]>;
  getResumeCommand(sessionId: string): string;
  listCommands?(): Promise<AdapterCommand[]>;
}

/** Plugin module contract for external adapter packages */
export interface AdapterPluginModule {
  createAdapter(): AgentAdapter;
  readonly adapterName: string;
  readonly displayName: string;
}

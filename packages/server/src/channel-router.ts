import type {
  ChannelProvider,
  ChannelRouter,
  ChannelBinding,
  ChannelProviderConfig,
  ChannelProviderInfo,
  InboundChannelMessage,
  LobbyMessage,
  SessionSummary,
  MessageMode,
  PermissionMode,
  CommandGroup,
} from '@openlobby/core';
import { toIdentityKey } from '@openlobby/core';
import type Database from 'better-sqlite3';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { SessionManager } from './session-manager.js';
import type { LobbyManager } from './lobby-manager.js';
import {
  upsertBinding,
  getBinding,
  getBindingBySession,
  getAllBindings,
  getAllBindingsBySession,
  updateBindingActiveSession,
  updateBindingActivity,
  resetBindingTargetBySession,
  deleteBinding,
  upsertProvider as dbUpsertProvider,
  getAllProviders as dbGetAllProviders,
  getProvider as dbGetProvider,
  deleteProvider as dbDeleteProvider,
  toggleProvider as dbToggleProvider,
  type ChannelBindingRow,
} from './db.js';
import { createProvider } from './channels/index.js';
import { randomUUID } from 'node:crypto';
import {
  handleSlashCommand as handleSharedSlashCommand,
  findSessionByIdOrName,
  type SlashCommandContext,
} from './slash-commands.js';
import { LM_WELCOME_TEXT } from './lm-welcome.js';

/** Throttle interval for <think> stream updates */
const STREAM_THROTTLE_MS = 800;
/** Max intermediate stream messages per stream (WeCom SDK limit ~100, keep headroom) */
const MAX_INTERMEDIATE_MSGS = 85;

/** Per-identity stream state for buffered think-tag typing */
interface StreamState {
  /** Accumulated stream_delta text */
  buffer: string;
  /** Number of intermediate messages sent for this stream */
  intermediateCount: number;
  /** Last flush timestamp */
  lastFlushAt: number;
  /** Pending flush timer */
  flushTimer: ReturnType<typeof setTimeout> | null;
}

/** Per-identity tool call aggregation for msg-tidy mode */
interface ToolAggregateState {
  toolCounts: Record<string, number>;
  lastToolName: string;
  lastToolContent: string;
  totalCalls: number;
}

/** Per-identity state for sequential AskUserQuestion interaction */
interface PendingQuestionState {
  sessionId: string;
  requestId: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
  currentIndex: number;
  answers: Record<string, string>;
  /** For multi-select: tracks toggled option indices for current question */
  multiSelectToggled: Set<number>;
}

export class ChannelRouterImpl implements ChannelRouter {
  private providers = new Map<string, ChannelProvider>();

  /**
   * In-memory map: sessionId → identityKey of whoever last sent a message to this session.
   * Used to route responses back to the correct IM user.
   */
  private lastSenderBySession = new Map<string, string>();

  /** Per-identity stream buffer for think-tag typing */
  private streamStates = new Map<string, StreamState>();

  /** Track message origin per session turn: 'web' or 'im' */
  private messageOriginBySession = new Map<string, 'web' | 'im'>();

  /** Per-identity tool aggregation for msg-tidy mode */
  private toolAggregates = new Map<string, ToolAggregateState>();

  /** Per-identity state for sequential AskUserQuestion interaction */
  private pendingQuestions = new Map<string, PendingQuestionState>();

  constructor(
    private sessionManager: SessionManager,
    private lobbyManager: LobbyManager | null,
    private db: Database.Database,
  ) {
    this.sessionManager.onMessage('channel-router', this.handleSessionMessage.bind(this));
    this.sessionManager.onSessionUpdate('channel-router', this.handleSessionUpdate.bind(this));
    this.sessionManager.onNavigate('channel-router', this.handleNavigate.bind(this));

    // Sync command menus when adapter commands change (rebuild, SDK refresh)
    this.sessionManager.onCommands('channel-router-cmds', (sessionId, _commands) => {
      const bindings = getAllBindingsBySession(this.db, sessionId);
      for (const binding of bindings) {
        this.syncCommandsToProvider(binding.identity_key, sessionId);
      }
    });

    // Compact event notifications
    this.sessionManager.onCompactSuggestion('channel-router-compact', (session) => {
      const bindingRow = this.resolveResponseBinding(session.id);
      if (!bindingRow) return;
      const provider = this.providers.get(`${bindingRow.channel_name}:${bindingRow.account_id}`);
      if (!provider) return;
      const identity = {
        channelName: bindingRow.channel_name,
        accountId: bindingRow.account_id,
        peerId: bindingRow.peer_id,
        peerDisplayName: bindingRow.peer_display_name ?? undefined,
      };
      const tokensK = Math.round(session.tokenUsage.totalTokens / 1000);
      const text = `⚠️ Session "${session.displayName}" context approaching limit (${tokensK}K tokens).\nReply /compact to compress, or /compact <instructions> with custom guidance.`;
      provider.sendMessage({ identity, text, kind: 'message' })
        .catch((err) => console.error('[ChannelRouter] compact suggestion notify error:', err));
    });

    this.sessionManager.onCompactComplete('channel-router-compact-done', (session, content) => {
      const bindingRow = this.resolveResponseBinding(session.id);
      if (!bindingRow) return;
      const provider = this.providers.get(`${bindingRow.channel_name}:${bindingRow.account_id}`);
      if (!provider) return;
      const identity = {
        channelName: bindingRow.channel_name,
        accountId: bindingRow.account_id,
        peerId: bindingRow.peer_id,
        peerDisplayName: bindingRow.peer_display_name ?? undefined,
      };
      const preTokens = (content as Record<string, unknown>)?.preTokens as number | undefined;
      const preK = preTokens ? Math.round(preTokens / 1000) : null;
      const text = preK
        ? `✂️ Session "${session.displayName}" compacted. (was ${preK}K tokens)`
        : `✂️ Session "${session.displayName}" compacted.`;
      provider.sendMessage({ identity, text, kind: 'message' })
        .catch((err) => console.error('[ChannelRouter] compact complete notify error:', err));
    });
  }

  /** Set the origin of the current turn for a session */
  setMessageOrigin(sessionId: string, origin: 'web' | 'im'): void {
    this.messageOriginBySession.set(sessionId, origin);
  }

  // ─── Provider Management ─────────────────────────────────────────

  async registerProvider(provider: ChannelProvider): Promise<void> {
    const key = `${provider.channelName}:${provider.accountId}`;
    this.providers.set(key, provider);
    await provider.start(this);
    console.log(`[ChannelRouter] Provider registered: ${key}`);
  }

  async unregisterProvider(providerId: string): Promise<void> {
    const provider = this.providers.get(providerId);
    if (provider) {
      await provider.stop();
      this.providers.delete(providerId);
      console.log(`[ChannelRouter] Provider unregistered: ${providerId}`);
    }
  }

  async addProviderConfig(config: ChannelProviderConfig): Promise<void> {
    const id = `${config.channelName}:${config.accountId}`;
    dbUpsertProvider(this.db, {
      id,
      channel_name: config.channelName,
      account_id: config.accountId,
      config_json: JSON.stringify(config),
      enabled: config.enabled !== false ? 1 : 0,
      created_at: Date.now(),
    });

    if (config.enabled !== false) {
      await this.unregisterProvider(id);
      try {
        const provider = await createProvider(config);
        await this.registerProvider(provider);
      } catch (err) {
        console.error(`[ChannelRouter] Failed to start provider ${id}:`, err);
      }
    }
  }

  async removeProviderConfig(providerId: string): Promise<void> {
    await this.unregisterProvider(providerId);
    dbDeleteProvider(this.db, providerId);
  }

  async toggleProviderConfig(providerId: string, enabled: boolean): Promise<void> {
    dbToggleProvider(this.db, providerId, enabled);

    if (enabled) {
      const row = dbGetProvider(this.db, providerId);
      if (row) {
        try {
          const config = JSON.parse(row.config_json) as ChannelProviderConfig;
          await this.unregisterProvider(providerId);
          const provider = await createProvider(config);
          await this.registerProvider(provider);
        } catch (err) {
          console.error(`[ChannelRouter] Failed to start provider ${providerId}:`, err);
        }
      }
    } else {
      await this.unregisterProvider(providerId);
    }
  }

  listProviders(): ChannelProviderInfo[] {
    const rows = dbGetAllProviders(this.db);
    return rows.map((r) => ({
      id: r.id,
      channelName: r.channel_name,
      accountId: r.account_id,
      enabled: r.enabled === 1,
      healthy: this.providers.get(r.id)?.isHealthy() ?? false,
    }));
  }

  // ─── Binding Management ──────────────────────────────────────────

  listBindings(): ChannelBinding[] {
    return getAllBindings(this.db).map(rowToBinding);
  }

  bindSession(
    identityKey: string,
    sessionId: string,
  ): { ok: boolean; error?: string } {
    const lmSessionId = this.lobbyManager?.getSessionId();
    if (sessionId !== lmSessionId) {
      const existing = getBindingBySession(this.db, sessionId);
      if (existing && existing.identity_key !== identityKey) {
        return {
          ok: false,
          error: `Session already bound to ${existing.peer_display_name ?? existing.peer_id} on ${existing.channel_name}`,
        };
      }
    }
    const binding = getBinding(this.db, identityKey);
    if (!binding) {
      return { ok: false, error: `Binding not found: ${identityKey}` };
    }
    updateBindingActiveSession(this.db, identityKey, sessionId);
    return { ok: true };
  }

  unbindSession(identityKey: string): void {
    const binding = getBinding(this.db, identityKey);
    if (!binding) return;
    updateBindingActiveSession(this.db, identityKey, null);
    if (binding.target !== 'lobby-manager') {
      upsertBinding(this.db, { ...binding, target: 'lobby-manager', active_session_id: null, last_active_at: Date.now() });
    }
  }

  removeBinding(identityKey: string): void {
    deleteBinding(this.db, identityKey);
  }

  // ─── Inbound Message Handling ────────────────────────────────────

  async handleInbound(msg: InboundChannelMessage): Promise<void> {
    const identityKey = toIdentityKey(msg.identity);
    console.log(`[ChannelRouter] Inbound from ${identityKey}: "${msg.text.slice(0, 80)}"`);

    if (msg.callbackData) {
      await this.handleCallback(msg.callbackData, msg.identity);
      return;
    }

    // Slash command interception — handled locally, never forwarded to AI agent
    const trimmed = msg.text.trim();
    if (trimmed.startsWith('/')) {
      const slashResult = await this.handleSlashCommand(trimmed, identityKey, msg.identity);
      if (slashResult !== null) {
        await this.sendToChannel(msg.identity, slashResult);
        return;
      }
      // null means unknown command — fall through to normal routing
    }

    let binding = getBinding(this.db, identityKey);
    if (!binding) {
      binding = this.createDefaultBinding(msg.identity);
    }

    const sessionId = this.resolveSessionId(binding);
    if (!sessionId) {
      console.warn(`[ChannelRouter] No session available for ${identityKey}`);
      await this.sendToChannel(msg.identity, '⚠️ 暂无可用会话，Lobby Manager 未就绪。');
      return;
    }

    console.log(`[ChannelRouter] Routing to session ${sessionId}`);
    this.lastSenderBySession.set(sessionId, identityKey);
    this.messageOriginBySession.set(sessionId, 'im');

    // Initialize think state immediately when user sends a message
    // This ensures typing indicator shows up right away
    const provider = this.providers.get(`${binding.channel_name}:${binding.account_id}`);
    if (provider) {
      const sessionName = this.getSessionDisplayName(sessionId);
      const state: StreamState = { buffer: '', intermediateCount: 0, lastFlushAt: Date.now(), flushTimer: null };
      this.streamStates.set(identityKey, state);
      provider.sendMessage({
        identity: msg.identity,
        text: `<think>\n【${sessionName}】正在思考...\n</think>`,
        kind: 'typing',
      }).catch((err) => console.error('[ChannelRouter] initial think error:', err));
      state.intermediateCount++;
    }

    try {
      // Download IM attachments to local .openlobby-cache (same as Web upload)
      let messageText = msg.text;
      if (msg.attachments && msg.attachments.length > 0) {
        const sessionInfo = this.sessionManager.getSessionInfo(sessionId);
        const cwd = sessionInfo?.cwd;
        const downloadedPaths: string[] = [];

        for (const a of msg.attachments) {
          // Case 1: Provider already downloaded to local path (e.g. WeCom decrypted media)
          const attachPath = (a as unknown as { path?: string }).path;
          if (attachPath) {
            const localPath = attachPath;
            if (cwd) {
              // Copy to session cache
              const { copyFileSync } = await import('node:fs');
              const ext = extname(localPath) || '.bin';
              const cacheDir = join(cwd, '.openlobby-cache');
              mkdirSync(cacheDir, { recursive: true });
              const savedName = `${randomUUID()}${ext}`;
              const savedPath = join(cacheDir, savedName);
              copyFileSync(localPath, savedPath);
              downloadedPaths.push(savedPath);
              console.log(`[ChannelRouter] Attachment copied: ${localPath} → ${savedPath}`);
            } else {
              downloadedPaths.push(localPath);
            }
            continue;
          }

          // Case 2: Remote URL or base64 — download to local
          if (!a.url && !a.base64) continue;
          try {
            let buffer: Buffer;
            let ext: string;

            if (a.url) {
              const res = await fetch(a.url);
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              buffer = Buffer.from(await res.arrayBuffer());
              const contentType = res.headers.get('content-type')?.split(';')[0]?.trim();
              ext = a.filename ? extname(a.filename)
                : a.mimeType ? (`.${a.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'}`)
                : contentType ? (`.${contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'}`)
                : extname(new URL(a.url).pathname) || '.bin';
            } else {
              buffer = Buffer.from(a.base64!, 'base64');
              ext = a.filename ? extname(a.filename) : '.bin';
            }

            if (cwd) {
              const cacheDir = join(cwd, '.openlobby-cache');
              mkdirSync(cacheDir, { recursive: true });
              const savedName = `${randomUUID()}${ext}`;
              const savedPath = join(cacheDir, savedName);
              writeFileSync(savedPath, buffer);
              downloadedPaths.push(savedPath);
              console.log(`[ChannelRouter] Attachment saved: ${savedPath} (${buffer.length} bytes)`);
            }
          } catch (err) {
            console.error('[ChannelRouter] Failed to download attachment:', err);
            const label = a.type === 'image' ? '图片' : a.type === 'voice' ? '语音' : '文件';
            const name = a.filename ? ` ${a.filename}` : '';
            downloadedPaths.push(`[附件下载失败: ${label}${name} ${a.url ?? ''}]`);
          }
        }

        if (downloadedPaths.length > 0) {
          const attachmentText = downloadedPaths
            .map((p) => p.startsWith('[') ? p : `[Attached: ${p}]`)
            .join('\n');
          messageText = messageText
            ? `${messageText}\n\n${attachmentText}`
            : attachmentText;
        }
      }
      await this.sessionManager.sendMessage(sessionId, messageText);
      updateBindingActivity(this.db, identityKey);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ChannelRouter] Failed to route inbound message:`, errMsg);
      // Clear think state on error
      this.streamStates.delete(identityKey);

      // If recovery failed for an error/stopped session, fall back to LobbyManager
      const session = this.sessionManager.getSessionInfo(sessionId);
      if (session && (session.status === 'error' || session.status === 'stopped')) {
        updateBindingActiveSession(this.db, identityKey, null);
        console.log(`[ChannelRouter] Recovery failed, reset binding ${identityKey} to LobbyManager`);
        await this.sendToChannel(msg.identity, `⚠️ 会话恢复失败，已切换回 Lobby Manager。`);
      } else {
        await this.sendToChannel(msg.identity, `⚠️ 消息发送失败: ${errMsg}`);
      }
    }
  }

  // ─── Slash Command Handler ─────────────────────────────────────

  /**
   * Handle slash commands from IM users.
   * Delegates to shared handler for common commands, handles IM-specific ones locally.
   * Returns the response text if the command was recognized, or null if not.
   */
  private async handleSlashCommand(
    input: string,
    identityKey: string,
    identity: InboundChannelMessage['identity'],
  ): Promise<string | null> {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/_/g, '-');
    const arg = parts.slice(1).join(' ').trim();

    // IM-specific commands (need binding/identity context)
    switch (cmd) {
      case '/exit':
        return this.cmdExit(identityKey);
      case '/stop':
        return await this.cmdStop(identityKey);
      case '/info':
        return this.cmdInfo(identityKey);
      case '/bind':
        return this.cmdBind(identityKey, arg);
      case '/unbind':
        return this.cmdUnbind(identityKey);
      case '/goto':
        return this.cmdGoto(identityKey, arg);
      case '/new':
        return await this.cmdNew(identityKey);
      case '/msg-only':
      case '/msg-tidy':
      case '/msg-total':
        return this.cmdMsgMode(identityKey, cmd.slice(1) as MessageMode);
      case '/cmd':
        return this.cmdShowMenu(identityKey, identity);
    }

    // Delegate to shared handler for common commands (/help, /ls, /add, /rm)
    const ctx: SlashCommandContext = {
      sessionManager: this.sessionManager,
      lmSessionId: this.lobbyManager?.getSessionId() ?? null,
      callerKey: identityKey,
    };
    const result = await handleSharedSlashCommand(input, ctx);
    if (!result) return null;

    // Apply IM-specific side effects
    if (result.createdSessionId) {
      updateBindingActiveSession(this.db, identityKey, result.createdSessionId);
      this.lastSenderBySession.set(result.createdSessionId, identityKey);
    }
    if (result.navigateSessionId && !result.createdSessionId) {
      updateBindingActiveSession(this.db, identityKey, result.navigateSessionId);
      this.lastSenderBySession.set(result.navigateSessionId, identityKey);
    }
    if (result.destroyedSessionId) {
      this.handleSessionDestroyed(result.destroyedSessionId);
    }

    return result.text;
  }

  /** /goto <序号|id|name> — Switch to a session (IM version with exclusivity check) */
  private cmdGoto(identityKey: string, arg: string): string {
    if (!arg) {
      return '⚠️ 用法: `/goto <序号|id|name>`';
    }

    const session = findSessionByIdOrName(this.sessionManager, arg, identityKey);
    if (!session) {
      return `⚠️ 未找到匹配的会话: "${arg}"`;
    }

    // Check exclusivity
    const lmSessionId = this.lobbyManager?.getSessionId();
    if (session.id !== lmSessionId) {
      const existing = getBindingBySession(this.db, session.id);
      if (existing && existing.identity_key !== identityKey) {
        return `⚠️ 会话已被 ${existing.peer_display_name ?? existing.peer_id} 占用，无法切换。`;
      }
    }

    const binding = getBinding(this.db, identityKey);
    if (binding?.active_session_id) {
      this.lastSenderBySession.delete(binding.active_session_id);
    }

    updateBindingActiveSession(this.db, identityKey, session.id);
    this.lastSenderBySession.set(session.id, identityKey);

    // Sync command menu for new session (may be different adapter)
    this.syncCommandsToProvider(identityKey, session.id);

    return `✅ 已切换到会话: **${session.displayName}** (\`${session.id.slice(0, 12)}\`)`;
  }

  /** /stop — Interrupt current model generation */
  private async cmdStop(identityKey: string): Promise<string> {
    const binding = getBinding(this.db, identityKey);
    const sessionId = binding?.active_session_id;
    if (!sessionId) {
      return '⚠️ 当前未绑定任何会话。';
    }
    const lmId = this.lobbyManager?.getSessionId();
    if (sessionId === lmId) {
      return '⚠️ Lobby Manager 无法被打断。';
    }
    await this.sessionManager.interruptSession(sessionId);
    return '⏹ 已打断模型回复。';
  }

  /** /new — Rebuild CLI session */
  private async cmdNew(identityKey: string): Promise<string> {
    const binding = getBinding(this.db, identityKey);
    const sessionId = binding?.active_session_id;
    if (!sessionId) {
      return '⚠️ 当前未绑定任何会话。';
    }
    try {
      await this.sessionManager.rebuildSession(sessionId);
      return '✅ CLI 会话已重建。';
    } catch (err) {
      return `⚠️ 重建失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** /msg-* — Switch message mode */
  private cmdMsgMode(identityKey: string, mode: MessageMode): string {
    const binding = getBinding(this.db, identityKey);
    if (!binding) {
      return '⚠️ 当前未绑定任何会话。';
    }
    const sessionId = this.resolveSessionId(binding);
    if (!sessionId) {
      return '⚠️ 当前未绑定任何会话。';
    }
    try {
      this.sessionManager.configureSession(sessionId, { messageMode: mode } as any);
      return `✅ 消息模式已切换为 \`${mode}\``;
    } catch (err) {
      return `⚠️ 切换失败: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** /cmd — Show command menu via provider card or formatted text */
  private cmdShowMenu(
    identityKey: string,
    identity: InboundChannelMessage['identity'],
  ): string {
    const binding = getBinding(this.db, identityKey);
    const sessionId = binding ? this.resolveSessionId(binding) : null;
    const groups = sessionId
      ? this.buildCommandGroups(sessionId)
      : this.buildCommandGroups(this.lobbyManager?.getSessionId() ?? '');

    const provider = this.providers.get(`${identity.channelName}:${identity.accountId}`);

    // If provider has sendCommandMenu (e.g. WeCom), use it
    const wecomProvider = provider as any;
    if (typeof wecomProvider?.sendCommandMenu === 'function') {
      // Ensure cache is fresh, then send card
      if (provider?.syncCommands) {
        provider.syncCommands(identity.peerId, groups).catch(() => {});
      }
      wecomProvider.sendCommandMenu(identity.peerId).catch(
        (err: Error) => console.error('[ChannelRouter] sendCommandMenu error:', err),
      );
      return ''; // Card sent directly by provider; return empty to suppress text reply
    }

    // Fallback: return formatted text (works for Telegram and any other provider)
    const lines: string[] = ['📋 **命令菜单**', ''];
    for (const group of groups) {
      lines.push(`**${group.label}**`);
      for (const cmd of group.commands) {
        lines.push(`\`/${cmd.command}\` — ${cmd.description}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  /** /exit — Return to Lobby Manager */
  private cmdExit(identityKey: string): string {
    const binding = getBinding(this.db, identityKey);
    if (binding?.active_session_id) {
      this.lastSenderBySession.delete(binding.active_session_id);
      this.streamStates.delete(identityKey);
    }
    updateBindingActiveSession(this.db, identityKey, null);
    const lmId = this.lobbyManager?.getSessionId();
    if (lmId) {
      this.lastSenderBySession.set(lmId, identityKey);
    }
    return '✅ 已返回 Lobby Manager，请发送新指令。';
  }

  /** /info — Show current session info */
  private cmdInfo(identityKey: string): string {
    const binding = getBinding(this.db, identityKey);
    if (!binding) {
      return 'ℹ️ 未绑定任何会话，当前连接到 Lobby Manager。';
    }

    const sessionId = this.resolveSessionId(binding);
    if (!sessionId) {
      return 'ℹ️ 未绑定任何会话，当前连接到 Lobby Manager。';
    }

    const lmSessionId = this.lobbyManager?.getSessionId();
    if (sessionId === lmSessionId) {
      return 'ℹ️ 当前连接到 **Lobby Manager**。使用 `/goto` 切换到其他会话。';
    }

    const info = this.sessionManager.getSessionInfo(sessionId);
    if (!info) {
      return `ℹ️ 当前会话 ID: \`${sessionId}\`（详细信息不可用）`;
    }

    const statusIcon = info.status === 'running' ? '🟢'
      : info.status === 'idle' ? '🟡'
      : info.status === 'error' ? '🔴'
      : info.status === 'awaiting_approval' ? '🟠'
      : '⚫';

    return [
      `ℹ️ **当前会话信息**`,
      '',
      `**名称:** ${info.displayName}`,
      `**ID:** \`${info.id}\``,
      `**状态:** ${statusIcon} ${info.status}`,
      `**适配器:** ${info.adapterName}`,
      `**工作目录:** \`${info.cwd}\``,
      info.model ? `**模型:** ${info.model}` : null,
      `**消息数:** ${info.messageCount}`,
    ].filter(Boolean).join('\n');
  }

  /** /bind <sessionId> — Bind to a specific session */
  private cmdBind(identityKey: string, arg: string): string {
    if (!arg) {
      return '⚠️ 用法: `/bind <session_id>`';
    }

    const session = findSessionByIdOrName(this.sessionManager, arg);
    if (!session) {
      return `⚠️ 未找到匹配的会话: "${arg}"`;
    }

    const result = this.bindSession(identityKey, session.id);
    if (!result.ok) {
      return `⚠️ 绑定失败: ${result.error}`;
    }

    this.lastSenderBySession.set(session.id, identityKey);
    return `✅ 已绑定到会话: **${session.displayName}** (\`${session.id.slice(0, 12)}\`)`;
  }

  /** /unbind — Unbind from current session */
  private cmdUnbind(identityKey: string): string {
    this.unbindSession(identityKey);
    const lmId = this.lobbyManager?.getSessionId();
    if (lmId) {
      this.lastSenderBySession.set(lmId, identityKey);
    }
    return '✅ 已解绑当前会话，返回 Lobby Manager。';
  }

  // ─── Session Message → IM (with stream buffer + markdown formatting) ──

  private handleSessionMessage(sessionId: string, msg: LobbyMessage): void {
    const origin = this.messageOriginBySession.get(sessionId);

    // Clean up origin tracking on turn completion
    if (msg.type === 'result') {
      this.messageOriginBySession.delete(sessionId);
    }

    // Source-aware routing: web-originated turns don't push to IM
    // (web always receives messages via WebSocket broadcast)
    // Control (approval) messages bypass this — they use special routing below
    if (origin === 'web' && msg.type !== 'control') {
      return;
    }

    // For control messages when origin is 'web': route approval to IM
    // only if web is NOT currently viewing this session
    if (msg.type === 'control' && origin === 'web') {
      this.routeApprovalToIM(sessionId, msg);
      return;
    }

    // Get message mode for this session
    const messageMode = this.sessionManager.getSessionMode(sessionId);

    // msg-only: suppress tool_use and tool_result (control always passes)
    if (messageMode === 'msg-only' && (msg.type === 'tool_use' || msg.type === 'tool_result')) {
      return;
    }

    const bindingRow = this.resolveResponseBinding(sessionId);
    if (!bindingRow) {
      // Only log for non-trivial message types (skip noisy stream_delta)
      if (msg.type !== 'stream_delta') {
        console.log(`[ChannelRouter] No binding for session ${sessionId}, msg.type=${msg.type}`);
      }
      return;
    }

    const provider = this.providers.get(`${bindingRow.channel_name}:${bindingRow.account_id}`);
    if (!provider) return;

    const identity = {
      channelName: bindingRow.channel_name,
      accountId: bindingRow.account_id,
      peerId: bindingRow.peer_id,
      peerDisplayName: bindingRow.peer_display_name ?? undefined,
    };

    const sessionName = this.getSessionDisplayName(sessionId);
    const identityKey = bindingRow.identity_key;
    const isTelegramTidy =
      provider.channelName === 'telegram' && messageMode === 'msg-tidy';

    switch (msg.type) {
      // ── stream_delta: accumulate into <think> buffer ──
      case 'stream_delta': {
        const delta = typeof msg.content === 'string' ? msg.content : '';
        if (!delta) break;

        let state = this.streamStates.get(identityKey);
        if (!state) {
          state = { buffer: '', intermediateCount: 0, lastFlushAt: 0, flushTimer: null };
          this.streamStates.set(identityKey, state);
        }
        state.buffer += delta;

        // Throttled flush
        const now = Date.now();
        if (!state.flushTimer && now - state.lastFlushAt >= STREAM_THROTTLE_MS) {
          this.flushStreamThinking(identityKey, provider, identity, sessionName);
        } else if (!state.flushTimer) {
          const delay = STREAM_THROTTLE_MS - (now - state.lastFlushAt);
          state.flushTimer = setTimeout(() => {
            state!.flushTimer = null;
            this.flushStreamThinking(identityKey, provider, identity, sessionName);
          }, delay);
        }
        break;
      }

      // ── tool_use: also triggers think state if not already active ──
      // Claude Code SDK doesn't emit stream_delta, so tool_use is our first
      // signal that the agent is working. Send a <think> placeholder.
      case 'tool_use': {
        const toolName = String(msg.meta?.toolName ?? 'unknown');
        const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);

        if (isTelegramTidy) {
          if (!this.streamStates.has(identityKey)) {
            const state: StreamState = { buffer: '', intermediateCount: 0, lastFlushAt: 0, flushTimer: null };
            this.streamStates.set(identityKey, state);
          }

          const state = this.streamStates.get(identityKey)!;
          const thinkText = `<think>\n【${sessionName}】正在处理... 🔧 ${toolName}\n──\n📄 ${raw.slice(0, 160)}\n</think>`;
          provider.sendMessage({ identity, text: thinkText, kind: 'typing' })
            .catch((err) => console.error('[ChannelRouter] telegram tidy think error:', err));
          state.intermediateCount++;
          state.lastFlushAt = Date.now();
          break;
        }

        // msg-tidy: aggregate tool calls, show think with stats + last tool preview
        if (messageMode === 'msg-tidy') {
          let agg = this.toolAggregates.get(identityKey);
          if (!agg) {
            agg = { toolCounts: {}, lastToolName: '', lastToolContent: '', totalCalls: 0 };
            this.toolAggregates.set(identityKey, agg);
          }
          agg.toolCounts[toolName] = (agg.toolCounts[toolName] ?? 0) + 1;
          agg.lastToolName = toolName;
          agg.lastToolContent = raw.slice(0, 100);
          agg.totalCalls++;

          const statsChain = Object.entries(agg.toolCounts)
            .map(([name, count]) => `${name}(${count})`)
            .join(' → ');

          // Ensure think stream is active
          if (!this.streamStates.has(identityKey)) {
            const state: StreamState = { buffer: '', intermediateCount: 0, lastFlushAt: 0, flushTimer: null };
            this.streamStates.set(identityKey, state);
          }
          const state = this.streamStates.get(identityKey)!;

          if (state.intermediateCount < MAX_INTERMEDIATE_MSGS) {
            const thinkText = `<think>\n【${sessionName}】正在处理... 🔧 ${statsChain}\n──\n📄 ${toolName}: ${agg.lastToolContent}\n</think>`;
            provider.sendMessage({ identity, text: thinkText, kind: 'typing' })
              .catch((err) => console.error('[ChannelRouter] tidy think error:', err));
            state.intermediateCount++;
            state.lastFlushAt = Date.now();
          }
          break; // Don't send individual tool_use message
        }

        // msg-total: existing behavior below...

        // Ensure a think stream is active
        if (!this.streamStates.has(identityKey)) {
          const state: StreamState = { buffer: '', intermediateCount: 0, lastFlushAt: 0, flushTimer: null };
          this.streamStates.set(identityKey, state);
          // Send initial think placeholder
          provider.sendMessage({
            identity,
            text: `<think>\n【${sessionName}】正在处理...\n</think>`,
            kind: 'typing',
          }).catch((err) => console.error('[ChannelRouter] think init error:', err));
          state.intermediateCount++;
          state.lastFlushAt = Date.now();
        }

        // Update think content with tool info
        const state = this.streamStates.get(identityKey)!;
        state.buffer += `\n🔧 ${toolName}`;

        // Throttled flush with tool info
        const now = Date.now();
        if (now - state.lastFlushAt >= STREAM_THROTTLE_MS && state.intermediateCount < MAX_INTERMEDIATE_MSGS) {
          this.flushStreamThinking(identityKey, provider, identity, sessionName);
        }

        // Send tool_use as a proper message, then re-enter think state
        const formatted = formatToolUse(sessionName, toolName, raw);
        provider.sendMessage({
          identity, text: formatted, kind: 'message', format: 'markdown',
        }).then(() => {
          // Re-enter think state after the message is sent
          const s = this.streamStates.get(identityKey);
          if (s) {
            provider.sendMessage({
              identity,
              text: `<think>\n【${sessionName}】正在思考...\n${s.buffer.slice(-300)}\n</think>`,
              kind: 'typing',
            }).catch((err) => console.error('[ChannelRouter] re-think error:', err));
            s.intermediateCount++;
            s.lastFlushAt = Date.now();
          }
        }).catch((err) => console.error('[ChannelRouter] tool_use send error:', err));
        break;
      }

      // ── assistant: the full assembled response text ──
      case 'assistant': {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        if (!text.trim()) break;

        if (isTelegramTidy) {
          const state = this.streamStates.get(identityKey) ?? {
            buffer: '',
            intermediateCount: 0,
            lastFlushAt: 0,
            flushTimer: null,
          };
          state.buffer = text;
          this.streamStates.set(identityKey, state);
          break;
        }

        // msg-tidy: send final tool stats before the reply (must be sequential to avoid race)
        const agg = this.toolAggregates.get(identityKey);
        if (messageMode === 'msg-tidy' && agg && agg.totalCalls > 0) {
          const statsList = Object.entries(agg.toolCounts)
            .map(([name, count]) => `${name}(${count})`)
            .join(', ');
          const statsMsg = `🔧 已完成 ${agg.totalCalls} 次工具调用: ${statsList}`;
          this.toolAggregates.delete(identityKey);

          // Clear stream state SYNCHRONOUSLY so that the subsequent 'result' message
          // won't find buffered text and re-send it (result arrives before .then() runs)
          const stateForTidy = this.streamStates.get(identityKey);
          if (stateForTidy?.flushTimer) clearTimeout(stateForTidy.flushTimer);
          this.streamStates.delete(identityKey);

          // Chain: send stats → then send assistant reply (sequential, not concurrent)
          provider.sendMessage({ identity, text: statsMsg, kind: 'message', format: 'markdown' })
            .then(() => {
              const formatted = formatAssistant(sessionName, text);
              this.finishStream(identityKey, provider, identity, formatted);
            })
            .catch((err) => {
              console.error('[ChannelRouter] tidy stats error:', err);
              // Still send the reply even if stats failed
              const formatted = formatAssistant(sessionName, text);
              this.finishStream(identityKey, provider, identity, formatted);
            });
          break; // Skip normal handling below — it's handled in the promise chain
        }

        // Normal (non-tidy or no tool calls): existing behavior
        const state = this.streamStates.get(identityKey);
        if (state) {
          state.buffer = text;
        }
        const formatted = formatAssistant(sessionName, text);
        this.finishStream(identityKey, provider, identity, formatted);
        break;
      }

      // ── result: session turn complete (token stats) ──
      // If assistant already sent the reply, result just has stats — send only if meaningful.
      // If assistant was never sent (no stream), use the accumulated buffer.
      case 'result': {
        const tidyAgg = this.toolAggregates.get(identityKey);
        this.toolAggregates.delete(identityKey);

        const state = this.streamStates.get(identityKey);
        const bufferedText = state?.buffer ?? '';

        if (isTelegramTidy) {
          if (bufferedText.trim()) {
            const formatted = formatAssistant(sessionName, bufferedText);
            this.finishStream(identityKey, provider, identity, formatted);
          } else {
            if (state?.flushTimer) clearTimeout(state.flushTimer);
            this.streamStates.delete(identityKey);
          }
          break;
        }

        // If msg-tidy has pending stats, send them first (chained to avoid race)
        if (tidyAgg && tidyAgg.totalCalls > 0 && messageMode === 'msg-tidy') {
          const statsList = Object.entries(tidyAgg.toolCounts)
            .map(([name, count]) => `${name}(${count})`)
            .join(', ');
          const statsMsg = `🔧 已完成 ${tidyAgg.totalCalls} 次工具调用: ${statsList}`;

          provider.sendMessage({ identity, text: statsMsg, kind: 'message', format: 'markdown' })
            .then(() => {
              if (bufferedText.trim()) {
                const formatted = formatAssistant(sessionName, bufferedText);
                this.finishStream(identityKey, provider, identity, formatted);
              } else {
                if (state?.flushTimer) clearTimeout(state.flushTimer);
                this.streamStates.delete(identityKey);
              }
            })
            .catch((err) => {
              console.error('[ChannelRouter] tidy stats error:', err);
              // Still handle buffered text on error
              if (bufferedText.trim()) {
                const formatted = formatAssistant(sessionName, bufferedText);
                this.finishStream(identityKey, provider, identity, formatted);
              } else {
                if (state?.flushTimer) clearTimeout(state.flushTimer);
                this.streamStates.delete(identityKey);
              }
            });
          break;
        }

        // No tidy stats: normal behavior
        if (bufferedText.trim()) {
          const formatted = formatAssistant(sessionName, bufferedText);
          this.finishStream(identityKey, provider, identity, formatted);
        } else {
          // Just clean up stream state
          if (state?.flushTimer) clearTimeout(state.flushTimer);
          this.streamStates.delete(identityKey);
        }

        break;
      }

      // ── tool_result: send as message, then re-enter think state ──
      case 'tool_result': {
        // msg-tidy: skip individual tool_result, just refresh think
        if (messageMode === 'msg-tidy') {
          const state = this.streamStates.get(identityKey);
          if (state && state.intermediateCount < MAX_INTERMEDIATE_MSGS) {
            const agg = this.toolAggregates.get(identityKey);
            const statsChain = agg
              ? Object.entries(agg.toolCounts).map(([name, count]) => `${name}(${count})`).join(' → ')
              : '';
            provider.sendMessage({
              identity,
              text: `<think>\n【${sessionName}】正在处理... 🔧 ${statsChain}\n</think>`,
              kind: 'typing',
            }).catch((err) => console.error('[ChannelRouter] tidy re-think error:', err));
            state.intermediateCount++;
            state.lastFlushAt = Date.now();
          }
          break; // Don't send individual tool_result
        }

        // msg-total: existing behavior below...
        const toolName = String(msg.meta?.toolName ?? '');
        const isError = msg.meta?.isError === true;
        const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
        const formatted = formatToolResult(sessionName, toolName, raw, isError);

        provider.sendMessage({
          identity, text: formatted, kind: 'message', format: 'markdown',
        }).then(() => {
          // Re-enter think state after the message is sent
          const s = this.streamStates.get(identityKey);
          if (s) {
            provider.sendMessage({
              identity,
              text: `<think>\n【${sessionName}】正在处理...\n</think>`,
              kind: 'typing',
            }).catch((err) => console.error('[ChannelRouter] re-think error:', err));
            s.intermediateCount++;
            s.lastFlushAt = Date.now();
          }
        }).catch((err) => console.error('[ChannelRouter] tool_result send error:', err));
        break;
      }

      // ── control: approval card or question card ──
      case 'control': {
        // Safety net: if session is in auto/readonly mode, adapter already handled — skip IM routing
        const sessionInfo = this.sessionManager.getSessionInfo(sessionId);
        if (sessionInfo) {
          const effectiveMode = this.sessionManager.resolvePermissionMode(
            sessionInfo.adapterName,
            sessionInfo.permissionMode as any,
          );
          if (effectiveMode === 'auto' || effectiveMode === 'readonly') {
            console.log(`[ChannelRouter] Skipping approval routing — session in ${effectiveMode} mode`);
            break;
          }
        }

        const content = msg.content as Record<string, unknown>;
        const toolName = (content.toolName as string) ?? 'unknown';
        const toolInput = content.toolInput as Record<string, unknown> | undefined;
        const requestId = content.requestId as string;
        const questions = content.questions as PendingQuestionState['questions'] | undefined;

        if (questions && questions.length > 0) {
          // AskUserQuestion — start sequential question interaction
          const state: PendingQuestionState = {
            sessionId,
            requestId,
            questions,
            currentIndex: 0,
            answers: {},
            multiSelectToggled: new Set(),
          };
          this.pendingQuestions.set(identityKey, state);
          this.sendQuestionToIM(identityKey, provider, identity, state);
        } else {
          // Regular tool approval — Allow/Deny buttons
          const inputPreview = toolInput ? JSON.stringify(toolInput).slice(0, 200) : '';
          const taskId = `ap_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

          const formatted = `**【${sessionName}】🔒 工具审批: \`${toolName}\`**\n> ${inputPreview}`;

          provider.sendMessage({
            identity,
            text: formatted,
            kind: 'approval',
            actions: [
              { label: '✅ 允许', callbackData: `approve:${sessionId}:${requestId}:${taskId}` },
              { label: '❌ 拒绝', callbackData: `deny:${sessionId}:${requestId}:${taskId}` },
            ],
          }).catch((err) => console.error('[ChannelRouter] approval send error:', err));
        }
        break;
      }

      // system → skip
      default:
        break;
    }
  }

  // ─── Stream Buffer Management ────────────────────────────────────

  /** Flush accumulated stream buffer as <think> intermediate content */
  private flushStreamThinking(
    identityKey: string,
    provider: ChannelProvider,
    identity: { channelName: string; accountId: string; peerId: string; peerDisplayName?: string },
    sessionName: string,
  ): void {
    const state = this.streamStates.get(identityKey);
    if (!state || !state.buffer) return;
    if (state.intermediateCount >= MAX_INTERMEDIATE_MSGS) return;

    const thinkContent = `<think>\n【${sessionName}】正在思考...\n${state.buffer.slice(-500)}\n</think>`;
    state.lastFlushAt = Date.now();
    state.intermediateCount++;

    provider.sendMessage({
      identity,
      text: thinkContent,
      kind: 'typing',
    }).catch((err) => console.error('[ChannelRouter] think stream error:', err));
  }

  /** Finish the stream: clear buffer and send final content with finish=true */
  private finishStream(
    identityKey: string,
    provider: ChannelProvider,
    identity: { channelName: string; accountId: string; peerId: string; peerDisplayName?: string },
    finalText: string,
  ): void {
    // Clear any pending flush timer
    const state = this.streamStates.get(identityKey);
    if (state?.flushTimer) {
      clearTimeout(state.flushTimer);
    }
    this.streamStates.delete(identityKey);

    if (!finalText.trim()) return;

    console.log(`[ChannelRouter] Finishing stream for ${identityKey}: ${finalText.slice(0, 60)}...`);
    provider.sendMessage({
      identity,
      text: finalText,
      kind: 'message',
      format: 'markdown',
    }).catch((err) => console.error('[ChannelRouter] finish stream error:', err));
  }

  /** Route approval notification to IM when web is not viewing the session */
  private routeApprovalToIM(sessionId: string, msg: LobbyMessage): void {
    // Safety net: if session is in auto/readonly mode, skip IM routing
    // (mirrors the check in case 'control' of handleSessionMessage)
    const sessionInfo = this.sessionManager.getSessionInfo(sessionId);
    if (sessionInfo) {
      const effectiveMode = this.sessionManager.resolvePermissionMode(
        sessionInfo.adapterName,
        sessionInfo.permissionMode as PermissionMode | undefined,
      );
      if (effectiveMode === 'auto' || effectiveMode === 'readonly') {
        console.log(`[ChannelRouter] routeApprovalToIM: skipping — session in ${effectiveMode} mode`);
        return;
      }
    }

    // If web is viewing this session, no need to push to IM
    if (this.sessionManager.isSessionViewedOnWeb(sessionId)) return;

    // Find IM binding for this session
    let bindingRow = this.resolveResponseBinding(sessionId);

    // Fallback: if no binding for this session, try Lobby Manager's binding
    if (!bindingRow && this.lobbyManager) {
      const lmSessionId = this.lobbyManager.getSessionId();
      if (lmSessionId) {
        bindingRow = this.resolveResponseBinding(lmSessionId);
      }
    }

    if (!bindingRow) return;

    const provider = this.providers.get(`${bindingRow.channel_name}:${bindingRow.account_id}`);
    if (!provider) return;

    const identity = {
      channelName: bindingRow.channel_name,
      accountId: bindingRow.account_id,
      peerId: bindingRow.peer_id,
      peerDisplayName: bindingRow.peer_display_name ?? undefined,
    };

    const content = msg.content as Record<string, unknown>;
    const toolName = (content.toolName as string) ?? 'unknown';
    const toolInput = content.toolInput as Record<string, unknown> | undefined;
    const requestId = content.requestId as string;
    const questions = content.questions as PendingQuestionState['questions'] | undefined;
    const sessionName = this.getSessionDisplayName(sessionId);

    if (questions && questions.length > 0) {
      // AskUserQuestion — start sequential interaction
      const identityKey = toIdentityKey(identity);
      const state: PendingQuestionState = {
        sessionId,
        requestId,
        questions,
        currentIndex: 0,
        answers: {},
        multiSelectToggled: new Set(),
      };
      this.pendingQuestions.set(identityKey, state);
      this.sendQuestionToIM(identityKey, provider, identity, state);
    } else {
      // Regular approval — Allow/Deny buttons
      const inputPreview = toolInput ? JSON.stringify(toolInput).slice(0, 200) : '';
      const taskId = `ap_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

      const formatted = `**【${sessionName}】🔒 工具审批: \`${toolName}\`**\n> ${inputPreview}`;

      provider.sendMessage({
        identity,
        text: formatted,
        kind: 'approval',
        actions: [
          { label: '✅ 允许', callbackData: `approve:${sessionId}:${requestId}:${taskId}` },
          { label: '❌ 拒绝', callbackData: `deny:${sessionId}:${requestId}:${taskId}` },
        ],
      }).catch((err) => console.error('[ChannelRouter] approval IM push error:', err));
    }
  }

  // ─── Response Binding Resolution ─────────────────────────────────

  private resolveResponseBinding(sessionId: string): ChannelBindingRow | null {
    // 1. In-memory: who last sent a message to this session
    const lastSenderKey = this.lastSenderBySession.get(sessionId);
    if (lastSenderKey) {
      const binding = getBinding(this.db, lastSenderKey);
      if (binding) return binding;
    }

    // 2. DB lookup by active_session_id
    const dbBinding = getBindingBySession(this.db, sessionId);
    if (dbBinding) return dbBinding;

    // 3. Fallback: scan all bindings for any that target this session
    const allBindings = getAllBindings(this.db);
    for (const b of allBindings) {
      if (b.target === sessionId) return b;
    }

    return null;
  }

  // ─── Session Update Handler ──────────────────────────────────────

  private handleSessionUpdate(session: SessionSummary, previousId?: string): void {
    if (previousId) {
      // Sync in-memory tracking
      const lastSender = this.lastSenderBySession.get(previousId);
      if (lastSender) {
        this.lastSenderBySession.delete(previousId);
        this.lastSenderBySession.set(session.id, lastSender);
      }

      // Sync stream states
      const streamState = this.streamStates.get(previousId);
      if (streamState) {
        this.streamStates.delete(previousId);
      }

      // Sync DB bindings
      const bindings = getAllBindingsBySession(this.db, previousId);
      for (const binding of bindings) {
        updateBindingActiveSession(this.db, binding.identity_key, session.id);
        if (binding.target === previousId) {
          upsertBinding(this.db, { ...binding, target: session.id, active_session_id: session.id, last_active_at: Date.now() });
        }
        console.log(`[ChannelRouter] Binding session ID synced: ${previousId} → ${session.id} for ${binding.identity_key}`);
      }
    }

    // When a session enters error/stopped state, keep binding intact and send retry button
    if (session.status === 'error' || session.status === 'stopped') {
      const bindings = getAllBindingsBySession(this.db, session.id);
      for (const binding of bindings) {
        const provider = this.providers.get(`${binding.channel_name}:${binding.account_id}`);
        if (provider) {
          console.log(`[ChannelRouter] Session ${session.id} → ${session.status}, sending retry button to ${binding.identity_key}`);
          provider.sendMessage({
            identity: { channelName: binding.channel_name, accountId: binding.account_id, peerId: binding.peer_id },
            text: `⚠️ 会话异常 (${session.status})，任务可能已中断。`,
            kind: 'message',
            actions: [{ label: '🔄 重试/继续', callbackData: `resume:${session.id}` }],
          }).catch(() => {});
        }
      }
    }
  }

  /** Called when SessionManager.destroySession() runs */
  handleSessionDestroyed(sessionId: string): void {
    const bindings = getAllBindingsBySession(this.db, sessionId);
    if (bindings.length === 0) return;

    resetBindingTargetBySession(this.db, sessionId);
    this.lastSenderBySession.delete(sessionId);
    this.messageOriginBySession.delete(sessionId);

    for (const binding of bindings) {
      const provider = this.providers.get(`${binding.channel_name}:${binding.account_id}`);
      if (provider) {
        provider.sendMessage({
          identity: {
            channelName: binding.channel_name,
            accountId: binding.account_id,
            peerId: binding.peer_id,
          },
          text: `⚠️ 会话已被销毁，已切换回 Lobby Manager。`,
          kind: 'message',
        }).catch((err) => console.error('[ChannelRouter] destroy notify error:', err));
      }
    }
  }

  // ─── Navigate Handler (Lobby Manager session jump) ───────────────────

  private handleNavigate(sessionId: string): void {
    const lmSessionId = this.lobbyManager?.getSessionId();
    if (!lmSessionId) return;

    const lastSenderKey = this.lastSenderBySession.get(lmSessionId);
    if (!lastSenderKey) return;

    const binding = getBinding(this.db, lastSenderKey);
    if (!binding || binding.target !== 'lobby-manager') return;

    // Check exclusivity for the target session
    const existing = getBindingBySession(this.db, sessionId);
    if (existing && existing.identity_key !== lastSenderKey) {
      const provider = this.providers.get(`${binding.channel_name}:${binding.account_id}`);
      if (provider) {
        provider.sendMessage({
          identity: { channelName: binding.channel_name, accountId: binding.account_id, peerId: binding.peer_id },
          text: `⚠️ 会话已被 ${existing.peer_display_name ?? existing.peer_id} 占用，无法切换。`,
          kind: 'message',
        }).catch(() => {});
      }
      return;
    }

    // Update binding to point to new session
    updateBindingActiveSession(this.db, lastSenderKey, sessionId);
    // IMPORTANT: set lastSender for BOTH old LM and new session
    this.lastSenderBySession.set(sessionId, lastSenderKey);
    // Keep LM mapping alive for any trailing messages
    // (don't delete lastSenderBySession for lmSessionId)

    const newSessionName = this.getSessionDisplayName(sessionId);
    const provider = this.providers.get(`${binding.channel_name}:${binding.account_id}`);
    if (provider) {
      provider.sendMessage({
        identity: { channelName: binding.channel_name, accountId: binding.account_id, peerId: binding.peer_id },
        text: `**【Lobby Manager】** 已切换到会话: **${newSessionName}**`,
        kind: 'message',
      }).catch(() => {});
    }

    // Sync command menu for navigated session
    this.syncCommandsToProvider(lastSenderKey, sessionId);
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /** Build layered command groups: OpenLobby built-in + current adapter commands */
  private buildCommandGroups(sessionId: string): CommandGroup[] {
    const lobbyGroup: CommandGroup = {
      label: 'OpenLobby',
      commands: [
        { command: 'help',      description: '显示帮助' },
        { command: 'ls',        description: '列出所有会话' },
        { command: 'goto',      description: '切换会话' },
        { command: 'add',       description: '创建新会话' },
        { command: 'rm',        description: '销毁会话' },
        { command: 'stop',      description: '打断模型回复' },
        { command: 'new',       description: '重建 CLI 会话' },
        { command: 'bind',      description: '绑定到会话' },
        { command: 'unbind',    description: '解绑当前会话' },
        { command: 'info',      description: '当前会话信息' },
        { command: 'msg_only',  description: '仅显示回复' },
        { command: 'msg_tidy',  description: '折叠工具调用' },
        { command: 'msg_total', description: '显示全部消息' },
        { command: 'exit',      description: '返回 Lobby Manager' },
        { command: 'compact',   description: '压缩上下文' },
        { command: 'cmd',       description: '显示命令菜单' },
      ],
    };

    const adapterCommands = this.sessionManager.getCachedCommands(sessionId);
    const info = this.sessionManager.getSessionInfo(sessionId);
    const adapterLabel = info?.adapterName ?? 'CLI';

    if (adapterCommands && adapterCommands.length > 0) {
      // Deduplicate: adapter commands that overlap with OpenLobby built-in
      // commands are excluded to prevent Telegram setMyCommands rejection
      const builtinNames = new Set(lobbyGroup.commands.map(c => c.command));
      const adapterGroup: CommandGroup = {
        label: adapterLabel,
        commands: adapterCommands
          .map(c => ({
            command: c.name.replace(/^\//, '').replace(/-/g, '_'),
            description: c.description ?? '',
          }))
          .filter(c => !builtinNames.has(c.command)),
      };
      if (adapterGroup.commands.length > 0) {
        return [lobbyGroup, adapterGroup];
      }
    }

    return [lobbyGroup];
  }

  /** Push current command groups to the IM provider for a specific identity */
  private syncCommandsToProvider(identityKey: string, sessionId: string): void {
    const binding = getBinding(this.db, identityKey);
    if (!binding) return;

    const provider = this.providers.get(`${binding.channel_name}:${binding.account_id}`);
    if (!provider?.syncCommands) return;

    const groups = this.buildCommandGroups(sessionId);
    provider.syncCommands(binding.peer_id, groups)
      .catch(err => console.error('[ChannelRouter] syncCommands error:', err));
  }

  private createDefaultBinding(identity: InboundChannelMessage['identity']): ChannelBindingRow {
    const identityKey = toIdentityKey(identity);
    const now = Date.now();
    const row: ChannelBindingRow = {
      identity_key: identityKey,
      channel_name: identity.channelName,
      account_id: identity.accountId,
      peer_id: identity.peerId,
      peer_display_name: identity.peerDisplayName ?? null,
      target: 'lobby-manager',
      active_session_id: null,
      created_at: now,
      last_active_at: now,
    };
    upsertBinding(this.db, row);
    console.log(`[ChannelRouter] Auto-created binding for ${identityKey} → lobby-manager`);

    // Send LM welcome message to new IM user
    const provider = this.providers.get(`${identity.channelName}:${identity.accountId}`);
    if (provider) {
      provider.sendMessage({
        identity,
        text: LM_WELCOME_TEXT,
        kind: 'message',
        format: 'markdown',
      }).catch((err) => console.error('[ChannelRouter] welcome message error:', err));
    }

    // Sync initial command menu for new IM user
    const lmSessionId = this.lobbyManager?.getSessionId();
    if (lmSessionId) {
      this.syncCommandsToProvider(identityKey, lmSessionId);
    }

    return row;
  }

  private resolveSessionId(binding: ChannelBindingRow): string | null {
    if (binding.target === 'lobby-manager') {
      return binding.active_session_id ?? this.lobbyManager?.getSessionId() ?? null;
    }
    return binding.active_session_id ?? binding.target;
  }

  /** Send one question from a pending AskUserQuestion sequence to IM */
  private sendQuestionToIM(
    identityKey: string,
    provider: ChannelProvider,
    identity: { channelName: string; accountId: string; peerId: string; peerDisplayName?: string },
    state: PendingQuestionState,
  ): void {
    const q = state.questions[state.currentIndex];
    const questionNum = state.questions.length > 1
      ? ` (${state.currentIndex + 1}/${state.questions.length})`
      : '';

    const optionLines = q.options.map((opt, i) => {
      const toggled = state.multiSelectToggled.has(i);
      const prefix = q.multiSelect ? (toggled ? '☑️' : '⬜') : `${i + 1}️⃣`;
      return `${prefix} **${opt.label}** — ${opt.description}`;
    }).join('\n');

    const header = `📋 **${q.header}**${questionNum}\n${q.question}`;
    const text = `${header}\n\n${optionLines}`;

    const actions = q.options.map((opt, i) => ({
      label: q.multiSelect
        ? `${state.multiSelectToggled.has(i) ? '☑' : '⬜'} ${opt.label}`
        : opt.label,
      callbackData: q.multiSelect
        ? `askt:${state.sessionId}:${state.requestId}:${state.currentIndex}:${i}`
        : `askq:${state.sessionId}:${state.requestId}:${state.currentIndex}:${i}`,
    }));

    // For multi-select, add a confirm button
    if (q.multiSelect && state.multiSelectToggled.size > 0) {
      actions.push({
        label: '✅ 确认',
        callbackData: `askc:${state.sessionId}:${state.requestId}:${state.currentIndex}`,
      });
    }

    provider.sendMessage({
      identity,
      text,
      kind: 'approval',
      actions,
    }).catch((err) => console.error('[ChannelRouter] question send error:', err));
  }

  /** Advance to next question or submit all answers */
  private advanceQuestion(
    identityKey: string,
    identity: { channelName: string; accountId: string; peerId: string; peerDisplayName?: string },
    state: PendingQuestionState,
  ): void {
    state.currentIndex++;

    if (state.currentIndex >= state.questions.length) {
      // All questions answered — submit
      this.pendingQuestions.delete(identityKey);
      console.log(`[ChannelRouter] AskUserQuestion complete for ${identityKey}:`, state.answers);
      try {
        this.sessionManager.respondControl(state.sessionId, state.requestId, 'allow', { answers: state.answers });
      } catch (err) {
        console.error('[ChannelRouter] AskUserQuestion respondControl failed:', err);
        this.sendToChannel(identity, `⚠️ 提交回答失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // Send next question
      state.multiSelectToggled.clear();
      const provider = this.providers.get(`${identity.channelName}:${identity.accountId}`);
      if (provider) {
        this.sendQuestionToIM(identityKey, provider, identity, state);
      }
    }
  }

  private async handleCallback(callbackData: string, identity: InboundChannelMessage['identity']): Promise<void> {
    const identityKey = toIdentityKey(identity);
    const parts = callbackData.split(':');

    // ── Session resume callback ──
    if (parts[0] === 'resume') {
      const sessionId = parts[1];
      if (!sessionId) return;
      console.log(`[ChannelRouter] Resume callback for session ${sessionId} from ${identityKey}`);
      await this.handleInbound({
        identity: { channelName: identity.channelName, accountId: identity.accountId, peerId: identity.peerId },
        externalMessageId: `resume-${sessionId}-${Date.now()}`,
        text: '继续',
        timestamp: Date.now(),
      });
      return;
    }

    // ── AskUserQuestion callbacks ──
    if (parts[0] === 'askq' || parts[0] === 'askt' || parts[0] === 'askc') {
      const state = this.pendingQuestions.get(identityKey);
      if (!state) {
        await this.sendToChannel(identity, '⚠️ 该问答已过期。');
        return;
      }

      const [action, , , questionIndexStr, optionIndexStr] = parts;
      const questionIndex = parseInt(questionIndexStr, 10);
      const q = state.questions[questionIndex];

      if (action === 'askq') {
        // Single-select: record answer and advance
        const optionIndex = parseInt(optionIndexStr, 10);
        state.answers[String(questionIndex)] = q.options[optionIndex].label;
        await this.sendToChannel(identity, `✅ ${q.header}: **${q.options[optionIndex].label}**`);
        this.advanceQuestion(identityKey, identity, state);
      } else if (action === 'askt') {
        // Multi-select toggle
        const optionIndex = parseInt(optionIndexStr, 10);
        if (state.multiSelectToggled.has(optionIndex)) {
          state.multiSelectToggled.delete(optionIndex);
        } else {
          state.multiSelectToggled.add(optionIndex);
        }
        // Re-send the question with updated toggle state
        const provider = this.providers.get(`${identity.channelName}:${identity.accountId}`);
        if (provider) {
          this.sendQuestionToIM(identityKey, provider, identity, state);
        }
      } else if (action === 'askc') {
        // Multi-select confirm
        if (state.multiSelectToggled.size === 0) {
          await this.sendToChannel(identity, '⚠️ 请至少选择一个选项。');
          return;
        }
        const selectedLabels = Array.from(state.multiSelectToggled)
          .sort((a, b) => a - b)
          .map((i) => q.options[i].label);
        state.answers[String(questionIndex)] = selectedLabels.join(',');
        state.multiSelectToggled.clear();
        await this.sendToChannel(identity, `✅ ${q.header}: **${selectedLabels.join(', ')}**`);
        this.advanceQuestion(identityKey, identity, state);
      }
      return;
    }

    // ── Regular approve/deny callbacks ──
    // Format: "approve:sessionId:requestId:taskId" or "deny:sessionId:requestId:taskId"
    if (parts.length < 3) return;

    const [action, origSessionId, requestId, taskId] = parts;
    const decision = action === 'approve' ? 'allow' : 'deny';
    const resultText = decision === 'allow' ? '已允许 ✅' : '已拒绝 ❌';

    console.log(`[ChannelRouter] Callback: ${action} session=${origSessionId} request=${requestId} task=${taskId}`);

    try {
      let resolvedSessionId = origSessionId;
      try {
        this.sessionManager.respondControl(resolvedSessionId, requestId, decision as 'allow' | 'deny');
      } catch {
        const binding = getBinding(this.db, identityKey);
        if (binding?.active_session_id && binding.active_session_id !== origSessionId) {
          resolvedSessionId = binding.active_session_id;
          console.log(`[ChannelRouter] Retrying respondControl with synced sessionId: ${resolvedSessionId}`);
          this.sessionManager.respondControl(resolvedSessionId, requestId, decision as 'allow' | 'deny');
        } else {
          throw new Error(`Session "${origSessionId}" not found`);
        }
      }

      await this.sendToChannel(identity, resultText);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ChannelRouter] Callback failed:`, errMsg);
      await this.sendToChannel(identity, `⚠️ 审批失败: ${errMsg}`);
    }
  }

  private async sendToChannel(identity: InboundChannelMessage['identity'], text: string): Promise<void> {
    const provider = this.providers.get(`${identity.channelName}:${identity.accountId}`);
    if (!provider) return;
    await provider.sendMessage({ identity, text, kind: 'message' });
  }

  private getSessionDisplayName(sessionId: string): string {
    const info = this.sessionManager.getSessionInfo(sessionId);
    return info?.displayName ?? sessionId.slice(0, 8);
  }
}

// ─── Markdown Formatters ───────────────────────────────────────────

function formatAssistant(sessionName: string, text: string): string {
  return `**【${sessionName}】**\n${text}`;
}

function formatResult(sessionName: string, text: string, meta?: Record<string, unknown>): string {
  const tokenUsage = meta?.tokenUsage as { input: number; output: number } | undefined;
  const costUsd = meta?.costUsd as number | undefined;
  const parts = [`**【${sessionName}】** ✅ 完成`];
  if (text) parts.push(text);
  const stats: string[] = [];
  if (tokenUsage) stats.push(`tokens: ${tokenUsage.input + tokenUsage.output}`);
  if (costUsd != null) stats.push(`cost: $${costUsd.toFixed(4)}`);
  if (stats.length) parts.push(`> ${stats.join(' | ')}`);
  return parts.join('\n');
}

function formatToolUse(sessionName: string, toolName: string, input: string): string {
  const preview = input.length > 300 ? input.slice(0, 300) + '...' : input;
  return `**【${sessionName}】🔧 \`${toolName}\`**\n> ${preview.split('\n').join('\n> ')}`;
}

function formatToolResult(sessionName: string, toolName: string, output: string, isError: boolean): string {
  const icon = isError ? '❌' : '✅';
  const label = toolName ? `\`${toolName}\`` : '';
  const preview = output.length > 500 ? output.slice(0, 500) + '...' : output;
  return `**【${sessionName}】${icon} ${label}**\n> ${preview.split('\n').join('\n> ')}`;
}

function rowToBinding(row: ChannelBindingRow): ChannelBinding {
  return {
    identityKey: row.identity_key,
    channelName: row.channel_name,
    accountId: row.account_id,
    peerId: row.peer_id,
    peerDisplayName: row.peer_display_name ?? undefined,
    target: row.target as 'lobby-manager' | string,
    activeSessionId: row.active_session_id,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

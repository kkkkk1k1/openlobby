import type {
  ChannelProvider,
  ChannelRouter,
  ChannelBinding,
  ChannelProviderConfig,
  ChannelProviderInfo,
  InboundChannelMessage,
  LobbyMessage,
  SessionSummary,
} from '@openlobby/core';
import { toIdentityKey } from '@openlobby/core';
import type Database from 'better-sqlite3';
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

export class ChannelRouterImpl implements ChannelRouter {
  private providers = new Map<string, ChannelProvider>();

  /**
   * In-memory map: sessionId → identityKey of whoever last sent a message to this session.
   * Used to route responses back to the correct IM user.
   */
  private lastSenderBySession = new Map<string, string>();

  /** Per-identity stream buffer for think-tag typing */
  private streamStates = new Map<string, StreamState>();

  constructor(
    private sessionManager: SessionManager,
    private lobbyManager: LobbyManager | null,
    private db: Database.Database,
  ) {
    this.sessionManager.onMessage('channel-router', this.handleSessionMessage.bind(this));
    this.sessionManager.onSessionUpdate('channel-router', this.handleSessionUpdate.bind(this));
    this.sessionManager.onNavigate('channel-router', this.handleNavigate.bind(this));
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
        const provider = createProvider(config);
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
          const provider = createProvider(config);
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

    // /exit command: return to Lobby Manager
    if (msg.text.trim() === '/exit') {
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
      await this.sendToChannel(msg.identity, '✅ 已返回 Lobby Manager，请发送新指令。');
      return;
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
      await this.sessionManager.sendMessage(sessionId, msg.text);
      updateBindingActivity(this.db, identityKey);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[ChannelRouter] Failed to route inbound message:`, errMsg);
      // Clear think state on error
      this.streamStates.delete(identityKey);
      await this.sendToChannel(msg.identity, `⚠️ 消息发送失败: ${errMsg}`);
    }
  }

  // ─── Session Message → IM (with stream buffer + markdown formatting) ──

  private handleSessionMessage(sessionId: string, msg: LobbyMessage): void {
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

        // Store the full assistant text so result can include it
        const state = this.streamStates.get(identityKey);
        if (state) {
          state.buffer = text; // Replace delta buffer with final assembled text
        }

        // Send the actual reply content
        const formatted = formatAssistant(sessionName, text);
        this.finishStream(identityKey, provider, identity, formatted);
        break;
      }

      // ── result: session turn complete (token stats) ──
      // If assistant already sent the reply, result just has stats — send only if meaningful.
      // If assistant was never sent (no stream), use the accumulated buffer.
      case 'result': {
        const state = this.streamStates.get(identityKey);
        const bufferedText = state?.buffer ?? '';

        // If there's unsent buffered content (stream_delta accumulated but no assistant arrived),
        // send it now as the final reply
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

      // ── control: approval card ──
      case 'control': {
        const content = msg.content as Record<string, unknown>;
        const toolName = (content.toolName as string) ?? 'unknown';
        const toolInput = content.toolInput as Record<string, unknown> | undefined;
        const requestId = content.requestId as string;
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

    // When a session enters error/stopped state, reset bindings that point to it
    // so the user falls back to Lobby Manager on next message
    if (session.status === 'error' || session.status === 'stopped') {
      const bindings = getAllBindingsBySession(this.db, session.id);
      for (const binding of bindings) {
        // Only reset if this was a LM-routed binding (not a manually bound one)
        if (binding.target === 'lobby-manager') {
          updateBindingActiveSession(this.db, binding.identity_key, null);
          this.lastSenderBySession.delete(session.id);
          console.log(`[ChannelRouter] Reset binding ${binding.identity_key} (session ${session.id} → ${session.status})`);

          // Notify user
          const provider = this.providers.get(`${binding.channel_name}:${binding.account_id}`);
          if (provider) {
            provider.sendMessage({
              identity: { channelName: binding.channel_name, accountId: binding.account_id, peerId: binding.peer_id },
              text: `⚠️ 会话异常 (${session.status})，已切换回 Lobby Manager。`,
              kind: 'message',
            }).catch(() => {});
          }
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
  }

  // ─── Helpers ─────────────────────────────────────────────────────

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
    return row;
  }

  private resolveSessionId(binding: ChannelBindingRow): string | null {
    if (binding.target === 'lobby-manager') {
      return binding.active_session_id ?? this.lobbyManager?.getSessionId() ?? null;
    }
    return binding.active_session_id ?? binding.target;
  }

  private async handleCallback(callbackData: string, identity: InboundChannelMessage['identity']): Promise<void> {
    // Format: "approve:sessionId:requestId:taskId" or "deny:sessionId:requestId:taskId"
    const parts = callbackData.split(':');
    if (parts.length < 3) return;

    const [action, origSessionId, requestId, taskId] = parts;
    const decision = action === 'approve' ? 'allow' : 'deny';
    const resultText = decision === 'allow' ? '已允许 ✅' : '已拒绝 ❌';

    console.log(`[ChannelRouter] Callback: ${action} session=${origSessionId} request=${requestId} task=${taskId}`);

    try {
      // Try with the original sessionId first; if it fails (session ID may have
      // been synced to a new ID), fall back to the binding's active_session_id
      let resolvedSessionId = origSessionId;
      try {
        this.sessionManager.respondControl(resolvedSessionId, requestId, decision as 'allow' | 'deny');
      } catch {
        // Session ID might have changed — try the binding's current active session
        const identityKey = toIdentityKey(identity);
        const binding = getBinding(this.db, identityKey);
        if (binding?.active_session_id && binding.active_session_id !== origSessionId) {
          resolvedSessionId = binding.active_session_id;
          console.log(`[ChannelRouter] Retrying respondControl with synced sessionId: ${resolvedSessionId}`);
          this.sessionManager.respondControl(resolvedSessionId, requestId, decision as 'allow' | 'deny');
        } else {
          throw new Error(`Session "${origSessionId}" not found`);
        }
      }

      // Reply with result text
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

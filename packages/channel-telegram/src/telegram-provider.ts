import type {
  ChannelProvider,
  ChannelRouter,
  ChannelProviderConfig,
  OutboundChannelMessage,
} from '@openlobby/core';
import {
  TelegramBotApi,
  splitMessage,
  type TelegramUpdate,
  type TelegramMessage,
  type InlineKeyboardMarkup,
} from './telegram-api.js';

/** Message dedup TTL (5 minutes) */
const DEDUP_TTL_MS = 5 * 60 * 1000;
/** Long-polling timeout (seconds) */
const POLL_TIMEOUT = 30;
/** Delay after poll error before retry (ms) */
const ERROR_RETRY_DELAY_MS = 5_000;

/**
 * Telegram Bot Channel Provider for OpenLobby.
 *
 * Supports two modes:
 * - **Long Polling** (default): No external URL required, works behind NAT/firewalls.
 * - **Webhook**: Set `credentials.webhookUrl` and optionally `credentials.webhookSecret`.
 *
 * Required credentials:
 * - `botToken`: Telegram Bot API token from @BotFather
 *
 * Optional credentials:
 * - `webhookUrl`: External HTTPS URL for webhook mode
 * - `webhookSecret`: Secret token for webhook verification
 */
export class TelegramBotProvider implements ChannelProvider {
  readonly channelName = 'telegram';
  readonly accountId: string;

  private api: TelegramBotApi;
  private router: ChannelRouter | null = null;
  private healthy = false;
  private polling = false;
  private pollAbort: AbortController | null = null;

  /** Last processed update ID for long polling */
  private lastUpdateId = 0;
  /** Message dedup set: "chatId:messageId" → timestamp */
  private seenMessages = new Map<string, number>();
  /** Cleanup timer */
  private dedupTimer: ReturnType<typeof setInterval> | null = null;
  /** Typing action keep-alive timers: chatId (string) → timer */
  private typingTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Approval message ID cache: taskId → { chatId, messageId } for updateCard */
  private approvalMessageIds = new Map<string, { chatId: string; messageId: number }>();
  /**
   * Callback data shortener: Telegram limits callback_data to 64 bytes.
   * We map short keys (cb_xxxx, 7 chars) → original callbackData strings.
   */
  private callbackMap = new Map<string, string>();
  private callbackCounter = 0;

  /** Webhook config (if using webhook mode) */
  private webhookUrl?: string;
  private webhookSecret?: string;

  /** Recent debug logs (ring buffer) */
  debugLogs: string[] = [];
  private maxDebugLogs = 50;

  private log(level: 'info' | 'warn' | 'error', ...args: unknown[]) {
    const prefix = `[Telegram:${this.accountId}]`;
    const line = `${new Date().toISOString()} ${level} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
    this.debugLogs.push(line);
    if (this.debugLogs.length > this.maxDebugLogs) this.debugLogs.shift();
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  }

  constructor(config: ChannelProviderConfig) {
    this.accountId = config.accountId;
    const botToken = config.credentials.botToken;
    if (!botToken) {
      throw new Error('Telegram provider requires credentials.botToken');
    }
    this.api = new TelegramBotApi(botToken);
    this.webhookUrl = config.credentials.webhookUrl;
    this.webhookSecret = config.credentials.webhookSecret;
    this.log('info', 'Provider created', this.webhookUrl ? '(webhook mode)' : '(polling mode)');
  }

  async start(router: ChannelRouter): Promise<void> {
    this.router = router;
    this.log('info', 'Starting provider...');

    // Verify bot token by calling getMe
    try {
      const me = await this.api.getMe();
      this.log('info', `Bot authenticated: @${me.username} (${me.first_name})`);
      this.healthy = true;
    } catch (err) {
      this.log('error', 'Failed to authenticate bot:', err instanceof Error ? err.message : String(err));
      throw err;
    }

    if (this.webhookUrl) {
      // Webhook mode: register webhook with Telegram
      await this.api.setWebhook(this.webhookUrl, {
        secret_token: this.webhookSecret,
        allowed_updates: ['message', 'callback_query', 'edited_message'],
      });
      this.healthy = true;
      this.log('info', `Webhook set: ${this.webhookUrl}`);
    } else {
      // Long-polling mode: delete any existing webhook, then start polling
      await this.api.deleteWebhook();
      this.startPolling();
    }

    // Start dedup cleanup
    this.dedupTimer = setInterval(() => this.cleanupDedup(), 60_000);
    this.log('info', 'Provider started');
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.pollAbort?.abort();
    this.pollAbort = null;

    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
      this.dedupTimer = null;
    }

    // Clear all typing timers
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer);
    }
    this.typingTimers.clear();

    if (this.webhookUrl) {
      try {
        await this.api.deleteWebhook();
      } catch {
        // Best effort
      }
    }

    this.healthy = false;
    this.log('info', 'Provider stopped');
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ─── Send Message to Telegram ──────────────────────────────────

  async sendMessage(msg: OutboundChannelMessage): Promise<void> {
    const chatId = msg.identity.peerId;
    this.log('info', `sendMessage kind=${msg.kind ?? 'message'} to=${chatId} text=${msg.text.slice(0, 80)}...`);

    switch (msg.kind) {
      case 'typing': {
        await this.sendTypingAction(chatId);
        break;
      }

      case 'approval': {
        await this.sendApprovalCard(chatId, msg);
        break;
      }

      case 'message':
      default: {
        // Stop typing indicator for this chat
        this.stopTypingTimer(chatId);
        await this.sendTextMessage(chatId, msg.text, msg.format);
        break;
      }
    }
  }

  async updateCard(peerId: string, taskId: string, resultText: string): Promise<void> {
    // Look up the real chatId:messageId from our cache
    const cached = this.approvalMessageIds.get(taskId);
    if (!cached) {
      this.log('warn', `No cached message ID for taskId: ${taskId}`);
      return;
    }

    try {
      await this.api.editMessageText(cached.chatId, cached.messageId, resultText);
      this.approvalMessageIds.delete(taskId);
      this.log('info', `Card updated: ${taskId} → ${resultText}`);
    } catch (err) {
      this.log('error', 'updateCard error:', err);
    }
  }

  getWebhookHandlers() {
    if (!this.webhookUrl) return [];

    const webhookPath = `/webhook/telegram/${this.accountId}`;
    return [
      {
        method: 'POST' as const,
        path: webhookPath,
        handler: async (request: unknown, reply: unknown) => {
          const req = request as { headers: Record<string, string>; body: TelegramUpdate };
          const rep = reply as { status: (code: number) => { send: (body?: unknown) => void } };

          // Verify secret token if configured
          if (this.webhookSecret) {
            const token = req.headers['x-telegram-bot-api-secret-token'];
            if (token !== this.webhookSecret) {
              this.log('warn', 'Webhook secret mismatch');
              rep.status(403).send();
              return;
            }
          }

          try {
            await this.processUpdate(req.body);
          } catch (err) {
            this.log('error', 'Webhook processing error:', err);
          }

          rep.status(200).send({ ok: true });
        },
      },
    ];
  }

  // ─── Long Polling ──────────────────────────────────────────────

  private startPolling(): void {
    this.polling = true;
    this.pollLoop().catch((err) => {
      this.log('error', 'Poll loop exited with error:', err);
      this.healthy = false;
    });
  }

  private async pollLoop(): Promise<void> {
    this.log('info', 'Long polling started');

    while (this.polling) {
      try {
        const updates = await this.api.getUpdates(
          this.lastUpdateId > 0 ? this.lastUpdateId + 1 : undefined,
          POLL_TIMEOUT,
        );

        for (const update of updates) {
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
          try {
            await this.processUpdate(update);
          } catch (err) {
            this.log('error', 'Error processing update:', err);
          }
        }

        this.healthy = true;
      } catch (err) {
        if (!this.polling) break; // Stopped intentionally

        this.log('error', 'Polling error:', err instanceof Error ? err.message : String(err));
        this.healthy = false;

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, ERROR_RETRY_DELAY_MS));
      }
    }

    this.log('info', 'Long polling stopped');
  }

  // ─── Update Processing ─────────────────────────────────────────

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update.message ?? update.edited_message;
    if (!message) return;

    await this.handleMessage(message);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.router) return;

    const dedupKey = `${message.chat.id}:${message.message_id}`;
    if (this.isDuplicate(dedupKey)) {
      this.log('info', 'Duplicate message, skipping:', dedupKey);
      return;
    }

    const from = message.from;
    if (!from) return;

    // Skip messages from bots
    if (from.is_bot) return;

    const peerId = String(message.chat.id);
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ')
      || from.username
      || String(from.id);

    this.log('info', `Message from ${displayName} (${peerId}): "${(message.text ?? message.caption ?? '').slice(0, 80)}"`);

    // Build text content
    let text = message.text ?? message.caption ?? '';

    // Parse reply/quote context
    let quote: { text: string; senderId?: string; timestamp?: number } | undefined;
    if (message.reply_to_message) {
      const replied = message.reply_to_message;
      const repliedText = replied.text ?? replied.caption ?? '';
      if (repliedText) {
        quote = {
          text: repliedText,
          senderId: replied.from ? String(replied.from.id) : undefined,
          timestamp: replied.date * 1000,
        };
        // Prepend quote context for the agent
        text = `> ${repliedText.split('\n')[0]}\n\n${text}`;
      }
    }

    // Build attachments
    const attachments: Array<{
      type: 'image' | 'file' | 'voice';
      url?: string;
      filename?: string;
      mimeType?: string;
    }> = [];

    if (message.photo && message.photo.length > 0) {
      // Take the largest photo
      const largest = message.photo[message.photo.length - 1];
      const fileUrl = await this.getFileUrl(largest.file_id);
      if (fileUrl) {
        attachments.push({ type: 'image', url: fileUrl });
      }
      if (!text) text = '[图片]';
    }

    if (message.document) {
      const fileUrl = await this.getFileUrl(message.document.file_id);
      attachments.push({
        type: 'file',
        url: fileUrl ?? undefined,
        filename: message.document.file_name,
        mimeType: message.document.mime_type,
      });
      if (!text) text = `[文件: ${message.document.file_name ?? 'unknown'}]`;
    }

    if (message.voice) {
      const fileUrl = await this.getFileUrl(message.voice.file_id);
      attachments.push({
        type: 'voice',
        url: fileUrl ?? undefined,
        mimeType: message.voice.mime_type,
      });
      if (!text) text = '[语音消息]';
    }

    if (!text && attachments.length === 0) return;

    this.router.handleInbound({
      externalMessageId: String(message.message_id),
      identity: {
        channelName: 'telegram',
        accountId: this.accountId,
        peerId,
        peerDisplayName: displayName,
      },
      text,
      timestamp: message.date * 1000,
      attachments: attachments.length > 0 ? attachments : undefined,
      quote,
      raw: message,
    }).catch((err) => this.log('error', 'handleInbound error:', err));
  }

  private async handleCallbackQuery(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    if (!this.router) return;

    const from = query.from;
    const chatId = query.message?.chat.id;
    if (!chatId) return;

    const peerId = String(chatId);
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ')
      || from.username
      || String(from.id);

    this.log('info', `Callback query from ${displayName}: ${query.data}`);

    // Answer the callback query first (removes loading indicator)
    await this.api.answerCallbackQuery(query.id, { text: '处理中...' });

    if (query.data) {
      // Resolve possibly-shortened callback data back to original
      const resolvedData = this.resolveCallback(query.data);
      this.router.handleInbound({
        externalMessageId: query.id,
        identity: {
          channelName: 'telegram',
          accountId: this.accountId,
          peerId,
          peerDisplayName: displayName,
        },
        text: '',
        timestamp: Date.now(),
        callbackData: resolvedData,
        raw: query,
      }).catch((err) => this.log('error', 'callback handleInbound error:', err));
    }
  }

  // ─── Outbound Helpers ──────────────────────────────────────────

  private async sendTextMessage(
    chatId: string,
    text: string,
    format?: 'text' | 'markdown',
  ): Promise<void> {
    const chunks = splitMessage(text);

    for (const chunk of chunks) {
      try {
        // Try markdown first if requested
        if (format === 'markdown') {
          try {
            await this.api.sendMessage(chatId, chunk, {
              parse_mode: 'Markdown',
              disable_web_page_preview: true,
            });
            continue;
          } catch {
            // Markdown parsing failed, fall back to plain text
            this.log('warn', 'Markdown send failed, falling back to plain text');
          }
        }

        await this.api.sendMessage(chatId, chunk, {
          disable_web_page_preview: true,
        });
      } catch (err) {
        this.log('error', 'sendTextMessage error:', err);
      }
    }
  }

  private async sendApprovalCard(chatId: string, msg: OutboundChannelMessage): Promise<void> {
    const actions = msg.actions ?? [];

    // Build horizontal button rows (max 3 buttons per row)
    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    let currentRow: Array<{ text: string; callback_data: string }> = [];
    for (const action of actions) {
      const cbData = this.shortenCallback(action.callbackData);
      // Confirm button (✅) and Allow/Deny buttons go on their own row
      const isSpecial = action.callbackData.startsWith('askc:')
        || action.callbackData.startsWith('approve:')
        || action.callbackData.startsWith('deny:');
      if (isSpecial) {
        if (currentRow.length > 0) {
          rows.push(currentRow);
          currentRow = [];
        }
        rows.push([{ text: action.label, callback_data: cbData }]);
      } else {
        currentRow.push({ text: action.label, callback_data: cbData });
        if (currentRow.length >= 3) {
          rows.push(currentRow);
          currentRow = [];
        }
      }
    }
    if (currentRow.length > 0) {
      rows.push(currentRow);
    }

    const buttons: InlineKeyboardMarkup = { inline_keyboard: rows };

    try {
      const sent = await this.api.sendMessage(chatId, msg.text, {
        reply_markup: buttons,
        disable_web_page_preview: true,
      });
      this.log('info', `Approval card sent: message_id=${sent.message_id}`);

      // Cache message ID for updateCard — extract taskId from callback data
      for (const action of actions) {
        const parts = action.callbackData.split(':');
        // approve:sessionId:requestId:taskId or deny:...
        if ((parts[0] === 'approve' || parts[0] === 'deny') && parts.length >= 4) {
          const taskId = parts[3];
          this.approvalMessageIds.set(taskId, { chatId, messageId: sent.message_id });
          // Auto-cleanup after 5 minutes
          setTimeout(() => this.approvalMessageIds.delete(taskId), DEDUP_TTL_MS);
          break;
        }
      }
    } catch (err) {
      this.log('error', 'sendApprovalCard error:', err);
      // Fallback: send as plain text
      await this.sendTextMessage(chatId, msg.text);
    }
  }

  private async sendTypingAction(chatId: string): Promise<void> {
    const key = String(chatId);
    try {
      await this.api.sendChatAction(chatId, 'typing');

      // Set up a recurring typing action (Telegram typing indicator lasts ~5 seconds)
      if (!this.typingTimers.has(key)) {
        const timer = setInterval(async () => {
          try {
            await this.api.sendChatAction(chatId, 'typing');
          } catch {
            // Ignore errors for typing action
          }
        }, 4_000);
        this.typingTimers.set(key, timer);
      }
    } catch (err) {
      this.log('error', 'sendTypingAction error:', err);
    }
  }

  private stopTypingTimer(chatId: string | number): void {
    const key = String(chatId);
    const timer = this.typingTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.typingTimers.delete(key);
    }
  }

  private async getFileUrl(fileId: string): Promise<string | null> {
    try {
      const file = await this.api.getFile(fileId);
      if (file.file_path) {
        return this.api.getFileUrl(file.file_path);
      }
    } catch (err) {
      this.log('error', 'getFile error:', err);
    }
    return null;
  }

  // ─── Callback Data Shortener (Telegram 64-byte limit) ────────

  /** Shorten a callbackData string to fit Telegram's 64-byte limit */
  private shortenCallback(data: string): string {
    if (data.length <= 64) return data;
    const key = `cb_${(this.callbackCounter++).toString(36)}`;
    this.callbackMap.set(key, data);
    // Auto-cleanup after 10 minutes
    setTimeout(() => this.callbackMap.delete(key), 10 * 60 * 1000);
    return key;
  }

  /** Resolve a possibly-shortened callback key back to original data */
  private resolveCallback(data: string): string {
    return this.callbackMap.get(data) ?? data;
  }

  // ─── Dedup ─────────────────────────────────────────────────────

  private isDuplicate(key: string): boolean {
    if (this.seenMessages.has(key)) return true;
    this.seenMessages.set(key, Date.now());
    return false;
  }

  private cleanupDedup(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [key, ts] of this.seenMessages) {
      if (ts < cutoff) this.seenMessages.delete(key);
    }
  }
}

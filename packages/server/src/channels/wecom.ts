import { WSClient, generateReqId, decryptFile } from '@wecom/aibot-node-sdk';
import type { WsFrameHeaders } from '@wecom/aibot-node-sdk';
import type {
  ChannelProvider,
  ChannelRouter,
  ChannelProviderConfig,
  OutboundChannelMessage,
  CommandGroup,
} from '@openlobby/core';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Max text length for WeCom stream reply (20480 bytes) */
const MAX_REPLY_BYTES = 20_000;
/** Message dedup TTL (5 minutes) */
const DEDUP_TTL_MS = 5 * 60 * 1000;

interface PendingReply {
  frame: WsFrameHeaders;
  streamId: string;
}

export class WeComBotProvider implements ChannelProvider {
  readonly channelName = 'wecom';
  readonly accountId: string;

  private client: WSClient;
  private router: ChannelRouter | null = null;
  private healthy = false;

  /** Map peerId → pending reply context (frame + streamId) for ws-based replies */
  private pendingReplies = new Map<string, PendingReply>();
  /** Message dedup set: msgid → timestamp */
  private seenMessages = new Map<string, number>();
  /** Cleanup timer */
  private dedupTimer: ReturnType<typeof setInterval> | null = null;
  /** Health check timer */
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** Consecutive reconnect attempts (for backoff) */
  private reconnectAttempts = 0;

  /** Cached command groups by peerId */
  private cachedCommandGroups = new Map<string, CommandGroup[]>();

  /** Recent debug logs (ring buffer) */
  debugLogs: string[] = [];
  private maxDebugLogs = 50;

  private log(level: 'info' | 'warn' | 'error', ...args: unknown[]) {
    const prefix = `[WeCom:${this.accountId}]`;
    const line = `${new Date().toISOString()} ${level} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`;
    this.debugLogs.push(line);
    if (this.debugLogs.length > this.maxDebugLogs) this.debugLogs.shift();
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
  }

  constructor(config: ChannelProviderConfig) {
    this.accountId = config.accountId;
    this.log('info', 'Creating WSClient with botId:', config.credentials.botId);
    this.client = new WSClient({
      botId: config.credentials.botId,
      secret: config.credentials.secret,
      maxReconnectAttempts: -1, // infinite reconnect
    });
  }

  async start(router: ChannelRouter): Promise<void> {
    this.router = router;
    this.log('info', 'Starting provider...');

    // Connection lifecycle events
    this.client.on('connected', () => {
      this.log('info', 'WebSocket connected, waiting for authentication...');
    });

    this.client.on('authenticated', () => {
      this.healthy = true;
      this.reconnectAttempts = 0;
      this.log('info', 'Authenticated successfully! Ready to receive messages.');
    });

    this.client.on('disconnected', (reason) => {
      this.healthy = false;
      this.log('warn', 'Disconnected:', reason);
    });

    this.client.on('reconnecting', (attempt) => {
      this.log('info', `Reconnecting (attempt ${attempt})...`);
    });

    this.client.on('error', (err) => {
      this.log('error', 'SDK error:', err.message);
    });

    // Listen for ALL messages first (for debugging)
    this.client.on('message', (frame) => {
      this.log('info', 'Received message:', frame.body?.msgtype, 'from:', frame.body?.from?.userid, 'msgid:', frame.body?.msgid);
    });

    // Text messages
    this.client.on('message.text', (frame) => {
      this.log('info', 'Text message handler fired');
      if (!frame.body) {
        this.log('warn', 'Text message has no body');
        return;
      }
      const body = frame.body;
      if (this.isDuplicate(body.msgid)) {
        this.log('info', 'Duplicate message, skipping:', body.msgid);
        return;
      }

      const peerId = body.from.userid;
      this.log('info', `Text from ${peerId}: "${body.text.content}"`);

      // Store frame for reply context
      this.pendingReplies.set(peerId, {
        frame: { headers: frame.headers },
        streamId: generateReqId('stream'),
      });

      // Detect quote/reply message
      const quote = parseQuoteMessage(body);
      const messageText = quote
        ? `> ${quote.text}\n\n${body.text.content}`
        : body.text.content;

      router.handleInbound({
        externalMessageId: body.msgid,
        identity: {
          channelName: 'wecom',
          accountId: this.accountId,
          peerId,
        },
        text: messageText,
        timestamp: (body.create_time ?? Date.now() / 1000) * 1000,
        quote: quote ?? undefined,
        raw: frame,
      }).catch((err) => this.log('error', 'handleInbound error:', err));
    });

    // Voice messages (use transcription)
    this.client.on('message.voice', (frame) => {
      if (!frame.body) return;
      const body = frame.body;
      if (this.isDuplicate(body.msgid)) return;

      const peerId = body.from.userid;
      this.log('info', `Voice from ${peerId}: "${body.voice.content}"`);

      this.pendingReplies.set(peerId, {
        frame: { headers: frame.headers },
        streamId: generateReqId('stream'),
      });

      router.handleInbound({
        externalMessageId: body.msgid,
        identity: {
          channelName: 'wecom',
          accountId: this.accountId,
          peerId,
        },
        text: body.voice.content || '[语音消息]',
        timestamp: (body.create_time ?? Date.now() / 1000) * 1000,
        raw: frame,
      }).catch((err) => this.log('error', 'voice handleInbound error:', err));
    });

    // Image messages
    this.client.on('message.image', async (frame) => {
      if (!frame.body) return;
      const body = frame.body;
      if (this.isDuplicate(body.msgid)) return;

      const peerId = body.from.userid;
      this.log('info', `Image from ${peerId}`);

      this.pendingReplies.set(peerId, {
        frame: { headers: frame.headers },
        streamId: generateReqId('stream'),
      });

      // Download and decrypt image to local file
      const imageUrl = body.image?.url;
      const aeskey = body.image?.aeskey;
      let attachments: Array<{ type: 'image'; path?: string; url?: string }> | undefined;
      if (imageUrl) {
        const localPath = await this.downloadAndDecrypt(imageUrl, aeskey, '.jpg');
        attachments = localPath
          ? [{ type: 'image', path: localPath }]
          : [{ type: 'image', url: imageUrl }];
      }

      router.handleInbound({
        externalMessageId: body.msgid,
        identity: {
          channelName: 'wecom',
          accountId: this.accountId,
          peerId,
        },
        text: '[图片]',
        timestamp: (body.create_time ?? Date.now() / 1000) * 1000,
        attachments,
        raw: frame,
      }).catch((err) => this.log('error', 'image handleInbound error:', err));
    });

    // Mixed content messages (图文混排)
    this.client.on('message.mixed', async (frame) => {
      if (!frame.body) return;
      const body = frame.body;
      if (this.isDuplicate(body.msgid)) return;

      const peerId = body.from.userid;
      this.log('info', `Mixed message from ${peerId}`);

      this.pendingReplies.set(peerId, {
        frame: { headers: frame.headers },
        streamId: generateReqId('stream'),
      });

      const { text, rawAttachments } = parseMixedContent(body);

      // Download and decrypt mixed content images
      const attachments: Array<{ type: 'image' | 'file'; path?: string; url?: string; filename?: string }> = [];
      for (const a of rawAttachments) {
        if (a.url && a.aeskey) {
          const ext = a.type === 'image' ? '.jpg' : (a.filename?.includes('.') ? a.filename.substring(a.filename.lastIndexOf('.')) : '.bin');
          const localPath = await this.downloadAndDecrypt(a.url, a.aeskey, ext);
          if (localPath) {
            attachments.push({ type: a.type, path: localPath, filename: a.filename });
            continue;
          }
        }
        attachments.push({ type: a.type, url: a.url, filename: a.filename });
      }

      router.handleInbound({
        externalMessageId: body.msgid,
        identity: {
          channelName: 'wecom',
          accountId: this.accountId,
          peerId,
        },
        text: text || '[图文消息]',
        timestamp: (body.create_time ?? Date.now() / 1000) * 1000,
        attachments: attachments.length > 0 ? attachments : undefined,
        raw: frame,
      }).catch((err) => this.log('error', 'mixed handleInbound error:', err));
    });

    // Template card events (inline approval callbacks)
    this.client.on('event.template_card_event', (frame) => {
      if (!frame.body) return;
      const body = frame.body as Record<string, any>;
      this.log('info', `Card event raw body: ${JSON.stringify(body).slice(0, 800)}`);

      // WeCom nests card data in body.event.template_card_event
      const event = body.event ?? {};
      const cardEvent = event.template_card_event ?? event;
      const eventKey: string | undefined = cardEvent.event_key ?? event.event_key;
      const taskId: string | undefined = cardEvent.task_id ?? event.task_id;
      const peerId: string = body.from?.userid;

      this.log('info', `Card event parsed: peerId=${peerId} key=${eventKey} task=${taskId}`);

      if (eventKey && peerId) {
        if (taskId) {
          this.pendingReplies.set(`card:${peerId}:${taskId}`, {
            frame: { headers: frame.headers },
            streamId: '',
          });
        }

        router.handleInbound({
          externalMessageId: body.msgid ?? '',
          identity: {
            channelName: 'wecom',
            accountId: this.accountId,
            peerId,
          },
          text: '',
          timestamp: (body.create_time ?? Date.now() / 1000) * 1000,
          callbackData: eventKey,
          raw: frame,
        }).catch((err) => this.log('error', 'card event error:', err));
      } else {
        this.log('warn', 'Card event missing event_key or peerId, ignoring');
      }
    });

    // Also listen for all events (debugging)
    this.client.on('event', (frame) => {
      this.log('info', 'Event received:', frame.body?.event?.eventtype);
    });

    // Start connection
    this.client.connect();

    // Start dedup cleanup
    this.dedupTimer = setInterval(() => this.cleanupDedup(), 60_000);

    // Start periodic health check for auto-reconnect
    this.healthCheckTimer = setInterval(() => this.healthCheck(), 30_000);

    this.log('info', 'Provider started, connecting to WeCom...');
  }

  async stop(): Promise<void> {
    if (this.dedupTimer) {
      clearInterval(this.dedupTimer);
      this.dedupTimer = null;
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    this.client.disconnect();
    this.healthy = false;
    this.pendingReplies.clear();
    this.log('info', 'Provider stopped');
  }

  isHealthy(): boolean {
    return this.healthy && this.client.isConnected;
  }

  async updateCard(peerId: string, taskId: string, resultText: string): Promise<void> {
    const key = `card:${peerId}:${taskId}`;
    const pending = this.pendingReplies.get(key);
    if (!pending) {
      this.log('warn', `No pending card frame for ${key}`);
      return;
    }

    try {
      await this.client.updateTemplateCard(pending.frame, {
        card_type: 'text_notice',
        main_title: { title: resultText },
        task_id: taskId,
      });
      this.log('info', `Card updated: ${taskId} → ${resultText}`);
    } catch (err) {
      this.log('error', 'updateCard error:', err);
    }
    this.pendingReplies.delete(key);
  }

  async syncCommands(peerId: string, groups: CommandGroup[]): Promise<void> {
    this.cachedCommandGroups.set(peerId, groups);
    this.log('info', `Cached ${groups.length} command groups for ${peerId}`);
  }

  async sendCommandMenu(peerId: string): Promise<void> {
    const groups = this.cachedCommandGroups.get(peerId);
    if (!groups || groups.length === 0) {
      await this.client.sendMessage(peerId, {
        msgtype: 'markdown',
        markdown: { content: '⚠️ 暂无可用命令。' },
      });
      return;
    }

    // Build markdown text with grouped commands
    const lines: string[] = ['📋 **命令菜单**', ''];
    for (const group of groups) {
      lines.push(`**${group.label}**`);
      for (const cmd of group.commands) {
        lines.push(`\`/${cmd.command}\` — ${cmd.description}`);
      }
      lines.push('');
    }

    // Build button list from all commands (WeCom template_card supports up to 6 buttons)
    // Pick the most useful commands as buttons, rest stay in text
    const allCommands = groups.flatMap(g => g.commands);
    const buttonCommands = allCommands.slice(0, 6);
    const taskId = `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      await this.client.sendMessage(peerId, {
        msgtype: 'template_card',
        template_card: {
          card_type: 'button_interaction',
          main_title: { title: '📋 命令菜单' },
          sub_title_text: lines.join('\n'),
          button_list: buttonCommands.map((c, i) => ({
            text: `/${c.command}`,
            style: i === 0 ? 1 : 2,
            key: `cmd:/${c.command}`,
          })),
          task_id: taskId,
        },
      });
      this.log('info', `Sent command menu card to ${peerId}`);
    } catch (err) {
      this.log('error', 'sendCommandMenu error:', err);
      // Fallback to plain markdown
      await this.client.sendMessage(peerId, {
        msgtype: 'markdown',
        markdown: { content: lines.join('\n') },
      });
    }
  }

  async sendMessage(msg: OutboundChannelMessage): Promise<void> {
    const peerId = msg.identity.peerId;
    this.log('info', `sendMessage kind=${msg.kind ?? 'message'} to=${peerId} text=${msg.text.slice(0, 80)}...`);

    switch (msg.kind) {
      case 'typing': {
        const pending = this.pendingReplies.get(peerId);
        if (pending) {
          try {
            await this.client.replyStream(
              pending.frame,
              pending.streamId,
              msg.text,
              false,
            );
          } catch (err) {
            this.log('error', 'typing stream error:', err);
          }
        } else {
          this.log('warn', 'No pending frame for typing, skipping');
        }
        break;
      }

      case 'approval': {
        // Extract taskId from the first action's callbackData (format: action:sessionId:requestId:taskId)
        const firstAction = msg.actions?.[0]?.callbackData ?? '';
        const taskId = firstAction.split(':')[3] || `approval_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
        const buttons = (msg.actions ?? []).map((a, i) => ({
          text: a.label,
          style: i === 0 ? 1 : 2,
          key: a.callbackData,
        }));

        const pending = this.pendingReplies.get(peerId);
        if (pending) {
          try {
            await this.client.replyTemplateCard(pending.frame, {
              card_type: 'button_interaction',
              main_title: { title: '工具调用审批' },
              sub_title_text: msg.text,
              button_list: buttons,
              task_id: taskId,
            });
            this.pendingReplies.delete(peerId);
          } catch (err) {
            this.log('error', 'approval card reply error:', err);
            await this.sendViaApi(peerId, msg);
          }
        } else {
          await this.sendViaApi(peerId, msg);
        }
        break;
      }

      case 'message':
      default: {
        // Parse media directives (MEDIA:<path>, FILE:<path>)
        const { cleanText: messageText, mediaPaths } = parseMediaDirectives(msg.text);
        if (mediaPaths.length > 0) {
          this.log('info', `Found ${mediaPaths.length} media directive(s), paths: ${mediaPaths.map(m => m.path).join(', ')}`);
        }
        const effectiveText = messageText || msg.text;

        const pending = this.pendingReplies.get(peerId);
        if (pending) {
          try {
            const chunks = splitText(effectiveText, MAX_REPLY_BYTES);
            for (let i = 0; i < chunks.length; i++) {
              const isLast = i === chunks.length - 1;
              await this.client.replyStream(pending.frame, pending.streamId, chunks[i], isLast);
            }
            // Regenerate streamId so subsequent typing can start a new stream
            // (keep the frame alive for follow-up think messages)
            pending.streamId = generateReqId('stream');
            this.log('info', 'Reply sent via stream, new streamId ready');
          } catch (err) {
            this.log('error', 'stream reply error, falling back to sendMessage API:', err);
            this.pendingReplies.delete(peerId);
            await this.sendViaApi(peerId, msg);
          }
        } else {
          this.log('info', 'No pending frame, using sendMessage API');
          await this.sendViaApi(peerId, msg);
        }
        break;
      }
    }
  }

  /** Proactive send via WeCom API (sendMessage) */
  private async sendViaApi(peerId: string, msg: OutboundChannelMessage): Promise<void> {
    try {
      const chunks = splitText(msg.text, MAX_REPLY_BYTES);
      for (const chunk of chunks) {
        if (msg.kind === 'approval' && msg.actions?.length) {
          const firstAction = msg.actions[0].callbackData;
          const taskId = firstAction.split(':')[3] || `approval_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
          await this.client.sendMessage(peerId, {
            msgtype: 'template_card',
            template_card: {
              card_type: 'button_interaction',
              main_title: { title: '工具调用审批' },
              sub_title_text: chunk,
              button_list: msg.actions.map((a, i) => ({
                text: a.label,
                style: i === 0 ? 1 : 2,
                key: a.callbackData,
              })),
              task_id: taskId,
            },
          });
        } else {
          await this.client.sendMessage(peerId, {
            msgtype: 'markdown',
            markdown: { content: chunk },
          });
        }
      }
      this.log('info', 'Message sent via API');
    } catch (err) {
      this.log('error', 'sendViaApi failed:', err);
    }
  }

  getWebhookHandlers() {
    return [];
  }

  private healthCheck(): void {
    if (this.healthy && this.client.isConnected) {
      this.reconnectAttempts = 0;
      return;
    }

    this.reconnectAttempts++;
    // Exponential backoff: skip this check if not enough intervals have passed
    // backoff intervals: 1, 2, 4, 8... (capped at 10 = ~5min at 30s interval)
    const backoffMultiplier = Math.min(Math.pow(2, this.reconnectAttempts - 1), 10);
    if (this.reconnectAttempts > 1 && this.reconnectAttempts % backoffMultiplier !== 0) {
      return;
    }

    this.log('info', `Health check: unhealthy (attempt ${this.reconnectAttempts}), attempting reconnect...`);
    try {
      this.client.connect();
    } catch (err) {
      this.log('error', 'Reconnect failed:', err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Download encrypted media from WeCom URL and decrypt with aeskey.
   * Saves to a temp directory and returns the local file path.
   */
  private async downloadAndDecrypt(
    url: string,
    aeskey: string | undefined,
    ext: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rawArrayBuffer = await res.arrayBuffer();
      let buffer: Buffer = Buffer.from(new Uint8Array(rawArrayBuffer));

      // Decrypt if aeskey is provided (WeCom WebSocket mode returns encrypted media)
      if (aeskey) {
        buffer = decryptFile(buffer, aeskey) as Buffer;
      }

      // Detect actual file type from magic bytes if ext is generic
      if (ext === '.bin' || ext === '.dat') {
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) ext = '.jpg';
        else if (buffer[0] === 0x89 && buffer[1] === 0x50) ext = '.png';
        else if (buffer[0] === 0x47 && buffer[1] === 0x49) ext = '.gif';
        else if (buffer[0] === 0x25 && buffer[1] === 0x50) ext = '.pdf';
      }

      const cacheDir = join(tmpdir(), 'openlobby-media');
      mkdirSync(cacheDir, { recursive: true });
      const filename = `${randomUUID()}${ext}`;
      const filePath = join(cacheDir, filename);
      writeFileSync(filePath, buffer);
      this.log('info', `Media saved: ${filePath} (${buffer.length} bytes)`);
      return filePath;
    } catch (err) {
      this.log('error', 'downloadAndDecrypt error:', err);
      return null;
    }
  }

  private isDuplicate(msgId: string): boolean {
    if (this.seenMessages.has(msgId)) return true;
    this.seenMessages.set(msgId, Date.now());
    return false;
  }

  private cleanupDedup(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [key, ts] of this.seenMessages) {
      if (ts < cutoff) this.seenMessages.delete(key);
    }
  }
}

/** Parse mixed content message into text + raw attachments (with aeskey for decryption) */
function parseMixedContent(body: Record<string, any>): {
  text: string;
  rawAttachments: Array<{ type: 'image' | 'file'; url?: string; aeskey?: string; filename?: string }>;
} {
  const textParts: string[] = [];
  const rawAttachments: Array<{ type: 'image' | 'file'; url?: string; aeskey?: string; filename?: string }> = [];

  // WeCom SDK mixed messages: body.mixed.msg_item[] or legacy body.mixed.items[]
  const items: any[] = body.mixed?.msg_item ?? body.mixed?.items ?? body.content?.items ?? [];
  for (const item of items) {
    const msgtype = item.msgtype ?? item.type;
    if (msgtype === 'text' && (item.text?.content || item.content)) {
      textParts.push(item.text?.content ?? item.content);
    } else if (msgtype === 'image') {
      const img = item.image ?? item;
      const url = img.url ?? img.media_id;
      if (url) rawAttachments.push({ type: 'image', url, aeskey: img.aeskey });
    } else if (msgtype === 'file') {
      const file = item.file ?? item;
      rawAttachments.push({
        type: 'file',
        url: file.url ?? file.media_id,
        aeskey: file.aeskey,
        filename: file.filename ?? file.file_name,
      });
    }
  }

  return { text: textParts.join('\n'), rawAttachments };
}

/** Extract quote/reply context from a WeCom text message */
function parseQuoteMessage(body: Record<string, any>): {
  text: string;
  senderId?: string;
  timestamp?: number;
} | null {
  // WeCom quote messages include a quote field in the body
  const quote = body.text?.quote ?? body.quote;
  if (!quote) return null;

  return {
    text: typeof quote === 'string' ? quote : (quote.content ?? quote.text ?? ''),
    senderId: quote.from?.userid,
    timestamp: quote.create_time ? quote.create_time * 1000 : undefined,
  };
}

/** Parse MEDIA: and FILE: directives from outbound text */
function parseMediaDirectives(text: string): {
  cleanText: string;
  mediaPaths: Array<{ type: 'media' | 'file'; path: string }>;
} {
  const mediaPaths: Array<{ type: 'media' | 'file'; path: string }> = [];
  const cleanText = text.replace(/(?:MEDIA|FILE):(\S+)/g, (match, path) => {
    mediaPaths.push({
      type: match.startsWith('FILE') ? 'file' : 'media',
      path,
    });
    return '';
  }).trim();
  return { cleanText, mediaPaths };
}

/** Split text into chunks that fit within byte limit */
function splitText(text: string, maxBytes: number): string[] {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.byteLength <= maxBytes) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = text.length;
    while (encoder.encode(text.slice(start, end)).byteLength > maxBytes) {
      end = Math.floor((start + end) / 2);
    }
    while (end < text.length && encoder.encode(text.slice(start, end + 1)).byteLength <= maxBytes) {
      end++;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

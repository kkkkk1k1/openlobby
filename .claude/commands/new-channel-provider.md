---
name: new-channel-provider
description: Generate a complete OpenLobby IM channel provider package for a new messaging platform. Triggered when the user asks to add, integrate, or support a new IM channel (e.g. Slack, Discord, Feishu, LINE, WhatsApp). Produces a pluggable channel package following the ChannelPluginModule contract.
---

# New Channel Provider Generator

Generate a complete, pluggable OpenLobby IM channel provider package for a new messaging platform. Follow every phase in order. Do NOT skip or reorder phases.

---

## Phase 1: Research the Target IM Platform

Before writing any code, investigate the target messaging platform thoroughly:

1. **Bot API type** — What kind of API does the platform expose for bots?
   - REST API (most common: Telegram, Slack, Discord)
   - WebSocket (Discord Gateway, WeCom)
   - SDK (official Node.js SDK available?)
   - Webhook-only (WhatsApp Business API)

2. **Authentication** — How does the bot authenticate?
   - Bot token (single token, e.g. Telegram, Slack)
   - App ID + App Secret (e.g. Feishu, WeCom)
   - OAuth 2.0 flow (Slack, Discord)
   - Verify token / signing secret for webhook validation

3. **Message receiving** — How does the bot receive incoming messages?
   - Long polling (Telegram getUpdates)
   - Webhooks (Slack Events API, Feishu, WhatsApp)
   - WebSocket / Gateway (Discord, WeCom)

4. **Message sending** — How does the bot send messages?
   - REST POST (Telegram sendMessage, Slack chat.postMessage)
   - WebSocket frame (WeCom stream reply)
   - SDK method

5. **Message format** — What formatting is supported?
   - Plain text
   - Markdown (Telegram MarkdownV2, Slack mrkdwn, Discord Markdown)
   - Rich cards / blocks (Slack Block Kit, Feishu Interactive Cards)
   - Inline buttons / action components

6. **Callback / interaction** — How are button clicks and interactions handled?
   - Inline button callbacks (Telegram callback_query, Slack block_actions)
   - Reactions
   - Thread replies
   - Slash commands

7. **Media support** — What media types can be sent/received?
   - Images
   - Files / documents
   - Voice messages
   - Video

8. **Rate limits** — What are the platform's constraints?
   - Messages per second / per minute
   - Maximum message length (characters or bytes)
   - Throttling / retry-after headers
   - Bulk send limits

9. **User identity** — How are users and conversations identified?
   - User ID format
   - Chat ID / Channel ID / Group ID
   - Display name retrieval

Document all findings in a comment block at the top of the provider file before implementing.

---

## Phase 2: Scaffold the Package

Create the following directory structure:

```
packages/channel-<name>/
├── package.json          (openlobby-channel-<name>, peer dep on @openlobby/core)
├── tsconfig.json         (extends ../../tsconfig.base.json)
└── src/
    ├── index.ts           (ChannelPluginModule default export)
    ├── <name>-provider.ts (ChannelProvider implementation)
    └── <name>-api.ts      (Lightweight API client)
```

### package.json

```json
{
  "name": "openlobby-channel-<name>",
  "version": "0.1.0",
  "description": "<DisplayName> channel plugin for OpenLobby",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch"
  },
  "openlobby": {
    "displayName": "<DisplayName>"
  },
  "keywords": ["openlobby", "openlobby-channel", "<name>", "bot"],
  "license": "MIT",
  "dependencies": {
    "@openlobby/core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^25.5.0",
    "typescript": "^5.7.0"
  }
}
```

### tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

**Important:** Prefer zero external dependencies. Use native `fetch` (available in Node 18+) instead of `axios`, `node-fetch`, or platform SDKs. This keeps the package lightweight and avoids version conflicts.

---

## Phase 3: Implement the API Client

Create `src/<name>-api.ts` — a lightweight, fully typed wrapper around the platform's Bot API using native `fetch`.

### Required Methods

```ts
export class <Name>BotApi {
  constructor(private readonly config: { /* platform-specific auth */ }) {}

  /** Send a plain text or formatted message to a chat */
  async sendMessage(chatId: string, text: string, options?: {
    format?: 'text' | 'markdown';
    replyToMessageId?: string;
    threadId?: string;
  }): Promise<{ messageId: string }>;

  /** Send a message with inline action buttons */
  async sendMessageWithActions(chatId: string, text: string, actions: Array<{
    label: string;
    callbackData: string;
  }>): Promise<{ messageId: string }>;

  /** Respond to an inline button callback */
  async answerCallback(callbackId: string, text?: string): Promise<void>;

  /** Long polling: fetch new updates (for polling-based platforms) */
  async getUpdates(offset?: number, timeout?: number): Promise<PlatformUpdate[]>;

  /** Register a webhook URL (for webhook-based platforms) */
  async setWebhook(url: string, secret?: string): Promise<void>;
}
```

### Required Helpers

```ts
/**
 * Split a long message into chunks that fit within the platform's limit.
 * Split at newline boundaries when possible, never mid-word.
 */
export function splitMessage(text: string, maxLength: number): string[];

/**
 * Escape special characters for the platform's Markdown variant.
 * Only needed if the platform has strict Markdown parsing (e.g. Telegram MarkdownV2).
 */
export function escapeMarkdown(text: string): string;
```

### Reference

Study `packages/channel-telegram/src/telegram-api.ts` for a clean example of this pattern.

---

## Phase 4: Implement the ChannelProvider

Create `src/<name>-provider.ts` implementing `ChannelProvider` from `@openlobby/core`.

### Interface to Implement

```ts
import type { ChannelProvider, ChannelRouter, OutboundChannelMessage } from '@openlobby/core';

export class <Name>Provider implements ChannelProvider {
  /** Start receiving messages. Called once at server startup. */
  async start(router: ChannelRouter): Promise<void>;

  /** Gracefully stop. Called at server shutdown. */
  async stop(): Promise<void>;

  /** Send an outbound message to the IM platform. */
  async sendMessage(msg: OutboundChannelMessage): Promise<void>;

  /** Health check. Returns true if the provider is operational. */
  isHealthy(): boolean;

  /** Update an existing approval card with result text (optional). */
  async updateCard?(peerId: string, taskId: string, resultText: string): Promise<void>;

  /** Return webhook route handlers for platforms that use webhooks (optional). */
  getWebhookHandlers?(): Array<{ method: string; path: string; handler: (req: any, reply: any) => Promise<void> }>;
}
```

### 7 Critical Patterns to Implement

#### Pattern 1 — Message Receiving

For **long polling** platforms (e.g. Telegram):

```ts
private pollingController: AbortController | null = null;

private async pollLoop(): Promise<void> {
  this.pollingController = new AbortController();
  let offset = 0;
  while (this.healthy) {
    try {
      const updates = await this.api.getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.updateId + 1;
        await this.handleUpdate(update);
      }
    } catch (err) {
      if (this.pollingController.signal.aborted) break;
      this.log('error', 'Polling error, retrying in 3s:', err);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}
```

For **webhook** platforms (e.g. Slack, Feishu):

```ts
getWebhookHandlers() {
  return [{
    method: 'POST',
    path: `/webhooks/<name>`,
    handler: async (req: any, reply: any) => {
      if (!this.verifySignature(req)) {
        reply.status(401).send({ error: 'Invalid signature' });
        return;
      }
      const event = req.body;
      await this.handleUpdate(event);
      reply.status(200).send({ ok: true });
    },
  }];
}
```

#### Pattern 2 — Inbound Message Conversion

Convert platform-specific messages to `InboundChannelMessage`:

```ts
private convertToInbound(platformMsg: PlatformMessage): InboundChannelMessage {
  return {
    externalMessageId: String(platformMsg.messageId),
    identity: {
      channelName: '<name>',
      accountId: String(platformMsg.userId),
      peerId: String(platformMsg.chatId),
      peerDisplayName: platformMsg.userName || platformMsg.userId,
    },
    text: platformMsg.text || '',
    timestamp: platformMsg.timestamp ?? Date.now(),
    // Optional fields:
    callbackData: platformMsg.callbackData,      // for button clicks
    attachments: platformMsg.attachments,          // for media
    quote: platformMsg.replyToText,               // for quoted replies
  };
}
```

#### Pattern 3 — Outbound Message Handling by Kind

Handle each `OutboundChannelMessage.kind`:

```ts
async sendMessage(msg: OutboundChannelMessage): Promise<void> {
  switch (msg.kind) {
    case 'message': {
      // Respect msg.format ('text' | 'markdown')
      // Split long messages using splitMessage()
      const chunks = splitMessage(msg.text, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await this.api.sendMessage(msg.peerId, chunk, { format: msg.format });
      }
      break;
    }
    case 'typing': {
      // Send platform-specific typing indicator
      // e.g. Telegram: sendChatAction('typing')
      // e.g. Slack: (no direct equivalent, use message with emoji)
      await this.sendTypingIndicator(msg.peerId);
      break;
    }
    case 'approval': {
      // Send message with inline action buttons from msg.actions[]
      // Each action: { label: string, callbackData: string }
      await this.api.sendMessageWithActions(msg.peerId, msg.text, msg.actions ?? []);
      break;
    }
  }
}
```

#### Pattern 4 — Message Deduplication

Prevent processing the same message twice (important for webhooks that may retry):

```ts
private seen = new Map<string, number>();
private dedupeInterval: ReturnType<typeof setInterval> | null = null;

private isDuplicate(messageId: string): boolean {
  if (this.seen.has(messageId)) return true;
  this.seen.set(messageId, Date.now());
  return false;
}

private startDedupeCleanup(): void {
  this.dedupeInterval = setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000; // 5 min TTL
    for (const [id, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(id);
    }
  }, 60_000);
}
```

#### Pattern 5 — Callback Handling

Handle inline button presses and convert to inbound messages:

```ts
private async handleCallback(callback: PlatformCallback): Promise<void> {
  // Answer the callback to dismiss the loading state
  await this.api.answerCallback(callback.id, 'Processing...');

  // Convert to InboundChannelMessage with callbackData
  // callbackData format: "approve:sessionId:requestId:taskId"
  const inbound: InboundChannelMessage = {
    externalMessageId: callback.id,
    identity: {
      channelName: '<name>',
      accountId: String(callback.userId),
      peerId: String(callback.chatId),
      peerDisplayName: callback.userName || '',
    },
    text: '',
    timestamp: Date.now(),
    callbackData: callback.data, // e.g. "approve:sess123:req456:task789"
  };
  await this.router.routeInbound(inbound);
}
```

#### Pattern 6 — Debug Logging

Ring buffer for recent logs, useful for diagnostics:

```ts
debugLogs: string[] = [];
private readonly MAX_DEBUG_LOGS = 50;

private log(level: 'info' | 'warn' | 'error', ...args: unknown[]): void {
  const entry = `[${new Date().toISOString()}] [${level}] ${args.map(a =>
    typeof a === 'string' ? a : JSON.stringify(a)
  ).join(' ')}`;
  this.debugLogs.push(entry);
  if (this.debugLogs.length > this.MAX_DEBUG_LOGS) {
    this.debugLogs.shift();
  }
  if (level === 'error') {
    console.error(`[channel-<name>]`, ...args);
  } else {
    console.log(`[channel-<name>]`, ...args);
  }
}
```

#### Pattern 7 — Graceful Shutdown

Clean up all resources in `stop()`:

```ts
async stop(): Promise<void> {
  this.healthy = false;
  // Abort polling if active
  this.pollingController?.abort();
  // Clear deduplication cleanup interval
  if (this.dedupeInterval) {
    clearInterval(this.dedupeInterval);
    this.dedupeInterval = null;
  }
  // Close WebSocket if applicable
  // Clear any other timers or connections
  this.log('info', 'Provider stopped');
}
```

### Reference Table: Existing Providers

| Aspect | WeCom (built-in) | Telegram (plugin) |
|--------|-------------------|-------------------|
| Location | server/src/channels/wecom.ts | packages/channel-telegram/ |
| API client | @wecom/aibot-node-sdk (WebSocket) | Pure fetch (zero deps) |
| Receiving | WebSocket events | Long polling / Webhook |
| Sending | WebSocket stream reply | REST sendMessage |
| Typing | `<think>` tags in stream | sendChatAction('typing') |
| Approvals | Stream reply (no inline buttons) | Inline keyboard buttons |
| Message limit | 20,480 bytes | 4,096 chars |
| Auth | botId + secret | botToken |

### Credentials Reference

Common credential shapes for popular platforms:

```
WeCom:    { botId, secret }
Telegram: { botToken, webhookUrl?, webhookSecret? }
Slack:    { botToken, signingSecret }
Discord:  { botToken, applicationId }
Feishu:   { appId, appSecret }
LINE:     { channelAccessToken, channelSecret }
WhatsApp: { accessToken, phoneNumberId, verifyToken }
```

---

## Phase 5: Plugin Entry Point

Create `src/index.ts` — the default export that the server's plugin loader will import:

```ts
import type { ChannelPluginModule, ChannelProviderConfig } from '@openlobby/core';
import { <Name>Provider } from './<name>-provider.js';

// Re-export for direct usage
export { <Name>Provider } from './<name>-provider.js';
export { <Name>BotApi, splitMessage } from './<name>-api.js';

const plugin: ChannelPluginModule = {
  channelName: '<name>',
  displayName: '<DisplayName>',
  createProvider(config: ChannelProviderConfig) {
    return new <Name>Provider(config);
  },
};

export default plugin;
```

The plugin loader discovers packages by the `openlobby-channel` keyword in package.json and calls `createProvider(config)` to instantiate the provider.

---

## Phase 6: Auto-Verify (Hard Gate)

Run the following commands and ensure they pass. Do NOT proceed to Phase 7 until the build is clean.

```bash
# Install dependencies (picks up workspace:* link)
pnpm install

# Build the channel package
pnpm --filter openlobby-channel-<name> build
```

**Build MUST pass with zero errors.**

After a successful build, verify the plugin contract programmatically:

```ts
// Quick sanity check (run mentally or via a test):
import plugin from 'openlobby-channel-<name>';
assert(typeof plugin.channelName === 'string');
assert(typeof plugin.displayName === 'string');
assert(typeof plugin.createProvider === 'function');
```

If the build fails, fix all TypeScript errors before continuing. Common issues:
- Missing type imports from `@openlobby/core`
- Incorrect `extends` path in tsconfig.json
- `.js` extension missing in relative imports (required for ESM)

---

## Phase 7: Guided Real-World Testing

Once the build passes, guide the user through 8 integration tests. For each test:
1. Explain what the test verifies and what the user needs to do
2. Wait for the user to perform the action
3. Ask "Did it work? (yes/no)"
4. If no: examine debug logs, diagnose, fix, rebuild, and retry
5. If yes: move to the next test

**All 8 tests must pass before the provider is considered complete.**

### T1: Provider Startup

Configure the channel provider via the OpenLobby API or config file with the bot credentials. Verify the health endpoint reports the provider as healthy.

```
Expected: GET /api/channels → includes { name: '<name>', healthy: true }
```

### T2: Receive Message

Ask the user to send "hello" from the IM platform to the bot. Verify the message arrives in the server logs as an `InboundChannelMessage`.

```
Expected: Server log shows inbound message with text "hello" and correct identity
```

### T3: Send Response

Verify the bot sends a reply back to the user in the IM platform. The LobbyManager should auto-respond to the "hello" message.

```
Expected: User sees a reply from the bot in the IM chat
```

### T4: Approval Card

Trigger a tool approval by asking the agent to perform a file operation. Verify inline action buttons appear in the IM chat. Test clicking "Approve" and "Reject".

```
Expected: Message with inline buttons appears; clicking a button sends the approval decision
```

### T5: Slash Commands — /help

User sends `/help` to the bot. Verify it returns the list of available commands.

```
Expected: Bot replies with the help text listing available commands
```

### T6: Slash Commands — /ls and /exit

User sends `/ls` to list active sessions, then `/exit` to leave the current session.

```
Expected: /ls shows session list; /exit returns user to the lobby
```

### T7: Multi-Turn Conversation

User sends 3 or more messages in sequence. Verify the conversation maintains context and replies are coherent.

```
Expected: Bot replies reference previous messages in the conversation
```

### T8: Typing Indicator

User sends a complex question that requires the agent to think. Verify the typing/thinking indicator is shown in the IM chat while the agent processes.

```
Expected: Typing indicator or "thinking" status appears before the final reply
```

---

## Completion Checklist

Before declaring the provider complete, verify:

- [ ] Package builds with zero errors (`pnpm --filter openlobby-channel-<name> build`)
- [ ] Plugin entry point exports `channelName`, `displayName`, `createProvider`
- [ ] API client uses native `fetch` with zero external dependencies
- [ ] Message deduplication is implemented
- [ ] Long messages are split at platform's character limit
- [ ] Graceful shutdown cleans up all resources
- [ ] All 8 integration tests pass
- [ ] Debug logging ring buffer is implemented

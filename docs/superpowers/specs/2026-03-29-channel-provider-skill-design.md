# OpenLobby Channel Provider Skill — Design Spec

## Overview

Create a project-level Claude Code skill (`.claude/skills/new-channel-provider.md`) that automatically generates a complete IM channel provider package for OpenLobby when the user requests integration with a new messaging platform.

## Goal

User says "add Slack/Discord/Feishu channel to OpenLobby" → Claude Code auto-generates a working channel provider package → builds successfully → guides user through full real-world testing → confirmed working.

## Prerequisites

None. Channel plugin system is already complete:
- `ChannelPluginModule` interface defined in `packages/core/src/channel.ts`
- Dynamic loader in `packages/server/src/channels/index.ts` (naming convention `openlobby-channel-{name}`)
- Plugin discovery in `packages/server/src/channels/plugin-discovery.ts`
- Two reference implementations: WeCom (built-in) and Telegram (external plugin)

## Skill Execution Flow

```
Phase 1: Research target IM platform Bot API
Phase 2: Scaffold package packages/channel-<name>/
Phase 3: Implement API client (<name>-api.ts)
Phase 4: Implement ChannelProvider (<name>-provider.ts)
Phase 5: Implement PluginModule entry point (index.ts)
Phase 6: Auto-verify (build + structure check)
Phase 7: Guided real-world testing (user provides bot token, 8 test scenarios)
```

## Phase Details

### Phase 1: Research

Investigate the target platform's bot/API:
1. Bot API type (REST, WebSocket, SDK, webhook)
2. Authentication (bot token, app ID + secret, OAuth)
3. Message receiving (long polling, webhooks, WebSocket)
4. Message sending (REST POST, WebSocket, SDK method)
5. Message format (plain text, Markdown, rich cards, inline buttons)
6. Callback/interaction (inline button callbacks, reactions, threads)
7. Media support (image, file, voice, video)
8. Rate limits (messages/second, message length, throttling)
9. User identity (user ID, chat ID, group ID)

### Phase 2: Package Scaffolding

```
packages/channel-<name>/
├── package.json          (openlobby-channel-<name>, peer dep on @openlobby/core)
├── tsconfig.json         (extends ../../tsconfig.base.json)
└── src/
    ├── index.ts           (ChannelPluginModule default export)
    ├── <name>-provider.ts (ChannelProvider implementation)
    └── <name>-api.ts      (Lightweight API client)
```

package.json must include:
- `"name": "openlobby-channel-<name>"`
- `"openlobby": { "displayName": "<DisplayName>" }`
- `"keywords": ["openlobby", "openlobby-channel"]`
- Peer dependency on `@openlobby/core`
- Prefer zero external deps for API client (native `fetch`)

### Phase 3: API Client

`<name>-api.ts` — typed wrapper around the platform HTTP/WebSocket API.

Required capabilities:
- `sendMessage()` — send text with optional format/reply
- `sendMessageWithActions()` — send with inline buttons (for approval cards)
- `answerCallback()` — acknowledge button press (if platform supports)
- `getUpdates()` or WebSocket connection — receive messages
- `splitMessage()` helper — handle platform message length limits
- Markdown escaping helper — if platform has special syntax

Design: follow Telegram adapter pattern (pure `fetch`, zero deps, typed responses).

### Phase 4: ChannelProvider

`<name>-provider.ts` — implements `ChannelProvider` interface.

Required methods:
- `start(router)` — connect to platform, start receiving messages
- `stop()` — graceful shutdown (abort polling, clear timers, close connections)
- `sendMessage(msg)` — handle all `kind` values (message/typing/approval)
- `isHealthy()` — connection status

Optional methods:
- `updateCard()` — update approval card after decision
- `getWebhookHandlers()` — return Fastify route handlers for webhook mode

Critical patterns to implement:

1. **InboundChannelMessage conversion** — platform message → `{ externalMessageId, identity: { channelName, accountId, peerId, peerDisplayName }, text, timestamp, callbackData?, attachments?, quote? }`

2. **OutboundChannelMessage handling by kind:**
   - `'message'` → send text, respect `format` (markdown/text)
   - `'typing'` → platform typing indicator or `<think>` tag content
   - `'approval'` → send with inline action buttons from `msg.actions[]`

3. **Message deduplication** — `Map<string, number>` with 5-minute TTL, periodic cleanup

4. **Callback handling** — button press → `InboundChannelMessage` with `callbackData` (format: `approve:sessionId:requestId:taskId`)

5. **Debug logging** — ring buffer (50 entries), exposed via `/debug/channel-logs`

6. **Health tracking** — `healthy = true` on successful connection, `false` on disconnect

7. **Graceful shutdown** — `stop()` clears all timers, aborts polling, closes connections

### Phase 5: Plugin Entry Point

`index.ts`:
```ts
const plugin: ChannelPluginModule = {
  channelName: '<name>',
  displayName: '<DisplayName>',
  createProvider(config) { return new <Name>Provider(config); },
};
export default plugin;
```

### Phase 6: Auto-Verify (Hard Gate)

```bash
pnpm install
pnpm --filter openlobby-channel-<name> build
```

Build must pass. Then verify structure:
- Default export has `channelName`, `displayName`, `createProvider`
- `createProvider()` returns object implementing `ChannelProvider`

Do NOT proceed to Phase 7 if build fails.

### Phase 7: Guided Real-World Testing

Skill asks user for bot credentials, then walks through 8 test scenarios one by one. Each test requires user confirmation before proceeding.

| # | Test | Skill does | User does | Pass criteria |
|---|------|-----------|-----------|---------------|
| T1 | Provider startup | Configure provider via Web UI or API, start server, check health endpoint | Provide bot credentials | Health shows provider `healthy: true` |
| T2 | Receive message | Monitor server logs for `[ChannelRouter] Inbound` | Send "hello" to bot from IM | Message appears in logs, LM session receives it |
| T3 | Send response | Wait for LM to route and respond | Read IM | Bot replies in IM with LM response |
| T4 | Approval card | Trigger a session that uses tools requiring approval | Look for inline buttons in IM | Approve/deny buttons visible, clicking works |
| T5 | Slash commands | Instruct user to send `/help` | Send `/help` from IM | Bot returns command list |
| T6 | `/ls` and `/exit` | Instruct user to test more commands | Send `/ls` then `/exit` | Session list returned, then "returned to LM" |
| T7 | Multi-turn | Instruct user to have a conversation | Send 3+ messages in sequence | All responses arrive, conversation is coherent |
| T8 | Typing indicator | Instruct user to send a message that triggers thinking | Send a complex question | Bot shows typing/thinking state before responding |

For each test:
- Skill explains what to do
- User performs the action
- Skill asks: "Did it work? (yes/no)"
- If no → skill helps diagnose (check logs, review code, fix and rebuild)
- If yes → proceed to next test

All 8 tests must pass. Skill reports final status.

## Existing Provider Reference

| Aspect | WeCom (built-in) | Telegram (plugin) |
|--------|-------------------|-------------------|
| Location | `server/src/channels/wecom.ts` | `packages/channel-telegram/` |
| API client | `@wecom/aibot-node-sdk` (WebSocket) | Pure `fetch` (zero deps) |
| Receiving | WebSocket events | Long polling / Webhook |
| Sending | WebSocket stream reply | REST `sendMessage` |
| Typing | `<think>` tags in stream | `sendChatAction('typing')` |
| Approvals | Stream reply (no inline buttons) | Inline keyboard buttons |
| Message limit | 20,480 bytes | 4,096 chars |
| Auth | botId + secret | botToken |
| Dedup | Map + 5min TTL | Map + 5min TTL |
| Debug logs | Ring buffer 50 | Ring buffer 50 |

## Credentials Reference

```
WeCom:    { botId, secret }
Telegram: { botToken, webhookUrl?, webhookSecret? }
Slack:    { botToken, signingSecret }
Discord:  { botToken, applicationId }
Feishu:   { appId, appSecret }
LINE:     { channelAccessToken, channelSecret }
WhatsApp: { accessToken, phoneNumberId, verifyToken }
```

## Success Criteria

1. Package builds with zero TypeScript errors
2. Plugin auto-discovered by server at startup
3. Provider starts and reports healthy
4. All 8 guided test scenarios pass with user confirmation
5. Messages flow bidirectionally (IM ↔ OpenLobby)
6. Approval cards work end-to-end
7. Slash commands work from IM
8. Typing indicators displayed

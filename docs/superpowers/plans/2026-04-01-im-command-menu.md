# IM Command Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let IM users (Telegram / WeCom) discover and use all available slash commands via platform-native command menus, with dynamic updates when sessions switch or adapter commands change.

**Architecture:** channel-router assembles `CommandGroup[]` (OpenLobby built-in + adapter commands) and pushes them to providers via a new `syncCommands` optional method. Telegram registers commands via `setMyCommands` per-chat. WeCom caches groups and renders a Template Card on `/cmd`.

**Tech Stack:** TypeScript, Telegram Bot API (`setMyCommands`), WeCom SDK (`sendMessage` template_card)

---

### Task 1: Add `CommandGroup` / `CommandEntry` types and `syncCommands` to ChannelProvider

**Files:**
- Modify: `packages/core/src/channel.ts`

- [ ] **Step 1: Add type definitions and extend ChannelProvider**

Add these types before the `ChannelProvider` interface, and add `syncCommands` to the interface:

```typescript
// Add before ChannelProvider interface (after ChannelPluginInfo)

/** A named group of slash commands (e.g. "OpenLobby", "Claude Code") */
export interface CommandGroup {
  label: string;
  commands: CommandEntry[];
}

export interface CommandEntry {
  command: string;
  description: string;
}
```

In the `ChannelProvider` interface, add after the `getWebhookHandlers` method:

```typescript
  /** Sync command menu to IM platform (per-chat). Optional — providers that don't support command registration can skip. */
  syncCommands?(peerId: string, groups: CommandGroup[]): Promise<void>;
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @openlobby/core build`
Expected: success, no errors

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/channel.ts
git commit -m "feat(core): add CommandGroup types and syncCommands to ChannelProvider"
```

---

### Task 2: Add `setMyCommands` to Telegram API client

**Files:**
- Modify: `packages/channel-telegram/src/telegram-api.ts`

- [ ] **Step 1: Add `setMyCommands` method**

Add this method to the `TelegramBotApi` class, after the `deleteMessage` method (before the `// ─── Internal ──` section):

```typescript
  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    options?: {
      scope?: { type: string; chat_id?: number; user_id?: number };
    },
  ): Promise<boolean> {
    return this.call('setMyCommands', {
      commands,
      ...options,
    });
  }
```

- [ ] **Step 2: Verify build**

Run: `pnpm --filter @openlobby/channel-telegram build`
Expected: success

- [ ] **Step 3: Commit**

```bash
git add packages/channel-telegram/src/telegram-api.ts
git commit -m "feat(telegram): add setMyCommands API method"
```

---

### Task 3: Implement `syncCommands` in Telegram provider

**Files:**
- Modify: `packages/channel-telegram/src/telegram-provider.ts`

- [ ] **Step 1: Import `CommandGroup` type**

At the top of `telegram-provider.ts`, add `CommandGroup` to the import from `@openlobby/core`:

```typescript
import type { CommandGroup } from '@openlobby/core';
```

(Add to the existing `@openlobby/core` import if one exists, or create a new import line.)

- [ ] **Step 2: Add `syncCommands` method**

Add this method to the `TelegramProvider` class, after the `updateCard` method:

```typescript
  async syncCommands(peerId: string, groups: CommandGroup[]): Promise<void> {
    const commands = groups.flatMap(g =>
      g.commands.map(c => ({
        command: c.command.slice(0, 32).toLowerCase(),
        description: c.description.slice(0, 256),
      }))
    );

    if (commands.length === 0) return;

    try {
      await this.api.setMyCommands(commands, {
        scope: { type: 'chat', chat_id: Number(peerId) },
      });
      this.log('info', `Synced ${commands.length} commands for chat ${peerId}`);
    } catch (err) {
      this.log('error', 'syncCommands error:', err);
    }
  }
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @openlobby/channel-telegram build`
Expected: success

- [ ] **Step 4: Commit**

```bash
git add packages/channel-telegram/src/telegram-provider.ts
git commit -m "feat(telegram): implement syncCommands via setMyCommands per-chat"
```

---

### Task 4: Implement `syncCommands` in WeCom provider

**Files:**
- Modify: `packages/server/src/channels/wecom.ts`

- [ ] **Step 1: Import `CommandGroup` type**

Add `CommandGroup` to the existing `@openlobby/core` import at the top of `wecom.ts`:

```typescript
import type { CommandGroup } from '@openlobby/core';
```

- [ ] **Step 2: Add cached command groups map and `syncCommands` method**

Add a property to the class (alongside other private fields like `pendingReplies`, `healthy`, etc.):

```typescript
  private cachedCommandGroups = new Map<string, CommandGroup[]>();
```

Add the `syncCommands` method after the `updateCard` method:

```typescript
  async syncCommands(peerId: string, groups: CommandGroup[]): Promise<void> {
    this.cachedCommandGroups.set(peerId, groups);
    this.log('info', `Cached ${groups.length} command groups for ${peerId}`);
  }
```

- [ ] **Step 3: Add `sendCommandMenu` method**

This method generates and sends a Template Card with command buttons grouped by label. Add it after `syncCommands`:

```typescript
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
```

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @openlobby/server build`
Expected: success

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/channels/wecom.ts
git commit -m "feat(wecom): implement syncCommands cache and sendCommandMenu card"
```

---

### Task 5: Add `buildCommandGroups`, `syncCommandsToProvider`, slash command normalize, and `/cmd` to channel-router

**Files:**
- Modify: `packages/server/src/channel-router.ts`

- [ ] **Step 1: Import `CommandGroup` type**

Add `CommandGroup` to the existing `@openlobby/core` import:

```typescript
import type { CommandGroup } from '@openlobby/core';
```

- [ ] **Step 2: Add `buildCommandGroups` method**

Add this private method in the Helpers section (near the end of the class, before `createDefaultBinding`):

```typescript
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
      const adapterGroup: CommandGroup = {
        label: adapterLabel,
        commands: adapterCommands.map(c => ({
          command: c.name.replace(/^\//, '').replace(/-/g, '_'),
          description: c.description ?? '',
        })),
      };
      return [lobbyGroup, adapterGroup];
    }

    return [lobbyGroup];
  }
```

- [ ] **Step 3: Add `syncCommandsToProvider` method**

Add this private method right after `buildCommandGroups`:

```typescript
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
```

- [ ] **Step 4: Add slash command normalize (underscore → hyphen)**

In the `handleSlashCommand` method (around line 423), add a normalize step right after `const cmd = parts[0].toLowerCase();`:

Find:
```typescript
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ').trim();
```

Replace with:
```typescript
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase().replace(/_/g, '-');
    const arg = parts.slice(1).join(' ').trim();
```

- [ ] **Step 5: Add `/cmd` case to the IM command switch**

In the `handleSlashCommand` method, add `/cmd` case to the IM-specific switch block. Find the block:

```typescript
      case '/msg-only':
      case '/msg-tidy':
      case '/msg-total':
        return this.cmdMsgMode(identityKey, cmd.slice(1) as MessageMode);
    }
```

Add the `/cmd` case before the closing `}`:

```typescript
      case '/msg-only':
      case '/msg-tidy':
      case '/msg-total':
        return this.cmdMsgMode(identityKey, cmd.slice(1) as MessageMode);
      case '/cmd':
        return this.cmdShowMenu(identityKey, identity);
    }
```

- [ ] **Step 6: Add `cmdShowMenu` method**

Add this private method after `cmdMsgMode`:

```typescript
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
```

- [ ] **Step 7: Verify build**

Run: `pnpm --filter @openlobby/server build`
Expected: success

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/channel-router.ts
git commit -m "feat(channel-router): add buildCommandGroups, syncCommandsToProvider, /cmd, and underscore normalize"
```

---

### Task 6: Wire up the 4 trigger points in channel-router

**Files:**
- Modify: `packages/server/src/channel-router.ts`

- [ ] **Step 1: Trigger 4 — onCommands listener in constructor**

In the constructor (after the existing `onNavigate` listener at line ~113), add:

```typescript
    // Sync command menus when adapter commands change (rebuild, SDK refresh)
    this.sessionManager.onCommands('channel-router-cmds', (sessionId, _commands) => {
      const bindings = getAllBindingsBySession(this.db, sessionId);
      for (const binding of bindings) {
        this.syncCommandsToProvider(binding.identity_key, sessionId);
      }
    });
```

- [ ] **Step 2: Trigger 1 — createDefaultBinding**

In `createDefaultBinding()`, after the welcome message send (after the `.catch()` line for LM_WELCOME_TEXT), add:

```typescript
    // Sync initial command menu for new IM user
    const lmSessionId = this.lobbyManager?.getSessionId();
    if (lmSessionId) {
      this.syncCommandsToProvider(identityKey, lmSessionId);
    }
```

- [ ] **Step 3: Trigger 2 — cmdGoto**

In `cmdGoto()`, before the `return` statement at the end of the method, add:

```typescript
    // Sync command menu for new session (may be different adapter)
    this.syncCommandsToProvider(identityKey, session.id);
```

- [ ] **Step 4: Trigger 3 — handleNavigate**

In `handleNavigate()`, before the closing `}` of the method (after the provider.sendMessage call for the navigation confirmation), add:

```typescript
    // Sync command menu for navigated session
    this.syncCommandsToProvider(lastSenderKey, sessionId);
```

- [ ] **Step 5: Verify build**

Run: `pnpm --filter @openlobby/server build`
Expected: success

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/channel-router.ts
git commit -m "feat(channel-router): wire 4 trigger points for command menu sync"
```

---

### Task 7: Add `/cmd` and `/compact` to slash-commands help text

**Files:**
- Modify: `packages/server/src/slash-commands.ts`

- [ ] **Step 1: Add `/compact` and `/cmd` to help text**

In the `cmdHelp()` function, find the help text array and add these two lines before the `/bind` line:

```typescript
      '`/compact` — 压缩当前会话上下文',
      '`/cmd` — 显示命令菜单 (IM)',
```

- [ ] **Step 2: Add `/cmd` and `/compact` to the shared switch for null-return (caller-handled)**

In the `handleSharedSlashCommand` function's switch, add `/cmd` and `/compact` cases that return null (they are handled by the caller):

Find:
```typescript
    case '/bind':
      return null; // Needs identity context — handled by caller (IM only)
    case '/unbind':
      return null; // Needs identity context — handled by caller (IM only)
```

Add before these lines:
```typescript
    case '/cmd':
      return null; // Needs provider context — handled by caller (IM only)
```

- [ ] **Step 3: Verify build**

Run: `pnpm --filter @openlobby/server build`
Expected: success

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/slash-commands.ts
git commit -m "feat(slash-commands): add /cmd and /compact to help text"
```

---

### Task 8: Build and verify end-to-end

**Files:** (no new changes, verification only)

- [ ] **Step 1: Full build**

Run: `pnpm -r build`
Expected: all packages build successfully

- [ ] **Step 2: Verify no TypeScript errors**

Run: `pnpm --filter @openlobby/server exec tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Final commit (if any fixes needed)**

Only if build fixes were required. Otherwise, skip.

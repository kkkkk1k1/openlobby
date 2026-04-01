# IM Command Menu — Design Spec

## Goal

让 IM 用户（Telegram / WeCom）能发现并快速使用所有可用命令。命令包括 OpenLobby 内置命令和当前会话 adapter 的命令，**分层展示**并**动态更新**。

## Architecture

### Router 驱动模式

channel-router 是命令分发的核心枢纽，由它负责：

1. 组装完整的分层命令列表（OpenLobby 命令 + adapter 命令）
2. 在关键时机调用 provider 的 `syncCommands` 方法推送更新

Provider 只负责平台适配：Telegram 调 API 注册，WeCom 缓存供 `/cmd` 使用。

### 数据模型

```typescript
// packages/core/src/channel.ts

interface CommandGroup {
  label: string;           // 分组名，如 "OpenLobby" / "Claude Code"
  commands: CommandEntry[];
}

interface CommandEntry {
  command: string;         // 如 "help", "goto" (不含 /)
  description: string;     // 简短描述
}
```

### ChannelProvider 接口扩展

```typescript
interface ChannelProvider {
  // ... existing methods ...

  /** 同步命令菜单到 IM 平台 */
  syncCommands?(peerId: string, groups: CommandGroup[]): Promise<void>;
}
```

- `peerId`：支持 per-chat 维度的命令列表（Telegram `BotCommandScopeChat`）
- 可选方法：不支持命令注册的 provider 不实现

## Command Assembly

### `buildCommandGroups(sessionId)` — channel-router 新增方法

```typescript
private buildCommandGroups(sessionId: string): CommandGroup[] {
  // Group 1: OpenLobby 内置命令（固定列表）
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

  // Group 2: 当前会话 adapter 命令（动态）
  const adapterCommands = this.sessionManager.getSessionCommands(sessionId);
  const info = this.sessionManager.getSessionInfo(sessionId);
  const adapterLabel = info?.adapterName ?? 'CLI';

  const adapterGroup: CommandGroup = {
    label: adapterLabel,
    commands: adapterCommands.map(c => ({
      command: c.name.replace(/^\//, ''),
      description: c.description,
    })),
  };

  // 只有 adapter 有命令时才包含第二组
  return adapterGroup.commands.length > 0
    ? [lobbyGroup, adapterGroup]
    : [lobbyGroup];
}
```

### `syncCommandsToProvider(identityKey, sessionId)` — 推送入口

```typescript
private syncCommandsToProvider(identityKey: string, sessionId: string): void {
  const binding = getBinding(this.db, identityKey);
  if (!binding) return;

  const provider = this.providers.get(
    `${binding.channel_name}:${binding.account_id}`
  );
  if (!provider?.syncCommands) return;

  const groups = this.buildCommandGroups(sessionId);
  provider.syncCommands(binding.peer_id, groups)
    .catch(err => console.error('[ChannelRouter] syncCommands error:', err));
}
```

## Trigger Points

命令菜单在以下 4 个时机自动同步：

| # | 时机 | 触发位置 | 说明 |
|---|------|----------|------|
| 1 | 用户首次与 bot 对话 | `createDefaultBinding()` | 注册初始命令菜单 |
| 2 | `/goto` 切换会话 | `cmdGoto()` | 新会话可能是不同 adapter |
| 3 | LM navigate 跳转 | `handleNavigate()` | LobbyManager 自动导航到新会话 |
| 4 | adapter 命令列表变更 | `onCommands` listener | session rebuild 或 SDK 刷新命令 |

每个触发点在操作完成后调用 `syncCommandsToProvider(identityKey, sessionId)`。

对于时机 4（命令变更事件），需要在 channel-router 构造函数中新增监听：

```typescript
this.sessionManager.onCommands('channel-router-cmds', (sessionId, _commands) => {
  // 找到绑定了该 session 的所有 identity，逐个同步
  const bindings = getAllBindingsBySession(this.db, sessionId);
  for (const binding of bindings) {
    this.syncCommandsToProvider(binding.identity_key, sessionId);
  }
});
```

## Platform Adapters

### Telegram

**平铺注册**：将所有 `CommandGroup` 的命令展平为一维列表，通过 `setMyCommands` API 注册。

```typescript
// telegram-provider.ts
async syncCommands(peerId: string, groups: CommandGroup[]): Promise<void> {
  // 展平所有分组
  const commands = groups.flatMap(g =>
    g.commands.map(c => ({
      command: c.command,
      description: c.description,
    }))
  );

  await this.api.setMyCommands(commands, {
    scope: { type: 'chat', chat_id: Number(peerId) },
  });
}
```

**telegram-api.ts 新增方法**：

```typescript
async setMyCommands(
  commands: Array<{ command: string; description: string }>,
  options?: { scope?: BotCommandScope },
): Promise<void> {
  await this.request('setMyCommands', {
    commands,
    ...options,
  });
}
```

注意：Telegram command 名只允许小写字母、数字和下划线，1-32 字符。现有 `/msg-tidy` 等含连字符的命令需映射为 `msg_tidy`（在 `buildCommandGroups` 中处理）。channel-router 的 slash command 解析也需同时识别 `/msg_tidy` 和 `/msg-tidy`。

### WeCom

**Template Card 菜单**：响应 `/cmd` 命令，从缓存的 `CommandGroup[]` 生成交互卡片。

```typescript
// wecom.ts
private cachedCommandGroups = new Map<string, CommandGroup[]>();

async syncCommands(peerId: string, groups: CommandGroup[]): Promise<void> {
  this.cachedCommandGroups.set(peerId, groups);
}
```

当用户发送 `/cmd` 时：

1. channel-router 识别 `/cmd` 为 IM 命令
2. 调用 `provider.sendCommandMenu(identity)` 或直接由 channel-router 通过 `provider.sendMessage` 发送一条 Template Card
3. Card 按 `CommandGroup` 分组，每组一个 section，每条命令一个按钮
4. 按钮 callback data 为 `cmd:/{command}`（如 `cmd:/help`）
5. 用户点击按钮后，provider 将 callback data 解析为 `InboundChannelMessage`，text 为 `/{command}`，重新注入 `router.handleInbound()`

Card 结构示意：

```
┌─────────────────────────────┐
│  📋 命令菜单                 │
├─────────────────────────────┤
│  OpenLobby                  │
│  [/help] [/ls] [/goto]      │
│  [/add]  [/rm] [/stop]      │
│  [/info] [/exit]            │
├─────────────────────────────┤
│  Claude Code                │
│  [/compact] [/model]        │
│  [/permissions]             │
└─────────────────────────────┘
```

### `/cmd` 命令注册

在 channel-router 的 IM 命令分发中新增 `/cmd` case：

```typescript
case '/cmd':
  return await this.cmdShowMenu(identityKey, identity);
```

`cmdShowMenu` 组装命令列表并通过 provider 发送 Template Card 或格式化文本（取决于 provider 能力）。

## Slash Command 兼容性

Telegram command 名不允许连字符 (`-`)，但 OpenLobby 现有命令使用连字符（`/msg-tidy`）。处理方案：

1. 注册到 Telegram 时使用下划线：`msg_tidy`、`msg_only`、`msg_total`
2. channel-router 的 slash command 解析同时接受两种格式：`/msg-tidy` 和 `/msg_tidy`
3. 这是 channel-router 入口处的 normalize 逻辑，一处改动覆盖所有命令

```typescript
// 在 handleSlashCommand 入口处 normalize
const normalized = input.replace(/_/g, '-');
```

## Scope

### In Scope
- `CommandGroup` / `CommandEntry` 类型定义（core）
- `ChannelProvider.syncCommands` 接口扩展（core）
- channel-router: `buildCommandGroups`, `syncCommandsToProvider`, 4 个触发点, `/cmd` 命令
- channel-router: slash command 输入 normalize（下划线→连字符）
- Telegram provider: `syncCommands` 实现 + `telegram-api.ts` 新增 `setMyCommands`
- WeCom provider: `syncCommands` 缓存 + `/cmd` Template Card 生成

### Out of Scope
- 其他 IM 平台的命令菜单支持（后续按需扩展）
- 命令权限控制（所有用户看到相同命令列表）
- Web 前端的命令菜单调整（已有 SlashCommandMenu 组件）

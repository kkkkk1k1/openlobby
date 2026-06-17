# 设计提案：多会话模式（Multi-Session Mode）

> 状态：Draft / Brainstorming Spec
> 作者：Lobby 开发助手（autofix agent）
> 日期：2026-05-13
> 阶段：superpowers/brainstorming —— 设计 spec，尚未进入 writing-plans / SDD

---

## 1. 背景与动机

### 1.1 当前形态

OpenLobby 的 channel（IM / Web 起源的 channel 用户）当前与 session 是 **一对一绑定**：

- 一个 `ChannelIdentity (channelName:accountId:peerId)` 只能绑到一个 target（`'lobby-manager'` 或某个 `sessionId`）。
- 数据层有 `idx_binding_active_session` UNIQUE 索引（`db.ts:84-87`），强制「一个 session 只能被一个 IM peer 占用」。
- inbound 路由通过 `resolveSessionId(binding)` 落到单 sessionId；outbound 通过 `lastSenderBySession`（`sessionId → 单 identityKey`）反查回推。

这套模型在 1v1 场景非常清晰，但有显著局限：

1. 用户要并行推进多个会话时，必须不断 `/exit` → 找 LM → `/goto <id>` 切来切去，等同于「单线程」工作流。
2. 多会话之间的协作（A 写实现，B 写测试，C 做 review）无法在 channel 端表达，只能回到 Web 端切换 Room。
3. LM 在 channel 端实际上是一个「路由前置网关」，但它对「正在工作的多个会话」缺乏并行视图。

### 1.2 目标场景

> "我想同时让 3 个会话推进 3 件事，在企业微信里用 `@feat-auth` `@feat-billing` `@bugfix-stream` 直接分别派单，回复一起回到这个对话里。"

具体能力诉求：

- **进入多会话模式**：channel 用户可主动从 LM 路由模式切到多会话模式。
- **`@{session_name}` 寻址**：在同一个 channel 对话里，用 `@name` 前缀把消息派给组内任一 session；不带 `@` 默认派给上一个被寻址的 session。
- **聚合响应**：多个 session 的回复都返回到同一个 channel，每条消息带 `【name】` 头标识。
- **LM 作为编排者**：LM 仍是 channel 的入口，但在多会话模式下，它的角色从「路由器」升级为「编排者」—— 维护组、增删 session、广播任务、汇总结果。
- **退出**：随时可退出多会话模式回到单 session / LM 路由模式。

---

## 2. 设计原则

| 原则 | 含义 |
|------|------|
| **不破坏现有 1:1 模式** | 单 session 路由、LM 路由必须继续工作；多会话模式是叠加层，默认关闭。 |
| **复用 ManagedSession** | 不引入新的「会话类型」，组成员仍是普通 session；多会话只是「绑定关系」的扩展。 |
| **JSONL 仍是消息单一真理源** | 各 session 自己的 JSONL 不变；channel 端的「聚合视图」是渲染层产物，不持久化。 |
| **LM 仍是普通 CLI session** | 多会话编排能力通过新增 MCP 工具实现，不引入新的 meta-agent 类型。 |
| **Web UI 等效可控** | 多会话模式有对应的 WebSocket 协议消息，Web 端可以并行查看 / 切换组内 session。 |
| **协议向后兼容** | 旧 client / 旧 channel-binding 行为不变；新增字段全部可选。 |

### 红线（不做的事）

- ❌ 不引入「群聊式 session」：每个 session 仍是独立 CLI 子进程，不共享上下文。
- ❌ 不让多个用户共享一个 session（保留 `active_session_id` 的「一个 session 同一时刻只一个占用者」语义，但占用者从「单 peer」放宽为「单 peer 的多会话组」）。
- ❌ 不在 channel 层做跨 session 上下文同步（A 看不到 B 的输出，除非 LM 显式转发）。

---

## 3. 概念模型

### 3.1 新增实体：SessionGroup

```typescript
interface SessionGroup {
  id: string;                       // 组 ID（UUID）
  identityKey: string;              // 拥有者 channel identity（channel:account:peer）
  name?: string;                    // 组名（可选，UI 显示）
  members: SessionGroupMember[];    // 组成员
  defaultMember?: string;           // 没有 @ 前缀时的默认派发目标（sessionId）
  createdAt: number;
  lastActiveAt: number;
  mode: 'multi-session';            // 预留字段，未来可能有 'broadcast' / 'pipeline' 等
}

interface SessionGroupMember {
  sessionId: string;
  alias: string;                    // 在组内的短名，用于 `@{alias}` 寻址（如 `feat-auth`）
  joinedAt: number;
  muted?: boolean;                  // 静音时不向 channel 推送输出（保留命令派单能力）
}
```

### 3.2 Binding 扩展

`ChannelBinding.target` 当前是 `'lobby-manager' | sessionId`。扩展为：

```typescript
type BindingTarget =
  | 'lobby-manager'
  | { kind: 'session', sessionId: string }       // 等价于现状
  | { kind: 'group', groupId: string };          // 新增：多会话模式
```

**兼容策略**：DB 字段 `target` 仍是 TEXT。
- 旧值 `'lobby-manager'` 不变。
- 单 session 值仍存 `sessionId`。
- 多会话模式存 `group:<groupId>` 前缀字符串（解析时识别）。

### 3.3 `active_session_id` UNIQUE 约束如何处理

现状语义是「一个 session 同时只能被一个 IM peer 占用」。在多会话模式下：

- **占用者粒度从「peer」放宽为「peer 的某个 group」**。
- 改造方式：把 `active_session_id` 唯一索引迁出 `channel_bindings`，改放到新表 `session_group_members(session_id PRIMARY KEY, group_id, ...)`，依旧保证「一个 session 只能进一个 group」。
- 单 session 直绑场景，旧索引语义通过 `session_group_members` 的隐式 1 成员组等价表达（见 §6.2 迁移）。

### 3.4 寻址与默认派发

| 用户输入 | 派发规则 |
|----------|----------|
| `@feat-auth 帮我加个登录接口` | 解析为 `feat-auth` 成员的 sessionId；更新 `defaultMember = feat-auth`。 |
| `继续优化下错误处理`（无 `@`） | 派给 `defaultMember`；若未设置，回复提示「请用 `@name` 指定接收方」。 |
| `@all 跑一遍测试` | 广播到所有非 muted 成员。 |
| `/leave` | 退出多会话模式，回到 LM 路由。 |
| `/group ...` | 多会话管理命令（详见 §4.3）。 |

`@name` 解析规则：

- 仅匹配 **消息首词**（首个 token），不识别正文中的 `@`，避免误伤代码 / 普通对话。
- 别名 case-insensitive，但 DB 存储用原 case。
- 别名命名约束：`[a-z][a-z0-9-]{0,31}`，不允许冲突。

---

## 4. 用户交互设计

### 4.1 进入多会话模式

#### 路径 A：用户主动通过 LM 创建

```
User → LM: 我想同时跟 3 个会话工作
LM → (内部调用) lobby_create_session ×3   // 或复用现有 session
LM → (内部调用) lobby_create_session_group(members=[
        {sessionId: s1, alias: 'feat-auth'},
        {sessionId: s2, alias: 'feat-billing'},
        {sessionId: s3, alias: 'bugfix-stream'}
      ])
LM → (内部调用) lobby_enter_group(identityKey, groupId)
LM → User:
  ✅ 已进入多会话模式 [group: my-sprint]
  成员：
    • @feat-auth      → s1（claude-code）
    • @feat-billing   → s2（claude-code）
    • @bugfix-stream  → s3（codex-cli）
  用法：
    @<name> <message>   派单给指定会话
    @all <message>      广播给所有
    /group              查看组状态
    /leave              退出多会话模式
```

#### 路径 B：快速命令（不走 LM）

```
User: /group new s1=feat-auth s2=feat-billing
```

`/group new` 是一个 channel-router 层的 slash command，直接调用同一组 MCP/REST API，不需要 LM 介入。适合熟手。

#### 路径 C：Web UI 一键进入

Web 端新增「Group」面板：用户勾选多个 sessions → 命名别名 → 「绑定到当前 channel peer」。后端推送 `channel.group-entered` 通知 channel 端。

### 4.2 多会话对话样态（以 WeCom 为例）

**用户输入**：

```
@feat-auth 帮我加一个 /api/login 接口，用 JWT
```

**channel 端展示**：

```
[user]
@feat-auth 帮我加一个 /api/login 接口，用 JWT

[think]【feat-auth】正在思考...

【feat-auth】
好的，我会先看一下现有的 auth 模块结构。
然后添加 /api/login 路由 + JWT 签发逻辑。

【feat-auth】
🔧 Read packages/server/src/auth.ts
✅ ...

【feat-auth】（最终回复）
已完成。涉及改动：
- src/routes/auth.ts: +42 行
- src/lib/jwt.ts: +28 行
测试：3 个用例全过。

⚙️ 状态：feat-auth ✅ idle  |  feat-billing 💤  |  bugfix-stream 🔄 running
```

关键点：

- 每条 session 消息都以 **`【alias】` 头**标识来源（已有 `formatAssistant` / `formatToolUse` 等格式化函数支持，需要在多会话模式下强制开启）。
- 末尾的「组状态行」是多会话模式独有的页脚（可配置开关），每条 final reply 后追加。
- 多个 session 并行回复时，每个 session 的 `stream_delta` 流必须用 **`sessionId` 维度独立流标识**（修复 `pendingReplies` 单 peerId 冲突问题）。

#### 并发回复处理

- 每个 session 单独有 `streamState`，按 sessionId × peerId 复合键管理（替代现状的单 peerId）。
- WeCom Provider 的 `pendingReplies` 改为 `Map<peerId+sessionId, {frame, streamId}>`，确保两个 session 同时刷 `<think>` 不相互覆盖。
- 节流仍是 800ms / session，但多 session 同时刷新时整体频率上限通过 channel 层的全局 token bucket 控制（避免 WeCom 限流）。

### 4.3 多会话管理命令（channel 端）

| 命令 | 行为 |
|------|------|
| `/group` | 显示当前组状态（成员、活跃度、默认派发目标）。 |
| `/group new <alias1>=<sessionId1> ...` | 用现有 sessions 创建新组（不存在则报错，让用户先建 session）。 |
| `/group add <alias>=<sessionId>` | 往当前组加成员。 |
| `/group remove <alias>` | 从当前组移除成员（session 本身不删除）。 |
| `/group rename <alias> <new-alias>` | 改成员别名。 |
| `/group default <alias>` | 设置默认派发目标。 |
| `/group mute <alias>` | 静音某成员（仍接收派单，但输出不推到 channel）。 |
| `/group unmute <alias>` | 取消静音。 |
| `/leave` | 退出多会话模式，回到 LM。组保留在 DB 中可后续 `/group resume <id>` 恢复。 |
| `/group destroy` | 销毁组（成员 session 不删）。 |

`/exit` 在多会话模式下解释为「退出当前组 = `/leave`」，保持语义直觉一致。

### 4.4 错误与边界

| 情形 | 行为 |
|------|------|
| `@unknown 你好` | 回复「未知成员 unknown，可用：feat-auth, feat-billing」，不派单。 |
| 派给已 stopped 的 session | 提示「@feat-auth 当前已停止，使用 `/group recover feat-auth` 恢复」。 |
| 派给等待审批的 session | 正常派单，但 channel 会先收到一条提示「@feat-auth 还在等待上一条审批」。 |
| `@all` 没有任何活跃成员 | 提示「当前组无可派单成员」。 |
| 多会话模式下用户在 Web UI 把组里某个 session 删了 | 后端自动 `lobby_remove_session_from_group`，channel 通知「@feat-auth 已被销毁，已从组中移除」。 |

---

## 5. LM 角色升级

### 5.1 系统 prompt 增量

在 `lobby-manager.ts:17-81` 现有 system prompt 基础上，新增「多会话编排」章节：

```
## Multi-Session Orchestration

You may operate channel users in two modes:

1. SINGLE-SESSION ROUTING (default): one user ↔ one session at a time.
2. MULTI-SESSION GROUP: one user ↔ a named group of sessions, addressed via @{alias}.

ENTER multi-session mode ONLY when the user explicitly asks (e.g. "I want to work
on multiple things in parallel", "create a group with X, Y, Z"). Never enter it
unprompted.

To enter, ensure target sessions exist (create via lobby_create_session if needed),
then call lobby_create_session_group with explicit aliases and lobby_enter_group.

While in multi-session mode you are EVEN MORE strictly a router:
- You will only receive messages the user sent to you directly (no @prefix), not
  messages routed to group members.
- Your job is to summarize, recover failing members, add/remove sessions, or
  re-route. Never execute coding tasks.

EXIT via lobby_leave_group (typically triggered by user `/leave`).
```

### 5.2 新增 MCP 工具

新增到 `mcp-server.ts` + `mcp-api.ts` + `LM_ALLOWED_TOOLS`：

| 工具 | 入参 | 出参 |
|------|------|------|
| `lobby_create_session_group` | `identityKey, name?, members: [{sessionId, alias}]` | `{ groupId }` |
| `lobby_list_session_groups` | `identityKey?` | `groups[]` |
| `lobby_session_group_info` | `groupId` | `SessionGroup` |
| `lobby_add_session_to_group` | `groupId, sessionId, alias` | `ok` |
| `lobby_remove_session_from_group` | `groupId, sessionId` | `ok` |
| `lobby_rename_group_member` | `groupId, oldAlias, newAlias` | `ok` |
| `lobby_set_group_default_member` | `groupId, alias` | `ok` |
| `lobby_enter_group` | `identityKey, groupId` | `ok` |
| `lobby_leave_group` | `identityKey` | `ok` |
| `lobby_destroy_session_group` | `groupId` | `ok` |
| `lobby_broadcast_to_group` | `groupId, message` | `dispatchedTo: alias[]` |

### 5.3 LM 不会看到组内消息

关键约束：进入多会话模式后，channel inbound 路由会**先解析 `@alias`**，命中后直接派给对应 session，**不经过 LM**。只有以下消息会到 LM：

- 显式以 `@lobby` / `@manager` 开头的消息（保留入口跟 LM 对话）。
- `/group` / `/leave` 等管理命令（由 channel-router 直接处理，不经过 LM —— 这与现状一致）。
- 没有 `defaultMember` 且没带 `@` 前缀的消息（fallback 到 LM，由它指导用户）。

---

## 6. 实现切面

### 6.1 受影响的文件清单

| 文件 | 改动性质 | 摘要 |
|------|---------|------|
| `packages/core/src/channel.ts` | 扩展类型 | `SessionGroup`、`SessionGroupMember`、`BindingTarget` discriminated union；`ChannelBinding` 新增 `groupId?` |
| `packages/core/src/protocol.ts` | 新增协议消息 | `channel.create-group / list-groups / enter-group / leave-group / update-group`；服务端反向 `channel.group-entered / group-left / group-updated / group-message` |
| `packages/server/src/db.ts` | schema 迁移 | 新表 `session_groups`、`session_group_members`；迁移 `idx_binding_active_session` 约束位置 |
| `packages/server/src/channel-router.ts` | 核心改造 | inbound 解析 `@alias`、outbound 头标识强制开启、`lastSenderBySession` 改为 `Map<sessionId, identityKey[]>`、新增 `/group` slash 处理 |
| `packages/server/src/channels/wecom.ts` | 流式 key 升级 | `pendingReplies` key 改为 `peerId:sessionId` |
| `packages/server/src/lobby-manager.ts` | prompt + 允许工具列表 | 新增多会话章节、扩展 `LM_ALLOWED_TOOLS` |
| `packages/server/src/mcp-server.ts` | 注册新工具 | 11 个 `lobby_*_group` 工具 |
| `packages/server/src/mcp-api.ts` | REST 端点 | 对应 11 个 endpoint |
| `packages/server/src/session-manager.ts` | 事件传播 | `session.destroyed` 时同步清理 group 成员 |
| `packages/web/*` | UI | Group 面板、Room 列表中标识"组内会话"、聚合视图（可选 P2） |
| `packages/server/src/__tests__/*` | 测试 | 新增 group 路由、@alias 解析、并发流式回复、迁移兼容测试 |

### 6.2 数据迁移

新增表（在 `db.ts` schema bootstrap 中追加 idempotent CREATE）：

```sql
CREATE TABLE IF NOT EXISTS session_groups (
  id              TEXT PRIMARY KEY,
  identity_key    TEXT NOT NULL,
  name            TEXT,
  default_member  TEXT,                  -- alias
  mode            TEXT DEFAULT 'multi-session',
  created_at      INTEGER NOT NULL,
  last_active_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_group_identity
  ON session_groups(identity_key);

CREATE TABLE IF NOT EXISTS session_group_members (
  session_id   TEXT PRIMARY KEY,         -- 一个 session 只能进一个组
  group_id     TEXT NOT NULL,
  alias        TEXT NOT NULL,
  muted        INTEGER DEFAULT 0,
  joined_at    INTEGER NOT NULL,
  FOREIGN KEY (group_id) REFERENCES session_groups(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_group_alias
  ON session_group_members(group_id, alias);
```

**`channel_bindings.active_session_id` UNIQUE 索引的处理**：

- 保留索引现状（不破坏旧版本兼容）。
- 多会话模式下，`active_session_id` 字段不再写入具体 sessionId（保持 NULL），「占用语义」迁移到 `session_group_members.session_id` PRIMARY KEY 约束。
- 单 session 直绑场景，`active_session_id` 行为完全不变。

### 6.3 协议增量

```typescript
// Client → Server
type CreateGroup    = { type: 'channel.create-group'; identityKey: string; members: GroupMemberInit[]; name?: string };
type EnterGroup     = { type: 'channel.enter-group'; identityKey: string; groupId: string };
type LeaveGroup     = { type: 'channel.leave-group'; identityKey: string };
type UpdateGroup    = { type: 'channel.update-group'; groupId: string; ops: GroupUpdateOp[] };
type ListGroups     = { type: 'channel.list-groups'; identityKey?: string };

// Server → Client
type GroupEntered   = { type: 'channel.group-entered'; identityKey: string; group: SessionGroup };
type GroupLeft      = { type: 'channel.group-left'; identityKey: string };
type GroupUpdated   = { type: 'channel.group-updated'; group: SessionGroup };
type GroupsList     = { type: 'channel.groups-list'; groups: SessionGroup[] };
```

### 6.4 关键算法：inbound 多会话路由

伪代码（替换 `channel-router.ts:handleInbound` 中常规路由分支）：

```typescript
async function routeInbound(msg, binding) {
  const target = parseTarget(binding.target);

  // 1. 多会话模式
  if (target.kind === 'group') {
    const group = await getGroup(target.groupId);
    const { alias, payload } = parseAtPrefix(msg.text, group.members);

    if (alias === '@manager' || alias === '@lobby') {
      return routeToSession(group.identityKey, lobbyManagerSessionId, payload);
    }
    if (alias === 'all') {
      return Promise.all(
        group.members.filter(m => !m.muted)
          .map(m => routeToSession(group.identityKey, m.sessionId, payload, m.alias))
      );
    }
    if (alias) {
      const member = group.members.find(m => m.alias === alias);
      if (!member) return sendInfo(`Unknown member @${alias}`);
      await setDefaultMember(group.id, alias);
      return routeToSession(group.identityKey, member.sessionId, payload, member.alias);
    }
    // 无 @ 前缀
    if (group.defaultMember) {
      const member = group.members.find(m => m.alias === group.defaultMember);
      return routeToSession(group.identityKey, member.sessionId, payload, member.alias);
    }
    return sendInfo('Please prefix with @name to address a member.');
  }

  // 2. 单 session 直绑（现状）
  if (target.kind === 'session') return routeToSession(binding.identityKey, target.sessionId, msg.text);

  // 3. LM 路由（现状）
  return routeToSession(binding.identityKey, lobbyManagerSessionId, msg.text);
}
```

### 6.5 关键算法：outbound 聚合反查

```typescript
function resolveResponseTargets(sessionId): Array<{ identityKey, alias? }> {
  // 1. 组成员？
  const member = db.getGroupMemberBySession(sessionId);
  if (member) {
    if (member.muted) return [];
    const group = db.getGroup(member.group_id);
    return [{ identityKey: group.identity_key, alias: member.alias }];
  }
  // 2. 旧逻辑（lastSenderBySession + active_session_id + 全表兜底）
  return legacyResolve(sessionId);
}
```

每条 outbound 消息在格式化前 prepend `【${alias}】` 头（多会话模式必带，单 session 模式可选）。

### 6.6 并发流式回复

- `WecomProvider.pendingReplies` 键改为 `${peerId}::${sessionId}`。
- `channel-router.ts` 的 `streamStates`、`toolAggregates`、`pendingQuestions` 同样改为按 `sessionId` 维度独立（这些当前已经基本按 sessionId 维度，需补全）。
- 引入 channel 全局 token bucket（默认 5 msg/sec），多 session 同时 burst 时排队，避免触发 WeCom 频控。

---

## 7. 分阶段实现计划

### Phase 1 —— Core schema + 后端骨架（~2-3 天）

1. `db.ts`：新增 `session_groups`、`session_group_members` 表与索引。
2. `channel.ts`：新增 `SessionGroup`、`SessionGroupMember`、`BindingTarget` 类型。
3. `db.ts`：新增 `createGroup / getGroup / listGroupsByIdentity / addMember / removeMember / setDefaultMember / getGroupMemberBySession / destroyGroup` 等存取函数。
4. 单元测试：迁移兼容、约束（一个 session 只能进一个 group）、并发写入。

**完成标准**：DB 层 100% 测试覆盖；不动 router / LM。

### Phase 2 —— Channel router 多会话路由（~3-4 天）

1. `channel-router.ts`：扩展 `parseTarget` / `resolveSessionId`；新增 `parseAtPrefix`、`resolveResponseTargets`。
2. inbound `@alias` 解析、unknown alias 回错、`@all` 广播、`defaultMember` fallback。
3. outbound `【alias】` 头格式化（多会话模式强制）。
4. 新增 `/group` slash 子命令族。
5. `lastSenderBySession` 升级为 sessionId-keyed 多 sender 数组（保留旧路径 fallback）。
6. 集成测试：模拟 inbound `@feat-auth 你好` → 派单到 s1；模拟 s1 输出 → 带 `【feat-auth】` 头回 channel。

**完成标准**：单 session、LM、多会话 三种模式在测试中全绿；旧测试零回归。

### Phase 3 —— WeCom Provider 并发流式回复（~1-2 天）

1. `wecom.ts`：`pendingReplies` 改复合键。
2. 引入全局 token bucket。
3. 集成测试：两个 session 同时刷 `stream_delta` → channel 端能看到两条独立的 `<think>` 流，互不覆盖。

### Phase 4 —— LM MCP 工具 + system prompt（~2 天）

1. `mcp-server.ts` / `mcp-api.ts`：新增 11 个 `lobby_*_group` 工具与 REST 端点。
2. `lobby-manager.ts`：扩展 `LM_ALLOWED_TOOLS`、追加 system prompt 多会话章节。
3. 端到端测试：在 LM session 里手动调 MCP 工具创建组、入组、出组。

### Phase 5 —— 协议 + Web UI（~3-4 天）

1. `protocol.ts`：新增 5 个 client → server + 4 个 server → client 消息。
2. `ws-handler.ts`：处理新协议。
3. Web 端：
   - Sidebar 标识「组内会话」。
   - 新增 Group 管理面板（创建组、改别名、设置 default、销毁）。
   - Room 头部显示「当前所属组」徽标。
4. （可选 P2）Web 端「聚合视图」：把当前组的所有 sessions 并排展示。

### Phase 6 —— 文档 + Release（~1 天）

1. 更新 `docs/architecture.md` 增加多会话章节。
2. 更新 README 增加 channel 端 `@name` 用法演示动图。
3. 更新 `CHANGELOG.md`。
4. 通过 `/release` 命令发版。

---

## 8. 风险与未决问题

| # | 风险 | 缓解 |
|---|------|------|
| R1 | 多会话同时审批时，channel 端审批卡片混乱 | 卡片标题强制带 `【alias】`；审批 callback 解析时按 sessionId 路由（现状已支持） |
| R2 | WeCom 频控（5000 msg/分钟级），多 session 同 burst | 全局 token bucket + per-session 800ms 节流 |
| R3 | `@all` 广播带来的消息洪水 | 文档提示，可配置组级开关 `allowBroadcast: false` |
| R4 | 用户在多会话模式下误删一个 session | session-manager `destroyed` 事件 → router 自动 `removeMember`，channel 通知 |
| R5 | LM 在多会话模式下"看不到"组内消息，可能影响诊断能力 | 提供 `lobby_session_group_info` 让 LM 查询，但不订阅消息流 |
| Q1 | 是否允许同一 sessionId 跨 peer 的多个 group？ | 当前设计否定（`session_group_members.session_id` 是 PK），保持简单 |
| Q2 | `@alias` 解析是否支持中文别名？ | 一期不支持，仅 `[a-z][a-z0-9-]{0,31}`；二期评估 |
| Q3 | 多会话模式下 Plan Mode 是组级还是成员级？ | 成员级（每个 session 自己的 Plan Mode 状态），channel 端 `/group plan @alias on` 单点切换 |

---

## 9. 决策清单（请评审者表态）

1. **进入方式优先级**：LM 引导（路径 A）vs slash 命令（路径 B）哪个作为「主路径」对外文档示例？
   建议：A 作为面向新用户的主路径，B 作为熟手快捷方式。
2. **`@all` 是否默认启用**？
   建议：默认启用，但提供 `/group config no-broadcast` 关闭。
3. **WeCom 之外的 channel（Telegram / Feishu）是否同期支持**？
   建议：本提案仅承诺 WeCom；其它 channel 实现时同步适配（接口已抽象）。
4. **Web UI 聚合视图（Phase 5 P2）是否纳入首版**？
   建议：不纳入首版，先把 channel 端跑通；Web 端 Phase 5 只做组管理面板。
5. **是否允许多会话模式下的 session 已经被另一个 peer 直接绑定**？
   建议：不允许，添加成员时检查 `active_session_id` 与 `session_group_members.session_id` 双约束。

---

## 10. 后续动作

本文档为 **brainstorming 阶段产出物**。下一步需要：

1. 评审者在 §9 表态后定稿。
2. 进入 `/superpowers:writing-plans`，对 Phase 1-6 每个阶段产出可执行的 plan 文件。
3. 进入 `/superpowers:subagent-driven-development`，按 plan 分派 subagent 实现。

——以上。

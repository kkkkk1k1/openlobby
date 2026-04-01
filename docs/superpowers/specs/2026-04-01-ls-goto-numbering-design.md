# /ls + /goto 序号快捷跳转 — Design Spec

**Date:** 2026-04-01
**Scope:** 给 /ls 输出加序号，/goto 支持用序号切换会话

## 问题

在 IM 中使用 `/goto` 需要输入会话名称或 12 位 ID 前缀，非常不便。

## 方案

### /ls 输出加序号

```
📋 **会话列表** (3)

1. 🟢 **ProjectA** (abc123…) [claude-code] — running
2. 🟡 **修复登录bug** (xyz789…) [codex-cli] — idle
3. 🟡 **代码审查** (def456…) [opencode] — idle
```

### /goto 支持序号

`/goto 1` → 切换到 ProjectA

### 匹配优先级

`findSessionByIdOrName` 增加序号匹配（最高优先级）：

1. **纯数字 → 序号匹配**（从最近一次 /ls 的缓存列表取）
2. 精确 ID 匹配
3. ID 前缀匹配
4. 名字模糊匹配

### 序号缓存

- 在 `slash-commands.ts` 模块级维护一个 `lastLsResult: Map<string, SessionSummary[]>`，key 为调用者标识（Web 用 `'web'`，IM 用 `identityKey`）
- 每次 `/ls` 执行时更新缓存
- `/goto` 时读取对应调用者的缓存
- 无需持久化，内存即可

### 改动文件

| 文件 | 改动 |
|------|------|
| `packages/server/src/slash-commands.ts` | /ls 加序号输出 + 缓存；findSessionByIdOrName 加序号匹配参数 |
| `packages/server/src/channel-router.ts` | IM 侧 /goto 传入 identityKey 以读取对应缓存 |

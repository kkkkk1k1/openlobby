# Version Check & Auto-Update Design

> Date: 2026-04-14
> Status: Approved

## 1. Overview

为 OpenLobby CLI 增加版本检查与自动更新功能。Web 前端定时检查 npm registry 是否有新版本，用户可一键更新并自动重启服务。LobbyManager 也提供 MCP tool 供对话中触发检查和更新。

## 2. Goals

- Web 页面打开时检查版本，之后每 30 分钟轮询一次
- 有新版本时在 Web 端展示更新按钮
- 全局安装用户可一键更新 + 自动重启
- npx 用户仅提示，不执行更新
- LobbyManager 新增 MCP tool 支持对话中检查/更新

## 3. Architecture

```
openlobby (CLI entry)
  └── Wrapper process (bin.ts)
        ├── fork → Server child process (server-main.ts)
        │     ├── createServer()
        │     ├── VersionChecker — query npm registry
        │     ├── GET /api/version — frontend polling endpoint
        │     ├── POST /api/update — trigger update
        │     └── WebSocket → notify frontend of update status
        └── Listen IPC messages from child
              ├── { type: 'ready' } → server started successfully
              ├── { type: 'update-and-restart' } → npm install -g → kill old → fork new
              └── child unexpected exit → log error, wrapper exits
```

## 4. Wrapper Process

### 4.1 Responsibility

bin.ts 改造为轻量 Wrapper（约 40-60 行），职责：

1. 解析 CLI 参数（`--port`, `--version`, `--help`）
2. `fork('./server-main.js')` 启动 server 子进程，传递参数
3. 监听子进程 IPC 消息
4. 收到 `update-and-restart` 时执行更新 + 重启

### 4.2 server-main.ts（新文件）

原 bin.ts 的业务逻辑迁移至此，作为子进程入口：

- 接收参数，调用 `createServer()`
- 启动成功后 `process.send({ type: 'ready' })`
- `POST /api/update` 被调用时 `process.send({ type: 'update-and-restart' })`

### 4.3 Update Flow (Wrapper Side)

```
收到 { type: 'update-and-restart' }
  → execSync('npm install -g openlobby@latest')
  → 成功：kill 旧子进程 → fork 新子进程（相同参数）
  → 失败：不 kill 旧进程，IPC 通知 server { type: 'update-failed', error }
```

### 4.4 esbuild Build Adjustment

`build.mjs` 打包两个独立入口：

- `dist/bin.js` — Wrapper（轻量，不 bundle server）
- `dist/server-main.js` — 实际服务

`packages/cli/package.json` 的 files 字段加入 `dist/server-main.js`。

## 5. VersionChecker

### 5.1 Location

`packages/server/src/version-checker.ts`

### 5.2 Interface

```typescript
interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  installMode: 'global' | 'npx';
}

class VersionChecker {
  constructor(db: Database, currentVersion: string);
  check(): Promise<VersionCheckResult>;
  getInstallMode(): 'global' | 'npx';
}
```

### 5.3 Behavior

- `check()` 调用 `https://registry.npmjs.org/openlobby/latest` 获取最新版本
- 24 小时缓存：利用 `server_config` 表存储 `last_version_check` 时间戳和 `latest_remote_version`
- 缓存未过期时直接返回缓存结果，不请求 npm
- fetch 超时 5 秒，失败静默忽略，返回 `{ hasUpdate: false, latest: null }`
- 使用 semver 比对：`latest > current` → `hasUpdate = true`

### 5.4 Install Mode Detection

- 检查 `process.argv[1]` 路径是否包含 `_npx` 相关目录
- 结果为 `'global' | 'npx'`

## 6. Server API Endpoints

### 6.1 GET /api/version

调用 `versionChecker.check()` 返回：

```json
{
  "current": "0.5.3",
  "latest": "0.6.0",
  "hasUpdate": true,
  "installMode": "global"
}
```

### 6.2 POST /api/update

- 加锁，正在更新时返回 `{ status: "already-updating" }`
- 检查 installMode：npx 用户返回 `{ status: "npx-hint", message: "..." }`
- 全局安装用户：`process.send({ type: 'update-and-restart' })`，返回 `{ status: "updating" }`

## 7. LobbyManager MCP Tools

在 LobbyManager 现有 MCP tools 中新增两个 tool：

### 7.1 lobby_check_update

- 描述：检查 OpenLobby 是否有新版本可用
- 参数：无
- 行为：调用 `versionChecker.check()`
- 返回：当前版本、最新版本、是否有更新、安装方式

### 7.2 lobby_update_server

- 描述：更新 OpenLobby 到最新版本并自动重启
- 参数：无
- 行为：先检查版本，无更新则返回"已是最新"；有更新则触发 `POST /api/update` 同等逻辑
- 返回：更新结果（成功触发/失败/npx 模式提示）

## 8. Web Frontend

### 8.1 useVersionCheck Hook

`packages/web/src/hooks/useVersionCheck.ts`

```typescript
interface VersionState {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  installMode: 'global' | 'npx';
  checking: boolean;
}
```

行为：
- mount 时立即 `GET /api/version`
- 每 30 分钟轮询
- `visibilitychange`: hidden 暂停，visible 立即检查并恢复轮询

### 8.2 Sidebar Version Area

改造 `packages/web/src/components/Sidebar.tsx` 底部版本区域：

- **无更新**：`v0.5.3` 不变
- **有更新**：版本号旁出现更新图标按钮，hover 显示 "vX.Y.Z 可用"

### 8.3 UpdateDialog Component

新增 `packages/web/src/components/UpdateDialog.tsx`

**全局安装用户**：
1. 确认框："确认更新到 vX.Y.Z？更新后服务将自动重启。"
2. 确认 → `POST /api/update` → 按钮变为"更新中..."禁用
3. WebSocket 断连 → 显示"服务重启中..."
4. 重连成功 → `location.reload()` 刷新页面

**npx 用户**：
1. 提示框："新版本 vX.Y.Z 可用。你正在使用 npx 运行，下次执行 `npx openlobby` 时将自动使用最新版本。"

### 8.4 Reconnection

断连后每 2 秒尝试重连，重连成功后 `location.reload()` 刷新页面加载新版前端资源。

## 9. Error Handling

### 9.1 Update Failure

- Wrapper 执行 npm install 失败 → 不 kill 旧进程
- IPC 通知 server `{ type: 'update-failed', error }` → WebSocket 推送前端
- 前端显示："更新失败：xxx，服务未受影响"

### 9.2 Permission Denied

- 更新前检测全局 node_modules 路径是否可写
- 不可写 → 返回错误，前端提示："更新需要管理员权限，请在终端手动执行 `sudo npm install -g openlobby@latest`"

### 9.3 Child Process Start Failure

- Wrapper fork 新子进程后等待 `{ type: 'ready' }` 消息
- 超时 30 秒 → 记录错误日志，Wrapper 退出
- 不回滚旧版本

### 9.4 Concurrent Update

- `POST /api/update` 加锁
- 正在更新时再次请求返回 `{ status: "already-updating" }`

## 10. File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/bin.ts` | Modify | Refactor to Wrapper: fork + listen + update-restart |
| `packages/cli/src/server-main.ts` | Create | Child process entry, migrated from bin.ts |
| `packages/cli/build.mjs` | Modify | Add server-main.js entry, inject version |
| `packages/cli/package.json` | Modify | Add `dist/server-main.js` to files |
| `packages/server/src/version-checker.ts` | Create | VersionChecker class |
| `packages/server/src/index.ts` | Modify | Register `/api/version`, `/api/update`; send IPC ready |
| `packages/server/src/lobby-manager.ts` | Modify | Add `lobby_check_update`, `lobby_update_server` MCP tools |
| `packages/web/src/hooks/useVersionCheck.ts` | Create | Version polling hook |
| `packages/web/src/components/Sidebar.tsx` | Modify | Update button in version area |
| `packages/web/src/components/UpdateDialog.tsx` | Create | Update confirmation/hint dialog |

**Unchanged**:
- `packages/core/` — no type changes needed
- Database schema — reuse existing `server_config` table
- Existing WebSocket protocol — only add new message types

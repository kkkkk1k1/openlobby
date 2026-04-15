# Process Manager-Aware Auto-Upgrade Design

> Date: 2026-04-15
> Status: Draft

## 1. Overview

当前自动升级采用 Wrapper + Child 双层架构：Wrapper 常驻内存执行 `npm install -g` 后 fork 新 Child。在 pm2 / systemd / docker 等进程管理器下存在以下问题：

1. **Wrapper 代码不更新**：npm install 替换磁盘文件后，Wrapper 仍运行旧版内存代码，如果新旧 Wrapper 不兼容会出错
2. **pm2 --watch 冲突**：文件变化触发 pm2 额外重启，与 Wrapper 内部重启产生竞态
3. **版本传递不准确**：Wrapper 以硬编码 `VERSION` 常量传递给 Child，升级后 Child 收到的仍是旧版本号

## 2. Goals

- 进程管理器（pm2、systemd、docker --restart）下自动升级 **Wrapper 和 Child 均加载新版本代码**
- 直接运行（无进程管理器）的行为 **完全不变**
- 前端体验不变：更新中 → 断连 → 重连后刷新
- 不引入额外依赖

## 3. Non-Goals

- 不处理 npx 用户（已有提示逻辑）
- 不处理 docker image 升级（需用户 pull 新镜像，超出 CLI 范围）
- 不做版本回滚

## 4. Design

### 4.1 核心思路：升级后 Wrapper 主动退出，依赖进程管理器或自身重启

**策略选择**：

| 方案 | 优点 | 缺点 |
|------|------|------|
| A: Wrapper 升级后 `process.exit(0)`，靠 pm2 重启 | 简单，Wrapper 一定加载新代码 | 直接运行时 exit(0) 就真退出了 |
| B: 检测是否在 pm2 下，分策略 | 精准 | 检测逻辑复杂，还有 systemd 等 |
| C: Wrapper 升级后用 `execvp` 重新执行自身 | 通用，不依赖进程管理器 | Node.js 无原生 execvp |
| **D: 退出码约定 + 自重启回退** | 通用，简单 | 需要约定特殊退出码 |

**选择方案 D**：使用特殊退出码（`EXIT_CODE_RESTART = 75`）表示"需要重新启动"。

### 4.2 升级流程（新）

```
Child 发送 { type: 'update-and-restart' }
  → Wrapper 执行 npm install -g openlobby@latest
  → 成功：
      1. kill Child (SIGTERM)
      2. 等待 Child 退出
      3. 尝试 exec 重启自身（替换当前进程）
         - 成功 → 新 Wrapper 进程（新代码），fork 新 Child
         - 失败 → process.exit(75)
              - pm2/systemd 看到进程退出 → 重启 → 新 Wrapper + 新 Child ✓
              - 直接运行 → 进程退出，但退出码 75 是非正常退出
  → 失败：不 kill，通知 { type: 'update-failed' }
```

### 4.3 使用 child_process.execFile 实现"exec 重启"

Node.js 没有 POSIX `execvp`，但可以通过 `spawn` 并让当前进程退出来实现同等效果：

```typescript
import { spawn } from 'node:child_process';

function restartSelf(): void {
  const child = spawn(process.argv[0], process.argv.slice(1), {
    stdio: 'inherit',
    detached: true,
  });
  child.unref();
  process.exit(0);
}
```

**问题**：在 pm2 下，detached spawn 的子进程会被 pm2 视为孤儿。pm2 同时看到原进程 exit(0) 会试图重启，导致双重进程。

**更好的方式**：不用 detached spawn，直接退出让进程管理器负责重启。对于无进程管理器的场景，Wrapper 自行 re-exec。

### 4.4 最终方案：检测进程管理器 + 分策略

检测方式简单且可靠：

```typescript
function isUnderProcessManager(): boolean {
  return !!(
    process.env.PM2_HOME ||          // pm2
    process.env.pm_id ||             // pm2
    process.env.INVOCATION_ID ||     // systemd
    process.env.SUPERVISOR_ENABLED   // supervisord
  );
}
```

**有进程管理器**：`npm install -g` → kill Child → Wrapper `process.exit(0)` → pm2/systemd 自动重启全新进程

**无进程管理器**（直接运行）：保持现有行为 — kill 旧 Child → fork 新 Child（Wrapper 不退出）

### 4.5 版本号修正

当前 Wrapper 用硬编码 `VERSION` 常量传给 Child env `OPENLOBBY_VERSION`。升级后旧 Wrapper fork 新 Child 时传递的还是旧版本号。

修复：Child 启动时从自身 `package.json` 或构建时注入的 banner 读取版本号，不依赖 Wrapper 传递。

```typescript
// server-main.ts
import { readFileSync } from 'node:fs';

function getVersion(): string {
  // 优先读取磁盘上的实际版本（升级后是新版本）
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return process.env.OPENLOBBY_VERSION ?? '0.0.0';
  }
}
```

## 5. Detailed Changes

### 5.1 packages/cli/src/bin.ts

```typescript
const EXIT_CODE_RESTART = 75;

function isUnderProcessManager(): boolean {
  return !!(
    process.env.PM2_HOME ||
    process.env.pm_id ||
    process.env.INVOCATION_ID ||
    process.env.SUPERVISOR_ENABLED
  );
}

// 在 update-and-restart 处理中：
proc.on('message', async (msg: any) => {
  if (msg?.type === 'update-and-restart') {
    const success = await performUpdate();
    if (success) {
      proc.removeListener('exit', exitHandler);
      proc.kill('SIGTERM');

      if (isUnderProcessManager()) {
        // 进程管理器负责重启，Wrapper 退出即可
        console.log('[Wrapper] Update complete. Exiting for process manager to restart...');
        proc.on('exit', () => process.exit(0));
      } else {
        // 直接运行：Wrapper 内部重启 Child
        console.log('[Wrapper] Restarting server...');
        child = spawnServer(port, mcpApiPort);
        setupChildListeners(child);
      }
    } else {
      proc.send({ type: 'update-failed', error: 'npm install failed or permission denied' });
    }
  }
});
```

### 5.2 packages/cli/src/server-main.ts

```typescript
// 版本号从 package.json 读取，不再完全依赖 env
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    return process.env.OPENLOBBY_VERSION ?? '0.0.0';
  }
}

const version = getVersion();
```

### 5.3 server /api/update 端点 — 新增 installMode: 'pm2' 提示

不需要改动。无论是 pm2 还是直接运行，对 Child 来说都是发送 `update-and-restart` IPC 消息，区别由 Wrapper 处理。

## 6. Edge Cases

### 6.1 pm2 cluster mode

pm2 cluster mode 使用 `cluster.fork()`，不经过 bin.ts Wrapper。此场景下 `process.send` 不是发给 Wrapper 而是发给 pm2 master。

**处理**：检测 `cluster.isWorker`，若为 cluster mode 则 `/api/update` 返回错误提示用户使用 `pm2 restart` 手动重启。

### 6.2 pm2 --watch

用户如果开了 `--watch`，`npm install -g` 不会改变项目目录文件（改的是全局 node_modules），一般不会触发 watch。但如果 watch 目标恰好包含全局目录，仍可能冲突。

**处理**：文档中注明不要对全局安装目录开启 pm2 watch。

### 6.3 pm2 配置了 max_restarts 且已接近上限

Wrapper exit(0) 后 pm2 不计入 restart count（exit code 0 + stop_exit_codes 配置）。pm2 默认不限制 exit code 0 的重启。安全。

### 6.4 systemd

systemd 的 `Restart=on-failure` 不会重启 exit(0) 进程。需要用户配置 `Restart=always` 或 `Restart=on-success`。

**处理**：文档中注明 systemd 用户需配置 `Restart=always`。

## 7. File Changes

| File | Action | Description |
|------|--------|-------------|
| `packages/cli/src/bin.ts` | Modify | 添加 `isUnderProcessManager()` 检测，升级后分策略处理 |
| `packages/cli/src/server-main.ts` | Modify | 版本号从 package.json 读取 |
| `packages/server/src/index.ts` | Modify | 检测 cluster mode，/api/update 增加 cluster 场景提示 |

## 8. Testing Strategy

- 单元测试 `isUnderProcessManager()` 对各种环境变量组合的检测
- 集成测试：mock `process.env.pm_id` 验证 Wrapper 在升级后 exit 而非 fork
- 手动测试：pm2 start openlobby → 触发升级 → 验证 pm2 重启 → 新版本生效

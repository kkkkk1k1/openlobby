<p align="center">
  <h1 align="center">OpenLobby</h1>
  <p align="center">AI 编程智能体统一会话管理器</p>
  <p align="center">
    <a href="../README.md">English</a> | <a href="README.zh-CN.md">中文</a>
  </p>
</p>

---

在 IM 风格的 Web 界面中管理 Claude Code 和 Codex CLI 会话。OpenLobby 让你在一个浏览器标签页中运行、监控和切换多个 AI 编程智能体会话 —— 就像是你的编程智能体的"聊天应用"。

## 功能特性

- **多智能体支持** — Claude Code（通过 `claude-agent-sdk`）和 Codex CLI（通过 `codex app-server` + JSON-RPC）
- **IM 风格界面** — 实时流式输出、Markdown 渲染、工具调用可视化
- **工具审批** — 交互式批准/拒绝卡片，浏览器断线重连后仍可恢复
- **会话发现** — 自动检测并导入终端中创建的已有 CLI 会话
- **计划模式** — 只读规划模式，限制智能体仅进行分析
- **LobbyManager** — 内置元智能体，将请求路由到正确的会话（基于 MCP）
- **IM 通道绑定** — 将会话桥接到企业微信，可扩展至 Telegram / 飞书
- **持久化会话** — SQLite 会话索引；消息直接从 CLI 原生 JSONL 文件读取
- **一键启动** — `npx openlobby` 打包完整技术栈

## 架构

```
浏览器 (React + Zustand)
  ↕ WebSocket
Node.js 服务端 (Fastify)
  ├─ SessionManager ── 会话生命周期、消息路由
  ├─ LobbyManager ──── 会话管理元智能体 (MCP)
  ├─ ChannelRouter ─── IM 平台消息桥接
  └─ Adapters
       ├─ ClaudeCodeAdapter (claude-agent-sdk)
       └─ CodexCliAdapter   (codex app-server + JSON-RPC)
            ↕
       本地 CLI 二进制 (claude, codex)
```

> 详细架构文档请参阅 [docs/architecture.md](architecture.md)。

## 项目结构

```
packages/
├── core/       @openlobby/core     — 类型定义、Adapter 接口、协议、通道定义
├── server/     @openlobby/server   — Fastify 服务端、SessionManager、WebSocket、MCP、通道
├── web/        @openlobby/web      — React 前端 (Vite + Tailwind)
└── cli/        openlobby          — CLI 入口 & esbuild 打包分发
```

## 使用

### 前置条件

- Node.js >= 20
- 至少安装以下之一：[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 或 [Codex CLI](https://github.com/openai/codex)

### 快速开始

```bash
npx openlobby
```

这将在 3001 端口启动 OpenLobby 服务并打开 Web 界面。

```bash
# 自定义端口
npx openlobby --port 8080
```

## 开发

### 环境搭建

```bash
git clone <repo-url>
cd OpenLobby
pnpm install
```

### 开发模式

```bash
# 同时启动前后端
pnpm dev

# 或单独启动
pnpm --filter @openlobby/server dev   # 后端 (端口 3001)
pnpm --filter @openlobby/web dev      # 前端 (端口 5173)
```

### 构建

```bash
# 构建所有包
pnpm build

# 构建 CLI 发布包（包含服务端 + Web 资源）
pnpm build:cli
```

### 测试

```bash
pnpm test
```

## 核心概念

| 概念 | 说明 |
|------|------|
| **Adapter** | 抽象层 — 每个 CLI 实现一个 Adapter（ClaudeCode、CodexCLI） |
| **LobbyMessage** | 统一消息格式 — 所有 Adapter 的输出都标准化为此类型 |
| **SessionManager** | 管理会话生命周期：创建、恢复、销毁、消息路由 |
| **LobbyManager** | 通过 MCP 工具管理会话的元智能体（不执行编程任务） |
| **ChannelRouter** | 在 IM 平台和会话之间路由消息 |

## 技术栈

| 层级 | 技术 |
|------|------|
| 语言 | TypeScript（strict, ESM） |
| 前端 | React 19, Zustand, Tailwind CSS, Vite |
| 后端 | Fastify, WebSocket, MCP SDK |
| 数据库 | SQLite (better-sqlite3) — 仅存会话索引 |
| CLI 集成 | claude-agent-sdk, codex app-server (JSON-RPC) |
| 构建 | Vite（前端）, esbuild（CLI 打包）, tsc（包） |
| 包管理 | pnpm workspace |

## 贡献

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feat/my-feature`)
3. 提交更改并添加测试
4. 运行 `pnpm build && pnpm test` 验证
5. 提交 Pull Request

请遵循现有代码规范：ESM 导入、严格 TypeScript、接口优先设计。

## 许可证

MIT

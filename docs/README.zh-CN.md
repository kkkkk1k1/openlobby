<p align="center">
  <h1 align="center">OpenLobby</h1>
  <p align="center">AI 编程智能体统一会话管理器</p>
  <p align="center">
    <a href="../README.md">English</a> | <a href="README.zh-CN.md">中文</a>
  </p>
</p>

---

在 IM 风格的 Web 界面中管理 Claude Code 和 Codex CLI 会话。OpenLobby 让你在一个浏览器标签页中运行、监控和切换多个 AI 编程智能体会话 —— 就像是你的编程智能体的"聊天应用"。

**为 AI 编程 CLI 的重度用户打造。** 如果你每天都在使用 Claude Code 或 Codex CLI，发现自己在多个终端会话之间来回切换、搞不清哪个智能体在做什么、或者希望能用手机查看一个长时间运行的任务——OpenLobby 就是为你准备的。部署到服务器上，通过浏览器或 IM 随时随地访问，让所有智能体会话 7×24 小时持续运行，无需保持终端窗口打开。

## 为什么选择 OpenLobby？

**并行运行多个 AI 智能体，在一个地方统一管理。**

- **会话完全保真** — 会话与原生 CLI 100% 兼容。导入已有会话，或在终端中使用 `claude --resume` 恢复任意会话。数据不会丢失。
- **快速多任务** — 在 Web 界面中即时切换智能体会话。一个人可以同时运行 5 个、10 个甚至更多编程任务，每个都在独立的上下文中。
- **大厅经理 (LM)** — 一个专职的元智能体，只负责会话路由和管理。它不碰你的代码，不回答你的问题——只负责创建、查找和导航到正确的会话。每个会话的上下文保持干净独立。
- **单 IM，多会话** — 绑定企业微信或 Telegram，在一个聊天对话中切换多个会话。不需要为每个项目创建单独的机器人。使用 `/goto`、`/add`、`/exit` 导航，或让大厅经理自动路由。
- **交互式审批卡片** — 工具执行需要你的审批。丰富的卡片展示工具名称、输入参数和允许/拒绝按钮——Web 和 IM 均支持。对于 `AskUserQuestion` 调用，问答卡片支持单选和多选选项。
- **与本地 CLI 相同的安全性** — 每个会话的权限模式完全可配置（`default`、`plan`、`bypassPermissions`）。在默认模式下，每次文件写入、Shell 命令和工具调用都需要你的明确审批——与在终端中运行 CLI 完全一致。区别在于你现在可以从任何地方审批：浏览器、手机或任何 IM 客户端。

## 功能特性

- **多智能体支持** — Claude Code（通过 `claude-agent-sdk`）和 Codex CLI（通过 `codex app-server` + JSON-RPC）
- **IM 风格界面** — 实时流式输出、Markdown 渲染、工具调用可视化
- **工具审批** — 交互式批准/拒绝卡片，支持单选/多选问答卡片
- **会话发现** — 自动检测并导入终端中创建的已有 CLI 会话
- **计划模式** — 只读规划模式，限制智能体仅进行分析
- **大厅经理** — 内置元智能体，通过 MCP 工具路由请求到正确的会话
- **IM 通道绑定** — 将会话桥接到企业微信 / Telegram，可扩展至飞书等
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
       本地 CLI 工具 (claude, codex)
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

## 前置条件

### 安装 AI CLI 工具

OpenLobby 需要至少安装一个 AI 编程 CLI。

**Claude Code**（推荐）：

```bash
# 通过 npm 安装
npm install -g @anthropic-ai/claude-code

# 验证安装
claude --version
```

> 需要 Anthropic API 密钥。在环境变量中设置 `ANTHROPIC_API_KEY`，或在首次运行 `claude` 时进行认证。详见 [Claude Code 文档](https://docs.anthropic.com/en/docs/claude-code)。

**Codex CLI**（可选）：

```bash
# 通过 npm 安装
npm install -g @openai/codex

# 验证安装
codex --version
```

> 需要 OpenAI API 密钥。在环境变量中设置 `OPENAI_API_KEY`。详见 [Codex CLI 仓库](https://github.com/openai/codex)。

### 系统要求

- Node.js >= 20
- pnpm（仅开发需要）

## 快速开始

```bash
npx openlobby
```

启动 OpenLobby 服务，端口 3001，Web 界面访问 `http://localhost:3001`。

```bash
# 自定义端口
npx openlobby --port 8080

# 自定义 MCP 内部 API 端口（默认：服务端口 + 1）
npx openlobby --mcp-port 4002

# 或通过环境变量设置
OPENLOBBY_MCP_PORT=4002 npx openlobby
```

## 使用场景

### 多任务并行开发

打开 Web 界面，创建多个会话——一个做前端功能，一个做后端 API，一个写测试。在侧边栏中即时切换。每个会话有独立的 AI 上下文。你可以同时监控它们全部的进度。

### 导入和恢复 CLI 会话

已经在终端中运行了一个 Claude Code 会话？点击侧边栏的 **导入** 按钮发现并导入到 OpenLobby。之后你还可以在终端中恢复同一个会话：

```bash
# 恢复命令显示在会话头部
claude --resume <session-id>
```

会话在 OpenLobby 和原生 CLI 之间完全可移植。

### IM 驱动的会话管理

将你的企业微信或 Telegram 账号绑定到 OpenLobby。所有智能体会话都可以通过一个 IM 聊天对话访问：

```
你:     帮我写一个 todo app
LM:     建议创建新会话 "todo-app"，确认吗？
你:     确认
LM:     会话已创建并已切换，请在新会话中发送你的指令。
你:     用 React 写一个带 localStorage 持久化的 todo app
智能体: [在 todo-app 会话中开始工作...]

你:     /goto backend-api
        ✅ 已切换到会话: backend-api
你:     给 /users 接口加上分页
智能体: [在 backend-api 会话中开始工作...]
```

不需要为每个项目建单独的机器人。一个对话，多个会话。

### 随时随地审批工具

当智能体需要运行一个需要审批的工具时，你会收到一张交互式卡片——无论你在 Web 界面还是通过 IM 在手机上。对于 `AskUserQuestion` 调用，丰富的问答卡片让你直接从选项中选择（单选或多选）。

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

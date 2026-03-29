/**
 * Lobby Manager welcome message — shown once when a user first connects.
 * Used by both Web (ws-handler) and IM (channel-router).
 */
export const LM_WELCOME_TEXT = `👋 **欢迎使用 OpenLobby！**

我是大厅经理 (Lobby Manager)，专门负责管理你的 AI 编程会话——我不会直接帮你写代码，所有任务都在独立会话中完成。

**你可以直接告诉我你想做什么：**
• "帮我写一个 todo app" → 我会创建新会话并切换过去
• "列出所有会话" → 我会展示当前所有会话的状态
• "切换到 backend-api" → 我会帮你导航到对应会话
• "添加一个 Telegram 通道" → 我会配置 IM 通道
• "清理空闲会话" → 我会帮你关闭长时间未使用的会话

**快捷命令：**
\`/ls\` — 列出所有会话
\`/add [name]\` — 创建新会话
\`/goto <id|name>\` — 切换到指定会话
\`/rm <id|name>\` — 销毁指定会话
\`/exit\` — 返回大厅经理 (IM)
\`/info\` — 查看当前会话信息 (IM)
\`/help\` — 显示帮助`;

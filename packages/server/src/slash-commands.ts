/**
 * Shared slash command handler for both Web (ws-handler) and IM (channel-router).
 *
 * Returns the response text if the command was recognized, or null if not.
 * Commands are stateless — caller is responsible for side effects like
 * updating bindings or navigating sessions.
 */

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { SessionSummary, MessageMode } from '@openlobby/core';
import type { SessionManager } from './session-manager.js';

export interface SlashCommandContext {
  sessionManager: SessionManager;
  lmSessionId: string | null;
  /** The session to target for /stop — the session the user is currently viewing (not the LM session) */
  targetSessionId?: string;
  /** Caller identity for /ls cache (IM uses identityKey, web uses 'web') */
  callerKey?: string;
}

/**
 * Per-caller cache of the last /ls result, so /goto <number> can reference
 * sessions by their position in the most recent listing.
 */
const lastLsCache = new Map<string, SessionSummary[]>();

export interface SlashCommandResult {
  text: string;
  /** If the command created a session, its ID */
  createdSessionId?: string;
  /** If the command wants to navigate to a session */
  navigateSessionId?: string;
  /** If the command destroyed a session */
  destroyedSessionId?: string;
  /** If the command rebuilt a session */
  rebuiltSessionId?: string;
  /** If the command configured a session */
  configuredSessionId?: string;
}

/**
 * Parse and execute a slash command.
 * Returns null if the command is not recognized.
 */
export async function handleSlashCommand(
  input: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult | null> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ').trim();

  switch (cmd) {
    case '/help':
      return cmdHelp();
    case '/ls':
      return cmdLs(ctx);
    case '/add':
      return await cmdAdd(ctx, arg || undefined);
    case '/goto':
      return cmdGoto(ctx, arg);
    case '/exit':
      return { text: '✅ 已返回 Lobby Manager，请发送新指令。' };
    case '/stop':
      return await cmdStop(ctx);
    case '/rm':
      return await cmdRm(ctx, arg);
    case '/new':
      return null; // Needs session context — handled by caller
    case '/msg-only':
    case '/msg-tidy':
    case '/msg-total':
      return null; // Needs session context — handled by caller
    case '/info':
      return null; // Needs session context — handled by caller
    case '/bind':
      return null; // Needs identity context — handled by caller (IM only)
    case '/unbind':
      return null; // Needs identity context — handled by caller (IM only)
    default:
      return null;
  }
}

function cmdHelp(): SlashCommandResult {
  return {
    text: [
      '📋 **OpenLobby 快捷命令**',
      '',
      '`/help` — 显示此帮助信息',
      '`/ls` — 列出所有会话',
      '`/add [name]` — 创建新会话',
      '`/goto <序号|id|name>` — 切换到指定会话',
      '`/exit` — 返回 Lobby Manager',
      '`/stop` — 打断当前模型回复',
      '`/rm <id|name>` — 销毁指定会话',
      '`/info` — 查看当前会话信息',
      '`/new` — 重建当前会话的 CLI 进程',
      '`/msg-only` — 仅推送回复内容',
      '`/msg-tidy` — 工具调用折叠为摘要',
      '`/msg-total` — 推送全部消息',
      '`/bind <sessionId>` — 绑定到指定会话 (IM)',
      '`/unbind` — 解绑当前会话 (IM)',
    ].join('\n'),
  };
}

function cmdLs(ctx: SlashCommandContext): SlashCommandResult {
  const sessions = ctx.sessionManager.listSessions();
  const filtered = sessions.filter((s) => s.id !== ctx.lmSessionId);

  if (filtered.length === 0) {
    return { text: '📭 暂无会话。使用 `/add` 创建新会话。' };
  }

  // Cache for /goto <number> lookup
  const callerKey = ctx.callerKey ?? 'web';
  lastLsCache.set(callerKey, filtered);

  const lines = filtered.map((s, i) => {
    const statusIcon = s.status === 'running' ? '🟢'
      : s.status === 'idle' ? '🟡'
      : s.status === 'error' ? '🔴'
      : s.status === 'awaiting_approval' ? '🟠'
      : '⚫';
    const idShort = s.id.length > 12 ? s.id.slice(0, 12) + '…' : s.id;
    return `${i + 1}. ${statusIcon} **${s.displayName}** (${idShort}) [${s.adapterName}] — ${s.status}`;
  });

  return { text: `📋 **会话列表** (${filtered.length})\n\n${lines.join('\n')}` };
}

async function cmdAdd(
  ctx: SlashCommandContext,
  name?: string,
): Promise<SlashCommandResult> {
  try {
    const sessionName = name || `Session-${Date.now().toString(36)}`;
    const cwd = resolve(homedir(), '.agentlobby', 'lobby-manager', 'projects', sessionName.replace(/\s+/g, '-'));
    mkdirSync(cwd, { recursive: true });

    const session = await ctx.sessionManager.createSession(
      'claude-code',
      { cwd },
      sessionName,
    );

    return {
      text: `✅ 会话已创建: **${sessionName}**\nID: \`${session.id}\`\n已自动切换到新会话。`,
      createdSessionId: session.id,
      navigateSessionId: session.id,
    };
  } catch (err) {
    return { text: `⚠️ 创建会话失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function cmdGoto(ctx: SlashCommandContext, arg: string): SlashCommandResult {
  if (!arg) {
    return { text: '⚠️ 用法: `/goto <序号|id|name>`' };
  }

  const session = findSessionByIdOrName(ctx.sessionManager, arg, ctx.callerKey);
  if (!session) {
    return { text: `⚠️ 未找到匹配的会话: "${arg}"` };
  }

  return {
    text: `✅ 已切换到会话: **${session.displayName}** (\`${session.id.slice(0, 12)}\`)`,
    navigateSessionId: session.id,
  };
}

async function cmdRm(ctx: SlashCommandContext, arg: string): Promise<SlashCommandResult> {
  if (!arg) {
    return { text: '⚠️ 用法: `/rm <session_id 或 name>`' };
  }

  const session = findSessionByIdOrName(ctx.sessionManager, arg, ctx.callerKey);
  if (!session) {
    return { text: `⚠️ 未找到匹配的会话: "${arg}"` };
  }

  if (session.id === ctx.lmSessionId) {
    return { text: '⚠️ 不能销毁 Lobby Manager 会话。' };
  }

  try {
    await ctx.sessionManager.destroySession(session.id);
    return {
      text: `✅ 会话已销毁: **${session.displayName}** (\`${session.id.slice(0, 12)}\`)`,
      destroyedSessionId: session.id,
    };
  } catch (err) {
    return { text: `⚠️ 销毁会话失败: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function cmdStop(ctx: SlashCommandContext): Promise<SlashCommandResult> {
  const targetId = ctx.targetSessionId;
  if (!targetId) {
    return { text: '⚠️ 当前没有正在运行的会话。' };
  }
  await ctx.sessionManager.interruptSession(targetId);
  return { text: '⏹ 已打断模型回复。' };
}

/** Find a session by number (from /ls), ID (prefix match), or display name (case-insensitive) */
export function findSessionByIdOrName(
  sessionManager: SessionManager,
  query: string,
  callerKey?: string,
): SessionSummary | undefined {
  // Number match — reference the cached /ls result
  if (/^\d+$/.test(query)) {
    const cached = lastLsCache.get(callerKey ?? 'web');
    if (cached) {
      const idx = parseInt(query, 10) - 1; // 1-based → 0-based
      if (idx >= 0 && idx < cached.length) return cached[idx];
    }
  }

  const sessions = sessionManager.listSessions();
  const lowerQuery = query.toLowerCase();

  // Exact ID match
  const exactId = sessions.find((s) => s.id === query);
  if (exactId) return exactId;

  // ID prefix match
  const prefixMatch = sessions.find((s) => s.id.startsWith(query));
  if (prefixMatch) return prefixMatch;

  // Display name match (case-insensitive, partial)
  return sessions.find((s) => s.displayName.toLowerCase().includes(lowerQuery));
}

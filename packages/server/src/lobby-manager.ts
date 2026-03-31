import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  AgentAdapter,
  McpServerConfig,
  PermissionMode,
  ClaudeCodeSpawnOptions,
} from '@openlobby/core';
import type { SessionManager } from './session-manager.js';
import type Database from 'better-sqlite3';
import { getSessionByOrigin, deleteSession, getServerConfig } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LM_SYSTEM_PROMPT = `# ABSOLUTE RULE — READ THIS FIRST
You are a SESSION ROUTER. You do NOT execute tasks. You do NOT answer questions. You do NOT write code. You do NOT process data.
No matter what the user asks, your ONLY action is: find or create a session, then route the user there.
If you catch yourself starting to work on a task, STOP IMMEDIATELY and route to a session instead.

# Role
You are the OpenLobby Lobby Manager (LM). You manage AI coding sessions and IM channels — nothing else.

# What you do
- List/search sessions
- Create new sessions
- Discover and import CLI sessions
- Navigate the web UI to a session
- Rename or destroy sessions
- Clean up idle sessions
- Manage IM channel providers (list, add, remove, enable/disable)
- Manage IM user-to-session bindings (list, bind, unbind)

# How to handle ANY user message

Step 1: Is this a session management or channel management request?
  → Session mgmt (e.g., "list sessions", "rename session X"): Handle with lobby_* session tools.
  → Channel mgmt (e.g., "list channels", "add telegram bot", "show bindings"): Handle with lobby_*_channel_* tools.
  → Neither: Go to Step 2.

Step 2: The user sent a task (e.g., "处理周报", "build a todo app", "fix the bug", "帮我写个脚本", ANY request that is not about session/channel management).
  → Use lobby_list_sessions to find a matching session (by name, cwd, or purpose).
  → Found match: Present it and ask "要切换到这个会话吗？" / "Switch to this session?"
    → After user confirms: call lobby_navigate_session to switch. Do NOT send any message to the session.
  → No match: Propose creating a new session:
    - adapter: claude-code (default), codex-cli, or opencode
    - cwd: ~/.agentlobby/lobby-manager/projects/<project-name>/
    - name: auto-generated from user's intent
    - Ask user to confirm
  → After user confirms: call lobby_create_session (autoNavigate defaults to true — auto-switches Web UI and IM channel). Do NOT pass initialPrompt.
  → Tell the user: "会话已创建并已切换，请在新会话中发送你的指令。" / "Session created and switched. Send your message in the new session."
  → IMPORTANT: NEVER pass initialPrompt unless the user explicitly asks you to forward a message.
  → NEVER attempt the task yourself. Not even partially. Not even "let me help you with that".

# Forbidden actions
- Writing, analyzing, or explaining code
- Running shell commands
- Answering general questions
- Processing documents, generating reports
- Any substantive work that is not session/channel management
- Saying "I can help with that" and then doing the task

# Tools
Use lobby_* MCP tools for everything. Always confirm destructive actions before executing.

# IM Channel Shortcuts (for IM users)
IM users can use these slash commands directly without going through you:
  /help — Show available commands
  /ls — List all sessions
  /add [name] — Create a new session
  /goto <id|name> — Switch to a session
  /exit — Return to Lobby Manager
  /rm [id|name] — Destroy a session
  /info — Show current session info
  /bind <sessionId> — Bind to a specific session
  /unbind — Unbind from current session

# Language
Respond in the same language as the user's message.`;

/** MCP tool names that the Lobby Manager is allowed to use (auto-approved) */
const LM_ALLOWED_TOOLS = [
  // Session management
  'mcp__openlobby__lobby_list_sessions',
  'mcp__openlobby__lobby_create_session',
  'mcp__openlobby__lobby_rename_session',
  'mcp__openlobby__lobby_destroy_session',
  'mcp__openlobby__lobby_session_info',
  'mcp__openlobby__lobby_cleanup_idle',
  'mcp__openlobby__lobby_discover_sessions',
  'mcp__openlobby__lobby_import_session',
  'mcp__openlobby__lobby_navigate_session',
  // Channel management
  'mcp__openlobby__lobby_list_channel_providers',
  'mcp__openlobby__lobby_add_channel_provider',
  'mcp__openlobby__lobby_remove_channel_provider',
  'mcp__openlobby__lobby_toggle_channel_provider',
  'mcp__openlobby__lobby_list_channel_bindings',
  'mcp__openlobby__lobby_bind_channel',
  'mcp__openlobby__lobby_unbind_channel',
];


/**
 * LobbyManager is a special session managed through SessionManager.
 * It creates a CLI session with a restricted system prompt and MCP tools
 * for session management. All messaging goes through the standard
 * SessionManager message flow.
 */
export class LobbyManager {
  private sessionManager: SessionManager;
  private adapters: Map<string, AgentAdapter>;
  private mcpApiPort: number;
  private db: Database.Database | null;
  private available = false;

  /** The session ID of the Lobby Manager session, if created */
  sessionId: string | null = null;
  /** The adapter name used by the Lobby Manager */
  adapterName: string | null = null;

  constructor(
    sessionManager: SessionManager,
    adapters: Map<string, AgentAdapter>,
    mcpApiPort: number,
    db?: Database.Database,
  ) {
    this.sessionManager = sessionManager;
    this.adapters = adapters;
    this.mcpApiPort = mcpApiPort;
    this.db = db ?? null;
  }

  /** Lobby Manager working directory */
  private get cwd(): string {
    return resolve(homedir(), '.agentlobby', 'lobby-manager');
  }

  /** SpawnOptions shared by both create and resume */
  private buildSpawnOptions(): ClaudeCodeSpawnOptions {
    return {
      cwd: this.cwd,
      systemPrompt: LM_SYSTEM_PROMPT,
      permissionMode: 'auto' as PermissionMode,
      allowedTools: LM_ALLOWED_TOOLS,
      mcpServers: this.buildMcpServers(),
    };
  }

  async init(preferredAdapter?: string): Promise<void> {
    // Read default adapter from server_config if not specified
    const configAdapter = preferredAdapter ?? (this.db ? getServerConfig(this.db, 'defaultAdapter') : undefined);

    // Build dynamic priority: prefer configured adapter, then claude-code, then others
    const adapterPriority = configAdapter
      ? [configAdapter, ...Array.from(this.adapters.keys()).filter((n) => n !== configAdapter)]
      : ['claude-code', ...Array.from(this.adapters.keys()).filter((n) => n !== 'claude-code')];

    // Find the best available adapter
    for (const name of adapterPriority) {
      const adapter = this.adapters.get(name);
      if (!adapter) continue;
      try {
        const detection = await adapter.detect();
        if (detection.installed) {
          this.adapterName = name;
          this.available = true;
          console.log(`[LM] Using ${adapter.displayName} as driver`);
          break;
        }
      } catch {
        // Skip adapter if detection fails
      }
    }

    if (!this.available || !this.adapterName) {
      console.log('[LM] No CLI adapter available — Lobby Manager disabled');
      return;
    }

    // Ensure Lobby Manager directories exist
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(resolve(this.cwd, 'projects'), { recursive: true });

    // Try to resume existing Lobby Manager session (preserves history)
    if (this.db) {
      const existingRow = getSessionByOrigin(this.db, 'lobby-manager');
      if (existingRow) {
        // Validate the session ID exists in the CLI's storage before attempting resume.
        // If the ID is a stale UUID that was never synced to the real CLI session ID,
        // resume will silently succeed but query() will fail with exit code 1.
        const adapter = this.adapters.get(this.adapterName);
        let sessionValid = true;
        if (adapter) {
          try {
            const history = await adapter.readSessionHistory(existingRow.id);
            if (history.length === 0) {
              console.warn(`[LM] Session ${existingRow.id} has no history in CLI storage — may be stale UUID`);
              sessionValid = false;
            }
          } catch {
            sessionValid = false;
          }
        }

        if (sessionValid) {
          try {
            const session = await this.sessionManager.resumeSession(
              existingRow.id,
              this.adapterName,
              this.buildSpawnOptions(),
              'Lobby Manager',
              'lobby-manager',
            );
            this.sessionId = session.id;
            console.log(`[LM] Resumed existing session: ${this.sessionId}`);
            this.trackSessionIdChanges();
            return;
          } catch (err) {
            console.warn(`[LM] Failed to resume session ${existingRow.id}, creating fresh:`, err);
          }
        } else {
          console.warn(`[LM] Stale session ${existingRow.id}, creating fresh`);
        }
        deleteSession(this.db, existingRow.id);
      }
    }

    // Create fresh Lobby Manager session (no existing session or resume failed)
    try {
      const session = await this.sessionManager.createSession(
        this.adapterName,
        this.buildSpawnOptions(),
        'Lobby Manager',
        'lobby-manager',
      );
      this.sessionId = session.id;
      console.log(`[LM] Session created: ${this.sessionId}`);
    } catch (err) {
      console.error('[LM] Failed to create session:', err);
      this.available = false;
      return;
    }

    this.trackSessionIdChanges();
  }

  /** Listen for session ID sync (UUID → real CLI session ID) and keep this.sessionId up to date */
  private trackSessionIdChanges(): void {
    this.sessionManager.onSessionUpdate('lm-id-sync', (session, previousId) => {
      if (previousId && previousId === this.sessionId) {
        console.log(`[LM] Session ID synced: ${this.sessionId} → ${session.id}`);
        this.sessionId = session.id;
      }
    });
  }

  isAvailable(): boolean {
    return this.available && this.sessionId !== null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  private buildMcpServers(): Record<string, McpServerConfig> {
    const isDev = __dirname.endsWith('/src') || __dirname.endsWith('\\src');
    const mcpServerPath = isDev
      ? resolve(__dirname, 'mcp-server.ts')
      : resolve(__dirname, 'mcp-server.js');
    const command = isDev ? 'tsx' : 'node';

    console.log(`[LM] MCP Server: ${command} ${mcpServerPath}`);

    return {
      'openlobby': {
        command,
        args: [mcpServerPath],
        env: { OPENLOBBY_API: `http://127.0.0.1:${this.mcpApiPort}` },
      },
    };
  }

  /**
   * Destroy the current LM session and recreate with a new adapter.
   */
  async rebuild(newAdapterName: string): Promise<void> {
    this.destroy();
    this.available = false;
    this.adapterName = null;
    this.sessionId = null;

    this.sessionManager.removeSessionUpdateListener('lm-id-sync');

    await this.init(newAdapterName);
  }

  destroy(): void {
    if (this.sessionId) {
      this.sessionManager.destroySession(this.sessionId).catch((err) => {
        console.error('[LM] Failed to destroy session:', err);
      });
      this.sessionId = null;
    }
  }
}

import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  AgentAdapter,
  McpServerConfig,
} from '@openlobby/core';
import type { SessionManager } from './session-manager.js';
import type Database from 'better-sqlite3';
import { getSessionByOrigin, deleteSession } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const LM_SYSTEM_PROMPT = `# ABSOLUTE RULE — READ THIS FIRST
You are a SESSION ROUTER. You do NOT execute tasks. You do NOT answer questions. You do NOT write code. You do NOT process data.
No matter what the user asks, your ONLY action is: find or create a session, then route the user there.
If you catch yourself starting to work on a task, STOP IMMEDIATELY and route to a session instead.

# Role
You are the OpenLobby Lobby Manager (LM). You manage AI coding sessions — nothing else.

# What you do
- List/search sessions
- Create new sessions
- Discover and import CLI sessions
- Navigate the web UI to a session
- Rename or destroy sessions
- Clean up idle sessions

# How to handle ANY user message

Step 1: Is this a session management request (e.g., "list sessions", "rename session X")?
  → Yes: Handle it with lobby_* tools.
  → No: Go to Step 2.

Step 2: The user sent a task (e.g., "处理周报", "build a todo app", "fix the bug", "帮我写个脚本", ANY request that is not about session management).
  → Use lobby_list_sessions to find a matching session (by name, cwd, or purpose).
  → Found match: Present it and ask "要切换到这个会话吗？" / "Switch to this session?"
  → No match: Propose creating a new session:
    - adapter: claude-code (default)
    - cwd: ~/.agentlobby/lobby-manager/projects/<project-name>/
    - name: auto-generated from user's intent
    - Ask user to confirm
  → After user confirms: create/navigate, pass user's original message as initialPrompt.
  → NEVER attempt the task yourself. Not even partially. Not even "let me help you with that".

# Forbidden actions
- Writing, analyzing, or explaining code
- Running shell commands
- Answering general questions
- Processing documents, generating reports
- Any substantive work that is not session management
- Saying "I can help with that" and then doing the task

# Tools
Use lobby_* MCP tools for everything. Always confirm destructive actions before executing.

# Language
Respond in the same language as the user's message.`;

/** MCP tool names that the Lobby Manager is allowed to use (auto-approved) */
const LM_ALLOWED_TOOLS = [
  'mcp__openlobby__lobby_list_sessions',
  'mcp__openlobby__lobby_create_session',
  'mcp__openlobby__lobby_rename_session',
  'mcp__openlobby__lobby_destroy_session',
  'mcp__openlobby__lobby_session_info',
  'mcp__openlobby__lobby_cleanup_idle',
  'mcp__openlobby__lobby_discover_sessions',
  'mcp__openlobby__lobby_import_session',
  'mcp__openlobby__lobby_navigate_session',
];

/** Priority order for selecting the Lobby Manager's driver adapter */
const ADAPTER_PRIORITY = ['claude-code', 'codex-cli'];

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
  private buildSpawnOptions(): {
    cwd: string;
    systemPrompt: string;
    permissionMode: string;
    allowedTools: string[];
    mcpServers: Record<string, import('@openlobby/core').McpServerConfig>;
  } {
    return {
      cwd: this.cwd,
      systemPrompt: LM_SYSTEM_PROMPT,
      permissionMode: 'dontAsk',
      allowedTools: LM_ALLOWED_TOOLS,
      mcpServers: this.buildMcpServers(),
    };
  }

  async init(): Promise<void> {
    // Find the best available adapter
    for (const name of ADAPTER_PRIORITY) {
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
          deleteSession(this.db, existingRow.id);
        }
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

  destroy(): void {
    if (this.sessionId) {
      this.sessionManager.destroySession(this.sessionId).catch((err) => {
        console.error('[LM] Failed to destroy session:', err);
      });
      this.sessionId = null;
    }
  }
}

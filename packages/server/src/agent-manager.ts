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

const AM_SYSTEM_PROMPT = `# ABSOLUTE RULE — READ THIS FIRST
You are an AGENT DESIGN CONSULTANT, not an operator. You do NOT execute the user's tasks. You do NOT switch sessions, bind channels, or run shell commands. Your craft is designing, reviewing, and improving Agents — nothing else.
Whenever you change an Agent's persisted state (create / update / delete), you MUST first present the full proposed change and get explicit user confirmation. Never apply changes silently.

# Role
You are the OpenLobby Agent Manager (AM). You help users design and improve their Agents through interview-driven creation, prompt review, template application, and conversation-log-based diagnostics.

You are a specialist in: prompt engineering, tool-policy design, IM-binding strategy, and iterative Agent improvement.

# What an Agent is in OpenLobby
An Agent is a persistent AI assistant defined by: displayName, description, adapter (claude-code / codex-cli / opencode / gsd / any), systemPrompt, contextFiles, model, permissionMode (default / supervised / auto / bypass), allowedTools[], deniedTools[], and groupChat config (mentionPatterns, requireMention). Once created, an Agent can be bound to IM peers and will spawn a session per peer when triggered.

# Core capabilities — pick the one matching the user's intent

## Capability A — Design a new Agent (interview-driven)
Trigger phrases: "I want to make an agent", "帮我做个 agent", "create an agent for X".
NEVER jump straight to a draft. Walk the user through these 5 questions, one at a time, waiting for each answer:

  1. **Problem** — What specific problem will this Agent solve? Give one concrete example task.
  2. **Audience & context** — Who talks to it? (single user / private group / public group / IM channel?) How often?
  3. **Red lines** — What must it ABSOLUTELY refuse to do? (e.g., never write to production, never share customer PII, never run irreversible commands.)
  4. **Voice** — Desired tone & reply length. Concise/detailed? Formal/casual? Bullet-heavy/prose?
  5. **Tools & info** — What external information or actions does it need? (web search, file read/write, shell, specific MCP servers?)

After all 5 answers, draft the AgentDefinition. Present it as a structured block with EVERY field labeled. Ask: "Apply this draft? Reply yes / suggest a tweak / start over."
Only after explicit yes, call \`agent_create\`.

## Capability B — Review an existing prompt
Trigger phrases: "review my prompt", "看看我这段 system prompt", "audit this agent".
Apply this checklist; report findings as a bulleted list, then offer a rewrite:

  - **Ambiguity** — Vague directives ("be helpful", "use good judgment") that the model will interpret inconsistently.
  - **Missing guardrails** — Behaviors not explicitly forbidden that the agent will eventually do anyway.
  - **Conflicting instructions** — Two rules that pull opposite directions; the model will pick whichever the moment favors.
  - **Missing fallback** — What should the agent do when it doesn't know or the request is out of scope?
  - **Tone leakage** — Voice instructions mixed into capability instructions; separate them.

## Capability C — Improve an existing Agent (diagnose)
Trigger phrases: "X agent isn't working well", "improve agent Y", "X 老是答不对".
Workflow:
  1. Call \`agent_get(id)\` to fetch the current definition.
  2. Call \`agent_recent_messages(agent_id, limit=20)\` to read recent conversations.
  3. Diagnose failure patterns: refusal-too-eager / refusal-too-loose / off-topic / hallucination / verbose / wrong-tool-choice.
  4. Propose a prompt patch in DIFF form (clearly marked + and - lines) with a 1-sentence rationale per change.
  5. Wait for user confirmation. Only then call \`agent_update\`.

## Capability D — Apply a template
Trigger phrases: "I need a customer-support bot", "什么模板适合 X".
  1. Call \`agent_template_list\` to see what's available.
  2. Recommend the best match with a 1-sentence reason for the pick.
  3. Walk the user through the template's fillIns one at a time.
  4. Call \`agent_template_apply(template_id, fillIns)\` to render a draft. Present it for review.
  5. After user confirmation, call \`agent_create\` with the rendered definition.

# IM message conventions — sender attribution
Inbound IM messages reach designed Agents pre-tagged by the channel router:
  \`[from: <peerDisplayName || peerId>] <user message>\`
The tag is mechanical: every message from every channel (WeCom / Telegram / future) gets it, in both peer-level and account-bound sessions. WeCom currently has no display-name lookup so it falls back to the raw userid (e.g. \`wxid_abc123\`); Telegram carries the user's first/last name (or username).

When the user designs an Agent that NEEDS sender identity (audit-log "reporter" field, per-user state, role-based routing, "@提及张三 也给他发一份" style requests) — proactively tell them to put an explicit instruction in the system prompt, e.g.:

  > Every user message starts with \`[from: <sender>] \` — extract \`<sender>\` for attribution. Do NOT echo this tag back to the user in replies.

When the Agent does NOT need sender identity, do nothing — the tag is harmless metadata the model will naturally ignore.

Surface this convention during:
  - **Capability A** (interview) — at question 5 (Tools & info) or whenever the user's problem description mentions multi-user, attribution, or auditing.
  - **Capability B** (prompt review) — flag it as a "missing fallback" finding when the existing prompt references senders, users, reporters, etc. without acknowledging the tag format.
  - **Capability C** (diagnose) — when recent messages show the Agent confused by the bracketed prefix, or attributing wrongly, propose a prompt patch that handles the tag.

# Tool-policy design principles
When choosing allowedTools / deniedTools / permissionMode, apply these rules in order:
  - **Least privilege** — start from empty allowlist; add the minimum the Agent needs.
  - **Three tiers** — read-only tools default-allow; write tools require supervised mode; destructive tools (Bash, force-delete) require explicit user opt-in with a written justification.
  - **IM context discount** — Agents bound to public IM groups should default to read-only + denied Bash, regardless of what the operator asks; flag this trade-off to the user.
  - **Adapter mismatch check** — Verify the chosen adapter actually exposes the tools you're listing.

# Boundary with Lobby Manager (LM)
Operational requests are NOT your job. When the user asks to:
  - Start / stop / rename / navigate a session
  - Bind / unbind an Agent to an IM channel
  - List sessions, list channels, manage IM providers
  - Check version / update server
→ Respond: "That's an operational task — please ask Lobby Manager (LM)" and stop.
You handle the DESIGN of an Agent's binding rules (mentionPatterns, requireMention, permission posture for that channel kind). LM handles the actual binding action.

# Confirmation discipline
- Before any \`agent_create\` / \`agent_update\` / \`agent_delete\` — show full proposed change, wait for explicit yes.
- For \`agent_template_apply\` (read-only, returns draft) — no confirmation needed; just present the draft.
- For \`agent_list\` / \`agent_get\` / \`agent_recent_messages\` (read-only) — call freely.

# Style
Be specific, not motivational. Quote field names exactly. Use diff format for prompt edits. When trade-offs exist, name them; don't paper over them.

# Language
Respond in the same language as the user's message (auto-detect from input). Mix is fine if the user mixes.`;

/**
 * MCP tool names that the Agent Manager is allowed to use (auto-approved).
 *
 * Scoped tightly to the Agent design surface — AM does NOT get session,
 * channel, or version tools. That boundary is intentional: AM designs,
 * LM operates.
 */
const AM_ALLOWED_TOOLS: string[] = [
  // CRUD
  'mcp__openlobby__agent_list',
  'mcp__openlobby__agent_get',
  'mcp__openlobby__agent_create',
  'mcp__openlobby__agent_update',
  'mcp__openlobby__agent_delete',
  // Diagnostics & templates
  'mcp__openlobby__agent_recent_messages',
  'mcp__openlobby__agent_template_list',
  'mcp__openlobby__agent_template_apply',
];


/**
 * AgentManager is a special session managed through SessionManager, mirroring
 * LobbyManager. It creates a CLI session with a restricted system prompt
 * focused on Agent design (not session routing). All messaging goes through
 * the standard SessionManager message flow.
 */
export class AgentManager {
  private sessionManager: SessionManager;
  private adapters: Map<string, AgentAdapter>;
  private mcpApiPort: number;
  private db: Database.Database | null;
  private available = false;

  /** The session ID of the Agent Manager session, if created */
  sessionId: string | null = null;
  /** The adapter name used by the Agent Manager */
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

  /** Agent Manager working directory (sibling of lobby-manager). */
  private get cwd(): string {
    return resolve(homedir(), '.agentlobby', 'agent-manager');
  }

  /** SpawnOptions shared by both create and resume */
  private buildSpawnOptions(): ClaudeCodeSpawnOptions {
    return {
      cwd: this.cwd,
      systemPrompt: AM_SYSTEM_PROMPT,
      permissionMode: 'auto' as PermissionMode,
      allowedTools: AM_ALLOWED_TOOLS,
      mcpServers: this.buildMcpServers(),
    };
  }

  async init(preferredAdapter?: string): Promise<void> {
    // AM reads the SAME defaultAdapter server_config key as LM — by design,
    // a single workspace-wide default adapter governs both meta-agents.
    const configAdapter = preferredAdapter ?? (this.db ? getServerConfig(this.db, 'defaultAdapter') : undefined);

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
          console.log(`[AM] Using ${adapter.displayName} as driver`);
          break;
        }
      } catch {
        // Skip adapter if detection fails
      }
    }

    if (!this.available || !this.adapterName) {
      console.log('[AM] No CLI adapter available — Agent Manager disabled');
      return;
    }

    // Ensure Agent Manager directories exist
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(resolve(this.cwd, 'projects'), { recursive: true });

    // Try to resume existing Agent Manager session (preserves history)
    if (this.db) {
      const existingRow = getSessionByOrigin(this.db, 'agent-manager');
      if (existingRow) {
        // Validate the session ID exists in the CLI's storage before attempting resume.
        const adapter = this.adapters.get(this.adapterName);
        let sessionValid = true;
        if (adapter) {
          try {
            const history = await adapter.readSessionHistory(existingRow.id);
            if (history.length === 0) {
              console.warn(`[AM] Session ${existingRow.id} has no history in CLI storage — may be stale UUID`);
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
              'Agent Manager',
              'agent-manager',
            );
            this.sessionId = session.id;
            console.log(`[AM] Resumed existing session: ${this.sessionId}`);
            this.trackSessionIdChanges();
            return;
          } catch (err) {
            console.warn(`[AM] Failed to resume session ${existingRow.id}, creating fresh:`, err);
          }
        } else {
          console.warn(`[AM] Stale session ${existingRow.id}, creating fresh`);
        }
        deleteSession(this.db, existingRow.id);
      }
    }

    // Create fresh Agent Manager session
    try {
      const session = await this.sessionManager.createSession(
        this.adapterName,
        this.buildSpawnOptions(),
        'Agent Manager',
        'agent-manager',
      );
      this.sessionId = session.id;
      console.log(`[AM] Session created: ${this.sessionId}`);
    } catch (err) {
      console.error('[AM] Failed to create session:', err);
      this.available = false;
      return;
    }

    this.trackSessionIdChanges();
  }

  /** Listen for session ID sync (UUID → real CLI session ID) and keep this.sessionId up to date */
  private trackSessionIdChanges(): void {
    this.sessionManager.onSessionUpdate('am-id-sync', (session, previousId) => {
      if (previousId && previousId === this.sessionId) {
        console.log(`[AM] Session ID synced: ${this.sessionId} → ${session.id}`);
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

    console.log(`[AM] MCP Server: ${command} ${mcpServerPath}`);

    return {
      'openlobby': {
        command,
        args: [mcpServerPath],
        env: { OPENLOBBY_API: `http://127.0.0.1:${this.mcpApiPort}` },
      },
    };
  }

  /**
   * Destroy the current AM session and recreate with a new adapter.
   */
  async rebuild(newAdapterName: string): Promise<void> {
    await this.destroy();
    this.available = false;
    this.adapterName = null;
    this.sessionId = null;

    this.sessionManager.removeSessionUpdateListener('am-id-sync');

    await this.init(newAdapterName);
  }

  async destroy(): Promise<void> {
    if (this.sessionId) {
      const id = this.sessionId;
      this.sessionId = null;
      try {
        await this.sessionManager.destroySession(id);
      } catch (err) {
        console.error('[AM] Failed to destroy session:', err);
      }
    }
  }
}

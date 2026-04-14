import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentProcess,
  SpawnOptions,
  ResumeOptions,
  LobbyMessage,
  SessionSummary,
  ControlDecision,
  AdapterCommand,
  AdapterPermissionMeta,
} from '../types.js';

// ──────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────

function makeLobbyMessage(
  sessionId: string,
  type: LobbyMessage['type'],
  content: string | Record<string, unknown>,
  meta?: LobbyMessage['meta'],
): LobbyMessage {
  return {
    id: randomUUID(),
    sessionId,
    timestamp: Date.now(),
    type,
    content,
    meta,
  };
}

const PLAN_MODE_SYSTEM_PROMPT = `You are in PLAN MODE. Only explore the codebase and produce a detailed implementation plan. Do NOT modify any files. Use only read-only tools.`;

/** Static fallback commands before server is available */
const FALLBACK_COMMANDS: AdapterCommand[] = [
  { name: '/compact', description: 'Compact conversation to save context' },
  { name: '/help', description: 'Show help information' },
];

// ──────────────────────────────────────────────
// OpenCodeProcess
// ──────────────────────────────────────────────

class OpenCodeProcess extends EventEmitter implements AgentProcess {
  sessionId: string;
  readonly adapter = 'opencode';
  status: AgentProcess['status'] = 'idle';

  private spawnOptions: SpawnOptions;
  private sseAbortController = new AbortController();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  /** Track seen TextPart IDs to distinguish delta vs final */
  private seenTextParts = new Set<string>();
  /** Track seen ToolPart IDs to avoid duplicate tool_use emissions */
  private emittedToolUseIds = new Set<string>();
  /**
   * Track user message IDs (from message.updated events).
   * Used to skip message.part.updated events that belong to user messages —
   * without this, user text parts would be emitted as 'assistant' messages.
   */
  private userMessageIds = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(sessionId: string, options: SpawnOptions, client: any) {
    super();
    this.sessionId = sessionId;
    this.spawnOptions = options;
    this.client = client;
  }

  /**
   * Subscribe to the SSE event stream and dispatch events.
   * Called once after construction.
   */
  async subscribeSSE(): Promise<void> {
    try {
      const result = await this.client.event.subscribe({
        signal: this.sseAbortController.signal,
      });

      // Process SSE events in background (don't await — it's infinite)
      this.consumeStream(result.stream).catch((err: unknown) => {
        if (this.sseAbortController.signal.aborted) return;
        console.error('[OpenCode] SSE stream error:', err);
        this.status = 'error';
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      });
    } catch (err) {
      if (this.sseAbortController.signal.aborted) return;
      console.error('[OpenCode] SSE subscribe failed:', err);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async consumeStream(stream: AsyncGenerator<any>): Promise<void> {
    for await (const event of stream) {
      if (this.sseAbortController.signal.aborted) break;
      this.handleSSEEvent(event);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSSEEvent(event: any): void {
    const type = event.type as string;

    // Filter events to only this session
    const sessionID =
      event.properties?.sessionID ??
      event.properties?.info?.sessionID ??
      event.properties?.part?.sessionID;
    if (sessionID && sessionID !== this.sessionId) return;

    switch (type) {
      case 'message.part.updated':
        this.handlePartUpdated(event.properties);
        break;

      case 'message.updated':
        this.handleMessageUpdated(event.properties);
        break;

      case 'permission.updated':
        this.handlePermissionUpdated(event.properties);
        break;

      case 'session.status':
        this.handleSessionStatus(event.properties);
        break;

      case 'session.idle':
        // Don't override awaiting_approval — idle event arrives even during permission prompts
        if (this.status !== 'awaiting_approval') {
          console.log('[OpenCode] Session idle:', this.sessionId);
          this.status = 'idle';
          this.emit('idle');
        }
        break;

      case 'session.error':
        this.handleSessionError(event.properties);
        break;

      case 'session.compacted': {
        const compactProps = event.properties as { sessionID?: string; tokens?: number };
        if (compactProps.sessionID && compactProps.sessionID !== this.sessionId) return;
        this.emit('message', makeLobbyMessage(this.sessionId, 'system', {
          compact: true,
          trigger: 'manual',
          preTokens: compactProps.tokens ?? 0,
        }));
        break;
      }

      default:
        // Ignore other events (lsp.*, pty.*, tui.*, file.edited, etc.)
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlePartUpdated(props: any): void {
    const part = props.part;
    const delta = props.delta as string | undefined;

    if (!part) return;

    // Skip parts belonging to user messages.
    // TextPart.messageID links each part to its parent Message.
    // If the parent is a user message, we must not emit it as 'assistant'.
    if (part.messageID && this.userMessageIds.has(part.messageID)) return;

    switch (part.type) {
      case 'text': {
        if (delta) {
          // Streaming text delta
          this.emit('message', makeLobbyMessage(this.sessionId, 'stream_delta', delta));
        } else if (part.text && !this.seenTextParts.has(part.id)) {
          // Final text content (no delta = completed text part)
          this.seenTextParts.add(part.id);
          this.emit('message', makeLobbyMessage(this.sessionId, 'assistant', part.text));
        }
        break;
      }

      case 'tool': {
        const state = part.state;
        if (!state) break;

        if (state.status === 'pending' || state.status === 'running') {
          // Only emit tool_use once per tool call
          if (!this.emittedToolUseIds.has(part.callID)) {
            this.emittedToolUseIds.add(part.callID);
            this.emit(
              'message',
              makeLobbyMessage(
                this.sessionId,
                'tool_use',
                JSON.stringify(state.input ?? {}, null, 2),
                { toolName: part.tool },
              ),
            );
          }
        } else if (state.status === 'completed') {
          this.emit(
            'message',
            makeLobbyMessage(
              this.sessionId,
              'tool_result',
              state.output ?? '',
              { toolName: part.tool },
            ),
          );
        } else if (state.status === 'error') {
          this.emit(
            'message',
            makeLobbyMessage(
              this.sessionId,
              'tool_result',
              state.error ?? 'Tool execution failed',
              { toolName: part.tool, isError: true },
            ),
          );
        }
        break;
      }

      case 'compaction': {
        this.emit('message', makeLobbyMessage(this.sessionId, 'system', {
          compact: true,
          trigger: 'manual',
          preTokens: 0,
        }));
        break;
      }

      // Ignore reasoning, step-start, step-finish, snapshot, patch, agent, retry
      default:
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessageUpdated(props: any): void {
    const info = props.info;
    if (!info) return;

    // Track user message IDs so we can filter out their parts in handlePartUpdated.
    // Without this, message.part.updated for user text parts would be emitted
    // as 'assistant' messages, causing user input to appear twice in the UI.
    if (info.role === 'user') {
      this.userMessageIds.add(info.id);
      return;
    }

    if (info.role !== 'assistant') return;

    // Only emit result when the message is completed (has time.completed)
    if (!info.time?.completed) return;

    this.emit(
      'message',
      makeLobbyMessage(
        this.sessionId,
        'result',
        {
          cost: info.cost,
          tokens: info.tokens,
          finish: info.finish,
        },
        {
          model: info.modelID,
          costUsd: info.cost,
          tokenUsage: info.tokens
            ? { input: info.tokens.input, output: info.tokens.output }
            : undefined,
        },
      ),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handlePermissionUpdated(props: any): void {
    if (!props.id) return;

    const mode = this.spawnOptions.permissionMode ?? 'supervised';

    console.log('[OpenCode] Permission props:', JSON.stringify(props, null, 2));

    // Extract meaningful tool name from permission properties.
    // OpenCode permission events have: title (e.g. "question"), description,
    // metadata (contains tool details like command, path, etc.)
    const meta = props.metadata ?? {};
    const toolName = meta.tool
      ?? meta.command
      ?? meta.path
      ?? props.description
      ?? props.title
      ?? props.type
      ?? 'unknown';

    console.log('[OpenCode] Permission requested:', toolName, 'id:', props.id, 'mode:', mode);

    // Auto mode: immediately approve
    if (mode === 'auto') {
      console.log('[OpenCode] Auto mode: approved', toolName);
      this.client
        .postSessionIdPermissionsPermissionId({
          path: { id: this.sessionId, permissionID: props.id },
          body: { response: 'once' },
        })
        .catch((err: unknown) => {
          console.warn('[OpenCode] Auto-approve failed:', err);
        });
      return;
    }

    // Readonly mode: auto-reject
    if (mode === 'readonly') {
      console.log('[OpenCode] Readonly mode: rejected', toolName);
      this.client
        .postSessionIdPermissionsPermissionId({
          path: { id: this.sessionId, permissionID: props.id },
          body: { response: 'reject' },
        })
        .catch((err: unknown) => {
          console.warn('[OpenCode] Auto-reject failed:', err);
        });
      return;
    }

    // Supervised mode: emit control message for user approval
    this.status = 'awaiting_approval';
    this.emit(
      'message',
      makeLobbyMessage(this.sessionId, 'control', {
        requestId: props.id,
        toolName,
        toolInput: props.metadata ?? {},
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSessionStatus(props: any): void {
    const statusType = props.status?.type;
    if (statusType === 'busy') {
      this.status = 'running';
    } else if (statusType === 'idle') {
      // Don't override awaiting_approval — status events arrive even during permission prompts
      if (this.status !== 'awaiting_approval') {
        this.status = 'idle';
      }
    }
    // 'retry' status — keep current status
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSessionError(props: any): void {
    console.error('[OpenCode] Session error:', props.error ?? props);
    this.status = 'error';

    this.emit(
      'message',
      makeLobbyMessage(
        this.sessionId,
        'system',
        { error: props.error ?? 'Unknown session error' },
        { isError: true },
      ),
    );
    this.emit('error', new Error(props.error ?? 'Unknown session error'));
  }

  // ── Public API (AgentProcess) ──

  sendMessage(content: string): void {
    console.log('[OpenCode] sendMessage:', content.slice(0, 100));
    this.status = 'running';

    // Reset tracking sets for new turn
    this.seenTextParts.clear();
    this.emittedToolUseIds.clear();

    // Build prompt body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      parts: [{ type: 'text' as const, text: content }],
    };

    if (this.spawnOptions.permissionMode === 'readonly') {
      body.system = PLAN_MODE_SYSTEM_PROMPT;
    }

    this.client.session
      .promptAsync({
        path: { id: this.sessionId },
        body,
      })
      .then(() => {
        console.log('[OpenCode] promptAsync accepted');
      })
      .catch((err: unknown) => {
        console.error('[OpenCode] promptAsync failed:', err);
        this.status = 'error';
        this.emit(
          'message',
          makeLobbyMessage(
            this.sessionId,
            'system',
            { error: err instanceof Error ? err.message : String(err) },
            { isError: true },
          ),
        );
      });
  }

  respondControl(requestId: string, decision: ControlDecision): void {
    console.log('[OpenCode] Control response:', requestId, decision);

    const reply = decision === 'allow' ? 'once' : 'reject';

    this.client
      .postSessionIdPermissionsPermissionId({
        path: { id: this.sessionId, permissionID: requestId },
        body: { response: reply },
      })
      .then(() => {
        console.log('[OpenCode] Permission replied:', requestId, reply);
      })
      .catch((err: unknown) => {
        console.warn('[OpenCode] Permission reply failed:', err);
      });
  }

  updateOptions(opts: Partial<SpawnOptions>): void {
    Object.assign(this.spawnOptions, opts);
    console.log('[OpenCode] Options updated:', Object.keys(opts));
  }

  interrupt(): void {
    if (this.status !== 'running' && this.status !== 'awaiting_approval') return;
    console.log('[OpenCode] Interrupting current generation');
    this.sseAbortController.abort();
    this.sseAbortController = new AbortController();
    this.client.session
      .abort({ path: { id: this.sessionId } })
      .catch(() => {});
    this.status = 'idle';
    this.emit('idle');
    this.subscribeSSE().catch((err: unknown) => {
      console.error('[OpenCode] Re-subscribe after interrupt failed:', err);
    });
  }

  kill(): void {
    console.log('[OpenCode] Killing process');
    this.sseAbortController.abort();

    // Abort the session (best-effort, don't block)
    this.client.session
      .abort({ path: { id: this.sessionId } })
      .catch(() => {});

    this.status = 'stopped';
    this.emit('exit', 0);
  }
}

// ──────────────────────────────────────────────
// OpenCodeAdapter
// ──────────────────────────────────────────────

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode';
  readonly displayName = 'OpenCode';
  readonly permissionMeta: AdapterPermissionMeta = {
    modeLabels: {
      auto: 'auto-approve',
      supervised: 'prompt',
      readonly: 'plan + auto-reject',
    },
  };

  private serverInstance: { url: string; close(): void } | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clientInstance: any | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async ensureServer(): Promise<any> {
    if (this.clientInstance) return this.clientInstance;

    const { createOpencode } = await import('@opencode-ai/sdk');
    // Use port 0 to avoid conflicts with other opencode instances;
    // SDK picks a random available port when set to 0.
    // Fallback to default 4096 if port 0 is not supported.
    const { client, server } = await createOpencode({ port: 0 });
    this.serverInstance = server;
    this.clientInstance = client;

    console.log('[OpenCode] Server started at:', server.url);
    return this.clientInstance;
  }

  async detect(): Promise<{ installed: boolean; version?: string; path?: string }> {
    try {
      const version = execSync('opencode --version', { encoding: 'utf-8' }).trim();
      const cliPath = execSync('which opencode', { encoding: 'utf-8' }).trim();
      return { installed: true, version, path: cliPath };
    } catch {
      return { installed: false };
    }
  }

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const client = await this.ensureServer();

    // Create a new session
    const result = await client.session.create({
      body: { title: `OpenLobby session` },
    });

    const session = result.data;
    const sessionId = session.id as string;
    console.log('[OpenCodeAdapter] Session created:', sessionId);

    const proc = new OpenCodeProcess(sessionId, options, client);

    // Subscribe to SSE in background
    await proc.subscribeSSE();

    // Fetch commands in background
    this.fetchCommands(client, proc);

    return proc;
  }

  async resume(sessionId: string, options?: ResumeOptions): Promise<AgentProcess> {
    const client = await this.ensureServer();

    // Verify session exists
    const result = await client.session.get({
      path: { id: sessionId },
    });

    if (!result.data) {
      throw new Error(`OpenCode session not found: ${sessionId}`);
    }

    console.log('[OpenCodeAdapter] Resuming session:', sessionId);

    const proc = new OpenCodeProcess(sessionId, {
      cwd: options?.cwd ?? process.cwd(),
      systemPrompt: options?.systemPrompt,
      permissionMode: options?.permissionMode,
      model: options?.model,
    }, client);

    await proc.subscribeSSE();
    this.fetchCommands(client, proc);

    return proc;
  }

  getSessionStoragePath(): string {
    // OpenCode stores data centrally in XDG data dir
    const home = homedir();
    return join(home, '.local', 'share', 'opencode');
  }

  /** Path to the centralized OpenCode SQLite database */
  private getDbPath(): string {
    return join(this.getSessionStoragePath(), 'opencode.db');
  }

  async readSessionHistory(sessionId: string): Promise<LobbyMessage[]> {
    // Try reading from SQLite first (no server needed), fall back to REST API
    const dbHistory = await this.readHistoryFromDb(sessionId);
    if (dbHistory.length > 0) return dbHistory;

    // Fall back to REST API if server is already running
    if (!this.clientInstance) return [];

    try {
      const client = this.clientInstance;
      const result = await client.session.messages({
        path: { id: sessionId },
      });

      return this.convertApiMessages(sessionId, result.data);
    } catch {
      return [];
    }
  }

  private async readHistoryFromDb(sessionId: string): Promise<LobbyMessage[]> {
    const dbPath = this.getDbPath();
    if (!existsSync(dbPath)) return [];

    try {
      // OpenCode stores message/part content in a `data` JSON column.
      // Query the actual columns and extract fields from JSON in JS.
      const safeId = sessionId.replace(/'/g, "''");
      const query = `SELECT m.id as msg_id, m.time_created, m.data as msg_data, p.id as part_id, p.data as part_data FROM message m LEFT JOIN part p ON p.message_id = m.id WHERE m.session_id = '${safeId}' ORDER BY m.time_created ASC, p.rowid ASC;`;

      const output = execSync(`sqlite3 -json "${dbPath}" "${query}"`, {
        encoding: 'utf-8',
        timeout: 10000,
      }).trim();

      if (!output) return [];

      const rows = JSON.parse(output) as Array<{
        msg_id: string;
        time_created: number;
        msg_data: string;
        part_id: string | null;
        part_data: string | null;
      }>;

      const messages: LobbyMessage[] = [];
      for (const row of rows) {
        if (!row.part_data) continue;

        let msgInfo: { role?: string; model?: { modelID?: string } };
        try { msgInfo = JSON.parse(row.msg_data); } catch { continue; }

        let partInfo: { type?: string; text?: string; tool?: string; callID?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string } };
        try { partInfo = JSON.parse(row.part_data); } catch { continue; }

        const role = msgInfo.role;
        const modelId = msgInfo.model?.modelID;

        if (partInfo.type === 'text' && partInfo.text) {
          messages.push({
            id: row.part_id!,
            sessionId,
            timestamp: row.time_created,
            type: role === 'user' ? 'user' : 'assistant',
            content: partInfo.text,
            meta: role === 'assistant' ? { model: modelId } : undefined,
          });
        } else if (partInfo.type === 'tool' && partInfo.state) {
          const st = partInfo.state;
          if (st.status === 'completed' || st.status === 'error') {
            messages.push({
              id: `${row.part_id}-use`,
              sessionId,
              timestamp: row.time_created,
              type: 'tool_use',
              content: JSON.stringify(st.input ?? {}, null, 2),
              meta: { toolName: partInfo.tool },
            });
            messages.push({
              id: `${row.part_id}-result`,
              sessionId,
              timestamp: row.time_created,
              type: 'tool_result',
              content: st.output ?? st.error ?? '',
              meta: { toolName: partInfo.tool, isError: st.status === 'error' },
            });
          }
        }
      }

      return messages;
    } catch (err) {
      console.error('[OpenCode] readHistoryFromDb failed:', err);
      return [];
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private convertApiMessages(sessionId: string, data: any): LobbyMessage[] {
    const messages: LobbyMessage[] = [];
    const items = data as Array<{
      info: { id: string; role: string; sessionID: string; time: { created: number; completed?: number }; modelID?: string; cost?: number; tokens?: { input: number; output: number } };
      parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string; input?: Record<string, unknown>; output?: string; error?: string }; callID?: string; id: string }>;
    }>;

    if (!Array.isArray(items)) return [];

    for (const item of items) {
      const info = item.info;
      const timestamp = info.time?.created ? info.time.created * 1000 : Date.now();

      if (info.role === 'user') {
        for (const part of item.parts) {
          if (part.type === 'text' && part.text) {
            messages.push({
              id: part.id ?? randomUUID(),
              sessionId,
              timestamp,
              type: 'user',
              content: part.text,
            });
          }
        }
      } else if (info.role === 'assistant') {
        for (const part of item.parts) {
          if (part.type === 'text' && part.text) {
            messages.push({
              id: part.id ?? randomUUID(),
              sessionId,
              timestamp,
              type: 'assistant',
              content: part.text,
              meta: { model: info.modelID },
            });
          } else if (part.type === 'tool' && part.state) {
            if (part.state.status === 'completed' || part.state.status === 'error') {
              messages.push({
                id: `${part.id}-use`,
                sessionId,
                timestamp,
                type: 'tool_use',
                content: JSON.stringify(part.state.input ?? {}, null, 2),
                meta: { toolName: part.tool },
              });
              messages.push({
                id: `${part.id}-result`,
                sessionId,
                timestamp,
                type: 'tool_result',
                content: part.state.output ?? part.state.error ?? '',
                meta: { toolName: part.tool, isError: part.state.status === 'error' },
              });
            }
          }
        }
      }
    }

    return messages;
  }

  async discoverSessions(cwd?: string): Promise<SessionSummary[]> {
    // Read directly from OpenCode's centralized SQLite database via sqlite3 CLI.
    // This avoids starting `opencode serve` just for discovery and
    // reliably finds sessions across ALL projects.
    const dbPath = this.getDbPath();
    if (!existsSync(dbPath)) return [];

    try {
      const query = cwd
        ? `SELECT id, title, directory, time_created, time_updated FROM session WHERE directory LIKE '${cwd.replace(/'/g, "''")}%' ORDER BY time_updated DESC;`
        : `SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC;`;

      const output = execSync(`sqlite3 -json "${dbPath}" "${query}"`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (!output) return [];

      const rows = JSON.parse(output) as Array<{
        id: string;
        title: string;
        directory: string;
        time_created: number;
        time_updated: number;
      }>;

      return rows.map((row) => ({
        id: row.id,
        adapterName: this.name,
        displayName: row.title || row.id.slice(0, 8),
        status: 'stopped',
        lastActiveAt: row.time_updated,
        messageCount: 0,
        cwd: row.directory ?? process.cwd(),
        origin: 'cli' as const,
        resumeCommand: this.getResumeCommand(row.id),
      }));
    } catch (err) {
      console.error('[OpenCode] discoverSessions failed:', err);
      return [];
    }
  }

  getResumeCommand(sessionId: string): string {
    return `opencode --session=${sessionId}`;
  }

  async listCommands(): Promise<AdapterCommand[]> {
    return FALLBACK_COMMANDS;
  }

  async resolveSessionCwd(sessionId: string): Promise<string | undefined> {
    const dbPath = this.getDbPath();
    if (!existsSync(dbPath)) return undefined;

    try {
      const safeId = sessionId.replace(/'/g, "''");
      const query = `SELECT directory FROM session WHERE id = '${safeId}' LIMIT 1;`;
      const output = execSync(`sqlite3 -json "${dbPath}" "${query}"`, {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (!output) return undefined;
      const rows = JSON.parse(output) as Array<{ directory: string }>;
      return rows[0]?.directory || undefined;
    } catch {
      return undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private fetchCommands(client: any, proc: OpenCodeProcess): void {
    client.command
      .list()
      .then((result: { data: Array<{ name: string; description?: string }> }) => {
        if (!Array.isArray(result.data)) {
          proc.emit('commands', FALLBACK_COMMANDS);
          return;
        }
        const commands: AdapterCommand[] = result.data.map(
          (c: { name: string; description?: string }) => ({
            name: c.name.startsWith('/') ? c.name : `/${c.name}`,
            description: c.description ?? '',
          }),
        );
        console.log(`[OpenCode] Commands fetched: ${commands.length}`);
        proc.emit('commands', commands);
      })
      .catch(() => {
        proc.emit('commands', FALLBACK_COMMANDS);
      });
  }
}

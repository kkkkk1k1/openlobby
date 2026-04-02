import { randomUUID } from 'node:crypto';
import type {
  AgentAdapter,
  AgentProcess,
  SpawnOptions,
  LobbyMessage,
  SessionSummary,
  ControlDecision,
  AdapterCommand,
  MessageMode,
  PermissionMode,
} from '@openlobby/core';
import type Database from 'better-sqlite3';
import {
  upsertSession,
  deleteSession as dbDeleteSession,
  updateSessionStatus,
  updateSessionDisplayName,
  updateSessionPinned,
  getAllSessions,
  getSessionCommands,
  upsertSessionCommands,
  getServerConfig,
  getAdapterDefault,
  getAllAdapterDefaults,
  setAdapterDefault,
} from './db.js';

export interface ManagedSession {
  id: string;
  /** Previous IDs this session was known as (e.g., temporary UUID before CLI sync) */
  previousIds: string[];
  adapterName: string;
  displayName: string;
  status: 'running' | 'idle' | 'stopped' | 'error' | 'awaiting_approval';
  createdAt: number;
  lastActiveAt: number;
  cwd: string;
  process: AgentProcess;
  messageCount: number;
  model?: string;
  permissionMode?: PermissionMode;
  lastMessage?: string;
  origin: 'lobby' | 'cli' | 'lobby-manager';
  messageMode: MessageMode;
  /** Whether this session is pinned to the top of the sidebar */
  pinned: boolean;
  /** Cumulative token usage for compact threshold tracking */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    compactCount: number;
    /** Suppress repeated compact prompts until next compact/reset */
    compactPrompted: boolean;
  };
}

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  private adapters = new Map<string, AgentAdapter>();
  private messageListeners = new Map<
    string,
    (sessionId: string, msg: LobbyMessage) => void
  >();
  private sessionUpdateListeners = new Map<
    string,
    (session: SessionSummary, previousId?: string) => void
  >();
  private navigateListeners = new Map<string, (sessionId: string) => void>();
  private commandsListeners = new Map<
    string,
    (sessionId: string, commands: AdapterCommand[]) => void
  >();
  private db: Database.Database | null;
  /** In-memory message cache as fallback when adapter can't read history from disk */
  private messageCache = new Map<string, LobbyMessage[]>();
  /** Track which sessions are being viewed on web (sessionId → set of listener IDs) */
  private webViewers = new Map<string, Set<string>>();
  /** Reverse map: listenerId → sessionId they're viewing */
  private viewerSessions = new Map<string, string>();
  /** Maps old (temporary) session IDs to their current IDs after syncSessionId migrations */
  private sessionIdAliases = new Map<string, string>();
  private compactSuggestionListeners = new Map<
    string,
    (session: ManagedSession) => void
  >();
  private compactCompleteListeners = new Map<
    string,
    (session: ManagedSession, content: unknown) => void
  >();

  constructor(db?: Database.Database) {
    this.db = db ?? null;
  }

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  onMessage(
    listenerId: string,
    handler: (sessionId: string, msg: LobbyMessage) => void,
  ): void {
    this.messageListeners.set(listenerId, handler);
  }

  removeMessageListener(listenerId: string): void {
    this.messageListeners.delete(listenerId);
  }

  onSessionUpdate(
    listenerId: string,
    handler: (session: SessionSummary, previousId?: string) => void,
  ): void {
    this.sessionUpdateListeners.set(listenerId, handler);
  }

  removeSessionUpdateListener(listenerId: string): void {
    this.sessionUpdateListeners.delete(listenerId);
  }

  onNavigate(
    listenerId: string,
    handler: (sessionId: string) => void,
  ): void {
    this.navigateListeners.set(listenerId, handler);
  }

  removeNavigateListener(listenerId: string): void {
    this.navigateListeners.delete(listenerId);
  }

  broadcastNavigate(sessionId: string): void {
    for (const handler of this.navigateListeners.values()) {
      handler(sessionId);
    }
  }

  onCommands(
    listenerId: string,
    handler: (sessionId: string, commands: AdapterCommand[]) => void,
  ): void {
    this.commandsListeners.set(listenerId, handler);
  }

  removeCommandsListener(listenerId: string): void {
    this.commandsListeners.delete(listenerId);
  }

  onCompactSuggestion(
    listenerId: string,
    handler: (session: ManagedSession) => void,
  ): void {
    this.compactSuggestionListeners.set(listenerId, handler);
  }

  removeCompactSuggestionListener(listenerId: string): void {
    this.compactSuggestionListeners.delete(listenerId);
  }

  onCompactComplete(
    listenerId: string,
    handler: (session: ManagedSession, content: unknown) => void,
  ): void {
    this.compactCompleteListeners.set(listenerId, handler);
  }

  removeCompactCompleteListener(listenerId: string): void {
    this.compactCompleteListeners.delete(listenerId);
  }

  /** Get cached commands for a session from SQLite */
  getCachedCommands(sessionId: string): AdapterCommand[] | null {
    if (!this.db) return null;
    const row = getSessionCommands(this.db, sessionId);
    if (!row) return null;
    try {
      return JSON.parse(row.commands_json) as AdapterCommand[];
    } catch {
      return null;
    }
  }

  private broadcastCommands(sessionId: string, commands: AdapterCommand[]): void {
    for (const handler of this.commandsListeners.values()) {
      handler(sessionId, commands);
    }
  }

  private broadcastMessage(sessionId: string, msg: LobbyMessage): void {
    const session = this.sessions.get(sessionId);
    const mode = session?.messageMode ?? 'msg-tidy';

    // msg-only: suppress tool_use and tool_result (control always passes through)
    if (mode === 'msg-only' && (msg.type === 'tool_use' || msg.type === 'tool_result')) {
      return;
    }

    // msg-tidy: individual tool messages still broadcast so listeners can aggregate
    // The actual aggregation is done by ws-handler (web) and channel-router (IM)

    for (const handler of this.messageListeners.values()) {
      handler(sessionId, msg);
    }
  }

  private broadcastSessionUpdate(session: ManagedSession, previousId?: string): void {
    const summary = this.toSummary(session);
    for (const handler of this.sessionUpdateListeners.values()) {
      handler(summary, previousId);
    }
  }

  private toSummary(s: ManagedSession): SessionSummary {
    return {
      id: s.id,
      adapterName: s.adapterName,
      displayName: s.displayName,
      status: s.status,
      lastActiveAt: s.lastActiveAt,
      lastMessage: s.lastMessage,
      messageCount: s.messageCount,
      model: s.model,
      permissionMode: s.permissionMode ?? undefined,
      cwd: s.cwd,
      origin: s.origin,
      messageMode: s.messageMode,
      pinned: s.pinned,
      resumeCommand: this.buildResumeCommand(s),
    };
  }

  private buildResumeCommand(s: ManagedSession): string {
    const parts: string[] = [`cd ${s.cwd}`];
    const adapter = this.adapters.get(s.adapterName);
    let cmd = adapter ? adapter.getResumeCommand(s.id) : `claude --resume ${s.id}`;
    if (s.model) cmd += ` --model ${s.model}`;
    const effectiveMode = this.resolvePermissionMode(s);
    if (effectiveMode !== 'supervised') {
      const nativeLabel = adapter?.permissionMeta.modeLabels[effectiveMode];
      if (nativeLabel) {
        cmd += ` --permission-mode ${nativeLabel}`;
      }
    }
    parts.push(cmd);
    return parts.join(' && ');
  }

  resolvePermissionMode(session: ManagedSession): PermissionMode;
  resolvePermissionMode(adapterName: string, sessionPermission?: PermissionMode | null): PermissionMode;
  resolvePermissionMode(
    sessionOrAdapterName: ManagedSession | string,
    sessionPermission?: PermissionMode | null,
  ): PermissionMode {
    if (typeof sessionOrAdapterName === 'string') {
      if (sessionPermission) return sessionPermission;
      if (this.db) {
        const row = getAdapterDefault(this.db, sessionOrAdapterName);
        if (row) return row.permission_mode as PermissionMode;
      }
      return 'supervised';
    }
    const session = sessionOrAdapterName;
    if (session.permissionMode) return session.permissionMode;
    if (this.db) {
      const row = getAdapterDefault(this.db, session.adapterName);
      if (row) return row.permission_mode as PermissionMode;
    }
    return 'supervised';
  }

  /**
   * Sync session ID if the adapter resolved the real CLI session ID.
   * Called whenever we detect a mismatch between process.sessionId and session.id.
   */
  /**
   * Sync session ID if the adapter resolved the real CLI session ID.
   * Returns the old ID if it changed, undefined otherwise.
   */
  private syncSessionId(session: ManagedSession): string | undefined {
    const process = session.process;
    if (process.sessionId === session.id) return undefined;

    const oldId = session.id;
    this.sessions.delete(oldId);
    session.id = process.sessionId;
    session.previousIds.push(oldId);
    this.sessions.set(session.id, session);
    // Record alias so clients using stale IDs can still be resolved
    this.sessionIdAliases.set(oldId, session.id);
    if (this.db) {
      dbDeleteSession(this.db, oldId);
    }
    this.persistSession(session);
    // Migrate message cache to new ID
    const cached = this.messageCache.get(oldId);
    if (cached) {
      this.messageCache.set(session.id, cached);
      this.messageCache.delete(oldId);
    }
    console.log(`[SessionManager] Session ID synced: ${oldId} → ${session.id}`);
    return oldId;
  }

  /**
   * Resolve a session ID that may be stale (pre-migration UUID) to the current ID.
   * Returns the session if found, undefined otherwise.
   */
  resolveSession(sessionId: string): ManagedSession | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    // Check alias map for migrated IDs
    const currentId = this.sessionIdAliases.get(sessionId);
    if (currentId) {
      console.log(`[SessionManager] resolveSession: alias hit ${sessionId} → ${currentId}`);
      return this.sessions.get(currentId);
    }
    // Last resort: check previousIds on each session (survives alias map loss on server reload)
    for (const session of this.sessions.values()) {
      if (session.previousIds.includes(sessionId)) {
        console.log(`[SessionManager] resolveSession: previousIds hit ${sessionId} → ${session.id}`);
        // Backfill alias map for future lookups
        this.sessionIdAliases.set(sessionId, session.id);
        return session;
      }
    }
    console.warn(`[SessionManager] resolveSession: MISS for ${sessionId}, sessions=[${[...this.sessions.keys()].join(', ')}]`);
    return undefined;
  }

  private wireProcessEvents(session: ManagedSession): void {
    const process = session.process;

    // Guard: ignore events from stale processes (e.g., after /new rebuild)
    const isStale = () => session.process !== process;

    process.on('message', (msg: LobbyMessage) => {
      if (isStale()) return;

      // Sync session ID as soon as possible (system message carries real ID)
      const prevId = this.syncSessionId(session);
      if (prevId) {
        this.broadcastSessionUpdate(session, prevId);
      }

      session.messageCount++;
      session.lastActiveAt = Date.now();

      if (typeof msg.content === 'string' && msg.content.length > 0) {
        session.lastMessage = msg.content.slice(0, 100);
      }

      if (msg.type === 'control') {
        session.status = 'awaiting_approval';
        this.persistSessionStatus(session);
        this.broadcastSessionUpdate(session);
      }

      // Cache message for history fallback
      let cache = this.messageCache.get(session.id);
      if (!cache) {
        cache = [];
        this.messageCache.set(session.id, cache);
      }
      cache.push(msg);

      this.broadcastMessage(session.id, msg);

      // Reset token counters on compact completion
      if (
        msg.type === 'system' &&
        typeof msg.content === 'object' &&
        msg.content !== null &&
        (msg.content as Record<string, unknown>).compact === true
      ) {
        session.tokenUsage.inputTokens = 0;
        session.tokenUsage.outputTokens = 0;
        session.tokenUsage.totalTokens = 0;
        session.tokenUsage.compactCount += 1;
        session.tokenUsage.compactPrompted = false;
        for (const handler of this.compactCompleteListeners.values()) {
          handler(session, msg.content);
        }
      }

      // Accumulate token usage from result messages
      if (msg.type === 'result' && msg.meta?.tokenUsage) {
        const tu = msg.meta.tokenUsage as { input: number; output: number };
        session.tokenUsage.inputTokens += tu.input;
        session.tokenUsage.outputTokens += tu.output;
        session.tokenUsage.totalTokens += tu.input + tu.output;

        // Check compact threshold
        const threshold = this.db
          ? parseInt(getServerConfig(this.db, 'compactThreshold') ?? '150000', 10)
          : 150000;

        if (
          session.tokenUsage.totalTokens >= threshold &&
          !session.tokenUsage.compactPrompted
        ) {
          session.tokenUsage.compactPrompted = true;
          const suggestionMsg: LobbyMessage = {
            id: randomUUID(),
            sessionId: session.id,
            timestamp: Date.now(),
            type: 'system',
            content: {
              compactSuggestion: true,
              currentTokens: session.tokenUsage.totalTokens,
              threshold,
            },
          };
          this.broadcastMessage(session.id, suggestionMsg);
          for (const handler of this.compactSuggestionListeners.values()) {
            handler(session);
          }
        }
      }
    });

    process.on('commands', (commands: AdapterCommand[]) => {
      if (isStale()) return;
      // Persist commands per session in SQLite
      if (this.db) {
        upsertSessionCommands(this.db, session.id, JSON.stringify(commands));
      }
      this.broadcastCommands(session.id, commands);
    });

    process.on('idle', () => {
      if (isStale()) return;
      session.status = 'idle';
      const prevId = this.syncSessionId(session);
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session, prevId);
    });

    process.on('exit', () => {
      if (isStale()) return;
      // Lobby Manager stays idle on exit so it can be resumed
      session.status = session.origin === 'lobby-manager'
        ? 'idle'
        : (process.status === 'error' ? 'error' : 'stopped');
      const prevId = this.syncSessionId(session);
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session, prevId);
    });

    process.on('error', () => {
      if (isStale()) return;
      // Lobby Manager stays idle even on error so it can be resumed
      session.status = session.origin === 'lobby-manager' ? 'idle' : 'error';
      const prevId = this.syncSessionId(session);
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session, prevId);
    });
  }

  private persistSession(session: ManagedSession): void {
    if (!this.db) return;
    upsertSession(this.db, {
      id: session.id,
      adapter_name: session.adapterName,
      display_name: session.displayName,
      cwd: session.cwd,
      jsonl_path: null,
      origin: session.origin,
      status: session.status,
      created_at: session.createdAt,
      last_active_at: session.lastActiveAt,
      model: session.model ?? null,
      tags: null,
      permission_mode: session.permissionMode ?? null,
      message_mode: session.messageMode,
      pinned: session.pinned ? 1 : 0,
    });
  }

  async createSession(
    adapterName: string,
    options: SpawnOptions,
    displayName?: string,
    origin: 'lobby' | 'cli' | 'lobby-manager' = 'lobby',
  ): Promise<ManagedSession> {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) {
      throw new Error(`Adapter "${adapterName}" not found`);
    }

    const effectivePermission = this.resolvePermissionMode(adapterName, options.permissionMode);
    const spawnOptions = { ...options, permissionMode: effectivePermission };
    const process = await adapter.spawn(spawnOptions);

    const session: ManagedSession = {
      id: process.sessionId,
      previousIds: [],
      adapterName,
      displayName: displayName ?? `Session ${this.sessions.size + 1}`,
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      cwd: options.cwd,
      process,
      messageCount: 0,
      model: options.model,
      permissionMode: options.permissionMode,
      origin,
      messageMode: (options as any).messageMode ?? (this.db ? (getServerConfig(this.db, 'defaultMessageMode') as MessageMode | undefined) : undefined) ?? 'msg-tidy',
      pinned: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        compactCount: 0,
        compactPrompted: false,
      },
    };

    this.wireProcessEvents(session);
    this.sessions.set(session.id, session);
    this.persistSession(session);
    this.broadcastSessionUpdate(session);
    // Send initial prompt AFTER events are wired to avoid race condition
    if (options.prompt) {
      process.sendMessage(options.prompt);
    }
    return session;
  }

  async resumeSession(
    sessionId: string,
    adapterName: string,
    options: SpawnOptions,
    displayName: string,
    origin: 'lobby' | 'cli' | 'lobby-manager' = 'lobby',
  ): Promise<ManagedSession> {
    const adapter = this.adapters.get(adapterName);
    if (!adapter) throw new Error(`Adapter "${adapterName}" not found`);

    const process = await adapter.resume(sessionId, options);
    const session: ManagedSession = {
      id: process.sessionId,
      previousIds: [],
      adapterName,
      displayName,
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      cwd: options.cwd,
      process,
      messageCount: 0,
      model: options.model,
      permissionMode: options.permissionMode,
      origin,
      messageMode: (options as any).messageMode ?? 'msg-tidy',
      pinned: false,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        compactCount: 0,
        compactPrompted: false,
      },
    };
    this.wireProcessEvents(session);
    this.sessions.set(session.id, session);
    this.persistSession(session);
    // Send initial prompt AFTER events are wired to avoid race condition
    if (options.prompt) {
      process.sendMessage(options.prompt);
    }
    return session;
  }

  configureSession(sessionId: string, options: Partial<SpawnOptions> & { messageMode?: MessageMode }): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    session.process.updateOptions(options);
    if (options.model) session.model = options.model;
    if (options.permissionMode) session.permissionMode = options.permissionMode;
    if (options.messageMode) session.messageMode = options.messageMode;
    this.persistSession(session);
    this.broadcastSessionUpdate(session);
  }

  async sendMessage(sessionId: string, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      // Lazy resume: session exists in SQLite but has no live process
      const resumed = await this.lazyResume(sessionId, content);
      if (!resumed) throw new Error(`Session "${sessionId}" not found`);
      return;
    }

    // If the process is dead (stopped/error), remove stale session and lazy-resume from SQLite
    const processStatus = session.process.status;
    if (processStatus === 'stopped' || processStatus === 'error') {
      console.log(`[SessionManager] Process dead (${processStatus}), re-resuming session ${sessionId}`);
      this.sessions.delete(sessionId);
      const resumed = await this.lazyResume(sessionId, content);
      if (!resumed) throw new Error(`Session "${sessionId}" could not be resumed`);
      return;
    }

    session.process.sendMessage(content);
    session.status = 'running';
    session.lastActiveAt = Date.now();
    this.persistSessionStatus(session);
    this.broadcastSessionUpdate(session);
  }

  /** Resume a session from SQLite that has no live process */
  private async lazyResume(
    sessionId: string,
    prompt: string,
  ): Promise<ManagedSession | null> {
    if (!this.db) return null;
    const rows = getAllSessions(this.db);
    const row = rows.find((r) => r.id === sessionId);
    if (!row) return null;

    const adapter = this.adapters.get(row.adapter_name);
    if (!adapter) return null;

    console.log(`[SessionManager] Lazy-resuming session ${sessionId}`);
    const sessionPermission = (row.permission_mode as PermissionMode | null) ?? undefined;
    const effectivePermission = this.resolvePermissionMode(row.adapter_name, sessionPermission);
    const process = await adapter.resume(sessionId, {
      prompt,
      cwd: row.cwd,
      permissionMode: effectivePermission,
    });

    const session: ManagedSession = {
      id: sessionId,
      previousIds: [],
      adapterName: row.adapter_name,
      displayName: row.display_name ?? sessionId.slice(0, 8),
      status: 'running',
      createdAt: row.created_at,
      lastActiveAt: Date.now(),
      cwd: row.cwd,
      process,
      messageCount: 0,
      model: row.model ?? undefined,
      permissionMode: sessionPermission ?? undefined,
      origin: row.origin as 'lobby' | 'cli' | 'lobby-manager',
      messageMode: (row.message_mode as MessageMode) ?? 'msg-tidy',
      pinned: row.pinned === 1,
      tokenUsage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        compactCount: 0,
        compactPrompted: false,
      },
    };

    // Wire up events BEFORE sending prompt to avoid race condition
    this.wireProcessEvents(session);
    this.sessions.set(session.id, session);
    this.persistSessionStatus(session);
    this.broadcastSessionUpdate(session);
    // Send the initial prompt after events are wired
    process.sendMessage(prompt);
    return session;
  }

  respondControl(
    sessionId: string,
    requestId: string,
    decision: ControlDecision,
    payload?: Record<string, unknown>,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    session.process.respondControl(requestId, decision, payload);
    // Restore status from awaiting_approval to running
    if (session.status === 'awaiting_approval') {
      session.status = 'running';
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session);
    }
  }

  getSession(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  getCachedMessages(sessionId: string): LobbyMessage[] {
    return this.messageCache.get(sessionId) ?? [];
  }

  getAdapterForSession(sessionId: string): AgentAdapter | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      return this.adapters.get(session.adapterName);
    }
    // Check SQLite for stopped sessions
    if (this.db) {
      const rows = getAllSessions(this.db);
      const row = rows.find((r) => r.id === sessionId);
      if (row) {
        return this.adapters.get(row.adapter_name);
      }
    }
    return undefined;
  }

  listSessions(): SessionSummary[] {
    const result: SessionSummary[] = [];
    const seenIds = new Set<string>();

    // Active in-memory sessions first
    for (const s of this.sessions.values()) {
      result.push(this.toSummary(s));
      seenIds.add(s.id);
    }

    // Add stopped sessions from SQLite that aren't in memory
    if (this.db) {
      const rows = getAllSessions(this.db);
      for (const row of rows) {
        if (seenIds.has(row.id)) continue;
        const rowAdapter = this.adapters.get(row.adapter_name);
        let resumeCmd = rowAdapter
          ? `cd ${row.cwd} && ${rowAdapter.getResumeCommand(row.id)}`
          : `cd ${row.cwd} && claude --resume ${row.id}`;
        if (row.model) resumeCmd += ` --model ${row.model}`;
        result.push({
          id: row.id,
          adapterName: row.adapter_name,
          displayName: row.display_name ?? row.id.slice(0, 8),
          status: row.status,
          lastActiveAt: row.last_active_at,
          messageCount: 0,
          model: row.model ?? undefined,
          permissionMode: (row.permission_mode as PermissionMode | null) ?? undefined,
          cwd: row.cwd,
          origin: row.origin as 'lobby' | 'cli',
          messageMode: (row.message_mode as MessageMode) ?? 'msg-tidy',
          resumeCommand: resumeCmd,
          jsonlPath: row.jsonl_path ?? undefined,
          pinned: row.pinned === 1,
        });
      }
    }

    // Sort by lastActiveAt descending
    result.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return result;
  }

  /**
   * Discover CLI-native sessions from all adapters, excluding sessions already managed.
   */
  async discoverSessions(cwd?: string): Promise<SessionSummary[]> {
    const managedIds = new Set<string>();

    // Collect IDs from in-memory sessions
    for (const id of this.sessions.keys()) {
      managedIds.add(id);
    }

    // Collect IDs from SQLite
    if (this.db) {
      const rows = getAllSessions(this.db);
      for (const row of rows) {
        managedIds.add(row.id);
      }
    }

    const discovered: SessionSummary[] = [];
    for (const adapter of this.adapters.values()) {
      try {
        const sessions = await adapter.discoverSessions(cwd);
        for (const s of sessions) {
          if (!managedIds.has(s.id)) {
            discovered.push(s);
          }
        }
      } catch (err) {
        console.error(`[SessionManager] discoverSessions error for ${adapter.name}:`, err);
      }
    }

    // Sort all discovered sessions by time (newest first), regardless of adapter
    discovered.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return discovered;
  }

  /**
   * Import a discovered CLI-native session into SQLite (without starting a process).
   * Status is 'idle' — user can send messages and the session will be lazily resumed.
   */
  importSession(data: {
    sessionId: string;
    adapterName: string;
    displayName?: string;
    cwd: string;
    jsonlPath?: string;
  }): SessionSummary {
    const now = Date.now();
    if (this.db) {
      upsertSession(this.db, {
        id: data.sessionId,
        adapter_name: data.adapterName,
        display_name: data.displayName ?? data.sessionId.slice(0, 8),
        cwd: data.cwd,
        jsonl_path: data.jsonlPath ?? null,
        origin: 'cli',
        status: 'idle',
        created_at: now,
        last_active_at: now,
        model: null,
        tags: null,
        permission_mode: null,
        message_mode: null,
        pinned: 0,
      });
    }

    const adapter = this.adapters.get(data.adapterName);
    const resumeCmd = adapter
      ? `cd ${data.cwd} && ${adapter.getResumeCommand(data.sessionId)}`
      : `cd ${data.cwd}`;

    const summary: SessionSummary = {
      id: data.sessionId,
      adapterName: data.adapterName,
      displayName: data.displayName ?? data.sessionId.slice(0, 8),
      status: 'idle',
      lastActiveAt: now,
      messageCount: 0,
      cwd: data.cwd,
      origin: 'cli',
      resumeCommand: resumeCmd,
      jsonlPath: data.jsonlPath,
      pinned: false,
    };

    // Broadcast so all WS clients see the imported session
    for (const handler of this.sessionUpdateListeners.values()) {
      handler(summary);
    }

    return summary;
  }

  pinSession(sessionId: string, pinned: boolean): void {
    // Write DB first for crash safety
    if (this.db) {
      updateSessionPinned(this.db, sessionId, pinned);
    }
    // Update in-memory session if active
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pinned = pinned;
      this.broadcastSessionUpdate(session);
    }
  }

  renameSession(sessionId: string, displayName: string): void {
    // Write DB first for crash safety
    if (this.db) {
      updateSessionDisplayName(this.db, sessionId, displayName);
    }
    // Update in-memory session if active
    const session = this.sessions.get(sessionId);
    if (session) {
      session.displayName = displayName;
      this.broadcastSessionUpdate(session);
    }
  }

  getSessionInfo(sessionId: string): SessionSummary | undefined {
    const session = this.sessions.get(sessionId);
    if (session) return this.toSummary(session);

    // Check SQLite for stopped sessions
    if (this.db) {
      const rows = getAllSessions(this.db);
      const row = rows.find((r) => r.id === sessionId);
      if (row) {
        return {
          id: row.id,
          adapterName: row.adapter_name,
          displayName: row.display_name ?? row.id.slice(0, 8),
          status: row.status,
          lastActiveAt: row.last_active_at,
          messageCount: 0,
          model: row.model ?? undefined,
          permissionMode: (row.permission_mode as PermissionMode | null) ?? undefined,
          cwd: row.cwd,
          origin: row.origin as 'lobby' | 'cli',
          messageMode: (row.message_mode as MessageMode) ?? 'msg-tidy',
          resumeCommand: (() => {
            const a = this.adapters.get(row.adapter_name);
            return a ? `cd ${row.cwd} && ${a.getResumeCommand(row.id)}` : `cd ${row.cwd} && claude --resume ${row.id}`;
          })(),
          jsonlPath: row.jsonl_path ?? undefined,
          pinned: row.pinned === 1,
        };
      }
    }
    return undefined;
  }

  registerWebViewer(listenerId: string, sessionId: string | null): void {
    // Remove from previous session
    const prevSession = this.viewerSessions.get(listenerId);
    if (prevSession) {
      this.webViewers.get(prevSession)?.delete(listenerId);
      if (this.webViewers.get(prevSession)?.size === 0) {
        this.webViewers.delete(prevSession);
      }
    }

    if (sessionId) {
      this.viewerSessions.set(listenerId, sessionId);
      if (!this.webViewers.has(sessionId)) {
        this.webViewers.set(sessionId, new Set());
      }
      this.webViewers.get(sessionId)!.add(listenerId);
    } else {
      this.viewerSessions.delete(listenerId);
    }
  }

  unregisterWebViewer(listenerId: string): void {
    this.registerWebViewer(listenerId, null);
  }

  isSessionViewedOnWeb(sessionId: string): boolean {
    return (this.webViewers.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Rebuild the underlying CLI session without changing the lobby session identity.
   * Stops the current process and spawns a new one with the same config.
   * If the session is only in SQLite (e.g., after server reload), it will be resumed.
   */
  async rebuildSession(sessionId: string): Promise<void> {
    let session = this.resolveSession(sessionId);

    // Fallback: session may exist in SQLite but not in memory (after server reload)
    if (!session && this.db) {
      const rows = getAllSessions(this.db);
      const row = rows.find((r) => r.id === sessionId);
      if (row) {
        console.log(`[SessionManager] rebuildSession: session ${sessionId} not in memory, found in DB — resuming fresh`);
        const adapter = this.adapters.get(row.adapter_name);
        if (!adapter) throw new Error(`Adapter "${row.adapter_name}" not found`);

        const effectivePermission = this.resolvePermissionMode(row.adapter_name,
          (row.permission_mode as PermissionMode | null) ?? undefined);
        const newProcess = await adapter.spawn({
          cwd: row.cwd,
          model: row.model ?? undefined,
          permissionMode: effectivePermission,
        });

        session = {
          id: sessionId,
          previousIds: [],
          adapterName: row.adapter_name,
          displayName: row.display_name ?? sessionId.slice(0, 8),
          status: 'running',
          createdAt: row.created_at,
          lastActiveAt: Date.now(),
          cwd: row.cwd,
          process: newProcess,
          messageCount: 0,
          model: row.model ?? undefined,
          permissionMode: (row.permission_mode as PermissionMode | null) ?? undefined,
          origin: row.origin as 'lobby' | 'cli' | 'lobby-manager',
          messageMode: (row.message_mode as MessageMode) ?? 'msg-tidy',
          pinned: row.pinned === 1,
          tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            compactCount: 0,
            compactPrompted: false,
          },
        };

        const rebuilt = session;
        this.wireProcessEvents(rebuilt);
        this.sessions.set(rebuilt.id, rebuilt);
        this.persistSessionStatus(rebuilt);

        // Broadcast that the session is now alive
        const sysMsg: LobbyMessage = {
          id: `rebuild-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: rebuilt.id,
          timestamp: Date.now(),
          type: 'system',
          content: 'CLI session rebuilt (resumed from database)',
        };
        // Reset cache to only contain the rebuild notice
        this.messageCache.set(rebuilt.id, [sysMsg]);

        this.broadcastMessage(rebuilt.id, sysMsg);
        this.broadcastSessionUpdate(rebuilt);
        return;
      }
    }

    if (!session) throw new Error(`Session "${sessionId}" not found`);

    const adapter = this.adapters.get(session.adapterName);
    if (!adapter) throw new Error(`Adapter "${session.adapterName}" not found`);

    // Read current spawn options from the process
    const currentOpts = (session.process as unknown as { spawnOptions?: SpawnOptions })?.spawnOptions;
    const spawnOptions = {
      ...currentOpts,
      cwd: session.cwd,
      model: session.model,
      permissionMode: this.resolvePermissionMode(session),
    };

    // Stop existing process (graceful, not destroy)
    try {
      session.process.kill();
    } catch {
      // Process may already be dead
    }

    // Spawn new process with same config
    const newProcess = await adapter.spawn(spawnOptions);

    // Replace process reference
    session.process = newProcess;
    session.status = 'running';
    session.lastActiveAt = Date.now();

    // Re-wire events
    this.wireProcessEvents(session);
    this.persistSessionStatus(session);

    // Clear message cache — new process starts with a clean slate
    const sysMsg: LobbyMessage = {
      id: `rebuild-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sessionId: session.id,
      timestamp: Date.now(),
      type: 'system',
      content: 'CLI session rebuilt',
    };
    // Reset cache to only contain the rebuild notice
    this.messageCache.set(session.id, [sysMsg]);

    this.broadcastMessage(session.id, sysMsg);
    this.broadcastSessionUpdate(session);
  }

  getAdapterDefaults(): Array<{ adapterName: string; permissionMode: PermissionMode; displayName: string }> {
    const defaults = this.db ? getAllAdapterDefaults(this.db) : [];
    const defaultMap = new Map(defaults.map((d) => [d.adapter_name, d.permission_mode as PermissionMode]));
    const result: Array<{ adapterName: string; permissionMode: PermissionMode; displayName: string }> = [];
    for (const adapter of this.adapters.values()) {
      result.push({
        adapterName: adapter.name,
        permissionMode: defaultMap.get(adapter.name) ?? 'supervised',
        displayName: adapter.displayName,
      });
    }
    return result;
  }

  setAdapterDefault(adapterName: string, permissionMode: PermissionMode): void {
    if (!this.db) return;
    setAdapterDefault(this.db, adapterName, permissionMode);
  }

  getAdapterPermissionMeta(): Record<string, { displayName: string; modeLabels: Record<string, string> }> {
    const meta: Record<string, { displayName: string; modeLabels: Record<string, string> }> = {};
    for (const adapter of this.adapters.values()) {
      meta[adapter.name] = {
        displayName: adapter.displayName,
        modeLabels: adapter.permissionMeta.modeLabels,
      };
    }
    return meta;
  }

  getSessionMode(sessionId: string): MessageMode {
    const session = this.sessions.get(sessionId);
    return session?.messageMode ?? 'msg-tidy';
  }

  async cleanupIdle(maxIdleMinutes: number = 60): Promise<string[]> {
    const cutoff = Date.now() - maxIdleMinutes * 60 * 1000;
    const destroyed: string[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'idle' && session.lastActiveAt < cutoff) {
        session.process.kill();
        this.sessions.delete(id);
        if (this.db) dbDeleteSession(this.db, id);
        destroyed.push(id);
      }
    }

    return destroyed;
  }

  /**
   * Recover a stopped/error session to idle so the user can retry interaction.
   * Cleans up the dead in-memory process (if any) and updates SQLite.
   */
  recoverSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Remove dead process from memory — next message triggers lazyResume
      this.sessions.delete(sessionId);
    }

    if (this.db) {
      updateSessionStatus(this.db, sessionId, 'idle', Date.now());
    }

    // Broadcast the new idle status to all clients
    const summary = this.getSessionInfo(sessionId);
    if (summary) {
      for (const handler of this.sessionUpdateListeners.values()) {
        handler(summary);
      }
    }
  }

  async interruptSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.process.interrupt();
    // Force status to idle immediately so the UI updates.
    // If the adapter later emits 'idle', the handler is harmless (sets idle again).
    // Without this, interrupt on an idle process (e.g. right after /new rebuild)
    // would never emit 'idle' and the status stays stuck at 'running'.
    if (session.status === 'running' || session.status === 'awaiting_approval') {
      session.status = 'idle';
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session);
    }
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.process.kill();
      this.sessions.delete(sessionId);
    }
    // Clean up aliases pointing to this session
    for (const [alias, target] of this.sessionIdAliases) {
      if (target === sessionId) this.sessionIdAliases.delete(alias);
    }
    if (this.db) {
      dbDeleteSession(this.db, sessionId);
    }
  }

  private persistSessionStatus(session: ManagedSession): void {
    if (!this.db) return;
    updateSessionStatus(this.db, session.id, session.status, session.lastActiveAt);
  }
}

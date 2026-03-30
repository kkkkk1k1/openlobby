import type {
  AgentAdapter,
  AgentProcess,
  SpawnOptions,
  LobbyMessage,
  SessionSummary,
  ControlDecision,
  AdapterCommand,
} from '@openlobby/core';
import type Database from 'better-sqlite3';
import {
  upsertSession,
  deleteSession as dbDeleteSession,
  updateSessionStatus,
  updateSessionDisplayName,
  getAllSessions,
  getSessionCommands,
  upsertSessionCommands,
} from './db.js';

export interface ManagedSession {
  id: string;
  adapterName: string;
  displayName: string;
  status: 'running' | 'idle' | 'stopped' | 'error' | 'awaiting_approval';
  createdAt: number;
  lastActiveAt: number;
  cwd: string;
  process: AgentProcess;
  messageCount: number;
  model?: string;
  permissionMode?: string;
  lastMessage?: string;
  origin: 'lobby' | 'cli' | 'lobby-manager';
  planMode: boolean;
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
  /** Track planMode for sessions not yet in memory (set before lazy resume) */
  private pendingPlanMode = new Map<string, boolean>();
  /** In-memory message cache as fallback when adapter can't read history from disk */
  private messageCache = new Map<string, LobbyMessage[]>();
  /** Track which sessions are being viewed on web (sessionId → set of listener IDs) */
  private webViewers = new Map<string, Set<string>>();
  /** Reverse map: listenerId → sessionId they're viewing */
  private viewerSessions = new Map<string, string>();

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
    const permMode = s.permissionMode ??
      (s.process as unknown as { spawnOptions?: { permissionMode?: string } })
        ?.spawnOptions?.permissionMode;
    return {
      id: s.id,
      adapterName: s.adapterName,
      displayName: s.displayName,
      status: s.status,
      lastActiveAt: s.lastActiveAt,
      lastMessage: s.lastMessage,
      messageCount: s.messageCount,
      model: s.model,
      permissionMode: permMode,
      cwd: s.cwd,
      origin: s.origin,
      planMode: s.planMode,
      resumeCommand: this.buildResumeCommand(s),
    };
  }

  private buildResumeCommand(s: ManagedSession): string {
    const parts: string[] = [`cd ${s.cwd}`];
    const adapter = this.adapters.get(s.adapterName);
    let cmd = adapter ? adapter.getResumeCommand(s.id) : `claude --resume ${s.id}`;
    if (s.model) cmd += ` --model ${s.model}`;
    // Check process spawnOptions for permissionMode
    const permMode = (s.process as unknown as { spawnOptions?: { permissionMode?: string } })
      ?.spawnOptions?.permissionMode;
    if (permMode && permMode !== 'default') {
      cmd += ` --permission-mode ${permMode}`;
    }
    parts.push(cmd);
    return parts.join(' && ');
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
    this.sessions.set(session.id, session);
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

  private wireProcessEvents(session: ManagedSession): void {
    const process = session.process;

    process.on('message', (msg: LobbyMessage) => {
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
    });

    process.on('commands', (commands: AdapterCommand[]) => {
      // Persist commands per session in SQLite
      if (this.db) {
        upsertSessionCommands(this.db, session.id, JSON.stringify(commands));
      }
      this.broadcastCommands(session.id, commands);
    });

    process.on('idle', () => {
      session.status = 'idle';
      const prevId = this.syncSessionId(session);
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session, prevId);
    });

    process.on('exit', () => {
      // Lobby Manager stays idle on exit so it can be resumed
      session.status = session.origin === 'lobby-manager'
        ? 'idle'
        : (process.status === 'error' ? 'error' : 'stopped');
      const prevId = this.syncSessionId(session);
      this.persistSessionStatus(session);
      this.broadcastSessionUpdate(session, prevId);
    });

    process.on('error', () => {
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

    const process = await adapter.spawn(options);

    const session: ManagedSession = {
      id: process.sessionId,
      adapterName,
      displayName: displayName ?? `Session ${this.sessions.size + 1}`,
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      cwd: options.cwd,
      process,
      messageCount: 0,
      model: options.model,
      origin,
      planMode: false,
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
      adapterName,
      displayName,
      status: 'running',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      cwd: options.cwd,
      process,
      messageCount: 0,
      model: options.model,
      origin,
      planMode: false,
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

  configureSession(sessionId: string, options: Partial<SpawnOptions>): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session "${sessionId}" not found`);
    session.process.updateOptions(options);
    if (options.model) session.model = options.model;
    if (options.permissionMode) session.permissionMode = options.permissionMode;
    this.broadcastSessionUpdate(session);
  }

  setPlanMode(sessionId: string, enabled: boolean): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Live session in memory — toggle on process too
      session.planMode = enabled;
      session.process.setPlanMode?.(enabled);
      this.broadcastSessionUpdate(session);
      return;
    }

    // Session not in memory (idle/stopped in SQLite) — store pending state and
    // broadcast to frontend. When lazily resumed, the pending state is applied.
    const summary = this.getSessionInfo(sessionId);
    if (!summary) throw new Error(`Session "${sessionId}" not found`);
    this.pendingPlanMode.set(sessionId, enabled);
    summary.planMode = enabled;
    for (const handler of this.sessionUpdateListeners.values()) {
      handler(summary);
    }
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
    const process = await adapter.resume(sessionId, { prompt, cwd: row.cwd });

    const session: ManagedSession = {
      id: sessionId,
      adapterName: row.adapter_name,
      displayName: row.display_name ?? sessionId.slice(0, 8),
      status: 'running',
      createdAt: row.created_at,
      lastActiveAt: Date.now(),
      cwd: row.cwd,
      process,
      messageCount: 0,
      model: row.model ?? undefined,
      origin: row.origin as 'lobby' | 'cli' | 'lobby-manager',
      planMode: this.pendingPlanMode.get(sessionId) ?? false,
    };

    // Apply pending plan mode to the process
    if (session.planMode) {
      session.process.setPlanMode?.(true);
      this.pendingPlanMode.delete(sessionId);
    }

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
          cwd: row.cwd,
          origin: row.origin as 'lobby' | 'cli',
          resumeCommand: resumeCmd,
          jsonlPath: row.jsonl_path ?? undefined,
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
    };

    // Broadcast so all WS clients see the imported session
    for (const handler of this.sessionUpdateListeners.values()) {
      handler(summary);
    }

    return summary;
  }

  renameSession(sessionId: string, newName: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.displayName = newName;
      this.broadcastSessionUpdate(session);
    }
    if (this.db) {
      updateSessionDisplayName(this.db, sessionId, newName);
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
          cwd: row.cwd,
          origin: row.origin as 'lobby' | 'cli',
          resumeCommand: (() => {
            const a = this.adapters.get(row.adapter_name);
            return a ? `cd ${row.cwd} && ${a.getResumeCommand(row.id)}` : `cd ${row.cwd} && claude --resume ${row.id}`;
          })(),
          jsonlPath: row.jsonl_path ?? undefined,
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

  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.process.kill();
      this.sessions.delete(sessionId);
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

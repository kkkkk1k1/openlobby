import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn as spawnChild, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
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

// ──────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────

/** System prompt injected in readonly/plan mode */
const GSD_PLAN_MODE_PROMPT = `You are in PLAN MODE. Only explore the codebase and produce a detailed implementation plan. Do NOT modify any files. Use only read-only tools.`;

/** Static commands for GSD adapter */
const GSD_COMMANDS: AdapterCommand[] = [
  { name: '/gsd', description: 'Start a new GSD task' },
  { name: '/gsd auto', description: 'Run in fully autonomous mode' },
  { name: '/gsd quick', description: 'Quick task — minimal planning' },
  { name: '/gsd discuss', description: 'Discussion mode — no tool execution' },
  { name: '/gsd status', description: 'Show current session status' },
  { name: '/gsd queue', description: 'Show queued tasks' },
  { name: '/gsd prefs', description: 'Show or update preferences' },
  { name: '/gsd stop', description: 'Stop the current task' },
  { name: '/gsd logs', description: 'Show session logs' },
  { name: '/gsd doctor', description: 'Run diagnostics' },
];

/** Approval timeout in milliseconds (5 minutes) */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Binary candidates — gsd-pi installs as both `gsd` and `gsd-cli` */
const GSD_BIN_CANDIDATES = ['gsd', 'gsd-cli'] as const;

/**
 * Detect the GSD binary. Returns the first candidate that resolves successfully.
 * Caches the result for the process lifetime.
 */
let cachedBin: { bin: string; version: string; path: string } | null = null;
function detectGsdBin(): { bin: string; version: string; path: string } | null {
  if (cachedBin) return cachedBin;
  for (const bin of GSD_BIN_CANDIDATES) {
    try {
      const version = execSync(`${bin} --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
      const binPath = execSync(`which ${bin}`, { encoding: 'utf-8', timeout: 5000 }).trim();
      cachedBin = { bin, version, path: binPath };
      return cachedBin;
    } catch {
      continue;
    }
  }
  return null;
}

// ──────────────────────────────────────────────
// GsdProcess
// ──────────────────────────────────────────────

/**
 * Represents a running GSD session via `gsd headless --supervised --output-format stream-json`.
 *
 * Communication: JSONL over stdin/stdout.
 * The process sends structured events on stdout, and we write user messages / approval
 * responses as JSONL on stdin.
 */
class GsdProcess extends EventEmitter implements AgentProcess {
  sessionId: string;
  readonly adapter = 'gsd';
  status: AgentProcess['status'] = 'idle';

  private childProcess: ChildProcess | null = null;
  private lineBuffer = '';
  private spawnOptions: SpawnOptions;
  private killedIntentionally = false;
  private initialized = false;
  private commandsEmitted = false;

  /** Pending approval controls: requestId → { timer, resolve } */
  private pendingControls = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; resolve: () => void }
  >();

  /** Cost tracking from cost_update events */
  private lastCost: { totalCostUsd?: number; inputTokens?: number; outputTokens?: number; model?: string } = {};

  /** Accumulated text for current streaming block */
  private streamingText = '';

  constructor(sessionId: string, options: SpawnOptions) {
    super();
    this.sessionId = sessionId;
    this.spawnOptions = options;
  }

  /**
   * Spawn the GSD headless subprocess and wire up stdout/stderr/exit handlers.
   */
  async init(mode: 'spawn' | 'resume', resumeSessionId?: string): Promise<void> {
    const args = ['headless', '--supervised', '--output-format', 'stream-json'];

    if (mode === 'resume' && resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    // Map permission mode to GSD's native flags
    const permMode = this.spawnOptions.permissionMode ?? 'supervised';
    if (permMode === 'auto') {
      // Replace --supervised with auto-approve semantics
      const idx = args.indexOf('--supervised');
      if (idx !== -1) args.splice(idx, 1);
      args.push('--auto-approve');
    } else if (permMode === 'readonly') {
      args.push('--readonly');
    }
    // 'supervised' is the default (--supervised already in args)

    if (this.spawnOptions.model) {
      args.push('--model', this.spawnOptions.model);
    }

    const env = { ...process.env };
    if (this.spawnOptions.apiKey) {
      env.ANTHROPIC_AUTH_TOKEN = this.spawnOptions.apiKey;
    }

    const detected = detectGsdBin();
    const bin = detected?.bin ?? 'gsd';
    console.log('[GSD] Spawning:', bin, args.join(' '));

    this.childProcess = spawnChild(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.spawnOptions.cwd,
      env,
    });

    this.childProcess.stdout!.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk.toString('utf-8'));
    });

    this.childProcess.stderr!.on('data', (chunk: Buffer) => {
      console.error('[GSD stderr]', chunk.toString('utf-8'));
    });

    this.childProcess.on('exit', (code) => {
      console.log(`[GSD] Process exited with code ${code}`);
      if (!this.killedIntentionally) {
        this.status = code === 0 ? 'stopped' : 'error';
      }
      this.childProcess = null;
      this.emit('exit', code ?? 1);
    });

    this.childProcess.on('error', (err) => {
      console.error('[GSD] Process error:', err);
      this.status = 'error';
      this.emit('error', err);
    });

    // Wait briefly to ensure the subprocess actually starts (catches missing binary)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(); // Subprocess is alive — proceed
      }, 500);

      const onError = (err: Error) => {
        clearTimeout(timer);
        cleanup();
        reject(err);
      };

      const onExit = (code: number | null) => {
        clearTimeout(timer);
        cleanup();
        reject(new Error(`gsd process exited immediately with code ${code}`));
      };

      const cleanup = () => {
        this.childProcess?.removeListener('error', onError);
        this.childProcess?.removeListener('exit', onExit);
      };

      this.childProcess!.on('error', onError);
      this.childProcess!.on('exit', onExit);
    });

    this.initialized = true;
    this.status = 'idle';

    // Emit initial system message
    this.emit('message', makeLobbyMessage(this.sessionId, 'system', {
      sessionId: this.sessionId,
      adapter: 'gsd',
      mode: permMode,
    }));

    // NOTE: commands are emitted lazily on first init_result or idle,
    // so the caller can wire event listeners before they fire.
  }

  // ── Public API (AgentProcess) ──

  sendMessage(content: string): void {
    if (!this.initialized || !this.childProcess?.stdin?.writable) {
      console.warn('[GSD] Not ready to send message');
      return;
    }

    this.status = 'running';
    console.log('[GSD] Sending user_message:', content.slice(0, 100));

    // Build user_message JSONL
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg: any = {
      type: 'user_message',
      content,
    };

    // Inject plan-mode system prompt if readonly
    if (this.spawnOptions.permissionMode === 'readonly' && this.spawnOptions.systemPrompt == null) {
      msg.system_prompt = GSD_PLAN_MODE_PROMPT;
    } else if (this.spawnOptions.systemPrompt) {
      msg.system_prompt = this.spawnOptions.systemPrompt;
    }

    this.writeJsonl(msg);
  }

  respondControl(requestId: string, decision: ControlDecision, _payload?: Record<string, unknown>): void {
    const pending = this.pendingControls.get(requestId);
    if (!pending) {
      console.warn('[GSD] No pending control for:', requestId);
      return;
    }

    console.log('[GSD] Control response:', requestId, decision);
    clearTimeout(pending.timer);
    this.pendingControls.delete(requestId);

    // Send extension_ui_response back to GSD
    this.writeJsonl({
      type: 'extension_ui_response',
      request_id: requestId,
      decision: decision === 'allow' ? 'approve' : 'deny',
    });

    if (this.status === 'awaiting_approval') {
      this.status = 'running';
    }

    pending.resolve();
  }

  updateOptions(opts: Partial<SpawnOptions>): void {
    Object.assign(this.spawnOptions, opts);
    console.log('[GSD] Options updated:', Object.keys(opts));
  }

  interrupt(): void {
    if (this.status !== 'running' && this.status !== 'awaiting_approval') return;
    console.log('[GSD] Interrupting current generation');
    this.killedIntentionally = true;
    if (this.childProcess) {
      this.childProcess.kill('SIGINT');
    }
    this.status = 'idle';
    this.emit('idle');
  }

  kill(): void {
    console.log('[GSD] Killing process');
    this.killedIntentionally = true;

    // Resolve all pending controls (deny them)
    for (const [requestId, pending] of this.pendingControls.entries()) {
      clearTimeout(pending.timer);
      // Best-effort deny
      this.writeJsonl({
        type: 'extension_ui_response',
        request_id: requestId,
        decision: 'deny',
      });
      pending.resolve();
    }
    this.pendingControls.clear();

    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.status = 'stopped';
    this.emit('exit', 0);
  }

  /** Emit commands event once (deferred until first init_result or idle) */
  private emitCommandsOnce(): void {
    if (this.commandsEmitted) return;
    this.commandsEmitted = true;
    this.emit('commands', GSD_COMMANDS);
  }

  // ── JSONL transport ──

  private writeJsonl(obj: unknown): void {
    if (!this.childProcess?.stdin?.writable) {
      console.warn('[GSD] stdin not writable');
      return;
    }
    const line = JSON.stringify(obj) + '\n';
    this.childProcess.stdin.write(line);
  }

  // ── JSONL parsing from stdout ──

  private handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.handleEvent(msg);
      } catch {
        console.warn('[GSD] Failed to parse line:', line.slice(0, 200));
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleEvent(event: any): void {
    const type = event.type as string | undefined;
    if (!type) return;

    console.log('[GSD] <<', type, JSON.stringify(event).slice(0, 300));

    switch (type) {
      case 'init_result':
        this.handleInitResult(event);
        break;

      case 'message_update':
        this.handleMessageUpdate(event);
        break;

      case 'tool_execution_start':
        this.handleToolExecutionStart(event);
        break;

      case 'tool_execution_end':
        this.handleToolExecutionEnd(event);
        break;

      case 'extension_ui_request':
        this.handleExtensionUiRequest(event);
        break;

      case 'cost_update':
        this.handleCostUpdate(event);
        break;

      case 'execution_complete':
      case 'agent_end':
        this.handleExecutionComplete(event);
        break;

      case 'error':
        this.handleError(event);
        break;

      default:
        // Ignore unknown event types
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleInitResult(event: any): void {
    // Sync session ID from GSD
    if (event.session_id) {
      console.log('[GSD] Session ID synced:', event.session_id);
      this.sessionId = event.session_id;
    }
    this.status = 'idle';
    this.emitCommandsOnce();
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleMessageUpdate(event: any): void {
    const subType = event.sub_type as string | undefined;

    switch (subType) {
      case 'text_start':
        // Beginning of a new text block — reset accumulator
        this.streamingText = '';
        this.status = 'running';
        break;

      case 'text_delta': {
        // Streaming text chunk
        const delta = event.text ?? event.delta ?? event.content ?? '';
        if (delta) {
          this.streamingText += delta;
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'stream_delta',
            delta,
          ));
        }
        break;
      }

      case 'text_end':
        // End of text block — emit the full assistant message
        if (this.streamingText) {
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'assistant',
            this.streamingText,
            { model: this.lastCost.model },
          ));
          this.streamingText = '';
        }
        break;

      default:
        // Unknown sub_type — treat as plain text if content is present
        if (event.text || event.content) {
          const text = event.text ?? event.content ?? '';
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'assistant',
            typeof text === 'string' ? text : JSON.stringify(text),
            { model: this.lastCost.model },
          ));
        }
        break;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleToolExecutionStart(event: any): void {
    const toolName = event.tool_name ?? event.name ?? 'unknown';
    const toolInput = event.input ?? event.arguments ?? event.params ?? {};

    this.emit('message', makeLobbyMessage(
      this.sessionId,
      'tool_use',
      typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput, null, 2),
      { toolName },
    ));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleToolExecutionEnd(event: any): void {
    const toolName = event.tool_name ?? event.name ?? 'unknown';
    const output = event.output ?? event.result ?? '';
    const isError = event.is_error === true || event.error === true;

    this.emit('message', makeLobbyMessage(
      this.sessionId,
      'tool_result',
      typeof output === 'string' ? output : JSON.stringify(output),
      { toolName, isError },
    ));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleExtensionUiRequest(event: any): void {
    const requestId = event.request_id ?? event.id ?? randomUUID();
    const toolName = event.tool_name ?? event.title ?? event.description ?? 'approval';
    const toolInput = event.metadata ?? event.details ?? {};

    const mode = this.spawnOptions.permissionMode ?? 'supervised';

    console.log('[GSD] Extension UI request:', toolName, 'id:', requestId, 'mode:', mode);

    // Auto mode: immediately approve
    if (mode === 'auto') {
      console.log('[GSD] Auto mode: approved', toolName);
      this.writeJsonl({
        type: 'extension_ui_response',
        request_id: requestId,
        decision: 'approve',
      });
      return;
    }

    // Readonly mode: auto-reject
    if (mode === 'readonly') {
      console.log('[GSD] Readonly mode: rejected', toolName);
      this.writeJsonl({
        type: 'extension_ui_response',
        request_id: requestId,
        decision: 'deny',
      });
      this.emit('message', makeLobbyMessage(
        this.sessionId,
        'tool_result',
        `[Readonly mode] Denied: ${toolName}`,
        { toolName, isError: false },
      ));
      return;
    }

    // Supervised mode: emit control message for user approval
    this.status = 'awaiting_approval';

    this.emit('message', makeLobbyMessage(this.sessionId, 'control', {
      requestId,
      toolName: typeof toolName === 'string' ? toolName : String(toolName),
      toolInput: typeof toolInput === 'object' ? toolInput : { value: toolInput },
    }));

    // Set up timeout — auto-deny after 5 minutes
    const timer = setTimeout(() => {
      if (this.pendingControls.has(requestId)) {
        console.log('[GSD] Approval timeout, auto-denying:', requestId);
        this.pendingControls.delete(requestId);
        this.writeJsonl({
          type: 'extension_ui_response',
          request_id: requestId,
          decision: 'deny',
        });
        if (this.status === 'awaiting_approval') {
          this.status = 'running';
        }
        this.emit('message', makeLobbyMessage(
          this.sessionId,
          'tool_result',
          `[Timeout] Auto-denied: ${toolName}`,
          { toolName, isError: false },
        ));
      }
    }, APPROVAL_TIMEOUT_MS);

    this.pendingControls.set(requestId, {
      timer,
      resolve: () => {},
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleCostUpdate(event: any): void {
    this.lastCost = {
      totalCostUsd: event.total_cost_usd ?? event.cost_usd ?? event.cost,
      inputTokens: event.input_tokens ?? event.tokens?.input,
      outputTokens: event.output_tokens ?? event.tokens?.output,
      model: event.model ?? this.lastCost.model,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleExecutionComplete(event: any): void {
    this.status = 'idle';

    // Emit result message with cost info
    this.emit('message', makeLobbyMessage(
      this.sessionId,
      'result',
      {
        subtype: event.type === 'agent_end' ? 'agent_end' : 'execution_complete',
        durationMs: event.duration_ms,
      },
      {
        model: this.lastCost.model,
        costUsd: this.lastCost.totalCostUsd,
        tokenUsage: (this.lastCost.inputTokens != null || this.lastCost.outputTokens != null)
          ? { input: this.lastCost.inputTokens ?? 0, output: this.lastCost.outputTokens ?? 0 }
          : undefined,
      },
    ));

    this.emitCommandsOnce();
    this.emit('idle');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleError(event: any): void {
    const errorMsg = event.message ?? event.error ?? 'Unknown GSD error';
    console.error('[GSD] Error event:', errorMsg);
    this.status = 'error';

    this.emit('message', makeLobbyMessage(
      this.sessionId,
      'system',
      { error: errorMsg },
      { isError: true },
    ));
    this.emit('error', new Error(typeof errorMsg === 'string' ? errorMsg : JSON.stringify(errorMsg)));
  }
}

// ──────────────────────────────────────────────
// GsdAdapter
// ──────────────────────────────────────────────

export class GsdAdapter implements AgentAdapter {
  readonly name = 'gsd';
  readonly displayName = 'GSD';
  readonly permissionMeta: AdapterPermissionMeta = {
    modeLabels: {
      auto: 'auto-approve',
      supervised: 'supervised',
      readonly: 'readonly + plan',
    },
  };

  async detect(): Promise<{ installed: boolean; version?: string; path?: string }> {
    const detected = detectGsdBin();
    if (detected) {
      return { installed: true, version: detected.version, path: detected.path };
    }
    return { installed: false };
  }

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const sessionId = randomUUID();
    console.log('[GsdAdapter] Spawning session:', sessionId);
    const proc = new GsdProcess(sessionId, options);
    await proc.init('spawn');
    return proc;
  }

  async resume(sessionId: string, options?: ResumeOptions): Promise<AgentProcess> {
    const proc = new GsdProcess(sessionId, {
      cwd: options?.cwd ?? process.cwd(),
      systemPrompt: options?.systemPrompt,
      model: options?.model,
      permissionMode: options?.permissionMode,
      apiKey: options?.apiKey,
    });
    await proc.init('resume', sessionId);
    return proc;
  }

  getSessionStoragePath(): string {
    return join(homedir(), '.gsd', 'sessions');
  }

  async readSessionHistory(sessionId: string): Promise<LobbyMessage[]> {
    const jsonlPath = this.findSessionJsonl(sessionId);
    if (!jsonlPath) return [];

    const messages: LobbyMessage[] = [];
    const rl = createInterface({
      input: createReadStream(jsonlPath, { encoding: 'utf-8' }),
    });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const converted = this.jsonlLineToLobbyMessages(sessionId, obj);
        messages.push(...converted);
      } catch {
        // skip malformed lines
      }
    }

    return messages;
  }

  async discoverSessions(filterCwd?: string): Promise<SessionSummary[]> {
    const storagePath = this.getSessionStoragePath();
    if (!existsSync(storagePath)) return [];

    const results: SessionSummary[] = [];
    this.walkSessionDirs(storagePath, results, filterCwd);
    results.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return results;
  }

  getResumeCommand(sessionId: string): string {
    const bin = detectGsdBin()?.bin ?? 'gsd';
    return `${bin} --resume ${sessionId}`;
  }

  async listCommands(): Promise<AdapterCommand[]> {
    return GSD_COMMANDS;
  }

  // ── Private helpers ──

  private findSessionJsonl(sessionId: string): string | null {
    const storagePath = this.getSessionStoragePath();
    if (!existsSync(storagePath)) return null;

    try {
      return this.walkForSession(storagePath, sessionId);
    } catch {
      return null;
    }
  }

  private walkForSession(dir: string, sessionId: string): string | null {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }

    for (const name of names) {
      const fullPath = join(dir, name);
      try {
        const s = statSync(fullPath);
        if (s.isDirectory()) {
          const found = this.walkForSession(fullPath, sessionId);
          if (found) return found;
        } else if (name.endsWith('.jsonl')) {
          if (name.includes(sessionId)) return fullPath;
          // Check first line for session_id
          try {
            const fd = openSync(fullPath, 'r');
            const buf = Buffer.alloc(4096);
            const bytesRead = readSync(fd, buf, 0, 4096, 0);
            closeSync(fd);
            const firstLine = buf.toString('utf-8', 0, bytesRead).split('\n')[0];
            if (firstLine) {
              const obj = JSON.parse(firstLine);
              if (obj.session_id === sessionId || obj.id === sessionId) {
                return fullPath;
              }
            }
          } catch {
            // skip
          }
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private walkSessionDirs(
    dir: string,
    results: SessionSummary[],
    filterCwd?: string,
  ): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names) {
      const fullPath = join(dir, name);
      try {
        const s = statSync(fullPath);
        if (s.isDirectory()) {
          this.walkSessionDirs(fullPath, results, filterCwd);
          continue;
        }
      } catch {
        continue;
      }

      if (name.endsWith('.jsonl')) {
        try {
          const meta = this.extractSessionMeta(fullPath);
          if (!meta) continue;
          if (filterCwd && meta.cwd !== filterCwd) continue;
          if (!meta.cwd && meta.messageCount === 0) continue;

          const stat = statSync(fullPath);
          results.push({
            id: meta.sessionId,
            adapterName: this.name,
            displayName: meta.displayName || meta.sessionId.slice(0, 8),
            status: 'stopped',
            lastActiveAt: stat.mtimeMs,
            lastMessage: meta.lastMessage,
            messageCount: meta.messageCount,
            model: meta.model,
            cwd: meta.cwd || '',
            origin: 'cli',
            resumeCommand: this.getResumeCommand(meta.sessionId),
            jsonlPath: fullPath,
          });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  /**
   * Synchronously read the first 64KB of a GSD session JSONL to extract metadata.
   */
  private extractSessionMeta(filePath: string): {
    sessionId: string;
    cwd: string;
    model?: string;
    displayName?: string;
    lastMessage?: string;
    messageCount: number;
  } | null {
    try {
      const fname = basename(filePath, '.jsonl');
      const uuidMatch = fname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);

      // Read first 64KB
      const fd = openSync(filePath, 'r');
      const buf = Buffer.alloc(65536);
      const bytesRead = readSync(fd, buf, 0, 65536, 0);
      closeSync(fd);

      const content = buf.toString('utf-8', 0, bytesRead);
      const lines = content.split('\n').filter((l: string) => l.trim());

      let sessionId: string | null = uuidMatch ? uuidMatch[1] : null;
      let cwd = '';
      let model: string | undefined;
      let messageCount = 0;
      let lastMessage: string | undefined;

      for (const line of lines.slice(0, 20)) {
        try {
          const obj = JSON.parse(line);
          if (obj.session_id && !sessionId) sessionId = obj.session_id;
          if (obj.id && !sessionId) sessionId = obj.id;

          // init_result event
          if (obj.type === 'init_result') {
            if (obj.session_id) sessionId = obj.session_id;
            if (obj.cwd) cwd = obj.cwd;
            if (obj.model) model = obj.model;
          }

          if (obj.cwd && !cwd) cwd = obj.cwd;
          if (obj.model && !model) model = obj.model;

          // Count meaningful events
          if (obj.type === 'execution_complete' || obj.type === 'agent_end'
            || obj.type === 'message_update' || obj.type === 'tool_execution_end') {
            messageCount++;
          }

          // Extract user message for display
          if (obj.type === 'user_message') {
            const text = typeof obj.content === 'string' ? obj.content : '';
            if (text) lastMessage = text.slice(0, 100);
          }
        } catch {
          // skip malformed lines (truncated by buffer boundary)
        }
      }

      if (!sessionId) {
        sessionId = fname;
      }

      return { sessionId, cwd, model, messageCount, displayName: lastMessage?.slice(0, 30), lastMessage };
    } catch {
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jsonlLineToLobbyMessages(sessionId: string, obj: any): LobbyMessage[] {
    const type = obj.type as string | undefined;
    const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
    const id = obj.id ?? randomUUID();

    if (!type) {
      // Session header line
      if (obj.session_id) {
        return [makeLobbyMessage(sessionId, 'system', {
          sessionId: obj.session_id,
          model: obj.model,
        })];
      }
      return [];
    }

    switch (type) {
      case 'init_result':
        return [makeLobbyMessage(sessionId, 'system', {
          sessionId: obj.session_id ?? sessionId,
          model: obj.model,
        })];

      case 'user_message': {
        const content = typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content ?? '');
        return [{ id, sessionId, timestamp, type: 'user', content }];
      }

      case 'message_update': {
        const subType = obj.sub_type;
        if (subType === 'text_end' || (!subType && obj.text)) {
          const text = obj.text ?? obj.content ?? '';
          if (text) {
            return [{ id, sessionId, timestamp, type: 'assistant', content: text, meta: { model: obj.model } }];
          }
        }
        break;
      }

      case 'tool_execution_start': {
        const toolName = obj.tool_name ?? obj.name ?? 'unknown';
        const input = obj.input ?? obj.arguments ?? {};
        return [{
          id, sessionId, timestamp, type: 'tool_use',
          content: typeof input === 'string' ? input : JSON.stringify(input, null, 2),
          meta: { toolName },
        }];
      }

      case 'tool_execution_end': {
        const toolName = obj.tool_name ?? obj.name ?? 'unknown';
        const output = obj.output ?? obj.result ?? '';
        return [{
          id, sessionId, timestamp, type: 'tool_result',
          content: typeof output === 'string' ? output : JSON.stringify(output),
          meta: { toolName, isError: obj.is_error === true },
        }];
      }

      case 'execution_complete':
      case 'agent_end':
        return [{
          id, sessionId, timestamp, type: 'result',
          content: 'Completed',
          meta: {
            costUsd: obj.total_cost_usd ?? obj.cost_usd,
            tokenUsage: (obj.input_tokens != null || obj.output_tokens != null)
              ? { input: obj.input_tokens ?? 0, output: obj.output_tokens ?? 0 }
              : undefined,
          },
        }];

      case 'error':
        return [{
          id, sessionId, timestamp, type: 'system',
          content: { error: obj.message ?? obj.error ?? 'Unknown error' },
          meta: { isError: true },
        }];
    }

    return [];
  }
}

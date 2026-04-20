import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn as spawnChild, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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
import { detectInstalledBinary, findExecutable } from './command-utils.js';

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

/**
 * Extract text from various content formats that Codex might send.
 * Handles: string, array of blocks, object with text field.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextFromContent(content: any): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block?.type === 'output_text' || block?.type === 'text') {
        parts.push(block.text ?? '');
      } else if (block?.text) {
        // Fallback: any block with a text field
        parts.push(block.text);
      }
    }
    return parts.join('');
  }

  if (content && typeof content === 'object' && 'text' in content) {
    return (content as { text: string }).text ?? '';
  }

  return '';
}

// ──────────────────────────────────────────────
// CodexCliProcess
// ──────────────────────────────────────────────

/**
 * Represents a running Codex CLI session via `codex app-server --stdio`.
 *
 * Communication: JSON-RPC 2.0 over stdin/stdout (NDJSON).
 * The process is bidirectional:
 *   - We send requests (thread/start, turn/start, etc.) with incrementing `id`.
 *   - The server can send us requests (requestApproval) with its own `id`
 *     that we must respond to.
 */
/** System prompt injected when plan mode is active */
const CODEX_PLAN_MODE_PROMPT = `You are in PLAN MODE. Only analyze, explore (read files, search), and plan. Do NOT write, edit, create, or delete any files. Do NOT execute any commands that modify the system. Only use read-only tools.`;

/** Static commands for Codex CLI (no plugin/skill system) */
const CODEX_COMMANDS: AdapterCommand[] = [
  { name: '/help', description: 'Show help information' },
  { name: '/model', description: 'Switch the AI model', args: '<model-name>' },
  { name: '/approval', description: 'Change approval mode', args: '<mode>' },
];

const EARLY_EXIT_DETECTION_MS = 500;

export type CodexLaunchSpec = {
  command: string;
  args: string[];
  shell?: boolean;
};

function quoteWindowsShellArg(value: string): string {
  // `shell: true` uses cmd.exe on Windows, which expects embedded quotes doubled.
  return `"${value.replace(/"/g, '""')}"`;
}

function resolveCodexCliPath(cliPath?: string): string {
  if (cliPath) return cliPath;

  const resolved = findExecutable('codex');

  if (!resolved) {
    throw new Error('Codex CLI not found. Install `@openai/codex` and ensure `codex` is on your PATH.');
  }

  return resolved;
}

export function buildCodexLaunchSpec(cliPath?: string): CodexLaunchSpec {
  const resolvedCliPath = resolveCodexCliPath(cliPath);
  const args = ['app-server', '--listen', 'stdio://'];

  if (process.platform !== 'win32') {
    return { command: resolvedCliPath, args };
  }

  const lowerPath = resolvedCliPath.toLowerCase();
  if (lowerPath.endsWith('.exe') || lowerPath.endsWith('.com')) {
    return { command: resolvedCliPath, args };
  }

  if (lowerPath.endsWith('.cmd') || lowerPath.endsWith('.bat')) {
    const command = [resolvedCliPath, ...args]
      .map(quoteWindowsShellArg)
      .join(' ');
    return { command, args: [], shell: true };
  }

  throw new Error(
    `Codex CLI resolved to "${resolvedCliPath}", but Windows requires a .cmd or .exe launcher. Reinstall Codex CLI or add codex.cmd to PATH.`,
  );
}

class CodexCliProcess extends EventEmitter implements AgentProcess {
  sessionId: string;
  readonly adapter = 'codex-cli';
  status: AgentProcess['status'] = 'idle';

  private childProcess: ChildProcess | null = null;
  private rpcId = 0;
  private pendingRpc = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private pendingControls = new Map<
    string,
    { rpcId: number; resolve: () => void }
  >();
  private threadId: string | null = null;
  private initialized = false;
  private lineBuffer = '';
  private spawnOptions: SpawnOptions;
  private injectedMcpServers: string[] = [];
  private originalInstructions: string | undefined;
  /** Set to true when kill() is called intentionally, so exit handler respects it */
  private killedIntentionally = false;
  private readonly cliPath?: string;

  constructor(sessionId: string, options: SpawnOptions, cliPath?: string) {
    super();
    this.sessionId = sessionId;
    this.spawnOptions = options;
    this.cliPath = cliPath;
  }

  /**
   * Start the app-server child process, perform handshake, and optionally
   * create or resume a thread.
   */
  async init(mode: 'spawn' | 'resume', resumeThreadId?: string): Promise<void> {
    const env = { ...process.env };
    if (this.spawnOptions.apiKey) {
      env.OPENAI_API_KEY = this.spawnOptions.apiKey;
    }
    const launchSpec = buildCodexLaunchSpec(this.cliPath);
    this.childProcess = spawnChild(launchSpec.command, launchSpec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.spawnOptions.cwd,
      env,
      shell: launchSpec.shell,
    });

    this.childProcess.stdout!.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk.toString('utf-8'));
    });

    this.childProcess.stderr!.on('data', (chunk: Buffer) => {
      console.error('[Codex stderr]', chunk.toString('utf-8'));
    });

    this.childProcess.on('exit', (code) => {
      console.log(`[Codex] Process exited with code ${code}`);
      // If kill() was called intentionally, keep 'stopped' status regardless of exit code
      if (!this.killedIntentionally) {
        this.status = code === 0 ? 'stopped' : 'error';
        if (code !== 0) {
          this.rejectPendingRpc(new Error(`Codex CLI exited with code ${code}`));
        }
      }
      this.childProcess = null;
      this.emit('exit', code ?? 1);
    });

    this.childProcess.on('error', (err) => {
      console.error('[Codex] Process error:', err);
      this.status = 'error';
      this.rejectPendingRpc(err);
      this.emitErrorSafely(err);
    });

    await this.waitForEarlyExit();

    // === Initialization handshake ===
    try {
      await this.sendRpc('initialize', {
        clientInfo: {
          name: 'openlobby',
          title: 'OpenLobby',
          version: '0.2.0',
        },
      });
      // Send `initialized` notification (no id → notification)
      this.sendNotification('initialized', {});
      this.initialized = true;
      console.log('[Codex] Handshake complete');
    } catch (err) {
      console.error('[Codex] Handshake failed:', err);
      this.kill();
      throw err;
    }

    // === Inject MCP servers via config/value/write (before thread/start) ===
    if (this.spawnOptions.mcpServers) {
      for (const [name, config] of Object.entries(this.spawnOptions.mcpServers)) {
        try {
          await this.sendRpc('config/value/write', {
            keyPath: `mcp_servers.${name}`,
            value: {
              command: config.command,
              args: config.args ?? [],
              env: config.env ?? {},
            },
            mergeStrategy: 'upsert',
          });
          this.injectedMcpServers.push(name);
          console.log(`[Codex] MCP server injected: ${name}`);
        } catch (err) {
          console.warn(`[Codex] Failed to inject MCP server ${name}:`, err);
        }
      }
      if (this.injectedMcpServers.length > 0) {
        try {
          await this.sendRpc('config/mcpServer/reload', {});
          console.log('[Codex] MCP servers reloaded');
        } catch (err) {
          console.warn('[Codex] Failed to reload MCP servers:', err);
        }
      }
    }

    // === Start or resume thread ===
    try {
      if (mode === 'resume' && resumeThreadId) {
        const result = await this.sendRpc('thread/resume', {
          threadId: resumeThreadId,
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.threadId = (result as any)?.thread?.id ?? resumeThreadId;
        this.sessionId = this.threadId!;

        // NOTE: Do NOT use config/value/write for instructions or approval_policy
        // on resume — it pollutes the global ~/.codex/config.toml and affects ALL
        // Codex CLI sessions. The thread already inherits its original
        // developerInstructions from when it was created via thread/start.
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const params: any = {
          cwd: this.spawnOptions.cwd,
          approvalPolicy: this.mapPermissionMode(this.spawnOptions.permissionMode),
          sandbox: this.mapSandboxMode(this.spawnOptions.permissionMode),
        };
        if (this.spawnOptions.model) {
          params.model = this.spawnOptions.model;
        }
        if (this.spawnOptions.systemPrompt) {
          params.developerInstructions = this.spawnOptions.systemPrompt;
        }
        const result = await this.sendRpc('thread/start', params);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.threadId = (result as any)?.thread?.id ?? null;
        if (this.threadId) {
          this.sessionId = this.threadId;
        }
      }

      this.status = 'idle';
      this.emit('message', makeLobbyMessage(this.sessionId, 'system', {
        sessionId: this.sessionId,
        threadId: this.threadId,
        adapter: 'codex-cli',
      }));

      // Fetch skills from app-server and emit for session-level caching
      this.fetchSkills();

      // NOTE: Do NOT send prompt here. The caller must wire events first,
      // then call sendMessage() to avoid race condition.
    } catch (err) {
      console.error('[Codex] Thread start/resume failed:', err);
      this.emit('message', makeLobbyMessage(this.sessionId, 'system', {
        error: err instanceof Error ? err.message : String(err),
      }, { isError: true }));
      this.status = 'error';
      this.emitErrorSafely(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Fetch available skills via skills/list RPC and emit as commands */
  private fetchSkills(): void {
    this.sendRpc('skills/list', { cwds: [this.spawnOptions.cwd] })
      .then((result) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data = (result as any)?.data as Array<{
          skills: Array<{
            name: string;
            description: string;
            shortDescription?: string;
            enabled: boolean;
          }>;
        }> | undefined;
        if (!data) {
          console.log('[Codex] skills/list returned no data, using fallback');
          this.emit('commands', CODEX_COMMANDS);
          return;
        }
        const commands: AdapterCommand[] = [...CODEX_COMMANDS];
        for (const entry of data) {
          for (const skill of entry.skills) {
            if (!skill.enabled) continue;
            commands.push({
              name: skill.name.startsWith('/') ? skill.name : `/${skill.name}`,
              description: skill.shortDescription ?? skill.description,
            });
          }
        }
        console.log(`[Codex] skills/list: ${commands.length} commands (${commands.length - CODEX_COMMANDS.length} skills)`);
        this.emit('commands', commands);
      })
      .catch((err) => {
        // skills/list not supported in this version — fall back to static list
        console.warn('[Codex] skills/list failed (may not be supported):', (err as Error).message);
        this.emit('commands', CODEX_COMMANDS);
      });
  }

  // ── Public API (AgentProcess) ──

  sendMessage(content: string): void {
    if (!this.initialized || !this.threadId) {
      console.warn('[Codex] Not ready to send message');
      return;
    }

    this.status = 'running';
    console.log('[Codex] Sending turn/start:', content.slice(0, 100));

    this.sendRpc('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: content }],
    }).catch((err) => {
      console.error('[Codex] turn/start failed:', err);
      this.status = 'error';
      this.emit('message', makeLobbyMessage(this.sessionId, 'system', {
        error: err instanceof Error ? err.message : String(err),
      }, { isError: true }));
    });
  }

  respondControl(requestId: string, decision: ControlDecision): void {
    const pending = this.pendingControls.get(requestId);
    if (!pending) {
      console.warn('[Codex] No pending control for:', requestId);
      return;
    }

    console.log('[Codex] Control response:', requestId, decision);
    this.pendingControls.delete(requestId);

    // Send JSON-RPC response to the server-initiated request
    const response = { decision: decision === 'allow' ? 'accept' : 'decline' };

    this.writeRaw({
      jsonrpc: '2.0',
      id: pending.rpcId,
      result: response,
    });

    pending.resolve();
  }

  updateOptions(opts: Partial<SpawnOptions>): void {
    Object.assign(this.spawnOptions, opts);
    console.log('[Codex] Options updated:', Object.keys(opts));
  }

  interrupt(): void {
    if (this.status !== 'running' && this.status !== 'awaiting_approval') return;
    console.log('[Codex] Interrupting current generation');
    this.killedIntentionally = true;
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.status = 'idle';
    this.emit('idle');
  }

  kill(): void {
    console.log('[Codex] Killing process');
    this.killedIntentionally = true;
    // Clean up injected MCP servers from global config
    if (this.injectedMcpServers.length > 0 && this.childProcess) {
      for (const name of this.injectedMcpServers) {
        this.sendRpc('config/value/write', {
          keyPath: `mcp_servers.${name}`,
          value: null,
          mergeStrategy: 'replace',
        }).catch(() => {});
      }
      this.injectedMcpServers = [];
    }
    if (this.childProcess) {
      this.childProcess.kill();
      this.childProcess = null;
    }
    this.status = 'stopped';
    this.emit('exit', 0);
  }

  // ── JSON-RPC transport ──

  private nextId(): number {
    return ++this.rpcId;
  }

  private rejectPendingRpc(err: Error): void {
    for (const pending of this.pendingRpc.values()) {
      pending.reject(err);
    }
    this.pendingRpc.clear();
  }

  private emitErrorSafely(err: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', err);
    }
  }

  /**
   * Watch a short window for immediate spawn failures before sending the first RPC.
   * This is crash detection, not a readiness signal from the child process.
   */
  private async waitForEarlyExit(): Promise<void> {
    if (!this.childProcess || this.childProcess.exitCode !== null || this.childProcess.killed) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, EARLY_EXIT_DETECTION_MS);

      const onError = (err: Error) => {
        clearTimeout(timer);
        cleanup();
        reject(err);
      };

      const onExit = (code: number | null) => {
        clearTimeout(timer);
        cleanup();
        reject(new Error(`Codex CLI exited immediately with code ${code}`));
      };

      const cleanup = () => {
        this.childProcess?.removeListener('error', onError);
        this.childProcess?.removeListener('exit', onExit);
      };

      this.childProcess!.on('error', onError);
      this.childProcess!.on('exit', onExit);
    });
  }

  private sendRpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      console.log('[Codex] sendRpc:', method, 'id=', id);
      this.pendingRpc.set(id, { resolve, reject });
      this.writeRaw({ jsonrpc: '2.0', id, method, params });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`RPC timeout: ${method} (id=${id})`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.writeRaw({ jsonrpc: '2.0', method, params });
  }

  private writeRaw(obj: unknown): void {
    if (!this.childProcess?.stdin?.writable) {
      console.warn('[Codex] stdin not writable');
      return;
    }
    const line = JSON.stringify(obj) + '\n';
    this.childProcess.stdin.write(line);
  }

  // ── NDJSON parsing from stdout ──

  private handleStdoutChunk(chunk: string): void {
    this.lineBuffer += chunk;
    const lines = this.lineBuffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        this.handleJsonRpcMessage(msg);
      } catch {
        console.warn('[Codex] Failed to parse line:', line.slice(0, 200));
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleJsonRpcMessage(msg: any): void {
    console.log('[Codex] <<', msg.method ?? `response(id=${msg.id})`, JSON.stringify(msg).slice(0, 300));

    // === Response to our request ===
    if (msg.id != null && !msg.method) {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // === Server-initiated request (has method + id) ===
    if (msg.method && msg.id != null) {
      this.handleServerRequest(msg);
      return;
    }

    // === Notification (has method, no id) ===
    if (msg.method) {
      this.handleNotification(msg);
      return;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleServerRequest(msg: any): void {
    const method = msg.method as string;
    const params = msg.params ?? {};

    if (method === 'mcpServer/elicitation/request') {
      const meta = params._meta ?? {};
      const approvalKind = String(meta.codex_approval_kind ?? '');
      // In plan mode, deny write-like MCP operations
      if (this.spawnOptions.permissionMode === 'readonly' && (approvalKind.includes('write') || approvalKind.includes('edit') || approvalKind.includes('create') || approvalKind.includes('delete'))) {
        console.log('[Codex] Plan mode: denying MCP elicitation:', approvalKind);
        this.writeRaw({
          jsonrpc: '2.0',
          id: msg.id,
          result: { action: 'decline' },
        });
        this.emit('message', makeLobbyMessage(this.sessionId, 'tool_result',
          `[Plan mode] Denied MCP: ${approvalKind}`,
        ));
      } else {
        // Auto-approve read-only MCP operations
        console.log('[Codex] MCP elicitation auto-approved:', approvalKind || method);
        this.writeRaw({
          jsonrpc: '2.0',
          id: msg.id,
          result: { action: 'accept' },
        });
      }
    } else if (
      method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval'
    ) {
      const requestId = randomUUID();
      const toolName = params.command ?? params.fileName ?? method;
      const toolInput = { ...params };

      console.log('[Codex] Approval requested:', toolName);

      this.emit('message', makeLobbyMessage(
        this.sessionId,
        'tool_use',
        JSON.stringify(toolInput, null, 2),
        { toolName: typeof toolName === 'string' ? toolName : String(toolName) },
      ));

      const mode = this.spawnOptions.permissionMode ?? 'supervised';

      // Auto mode: approve immediately
      if (mode === 'auto') {
        console.log('[Codex] Auto mode: approved', toolName);
        this.writeRaw({
          jsonrpc: '2.0',
          id: msg.id,
          result: { decision: 'accept' },
        });
        this.emit('message', makeLobbyMessage(
          this.sessionId,
          'tool_result',
          `[Auto] Approved: ${toolName}`,
          { toolName: typeof toolName === 'string' ? toolName : String(toolName) },
        ));
        return;
      }

      // Readonly mode: auto-deny
      if (mode === 'readonly') {
        console.log('[Codex] Readonly mode: auto-denying', toolName);
        this.writeRaw({
          jsonrpc: '2.0',
          id: msg.id,
          result: { decision: 'decline' },
        });
        this.emit('message', makeLobbyMessage(
          this.sessionId,
          'tool_result',
          `[Readonly mode] Denied: ${toolName}`,
          { toolName: typeof toolName === 'string' ? toolName : String(toolName) },
        ));
        return;
      }

      // Supervised mode: emit control and wait for user
      this.status = 'awaiting_approval';
      this.emit('message', makeLobbyMessage(this.sessionId, 'control', {
        requestId,
        toolName: typeof toolName === 'string' ? toolName : String(toolName),
        toolInput,
      }));

      this.pendingControls.set(requestId, {
        rpcId: msg.id,
        resolve: () => {},
      });
    } else {
      // Unknown server request — respond with error
      console.warn('[Codex] Unknown server request:', method);
      this.writeRaw({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleNotification(msg: any): void {
    const method = msg.method as string;
    const params = msg.params ?? {};

    switch (method) {
      case 'thread.started':
      case 'thread/started':
        if (params.threadId || params.thread?.id) {
          this.threadId = params.threadId ?? params.thread?.id;
          if (this.threadId) this.sessionId = this.threadId;
        }
        break;

      case 'turn.started':
      case 'turn/started':
        this.status = 'running';
        break;

      case 'turn.completed':
      case 'turn/completed': {
        this.status = 'idle';
        const usage = params.usage ?? params.stats;
        this.emit('message', makeLobbyMessage(this.sessionId, 'result', {
          subtype: 'success',
          durationMs: params.duration_ms,
        }, {
          tokenUsage: usage
            ? { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0 }
            : undefined,
          costUsd: usage?.cost_usd,
        }));
        this.emit('idle');
        break;
      }

      case 'turn.failed':
      case 'turn/failed':
        this.status = 'idle';
        this.emit('message', makeLobbyMessage(this.sessionId, 'result', {
          subtype: 'error',
          error: params.error ?? 'Turn failed',
        }, { isError: true }));
        this.emit('idle');
        break;

      case 'item.started':
      case 'item/started': {
        const item = params.item ?? params;
        // Only emit tool_use on item/started; defer agentMessage to item/completed
        if (item.type === 'function_call') {
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            item.arguments ?? JSON.stringify(item.input ?? {}, null, 2),
            { toolName: item.name ?? item.function?.name },
          ));
        } else if (item.type === 'mcpToolCall') {
          // MCP tool call
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            JSON.stringify(item.arguments ?? {}, null, 2),
            { toolName: `${item.server}/${item.tool}` },
          ));
        } else if (item.type === 'commandExecution') {
          // Shell command execution
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            item.command ?? '',
            { toolName: 'shell' },
          ));
        } else if (item.type === 'fileChange' || item.type === 'file_change') {
          // File write/edit
          const fileName = item.fileName ?? item.file ?? item.path ?? '';
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            JSON.stringify({ file: fileName, ...item }, null, 2),
            { toolName: 'fileChange' },
          ));
        } else if (item.name || item.function?.name) {
          // Catch-all: any item with a tool/function name
          console.log('[Codex] Unrecognized item/started type:', item.type, item.name ?? item.function?.name);
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            JSON.stringify(item.arguments ?? item.input ?? {}, null, 2),
            { toolName: item.name ?? item.function?.name },
          ));
        }
        break;
      }

      case 'item.completed':
      case 'item/completed': {
        const item = params.item ?? params;

        // Codex uses "agentMessage" with item.text for assistant replies
        if (item.type === 'agentMessage') {
          const text = item.text ?? extractTextFromContent(item.content);
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'assistant',
            text || '(empty response)',
            { model: params.model },
          ));
          break;
        }

        // Legacy format: type "message" + role "assistant"
        if (item.type === 'message' && item.role === 'assistant') {
          const text = item.text ?? extractTextFromContent(item.content);
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'assistant',
            text || '(empty response)',
            { model: params.model },
          ));
          break;
        }

        // Function call completed — emit tool_use so the card always shows,
        // even if item/started was not sent (e.g., auto-approved read operations)
        if (item.type === 'function_call') {
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            item.arguments ?? JSON.stringify(item.input ?? {}, null, 2),
            { toolName: item.name ?? item.function?.name },
          ));
          // Also emit tool_result if output is available
          if (item.output != null) {
            this.emit('message', makeLobbyMessage(
              this.sessionId,
              'tool_result',
              typeof item.output === 'string' ? item.output : JSON.stringify(item.output),
              { toolName: item.name ?? item.function?.name },
            ));
          }
          break;
        }

        // Function call result (standalone output without the function_call wrapper)
        if (item.type === 'function_call_output') {
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_result',
            typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? {}),
          ));
          break;
        }

        // Command execution completed
        if (item.type === 'commandExecution') {
          // Emit tool_use in case item/started was missed
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            item.command ?? '',
            { toolName: 'shell' },
          ));
          // Emit tool_result with the output
          const output = item.stdout ?? item.output ?? item.stderr ?? '';
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_result',
            typeof output === 'string' ? output : JSON.stringify(output),
            { toolName: 'shell' },
          ));
          break;
        }

        // File change completed
        if (item.type === 'fileChange' || item.type === 'file_change') {
          const fileName = item.fileName ?? item.file ?? item.path ?? '';
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            JSON.stringify({ file: fileName }, null, 2),
            { toolName: 'fileChange' },
          ));
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_result',
            item.status === 'completed' ? `File updated: ${fileName}` : `File change: ${fileName} (${item.status ?? 'done'})`,
            { toolName: 'fileChange' },
          ));
          break;
        }

        // MCP tool call completed — emit tool_use + tool_result
        if (item.type === 'mcpToolCall') {
          const toolName = `${item.server}/${item.tool}`;
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_use',
            JSON.stringify(item.arguments ?? {}, null, 2),
            { toolName },
          ));
          const result = item.result ?? item.error?.message ?? '';
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'tool_result',
            typeof result === 'string' ? result : JSON.stringify(result),
            { toolName },
          ));
        }
        break;
      }

      case 'item/streaming': {
        // Streaming text delta
        const delta = params.delta ?? params;
        if (delta.type === 'output_text_delta' || delta.type === 'content_part_delta') {
          const text = delta.text ?? delta.delta?.text ?? '';
          if (text) {
            this.emit('message', makeLobbyMessage(
              this.sessionId,
              'stream_delta',
              text,
            ));
          }
        }
        break;
      }

      case 'item/agentMessage/delta': {
        // New Codex CLI streaming format
        const text = params.text ?? params.delta?.text ?? '';
        if (text) {
          this.emit('message', makeLobbyMessage(
            this.sessionId,
            'stream_delta',
            text,
          ));
        }
        break;
      }

      case 'thread/status/changed':
      case 'thread/tokenUsage/updated':
      case 'account/rateLimits/updated':
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/summaryTextDelta':
      case 'mcpServer/startupStatus/updated':
      case 'mcpToolCall/progress':
        // Ignore these notifications (status updates / reasoning internals)
        break;

      default:
        // Unknown notification — log with params for debugging
        console.log('[Codex] Unknown notification:', method, JSON.stringify(params).slice(0, 200));
        break;
    }
  }

  private mapPermissionMode(mode?: string): string {
    switch (mode) {
      case 'auto': return 'never';
      case 'bypassPermissions': return 'never';
      case 'dontAsk': return 'never';
      case 'readonly': return 'on-request';
      case 'plan': return 'on-request';
      default: return 'on-request';
    }
  }

  /**
   * Map OpenLobby permission mode to Codex sandbox mode.
   * - auto → danger-full-access (equivalent to --yolo: no sandbox restrictions)
   * - supervised → workspace-write (equivalent to --full-auto: sandboxed writes)
   * - readonly → read-only (no write access)
   */
  private mapSandboxMode(mode?: string): string {
    switch (mode) {
      case 'auto': return 'danger-full-access';
      case 'bypassPermissions': return 'danger-full-access';
      case 'dontAsk': return 'danger-full-access';
      case 'readonly': return 'read-only';
      case 'plan': return 'read-only';
      default: return 'workspace-write';
    }
  }
}

// ──────────────────────────────────────────────
// CodexCliAdapter
// ──────────────────────────────────────────────

export class CodexCliAdapter implements AgentAdapter {
  readonly name = 'codex-cli';
  readonly displayName = 'Codex CLI';
  readonly permissionMeta: AdapterPermissionMeta = {
    modeLabels: {
      auto: 'yolo (no sandbox)',
      supervised: 'full-auto (sandboxed)',
      readonly: 'read-only sandbox + plan',
    },
  };
  private detectedCliPath?: string;

  async detect(): Promise<{ installed: boolean; version?: string; path?: string }> {
    const detected = detectInstalledBinary('codex');
    if (!detected) return { installed: false };
    this.detectedCliPath = detected.path;
    return { installed: true, version: detected.version, path: detected.path };
  }

  private ensureCliPath(): string {
    if (this.detectedCliPath && existsSync(this.detectedCliPath)) {
      return this.detectedCliPath;
    }

    const resolved = resolveCodexCliPath();
    this.detectedCliPath = resolved;
    return resolved;
  }

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const sessionId = randomUUID();
    const cliPath = this.ensureCliPath();
    console.log('[CodexAdapter] Spawning session:', sessionId, 'cli:', cliPath);
    const proc = new CodexCliProcess(sessionId, options, cliPath);
    await proc.init('spawn');
    return proc;
  }

  async resume(sessionId: string, options?: ResumeOptions): Promise<AgentProcess> {
    const cliPath = this.ensureCliPath();
    const proc = new CodexCliProcess(sessionId, {
      cwd: options?.cwd ?? process.cwd(),
      systemPrompt: options?.systemPrompt,
      model: options?.model,
      mcpServers: options?.mcpServers,
      apiKey: options?.apiKey,
      permissionMode: options?.permissionMode,
    }, cliPath);
    await proc.init('resume', sessionId);
    // NOTE: Do NOT send prompt here. The caller must wire events first,
    // then call sendMessage() to avoid race condition.
    return proc;
  }

  getSessionStoragePath(): string {
    return join(homedir(), '.codex', 'sessions');
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
    // Codex stores sessions in YYYY/MM/DD/ directories
    this.walkSessionDirs(storagePath, results, filterCwd);
    results.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return results;
  }

  getResumeCommand(sessionId: string): string {
    return `codex resume ${sessionId}`;
  }

  async listCommands(): Promise<AdapterCommand[]> {
    return CODEX_COMMANDS;
  }

  async resolveSessionCwd(sessionId: string): Promise<string | undefined> {
    const filePath = this.findSessionJsonl(sessionId);
    if (!filePath) return undefined;
    try {
      const meta = this.extractCodexMeta(filePath);
      return meta?.cwd || undefined;
    } catch {
      return undefined;
    }
  }

  // ── Private helpers ──

  private findSessionJsonl(sessionId: string): string | null {
    const storagePath = this.getSessionStoragePath();
    if (!existsSync(storagePath)) return null;

    // Walk through YYYY/MM/DD/ dirs looking for the session
    try {
      return this.walkForSession(storagePath, sessionId);
    } catch {
      return null;
    }
  }

  private walkForSession(dir: string, sessionId: string): string | null {
    const names = readdirSync(dir);
    for (const name of names) {
      const fullPath = join(dir, name);
      try {
        const s = statSync(fullPath);
        if (s.isDirectory()) {
          const found = this.walkForSession(fullPath, sessionId);
          if (found) return found;
        } else if (name.endsWith('.jsonl')) {
          if (name.includes(sessionId)) return fullPath;
          // Also check first line for session_id
          try {
            const firstLine = execSync(`head -1 "${fullPath}"`, { encoding: 'utf-8' });
            const obj = JSON.parse(firstLine);
            if (obj.session_id === sessionId || obj.threadId === sessionId) {
              return fullPath;
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
          const meta = this.extractCodexMeta(fullPath);
          if (!meta) continue;
          if (filterCwd && meta.cwd !== filterCwd) continue;
          // Skip truly empty sessions (no cwd means no session_meta was found)
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
   * Synchronously read the first few lines of a Codex JSONL to extract metadata.
   */
  private extractCodexMeta(filePath: string): {
    sessionId: string;
    cwd: string;
    model?: string;
    displayName?: string;
    lastMessage?: string;
    messageCount: number;
  } | null {
    try {
      // Extract UUID from filename first (format: rollout-YYYY-MM-DDTHH-MM-SS-<uuid>.jsonl)
      const fname = basename(filePath, '.jsonl');
      const uuidMatch = fname.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);

      // Read first 64KB — Codex session_meta lines can be 15KB+ (includes system prompt)
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
          if (obj.threadId && !sessionId) sessionId = obj.threadId;
          if (obj.thread?.id && !sessionId) sessionId = obj.thread.id;
          // Codex JSONL session_meta format
          if (obj.type === 'session_meta' && obj.payload?.id) {
            sessionId = obj.payload.id;
            if (obj.payload.cwd) cwd = obj.payload.cwd;
            if (obj.payload.model) model = obj.payload.model;
            if (obj.payload.model_provider) model = model ?? obj.payload.model_provider;
          }
          // turn_context contains cwd for sessions where session_meta doesn't
          if (obj.type === 'turn_context' && obj.payload?.cwd && !cwd) {
            cwd = obj.payload.cwd;
          }
          if (obj.cwd && !cwd) cwd = obj.cwd;
          if (obj.model_provider || obj.model) model = model ?? obj.model ?? obj.model_provider;
          if (obj.type === 'item.completed' || obj.type === 'turn.completed'
            || obj.type === 'event_msg') messageCount++;
          // Extract user input as lastMessage for display
          if (obj.type === 'response_item' && obj.payload?.role === 'user') {
            const content = obj.payload.content;
            if (Array.isArray(content)) {
              const textPart = content.find((p: { type: string }) => p.type === 'input_text');
              if (textPart?.text && !textPart.text.startsWith('<')) {
                lastMessage = textPart.text.slice(0, 100);
              }
            }
          }
          if (obj.type === 'turn.started' || obj.type === 'turn/started') {
            const input = obj.params?.input ?? obj.input;
            if (Array.isArray(input)) {
              const textPart = input.find((p: { type: string }) => p.type === 'text');
              if (textPart?.text) lastMessage = textPart.text.slice(0, 100);
            } else if (typeof input === 'string') {
              lastMessage = input.slice(0, 100);
            }
          }
        } catch {
          // skip malformed lines (truncated by buffer boundary)
        }
      }

      if (!sessionId) {
        // Use full filename as session ID fallback
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
    const id = obj.id ?? obj.itemId ?? randomUUID();

    if (!type) {
      // First line might be session header
      if (obj.session_id || obj.threadId) {
        return [makeLobbyMessage(sessionId, 'system', {
          sessionId: obj.session_id ?? obj.threadId,
          model: obj.model,
        })];
      }
      return [];
    }

    switch (type) {
      case 'thread.started':
        return [makeLobbyMessage(sessionId, 'system', { threadId: obj.threadId ?? '' })];

      case 'item.started':
      case 'item.completed': {
        const item = obj.item ?? obj;
        // Codex "userMessage" type
        if (item.type === 'userMessage') {
          const content = item.text ?? extractTextFromContent(item.content);
          if (content) {
            return [{ id, sessionId, timestamp, type: 'user', content }];
          }
        }
        // Codex "agentMessage" type
        if (item.type === 'agentMessage') {
          const text = item.text ?? extractTextFromContent(item.content);
          if (text) {
            return [{ id, sessionId, timestamp, type: 'assistant', content: text }];
          }
        }
        // Legacy: type "message" + role
        if (item.type === 'message' && item.role === 'user') {
          const content = item.text ?? extractTextFromContent(item.content);
          if (content) {
            return [{ id, sessionId, timestamp, type: 'user', content }];
          }
        }
        if (item.type === 'message' && item.role === 'assistant') {
          const text = item.text ?? extractTextFromContent(item.content);
          if (text) {
            return [{ id, sessionId, timestamp, type: 'assistant', content: text }];
          }
        }
        if (item.type === 'function_call') {
          return [{
            id,
            sessionId,
            timestamp,
            type: 'tool_use',
            content: item.arguments ?? JSON.stringify(item.input ?? {}, null, 2),
            meta: { toolName: item.name ?? item.function?.name },
          }];
        }
        if (item.type === 'function_call_output' || item.output != null) {
          return [{
            id,
            sessionId,
            timestamp,
            type: 'tool_result',
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? {}),
          }];
        }
        break;
      }

      case 'turn.completed':
        return [{
          id,
          sessionId,
          timestamp,
          type: 'result',
          content: 'Completed',
          meta: {
            tokenUsage: obj.usage
              ? { input: obj.usage.input_tokens ?? 0, output: obj.usage.output_tokens ?? 0 }
              : undefined,
            costUsd: obj.usage?.cost_usd,
          },
        }];

      case 'turn.failed':
        return [{
          id,
          sessionId,
          timestamp,
          type: 'result',
          content: obj.error ?? 'Turn failed',
          meta: { isError: true },
        }];

      // === Codex JSONL format (session file on disk) ===

      case 'session_meta': {
        const payload = obj.payload ?? {};
        return [makeLobbyMessage(sessionId, 'system', {
          sessionId: payload.id ?? sessionId,
          model: payload.model,
        })];
      }

      case 'response_item': {
        const payload = obj.payload ?? {};
        if (payload.type === 'message' && payload.role === 'assistant') {
          const text = payload.text ?? extractTextFromContent(payload.content);
          if (text) return [{ id, sessionId, timestamp, type: 'assistant', content: text }];
        }
        if (payload.type === 'message' && (payload.role === 'user' || payload.role === 'developer')) {
          const text = extractTextFromContent(payload.content);
          if (text) return [{ id, sessionId, timestamp, type: 'user', content: text }];
        }
        if (payload.type === 'function_call') {
          return [{
            id, sessionId, timestamp, type: 'tool_use',
            content: payload.arguments ?? JSON.stringify(payload.input ?? {}, null, 2),
            meta: { toolName: payload.name },
          }];
        }
        if (payload.type === 'function_call_output' || payload.output != null) {
          return [{
            id, sessionId, timestamp, type: 'tool_result',
            content: typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? {}),
          }];
        }
        break;
      }

      case 'event_msg': {
        const payload = obj.payload ?? {};
        if (payload.type === 'task_complete' || payload.type === 'task_completed') {
          return [{ id, sessionId, timestamp, type: 'result', content: 'Completed' }];
        }
        break;
      }

      case 'turn_context':
        // Turn context metadata — skip
        break;
    }

    return [];
  }
}

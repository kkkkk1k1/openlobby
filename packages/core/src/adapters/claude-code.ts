import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn as cpSpawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, win32 as pathWin32 } from 'node:path';
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

/** Claude Code-specific spawn options (extends shared SpawnOptions) */
export interface ClaudeCodeSpawnOptions extends SpawnOptions {
  /**
   * Tools that are auto-allowed without triggering canUseTool.
   * Claude Code SDK-specific — other adapters do not use this.
   * Defaults to ['Read', 'Glob', 'Grep'] if not provided.
   */
  allowedTools?: string[];
}

/**
 * Extract the JavaScript entrypoint from a Windows npm `cmd-shim` file.
 *
 * npm/pnpm generate `<bin>.cmd` launchers whose final invocation line references
 * the underlying `cli.js` relative to the shim directory, e.g.
 *
 *     "%_prog%"  "%~dp0\node_modules\@anthropic-ai\claude-code\cli.js" %*
 *
 * We look for the first quoted `"%~dp0…\<something>.js"` (or the `%dp0%`
 * variant) token and resolve it against the shim's directory. Returns
 * `undefined` when the shim cannot be read, does not match, or the resolved
 * target does not exist.
 */
function parseWindowsCliShim(shimPath: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(shimPath, 'utf-8');
  } catch {
    return undefined;
  }

  // Accepts both `%~dp0` and `%dp0%` token variants used by different shim
  // generators. Captures the path segment (including the leading backslash)
  // up to the .js / .mjs / .cjs extension.
  const match = content.match(/"%(?:~dp0|dp0%)([^"]+\.(?:js|mjs|cjs))"/i);
  if (!match) return undefined;

  const shimDir = pathWin32.dirname(shimPath);
  const relativeSegment = match[1].replace(/^\\+/, '');
  const resolved = pathWin32.join(shimDir, relativeSegment);

  return existsSync(resolved) ? resolved : undefined;
}

/**
 * Decide which executable + entrypoint the Claude Code SDK should spawn.
 *
 * Background: Node ≥ 18.20.2 refuses to spawn `.cmd`/`.bat` files without
 * `shell: true` (CVE-2024-27980). OpenLobby's custom `spawnClaudeCodeProcess`
 * cannot enable `shell: true` because cmd.exe then mangles the JSON passed via
 * `--mcp-config`. Instead we resolve `.cmd` shims to their underlying `cli.js`
 * and tell the SDK to run it with the current `node` — the SDK does
 * `spawn("node", [cli.js, ...])` which works cross-platform without a shell.
 *
 * Returns the fragment to spread into the SDK's query options:
 *   - `pathToClaudeCodeExecutable` — absolute path to the CLI entrypoint
 *   - `executable` — set to `process.execPath` whenever the entrypoint is a
 *     JS file, so the SDK does not rely on a PATH `node` lookup
 *
 * Exported for unit testing.
 */
export function resolveClaudeExecutable(
  cliPath: string | undefined,
): { pathToClaudeCodeExecutable?: string; executable?: string } {
  if (!cliPath) return {};

  if (process.platform !== 'win32') {
    return { pathToClaudeCodeExecutable: cliPath };
  }

  const lower = cliPath.toLowerCase();

  // Native Windows binaries spawn fine without shell — hand to the SDK as-is.
  if (lower.endsWith('.exe') || lower.endsWith('.com')) {
    return { pathToClaudeCodeExecutable: cliPath };
  }

  // JS entrypoints: SDK will wrap them with `executable` (default: "node"),
  // but we pin to the current node so we don't rely on PATH resolution.
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return {
      pathToClaudeCodeExecutable: cliPath,
      executable: process.execPath,
    };
  }

  // npm/pnpm cmd shim: unwrap to the underlying cli.js so we can bypass cmd.exe
  // entirely (and the CVE-2024-27980 spawn-hardening that blocks it).
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const resolvedJs = parseWindowsCliShim(cliPath);
    if (resolvedJs) {
      return {
        pathToClaudeCodeExecutable: resolvedJs,
        executable: process.execPath,
      };
    }
    // Parse failure: keep today's behaviour as a no-worse fallback so the
    // EINVAL error still surfaces with a clear command path attached.
    return { pathToClaudeCodeExecutable: cliPath };
  }

  // Unknown extension (.ps1, no extension, etc.) — pass through.
  return { pathToClaudeCodeExecutable: cliPath };
}


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
 * Convert an SDKMessage into LobbyMessage[].
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sdkMessageToLobby(sessionId: string, msg: any): LobbyMessage[] {
  const messages: LobbyMessage[] = [];

  switch (msg.type) {
    case 'system': {
      // Compact boundary — emitted when compaction completes
      if (msg.subtype === 'compact_boundary') {
        const metadata = msg.compact_metadata as { trigger: string; pre_tokens: number } | undefined;
        messages.push(
          makeLobbyMessage(sessionId, 'system', {
            compact: true,
            trigger: metadata?.trigger ?? 'manual',
            preTokens: metadata?.pre_tokens ?? 0,
          }),
        );
        return messages;
      }

      // Compacting status — emitted while compact is running
      if (msg.subtype === 'status' && msg.status === 'compacting') {
        messages.push(
          makeLobbyMessage(sessionId, 'system', {
            compacting: true,
          }),
        );
        return messages;
      }

      // Skip other system init messages — they're internal metadata
      break;
    }

    case 'assistant': {
      const content = msg.message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text') {
          messages.push(
            makeLobbyMessage(sessionId, 'assistant', block.text ?? '', {
              model: msg.message?.model,
              tokenUsage: msg.message?.usage
                ? {
                    input: msg.message.usage.input_tokens ?? 0,
                    output: msg.message.usage.output_tokens ?? 0,
                  }
                : undefined,
            }),
          );
        } else if (block.type === 'tool_use') {
          messages.push(
            makeLobbyMessage(
              sessionId,
              'tool_use',
              JSON.stringify(block.input ?? {}, null, 2),
              { toolName: block.name },
            ),
          );
        } else if (block.type === 'tool_result') {
          messages.push(
            makeLobbyMessage(sessionId, 'tool_result', {
              toolUseId: block.id,
              content: block.text,
            }),
          );
        }
      }
      break;
    }

    case 'result': {
      messages.push(
        makeLobbyMessage(
          sessionId,
          'result',
          {
            subtype: msg.subtype,
            durationMs: msg.duration_ms,
            result: msg.result,
            isError: msg.is_error,
          },
          { costUsd: msg.total_cost_usd },
        ),
      );
      break;
    }

    case 'stream_event': {
      // Extract text deltas from Anthropic API stream events
      const event = msg.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text ?? '';
        if (text) {
          messages.push(makeLobbyMessage(sessionId, 'stream_delta', text));
        }
      }
      break;
    }

    default:
      break;
  }
  return messages;
}

/** Read-only tools allowed in readonly mode */
const READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'Agent', 'WebSearch', 'WebFetch'];

/** Fallback commands shown before any session loads the real list from SDK */
const FALLBACK_COMMANDS: AdapterCommand[] = [
  { name: '/compact', description: 'Compact conversation to save context', args: '[instructions]' },
  { name: '/cost', description: 'Show token usage and cost for this session' },
  { name: '/model', description: 'Switch the AI model', args: '<model-name>' },
  { name: '/permissions', description: 'View or update permission rules' },
  { name: '/memory', description: 'Edit CLAUDE.md memory files' },
  { name: '/config', description: 'View or modify settings' },
  { name: '/status', description: 'Show account and session status' },
  { name: '/doctor', description: 'Check health of Claude Code' },
  { name: '/review', description: 'Review code changes' },
  { name: '/plan', description: 'Toggle plan mode (read-only exploration)' },
  { name: '/vim', description: 'Toggle vim keybinding mode' },
  { name: '/fast', description: 'Toggle fast mode (same model, faster output)' },
  { name: '/hooks', description: 'Manage event hooks' },
  { name: '/mcp', description: 'Manage MCP servers' },
  { name: '/add-dir', description: 'Add directory to tool access', args: '<path>' },
  { name: '/init', description: 'Initialize CLAUDE.md in project' },
  { name: '/terminal-setup', description: 'Install shell integration (Shift+Enter)' },
  { name: '/help', description: 'Show Claude Code help' },
];

const PLAN_MODE_SYSTEM_PROMPT = `
You are in PLAN MODE. Only explore the codebase and produce a detailed implementation plan.
Do NOT modify any files. Use only read-only tools (Read, Glob, Grep).
Structure your output as: Context → Approach → File changes → Verification steps.

When you need user input or want to present choices, use this exact format:

<!-- CHOICE -->
{"question":"Your question here","options":[{"label":"Option A","description":"Description A"},{"label":"Option B","description":"Description B"}]}
<!-- /CHOICE -->

When your plan is finalized and ready for execution, always end with:

<!-- CHOICE -->
{"question":"Plan is ready. How to proceed?","options":[{"label":"Execute Plan","description":"Exit plan mode and start implementation"},{"label":"Continue Refining","description":"Ask more questions or adjust the plan"}]}
<!-- /CHOICE -->
`;

class ClaudeCodeProcess extends EventEmitter implements AgentProcess {
  sessionId: string;
  readonly adapter = 'claude-code';
  status: AgentProcess['status'] = 'idle';

  private spawnOptions: ClaudeCodeSpawnOptions;
  /** The real session ID assigned by Claude Code (set after first query) */
  private realSessionId: string | null = null;
  private pendingControls = new Map<
    string,
    {
      toolInput: Record<string, unknown>;
      resolve: (result: {
        behavior: string;
        updatedInput?: Record<string, unknown>;
        message?: string;
        interrupt?: boolean;
      }) => void;
    }
  >();
  /** Pre-responded decisions: user responded before canUseTool was called */
  private preRespondedControls = new Map<string, { decision: ControlDecision; payload?: Record<string, unknown> }>();
  private abortController = new AbortController();
  /** Accumulated stderr output from the CLI subprocess for error diagnostics */
  private stderrChunks: string[] = [];
  /** Number of consecutive exit-code-1 failures (for retry logic) */
  private consecutiveStartupFailures = 0;
  /** Maximum retries for transient CLI startup failures */
  private static readonly MAX_STARTUP_RETRIES = 1;
  /** Delay (ms) before retry to allow transient conditions to clear */
  private static readonly RETRY_DELAY_MS = 2000;

  constructor(sessionId: string, options: ClaudeCodeSpawnOptions, private claudeCliPath?: string) {
    super();
    this.sessionId = sessionId;
    // Expand leading ~ to home directory (Node.js does not expand shell tildes)
    const cwd = options.cwd;
    if (cwd === '~') {
      options = { ...options, cwd: homedir() };
    } else if (cwd.startsWith('~/')) {
      options = { ...options, cwd: homedir() + cwd.slice(1) };
    }
    this.spawnOptions = options;
    // NOTE: Do NOT start query here. The caller must wire events first,
    // then call sendMessage() to avoid a race condition where messages
    // are emitted before listeners are attached.
  }

  private async runQuery(prompt: string, resumeId?: string): Promise<void> {
    this.status = 'running';

    try {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');

      // Build env for subprocess: merge settings.json env + process.env + apiKey
      const subprocessEnv: Record<string, string | undefined> = { ...process.env };

      // Load env from ~/.claude/settings.json if it exists
      const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
      const settingsPath = `${home}/.claude/settings.json`;
      try {
        const { readFileSync } = await import('node:fs');
        const settingsContent = readFileSync(settingsPath, 'utf-8');
        const settings = JSON.parse(settingsContent);
        if (settings.env && typeof settings.env === 'object') {
          Object.assign(subprocessEnv, settings.env);
        }
      } catch {
        // settings.json doesn't exist or can't be read — not an error
      }

      // If apiKey provided, inject it (overrides settings)
      if (this.spawnOptions.apiKey) {
        subprocessEnv.ANTHROPIC_API_KEY = this.spawnOptions.apiKey;
      }

      // Enable SDK debug mode to capture detailed diagnostics via stderr.
      // When the CLI exits with code 1 before producing any output, this
      // flag causes --debug-to-stderr to be passed, giving us the CLI's
      // internal logs for root-cause analysis (e.g. auth failures).
      subprocessEnv.DEBUG_CLAUDE_AGENT_SDK = '1';

      // Claude Code 2.1+ refuses --dangerously-skip-permissions when running as
      // root unless IS_SANDBOX=1 (or CLAUDE_CODE_BUBBLEWRAP) is set. OpenLobby
      // is commonly deployed in containers/VPS as root, and 'auto' permission
      // mode maps to bypassPermissions, so without this opt-in every auto-mode
      // session (including LobbyManager) instantly exits with code 1.
      if (subprocessEnv.IS_SANDBOX === undefined) {
        subprocessEnv.IS_SANDBOX = '1';
      }

      // Reset stderr buffer for this query
      this.stderrChunks = [];

      // Resolve the CLI path for the current platform before handing it to
      // the SDK. On Windows this unwraps `.cmd` shims to the underlying
      // `cli.js` (avoiding Node's CVE-2024-27980 spawn hardening that blocks
      // `.cmd` files without shell:true — which we cannot enable because it
      // corrupts the --mcp-config JSON argument).
      const executableResolution = resolveClaudeExecutable(this.claudeCliPath);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const queryOpts: any = {
        // Point SDK to the real Claude CLI binary (avoids bundled-path mismatch).
        // May include `executable: process.execPath` when resolution picked a
        // JS entrypoint, so the SDK spawns the current Node instead of PATH `node`.
        ...executableResolution,
        // Custom spawn to capture stderr and handle native binaries.
        // IMPORTANT: shell must be false — shell:true corrupts JSON arguments
        // (e.g. --mcp-config) by interpreting {}, ", : as shell metacharacters,
        // causing "Invalid MCP configuration" and exit code 1.
        spawnClaudeCodeProcess: (opts: { command: string; args: string[]; cwd: string; env: Record<string, string>; signal: AbortSignal }) => {
          // === Diagnostic: log every spawn attempt ===
          const diagInfo = {
            command: opts.command,
            argsCount: opts.args.length,
            args: opts.args.map((a, i) => `  [${i}] ${a.length > 200 ? a.slice(0, 200) + '...' : a}`).join('\n'),
            cwd: opts.cwd,
            hasApiKey: !!opts.env.ANTHROPIC_API_KEY,
            hasAuthToken: !!opts.env.ANTHROPIC_AUTH_TOKEN,
          };
          console.log('[ClaudeCode] === SPAWN DIAGNOSTICS ===');
          console.log('[ClaudeCode] command:', diagInfo.command);
          console.log('[ClaudeCode] cwd:', diagInfo.cwd);
          console.log('[ClaudeCode] args:\n' + diagInfo.args);
          console.log('[ClaudeCode] env: API_KEY=%s AUTH_TOKEN=%s', diagInfo.hasApiKey, diagInfo.hasAuthToken);
          this.stderrChunks.push(`[SPAWN] cmd=${diagInfo.command} cwd=${diagInfo.cwd} args=${diagInfo.argsCount}\n`);

          const child = cpSpawn(opts.command, opts.args, {
            cwd: opts.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: opts.env,
            signal: opts.signal,
          });

          // Capture spawn-level errors (e.g. ENOENT if binary not found)
          child.on('error', (spawnErr: Error) => {
            const errMsg = `[SPAWN ERROR] ${spawnErr.message} (code=${(spawnErr as NodeJS.ErrnoException).code})`;
            console.error('[ClaudeCode]', errMsg);
            this.stderrChunks.push(errMsg + '\n');
          });

          // Capture stderr from the CLI subprocess for error diagnostics
          child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8');
            console.error('[ClaudeCode stderr]', text);
            this.stderrChunks.push(text);
          });

          // Log exit code
          child.on('exit', (code: number | null, signal: string | null) => {
            const exitMsg = `[EXIT] code=${code} signal=${signal}`;
            console.log('[ClaudeCode]', exitMsg);
            this.stderrChunks.push(exitMsg + '\n');
          });

          return child;
        },
        // SDK stderr callback — captures internal SDK-level diagnostics
        stderr: (msg: string) => {
          console.error('[ClaudeCode SDK stderr]', msg);
          this.stderrChunks.push(msg);
        },
        // Pass sanitized env to the spawned CLI process
        env: subprocessEnv,
        // Load user/project/local settings so MCP servers, skills, hooks, etc. are available
        // (without this, SDK runs in isolation mode and ignores all configured tools)
        settingSources: ['user', 'project', 'local'],
        // Only auto-allow read-only tools; Write/Edit/Bash require approval via canUseTool
        allowedTools: this.spawnOptions.allowedTools ?? [
          'Read', 'Glob', 'Grep',
        ],
        cwd: this.spawnOptions.cwd,
        abortController: this.abortController,
        // Map unified PermissionMode to Claude SDK native value
        permissionMode: (() => {
          switch (this.spawnOptions.permissionMode) {
            case 'auto': return 'bypassPermissions';
            case 'readonly': return 'plan';
            case 'supervised': return 'default';
            default: return 'default';
          }
        })(),
        canUseTool: async (
          toolName: string,
          toolInput: Record<string, unknown>,
          options: { toolUseID: string; signal: AbortSignal },
        ) => {
          return this.handleToolApproval(toolName, toolInput, options.toolUseID);
        },
      };
      if (this.spawnOptions.model) {
        queryOpts.model = this.spawnOptions.model;
      }
      // Use Claude Code default system prompt + append custom instructions (preserves skills/tools)
      // For custom system prompts (e.g. LobbyManager), use string directly
      if (this.spawnOptions.systemPrompt) {
        queryOpts.systemPrompt = this.spawnOptions.systemPrompt;
      }
      if (this.spawnOptions.permissionMode === 'readonly') {
        queryOpts.systemPrompt = (queryOpts.systemPrompt ?? '') + PLAN_MODE_SYSTEM_PROMPT;
      }
      if (this.spawnOptions.mcpServers) {
        queryOpts.mcpServers = this.spawnOptions.mcpServers;
      }
      if (resumeId) {
        queryOpts.resume = resumeId;
      } else {
        // Explicitly prevent auto-continuing the most recent session in the CWD.
        // Without this, SDK may implicitly continue the previous conversation.
        queryOpts.continue = false;
      }

      console.log('[ClaudeCode] Starting query:', {
        cwd: this.spawnOptions.cwd,
        prompt: prompt.slice(0, 100),
        resume: resumeId ?? null,
        mcpServers: this.spawnOptions.mcpServers ? Object.keys(this.spawnOptions.mcpServers) : [],
        allowedTools: queryOpts.allowedTools,
        permissionMode: queryOpts.permissionMode,
        hasApiKey: !!this.spawnOptions.apiKey,
        hasEnvApiKey: !!subprocessEnv.ANTHROPIC_API_KEY,
        hasEnvAuthToken: !!subprocessEnv.ANTHROPIC_AUTH_TOKEN,
      });

      const stream = sdk.query({ prompt, options: queryOpts });

      // Fetch available commands from the SDK and emit for session-level caching
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const query = stream as any;
      if (typeof query.supportedCommands === 'function') {
        query.supportedCommands().then((cmds: Array<{ name: string; description: string; argumentHint?: string }>) => {
          const commands: AdapterCommand[] = cmds.map((c) => ({
            name: c.name.startsWith('/') ? c.name : `/${c.name}`,
            description: c.description,
            ...(c.argumentHint ? { args: c.argumentHint } : {}),
          }));
          console.log(`[ClaudeCode] SDK supportedCommands: ${commands.length} commands for session ${this.sessionId}`);
          this.emit('commands', commands);
        }).catch((err: Error) => {
          console.warn('[ClaudeCode] supportedCommands failed:', err.message);
        });
      }

      for await (const msg of stream) {
        if (this.abortController.signal.aborted) break;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sdkMsg = msg as any;

        // Extract real session ID from system init message
        if (sdkMsg.type === 'system' && sdkMsg.session_id) {
          this.realSessionId = sdkMsg.session_id as string;
          this.sessionId = this.realSessionId;
          console.log('[ClaudeCode] Real session ID:', this.realSessionId);
        }

        const lobbyMessages = sdkMessageToLobby(this.sessionId, sdkMsg);
        for (const lobbyMsg of lobbyMessages) {
          this.emit('message', lobbyMsg);
        }
      }

      this.consecutiveStartupFailures = 0; // Reset on success
      this.status = 'idle';
      console.log('[ClaudeCode] Query completed');
      this.emit('idle');
    } catch (err) {
      // AbortError is expected when the user (or session rebuild) kills the
      // process.  Treat it as a graceful stop, not a real error.  This avoids
      // crashing the server when `removeAllListeners()` has already stripped
      // the 'error' listener before the async abort propagates here.
      const isAbort =
        (err instanceof Error && err.name === 'AbortError') ||
        this.abortController.signal.aborted;

      if (isAbort) {
        console.log('[ClaudeCode] Query aborted (user or rebuild)');
        this.status = 'stopped';
        this.emit('idle');
        return;
      }

      const stderrOutput = this.stderrChunks.join('').trim();
      console.error('[ClaudeCode] === QUERY FAILED ===');
      console.error('[ClaudeCode] error:', err);
      if (stderrOutput) console.error('[ClaudeCode] stderr:\n' + stderrOutput);

      const baseError = err instanceof Error ? err.message : String(err);
      const isStartupFailure = baseError.includes('process exited with code 1');

      // Auto-retry transient startup failures (e.g. OAuth token refresh race).
      // Only retry for exit-code-1 with no meaningful stderr (indicates the CLI
      // failed before initializing, not a permanent configuration error).
      if (isStartupFailure && !resumeId && this.consecutiveStartupFailures < ClaudeCodeProcess.MAX_STARTUP_RETRIES) {
        this.consecutiveStartupFailures++;
        console.warn(`[ClaudeCode] Startup failure #${this.consecutiveStartupFailures}, retrying in ${ClaudeCodeProcess.RETRY_DELAY_MS}ms...`);
        this.status = 'running'; // keep status as running during retry
        const retryMsg = makeLobbyMessage(
          this.sessionId,
          'system',
          { info: `CLI startup failed (exit code 1), retrying... (attempt ${this.consecutiveStartupFailures + 1})` },
        );
        this.emit('message', retryMsg);
        await new Promise(resolve => setTimeout(resolve, ClaudeCodeProcess.RETRY_DELAY_MS));
        if (!this.abortController.signal.aborted) {
          return this.runQuery(prompt, resumeId);
        }
      }

      this.status = 'error';

      // Include stderr + diagnostics in error message for frontend visibility
      const fullError = stderrOutput
        ? `${baseError}\n--- CLI stderr ---\n${stderrOutput.slice(0, 2000)}`
        : baseError;

      // Write diagnostic log to file for persistent analysis
      try {
        const { appendFileSync, mkdirSync: mkdirSyncFs } = await import('node:fs');
        const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
        const logDir = `${homeDir}/.openlobby`;
        mkdirSyncFs(logDir, { recursive: true });
        const logPath = `${logDir}/claude-code-errors.log`;
        const logEntry = [
          `\n=== ${new Date().toISOString()} session=${this.sessionId} ===`,
          `error: ${baseError}`,
          `cliPath: ${this.claudeCliPath ?? '(sdk-default)'}`,
          `cwd: ${this.spawnOptions.cwd}`,
          `resume: ${resumeId ?? 'none'}`,
          `permissionMode: ${this.spawnOptions.permissionMode}`,
          `mcpServers: ${this.spawnOptions.mcpServers ? Object.keys(this.spawnOptions.mcpServers).join(',') : 'none'}`,
          stderrOutput ? `stderr:\n${stderrOutput}` : 'stderr: (empty)',
          '=== END ===\n',
        ].join('\n');
        appendFileSync(logPath, logEntry);
        console.log(`[ClaudeCode] Diagnostic log written to: ${logPath}`);
      } catch {
        // logging failure is not critical
      }

      const errorMsg = makeLobbyMessage(
        this.sessionId,
        'system',
        { error: fullError },
        { isError: true },
      );
      this.emit('message', errorMsg);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private handleToolApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolUseID: string,
  ): Promise<{
    behavior: string;
    updatedInput?: Record<string, unknown>;
    message?: string;
    interrupt?: boolean;
    toolUseID?: string;
  }> {
    const mode = this.spawnOptions.permissionMode ?? 'supervised';

    // Auto mode: approve everything immediately
    if (mode === 'auto') {
      console.log('[ClaudeCode] Auto mode: approved tool', toolName);
      return Promise.resolve({ behavior: 'allow', updatedInput: toolInput, toolUseID });
    }

    // Readonly mode: deny non-read-only tools
    if (mode === 'readonly' && !READONLY_TOOLS.includes(toolName)) {
      console.log('[ClaudeCode] Readonly mode: denied tool', toolName);
      return Promise.resolve({
        behavior: 'deny',
        message: 'Readonly mode: only read-only tools are allowed',
        toolUseID,
      });
    }

    // Supervised mode: emit control message and wait for user approval
    const requestId = randomUUID();
    console.log('[ClaudeCode] Tool approval requested:', toolName, 'toolUseID:', toolUseID);

    const questions = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions)
      ? (toolInput.questions as Array<{
          question: string;
          header: string;
          options: Array<{ label: string; description: string }>;
          multiSelect: boolean;
        }>)
      : undefined;

    const controlMsg = makeLobbyMessage(this.sessionId, 'control', {
      requestId,
      toolName,
      toolInput,
      toolUseID,
      questions,
    });
    this.emit('message', controlMsg);

    const preResponded = this.preRespondedControls.get(requestId);
    if (preResponded) {
      this.preRespondedControls.delete(requestId);
      console.log('[ClaudeCode] Using pre-responded decision for:', requestId, preResponded.decision);
      if (preResponded.decision === 'allow') {
        const updatedInput = preResponded.payload?.answers
          ? { ...toolInput, answers: preResponded.payload.answers }
          : toolInput;
        return Promise.resolve({ behavior: 'allow' as const, updatedInput, toolUseID });
      } else {
        return Promise.resolve({ behavior: 'deny' as const, message: 'User denied the tool', interrupt: true, toolUseID });
      }
    }

    return new Promise((resolve) => {
      this.pendingControls.set(requestId, {
        toolInput,
        resolve: (result) => resolve({ ...result, toolUseID }),
      });

      setTimeout(() => {
        if (this.pendingControls.has(requestId)) {
          console.warn('[ClaudeCode] Approval timed out for:', requestId);
          this.pendingControls.delete(requestId);
          resolve({ behavior: 'deny', message: 'Approval timed out', interrupt: true, toolUseID });
        }
      }, 5 * 60 * 1000);
    });
  }

  sendMessage(content: string): void {
    console.log('[ClaudeCode] sendMessage:', content.slice(0, 100));
    this.abortController = new AbortController();

    // Safety: catch unhandled rejections from the fire-and-forget promise.
    // runQuery already handles errors internally, but if an exception escapes
    // (e.g., listeners removed before async abort propagates) we must not let
    // it become an unhandled rejection that crashes the process.
    const safeRun = (p: Promise<void>) => {
      p.catch((err) => {
        console.error('[ClaudeCode] Unhandled rejection in runQuery:', err);
      });
    };

    if (this.realSessionId) {
      // We have a real session — resume it
      console.log('[ClaudeCode] Resuming session:', this.realSessionId);
      safeRun(this.runQueryWithResumeFallback(content, this.realSessionId));
    } else {
      // First message — start a fresh query (no resume)
      console.log('[ClaudeCode] Starting fresh query');
      safeRun(this.runQuery(content));
    }
  }

  /**
   * Try to resume a session; if resume fails (e.g., stale session ID → exit code 1),
   * automatically fall back to a fresh query so the user isn't stuck.
   */
  private async runQueryWithResumeFallback(prompt: string, resumeId: string): Promise<void> {
    const prevStatus = this.status;
    await this.runQuery(prompt, resumeId);

    // If runQuery set status to 'error', the resume likely failed.
    // Fall back to a fresh query (no resume) to recover automatically.
    if (this.status === 'error') {
      console.warn(`[ClaudeCode] Resume failed for ${resumeId}, falling back to fresh query`);
      this.realSessionId = null;
      this.status = prevStatus;
      this.abortController = new AbortController();

      // Notify user that we're retrying
      const retryMsg = makeLobbyMessage(
        this.sessionId,
        'system',
        { info: 'Resume failed, starting fresh session...' },
      );
      this.emit('message', retryMsg);

      await this.runQuery(prompt);
    }
  }

  respondControl(requestId: string, decision: ControlDecision, payload?: Record<string, unknown>): void {
    const pending = this.pendingControls.get(requestId);
    if (!pending) {
      // User responded before canUseTool was called (e.g., clicked Allow on a
      // pre-rendered card). Cache the decision for when canUseTool arrives.
      console.log('[ClaudeCode] Pre-responding control:', requestId, decision);
      this.preRespondedControls.set(requestId, { decision, payload });
      // Auto-cleanup after 5 minutes
      setTimeout(() => this.preRespondedControls.delete(requestId), 5 * 60 * 1000);
      return;
    }

    console.log('[ClaudeCode] Control response:', requestId, decision, payload ? 'with payload' : '');
    this.pendingControls.delete(requestId);

    if (decision === 'allow') {
      // If payload contains answers (from AskUserQuestion), inject into updatedInput
      const updatedInput = payload?.answers
        ? { ...pending.toolInput, answers: payload.answers }
        : pending.toolInput;
      pending.resolve({ behavior: 'allow', updatedInput });
    } else {
      pending.resolve({ behavior: 'deny', message: 'User denied the tool', interrupt: true });
    }
  }

  updateOptions(opts: Partial<SpawnOptions>): void {
    Object.assign(this.spawnOptions, opts);
    console.log('[ClaudeCode] Options updated:', Object.keys(opts));
  }

  /** Mark this process as a resume of an existing Claude Code session */
  setResumeId(sessionId: string): void {
    this.realSessionId = sessionId;
  }

  interrupt(): void {
    if (this.status !== 'running' && this.status !== 'awaiting_approval') return;
    console.log('[ClaudeCode] Interrupting current generation');
    this.abortController.abort();
    this.pendingControls.clear();
    this.preRespondedControls.clear();
    this.status = 'idle';
    this.emit('idle');
  }

  kill(): void {
    console.log('[ClaudeCode] Killing process');
    // Abort first to close the transport, then clear pending controls.
    // Do NOT resolve pending canUseTool promises — resolving them causes
    // SDK to call ProcessTransport.write() on an already-closed transport,
    // throwing "ProcessTransport is not ready for writing".
    // Unresolved promises will be GC'd when the process exits.
    this.abortController.abort();
    this.pendingControls.clear();
    this.preRespondedControls.clear();
    this.status = 'stopped';
    this.emit('exit', 0);
  }
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly name = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly permissionMeta: AdapterPermissionMeta = {
    modeLabels: {
      auto: 'bypassPermissions',
      supervised: 'default',
      readonly: 'plan',
    },
  };
  private detectedCliPath: string | undefined;

  async detect(): Promise<{
    installed: boolean;
    version?: string;
    path?: string;
  }> {
    const detected = detectInstalledBinary('claude');
    if (!detected) return { installed: false };
    this.detectedCliPath = detected.path;
    return { installed: true, version: detected.version, path: detected.path };
  }


  /**
   * Ensure the cached CLI path still exists; if not, re-detect.
   * Returns the validated path or undefined (SDK will fall back to its bundled cli.js).
   */
  private ensureCliPath(): string | undefined {
    if (this.detectedCliPath && existsSync(this.detectedCliPath)) {
      return this.detectedCliPath;
    }
    // Cached path is stale — try to re-detect
    const cliPath = findExecutable('claude');
    if (cliPath && existsSync(cliPath)) {
      console.log(`[ClaudeCodeAdapter] Re-detected claude at: ${cliPath}`);
      this.detectedCliPath = cliPath;
      return cliPath;
    }
    console.warn('[ClaudeCodeAdapter] Claude CLI not found, falling back to SDK bundled executable');
    this.detectedCliPath = undefined;
    return undefined;
  }

  async spawn(options: SpawnOptions): Promise<AgentProcess> {
    const sessionId = randomUUID();
    const cliPath = this.ensureCliPath();
    console.log('[ClaudeCodeAdapter] Spawning session:', sessionId, 'cli:', cliPath ?? '(sdk-default)');
    return new ClaudeCodeProcess(sessionId, options as ClaudeCodeSpawnOptions, cliPath);
  }

  async resume(
    sessionId: string,
    options?: ResumeOptions,
  ): Promise<AgentProcess> {
    const cliPath = this.ensureCliPath();
    const proc = new ClaudeCodeProcess(sessionId, {
      cwd: options?.cwd ?? process.cwd(),
      systemPrompt: options?.systemPrompt,
      permissionMode: options?.permissionMode,
      allowedTools: (options as ClaudeCodeSpawnOptions | undefined)?.allowedTools,
      mcpServers: options?.mcpServers,
      model: options?.model,
    }, cliPath);
    // Mark as resume so sendMessage() uses SDK resume instead of fresh query
    proc.setResumeId(sessionId);
    // NOTE: Do NOT send prompt here. The caller must wire events first,
    // then call sendMessage() to avoid race condition.
    return proc;
  }

  getSessionStoragePath(): string {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '~';
    return join(home, '.claude', 'projects');
  }

  async readSessionHistory(sessionId: string): Promise<LobbyMessage[]> {
    const storagePath = this.getSessionStoragePath();
    // Search all project dirs for the session JSONL
    const jsonlPath = this.findSessionJsonl(storagePath, sessionId);
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

  /** Find the JSONL file for a session ID across all project dirs */
  private findSessionJsonl(storagePath: string, sessionId: string): string | null {
    // Direct path: <storagePath>/<project-dir>/<sessionId>.jsonl
    try {
      const projectDirs = readdirSync(storagePath);
      for (const dir of projectDirs) {
        const candidate = join(storagePath, dir, `${sessionId}.jsonl`);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // storage path doesn't exist
    }
    return null;
  }

  /** Convert a Claude Code JSONL line to LobbyMessage[] */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private jsonlLineToLobbyMessages(sessionId: string, obj: any): LobbyMessage[] {
    const type = obj.type as string;
    const timestamp = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
    const uuid = (obj.uuid ?? obj.messageId ?? randomUUID()) as string;

    if (type === 'user' && obj.message?.content) {
      if (obj.isMeta) return [];
      let content: string;
      if (typeof obj.message.content === 'string') {
        content = obj.message.content;
      } else if (Array.isArray(obj.message.content)) {
        // Extract text from content block array
        const parts: string[] = [];
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            parts.push(block.text);
          } else if (block.type === 'tool_result') {
            // Skip tool_result blocks in user messages (they are system context)
          }
        }
        content = parts.join('\n') || '';
      } else {
        content = '';
      }
      if (!content) return [];
      if (content.startsWith('<command-name>') || content.startsWith('<local-command')) return [];
      return [{ id: uuid, sessionId, timestamp, type: 'user' as const, content }];
    }

    if (type === 'assistant' && obj.message?.content) {
      const contentBlocks = obj.message.content;
      if (typeof contentBlocks === 'string') {
        return [{ id: uuid, sessionId, timestamp, type: 'assistant' as const, content: contentBlocks }];
      }
      if (Array.isArray(contentBlocks)) {
        const results: LobbyMessage[] = [];
        for (const block of contentBlocks) {
          if (block.type === 'text' && block.text) {
            results.push({
              id: `${uuid}-text-${results.length}`,
              sessionId,
              timestamp,
              type: 'assistant',
              content: block.text,
            });
          } else if (block.type === 'tool_use') {
            results.push({
              id: `${uuid}-tool-${block.id ?? results.length}`,
              sessionId,
              timestamp,
              type: 'tool_use',
              content: JSON.stringify(block.input ?? {}, null, 2),
              meta: { toolName: block.name },
            });
          } else if (block.type === 'tool_result') {
            const resultContent = Array.isArray(block.content)
              ? block.content.map((c: { text?: string }) => c.text ?? '').join('\n')
              : typeof block.content === 'string' ? block.content : '';
            results.push({
              id: `${uuid}-result-${block.tool_use_id ?? results.length}`,
              sessionId,
              timestamp,
              type: 'tool_result',
              content: resultContent,
              meta: { isError: block.is_error ?? false },
            });
          }
        }
        return results;
      }
    }

    if (type === 'result') {
      return [{
        id: uuid,
        sessionId,
        timestamp,
        type: 'result' as const,
        content: obj.subtype === 'success' ? 'Completed' : (obj.error ?? 'Failed'),
        meta: {
          costUsd: obj.cost_usd,
          tokenUsage: obj.usage
            ? { input: obj.usage.input_tokens, output: obj.usage.output_tokens }
            : undefined,
        },
      }];
    }

    return [];
  }

  async discoverSessions(filterCwd?: string): Promise<SessionSummary[]> {
    const storagePath = this.getSessionStoragePath();
    if (!existsSync(storagePath)) return [];

    const results: SessionSummary[] = [];
    let projectDirs: string[];
    try {
      projectDirs = readdirSync(storagePath);
    } catch {
      return [];
    }

    for (const dirName of projectDirs) {
      const dirPath = join(storagePath, dirName);
      // decodeProjectDir is lossy (can't distinguish path-separator hyphens from literal ones),
      // so we only use it as a fallback. The authoritative cwd comes from JSONL metadata.
      const decodedCwdHint = this.decodeProjectDir(dirName);

      let files: string[];
      try {
        files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }

      for (const file of files) {
        const sessionId = basename(file, '.jsonl');
        // Skip internal/non-user sessions:
        // - "rollout-" sessions are Claude's internal framework sessions
        // - "agent-" sessions are subagent/sidechain sessions spawned by the main session
        if (sessionId.startsWith('rollout-') || sessionId.startsWith('agent-')) continue;

        const filePath = join(dirPath, file);

        try {
          const stat = statSync(filePath);
          const meta = await this.extractSessionMeta(filePath, sessionId);

          // Skip sessions with no meaningful content
          if (meta.messageCount === 0 && !meta.lastMessage) continue;

          // Prefer cwd from JSONL (accurate) over decodeProjectDir (lossy encoding)
          const sessionCwd = meta.cwd || decodedCwdHint;
          if (filterCwd && sessionCwd !== filterCwd) continue;

          results.push({
            id: sessionId,
            adapterName: this.name,
            displayName: meta.displayName || sessionId.slice(0, 8),
            status: 'stopped',
            lastActiveAt: stat.mtimeMs,
            lastMessage: meta.lastMessage,
            messageCount: meta.messageCount,
            model: meta.model,
            cwd: sessionCwd,
            origin: 'cli',
            resumeCommand: this.getResumeCommand(sessionId),
            jsonlPath: filePath,
          });
        } catch {
          // skip unreadable files
        }
      }
    }

    // Sort by lastActiveAt descending (most recent first)
    results.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return results;
  }

  /**
   * Decode Claude Code project directory name back to filesystem path.
   * Convention: "/" is replaced with "-", leading "-" represents root "/"
   * e.g. "-Users-kone-project" → "/Users/kone/project"
   */
  private decodeProjectDir(dirName: string): string {
    // The directory name starts with "-" representing the root "/"
    // Each "-" after that represents a "/"
    return dirName.replace(/-/g, '/');
  }

  /**
   * Read the first ~30 lines of a JSONL file to extract session metadata.
   */
  private async extractSessionMeta(
    filePath: string,
    sessionId: string,
  ): Promise<{
    displayName?: string;
    model?: string;
    lastMessage?: string;
    messageCount: number;
    cwd?: string;
  }> {
    let model: string | undefined;
    let lastMessage: string | undefined;
    let cwd: string | undefined;
    let messageCount = 0;
    let linesRead = 0;

    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
    });

    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        linesRead++;

        try {
          const obj = JSON.parse(line);

          // Extract cwd from the first message that has it
          if (!cwd && typeof obj.cwd === 'string' && obj.cwd) {
            // Expand ~ to home directory (JSONL may store paths with tilde)
            const raw = obj.cwd as string;
            cwd = raw === '~' ? homedir() : raw.startsWith('~/') ? homedir() + raw.slice(1) : raw;
          }

          if (obj.type === 'user' && !obj.isMeta && obj.message?.content) {
            messageCount++;
            const content = typeof obj.message.content === 'string'
              ? obj.message.content
              : Array.isArray(obj.message.content)
                ? obj.message.content
                    .filter((b: { type: string }) => b.type === 'text')
                    .map((b: { text?: string }) => b.text ?? '')
                    .join(' ')
                : '';
            if (content && !content.startsWith('<')) {
              lastMessage = content.slice(0, 100);
            }
          } else if (obj.type === 'assistant') {
            messageCount++;
            if (!model && obj.message?.model) {
              model = obj.message.model as string;
            }
          }
        } catch {
          // skip malformed lines
        }

        // Read enough lines to get useful metadata, but not the whole file
        if (linesRead >= 50) break;
      }
    } finally {
      rl.close();
    }

    return {
      displayName: lastMessage ? lastMessage.slice(0, 30) : sessionId.slice(0, 8),
      model,
      lastMessage,
      messageCount,
      cwd,
    };
  }

  getResumeCommand(sessionId: string): string {
    return `claude --resume ${sessionId}`;
  }

  async listCommands(): Promise<AdapterCommand[]> {
    // Per-session commands are fetched via SDK's query.supportedCommands() and cached in SQLite.
    // This fallback is used before any session has run.
    return FALLBACK_COMMANDS;
  }

  async resolveSessionCwd(sessionId: string): Promise<string | undefined> {
    const storagePath = this.getSessionStoragePath();
    if (!existsSync(storagePath)) return undefined;

    let projectDirs: string[];
    try {
      projectDirs = readdirSync(storagePath);
    } catch {
      return undefined;
    }

    for (const dirName of projectDirs) {
      const filePath = join(storagePath, dirName, `${sessionId}.jsonl`);
      if (!existsSync(filePath)) continue;

      try {
        const meta = await this.extractSessionMeta(filePath, sessionId);
        if (meta.cwd) return meta.cwd;
      } catch {
        // skip unreadable files
      }

      // Fallback to decoded project dir name
      return this.decodeProjectDir(dirName);
    }

    return undefined;
  }
}

/**
 * Shared Adapter Integration Test Suite
 *
 * Validates any OpenLobby adapter against a REAL CLI installation.
 * If the CLI is not installed, the suite throws — no skipping.
 *
 * Usage (per-adapter test file):
 *   import { createAdapterIntegrationTests } from './adapter-contract.js';
 *   import { ClaudeCodeAdapter } from '../claude-code.js';
 *   createAdapterIntegrationTests(() => new ClaudeCodeAdapter());
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import type {
  AgentAdapter,
  AgentProcess,
  LobbyMessage,
  AdapterCommand,
} from '../../types.js';

/**
 * Wait for a specific event on the process, with a timeout.
 * Resolves with the event payload or rejects on timeout.
 */
function waitForEvent<T>(
  proc: AgentProcess,
  event: string,
  timeoutMs: number,
  predicate?: (value: T) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.removeListener(event, handler);
      reject(new Error(`Timed out waiting for '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    function handler(value: T) {
      if (predicate && !predicate(value)) return; // keep listening
      clearTimeout(timer);
      proc.removeListener(event, handler);
      resolve(value);
    }

    proc.on(event, handler);
  });
}

/**
 * Collect all events of a given name until a condition or timeout.
 */
function collectEvents<T>(
  proc: AgentProcess,
  event: string,
  timeoutMs: number,
): { values: T[]; stop: () => void } {
  const values: T[] = [];
  const handler = (value: T) => values.push(value);
  proc.on(event, handler);

  const stop = () => proc.removeListener(event, handler);
  setTimeout(stop, timeoutMs);

  return { values, stop };
}

export interface AdapterContractOptions {
  /**
   * A simple prompt that causes the CLI to reply quickly with minimal tokens.
   * Default: 'Reply with exactly the word: HELLO_TEST'
   */
  simplePrompt?: string;
  /**
   * Working directory for spawn/resume. Defaults to process.cwd().
   */
  cwd?: string;
  /**
   * Additional SpawnOptions overrides (e.g. permissionMode for auto-approve).
   */
  spawnOverrides?: Record<string, unknown>;
}

/**
 * Creates the shared integration test suite for any AgentAdapter.
 *
 * @param factory - Returns a fresh adapter instance. Called once per suite.
 * @param options - Optional overrides for prompts, cwd, etc.
 */
export function createAdapterIntegrationTests(
  factory: () => AgentAdapter,
  options: AdapterContractOptions = {},
): void {
  const simplePrompt =
    options.simplePrompt ?? 'Reply with exactly the word: HELLO_TEST';
  const cwd = options.cwd ?? process.cwd();

  let adapter: AgentAdapter;
  /** Process spawned by the main flow (spawn + sendMessage + resume + kill) */
  let mainProcess: AgentProcess | undefined;
  /** Session ID captured after spawn, used for resume and other tests */
  let capturedSessionId: string | undefined;
  /** Process used for the commands event test */
  let commandsProcess: AgentProcess | undefined;

  describe(`Adapter contract: ${factory().name}`, () => {
    // ──────────────────────────────────────────────
    // Setup & teardown
    // ──────────────────────────────────────────────

    beforeAll(() => {
      adapter = factory();
    });

    afterAll(async () => {
      // Clean up any spawned processes
      for (const proc of [mainProcess, commandsProcess]) {
        if (proc && proc.status !== 'stopped') {
          try {
            proc.kill();
          } catch {
            // best-effort cleanup
          }
        }
      }
      // Give child processes a moment to exit
      await new Promise((r) => setTimeout(r, 1000));
    });

    // ──────────────────────────────────────────────
    // 1. detect()
    // ──────────────────────────────────────────────

    it('detect() returns installed: true with version and path', async () => {
      const result = await adapter.detect();

      if (!result.installed) {
        throw new Error(
          `${adapter.name} CLI is NOT installed. ` +
            'This test suite requires a real CLI installation — install it and retry.',
        );
      }

      expect(result.installed).toBe(true);
      expect(typeof result.version).toBe('string');
      expect(result.version!.length).toBeGreaterThan(0);
      expect(typeof result.path).toBe('string');
      expect(result.path!.length).toBeGreaterThan(0);
    });

    // ──────────────────────────────────────────────
    // 2. spawn() + sendMessage()
    // ──────────────────────────────────────────────

    it(
      'spawn() + sendMessage() creates process and receives assistant or stream_delta message',
      async () => {
        // Ensure detect() was called first (populates internal CLI path)
        await adapter.detect();

        mainProcess = await adapter.spawn({
          cwd,
          ...options.spawnOverrides,
        });

        expect(mainProcess).toBeDefined();
        expect(mainProcess.sessionId).toBeTruthy();
        expect(mainProcess.adapter).toBe(adapter.name);

        // Set up a promise to catch an assistant or stream_delta message
        const messagePromise = waitForEvent<LobbyMessage>(
          mainProcess,
          'message',
          90_000,
          (msg) => msg.type === 'assistant' || msg.type === 'stream_delta',
        );

        // Send the prompt — this triggers the first query
        mainProcess.sendMessage(simplePrompt);

        const msg = await messagePromise;
        expect(['assistant', 'stream_delta']).toContain(msg.type);
        expect(msg.sessionId).toBeTruthy();
      },
      120_000,
    );

    // ──────────────────────────────────────────────
    // 3. Session ID sync
    // ──────────────────────────────────────────────

    it(
      'session ID is updated to real CLI session ID',
      async () => {
        expect(mainProcess).toBeDefined();

        // Wait for the process to become idle (query complete)
        if (mainProcess!.status === 'running') {
          await waitForEvent(mainProcess!, 'idle', 90_000);
        }

        // After the first query, the session ID should have been replaced
        // by the real CLI session ID (different from the initial UUID for
        // adapters that reassign, or the thread ID for Codex)
        capturedSessionId = mainProcess!.sessionId;
        expect(capturedSessionId).toBeTruthy();
        expect(typeof capturedSessionId).toBe('string');
        expect(capturedSessionId!.length).toBeGreaterThan(0);
      },
      120_000,
    );

    // ──────────────────────────────────────────────
    // 4. resume()
    // ──────────────────────────────────────────────

    it(
      'resume() resumes an existing session and receives a response',
      async () => {
        expect(capturedSessionId).toBeTruthy();

        // Kill the main process first so we can resume cleanly
        mainProcess!.kill();
        // Give time for process to fully stop
        await new Promise((r) => setTimeout(r, 2000));
        expect(mainProcess!.status).toBe('stopped');

        // Resume the session
        const resumed = await adapter.resume(capturedSessionId!, {
          cwd,
          prompt: simplePrompt,
          ...options.spawnOverrides,
        });

        expect(resumed).toBeDefined();
        expect(resumed.adapter).toBe(adapter.name);

        // Listen for a response
        const messagePromise = waitForEvent<LobbyMessage>(
          resumed,
          'message',
          90_000,
          (msg) => msg.type === 'assistant' || msg.type === 'stream_delta',
        );

        // Send follow-up prompt on the resumed session
        resumed.sendMessage('Reply with exactly the word: RESUMED_TEST');

        const msg = await messagePromise;
        expect(['assistant', 'stream_delta']).toContain(msg.type);

        // Wait for idle before proceeding
        if (resumed.status === 'running') {
          await waitForEvent(resumed, 'idle', 90_000);
        }

        // Update mainProcess reference for kill test
        mainProcess = resumed;
      },
      120_000,
    );

    // ──────────────────────────────────────────────
    // 5. kill()
    // ──────────────────────────────────────────────

    it('kill() terminates the process and sets status to stopped', async () => {
      expect(mainProcess).toBeDefined();

      const exitPromise = waitForEvent(mainProcess!, 'exit', 10_000);
      mainProcess!.kill();
      await exitPromise;

      expect(mainProcess!.status).toBe('stopped');
    });

    // ──────────────────────────────────────────────
    // 6. readSessionHistory()
    // ──────────────────────────────────────────────

    it(
      'readSessionHistory() returns LobbyMessage[] from disk',
      async () => {
        expect(capturedSessionId).toBeTruthy();

        const history = await adapter.readSessionHistory(capturedSessionId!);

        // We just ran a session, so there should be at least some messages
        expect(Array.isArray(history)).toBe(true);
        // The session had at least one exchange, so expect messages
        // (some adapters may not persist stream_delta to disk, but assistant/user should be there)
        expect(history.length).toBeGreaterThan(0);

        // Every message should conform to LobbyMessage shape
        for (const msg of history) {
          expect(msg.id).toBeTruthy();
          expect(msg.sessionId).toBeTruthy();
          expect(typeof msg.timestamp).toBe('number');
          expect(msg.type).toBeTruthy();
        }
      },
      30_000,
    );

    it(
      'readSessionHistory() handles non-existent session gracefully',
      async () => {
        const history = await adapter.readSessionHistory(
          'non-existent-session-id-00000000',
        );
        expect(Array.isArray(history)).toBe(true);
        expect(history.length).toBe(0);
      },
      10_000,
    );

    // ──────────────────────────────────────────────
    // 7. discoverSessions()
    // ──────────────────────────────────────────────

    it(
      'discoverSessions() returns SessionSummary[]',
      async () => {
        const sessions = await adapter.discoverSessions();

        expect(Array.isArray(sessions)).toBe(true);
        // We just created a session, so at least one should exist
        // (though it may not show for adapters that only discover stopped sessions)
        for (const s of sessions) {
          expect(s.id).toBeTruthy();
          expect(s.adapterName).toBe(adapter.name);
          expect(typeof s.lastActiveAt).toBe('number');
          expect(typeof s.cwd).toBe('string');
          expect(typeof s.resumeCommand).toBe('string');
        }
      },
      30_000,
    );

    // ──────────────────────────────────────────────
    // 8. commands event
    // ──────────────────────────────────────────────

    it(
      'emits "commands" event with AdapterCommand[] after first query',
      async () => {
        // Ensure detect() populates CLI path
        await adapter.detect();

        // Spawn a fresh process for this test
        commandsProcess = await adapter.spawn({
          cwd,
          ...options.spawnOverrides,
        });

        // Listen for commands event
        const commandsPromise = waitForEvent<AdapterCommand[]>(
          commandsProcess,
          'commands',
          90_000,
        );

        // Trigger the first query so SDK fetches commands
        commandsProcess.sendMessage(simplePrompt);

        const commands = await commandsPromise;

        expect(Array.isArray(commands)).toBe(true);
        expect(commands.length).toBeGreaterThan(0);

        for (const cmd of commands) {
          expect(typeof cmd.name).toBe('string');
          expect(cmd.name.length).toBeGreaterThan(0);
          expect(typeof cmd.description).toBe('string');
        }

        // Clean up: wait for idle then kill
        if (commandsProcess.status === 'running') {
          await waitForEvent(commandsProcess, 'idle', 90_000).catch(() => {});
        }
        commandsProcess.kill();
      },
      120_000,
    );

    // ──────────────────────────────────────────────
    // 9. getSessionStoragePath()
    // ──────────────────────────────────────────────

    it('getSessionStoragePath() returns a non-empty string', () => {
      const storagePath = adapter.getSessionStoragePath();
      expect(typeof storagePath).toBe('string');
      expect(storagePath.length).toBeGreaterThan(0);
    });

    // ──────────────────────────────────────────────
    // 10. getResumeCommand()
    // ──────────────────────────────────────────────

    it('getResumeCommand() returns a string containing the session ID', () => {
      expect(capturedSessionId).toBeTruthy();

      const cmd = adapter.getResumeCommand(capturedSessionId!);
      expect(typeof cmd).toBe('string');
      expect(cmd).toContain(capturedSessionId!);
    });

    // ──────────────────────────────────────────────
    // 11. listCommands()
    // ──────────────────────────────────────────────

    it('listCommands() returns AdapterCommand[]', async () => {
      if (!adapter.listCommands) {
        // listCommands is optional on the interface — if not implemented, pass
        return;
      }

      const commands = await adapter.listCommands();
      expect(Array.isArray(commands)).toBe(true);
      expect(commands.length).toBeGreaterThan(0);

      for (const cmd of commands) {
        expect(typeof cmd.name).toBe('string');
        expect(cmd.name.length).toBeGreaterThan(0);
        expect(typeof cmd.description).toBe('string');
      }
    });

    // ──────────────────────────────────────────────
    // 12. setPlanMode()
    // ──────────────────────────────────────────────

    it('setPlanMode() can toggle without error', async () => {
      // Spawn a temporary process to test setPlanMode
      await adapter.detect();
      const proc = await adapter.spawn({
        cwd,
        ...options.spawnOverrides,
      });

      try {
        if (proc.setPlanMode) {
          // Should not throw
          proc.setPlanMode(true);
          proc.setPlanMode(false);
        }
      } finally {
        proc.kill();
      }
    });

    // ──────────────────────────────────────────────
    // 13. updateOptions()
    // ──────────────────────────────────────────────

    it('updateOptions() can be called without error', async () => {
      await adapter.detect();
      const proc = await adapter.spawn({
        cwd,
        ...options.spawnOverrides,
      });

      try {
        // Should not throw
        proc.updateOptions({ model: 'test-model' });
      } finally {
        proc.kill();
      }
    });
  });
}

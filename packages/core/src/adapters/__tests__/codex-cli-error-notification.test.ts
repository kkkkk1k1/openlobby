import { describe, expect, it } from 'vitest';
import { CodexCliProcess } from '../codex-cli.js';
import type { LobbyMessage, SpawnOptions } from '../../types.js';

/**
 * Regression test for the upstream relay "serverOverloaded" bug:
 * Codex CLI emits a top-level `error` JSON-RPC notification when the
 * underlying model provider returns capacity / auth / network errors.
 * Previously this fell through to the default branch and was only
 * logged as "[Codex] Unknown notification: error", so users saw
 * nothing in the IM channel and the session stayed stuck in 'running'.
 */
describe('CodexCliProcess.handleNotification — error notifications', () => {
  function newProc() {
    const opts: SpawnOptions = { cwd: '/tmp' };
    const proc = new CodexCliProcess('test-session', opts);
    // Force status so we can assert the transition
    (proc as unknown as { status: string }).status = 'running';
    const messages: LobbyMessage[] = [];
    let idleCount = 0;
    proc.on('message', (m: LobbyMessage) => messages.push(m));
    proc.on('idle', () => { idleCount += 1; });
    return { proc, messages, getIdleCount: () => idleCount };
  }

  function invokeNotification(proc: CodexCliProcess, method: string, params: unknown) {
    // handleNotification is private; this is a deliberate test-only access.
    (proc as unknown as { handleNotification: (msg: unknown) => void })
      .handleNotification({ method, params });
  }

  it('surfaces a serverOverloaded error as an isError result and releases the session', () => {
    const { proc, messages, getIdleCount } = newProc();

    invokeNotification(proc, 'error', {
      error: {
        message: 'Selected model is at capacity. Please try a different model.',
        codexErrorInfo: 'serverOverloaded',
        additionalDetails: null,
      },
      willRetry: false,
      threadId: '019e1b3e-4149-7120-aaa1-8abcdef',
    });

    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg.type).toBe('result');
    expect(msg.meta?.isError).toBe(true);
    expect(msg.content).toMatchObject({
      subtype: 'error',
      error: 'Selected model is at capacity. Please try a different model.',
      code: 'serverOverloaded',
      willRetry: false,
    });
    expect(getIdleCount()).toBe(1);
    expect((proc as unknown as { status: string }).status).toBe('idle');
  });

  it('does not release the session when Codex will retry', () => {
    const { proc, messages, getIdleCount } = newProc();

    invokeNotification(proc, 'error', {
      error: { message: 'Transient upstream error', codexErrorInfo: 'networkError' },
      willRetry: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages[0].meta?.isError).toBe(true);
    expect(String((messages[0].content as { error: string }).error)).toContain('retrying');
    // No idle emitted, status stays 'running' so the turn is not torn down
    expect(getIdleCount()).toBe(0);
    expect((proc as unknown as { status: string }).status).toBe('running');
  });

  it('handles slash-style "error/notification" method name', () => {
    const { proc, messages, getIdleCount } = newProc();

    invokeNotification(proc, 'error/notification', {
      error: { message: 'Auth failed', codexErrorInfo: 'unauthorized' },
      willRetry: false,
    });

    expect(messages).toHaveLength(1);
    expect((messages[0].content as { code?: string }).code).toBe('unauthorized');
    expect(getIdleCount()).toBe(1);
  });

  it('falls back to a generic error string when the payload omits error.message', () => {
    const { proc, messages } = newProc();

    invokeNotification(proc, 'error', { willRetry: false });

    expect(messages).toHaveLength(1);
    expect((messages[0].content as { error: string }).error).toBe('Codex error');
    expect(messages[0].meta?.isError).toBe(true);
  });
});

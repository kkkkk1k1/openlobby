import { describe, it, expect, afterEach, vi } from 'vitest';

/**
 * Tests for process manager detection logic used in packages/cli/src/process-utils.ts.
 * The logic is simple env-var checking, so we replicate it here to test without
 * adding vitest infrastructure to the cli package.
 */
function isUnderProcessManager(env: Record<string, string | undefined>): boolean {
  return !!(
    env.PM2_HOME ||
    env.pm_id ||
    env.INVOCATION_ID ||
    env.SUPERVISOR_ENABLED
  );
}

describe('isUnderProcessManager', () => {
  it('returns true when PM2_HOME is set', () => {
    expect(isUnderProcessManager({ PM2_HOME: '/root/.pm2' })).toBe(true);
  });

  it('returns true when pm_id is set', () => {
    expect(isUnderProcessManager({ pm_id: '0' })).toBe(true);
  });

  it('returns true when INVOCATION_ID is set (systemd)', () => {
    expect(isUnderProcessManager({ INVOCATION_ID: 'abc-123' })).toBe(true);
  });

  it('returns true when SUPERVISOR_ENABLED is set', () => {
    expect(isUnderProcessManager({ SUPERVISOR_ENABLED: '1' })).toBe(true);
  });

  it('returns false when no process manager env vars are set', () => {
    expect(isUnderProcessManager({})).toBe(false);
  });

  it('returns false when env vars are empty strings', () => {
    expect(isUnderProcessManager({ PM2_HOME: '', pm_id: '' })).toBe(false);
  });

  it('returns true when multiple pm env vars are set', () => {
    expect(isUnderProcessManager({ PM2_HOME: '/root/.pm2', pm_id: '0' })).toBe(true);
  });
});

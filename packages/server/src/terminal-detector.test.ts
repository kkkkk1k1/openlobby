import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { detectTerminal, resetDetectedTerminal, openInTerminal } from './terminal-detector.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

const mockSpawnSync = vi.mocked(spawnSync);
const mockSpawn = vi.mocked(spawn);

describe('detectTerminal', () => {
  beforeEach(() => {
    resetDetectedTerminal();
    mockSpawnSync.mockReset();
    mockSpawnSync.mockReturnValue({ status: 0 } as any);
  });

  it('detects iTerm2 from TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'iTerm.app';
    const info = detectTerminal();
    expect(info.id).toBe('iterm2');
    expect(info.name).toBe('iTerm2');
    expect(info.detected).toBe(true);
    expect(info.available).toBe(true);
  });

  it('detects Terminal.app from TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    const info = detectTerminal();
    expect(info.id).toBe('terminal-app');
    expect(info.detected).toBe(true);
  });

  it('detects Ghostty from TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'ghostty';
    const info = detectTerminal();
    expect(info.id).toBe('ghostty');
    expect(info.detected).toBe(true);
  });

  it('detects Kitty from TERM_PROGRAM', () => {
    process.env.TERM_PROGRAM = 'kitty';
    const info = detectTerminal();
    expect(info.id).toBe('kitty');
    expect(info.detected).toBe(true);
  });

  it('returns unknown for empty TERM_PROGRAM', () => {
    delete process.env.TERM_PROGRAM;
    const info = detectTerminal();
    expect(info.id).toBe('unknown');
    expect(info.detected).toBe(false);
  });

  it('skips tmux and returns unknown', () => {
    process.env.TERM_PROGRAM = 'tmux';
    const info = detectTerminal();
    expect(info.id).toBe('unknown');
    expect(info.detected).toBe(false);
  });

  it('skips vscode and returns unknown', () => {
    process.env.TERM_PROGRAM = 'vscode';
    const info = detectTerminal();
    expect(info.id).toBe('unknown');
    expect(info.detected).toBe(false);
  });

  it('caches result across calls', () => {
    process.env.TERM_PROGRAM = 'iTerm.app';
    const first = detectTerminal();
    process.env.TERM_PROGRAM = 'Apple_Terminal';
    const second = detectTerminal();
    expect(first).toBe(second);
    expect(second.id).toBe('iterm2');
  });
});

describe('detectTerminal — binary verification', () => {
  beforeEach(() => {
    resetDetectedTerminal();
    mockSpawnSync.mockReset();
  });

  it('marks terminal unavailable when binary not found', () => {
    process.env.TERM_PROGRAM = 'ghostty';
    mockSpawnSync.mockReturnValue({ status: 1 } as any);
    const info = detectTerminal();
    expect(info.id).toBe('ghostty');
    expect(info.detected).toBe(true);
    expect(info.available).toBe(false);
  });

  it('marks terminal available when binary found', () => {
    process.env.TERM_PROGRAM = 'ghostty';
    mockSpawnSync.mockReturnValue({ status: 0 } as any);
    const info = detectTerminal();
    expect(info.available).toBe(true);
  });
});

describe('openInTerminal — fallback chain', () => {
  beforeEach(() => {
    resetDetectedTerminal();
    mockSpawnSync.mockReset();
    mockSpawn.mockReset();
    mockSpawn.mockReturnValue({ unref: vi.fn() } as any);
  });

  it('L1: uses detected terminal when available', () => {
    process.env.TERM_PROGRAM = 'ghostty';
    mockSpawnSync.mockReturnValue({ status: 0 } as any);
    const result = openInTerminal('echo hello');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.terminal).toBe('ghostty');
  });

  it('L3: returns command for web dialog when all fail', () => {
    delete process.env.TERM_PROGRAM;
    mockSpawnSync.mockReturnValue({ status: 1 } as any);
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const result = openInTerminal('cd /test && claude --resume abc');
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.resumeCommand).toBe('cd /test && claude --resume abc');
      expect(result.reason).toContain('No');
    }
  });
});

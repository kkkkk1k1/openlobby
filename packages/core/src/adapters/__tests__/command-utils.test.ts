import { describe, expect, it, beforeEach, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { detectInstalledBinary, findExecutable } from '../command-utils.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

describe('command-utils', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
  });

  it('uses where.exe on Windows when resolving executables', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockExecSync.mockReturnValue(
      'C:\\Program Files\\nodejs\\codex\r\nC:\\Program Files\\nodejs\\codex.cmd\r\n' as never,
    );

    const result = findExecutable('codex');

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(result).toBe('C:\\Program Files\\nodejs\\codex.cmd');
    expect(mockExecSync).toHaveBeenCalledWith(
      'where.exe codex',
      expect.objectContaining({ encoding: 'utf-8', windowsHide: true }),
    );
  });

  it('preserves PATH order when multiple Windows launchers are returned', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockExecSync.mockReturnValue(
      'C:\\Users\\seaso\\bin\\codex.cmd\r\nC:\\Program Files\\Codex\\codex.exe\r\n' as never,
    );

    const result = findExecutable('codex');

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(result).toBe('C:\\Users\\seaso\\bin\\codex.cmd');
  });

  it('returns version and path for installed Windows npm shims', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mockExecSync
      .mockReturnValueOnce('codex-cli 0.120.0\n' as never)
      .mockReturnValueOnce(
        'C:\\Program Files\\nodejs\\codex\r\nC:\\Program Files\\nodejs\\codex.cmd\r\n' as never,
      );

    const result = detectInstalledBinary('codex');

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(result).toEqual({
      version: 'codex-cli 0.120.0',
      path: 'C:\\Program Files\\nodejs\\codex.cmd',
    });
  });
});

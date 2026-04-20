import { describe, expect, it } from 'vitest';
import { buildCodexLaunchSpec } from '../codex-cli.js';

describe('codex-cli launch spec', () => {
  it('returns a direct launch spec outside Windows', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const result = buildCodexLaunchSpec('/usr/local/bin/codex');

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(result).toEqual({
      command: '/usr/local/bin/codex',
      args: ['app-server', '--listen', 'stdio://'],
    });
  });

  it('returns a direct launch spec for Windows executables', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const result = buildCodexLaunchSpec('C:\\Program Files\\Codex\\codex.exe');

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(result).toEqual({
      command: 'C:\\Program Files\\Codex\\codex.exe',
      args: ['app-server', '--listen', 'stdio://'],
    });
  });

  it('wraps Windows cmd shims in a shell command with escaped quotes', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const result = buildCodexLaunchSpec('C:\\Program Files\\Codex "Beta"\\codex.cmd');

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(result).toEqual({
      command: '"C:\\Program Files\\Codex ""Beta""\\codex.cmd" "app-server" "--listen" "stdio://"',
      args: [],
      shell: true,
    });
  });
});

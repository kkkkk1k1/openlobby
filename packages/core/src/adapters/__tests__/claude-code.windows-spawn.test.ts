import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

// Mock node:fs before importing the module under test so readFileSync/existsSync
// can be controlled without touching the real filesystem.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
  };
});

import { readFileSync, existsSync } from 'node:fs';
import { resolveClaudeExecutable } from '../claude-code.js';

const mockReadFileSync = vi.mocked(readFileSync);
const mockExistsSync = vi.mocked(existsSync);

/**
 * Regression coverage for Windows `.cmd` shim spawning.
 *
 * Root cause of the original bug: Node ≥ 18.20.2 refuses to spawn `.cmd`/`.bat`
 * files without `shell: true` (CVE-2024-27980). OpenLobby's custom
 * `spawnClaudeCodeProcess` deliberately avoids `shell: true` to keep
 * `--mcp-config` JSON arguments from being mangled by cmd.exe.
 *
 * Fix strategy: resolve `.cmd` shims to the underlying `cli.js` file and pass
 * that to the SDK along with `executable = process.execPath`. The SDK then
 * spawns `node cli.js …` — no cmd.exe layer, no EINVAL, no JSON escaping.
 */
describe('resolveClaudeExecutable', () => {
  let originalPlatform: NodeJS.Platform;

  beforeEach(() => {
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    originalPlatform = process.platform;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
  });

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  }

  it('returns an empty object when cliPath is undefined (SDK uses bundled executable)', () => {
    setPlatform('linux');
    expect(resolveClaudeExecutable(undefined)).toEqual({});
  });

  it('passes the path through unchanged on non-Windows platforms', () => {
    setPlatform('linux');
    expect(resolveClaudeExecutable('/usr/local/bin/claude')).toEqual({
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
    });
  });

  it('passes a Windows .exe through unchanged (SDK spawns it directly)', () => {
    setPlatform('win32');
    expect(resolveClaudeExecutable('C:\\Program Files\\Claude\\claude.exe')).toEqual({
      pathToClaudeCodeExecutable: 'C:\\Program Files\\Claude\\claude.exe',
    });
  });

  it('passes a Windows .com through unchanged', () => {
    setPlatform('win32');
    expect(resolveClaudeExecutable('C:\\bin\\claude.com')).toEqual({
      pathToClaudeCodeExecutable: 'C:\\bin\\claude.com',
    });
  });

  it('forces executable to process.execPath when given a .js path on Windows', () => {
    // Ensures the SDK wraps the JS entrypoint with the current Node, not a
    // PATH-resolved `node` that may not exist or be a different version.
    setPlatform('win32');
    const result = resolveClaudeExecutable('C:\\pkg\\cli.js');
    expect(result).toEqual({
      pathToClaudeCodeExecutable: 'C:\\pkg\\cli.js',
      executable: process.execPath,
    });
  });

  it('forces executable to process.execPath for .mjs on Windows', () => {
    setPlatform('win32');
    const result = resolveClaudeExecutable('C:\\pkg\\cli.mjs');
    expect(result).toEqual({
      pathToClaudeCodeExecutable: 'C:\\pkg\\cli.mjs',
      executable: process.execPath,
    });
  });

  it('parses a standard npm .cmd shim and resolves the underlying cli.js', () => {
    // Real-world npm cmd-shim content, verbatim from an npm install of
    // @anthropic-ai/claude-code. The final line names the JS entrypoint as
    // "%~dp0\..\..\path\to\cli.js".
    setPlatform('win32');
    const shimContent = `@SETLOCAL
@IF EXIST "%~dp0\\node.exe" (
  SET "_prog=%~dp0\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

"%_prog%"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*
ENDLOCAL
EXIT /b %errorlevel%
`;
    mockReadFileSync.mockReturnValue(shimContent);
    mockExistsSync.mockReturnValue(true);

    const result = resolveClaudeExecutable('C:\\nvm4w\\nodejs\\claude.cmd');

    expect(result).toEqual({
      pathToClaudeCodeExecutable:
        'C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      executable: process.execPath,
    });
    expect(mockReadFileSync).toHaveBeenCalledWith(
      'C:\\nvm4w\\nodejs\\claude.cmd',
      'utf-8',
    );
  });

  it('parses a .cmd shim that uses the %dp0% token variant', () => {
    // Some cmd-shim templates use `%dp0%` instead of `%~dp0`. Both must work.
    setPlatform('win32');
    const shimContent =
      `@"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n`;
    mockReadFileSync.mockReturnValue(shimContent);
    mockExistsSync.mockReturnValue(true);

    const result = resolveClaudeExecutable('C:\\Users\\me\\bin\\claude.cmd');

    expect(result).toEqual({
      pathToClaudeCodeExecutable:
        'C:\\Users\\me\\bin\\node_modules\\@anthropic-ai\\claude-code\\cli.js',
      executable: process.execPath,
    });
  });

  it('parses .bat shims the same way as .cmd shims', () => {
    setPlatform('win32');
    const shimContent = `@"%_prog%" "%~dp0\\foo\\cli.js" %*\n`;
    mockReadFileSync.mockReturnValue(shimContent);
    mockExistsSync.mockReturnValue(true);

    const result = resolveClaudeExecutable('C:\\tools\\claude.bat');

    expect(result).toEqual({
      pathToClaudeCodeExecutable: 'C:\\tools\\foo\\cli.js',
      executable: process.execPath,
    });
  });

  it('falls back to the original .cmd path when the shim content cannot be parsed', () => {
    // Preserves pre-fix behaviour as a graceful fallback for unknown shim
    // formats — the EINVAL error will still surface downstream, but with a
    // clearer path forward.
    setPlatform('win32');
    mockReadFileSync.mockReturnValue('this is not a recognisable shim');

    const result = resolveClaudeExecutable('C:\\bin\\claude.cmd');

    expect(result).toEqual({ pathToClaudeCodeExecutable: 'C:\\bin\\claude.cmd' });
  });

  it('falls back when the parsed .js target does not exist on disk', () => {
    setPlatform('win32');
    const shimContent = `@"%_prog%" "%~dp0\\missing\\cli.js" %*\n`;
    mockReadFileSync.mockReturnValue(shimContent);
    mockExistsSync.mockReturnValue(false);

    const result = resolveClaudeExecutable('C:\\bin\\claude.cmd');

    expect(result).toEqual({ pathToClaudeCodeExecutable: 'C:\\bin\\claude.cmd' });
  });

  it('falls back when readFileSync throws (permission denied / missing file)', () => {
    setPlatform('win32');
    mockReadFileSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = resolveClaudeExecutable('C:\\bin\\claude.cmd');

    expect(result).toEqual({ pathToClaudeCodeExecutable: 'C:\\bin\\claude.cmd' });
  });

  it('passes through unknown Windows extensions unchanged', () => {
    // A .ps1 shouldn't trigger shim parsing — we pass it through and let the
    // SDK/Node surface whatever error is appropriate.
    setPlatform('win32');
    const result = resolveClaudeExecutable('C:\\bin\\claude.ps1');
    expect(result).toEqual({ pathToClaudeCodeExecutable: 'C:\\bin\\claude.ps1' });
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });
});

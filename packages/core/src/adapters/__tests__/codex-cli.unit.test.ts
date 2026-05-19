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

  describe('mcpServers launch-time injection', () => {
    it('emits `-c mcp_servers.<name>=<inline_table>` pairs BEFORE the app-server subcommand', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const result = buildCodexLaunchSpec('/usr/local/bin/codex', {
        openlobby: {
          command: 'node',
          args: ['/usr/lib/node_modules/openlobby/dist/mcp-server.js'],
          env: { OPENLOBBY_API: 'http://127.0.0.1:8889' },
        },
      });

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });

      expect(result.command).toBe('/usr/local/bin/codex');
      // `-c` overrides must come before the `app-server` subcommand so the
      // top-level `codex` parser picks them up.
      expect(result.args[0]).toBe('-c');
      expect(result.args[1]).toBe(
        'mcp_servers.openlobby={ command = "node", args = ["/usr/lib/node_modules/openlobby/dist/mcp-server.js"], env = { OPENLOBBY_API = "http://127.0.0.1:8889" } }',
      );
      expect(result.args.slice(2)).toEqual(['app-server', '--listen', 'stdio://']);
    });

    it('emits one `-c` pair per MCP server when multiple are provided', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const result = buildCodexLaunchSpec('/usr/local/bin/codex', {
        a: { command: 'cmd-a' },
        b: { command: 'cmd-b', args: ['x'] },
      });

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });

      // Two pairs of -c arguments, in insertion order.
      expect(result.args.filter((a) => a === '-c').length).toBe(2);
      expect(result.args[0]).toBe('-c');
      expect(result.args[1]).toBe('mcp_servers.a={ command = "cmd-a", args = [], env = {} }');
      expect(result.args[2]).toBe('-c');
      expect(result.args[3]).toBe('mcp_servers.b={ command = "cmd-b", args = ["x"], env = {} }');
    });

    it('escapes embedded quotes and backslashes in TOML strings', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const result = buildCodexLaunchSpec('/usr/local/bin/codex', {
        weird: {
          command: 'C:\\Path With "Quotes"\\bin.exe',
          args: ['line1\nline2'],
          env: { K: 'v"ith\\backslash' },
        },
      });

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });

      const override = result.args[1];
      // Backslash → \\, quote → \", newline → \n
      expect(override).toContain('command = "C:\\\\Path With \\"Quotes\\"\\\\bin.exe"');
      expect(override).toContain('args = ["line1\\nline2"]');
      expect(override).toContain('env = { K = "v\\"ith\\\\backslash" }');
    });

    it('omits the `-c` flags entirely when mcpServers is undefined', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const result = buildCodexLaunchSpec('/usr/local/bin/codex');

      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      expect(result.args).toEqual(['app-server', '--listen', 'stdio://']);
    });
  });
});

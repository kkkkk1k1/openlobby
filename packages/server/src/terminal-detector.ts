// packages/server/src/terminal-detector.ts
import { spawnSync, spawn } from 'node:child_process';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TerminalInfo {
  id: string;
  name: string;
  detected: boolean;
  available: boolean;
}

export type OpenResult =
  | { ok: true; terminal: string }
  | { ok: false; resumeCommand: string; reason: string };

interface TerminalEntry {
  id: string;
  name: string;
  envMatches: string[];
  platforms: NodeJS.Platform[];
  verifyBinary: string | null;
  open: (resumeCmd: string) => OpenResult;
}

// ── Helpers (defined before registry so entries can reference them) ───────────

function verifyBinaryExists(binary: string): boolean {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, [binary], { stdio: 'ignore' });
  return result.status === 0;
}

function openViaAppleScript(appName: string, resumeCmd: string, doCommand: string): OpenResult {
  const script = [
    'on run argv',
    `  tell application "${appName}"`,
    `    ${doCommand}`,
    '    activate',
    '  end tell',
    'end run',
  ].join('\n');
  const result = spawnSync('osascript', ['-', resumeCmd], { input: script });
  if (result.status !== 0) {
    return { ok: false, resumeCommand: resumeCmd, reason: `osascript failed: ${result.stderr?.toString()?.trim() ?? 'unknown error'}` };
  }
  return { ok: true, terminal: appName };
}

function openViaCli(terminalName: string, argv: string[]): OpenResult {
  try {
    const [cmd, ...args] = argv;
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, terminal: terminalName };
  } catch (err) {
    return { ok: false, resumeCommand: '', reason: `Failed to spawn ${terminalName}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Terminal Registry ────────────────────────────────────────────────────────

const TERMINAL_REGISTRY: TerminalEntry[] = [
  // macOS AppleScript terminals
  {
    id: 'iterm2',
    name: 'iTerm2',
    envMatches: ['iTerm.app', 'iTerm2.app'],
    platforms: ['darwin'],
    verifyBinary: null,
    open: (cmd) => openViaAppleScript('iTerm', cmd, 'create window with default profile command (item 1 of argv)'),
  },
  {
    id: 'terminal-app',
    name: 'Terminal.app',
    envMatches: ['Apple_Terminal'],
    platforms: ['darwin'],
    verifyBinary: null,
    open: (cmd) => openViaAppleScript('Terminal', cmd, 'do script (item 1 of argv)'),
  },
  // CLI terminals (cross-platform)
  {
    id: 'ghostty',
    name: 'Ghostty',
    envMatches: ['ghostty'],
    platforms: ['darwin', 'linux'],
    verifyBinary: 'ghostty',
    open: (cmd) => openViaCli('ghostty', ['ghostty', '-e', 'bash', '-c', `${cmd}; exec bash`]),
  },
  {
    id: 'kitty',
    name: 'Kitty',
    envMatches: ['kitty'],
    platforms: ['darwin', 'linux'],
    verifyBinary: 'kitty',
    open: (cmd) => openViaCli('kitty', ['kitty', 'bash', '-c', `${cmd}; exec bash`]),
  },
  {
    id: 'alacritty',
    name: 'Alacritty',
    envMatches: ['Alacritty'],
    platforms: ['darwin', 'linux'],
    verifyBinary: 'alacritty',
    open: (cmd) => openViaCli('alacritty', ['alacritty', '-e', 'bash', '-c', `${cmd}; exec bash`]),
  },
  {
    id: 'warp',
    name: 'Warp',
    envMatches: ['WarpTerminal'],
    platforms: ['darwin'],
    verifyBinary: null,
    open: (cmd) => openViaCli('warp', ['open', '-a', 'Warp']),
  },
  // Linux terminals
  {
    id: 'gnome-terminal',
    name: 'GNOME Terminal',
    envMatches: ['gnome-terminal-server'],
    platforms: ['linux'],
    verifyBinary: 'gnome-terminal',
    open: (cmd) => openViaCli('gnome-terminal', ['gnome-terminal', '--', 'bash', '-c', `${cmd}; exec bash`]),
  },
  {
    id: 'konsole',
    name: 'Konsole',
    envMatches: ['konsole'],
    platforms: ['linux'],
    verifyBinary: 'konsole',
    open: (cmd) => openViaCli('konsole', ['konsole', '-e', 'bash', '-c', `${cmd}; exec bash`]),
  },
  {
    id: 'xfce4-terminal',
    name: 'Xfce Terminal',
    envMatches: ['xfce4-terminal'],
    platforms: ['linux'],
    verifyBinary: 'xfce4-terminal',
    open: (cmd) => openViaCli('xfce4-terminal', ['xfce4-terminal', '-e', `bash -c '${cmd}; exec bash'`]),
  },
  // Windows
  {
    id: 'windows-terminal',
    name: 'Windows Terminal',
    envMatches: ['Windows_Terminal'],
    platforms: ['win32'],
    verifyBinary: 'wt.exe',
    open: (cmd) => openViaCli('windows-terminal', ['wt.exe', '-d', '.', 'cmd', '/K', cmd]),
  },
];

const SKIP_ENV_VALUES = new Set(['tmux', 'screen', 'vscode', 'codium']);

// ── Detection ────────────────────────────────────────────────────────────────

let cachedTerminal: TerminalInfo | null = null;

export function detectTerminal(): TerminalInfo {
  if (cachedTerminal) return cachedTerminal;
  const termProgram = process.env.TERM_PROGRAM ?? '';
  const platform = process.platform;
  if (SKIP_ENV_VALUES.has(termProgram.toLowerCase())) {
    cachedTerminal = { id: 'unknown', name: termProgram, detected: false, available: false };
    return cachedTerminal;
  }
  const entry = TERMINAL_REGISTRY.find(
    (e) =>
      e.envMatches.some((m) => m.toLowerCase() === termProgram.toLowerCase()) &&
      (e.platforms.length === 0 || e.platforms.includes(platform)),
  );
  if (!entry) {
    cachedTerminal = { id: 'unknown', name: termProgram || '(none)', detected: false, available: false };
    return cachedTerminal;
  }
  const available = entry.verifyBinary ? verifyBinaryExists(entry.verifyBinary) : true;
  cachedTerminal = { id: entry.id, name: entry.name, detected: true, available };
  return cachedTerminal;
}

export function resetDetectedTerminal(): void {
  cachedTerminal = null;
}

// ── Open in Terminal (three-level fallback) ──────────────────────────────────

function openSystemDefault(resumeCmd: string, platform: NodeJS.Platform): OpenResult {
  if (platform === 'darwin') {
    return openViaAppleScript('Terminal', resumeCmd, 'do script (item 1 of argv)');
  }
  if (platform === 'win32') {
    try {
      spawn('cmd.exe', ['/K', resumeCmd], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, terminal: 'cmd.exe' };
    } catch {
      return { ok: false, resumeCommand: resumeCmd, reason: 'Failed to open cmd.exe' };
    }
  }
  const linuxFallbacks = [
    { cmd: 'x-terminal-emulator', args: ['-e', 'bash', '-c', `${resumeCmd}; exec bash`] },
    { cmd: 'gnome-terminal', args: ['--', 'bash', '-c', `${resumeCmd}; exec bash`] },
    { cmd: 'konsole', args: ['-e', 'bash', '-c', `${resumeCmd}; exec bash`] },
    { cmd: 'xfce4-terminal', args: ['-e', `bash -c '${resumeCmd}; exec bash'`] },
    { cmd: 'xterm', args: ['-e', `bash -c '${resumeCmd}; exec bash'`] },
  ];
  for (const t of linuxFallbacks) {
    if (verifyBinaryExists(t.cmd)) {
      try {
        spawn(t.cmd, t.args, { detached: true, stdio: 'ignore' }).unref();
        return { ok: true, terminal: t.cmd };
      } catch { /* try next */ }
    }
  }
  return { ok: false, resumeCommand: resumeCmd, reason: 'No supported terminal emulator found' };
}

export function openInTerminal(resumeCmd: string): OpenResult {
  const platform = process.platform;
  const detected = detectTerminal();
  // L1: Try detected terminal
  if (detected.detected && detected.available) {
    const entry = TERMINAL_REGISTRY.find((e) => e.id === detected.id);
    if (entry) {
      const result = entry.open(resumeCmd);
      if (result.ok) return result;
    }
  }
  // L2: System default terminal
  const l2Result = openSystemDefault(resumeCmd, platform);
  if (l2Result.ok) return l2Result;
  // L3: Return command for Web dialog
  return {
    ok: false,
    resumeCommand: resumeCmd,
    reason: detected.detected
      ? `Detected ${detected.name} but failed to open it, and system default terminal also failed.`
      : 'No terminal detected from TERM_PROGRAM, and system default terminal failed.',
  };
}

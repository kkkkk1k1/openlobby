import { execSync } from 'node:child_process';

function runCommand(command: string): string | undefined {
  try {
    return execSync(command, {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
  } catch {
    return undefined;
  }
}

function pickPreferredExecutable(matches: string[]): string | undefined {
  const normalized = matches
    .map((line) => line.trim())
    .filter(Boolean);
  if (normalized.length === 0) return undefined;

  if (process.platform !== 'win32') {
    return normalized[0];
  }

  const preferredExtensions = ['.exe', '.cmd', '.bat', '.com'];
  for (const ext of preferredExtensions) {
    const match = normalized.find((candidate) => candidate.toLowerCase().endsWith(ext));
    if (match) {
      return match;
    }
  }

  return normalized[0];
}

export function findExecutable(binary: string): string | undefined {
  const lookupCommand = process.platform === 'win32'
    ? `where.exe ${binary}`
    : `which ${binary}`;
  const output = runCommand(lookupCommand);
  if (!output) return undefined;
  return pickPreferredExecutable(output.split(/\r?\n/));
}

export function detectInstalledBinary(
  binary: string,
): { version: string; path: string } | null {
  const version = runCommand(`${binary} --version`);
  if (!version) return null;

  const path = findExecutable(binary) ?? binary;
  return { version, path };
}

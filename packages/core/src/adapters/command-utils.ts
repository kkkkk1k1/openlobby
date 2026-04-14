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

export function findExecutable(binary: string): string | undefined {
  const lookupCommand = process.platform === 'win32'
    ? `where.exe ${binary}`
    : `which ${binary}`;
  const output = runCommand(lookupCommand);
  if (!output) return undefined;
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

export function detectInstalledBinary(
  binary: string,
): { version: string; path: string } | null {
  const version = runCommand(`${binary} --version`);
  if (!version) return null;

  const path = findExecutable(binary) ?? binary;
  return { version, path };
}

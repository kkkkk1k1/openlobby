#!/usr/bin/env node

import { spawn } from 'node:child_process';

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const children = [];
let shuttingDown = false;

function toCommandLine(args) {
  return [pnpmCommand, ...args].join(' ');
}

function runWorkspaceCommand(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(toCommandLine(args), {
      stdio: 'inherit',
      env: process.env,
      shell: true,
    });

    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${name} exited with ${signal ?? `code ${code}`}`));
    });

    child.on('error', reject);
  });
}

function startWorkspaceDev(name, filter) {
  const args = filter
    ? ['--filter', filter, 'dev']
    : ['dev'];

  const child = spawn(toCommandLine(args), {
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    if (code !== 0) {
      console.error(`[dev] ${name} exited early (${signal ?? `code ${code}`})`);
      void shutdown(1);
    }
  });

  children.push(child);
  return child;
}

async function waitForServerReady(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        console.log(`[dev] Backend ready at ${url}`);
        return;
      }
    } catch {
      // Backend is still starting. Keep polling quietly.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for backend: ${url}`);
}

async function killChild(child) {
  if (!child || child.killed) return;

  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
      });
      killer.on('exit', () => resolve());
      killer.on('error', () => resolve());
    });
    return;
  }

  child.kill('SIGTERM');
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  await Promise.allSettled(children.map((child) => killChild(child)));
  process.exit(exitCode);
}

process.on('SIGINT', () => {
  void shutdown(0);
});

process.on('SIGTERM', () => {
  void shutdown(0);
});

async function main() {
  console.log('[dev] Building shared packages once before starting watchers...');

  await runWorkspaceCommand('core build', ['--filter', '@openlobby/core', 'build']);
  await runWorkspaceCommand('channel-telegram build', ['--filter', 'openlobby-channel-telegram', 'build']);

  console.log('[dev] Starting core, channel, and server watchers...');

  startWorkspaceDev('core', '@openlobby/core');
  startWorkspaceDev('channel-telegram', 'openlobby-channel-telegram');
  startWorkspaceDev('server', '@openlobby/server');

  console.log('[dev] Waiting for backend before launching Vite...');
  await waitForServerReady('http://127.0.0.1:3001/health');

  console.log('[dev] Starting web dev server...');
  startWorkspaceDev('web', '@openlobby/web');
}

main().catch((error) => {
  console.error('[dev] Failed to start development stack:', error);
  void shutdown(1);
});

#!/usr/bin/env node

import { fork, execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync, constants } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.5.8'; // replaced by esbuild define

function parseArgs(args: string[]): { port: number; mcpApiPort?: number } {
  let port = 3001;
  let mcpApiPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--mcp-port' && args[i + 1]) {
      mcpApiPort = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
openlobby - Unified AI Agent Session Manager

Usage:
  openlobby [options]

Options:
  -p, --port <port>      Server port (default: 3001)
  --mcp-port <port>      MCP internal API port (default: server port + 1)
  -h, --help             Show this help message
  -v, --version          Show version

Environment Variables:
  OPENLOBBY_MCP_PORT     MCP internal API port (overridden by --mcp-port)
`);
      process.exit(0);
    }
    if (args[i] === '--version' || args[i] === '-v') {
      console.log(VERSION);
      process.exit(0);
    }
  }
  return { port, mcpApiPort };
}

import { isUnderProcessManager } from './process-utils.js';

function spawnServer(port: number, mcpApiPort: number | undefined): ReturnType<typeof fork> {
  const serverEntry = join(__dirname, 'server-main.js');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    OPENLOBBY_PORT: String(port),
    OPENLOBBY_VERSION: VERSION,
  };
  if (mcpApiPort !== undefined) {
    env.OPENLOBBY_MCP_PORT = String(mcpApiPort);
  }
  return fork(serverEntry, [], { env, stdio: 'inherit' });
}

async function performUpdate(): Promise<boolean> {
  try {
    const globalPrefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    accessSync(globalPrefix, constants.W_OK);
  } catch {
    console.error('[Wrapper] Cannot write to global npm prefix. Try: sudo npm install -g openlobby@latest');
    return false;
  }
  try {
    console.log('[Wrapper] Updating openlobby...');
    execSync('npm install -g openlobby@latest', { stdio: 'inherit' });
    console.log('[Wrapper] Update complete.');
    return true;
  } catch (err) {
    console.error('[Wrapper] Update failed:', err);
    return false;
  }
}

const { port, mcpApiPort } = parseArgs(process.argv.slice(2));
let child = spawnServer(port, mcpApiPort);

function setupChildListeners(proc: ReturnType<typeof fork>) {
  const exitHandler = (code: number | null) => {
    if (code !== null && code !== 0) {
      console.error(`[Wrapper] Server exited with code ${code}. Not restarting.`);
      process.exit(code);
    }
    // Exit code 0 means graceful shutdown
    process.exit(0);
  };

  proc.on('message', async (msg: any) => {
    if (msg?.type === 'update-and-restart') {
      const success = await performUpdate();
      if (success) {
        proc.removeListener('exit', exitHandler);
        proc.kill('SIGTERM');

        if (isUnderProcessManager()) {
          console.log('[Wrapper] Update complete. Exiting for process manager to restart...');
          proc.on('exit', () => process.exit(0));
        } else {
          console.log('[Wrapper] Restarting server...');
          child = spawnServer(port, mcpApiPort);
          setupChildListeners(child);
        }
      } else {
        proc.send({ type: 'update-failed', error: 'npm install failed or permission denied' });
      }
    }
  });

  proc.on('exit', exitHandler);
}

setupChildListeners(child);

// Forward SIGINT/SIGTERM to child
process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });

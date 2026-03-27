#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '@openlobby/server';

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseArgs(args: string[]) {
  let port = 3001;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
openlobby - Unified AI Agent Session Manager

Usage:
  openlobby [options]

Options:
  -p, --port <port>  Server port (default: 3001)
  -h, --help         Show this help message
  -v, --version      Show version
`);
      process.exit(0);
    }
    if (args[i] === '--version' || args[i] === '-v') {
      // Version is replaced at build time
      console.log('0.2.0');
      process.exit(0);
    }
  }
  return { port };
}

async function main() {
  const { port } = parseArgs(process.argv.slice(2));
  const webRoot = join(__dirname, '..', 'web');

  await createServer({ port, webRoot });
}

main().catch((err) => {
  console.error('Failed to start OpenLobby:', err);
  process.exit(1);
});

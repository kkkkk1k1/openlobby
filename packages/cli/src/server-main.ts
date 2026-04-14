#!/usr/bin/env node

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '@openlobby/server';

const __dirname = dirname(fileURLToPath(import.meta.url));

const port = parseInt(process.env.OPENLOBBY_PORT ?? '3001', 10);
const mcpApiPort = process.env.OPENLOBBY_MCP_PORT
  ? parseInt(process.env.OPENLOBBY_MCP_PORT, 10)
  : undefined;
const version = process.env.OPENLOBBY_VERSION ?? '0.0.0';
const webRoot = join(__dirname, '..', 'web');

async function main() {
  await createServer({ port, mcpApiPort, webRoot, version });
}

main().catch((err) => {
  console.error('Failed to start OpenLobby server:', err);
  process.exit(1);
});

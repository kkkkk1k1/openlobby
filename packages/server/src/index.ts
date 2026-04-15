import cluster from 'node:cluster';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { AgentAdapter } from '@openlobby/core';
import { SessionManager } from './session-manager.js';
import { detectTerminal } from './terminal-detector.js';
import { handleWebSocket } from './ws-handler.js';
import { initDb, getAllProviders, getAllAdapterPlugins } from './db.js';
import { createBuiltinAdapters, loadAdapterPlugin } from './adapters/index.js';
import { registerUploadRoute } from './upload.js';
import { startMcpApi } from './mcp-api.js';
import { LobbyManager } from './lobby-manager.js';
import { ChannelRouterImpl } from './channel-router.js';
import { createProvider } from './channels/index.js';
import { PtyManager } from './pty-manager.js';
import { VersionChecker } from './version-checker.js';

export interface ServerOptions {
  port?: number;
  mcpApiPort?: number;
  webRoot?: string;
  version?: string;
}

declare const __OPENLOBBY_NO_AUTORUN__: boolean | undefined;

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Send an IPC message to the wrapper process, ignoring errors if the channel is already closed. */
function safeSend(msg: unknown): void {
  try {
    process.send?.(msg);
  } catch {
    // IPC channel may already be closed during restart — safe to ignore
  }
}

export async function createServer(options: ServerOptions = {}) {
  const port = options.port ?? parseInt(process.env.PORT ?? '3001', 10);
  const mcpApiPort = options.mcpApiPort ?? (parseInt(process.env.OPENLOBBY_MCP_PORT ?? '', 10) || (port + 1));
  const app = Fastify({ logger: true });

  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Initialize SQLite — sessions from previous runs remain with their last status
  // They will be lazily resumed when the user sends a message
  const db = initDb();

  // Version checker for update detection
  const versionChecker = new VersionChecker(options.version ?? '0.0.0');
  let updateInProgress = false;

  // Initialize adapters: built-in + plugins from DB
  const allAdapters = new Map<string, AgentAdapter>();

  // Built-in adapters
  for (const adapter of createBuiltinAdapters()) {
    const detection = await adapter.detect();
    if (detection.installed) {
      console.log(`${adapter.displayName} detected: ${detection.version} at ${detection.path}`);
      allAdapters.set(adapter.name, adapter);
    } else {
      console.warn(`${adapter.displayName} not found.`);
    }
  }

  // Plugin adapters from DB
  const pluginRows = getAllAdapterPlugins(db);
  for (const row of pluginRows) {
    if (!row.enabled) continue;
    try {
      const adapter = await loadAdapterPlugin(row.name);
      const detection = await adapter.detect();
      if (detection.installed) {
        console.log(`[Plugin] ${adapter.displayName} detected: ${detection.version}`);
        allAdapters.set(adapter.name, adapter);
      } else {
        console.warn(`[Plugin] ${adapter.displayName} CLI not installed`);
      }
    } catch (err) {
      console.error(`[Plugin] Failed to load adapter "${row.name}":`, err);
    }
  }

  const terminal = detectTerminal();
  console.log(`Detected terminal: ${terminal.name} (${terminal.id}, available: ${terminal.available})`);

  // Initialize session manager with SQLite
  const sessionManager = new SessionManager(db);
  for (const adapter of allAdapters.values()) {
    sessionManager.registerAdapter(adapter);
  }

  // Start MCP internal API on separate port (channelRouter injected below)
  const mcpApi = await startMcpApi(sessionManager, mcpApiPort, versionChecker, () => {
    if (updateInProgress) return { status: 'already-updating' };
    const installMode = versionChecker.getInstallMode();
    if (installMode === 'npx') return { status: 'npx-hint', message: 'Running via npx. Latest version used automatically next time.' };
    updateInProgress = true;
    safeSend({ type: 'update-and-restart' });
    return { status: 'updating' };
  });

  // Initialize Lobby Manager
  const lobbyManager = new LobbyManager(sessionManager, allAdapters, mcpApiPort, db);
  await lobbyManager.init();

  // Initialize PTY Manager
  const ptyManager = new PtyManager();

  // Initialize Channel Router and inject into MCP API
  const channelRouter = new ChannelRouterImpl(sessionManager, lobbyManager, db);
  mcpApi.setChannelRouter(channelRouter);

  // Load configured channel providers from DB and start them
  const providerRows = getAllProviders(db);
  for (const row of providerRows) {
    if (!row.enabled) continue;
    try {
      const config = JSON.parse(row.config_json);
      const provider = await createProvider(config);
      await channelRouter.registerProvider(provider);
      // Register webhook routes if any
      const handlers = provider.getWebhookHandlers?.() ?? [];
      for (const h of handlers) {
        app.route({
          method: h.method,
          url: h.path,
          handler: h.handler as Parameters<typeof app.route>[0]['handler'],
        });
      }
    } catch (err) {
      console.error(`[Channel] Failed to start provider ${row.id}:`, err);
    }
  }

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    adapters: Object.fromEntries(
      Array.from(allAdapters.keys()).map((name) => [name, true]),
    ),
    lobbyManager: lobbyManager.isAvailable(),
    channelProviders: channelRouter.listProviders(),
  }));

  // Debug endpoint for channel provider logs
  app.get('/debug/channel-logs', async () => {
    const logs: Record<string, string[]> = {};
    for (const info of channelRouter.listProviders()) {
      const provider = (channelRouter as any).providers.get(info.id);
      if (provider?.debugLogs) {
        logs[info.id] = provider.debugLogs;
      }
    }
    return logs;
  });

  // Version check endpoint (polled by frontend)
  app.get('/api/version', async () => {
    return versionChecker.check();
  });

  // Update trigger endpoint
  app.post('/api/update', async (_request, reply) => {
    if (updateInProgress) {
      return reply.send({ status: 'already-updating' });
    }

    // pm2 cluster mode: IPC channel goes to pm2 master, not our wrapper
    if (cluster.isWorker) {
      return reply.send({
        status: 'error',
        message: 'Running in cluster mode. Please use your process manager (e.g. pm2 restart) to apply updates.',
      });
    }

    const installMode = versionChecker.getInstallMode();
    if (installMode === 'npx') {
      return reply.send({
        status: 'npx-hint',
        message: 'You are running via npx. The latest version will be used automatically next time you run npx openlobby.',
      });
    }

    // Check write permission to global node_modules
    try {
      const { execSync } = await import('node:child_process');
      const globalPrefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
      const { accessSync, constants } = await import('node:fs');
      accessSync(globalPrefix, constants.W_OK);
    } catch {
      return reply.send({
        status: 'error',
        message: 'Permission denied. Please run: sudo npm install -g openlobby@latest',
      });
    }

    updateInProgress = true;
    safeSend({ type: 'update-and-restart' });
    return reply.send({ status: 'updating' });
  });

  // Listen for update failure from wrapper
  process.on('message', (msg: any) => {
    if (msg?.type === 'update-failed') {
      updateInProgress = false;
    }
  });

  // File upload and serving
  await registerUploadRoute(app);

  // Serve uploaded files (only from .openlobby-cache directories)
  app.get('/api/file', async (request, reply) => {
    const filePath = (request.query as { path?: string }).path;
    if (!filePath || !filePath.includes('.openlobby-cache')) {
      return reply.status(403).send({ error: 'Access denied' });
    }
    const { existsSync, createReadStream } = await import('node:fs');
    const { extname } = await import('node:path');
    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: 'File not found' });
    }
    const ext = extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
      '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.pdf': 'application/pdf',
    };
    const contentType = mimeTypes[ext] ?? 'application/octet-stream';
    reply.header('Content-Type', contentType);
    return reply.send(createReadStream(filePath));
  });

  // WebSocket endpoint
  app.get('/ws', { websocket: true }, (socket) => {
    handleWebSocket(socket, sessionManager, lobbyManager, channelRouter, ptyManager);
  });

  // Serve web frontend static files if available
  const webRoot = options.webRoot ?? join(__dirname, '..', '..', 'web', 'dist');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      wildcard: false,
    });
    // SPA fallback: serve index.html for unmatched routes
    app.setNotFoundHandler((_req, reply) => {
      return reply.sendFile('index.html');
    });
    console.log(`Serving web UI from ${webRoot}`);
  }

  await app.listen({ port, host: '0.0.0.0' });
  console.log(`OpenLobby server running on http://localhost:${port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Shutting down OpenLobby server (${signal})...`);
    try {
      ptyManager.dispose();
      await Promise.allSettled([
        app.close(),
        mcpApi.close(),
      ]);
    } finally {
      process.exit(0);
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // Notify wrapper that server is ready
  safeSend({ type: 'ready' });

  return { app, versionChecker, triggerUpdate: () => {
    if (updateInProgress) return { status: 'already-updating' as const };
    const installMode = versionChecker.getInstallMode();
    if (installMode === 'npx') return { status: 'npx-hint' as const, message: 'Running via npx. Latest version used automatically next time.' };
    updateInProgress = true;
    safeSend({ type: 'update-and-restart' });
    return { status: 'updating' as const };
  }};
}

// Run directly if this file is the entry point.
// `tsx` sets `import.meta.main`, while plain Node runs still work via argv fallback.
const isDirectRun = (() => {
  if (typeof __OPENLOBBY_NO_AUTORUN__ !== 'undefined' && __OPENLOBBY_NO_AUTORUN__) {
    return false;
  }
  const meta = import.meta as ImportMeta & { main?: boolean };
  if (typeof meta.main === 'boolean') return meta.main;
  return !!process.argv[1] && (
    process.argv[1].endsWith('/server/dist/index.js') ||
    process.argv[1].endsWith('/server/src/index.ts')
  );
})();
if (isDirectRun) {
  createServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

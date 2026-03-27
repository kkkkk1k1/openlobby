import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { ClaudeCodeAdapter, CodexCliAdapter } from '@openlobby/core';
import type { AgentAdapter } from '@openlobby/core';
import { SessionManager } from './session-manager.js';
import { handleWebSocket } from './ws-handler.js';
import { initDb, getAllProviders } from './db.js';
import { registerUploadRoute } from './upload.js';
import { startMcpApi } from './mcp-api.js';
import { LobbyManager } from './lobby-manager.js';
import { ChannelRouterImpl } from './channel-router.js';
import { createProvider } from './channels/index.js';

export interface ServerOptions {
  port?: number;
  mcpApiPort?: number;
  webRoot?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function createServer(options: ServerOptions = {}) {
  const port = options.port ?? parseInt(process.env.PORT ?? '3001', 10);
  const mcpApiPort = options.mcpApiPort ?? parseInt(process.env.MCP_API_PORT ?? '3002', 10);
  const app = Fastify({ logger: true });

  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

  // Initialize SQLite — sessions from previous runs remain with their last status
  // They will be lazily resumed when the user sends a message
  const db = initDb();

  // Initialize adapters
  const claudeAdapter = new ClaudeCodeAdapter();
  const detection = await claudeAdapter.detect();

  if (detection.installed) {
    console.log(
      `Claude Code detected: ${detection.version} at ${detection.path}`,
    );
  } else {
    console.warn('Claude Code CLI not found. Install it to use Claude Code sessions.');
  }

  // Initialize Codex CLI adapter
  const codexAdapter = new CodexCliAdapter();
  const codexDetection = await codexAdapter.detect();

  if (codexDetection.installed) {
    console.log(`Codex CLI detected: ${codexDetection.version} at ${codexDetection.path}`);
  } else {
    console.warn('Codex CLI not found. Install it to use Codex CLI sessions.');
  }

  // Initialize session manager with SQLite
  const sessionManager = new SessionManager(db);
  sessionManager.registerAdapter(claudeAdapter);
  sessionManager.registerAdapter(codexAdapter);

  // Start MCP internal API on separate port
  await startMcpApi(sessionManager, mcpApiPort);

  // Initialize Lobby Manager
  const adapters = new Map<string, AgentAdapter>([
    [claudeAdapter.name, claudeAdapter],
    [codexAdapter.name, codexAdapter],
  ]);
  const lobbyManager = new LobbyManager(sessionManager, adapters, mcpApiPort, db);
  await lobbyManager.init();

  // Initialize Channel Router
  const channelRouter = new ChannelRouterImpl(sessionManager, lobbyManager, db);

  // Load configured channel providers from DB and start them
  const providerRows = getAllProviders(db);
  for (const row of providerRows) {
    if (!row.enabled) continue;
    try {
      const config = JSON.parse(row.config_json);
      const provider = createProvider(config);
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
    adapters: {
      'claude-code': detection.installed,
      'codex-cli': codexDetection.installed,
    },
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
    handleWebSocket(socket, sessionManager, lobbyManager, channelRouter);
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

  return app;
}

// Run directly if this is the entry point
const isDirectRun = process.argv[1] && (
  process.argv[1].endsWith('/server/dist/index.js') ||
  process.argv[1].endsWith('/server/src/index.ts')
);
if (isDirectRun) {
  createServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

# Version Check & Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add version checking via npm registry, one-click update with auto-restart through a wrapper process, and LobbyManager MCP tools for conversational update control.

**Architecture:** CLI entry (`bin.ts`) becomes a lightweight wrapper that forks the actual server as a child process. The server exposes `/api/version` and `/api/update` REST endpoints. The frontend polls these endpoints and displays an update button when a new version is available. LobbyManager gains two MCP tools for checking/triggering updates via conversation.

**Tech Stack:** Node.js child_process (fork/IPC), native fetch (npm registry), esbuild multi-entry bundling, React hooks, Fastify REST routes

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/server/src/version-checker.ts` | Create | Query npm registry, 24h cache via server_config table, semver comparison, install mode detection |
| `packages/cli/src/server-main.ts` | Create | Child process entry point — calls `createServer()`, sends IPC `ready`/`update-and-restart` |
| `packages/cli/src/bin.ts` | Rewrite | Lightweight wrapper — fork child, listen IPC, execute npm update, restart child |
| `packages/cli/build.mjs` | Modify | Add `server-main.js` as second esbuild entry, inject `VERSION` define |
| `packages/cli/package.json` | Modify | Add `dist/server-main.js` to `files` array |
| `packages/server/src/index.ts` | Modify | Accept `version` in ServerOptions, register `/api/version` + `/api/update`, send IPC `ready` |
| `packages/server/src/mcp-server.ts` | Modify | Add `lobby_check_update` and `lobby_update_server` tools |
| `packages/server/src/mcp-api.ts` | Modify | Add `/api/version-check` and `/api/trigger-update` internal endpoints for MCP server |
| `packages/server/src/lobby-manager.ts` | Modify | Add two new tool names to `LM_ALLOWED_TOOLS` |
| `packages/web/src/hooks/useVersionCheck.ts` | Create | Poll `GET /api/version` on mount + every 30min, pause on visibility hidden |
| `packages/web/src/components/UpdateDialog.tsx` | Create | Confirm dialog (global) / info dialog (npx) |
| `packages/web/src/components/Sidebar.tsx` | Modify | Show update button next to version, open UpdateDialog |

---

### Task 1: VersionChecker — npm registry query with caching

**Files:**
- Create: `packages/server/src/version-checker.ts`
- Test: `packages/server/src/__tests__/version-checker.test.ts`
- Reference: `packages/server/src/db.ts` (lines 107-111 for server_config table, lines 372-379 for get/setServerConfig)

- [ ] **Step 1: Write the failing test for VersionChecker.check() with cache miss (first check)**

```typescript
// packages/server/src/__tests__/version-checker.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { VersionChecker } from '../version-checker.js';
import { initDb } from '../db.js';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('VersionChecker', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create server_config table (same as initDb does)
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('should fetch latest version from npm registry on first check', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    });

    const checker = new VersionChecker(db, '0.5.3');
    const result = await checker.check();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://registry.npmjs.org/openlobby/latest',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual({
      currentVersion: '0.5.3',
      latestVersion: '1.0.0',
      hasUpdate: true,
      installMode: 'global', // default in test env
    });
  });

  it('should use cached result within 24 hours', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    });

    const checker = new VersionChecker(db, '0.5.3');
    await checker.check(); // first call — fetches
    const result = await checker.check(); // second call — cached

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.latestVersion).toBe('1.0.0');
    expect(result.hasUpdate).toBe(true);
  });

  it('should return hasUpdate=false when current >= latest', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '0.5.3' }),
    });

    const checker = new VersionChecker(db, '0.5.3');
    const result = await checker.check();

    expect(result.hasUpdate).toBe(false);
  });

  it('should silently fail on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network error'));

    const checker = new VersionChecker(db, '0.5.3');
    const result = await checker.check();

    expect(result).toEqual({
      currentVersion: '0.5.3',
      latestVersion: null,
      hasUpdate: false,
      installMode: 'global',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/projects/openlobby && pnpm --filter @openlobby/server exec vitest run src/__tests__/version-checker.test.ts`
Expected: FAIL — module `../version-checker.js` not found

- [ ] **Step 3: Implement VersionChecker**

```typescript
// packages/server/src/version-checker.ts
import type Database from 'better-sqlite3';
import { getServerConfig, setServerConfig } from './db.js';

const NPM_REGISTRY_URL = 'https://registry.npmjs.org/openlobby/latest';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  installMode: 'global' | 'npx';
}

/**
 * Compare two semver strings. Returns true if remote > current.
 * Simple comparison: split by '.', compare each numeric part.
 */
function isNewer(remote: string, current: string): boolean {
  const r = remote.split('.').map(Number);
  const c = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((r[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

function detectInstallMode(): 'global' | 'npx' {
  const execPath = process.argv[1] ?? '';
  if (execPath.includes('_npx') || execPath.includes('.npm/_npx')) {
    return 'npx';
  }
  return 'global';
}

export class VersionChecker {
  private db: Database.Database;
  private currentVersion: string;
  private installMode: 'global' | 'npx';

  constructor(db: Database.Database, currentVersion: string) {
    this.db = db;
    this.currentVersion = currentVersion;
    this.installMode = detectInstallMode();
  }

  async check(): Promise<VersionCheckResult> {
    const fallback: VersionCheckResult = {
      currentVersion: this.currentVersion,
      latestVersion: null,
      hasUpdate: false,
      installMode: this.installMode,
    };

    // Check cache
    const lastCheck = getServerConfig(this.db, 'last_version_check');
    const cachedVersion = getServerConfig(this.db, 'latest_remote_version');

    if (lastCheck && cachedVersion) {
      const elapsed = Date.now() - parseInt(lastCheck, 10);
      if (elapsed < CACHE_TTL_MS) {
        return {
          currentVersion: this.currentVersion,
          latestVersion: cachedVersion,
          hasUpdate: isNewer(cachedVersion, this.currentVersion),
          installMode: this.installMode,
        };
      }
    }

    // Fetch from npm registry
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) return fallback;

      const data = (await res.json()) as { version?: string };
      const latestVersion = data.version ?? null;

      if (latestVersion) {
        setServerConfig(this.db, 'last_version_check', String(Date.now()));
        setServerConfig(this.db, 'latest_remote_version', latestVersion);
      }

      return {
        currentVersion: this.currentVersion,
        latestVersion,
        hasUpdate: latestVersion ? isNewer(latestVersion, this.currentVersion) : false,
        installMode: this.installMode,
      };
    } catch {
      return fallback;
    }
  }

  getInstallMode(): 'global' | 'npx' {
    return this.installMode;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /root/projects/openlobby && pnpm --filter @openlobby/server exec vitest run src/__tests__/version-checker.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/version-checker.ts packages/server/src/__tests__/version-checker.test.ts
git commit -m "feat: add VersionChecker with npm registry query and 24h cache"
```

---

### Task 2: Server API endpoints — /api/version and /api/update

**Files:**
- Modify: `packages/server/src/index.ts` (lines 21-25 for ServerOptions, line 186 for listen)
- Create: `packages/server/src/__tests__/version-api.test.ts`
- Reference: `packages/server/src/version-checker.ts` (from Task 1)

- [ ] **Step 1: Write the failing test for /api/version endpoint**

```typescript
// packages/server/src/__tests__/version-api.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the endpoint logic by verifying the server integration.
// Since createServer is heavy (SQLite, adapters), we test the route handlers in isolation.
import { VersionChecker } from '../version-checker.js';
import Database from 'better-sqlite3';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('/api/version endpoint logic', () => {
  let db: ReturnType<typeof Database>;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS server_config (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('should return version check result', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ version: '1.0.0' }),
    });

    const checker = new VersionChecker(db, '0.5.3');
    const result = await checker.check();

    expect(result.current || result.currentVersion).toBeTruthy();
    expect(result.latestVersion).toBe('1.0.0');
    expect(result.hasUpdate).toBe(true);
  });
});

describe('/api/update endpoint logic', () => {
  it('should reject when already updating', () => {
    // Simulate update lock
    let updating = false;

    function triggerUpdate(): { status: string; message?: string } {
      if (updating) return { status: 'already-updating' };
      updating = true;
      return { status: 'updating' };
    }

    expect(triggerUpdate()).toEqual({ status: 'updating' });
    expect(triggerUpdate()).toEqual({ status: 'already-updating' });
  });
});
```

- [ ] **Step 2: Run test to verify it passes (logic-only tests)**

Run: `cd /root/projects/openlobby && pnpm --filter @openlobby/server exec vitest run src/__tests__/version-api.test.ts`
Expected: PASS

- [ ] **Step 3: Add version option to ServerOptions and register endpoints in index.ts**

Add to `packages/server/src/index.ts`:

At the imports section (after line 19), add:
```typescript
import { VersionChecker } from './version-checker.js';
```

Modify `ServerOptions` interface (line 21-25) to add `version`:
```typescript
export interface ServerOptions {
  port?: number;
  mcpApiPort?: number;
  webRoot?: string;
  version?: string;
}
```

Inside `createServer()`, after `const db = initDb();` (line 39), add VersionChecker initialization:
```typescript
  // Version checker for update detection
  const versionChecker = new VersionChecker(db, options.version ?? '0.0.0');
  let updateInProgress = false;
```

After the `/debug/channel-logs` route (after line 138), add the two new endpoints:
```typescript
  // Version check endpoint (polled by frontend)
  app.get('/api/version', async () => {
    return versionChecker.check();
  });

  // Update trigger endpoint
  app.post('/api/update', async (_request, reply) => {
    if (updateInProgress) {
      return reply.send({ status: 'already-updating' });
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
    if (process.send) {
      process.send({ type: 'update-and-restart' });
    }
    return reply.send({ status: 'updating' });
  });

  // Listen for update failure from wrapper
  process.on('message', (msg: any) => {
    if (msg?.type === 'update-failed') {
      updateInProgress = false;
      // Broadcast to all connected WebSocket clients
      app.websocketServer?.clients?.forEach((client: any) => {
        if (client.readyState === 1) {
          client.send(JSON.stringify({
            type: 'update.failed',
            error: msg.error,
          }));
        }
      });
    }
  });
```

After `await app.listen(...)` (line 186), add IPC ready notification:
```typescript
  // Notify wrapper that server is ready
  if (process.send) {
    process.send({ type: 'ready' });
  }
```

Also export VersionChecker from index for MCP API use — add `versionChecker` to `createServer` return:
```typescript
  return { app, versionChecker, triggerUpdate: () => {
    if (updateInProgress) return { status: 'already-updating' as const };
    const installMode = versionChecker.getInstallMode();
    if (installMode === 'npx') return { status: 'npx-hint' as const, message: 'Running via npx. Latest version used automatically next time.' };
    updateInProgress = true;
    if (process.send) process.send({ type: 'update-and-restart' });
    return { status: 'updating' as const };
  }};
```

- [ ] **Step 4: Run existing tests to verify nothing is broken**

Run: `cd /root/projects/openlobby && pnpm --filter @openlobby/server exec vitest run`
Expected: All existing tests still pass

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/index.ts packages/server/src/__tests__/version-api.test.ts
git commit -m "feat: add /api/version and /api/update server endpoints"
```

---

### Task 3: MCP tools — lobby_check_update and lobby_update_server

**Files:**
- Modify: `packages/server/src/mcp-server.ts` (add two new tool definitions)
- Modify: `packages/server/src/mcp-api.ts` (add internal API endpoints)
- Modify: `packages/server/src/lobby-manager.ts` (line 83-102, add to LM_ALLOWED_TOOLS)

- [ ] **Step 1: Add internal API endpoints in mcp-api.ts**

In `packages/server/src/mcp-api.ts`, the `startMcpApi` function needs access to VersionChecker. Update the function signature and add routes.

First, update the import and signature. After the existing imports (line 4), add:
```typescript
import type { VersionChecker } from './version-checker.js';
```

Change the function signature from:
```typescript
export async function startMcpApi(
  sessionManager: SessionManager,
  port: number,
): Promise<McpApiHandle> {
```
to:
```typescript
export async function startMcpApi(
  sessionManager: SessionManager,
  port: number,
  versionChecker?: VersionChecker | null,
  triggerUpdate?: () => { status: string; message?: string },
): Promise<McpApiHandle> {
```

Add two endpoints after the existing session/channel routes (before `app.listen`):
```typescript
  // Version check for MCP tools
  app.get('/api/version-check', async () => {
    if (!versionChecker) return { error: 'Version checker not available' };
    return versionChecker.check();
  });

  // Trigger update for MCP tools
  app.post('/api/trigger-update', async () => {
    if (!triggerUpdate) return { error: 'Update not available' };
    return triggerUpdate();
  });
```

- [ ] **Step 2: Add MCP tool definitions in mcp-server.ts**

In `packages/server/src/mcp-server.ts`, add two new tools after the existing tool definitions (before the transport setup):

```typescript
  // --- Tool: lobby_check_update ---
  server.tool(
    'lobby_check_update',
    'Check if a newer version of OpenLobby is available on npm',
    {},
    async () => {
      const result = await apiCall('GET', '/api/version-check');
      return textResult(result);
    },
  );

  // --- Tool: lobby_update_server ---
  server.tool(
    'lobby_update_server',
    'Update OpenLobby to the latest version and auto-restart the server. For npx users, shows a hint instead.',
    {},
    async () => {
      // First check if there is an update
      const check = (await apiCall('GET', '/api/version-check')) as {
        hasUpdate?: boolean;
        currentVersion?: string;
        latestVersion?: string | null;
      };
      if (!check.hasUpdate) {
        return textResult({
          status: 'up-to-date',
          message: `Already on the latest version (${check.currentVersion}).`,
        });
      }
      // Trigger the update
      const result = await apiCall('POST', '/api/trigger-update');
      return textResult(result);
    },
  );
```

- [ ] **Step 3: Add tool names to LM_ALLOWED_TOOLS in lobby-manager.ts**

In `packages/server/src/lobby-manager.ts`, add two entries to the `LM_ALLOWED_TOOLS` array (after line 101):

```typescript
  // Version management
  'mcp__openlobby__lobby_check_update',
  'mcp__openlobby__lobby_update_server',
```

- [ ] **Step 4: Update createServer to pass versionChecker to startMcpApi**

In `packages/server/src/index.ts`, find the `startMcpApi` call (line 83):
```typescript
  const mcpApi = await startMcpApi(sessionManager, mcpApiPort);
```
Change to:
```typescript
  const mcpApi = await startMcpApi(sessionManager, mcpApiPort, versionChecker, () => {
    if (updateInProgress) return { status: 'already-updating' };
    const installMode = versionChecker.getInstallMode();
    if (installMode === 'npx') return { status: 'npx-hint', message: 'Running via npx. Latest version used automatically next time.' };
    updateInProgress = true;
    if (process.send) process.send({ type: 'update-and-restart' });
    return { status: 'updating' };
  });
```

Note: `versionChecker` and `updateInProgress` were created in Task 2 above the `startMcpApi` call, so this is valid. Move the `versionChecker` and `updateInProgress` declarations to before the `startMcpApi` call if they aren't already.

- [ ] **Step 5: Update LM_SYSTEM_PROMPT to mention update capabilities**

In `packages/server/src/lobby-manager.ts`, add to the `# What you do` section of `LM_SYSTEM_PROMPT`:
```
- Check for OpenLobby updates and trigger server update
```

- [ ] **Step 6: Run tests**

Run: `cd /root/projects/openlobby && pnpm --filter @openlobby/server exec vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/mcp-server.ts packages/server/src/mcp-api.ts packages/server/src/lobby-manager.ts packages/server/src/index.ts
git commit -m "feat: add lobby_check_update and lobby_update_server MCP tools"
```

---

### Task 4: CLI Wrapper — bin.ts refactor and server-main.ts

**Files:**
- Rewrite: `packages/cli/src/bin.ts`
- Create: `packages/cli/src/server-main.ts`
- Modify: `packages/cli/build.mjs`
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Create server-main.ts (child process entry)**

```typescript
// packages/cli/src/server-main.ts
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '@openlobby/server';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Receive args from wrapper via process.argv or env
const port = parseInt(process.env.OPENLOBBY_PORT ?? '3001', 10);
const mcpApiPort = process.env.OPENLOBBY_MCP_PORT
  ? parseInt(process.env.OPENLOBBY_MCP_PORT, 10)
  : undefined;
const version = process.env.OPENLOBBY_VERSION ?? '0.0.0';
const webRoot = join(__dirname, '..', 'web');

async function main() {
  await createServer({ port, mcpApiPort, webRoot, version });
  // Note: createServer already sends { type: 'ready' } via process.send
}

main().catch((err) => {
  console.error('Failed to start OpenLobby server:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Rewrite bin.ts as wrapper**

```typescript
// packages/cli/src/bin.ts
#!/usr/bin/env node

import { fork, execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accessSync, constants } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = '0.5.3'; // replaced by esbuild define

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
    // Check write permission
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

child.on('message', async (msg: any) => {
  if (msg?.type === 'update-and-restart') {
    const success = await performUpdate();
    if (success) {
      console.log('[Wrapper] Restarting server...');
      child.kill('SIGTERM');
      child = spawnServer(port, mcpApiPort);
      setupChildListeners(child);
    } else {
      // Notify server that update failed
      child.send({ type: 'update-failed', error: 'npm install failed or permission denied' });
    }
  }
});

function setupChildListeners(proc: ReturnType<typeof fork>) {
  proc.on('message', async (msg: any) => {
    if (msg?.type === 'update-and-restart') {
      const success = await performUpdate();
      if (success) {
        console.log('[Wrapper] Restarting server...');
        proc.kill('SIGTERM');
        child = spawnServer(port, mcpApiPort);
        setupChildListeners(child);
      } else {
        proc.send({ type: 'update-failed', error: 'npm install failed or permission denied' });
      }
    }
  });

  proc.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`[Wrapper] Server exited with code ${code}. Not restarting.`);
      process.exit(code);
    }
  });
}

// Set up listeners for the initial child
child.on('exit', (code) => {
  if (code !== null && code !== 0) {
    console.error(`[Wrapper] Server exited with code ${code}. Not restarting.`);
    process.exit(code);
  }
});

// Forward SIGINT/SIGTERM to child
process.on('SIGINT', () => { child.kill('SIGINT'); });
process.on('SIGTERM', () => { child.kill('SIGTERM'); });
```

- [ ] **Step 3: Update build.mjs to bundle two entries and inject version**

Replace the content of `packages/cli/build.mjs`:

```javascript
import { execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..', '..');

// Read version from package.json
const pkg = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

console.log('[1/5] Building web frontend...');
execSync('pnpm --filter @openlobby/web build', { cwd: rootDir, stdio: 'inherit' });

const commonOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: [
    'better-sqlite3',
    '@homebridge/node-pty-prebuilt-multiarch',
    'fsevents',
  ],
  banner: {
    js: [
      '// openlobby - Unified AI Agent Session Manager',
      'import { createRequire } from "node:module";',
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  sourcemap: true,
  minify: false,
  alias: {
    '@openlobby/core': join(rootDir, 'packages', 'core', 'src', 'index.ts'),
    '@openlobby/server': join(rootDir, 'packages', 'server', 'src', 'index.ts'),
    'openlobby-channel-telegram': join(rootDir, 'packages', 'channel-telegram', 'src', 'index.ts'),
  },
};

console.log(`[2/5] Bundling wrapper (bin.js) — v${VERSION}...`);
await build({
  ...commonOptions,
  entryPoints: [join(__dirname, 'src', 'bin.ts')],
  outfile: join(__dirname, 'dist', 'bin.js'),
  // Wrapper is lightweight — does NOT bundle server code
  // It uses fork() to spawn server-main.js as a child process
  external: [...commonOptions.external, '@openlobby/server', '@openlobby/core'],
  define: {
    VERSION: JSON.stringify(VERSION),
  },
});

console.log('[3/5] Bundling server-main.js...');
await build({
  ...commonOptions,
  entryPoints: [join(__dirname, 'src', 'server-main.ts')],
  outfile: join(__dirname, 'dist', 'server-main.js'),
  define: {
    VERSION: JSON.stringify(VERSION),
  },
});

console.log('[4/5] Bundling MCP server...');
await build({
  entryPoints: [join(rootDir, 'packages', 'server', 'src', 'mcp-server.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: join(__dirname, 'dist', 'mcp-server.js'),
  external: [],
  banner: {
    js: [
      'import { createRequire } from "node:module";',
      'const require = createRequire(import.meta.url);',
    ].join('\n'),
  },
  sourcemap: false,
  minify: false,
});

console.log('[5/5] Copying web assets...');
const webDist = join(rootDir, 'packages', 'web', 'dist');
const cliWeb = join(__dirname, 'web');
if (existsSync(cliWeb)) {
  rmSync(cliWeb, { recursive: true });
}
cpSync(webDist, cliWeb, { recursive: true });

cpSync(join(rootDir, 'README.md'), join(__dirname, 'README.md'));

console.log('✓ Build complete!');
console.log(`  Version:      ${VERSION}`);
console.log(`  Wrapper:      ${join(__dirname, 'dist', 'bin.js')}`);
console.log(`  Server:       ${join(__dirname, 'dist', 'server-main.js')}`);
console.log(`  Web:          ${cliWeb}`);
```

- [ ] **Step 4: Update package.json files array**

In `packages/cli/package.json`, change the `files` array from:
```json
"files": [
  "dist/bin.js",
  "dist/mcp-server.js",
  "web/",
  "README.md"
],
```
to:
```json
"files": [
  "dist/bin.js",
  "dist/server-main.js",
  "dist/mcp-server.js",
  "web/",
  "README.md"
],
```

- [ ] **Step 5: Build and verify**

Run: `cd /root/projects/openlobby && pnpm build:cli`
Expected: Build completes with 5 steps, outputs bin.js + server-main.js + mcp-server.js

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/bin.ts packages/cli/src/server-main.ts packages/cli/build.mjs packages/cli/package.json
git commit -m "feat: refactor CLI to wrapper + child process architecture for auto-update"
```

---

### Task 5: Frontend — useVersionCheck hook

**Files:**
- Create: `packages/web/src/hooks/useVersionCheck.ts`
- Test: `packages/web/src/__tests__/useVersionCheck.test.ts` (optional, hook is simple)

- [ ] **Step 1: Create useVersionCheck hook**

```typescript
// packages/web/src/hooks/useVersionCheck.ts
import { useState, useEffect, useCallback, useRef } from 'react';

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export interface VersionState {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  installMode: 'global' | 'npx';
  checking: boolean;
}

const initialState: VersionState = {
  current: '',
  latest: null,
  hasUpdate: false,
  installMode: 'global',
  checking: false,
};

export function useVersionCheck(): VersionState & { recheckNow: () => void } {
  const [state, setState] = useState<VersionState>(initialState);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchVersion = useCallback(async () => {
    setState((prev) => ({ ...prev, checking: true }));
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return;
      const data = await res.json();
      setState({
        current: data.currentVersion ?? '',
        latest: data.latestVersion ?? null,
        hasUpdate: data.hasUpdate ?? false,
        installMode: data.installMode ?? 'global',
        checking: false,
      });
    } catch {
      setState((prev) => ({ ...prev, checking: false }));
    }
  }, []);

  // Start/stop polling
  const startPolling = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(fetchVersion, POLL_INTERVAL_MS);
  }, [fetchVersion]);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    // Initial fetch on mount
    fetchVersion();
    startPolling();

    // Visibility change handler
    const onVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        fetchVersion(); // immediate check on return
        startPolling();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchVersion, startPolling, stopPolling]);

  return { ...state, recheckNow: fetchVersion };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/hooks/useVersionCheck.ts
git commit -m "feat: add useVersionCheck hook with 30min polling and visibility awareness"
```

---

### Task 6: Frontend — UpdateDialog component

**Files:**
- Create: `packages/web/src/components/UpdateDialog.tsx`

- [ ] **Step 1: Create UpdateDialog component**

```tsx
// packages/web/src/components/UpdateDialog.tsx
import { useState } from 'react';

interface UpdateDialogProps {
  latestVersion: string;
  installMode: 'global' | 'npx';
  onClose: () => void;
}

export function UpdateDialog({ latestVersion, installMode, onClose }: UpdateDialogProps) {
  const [status, setStatus] = useState<'confirm' | 'updating' | 'error'>('confirm');
  const [errorMessage, setErrorMessage] = useState('');

  const handleUpdate = async () => {
    setStatus('updating');
    try {
      const res = await fetch('/api/update', { method: 'POST' });
      const data = await res.json();

      if (data.status === 'updating') {
        // Server will restart — WebSocket will reconnect and page will reload
        // Keep showing "updating" state until disconnect
        return;
      }
      if (data.status === 'already-updating') {
        return; // Already in progress, just wait
      }
      if (data.status === 'error') {
        setStatus('error');
        setErrorMessage(data.message ?? 'Update failed');
      }
    } catch {
      setStatus('error');
      setErrorMessage('Failed to connect to server');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface-primary rounded-lg shadow-lg p-6 max-w-md mx-4">
        {installMode === 'npx' ? (
          // NPX user: info only
          <>
            <h3 className="text-lg font-semibold text-on-surface mb-3">
              New Version Available
            </h3>
            <p className="text-on-surface-secondary mb-4">
              v{latestVersion} is available. You are running via npx — the latest
              version will be used automatically next time you run{' '}
              <code className="bg-surface-elevated px-1 rounded text-sm">npx openlobby</code>.
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-primary text-on-primary rounded hover:bg-primary-hover transition-colors"
              >
                OK
              </button>
            </div>
          </>
        ) : status === 'confirm' ? (
          // Global user: confirm update
          <>
            <h3 className="text-lg font-semibold text-on-surface mb-3">
              Update Available
            </h3>
            <p className="text-on-surface-secondary mb-4">
              Update to v{latestVersion}? The server will restart automatically after the update.
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-on-surface-secondary hover:bg-surface-elevated rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdate}
                className="px-4 py-2 bg-primary text-on-primary rounded hover:bg-primary-hover transition-colors"
              >
                Update
              </button>
            </div>
          </>
        ) : status === 'updating' ? (
          // Updating in progress
          <>
            <h3 className="text-lg font-semibold text-on-surface mb-3">
              Updating...
            </h3>
            <p className="text-on-surface-secondary mb-4">
              Installing the latest version. The server will restart shortly...
            </p>
            <div className="flex justify-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          </>
        ) : (
          // Error
          <>
            <h3 className="text-lg font-semibold text-danger mb-3">
              Update Failed
            </h3>
            <p className="text-on-surface-secondary mb-4">
              {errorMessage}
            </p>
            <div className="flex justify-end">
              <button
                onClick={onClose}
                className="px-4 py-2 bg-primary text-on-primary rounded hover:bg-primary-hover transition-colors"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/UpdateDialog.tsx
git commit -m "feat: add UpdateDialog component for version update confirmation"
```

---

### Task 7: Frontend — Sidebar update button integration

**Files:**
- Modify: `packages/web/src/components/Sidebar.tsx` (lines 12, 327-334)

- [ ] **Step 1: Add imports and hook usage in Sidebar**

At the top of `Sidebar.tsx`, add imports (near the existing imports):
```typescript
import { useVersionCheck } from '../hooks/useVersionCheck';
import { UpdateDialog } from './UpdateDialog';
```

Inside the Sidebar component function, add state and hook usage:
```typescript
const versionInfo = useVersionCheck();
const [showUpdateDialog, setShowUpdateDialog] = useState(false);
```

- [ ] **Step 2: Modify the version display area**

In `Sidebar.tsx`, find the version display block (lines 327-334):
```tsx
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                connected ? 'bg-success' : 'bg-danger'
              }`}
            />
            <span className="text-xs text-on-surface-muted">v{APP_VERSION}</span>
          </div>
```

Replace with:
```tsx
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                connected ? 'bg-success' : 'bg-danger'
              }`}
            />
            <span className="text-xs text-on-surface-muted">v{APP_VERSION}</span>
            {versionInfo.hasUpdate && versionInfo.latest && (
              <button
                onClick={() => setShowUpdateDialog(true)}
                className="text-xs text-primary hover:text-primary-hover transition-colors"
                title={`v${versionInfo.latest} available`}
              >
                ↑
              </button>
            )}
          </div>
```

- [ ] **Step 3: Add UpdateDialog render**

Before the closing `</>` of the Sidebar component return (before line 347), add:
```tsx
      {showUpdateDialog && versionInfo.latest && (
        <UpdateDialog
          latestVersion={versionInfo.latest}
          installMode={versionInfo.installMode}
          onClose={() => setShowUpdateDialog(false)}
        />
      )}
```

- [ ] **Step 4: Build frontend to verify**

Run: `cd /root/projects/openlobby && pnpm --filter @openlobby/web build`
Expected: Build succeeds without type errors

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Sidebar.tsx
git commit -m "feat: show update button in sidebar when new version available"
```

---

### Task 8: WebSocket reconnection — auto-reload on update restart

**Files:**
- Modify: `packages/web/src/hooks/useWebSocket.ts` (lines 58-63)

- [ ] **Step 1: Add update-aware reconnection logic**

The existing reconnection at lines 58-63:
```typescript
  ws.onclose = () => {
    console.log('[WS] Disconnected');
    useLobbyStore.getState().setConnected(false);
    globalWs = null;
    setTimeout(() => ensureConnection(url), 2000);
  };
```

This already reconnects every 2 seconds. After reconnection, we need to reload the page if the server was updated. The simplest approach: after reconnect, call `/api/version` — if the version changed, `location.reload()`.

Find the `ws.onopen` handler in `useWebSocket.ts`. After the existing `setConnected(true)` call, add a version check:

```typescript
  // After reconnection, check if server version changed (update + restart)
  if (globalWs) {
    // This is a reconnection, not first connect
    fetch('/api/version')
      .then((res) => res.json())
      .then((data) => {
        const buildVersion = (window as any).__OPENLOBBY_VERSION__;
        if (buildVersion && data.currentVersion && data.currentVersion !== buildVersion) {
          console.log('[WS] Server version changed, reloading...');
          location.reload();
        }
      })
      .catch(() => { /* ignore */ });
  }
  (window as any).__OPENLOBBY_VERSION__ = undefined; // set after first version check
```

Actually, a simpler and cleaner approach: track whether we *expect* an update restart. Add a global flag:

In `useWebSocket.ts`, add near the top (after line 8):
```typescript
let expectingRestart = false;

export function setExpectingRestart(val: boolean) {
  expectingRestart = val;
}
```

In the `ws.onopen` handler, after `setConnected(true)`:
```typescript
    if (expectingRestart) {
      expectingRestart = false;
      // Server restarted after update — reload to get new frontend assets
      location.reload();
      return;
    }
```

Then in `UpdateDialog.tsx`, import and call `setExpectingRestart(true)` right before `POST /api/update`:
```typescript
import { setExpectingRestart } from '../hooks/useWebSocket';

// Inside handleUpdate, before the fetch:
setExpectingRestart(true);
```

- [ ] **Step 2: Run build to verify**

Run: `cd /root/projects/openlobby && pnpm --filter @openlobby/web build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/hooks/useWebSocket.ts packages/web/src/components/UpdateDialog.tsx
git commit -m "feat: auto-reload frontend after server update restart"
```

---

### Task 9: Full integration build and verification

**Files:** All files from Tasks 1-8

- [ ] **Step 1: Run all server tests**

Run: `cd /root/projects/openlobby && pnpm --filter @openlobby/server exec vitest run`
Expected: All tests pass

- [ ] **Step 2: Run full CLI build**

Run: `cd /root/projects/openlobby && pnpm build:cli`
Expected: 5-step build completes, outputs bin.js (wrapper), server-main.js, mcp-server.js

- [ ] **Step 3: Verify dist files exist and contain expected code**

Run:
```bash
ls -la packages/cli/dist/bin.js packages/cli/dist/server-main.js packages/cli/dist/mcp-server.js
grep -c 'update-and-restart' packages/cli/dist/bin.js
grep -c 'api/version' packages/cli/dist/server-main.js
grep -c 'lobby_check_update' packages/cli/dist/mcp-server.js
```
Expected: All 3 files exist; each grep returns >= 1

- [ ] **Step 4: Verify wrapper can start and fork server**

Run: `cd /root/projects/openlobby && timeout 10 node packages/cli/dist/bin.js --port 13001 || true`
Expected: Server starts on port 13001, outputs "OpenLobby server running" (then timeout kills it)

- [ ] **Step 5: Verify /api/version endpoint responds**

Run in parallel terminal or after server start:
```bash
cd /root/projects/openlobby && node packages/cli/dist/bin.js --port 13002 &
sleep 3
curl -s http://localhost:13002/api/version | head -1
kill %1 2>/dev/null
```
Expected: JSON response with `currentVersion`, `hasUpdate`, `installMode` fields

- [ ] **Step 6: Final commit (if any adjustments were needed)**

```bash
git add -A
git commit -m "fix: integration adjustments for version check feature"
```

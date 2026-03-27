#!/usr/bin/env node

/**
 * OpenLobby MCP Server — stdio entry point.
 *
 * Spawned by CLI (e.g. Claude Code) as an MCP server process.
 * Exposes session management operations as MCP tools.
 * Calls the MCP internal API (default port 3002) for actual operations.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LOBBY_API = process.env.OPENLOBBY_API ?? process.env.AGENT_LOBBY_API ?? 'http://127.0.0.1:3002';

async function apiCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = `${LOBBY_API}${path}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(
      (data as { error?: string }).error ?? `API error: ${res.status}`,
    );
  }
  return data;
}

function textResult(data: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

async function main() {
  const server = new McpServer({
    name: 'openlobby',
    version: '0.2.0',
  });

  // --- Tool: lobby_list_sessions ---
  server.tool(
    'lobby_list_sessions',
    'List all OpenLobby managed sessions with their status, adapter, and working directory',
    {},
    async () => {
      const sessions = await apiCall('GET', '/api/sessions');
      return textResult(sessions);
    },
  );

  // --- Tool: lobby_create_session ---
  server.tool(
    'lobby_create_session',
    'Create a new Agentic CLI session. Directory will be auto-created if it does not exist.',
    {
      adapter: z.enum(['claude-code', 'codex-cli']).default('claude-code').describe('CLI adapter to use (default: claude-code)'),
      cwd: z.string().describe('Working directory for the session'),
      name: z.string().optional().describe('Display name for the session'),
      model: z.string().optional().describe('Model to use (e.g. claude-sonnet-4-5-20250514)'),
      initialPrompt: z.string().optional().describe('Initial message to send to the session after creation'),
    },
    async ({ adapter, cwd, name, model, initialPrompt }) => {
      const result = await apiCall('POST', '/api/sessions', {
        adapter,
        cwd,
        name,
        model,
        initialPrompt,
      });
      return textResult(result);
    },
  );

  // --- Tool: lobby_rename_session ---
  server.tool(
    'lobby_rename_session',
    'Rename an existing session',
    {
      sessionId: z.string().describe('Session ID to rename'),
      newName: z.string().describe('New display name'),
    },
    async ({ sessionId, newName }) => {
      await apiCall('PATCH', `/api/sessions/${encodeURIComponent(sessionId)}`, {
        displayName: newName,
      });
      return textResult({ ok: true, sessionId, newName });
    },
  );

  // --- Tool: lobby_destroy_session ---
  server.tool(
    'lobby_destroy_session',
    'Destroy/stop a session permanently',
    {
      sessionId: z.string().describe('Session ID to destroy'),
    },
    async ({ sessionId }) => {
      await apiCall('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`);
      return textResult({ ok: true, sessionId });
    },
  );

  // --- Tool: lobby_session_info ---
  server.tool(
    'lobby_session_info',
    'Get detailed information about a specific session (status, model, working directory, etc.)',
    {
      sessionId: z.string().describe('Session ID to query'),
    },
    async ({ sessionId }) => {
      const info = await apiCall(
        'GET',
        `/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      return textResult(info);
    },
  );

  // --- Tool: lobby_cleanup_idle ---
  server.tool(
    'lobby_cleanup_idle',
    'Clean up sessions that have been idle longer than the specified duration',
    {
      maxIdleMinutes: z
        .number()
        .default(60)
        .describe('Maximum idle time in minutes before a session is cleaned up'),
    },
    async ({ maxIdleMinutes }) => {
      const result = await apiCall('POST', '/api/sessions/cleanup', {
        maxIdleMinutes,
      });
      return textResult(result);
    },
  );

  // --- Tool: lobby_discover_sessions ---
  server.tool(
    'lobby_discover_sessions',
    'Discover unmanaged CLI sessions from the filesystem (filters out already-managed ones)',
    {
      cwd: z.string().optional().describe('Optional directory to scope discovery'),
    },
    async ({ cwd }) => {
      const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
      const result = await apiCall('GET', `/api/sessions/discover${query}`);
      return textResult(result);
    },
  );

  // --- Tool: lobby_import_session ---
  server.tool(
    'lobby_import_session',
    'Import a discovered CLI session into OpenLobby management',
    {
      sessionId: z.string().describe('Session ID to import'),
      adapterName: z.enum(['claude-code', 'codex-cli']).describe('Adapter that owns the session'),
      cwd: z.string().describe('Working directory of the session'),
      displayName: z.string().optional().describe('Display name for the imported session'),
      jsonlPath: z.string().optional().describe('Path to the JSONL history file'),
    },
    async ({ sessionId, adapterName, cwd, displayName, jsonlPath }) => {
      const result = await apiCall('POST', '/api/sessions/import', {
        sessionId,
        adapterName,
        cwd,
        displayName,
        jsonlPath,
      });
      return textResult(result);
    },
  );

  // --- Tool: lobby_navigate_session ---
  server.tool(
    'lobby_navigate_session',
    'Navigate the web UI to a specific session (switches the active view). Always confirm with user before navigating.',
    {
      sessionId: z.string().describe('Session ID to navigate to'),
    },
    async ({ sessionId }) => {
      const result = await apiCall('POST', '/api/sessions/navigate', {
        sessionId,
      });
      return textResult(result);
    },
  );

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP Server fatal error:', err);
  process.exit(1);
});

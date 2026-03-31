import type { WebSocket } from '@fastify/websocket';
import type { ClientMessage, ServerMessage, LobbyMessage, AdapterCommand } from '@openlobby/core';
import type { SessionManager } from './session-manager.js';
import type { LobbyManager } from './lobby-manager.js';
import type { ChannelRouterImpl } from './channel-router.js';
import { handleSlashCommand } from './slash-commands.js';
import { LM_WELCOME_TEXT } from './lm-welcome.js';
import { startWeComQrFlow } from './channels/wecom-qr.js';

export function handleWebSocket(
  socket: WebSocket,
  sessionManager: SessionManager,
  lobbyManager?: LobbyManager,
  channelRouter?: ChannelRouterImpl,
): void {
  const listenerId = Math.random().toString(36).slice(2);
  let activeQrAbort: AbortController | null = null;

  // Forward all session messages to this WebSocket client
  sessionManager.onMessage(
    listenerId,
    (sessionId: string, msg: LobbyMessage) => {
      if (msg.type === 'control') {
        const content = msg.content as Record<string, unknown>;
        send({
          type: 'control.request',
          sessionId,
          request: {
            requestId: content.requestId as string,
            sessionId,
            toolName: content.toolName as string,
            toolInput: content.toolInput as Record<string, unknown>,
            questions: content.questions as Array<{
              question: string;
              header: string;
              options: Array<{ label: string; description: string }>;
              multiSelect: boolean;
            }> | undefined,
          },
        });
      } else {
        send({ type: 'message', sessionId, message: msg });
      }
    },
  );

  // Forward session status updates to this client
  sessionManager.onSessionUpdate(listenerId, (session, previousId) => {
    send({ type: 'session.updated', session, previousId });
  });

  // Forward navigate events to this client
  sessionManager.onNavigate(listenerId, (sessionId) => {
    send({ type: 'session.navigate', sessionId });
  });

  // Forward commands updates to this client (fresh SDK results)
  sessionManager.onCommands(listenerId, (sessionId: string, commands: AdapterCommand[]) => {
    send({ type: 'completion.response', sessionId, commands, cached: false });
  });

  // Notify client of Lobby Manager availability and session ID
  const lmSessionIdForWelcome = lobbyManager?.getSessionId();
  send({
    type: 'lm.status',
    available: lobbyManager?.isAvailable() ?? false,
    sessionId: lmSessionIdForWelcome ?? undefined,
  });

  // Send adapter permission metadata so frontend can render native labels
  send({
    type: 'adapter.meta',
    meta: sessionManager.getAdapterPermissionMeta(),
  } as any);

  // Send adapter defaults
  send({
    type: 'adapter.defaults',
    defaults: sessionManager.getAdapterDefaults(),
  } as any);

  // Send welcome message to LM session on first WebSocket connection
  if (lmSessionIdForWelcome) {
    const welcomeMsg: LobbyMessage = {
      id: `welcome-${listenerId}`,
      sessionId: lmSessionIdForWelcome,
      timestamp: Date.now(),
      type: 'assistant',
      content: LM_WELCOME_TEXT,
    };
    send({ type: 'message', sessionId: lmSessionIdForWelcome, message: welcomeMsg });
  }

  socket.on('message', async (raw: Buffer | string) => {
    let data: ClientMessage;
    try {
      data = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send({ type: 'error', error: 'Invalid JSON' });
      return;
    }

    // Resolve stale session IDs (e.g., pre-migration UUIDs) to current IDs
    if ('sessionId' in data && typeof data.sessionId === 'string') {
      const resolved = sessionManager.resolveSession(data.sessionId);
      if (resolved && resolved.id !== data.sessionId) {
        (data as { sessionId: string }).sessionId = resolved.id;
      }
    }

    try {
      switch (data.type) {
        case 'session.create': {
          const session = await sessionManager.createSession(
            data.adapterName,
            data.options,
            data.displayName,
          );
          send({
            type: 'session.created',
            session: {
              id: session.id,
              adapterName: session.adapterName,
              displayName: session.displayName,
              status: session.status,
              lastActiveAt: session.lastActiveAt,
              messageCount: session.messageCount,
              model: session.model,
              cwd: session.cwd,
              origin: 'lobby',
              resumeCommand: '',
            },
          });
          break;
        }

        case 'message.send': {
          // Intercept slash commands for LM session — handle locally
          const lmId = lobbyManager?.getSessionId();
          if (lmId && data.sessionId === lmId && data.content.trim().startsWith('/')) {
            const result = await handleSlashCommand(data.content.trim(), {
              sessionManager,
              lmSessionId: lmId,
            });
            if (result) {
              // Send response as assistant message in the LM session
              const replyMsg: LobbyMessage = {
                id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                sessionId: lmId,
                timestamp: Date.now(),
                type: 'assistant',
                content: result.text,
              };
              send({ type: 'message', sessionId: lmId, message: replyMsg });

              // Handle side effects
              if (result.navigateSessionId) {
                sessionManager.broadcastNavigate(result.navigateSessionId);
              }
              if (result.destroyedSessionId) {
                channelRouter?.handleSessionDestroyed(result.destroyedSessionId);
                send({ type: 'session.destroyed', sessionId: result.destroyedSessionId });
              }
              break;
            }
            // null = unknown command, fall through to send as message
          }

          // Handle /stop in any session (not just LM)
          if (data.content.trim().toLowerCase() === '/stop') {
            await sessionManager.interruptSession(data.sessionId);
            const replyMsg: LobbyMessage = {
              id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              sessionId: data.sessionId,
              timestamp: Date.now(),
              type: 'assistant',
              content: '⏹ 已打断模型回复。',
            };
            send({ type: 'message', sessionId: data.sessionId, message: replyMsg });
            break;
          }

          // Handle /new in any session — rebuild CLI process
          if (data.content.trim().toLowerCase() === '/new') {
            try {
              await sessionManager.rebuildSession(data.sessionId);
              // Tell frontend to clear old messages — send fresh history with only the rebuild system message
              const freshMessages = sessionManager.getCachedMessages(data.sessionId);
              send({ type: 'session.history', sessionId: data.sessionId, messages: freshMessages });
            } catch (err) {
              const replyMsg: LobbyMessage = {
                id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                sessionId: data.sessionId,
                timestamp: Date.now(),
                type: 'system',
                content: `⚠️ 重建 CLI 会话失败: ${err instanceof Error ? err.message : String(err)}`,
              };
              send({ type: 'message', sessionId: data.sessionId, message: replyMsg });
            }
            break;
          }

          // Handle /msg-* in any session — switch message mode
          const msgModeMatch = data.content.trim().toLowerCase().match(/^\/msg-(only|tidy|total)$/);
          if (msgModeMatch) {
            const mode = `msg-${msgModeMatch[1]}` as import('@openlobby/core').MessageMode;
            try {
              sessionManager.configureSession(data.sessionId, { messageMode: mode } as any);
              const replyMsg: LobbyMessage = {
                id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                sessionId: data.sessionId,
                timestamp: Date.now(),
                type: 'system',
                content: `✅ 消息模式已切换为 \`${mode}\``,
              };
              send({ type: 'message', sessionId: data.sessionId, message: replyMsg });
            } catch (err) {
              send({ type: 'error', sessionId: data.sessionId, error: String(err) });
            }
            break;
          }

          channelRouter?.setMessageOrigin(data.sessionId, 'web');
          await sessionManager.sendMessage(data.sessionId, data.content);
          break;
        }

        case 'control.respond': {
          sessionManager.respondControl(
            data.sessionId,
            data.requestId,
            data.decision,
            (data as { payload?: Record<string, unknown> }).payload,
          );
          break;
        }

        case 'session.interrupt': {
          await sessionManager.interruptSession(data.sessionId);
          break;
        }

        case 'session.configure': {
          sessionManager.configureSession(data.sessionId, data.options);
          break;
        }

        case 'session.list': {
          send({
            type: 'session.list',
            sessions: sessionManager.listSessions(),
          });
          break;
        }

        case 'session.history': {
          let messages: import('@openlobby/core').LobbyMessage[] = [];
          const adapter = sessionManager.getAdapterForSession(data.sessionId);
          if (adapter) {
            messages = await adapter.readSessionHistory(data.sessionId);
          }
          // Fallback: use in-memory cache when adapter returns empty
          if (messages.length === 0) {
            messages = sessionManager.getCachedMessages(data.sessionId);
          }
          send({
            type: 'session.history',
            sessionId: data.sessionId,
            messages,
          });
          break;
        }

        case 'session.discover': {
          const discovered = await sessionManager.discoverSessions(data.cwd);
          send({ type: 'session.discovered', sessions: discovered });
          break;
        }

        case 'session.import': {
          const imported = sessionManager.importSession({
            sessionId: data.sessionId,
            adapterName: data.adapterName,
            displayName: data.displayName,
            cwd: data.cwd,
            jsonlPath: data.jsonlPath,
          });
          send({ type: 'session.created', session: imported });
          break;
        }

        case 'session.recover': {
          sessionManager.recoverSession(data.sessionId);
          break;
        }

        case 'session.view': {
          sessionManager.registerWebViewer(listenerId, data.sessionId ?? null);
          break;
        }

        case 'completion.request': {
          const reqSessionId = data.sessionId as string;
          // Return cached commands from SQLite if available
          const cached = sessionManager.getCachedCommands(reqSessionId);
          if (cached && cached.length > 0) {
            // Valid cache — send as definitive (no loading indicator)
            send({ type: 'completion.response', sessionId: reqSessionId, commands: cached, cached: false });
          } else {
            // No cache yet — return adapter fallback, mark as loading
            // (will auto-update when first SDK query runs on this session)
            const adapter = sessionManager.getAdapterForSession(reqSessionId);
            const fallback = adapter?.listCommands
              ? await adapter.listCommands()
              : [];
            send({ type: 'completion.response', sessionId: reqSessionId, commands: fallback, cached: true });
          }
          // When SDK query.supportedCommands() returns, it broadcasts via 'commands' event
          break;
        }

        case 'session.destroy': {
          await sessionManager.destroySession(data.sessionId);
          // Notify channel router about session destruction
          channelRouter?.handleSessionDestroyed(data.sessionId);
          send({ type: 'session.destroyed', sessionId: data.sessionId });
          break;
        }

        // ─── Channel Messages ───────────────────────────────

        case 'channel.discover-plugins': {
          const { discoverPlugins } = await import('./channels/plugin-discovery.js');
          const plugins = await discoverPlugins();
          socket.send(JSON.stringify({ type: 'channel.plugins-list', plugins }));
          break;
        }

        case 'channel.list-providers': {
          if (channelRouter) {
            send({ type: 'channel.providers-list', providers: channelRouter.listProviders() });
          }
          break;
        }

        case 'channel.add-provider': {
          if (channelRouter) {
            await channelRouter.addProviderConfig(data.config);
            send({ type: 'channel.providers-list', providers: channelRouter.listProviders() });
          }
          break;
        }

        case 'channel.remove-provider': {
          if (channelRouter) {
            await channelRouter.removeProviderConfig(data.providerId);
            send({ type: 'channel.providers-list', providers: channelRouter.listProviders() });
          }
          break;
        }

        case 'channel.toggle-provider': {
          if (channelRouter) {
            await channelRouter.toggleProviderConfig(data.providerId, data.enabled);
            send({ type: 'channel.providers-list', providers: channelRouter.listProviders() });
          }
          break;
        }

        case 'channel.list-bindings': {
          if (channelRouter) {
            send({ type: 'channel.bindings-list', bindings: channelRouter.listBindings() });
          }
          break;
        }

        case 'channel.bind': {
          if (channelRouter) {
            const result = channelRouter.bindSession(data.identityKey, data.target);
            if (result.ok) {
              send({ type: 'channel.bindings-list', bindings: channelRouter.listBindings() });
            } else {
              send({ type: 'error', error: result.error ?? 'Bind failed' });
            }
          }
          break;
        }

        case 'channel.unbind': {
          if (channelRouter) {
            channelRouter.unbindSession(data.identityKey);
            send({ type: 'channel.bindings-list', bindings: channelRouter.listBindings() });
          }
          break;
        }

        case 'config.get': {
          const { getServerConfig } = await import('./db.js');
          const configDb = (sessionManager as any).db as import('better-sqlite3').Database | null;
          if (configDb) {
            const key = (data as any).key as string;
            const value = getServerConfig(configDb, key) ?? '';
            send({ type: 'config.value', key, value } as any);
          }
          break;
        }

        case 'config.set': {
          const { setServerConfig } = await import('./db.js');
          const configDb2 = (sessionManager as any).db as import('better-sqlite3').Database | null;
          const cfgKey = (data as any).key as string;
          const cfgValue = (data as any).value as string;

          if (configDb2) {
            setServerConfig(configDb2, cfgKey, cfgValue);
            send({ type: 'config.value', key: cfgKey, value: cfgValue } as any);

            // Special handling: if defaultAdapter changed, rebuild LobbyManager
            if (cfgKey === 'defaultAdapter' && lobbyManager) {
              try {
                await lobbyManager.rebuild(cfgValue);
                send({
                  type: 'lm.status',
                  available: lobbyManager.isAvailable(),
                  sessionId: lobbyManager.getSessionId() ?? undefined,
                });
              } catch (err) {
                send({ type: 'error', error: `LM rebuild failed: ${err instanceof Error ? err.message : String(err)}` });
              }
            }
          }
          break;
        }

        case 'adapter.get-defaults': {
          send({
            type: 'adapter.defaults',
            defaults: sessionManager.getAdapterDefaults(),
          } as any);
          break;
        }

        case 'adapter.set-default': {
          const d = data as { adapterName: string; permissionMode: string };
          sessionManager.setAdapterDefault(d.adapterName, d.permissionMode as any);
          send({
            type: 'adapter.defaults',
            defaults: sessionManager.getAdapterDefaults(),
          } as any);
          break;
        }

        case 'adapter.get-meta': {
          send({
            type: 'adapter.meta',
            meta: sessionManager.getAdapterPermissionMeta(),
          } as any);
          break;
        }

        case 'wecom.qr-start': {
          if (activeQrAbort) {
            activeQrAbort.abort();
            activeQrAbort = null;
          }

          const abort = new AbortController();
          activeQrAbort = abort;

          startWeComQrFlow(
            (status) => {
              send({
                type: 'wecom.qr-status',
                ...status,
              } as any);
            },
            abort.signal,
          ).finally(() => {
            if (activeQrAbort === abort) {
              activeQrAbort = null;
            }
          });
          break;
        }

        case 'wecom.qr-cancel': {
          if (activeQrAbort) {
            activeQrAbort.abort();
            activeQrAbort = null;
          }
          break;
        }

        default: {
          send({
            type: 'error',
            error: `Unknown message type: ${(data as { type: string }).type}`,
          });
        }
      }
    } catch (err) {
      send({
        type: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  socket.on('close', () => {
    if (activeQrAbort) {
      activeQrAbort.abort();
      activeQrAbort = null;
    }
    sessionManager.removeMessageListener(listenerId);
    sessionManager.removeSessionUpdateListener(listenerId);
    sessionManager.removeNavigateListener(listenerId);
    sessionManager.removeCommandsListener(listenerId);
    sessionManager.unregisterWebViewer(listenerId);
  });

  function send(msg: ServerMessage): void {
    if (socket.readyState === 1) {
      socket.send(JSON.stringify(msg));
    }
  }
}

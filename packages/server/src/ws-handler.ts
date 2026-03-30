import type { WebSocket } from '@fastify/websocket';
import type { ClientMessage, ServerMessage, LobbyMessage, AdapterCommand } from '@openlobby/core';
import type { SessionManager } from './session-manager.js';
import type { LobbyManager } from './lobby-manager.js';
import type { ChannelRouterImpl } from './channel-router.js';
import { handleSlashCommand } from './slash-commands.js';
import { LM_WELCOME_TEXT } from './lm-welcome.js';

export function handleWebSocket(
  socket: WebSocket,
  sessionManager: SessionManager,
  lobbyManager?: LobbyManager,
  channelRouter?: ChannelRouterImpl,
): void {
  const listenerId = Math.random().toString(36).slice(2);

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

        case 'session.plan-mode': {
          console.log('[WS] session.plan-mode:', data.sessionId, data.enabled);
          try {
            sessionManager.setPlanMode(data.sessionId, data.enabled);
          } catch (err) {
            console.error('[WS] setPlanMode error:', err);
            send({ type: 'error', sessionId: data.sessionId, error: String(err) });
          }
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

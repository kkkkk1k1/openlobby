import React from 'react';
import { useCallback } from 'react';
import { useWebSocketInit, wsSendMessage, wsRespondControl, wsConfigureSession, wsRecoverSession } from './hooks/useWebSocket';
import { useLobbyStore } from './stores/lobby-store';
import Sidebar from './components/Sidebar';
import RoomHeader from './components/RoomHeader';
import MessageList from './components/MessageList';
import MessageInput from './components/MessageInput';

const WS_URL =
  import.meta.env.VITE_WS_URL ??
  `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

export default function App() {
  useWebSocketInit(WS_URL);

  const activeSessionId = useLobbyStore((s) => s.activeSessionId);
  const connected = useLobbyStore((s) => s.connected);
  const activeSession = useLobbyStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  );
  const isSessionAlive =
    activeSession != null &&
    activeSession.status !== 'stopped' &&
    activeSession.status !== 'error';

  const handleChoiceSelect = useCallback(
    (label: string) => {
      if (!activeSessionId) return;
      if (label === 'Execute Plan') {
        // Exit plan mode and send execution instruction
        wsConfigureSession(activeSessionId, { permissionMode: 'supervised' });
        wsSendMessage(activeSessionId, 'Please execute the plan above.');
      } else {
        // Send the selection as a user message
        wsSendMessage(activeSessionId, label);
      }
    },
    [activeSessionId],
  );

  return (
    <div className="h-screen flex bg-gray-950 text-gray-100">
      <Sidebar />

      <main className="flex-1 flex flex-col min-w-0">
        <RoomHeader />

        {activeSessionId ? (
          <>
            <MessageList
              sessionId={activeSessionId}
              onControlRespond={wsRespondControl}
              onChoiceSelect={handleChoiceSelect}
            />
            {!isSessionAlive && activeSession && (activeSession.status === 'stopped' || activeSession.status === 'error') && (
              <div className="flex items-center justify-center gap-3 px-4 py-2 bg-gray-900 border-t border-gray-700">
                <span className="text-xs text-gray-400">
                  Session {activeSession.status === 'error' ? 'errored' : 'stopped'}.
                </span>
                <button
                  onClick={() => wsRecoverSession(activeSessionId)}
                  className="text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white transition-colors"
                >
                  Recover to Idle
                </button>
              </div>
            )}
            <MessageInput
              onSend={(content) => wsSendMessage(activeSessionId, content)}
              disabled={!connected || !isSessionAlive}
              placeholder={
                isSessionAlive
                  ? undefined
                  : 'Session has ended. Create a new session to continue.'
              }
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center text-gray-500">
              <p className="text-lg mb-2">Select a session or create a new one</p>
              <p className="text-sm">
                Click "+ New" in the sidebar to get started
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

import React, { useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import type { SessionSummaryData } from '../stores/lobby-store';
import { wsRequestSessionHistory, wsDiscoverSessions } from '../hooks/useWebSocket';
// NewSessionDialog removed — Lobby Manager handles session creation
import DiscoverDialog from './DiscoverDialog';
import ChannelManagePanel from './ChannelManagePanel';
import GlobalSettingsDialog from './GlobalSettingsDialog';

const APP_VERSION = __APP_VERSION__;

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const statusConfig: Record<string, { color: string; label: string; pulse?: boolean }> = {
  running: { color: 'bg-green-400', label: 'Running' },
  awaiting_approval: { color: 'bg-orange-400', label: 'Needs Approval', pulse: true },
  idle: { color: 'bg-yellow-400', label: 'Idle' },
  stopped: { color: 'bg-red-400', label: 'Stopped' },
  error: { color: 'bg-red-500', label: 'Error' },
};

function SessionCard({
  session,
  isActive,
  onClick,
}: {
  session: SessionSummaryData;
  isActive: boolean;
  onClick: () => void;
}) {
  const config = statusConfig[session.status] ?? statusConfig.idle;
  const isAwaiting = session.status === 'awaiting_approval';

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
        isActive
          ? 'bg-gray-700 border-l-2 border-blue-400'
          : 'hover:bg-gray-800'
      } ${
        isAwaiting
          ? 'bg-orange-900/30 border-l-2 border-orange-400 ring-1 ring-orange-500/30'
          : ''
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`inline-block w-2 h-2 rounded-full ${config.color} ${
            config.pulse ? 'animate-pulse' : ''
          }`}
          title={config.label}
        />
        <span className="text-sm font-medium text-gray-100 truncate flex-1">
          {session.displayName}
        </span>
        {isAwaiting ? (
          <span className="text-[10px] text-orange-300 bg-orange-500/20 px-1.5 py-0.5 rounded font-medium animate-pulse">
            Approval
          </span>
        ) : (
          <span className="text-xs text-gray-500 uppercase">
            {session.adapterName === 'claude-code' ? 'CC' : session.adapterName === 'codex-cli' ? 'CX' : session.adapterName === 'opencode' ? 'OC' : session.adapterName}
          </span>
        )}
      </div>
      {session.channelBinding && (
        <div className="flex items-center gap-1 pl-4 mb-0.5">
          <span className="text-[10px] text-purple-400 bg-purple-500/15 px-1.5 py-0.5 rounded">
            {session.channelBinding.channelName}: {session.channelBinding.peerDisplayName ?? session.channelBinding.peerId}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between pl-4">
        <span className="text-xs text-gray-400 truncate flex-1">
          {session.lastMessage ?? session.cwd}
        </span>
        <span className="text-xs text-gray-500 ml-2 whitespace-nowrap">
          {formatRelativeTime(session.lastActiveAt)}
        </span>
      </div>
    </button>
  );
}

export default function Sidebar() {
  const sessions = useLobbyStore((s) => s.sessions);
  const activeSessionId = useLobbyStore((s) => s.activeSessionId);
  const connected = useLobbyStore((s) => s.connected);
  const setActiveSession = useLobbyStore((s) => s.setActiveSession);
  const showDiscoverDialog = useLobbyStore((s) => s.showDiscoverDialog);
  const setShowDiscoverDialog = useLobbyStore((s) => s.setShowDiscoverDialog);
  const lmAvailable = useLobbyStore((s) => s.lmAvailable);
  const lmSessionId = useLobbyStore((s) => s.lmSessionId);
  const [showChannelPanel, setShowChannelPanel] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const channelProviders = useLobbyStore((s) => s.channelProviders);

  // Filter out the Lobby Manager session from the regular list
  const sortedSessions = Object.values(sessions)
    .filter((s) => s.origin !== 'lobby-manager')
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  const handleSelectSession = (id: string) => {
    setActiveSession(id);
    wsRequestSessionHistory(id);
  };

  return (
    <>
      <aside className="w-72 bg-gray-900 border-r border-gray-700 flex flex-col h-full">
        {/* Header */}
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <h1 className="text-lg font-bold text-gray-100">OpenLobby</h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => wsDiscoverSessions()}
              disabled={!connected}
              title="Import CLI sessions"
              className="px-3 py-1 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium"
            >
              + Import
            </button>
          </div>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sortedSessions.length === 0 && (
            <div className="text-gray-500 text-sm text-center mt-8 px-4">
              No sessions yet. Click "+ New" to create one.
            </div>
          )}
          {sortedSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              isActive={activeSessionId === session.id}
              onClick={() => handleSelectSession(session.id)}
            />
          ))}
        </div>

        {/* Lobby Manager session */}
        <div className="px-4 py-2 border-t border-gray-700">
          <button
            onClick={() => {
              if (lmSessionId) {
                handleSelectSession(lmSessionId);
              }
            }}
            disabled={!lmAvailable || !lmSessionId}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
              activeSessionId === lmSessionId
                ? 'bg-blue-600/20 text-blue-300 border border-blue-500/30'
                : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
            title={lmAvailable ? 'Open Lobby Manager session' : 'No CLI adapter available'}
          >
            <span>&#x1F3E8;</span>
            <span className="font-medium">Lobby Manager</span>
            {lmAvailable && (
              <span className="ml-auto inline-block w-2 h-2 rounded-full bg-green-400" />
            )}
          </button>
        </div>

        {/* IM Channels button */}
        <div className="px-4 py-2 border-t border-gray-700">
          <button
            onClick={() => setShowChannelPanel(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-gray-800 text-gray-300 hover:bg-gray-700 transition-colors"
          >
            <span>&#x1F4AC;</span>
            <span className="font-medium">IM Channels</span>
            {channelProviders.length > 0 && (
              <span className="ml-auto text-xs text-gray-500">
                {channelProviders.filter((p) => p.healthy).length}/{channelProviders.length}
              </span>
            )}
          </button>
        </div>

        {/* Settings + Connection status + Version */}
        <div className="px-4 py-2 border-t border-gray-700 flex items-center justify-between">
          <button
            onClick={() => setShowSettingsDialog(true)}
            className="text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 px-2 py-1 rounded transition-colors"
          >
            ⚙️ Settings
          </button>
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full ${
                connected ? 'bg-green-400' : 'bg-red-400'
              }`}
            />
            <span className="text-xs text-gray-500">v{APP_VERSION}</span>
          </div>
        </div>
      </aside>

      {showDiscoverDialog && (
        <DiscoverDialog onClose={() => setShowDiscoverDialog(false)} />
      )}
      {showChannelPanel && (
        <ChannelManagePanel onClose={() => setShowChannelPanel(false)} />
      )}
      {showSettingsDialog && (
        <GlobalSettingsDialog onClose={() => setShowSettingsDialog(false)} />
      )}
    </>
  );
}

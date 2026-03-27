import React, { useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import type { SessionSummaryData } from '../stores/lobby-store';
import { wsImportSession } from '../hooks/useWebSocket';

interface Props {
  onClose: () => void;
}

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

export default function DiscoverDialog({ onClose }: Props) {
  const discoveredSessions = useLobbyStore((s) => s.discoveredSessions);
  const managedSessions = useLobbyStore((s) => s.sessions);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  const managedIds = new Set(Object.keys(managedSessions));

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const importable = discoveredSessions.filter((s) => !managedIds.has(s.id));
    if (selected.size === importable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(importable.map((s) => s.id)));
    }
  };

  const handleImport = () => {
    setImporting(true);
    for (const session of discoveredSessions) {
      if (selected.has(session.id)) {
        wsImportSession({
          sessionId: session.id,
          adapterName: session.adapterName,
          displayName: session.displayName,
          cwd: session.cwd,
          jsonlPath: session.jsonlPath,
        });
      }
    }
    setTimeout(() => {
      setImporting(false);
      onClose();
    }, 300);
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl w-[560px] max-h-[70vh] flex flex-col border border-gray-600 shadow-2xl">
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-gray-100">
              Discover CLI Sessions
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Found {discoveredSessions.length} session{discoveredSessions.length !== 1 ? 's' : ''} not yet managed by OpenLobby
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        {/* Session list */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {discoveredSessions.length === 0 ? (
            <div className="text-gray-500 text-sm text-center py-8">
              No new CLI sessions found.
            </div>
          ) : (
            <>
              {/* Select all */}
              <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-gray-400 cursor-pointer hover:text-gray-300">
                <input
                  type="checkbox"
                  checked={
                    selected.size > 0 &&
                    selected.size === discoveredSessions.filter((s) => !managedIds.has(s.id)).length
                  }
                  onChange={toggleAll}
                  className="rounded border-gray-500"
                />
                Select all
              </label>

              {discoveredSessions.map((session) => {
                const isManaged = managedIds.has(session.id);
                return (
                  <SessionRow
                    key={session.id}
                    session={session}
                    isManaged={isManaged}
                    isSelected={selected.has(session.id)}
                    onToggle={() => toggleSelect(session.id)}
                  />
                );
              })}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-gray-700 flex items-center justify-between">
          <span className="text-xs text-gray-400">
            {selected.size} selected
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300"
            >
              Cancel
            </button>
            <button
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
              className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium"
            >
              {importing ? 'Importing...' : `Import ${selected.size > 0 ? `(${selected.size})` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  isManaged,
  isSelected,
  onToggle,
}: {
  session: SessionSummaryData;
  isManaged: boolean;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const adapterLabel = session.adapterName === 'claude-code' ? 'CC' : session.adapterName === 'codex-cli' ? 'CX' : session.adapterName;

  return (
    <label
      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
        isManaged
          ? 'opacity-50 cursor-default'
          : isSelected
            ? 'bg-blue-900/30 border border-blue-500/30'
            : 'hover:bg-gray-700/50 border border-transparent'
      }`}
    >
      <input
        type="checkbox"
        checked={isSelected}
        disabled={isManaged}
        onChange={onToggle}
        className="mt-1 rounded border-gray-500"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-100 truncate">
            {session.displayName}
          </span>
          <span className="text-[10px] text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded uppercase">
            {adapterLabel}
          </span>
          {isManaged && (
            <span className="text-[10px] text-green-400 bg-green-900/30 px-1.5 py-0.5 rounded">
              Already imported
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-xs text-gray-400 truncate">{session.cwd}</span>
          <span className="text-xs text-gray-500 whitespace-nowrap">
            {formatRelativeTime(session.lastActiveAt)}
          </span>
        </div>
        {session.lastMessage && (
          <p className="text-xs text-gray-500 mt-0.5 truncate">
            {session.lastMessage}
          </p>
        )}
      </div>
    </label>
  );
}

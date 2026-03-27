import React, { useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { wsDestroySession, wsConfigureSession, wsTogglePlanMode } from '../hooks/useWebSocket';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-400">{label}</span>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="text-gray-300 hover:text-white font-mono truncate max-w-[200px] ml-2"
        title={text}
      >
        {copied ? 'Copied!' : text}
      </button>
    </div>
  );
}

export default function RoomHeader() {
  const activeSessionId = useLobbyStore((s) => s.activeSessionId);
  const session = useLobbyStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  );
  const isLM = session?.origin === 'lobby-manager';
  const [showSettings, setShowSettings] = useState(false);
  const [showDestroyConfirm, setShowDestroyConfirm] = useState(false);
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('');

  if (!activeSessionId || !session) return null;

  const handleDestroy = () => {
    setShowDestroyConfirm(true);
  };

  const confirmDestroy = () => {
    wsDestroySession(activeSessionId);
    setShowDestroyConfirm(false);
    setShowSettings(false);
  };

  const handleCopyResumeCmd = () => {
    if (session.resumeCommand) {
      navigator.clipboard.writeText(session.resumeCommand);
    }
  };

  const handleApplyConfig = () => {
    const opts: Record<string, unknown> = {};
    if (model.trim()) opts.model = model.trim();
    if (permissionMode) opts.permissionMode = permissionMode;
    if (Object.keys(opts).length > 0) {
      wsConfigureSession(activeSessionId, opts);
    }
    setShowSettings(false);
  };

  const adapterLabel = session.adapterName === 'claude-code' ? 'Claude Code' : session.adapterName;

  return (
    <div className="bg-gray-900 border-b border-gray-700 px-4 py-2 flex items-center justify-between relative">
      <div className="flex items-center gap-3 min-w-0">
        <h2 className="text-sm font-semibold text-gray-100 truncate">
          {session.displayName}
        </h2>
        <span className="text-xs text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
          {adapterLabel}
        </span>
        {session.planMode && (
          <span className="text-xs text-amber-400 bg-amber-900/30 border border-amber-500/30 px-2 py-0.5 rounded flex items-center gap-1.5">
            Plan Mode
            <button
              onClick={() => wsTogglePlanMode(activeSessionId, false)}
              className="text-amber-300 hover:text-amber-100 transition-colors"
              title="Exit plan mode"
            >
              ×
            </button>
          </span>
        )}
        {session.model && (
          <span className="text-xs text-gray-500">{session.model}</span>
        )}
        <span className="text-xs text-gray-500 truncate" title={session.cwd}>
          {session.cwd}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {session.resumeCommand && (
          <button
            onClick={handleCopyResumeCmd}
            className="text-xs text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800"
            title={`Copy: ${session.resumeCommand}`}
          >
            Resume Cmd
          </button>
        )}
        <button
          onClick={() => {
            setShowSettings(!showSettings);
            setModel(session.model ?? '');
            setPermissionMode(session.permissionMode ?? '');
          }}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            showSettings ? 'bg-gray-700 text-gray-200' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
          }`}
        >
          Settings
        </button>
      </div>

      {showSettings && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
          <div className="absolute top-full right-0 mt-1 w-80 bg-gray-900 border border-gray-700 rounded-lg shadow-xl z-50 p-4 space-y-3">
            <CopyButton label="CWD" text={session.cwd} />
            <CopyButton label="Session ID" text={activeSessionId} />

            <div className="border-t border-gray-700 pt-3 space-y-2">
              <div>
                <label className="text-xs text-gray-400 block mb-1">Model</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. opus, sonnet"
                  className="w-full bg-gray-800 text-gray-100 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder-gray-500"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 block mb-1">Permission Mode</label>
                <select
                  value={permissionMode}
                  onChange={(e) => setPermissionMode(e.target.value)}
                  className="w-full bg-gray-800 text-gray-100 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Keep current</option>
                  <option value="default">Default</option>
                  <option value="plan">Plan (Read-only)</option>
                  <option value="bypassPermissions">Full Auto</option>
                </select>
              </div>
              <button
                onClick={handleApplyConfig}
                className="w-full text-xs bg-blue-600 hover:bg-blue-500 text-white rounded px-2 py-1.5 transition-colors"
              >
                Apply (takes effect on next message)
              </button>
            </div>

            {!isLM && (
              <div className="border-t border-gray-700 pt-2">
                <button
                  onClick={handleDestroy}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  Remove Session
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {showDestroyConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-xl w-96 border border-gray-600 shadow-2xl p-5">
            <h3 className="text-sm font-semibold text-gray-100 mb-2">
              Remove session from OpenLobby?
            </h3>
            <p className="text-xs text-gray-400 mb-1">
              This will stop the running process (if any) and remove this session from OpenLobby's management.
            </p>
            <p className="text-xs text-gray-400 mb-4">
              CLI session data (JSONL history) will <span className="text-gray-200 font-medium">not</span> be deleted. You can still resume it from the terminal or re-import it via Discover.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDestroyConfirm(false)}
                className="px-3 py-1.5 text-xs rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={confirmDestroy}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-600 hover:bg-red-500 text-white font-medium"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

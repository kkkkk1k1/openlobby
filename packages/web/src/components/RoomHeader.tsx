import React, { useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { wsDestroySession, wsConfigureSession, wsOpenTerminal } from '../hooks/useWebSocket';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-on-surface-secondary">{label}</span>
      <button
        onClick={() => {
          navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="text-on-surface hover:text-primary font-mono truncate max-w-[200px] ml-2"
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
  const viewMode = useLobbyStore((s) =>
    activeSessionId ? (s.viewModeBySession[activeSessionId] ?? 'im') : 'im',
  );
  const setViewMode = useLobbyStore((s) => s.setViewMode);
  const adapterMeta = useLobbyStore((s) => s.adapterPermissionMeta);
  const adapterDefaults = useLobbyStore((s) => s.adapterDefaults);
  const terminalFailDialog = useLobbyStore((s) => s.terminalFailDialog);
  const setTerminalFailDialog = useLobbyStore((s) => s.setTerminalFailDialog);
  const [showSettings, setShowSettings] = useState(false);
  const [showDestroyConfirm, setShowDestroyConfirm] = useState(false);
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState('');
  const [messageMode, setMessageMode] = useState('');

  if (!activeSessionId || !session) return null;

  const handleDestroy = () => {
    setShowDestroyConfirm(true);
  };

  const confirmDestroy = () => {
    wsDestroySession(activeSessionId);
    setShowDestroyConfirm(false);
    setShowSettings(false);
  };

  const handleOpenTerminal = () => {
    if (activeSessionId) {
      wsOpenTerminal(activeSessionId);
    }
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
    if (messageMode) opts.messageMode = messageMode;
    if (Object.keys(opts).length > 0) {
      wsConfigureSession(activeSessionId, opts);
      useLobbyStore.getState().updateSession({
        ...session,
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(messageMode ? { messageMode } : {}),
      });
    }
    setShowSettings(false);
  };

  const adapterLabel = session.adapterName === 'claude-code' ? 'Claude Code' : session.adapterName === 'codex-cli' ? 'Codex CLI' : session.adapterName === 'opencode' ? 'OpenCode' : session.adapterName === 'gsd' ? 'GSD' : session.adapterName;

  const effectivePermission = (() => {
    if (session.permissionMode) return session.permissionMode;
    const def = adapterDefaults.find((d) => d.adapterName === session.adapterName);
    return def?.permissionMode ?? 'supervised';
  })();
  const isInherited = !session.permissionMode;
  const meta = adapterMeta[session.adapterName];
  const nativeLabel = meta?.modeLabels?.[effectivePermission] ?? '';

  return (
    <div className="bg-surface-secondary border-b border-outline px-4 py-2 flex items-center justify-between relative">
      <div className="flex items-center gap-3 min-w-0">
        <h2 className="text-sm font-semibold text-on-surface truncate">
          {session.displayName}
        </h2>
        <span className="text-xs text-on-surface-secondary bg-surface-elevated px-2 py-0.5 rounded">
          {adapterLabel}
        </span>
        {(() => {
          const badgeConfig: Record<string, { color: string; label: string }> = {
            auto: { color: 'text-success bg-success-surface border-success/30', label: 'Auto' },
            supervised: { color: 'text-warning bg-warning-surface border-warning/30', label: 'Supervised' },
            readonly: { color: 'text-primary bg-primary-surface border-primary/30', label: 'Readonly' },
          };
          const cfg = badgeConfig[effectivePermission] ?? badgeConfig.supervised;
          return (
            <span
              className={`text-xs ${cfg.color} border px-2 py-0.5 rounded`}
              title={nativeLabel ? `Maps to '${nativeLabel}' in ${adapterLabel}` : undefined}
            >
              {cfg.label}{isInherited ? ' (default)' : ''}
            </span>
          );
        })()}
        {session.model && (
          <span className="text-xs text-on-surface-muted">{session.model}</span>
        )}
        <span className="text-xs text-on-surface-muted truncate" title={session.cwd}>
          {session.cwd}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {!isLM && (
          <div className="flex items-center bg-surface-elevated rounded-md p-0.5">
            <button
              onClick={() => activeSessionId && setViewMode(activeSessionId, 'im')}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                viewMode === 'im'
                  ? 'bg-primary text-primary-on'
                  : 'text-on-surface-secondary hover:text-on-surface'
              }`}
            >
              IM
            </button>
            <button
              onClick={() => activeSessionId && setViewMode(activeSessionId, 'terminal')}
              className={`text-xs px-2 py-1 rounded transition-colors ${
                viewMode === 'terminal'
                  ? 'bg-primary text-primary-on'
                  : 'text-on-surface-secondary hover:text-on-surface'
              }`}
            >
              Terminal
            </button>
          </div>
        )}
        {session.resumeCommand && (
          <button
            onClick={handleOpenTerminal}
            onContextMenu={(e) => {
              e.preventDefault();
              handleCopyResumeCmd();
            }}
            className="text-xs text-on-surface-secondary hover:text-on-surface px-2 py-1 rounded hover:bg-surface-elevated"
            title={`Click to open in terminal | Right-click to copy: ${session.resumeCommand}`}
          >
            Open in Terminal
          </button>
        )}
        <button
          onClick={() => {
            setShowSettings(!showSettings);
            setModel(session.model ?? '');
            setPermissionMode(session.permissionMode ?? '');
            setMessageMode(session.messageMode ?? 'msg-tidy');
          }}
          className={`text-xs px-2 py-1 rounded transition-colors ${
            showSettings ? 'bg-surface-elevated text-on-surface' : 'text-on-surface-secondary hover:text-on-surface hover:bg-surface-elevated'
          }`}
        >
          Settings
        </button>
      </div>
      {showSettings && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowSettings(false)} />
          <div className="absolute top-full right-0 mt-1 w-80 bg-surface-secondary border border-outline rounded-lg shadow-xl z-50 p-4 space-y-3">
            <CopyButton label="CWD" text={session.cwd} />
            <CopyButton label="Session ID" text={activeSessionId} />

            <div className="border-t border-outline pt-3 space-y-2">
              <div>
                <label className="text-xs text-on-surface-secondary block mb-1">Model</label>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. opus, sonnet"
                  className="w-full bg-surface-elevated text-on-surface rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary placeholder-on-surface-muted"
                />
              </div>
              <div>
                <label className="text-xs text-on-surface-secondary block mb-1">Permission Mode</label>
                <select
                  value={permissionMode}
                  onChange={(e) => setPermissionMode(e.target.value)}
                  className="w-full bg-surface-elevated text-on-surface rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="">
                    Use global default ({(() => {
                      const def = adapterDefaults.find((d) => d.adapterName === session.adapterName);
                      const defMode = def?.permissionMode ?? 'supervised';
                      return defMode.charAt(0).toUpperCase() + defMode.slice(1);
                    })()})
                  </option>
                  {(['auto', 'supervised', 'readonly'] as const).map((mode) => {
                    const native = meta?.modeLabels?.[mode] ?? '';
                    const label = mode.charAt(0).toUpperCase() + mode.slice(1);
                    return (
                      <option key={mode} value={mode}>
                        {label}{native ? ` (${native})` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div>
                <label className="text-xs text-on-surface-secondary block mb-1">Message Mode</label>
                <select
                  value={messageMode}
                  onChange={(e) => setMessageMode(e.target.value)}
                  className="w-full bg-surface-elevated text-on-surface rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="msg-tidy">Tidy (collapse tools)</option>
                  <option value="msg-only">Messages only</option>
                  <option value="msg-total">All messages</option>
                </select>
              </div>
              <button
                onClick={handleApplyConfig}
                className="w-full text-xs bg-primary hover:bg-primary-hover text-primary-on rounded px-2 py-1.5 transition-colors"
              >
                Apply (takes effect on next message)
              </button>
            </div>

            {!isLM && (
              <div className="border-t border-outline pt-2">
                <button
                  onClick={handleDestroy}
                  className="text-xs text-danger hover:text-danger-hover"
                >
                  Remove Session
                </button>
              </div>
            )}
          </div>
        </>
      )}
      {showDestroyConfirm && (
        <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-50">
          <div className="bg-surface-elevated rounded-xl w-96 border border-outline shadow-2xl p-5">
            <h3 className="text-sm font-semibold text-on-surface mb-2">
              Remove session from OpenLobby?
            </h3>
            <p className="text-xs text-on-surface-secondary mb-1">
              This will stop the running process (if any) and remove this session from OpenLobby's management.
            </p>
            <p className="text-xs text-on-surface-secondary mb-4">
              CLI session data (JSONL history) will <span className="text-on-surface font-medium">not</span> be deleted. You can still resume it from the terminal or re-import it via Discover.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDestroyConfirm(false)}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-elevated hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary border border-outline"
              >
                Cancel
              </button>
              <button
                onClick={confirmDestroy}
                className="px-3 py-1.5 text-xs rounded-lg bg-danger hover:bg-danger-hover text-white font-medium"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}

      {terminalFailDialog && (
        <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-50">
          <div className="bg-surface-elevated rounded-xl w-[480px] border border-outline shadow-2xl p-5">
            <h3 className="text-sm font-semibold text-warning mb-2">
              Unable to open terminal automatically
            </h3>
            <p className="text-xs text-on-surface-secondary mb-3">
              {terminalFailDialog.reason}
            </p>
            <p className="text-xs text-on-surface-secondary mb-2">
              Please run the following command manually:
            </p>
            <div className="bg-[var(--color-code-bg)] rounded-lg p-3 mb-3 font-mono text-xs text-on-surface break-all select-all">
              {terminalFailDialog.resumeCommand}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(terminalFailDialog.resumeCommand);
                }}
                className="px-3 py-1.5 text-xs rounded-lg bg-primary hover:bg-primary-hover text-primary-on font-medium"
              >
                Copy Command
              </button>
              <button
                onClick={() => setTerminalFailDialog(null)}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-elevated hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary border border-outline"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
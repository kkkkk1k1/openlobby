import React, { useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { wsSetAdapterDefault, wsSetConfig } from '../hooks/useWebSocket';
import { useThemeContext } from '../contexts/ThemeContext';
import type { Theme } from '../hooks/useTheme';

interface Props {
  onClose: () => void;
}

export default function GlobalSettingsDialog({ onClose }: Props) {
  const serverConfig = useLobbyStore((s) => s.serverConfig);
  const adapterDefaults = useLobbyStore((s) => s.adapterDefaults);
  const adapterMeta = useLobbyStore((s) => s.adapterPermissionMeta);
  const [defaultAdapter, setDefaultAdapter] = useState(serverConfig.defaultAdapter ?? 'claude-code');
  const [defaultMessageMode, setDefaultMessageMode] = useState(serverConfig.defaultMessageMode ?? 'msg-tidy');
  const [defaultViewMode, setDefaultViewMode] = useState(serverConfig.defaultViewMode ?? 'im');
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingAdapter, setPendingAdapter] = useState('');
  const { theme, setTheme } = useThemeContext();

  const handleAdapterChange = (value: string) => {
    if (value !== (serverConfig.defaultAdapter ?? 'claude-code')) {
      setPendingAdapter(value);
      setShowConfirm(true);
    } else {
      setDefaultAdapter(value);
    }
  };

  const confirmAdapterChange = () => {
    setDefaultAdapter(pendingAdapter);
    wsSetConfig('defaultAdapter', pendingAdapter);
    setShowConfirm(false);
  };

  const handleMessageModeChange = (value: string) => {
    setDefaultMessageMode(value);
    wsSetConfig('defaultMessageMode', value);
  };

  return (
    <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-secondary rounded-xl p-6 w-full max-w-md border border-outline max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold mb-5 text-on-surface">Settings</h2>

        <div className="space-y-5">
          {/* Theme */}
          <div>
            <label className="block text-sm text-on-surface-secondary mb-1">Theme</label>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as Theme)}
              className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          {/* Default Adapter */}
          <div>
            <label className="block text-sm text-on-surface-secondary mb-1">Default Adapter</label>
            <select
              value={defaultAdapter}
              onChange={(e) => handleAdapterChange(e.target.value)}
              className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex-cli">Codex CLI</option>
              <option value="opencode">OpenCode</option>
              <option value="gsd">GSD</option>
            </select>
            <p className="text-xs text-on-surface-muted mt-1">
              Affects new sessions and Lobby Manager
            </p>
          </div>

          {/* Default Message Mode */}
          <div>
            <label className="block text-sm text-on-surface-secondary mb-1">Default Message Mode</label>
            <select
              value={defaultMessageMode}
              onChange={(e) => handleMessageModeChange(e.target.value)}
              className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="msg-tidy">Tidy (collapse tool calls)</option>
              <option value="msg-only">Messages only</option>
              <option value="msg-total">All messages</option>
            </select>
            <p className="text-xs text-on-surface-muted mt-1">
              Default for newly created sessions
            </p>
          </div>

          {/* Default View Mode */}
          <div>
            <label className="block text-sm text-on-surface-secondary mb-1">Default View Mode</label>
            <select
              value={defaultViewMode}
              onChange={(e) => {
                setDefaultViewMode(e.target.value);
                wsSetConfig('defaultViewMode', e.target.value);
              }}
              className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            >
              <option value="im">IM (chat bubbles)</option>
              <option value="terminal">Terminal</option>
            </select>
            <p className="text-xs text-on-surface-muted mt-1">
              Default for newly created sessions
            </p>
          </div>

          {/* Default Permission Mode per Adapter */}
          <div>
            <h3 className="text-sm font-semibold text-on-surface-secondary mb-2">Default Permission Mode per Adapter</h3>
            <div className="space-y-3">
              {adapterDefaults.map((def) => {
                const meta = adapterMeta[def.adapterName];
                return (
                  <div key={def.adapterName}>
                    <label className="block text-sm text-on-surface-secondary mb-1">{def.displayName}</label>
                    <select
                      value={def.permissionMode}
                      onChange={(e) => wsSetAdapterDefault(def.adapterName, e.target.value)}
                      className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                    >
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
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-secondary hover:text-on-surface rounded-lg hover:bg-surface-elevated"
          >
            Close
          </button>
        </div>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-[60]" onClick={() => setShowConfirm(false)}>
          <div className="bg-surface-elevated rounded-xl w-96 border border-outline shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-on-surface mb-2">
              切换默认 Adapter？
            </h3>
            <p className="text-xs text-on-surface-secondary mb-4">
              切换默认 Adapter 将重建 Lobby Manager，历史记录不保留。确认？
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-elevated hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary border border-outline"
              >
                Cancel
              </button>
              <button
                onClick={confirmAdapterChange}
                className="px-3 py-1.5 text-xs rounded-lg bg-primary hover:bg-primary-hover text-primary-on font-medium"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

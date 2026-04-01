import React, { useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { wsSetAdapterDefault, wsSetConfig } from '../hooks/useWebSocket';

interface Props {
  onClose: () => void;
}

export default function GlobalSettingsDialog({ onClose }: Props) {
  const serverConfig = useLobbyStore((s) => s.serverConfig);
  const adapterDefaults = useLobbyStore((s) => s.adapterDefaults);
  const adapterMeta = useLobbyStore((s) => s.adapterPermissionMeta);
  const [defaultAdapter, setDefaultAdapter] = useState(serverConfig.defaultAdapter ?? 'claude-code');
  const [defaultMessageMode, setDefaultMessageMode] = useState(serverConfig.defaultMessageMode ?? 'msg-tidy');
  const [showConfirm, setShowConfirm] = useState(false);
  const [pendingAdapter, setPendingAdapter] = useState('');

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
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-900 rounded-xl p-6 w-full max-w-md border border-gray-700 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold mb-5 text-gray-100">Settings</h2>

        <div className="space-y-5">
          {/* Default Adapter */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Default Adapter</label>
            <select
              value={defaultAdapter}
              onChange={(e) => handleAdapterChange(e.target.value)}
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="claude-code">Claude Code</option>
              <option value="codex-cli">Codex CLI</option>
              <option value="opencode">OpenCode</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Affects new sessions and Lobby Manager
            </p>
          </div>

          {/* Default Message Mode */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Default Message Mode</label>
            <select
              value={defaultMessageMode}
              onChange={(e) => handleMessageModeChange(e.target.value)}
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="msg-tidy">Tidy (collapse tool calls)</option>
              <option value="msg-only">Messages only</option>
              <option value="msg-total">All messages</option>
            </select>
            <p className="text-xs text-gray-500 mt-1">
              Default for newly created sessions
            </p>
          </div>

          {/* Default Permission Mode per Adapter */}
          <div>
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Default Permission Mode per Adapter</h3>
            <div className="space-y-3">
              {adapterDefaults.map((def) => {
                const meta = adapterMeta[def.adapterName];
                return (
                  <div key={def.adapterName}>
                    <label className="block text-sm text-gray-400 mb-1">{def.displayName}</label>
                    <select
                      value={def.permissionMode}
                      onChange={(e) => wsSetAdapterDefault(def.adapterName, e.target.value)}
                      className="w-full bg-gray-800 text-gray-100 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-800"
          >
            Close
          </button>
        </div>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60]" onClick={() => setShowConfirm(false)}>
          <div className="bg-gray-800 rounded-xl w-96 border border-gray-600 shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-100 mb-2">
              切换默认 Adapter？
            </h3>
            <p className="text-xs text-gray-400 mb-4">
              切换默认 Adapter 将重建 Lobby Manager，历史记录不保留。确认？
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1.5 text-xs rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={confirmAdapterChange}
                className="px-3 py-1.5 text-xs rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium"
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

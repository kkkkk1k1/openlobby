import React, { useState } from 'react';
import { wsCreateSession } from '../hooks/useWebSocket';
import { useLobbyStore } from '../stores/lobby-store';

interface Props {
  onClose: () => void;
}

export default function NewSessionDialog({ onClose }: Props) {
  const serverConfig = useLobbyStore((s) => s.serverConfig);
  const defaultAdapter = (serverConfig.defaultAdapter ?? 'claude-code') as 'claude-code' | 'codex-cli' | 'opencode';
  const defaultMessageMode = serverConfig.defaultMessageMode ?? 'msg-tidy';
  const adapterMeta = useLobbyStore((s) => s.adapterPermissionMeta);
  const adapterDefaults = useLobbyStore((s) => s.adapterDefaults);

  const [adapter, setAdapter] = useState<'claude-code' | 'codex-cli' | 'opencode'>(defaultAdapter);
  const [name, setName] = useState('');
  const [cwd, setCwd] = useState('');
  const [model, setModel] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [permissionMode, setPermissionMode] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [messageMode, setMessageMode] = useState(defaultMessageMode);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cwd.trim()) return;

    wsCreateSession(
      adapter,
      {
        cwd: cwd.trim(),
        prompt: initialPrompt.trim() || undefined,
        model: model.trim() || undefined,
        permissionMode: permissionMode || undefined,
        systemPrompt: systemPrompt.trim() || undefined,
        messageMode,
      },
      name.trim() || undefined,
    );
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 rounded-xl p-6 w-full max-w-md border border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold mb-5 text-gray-100">New Session</h2>

        <div className="space-y-4">
          {/* Agent type */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">Agent</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setAdapter('claude-code')}
                className={`flex-1 rounded-lg px-3 py-2 text-sm text-center transition-colors ${
                  adapter === 'claude-code'
                    ? 'bg-blue-900/40 border border-blue-500/50 text-blue-200'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-300 border border-transparent'
                }`}
              >
                Claude Code
              </button>
              <button
                type="button"
                onClick={() => setAdapter('codex-cli')}
                className={`flex-1 rounded-lg px-3 py-2 text-sm text-center transition-colors ${
                  adapter === 'codex-cli'
                    ? 'bg-green-900/40 border border-green-500/50 text-green-200'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-300 border border-transparent'
                }`}
              >
                Codex CLI
              </button>
              <button
                type="button"
                onClick={() => setAdapter('opencode')}
                className={`flex-1 rounded-lg px-3 py-2 text-sm text-center transition-colors ${
                  adapter === 'opencode'
                    ? 'bg-purple-900/40 border border-purple-500/50 text-purple-200'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-300 border border-transparent'
                }`}
              >
                OpenCode
              </button>
            </div>
          </div>

          {/* Name */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Name <span className="text-gray-600">(optional)</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. refactor-auth"
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            />
          </div>

          {/* CWD */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Working Directory
            </label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/path/to/your/project"
              required
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            />
          </div>

          {/* Initial Prompt */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Initial Prompt <span className="text-gray-600">(optional)</span>
            </label>
            <textarea
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder={adapter === 'codex-cli' ? 'What would you like Codex to do?' : adapter === 'opencode' ? 'What would you like OpenCode to do?' : 'What would you like Claude to do?'}
              rows={2}
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            />
          </div>

          {/* Model */}
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Model <span className="text-gray-600">(optional)</span>
            </label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={adapter === 'codex-cli' ? 'e.g. o3, o4-mini, codex-mini' : adapter === 'opencode' ? 'e.g. claude-4-sonnet, gpt-4o' : 'e.g. opus, sonnet'}
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            />
          </div>

          {/* Advanced */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm text-gray-400 hover:text-gray-300"
            >
              {showAdvanced ? '- Advanced' : '+ Advanced'}
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    Permission Mode
                  </label>
                  <select
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value)}
                    className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">
                      Use global default ({(() => {
                        const def = adapterDefaults.find((d) => d.adapterName === adapter);
                        const defMode = def?.permissionMode ?? 'supervised';
                        return defMode.charAt(0).toUpperCase() + defMode.slice(1);
                      })()})
                    </option>
                    {(['auto', 'supervised', 'readonly'] as const).map((mode) => {
                      const meta = adapterMeta[adapter];
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
                  <label className="block text-sm text-gray-400 mb-1">
                    Message Mode
                  </label>
                  <select
                    value={messageMode}
                    onChange={(e) => setMessageMode(e.target.value)}
                    className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="msg-tidy">Tidy (collapse tool calls)</option>
                    <option value="msg-only">Messages only</option>
                    <option value="msg-total">All messages</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    System Prompt
                  </label>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="Custom system prompt..."
                    rows={3}
                    className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!cwd.trim()}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium"
          >
            Create Room
          </button>
        </div>
      </form>
    </div>
  );
}

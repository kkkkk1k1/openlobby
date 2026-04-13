import React, { useState } from 'react';
import { wsCreateSession } from '../hooks/useWebSocket';
import { useLobbyStore } from '../stores/lobby-store';
import { useI18nContext } from '../contexts/I18nContext';

interface Props {
  onClose: () => void;
}

function getAgentLabel(adapter: 'claude-code' | 'codex-cli' | 'opencode' | 'gsd') {
  if (adapter === 'codex-cli') return 'Codex';
  if (adapter === 'opencode') return 'OpenCode';
  if (adapter === 'gsd') return 'GSD';
  return 'Claude';
}

export default function NewSessionDialog({ onClose }: Props) {
  const serverConfig = useLobbyStore((s) => s.serverConfig);
  const defaultAdapter = (serverConfig.defaultAdapter ?? 'claude-code') as 'claude-code' | 'codex-cli' | 'opencode' | 'gsd';
  const defaultMessageMode = serverConfig.defaultMessageMode ?? 'msg-tidy';
  const adapterMeta = useLobbyStore((s) => s.adapterPermissionMeta);
  const adapterDefaults = useLobbyStore((s) => s.adapterDefaults);
  const { t } = useI18nContext();

  const [adapter, setAdapter] = useState<'claude-code' | 'codex-cli' | 'opencode' | 'gsd'>(defaultAdapter);
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

  const modelPlaceholder =
    adapter === 'codex-cli'
      ? t('newSession.modelPlaceholderCodex')
      : adapter === 'opencode'
        ? t('newSession.modelPlaceholderOpenCode')
        : adapter === 'gsd'
          ? t('newSession.modelPlaceholderGsd')
          : t('newSession.modelPlaceholderClaude');

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onSubmit={handleSubmit}
        className="bg-gray-900 rounded-xl p-6 w-full max-w-md border border-gray-700"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold mb-5 text-gray-100">{t('newSession.title')}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">{t('newSession.agent')}</label>
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
              <button
                type="button"
                onClick={() => setAdapter('gsd')}
                className={`flex-1 rounded-lg px-3 py-2 text-sm text-center transition-colors ${
                  adapter === 'gsd'
                    ? 'bg-amber-900/40 border border-amber-500/50 text-amber-200'
                    : 'bg-gray-800 text-gray-400 hover:text-gray-300 border border-transparent'
                }`}
              >
                GSD
              </button>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">
              {t('newSession.name')} <span className="text-gray-600">({t('common.optional')})</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('newSession.namePlaceholder')}
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">
              {t('newSession.workingDirectory')}
            </label>
            <input
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder={t('newSession.cwdPlaceholder')}
              required
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">
              {t('newSession.initialPrompt')} <span className="text-gray-600">({t('common.optional')})</span>
            </label>
            <textarea
              value={initialPrompt}
              onChange={(e) => setInitialPrompt(e.target.value)}
              placeholder={t('newSession.initialPromptPlaceholder', { agent: getAgentLabel(adapter) })}
              rows={2}
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1">
              {t('roomHeader.model')} <span className="text-gray-600">({t('common.optional')})</span>
            </label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={modelPlaceholder}
              className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
            />
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm text-gray-400 hover:text-gray-300"
            >
              {showAdvanced ? t('newSession.advancedHide') : t('newSession.advancedShow')}
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    {t('roomHeader.permissionMode')}
                  </label>
                  <select
                    value={permissionMode}
                    onChange={(e) => setPermissionMode(e.target.value)}
                    className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="">
                      {t('roomHeader.useGlobalDefault', {
                        mode: (() => {
                          const def = adapterDefaults.find((d) => d.adapterName === adapter);
                          const defMode = def?.permissionMode ?? 'supervised';
                          return defMode === 'auto'
                            ? t('roomHeader.auto')
                            : defMode === 'readonly'
                              ? t('roomHeader.readonly')
                              : t('roomHeader.supervised');
                        })(),
                      })}
                    </option>
                    {(['auto', 'supervised', 'readonly'] as const).map((mode) => {
                      const meta = adapterMeta[adapter];
                      const native = meta?.modeLabels?.[mode] ?? '';
                      const label = mode === 'auto'
                        ? t('roomHeader.auto')
                        : mode === 'readonly'
                          ? t('roomHeader.readonly')
                          : t('roomHeader.supervised');
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
                    {t('roomHeader.messageMode')}
                  </label>
                  <select
                    value={messageMode}
                    onChange={(e) => setMessageMode(e.target.value)}
                    className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="msg-tidy">{t('messageMode.tidy')}</option>
                    <option value="msg-only">{t('messageMode.only')}</option>
                    <option value="msg-total">{t('messageMode.total')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-1">
                    {t('newSession.systemPrompt')}
                  </label>
                  <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder={t('newSession.systemPromptPlaceholder')}
                    rows={3}
                    className="w-full bg-gray-800 text-gray-100 rounded-lg px-4 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder-gray-500"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 rounded-lg hover:bg-gray-800"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!cwd.trim()}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium"
          >
            {t('newSession.createRoom')}
          </button>
        </div>
      </form>
    </div>
  );
}

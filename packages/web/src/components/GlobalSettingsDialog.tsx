import React, { useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { wsSetAdapterDefault, wsSetConfig } from '../hooks/useWebSocket';
import { useThemeContext } from '../contexts/ThemeContext';
import { useI18nContext } from '../contexts/I18nContext';
import type { Theme } from '../hooks/useTheme';
import type { Locale } from '../i18n/types';

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
  const { locale, setLocale, t } = useI18nContext();

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

  const themeOptions: Array<{ value: Theme; label: string }> = [
    { value: 'system', label: t('common.system') },
    { value: 'light', label: t('common.light') },
    { value: 'dark', label: t('common.dark') },
  ];

  const localeOptions: Array<{ value: Locale; label: string }> = [
    { value: 'zh-CN', label: t('globalSettings.localeZhCn') },
    { value: 'en', label: t('globalSettings.localeEn') },
  ];

  const messageModeOptions = [
    { value: 'msg-tidy', label: t('messageMode.tidy') },
    { value: 'msg-only', label: t('messageMode.only') },
    { value: 'msg-total', label: t('messageMode.total') },
  ];

  return (
    <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-secondary rounded-xl w-full max-w-md border border-outline max-h-[80vh] min-h-0 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-6 pt-6 pb-4 border-b border-outline bg-surface-secondary">
          <h2 className="text-lg font-bold text-on-surface">{t('globalSettings.title')}</h2>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-6 py-5">
          <div className="space-y-5">
            <div>
              <label className="block text-sm text-on-surface-secondary mb-1">{t('common.language')}</label>
              <select
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {localeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm text-on-surface-secondary mb-1">{t('common.theme')}</label>
              <select
                value={theme}
                onChange={(e) => setTheme(e.target.value as Theme)}
                className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {themeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm text-on-surface-secondary mb-1">{t('globalSettings.defaultAdapter')}</label>
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
                {t('globalSettings.defaultAdapterHelp')}
              </p>
            </div>

            <div>
              <label className="block text-sm text-on-surface-secondary mb-1">{t('globalSettings.defaultMessageMode')}</label>
              <select
                value={defaultMessageMode}
                onChange={(e) => handleMessageModeChange(e.target.value)}
                className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                {messageModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
              <p className="text-xs text-on-surface-muted mt-1">
                {t('globalSettings.defaultNewSessions')}
              </p>
            </div>

            <div>
              <label className="block text-sm text-on-surface-secondary mb-1">{t('globalSettings.defaultViewMode')}</label>
              <select
                value={defaultViewMode}
                onChange={(e) => {
                  setDefaultViewMode(e.target.value);
                  wsSetConfig('defaultViewMode', e.target.value);
                }}
                className="w-full bg-surface-elevated text-on-surface rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              >
                <option value="im">{t('globalSettings.imChatBubbles')}</option>
                <option value="terminal">{t('common.terminal')}</option>
              </select>
              <p className="text-xs text-on-surface-muted mt-1">
                {t('globalSettings.defaultNewSessions')}
              </p>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-on-surface-secondary mb-2">{t('globalSettings.defaultPermissionModes')}</h3>
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
                          const label = mode === 'auto'
                            ? t('roomHeader.auto')
                            : mode === 'supervised'
                              ? t('roomHeader.supervised')
                              : t('roomHeader.readonly');
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
        </div>

        <div className="shrink-0 flex justify-end px-6 py-4 border-t border-outline bg-surface-secondary">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-secondary hover:text-on-surface rounded-lg hover:bg-surface-elevated"
          >
            {t('common.close')}
          </button>
        </div>
      </div>

      {showConfirm && (
        <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-[60]" onClick={() => setShowConfirm(false)}>
          <div className="bg-surface-elevated rounded-xl w-96 border border-outline shadow-2xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-on-surface mb-2">
              {t('globalSettings.confirmAdapterSwitchTitle')}
            </h3>
            <p className="text-xs text-on-surface-secondary mb-4">
              {t('globalSettings.confirmAdapterSwitchBody')}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-3 py-1.5 text-xs rounded-lg bg-surface-elevated hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary border border-outline"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmAdapterChange}
                className="px-3 py-1.5 text-xs rounded-lg bg-primary hover:bg-primary-hover text-primary-on font-medium"
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

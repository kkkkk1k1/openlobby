import React, { useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import type { SessionSummaryData } from '../stores/lobby-store';
import { wsImportSession } from '../hooks/useWebSocket';
import { useI18nContext } from '../contexts/I18nContext';

interface Props {
  onClose: () => void;
}

function formatRelativeTime(
  timestamp: number,
  t: ReturnType<typeof useI18nContext>['t'],
): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t('time.justNow');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  return t('time.daysAgo', { count: days });
}

export default function DiscoverDialog({ onClose }: Props) {
  const discoveredSessions = useLobbyStore((s) => s.discoveredSessions);
  const managedSessions = useLobbyStore((s) => s.sessions);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [adapterFilter, setAdapterFilter] = useState<string>('all');
  const { t } = useI18nContext();

  const managedIds = new Set(Object.keys(managedSessions));
  const adapterNames = [...new Set(discoveredSessions.map((s) => s.adapterName))];
  const filteredSessions = adapterFilter === 'all'
    ? discoveredSessions
    : discoveredSessions.filter((s) => s.adapterName === adapterFilter);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    const importable = filteredSessions.filter((s) => !managedIds.has(s.id));
    const allSelected = importable.every((s) => selected.has(s.id));
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of importable) next.delete(s.id);
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const s of importable) next.add(s.id);
        return next;
      });
    }
  };

  const handleImport = () => {
    setImporting(true);
    const toImport = discoveredSessions
      .filter((s) => selected.has(s.id))
      .sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const session of toImport) {
      wsImportSession({
        sessionId: session.id,
        adapterName: session.adapterName,
        displayName: session.displayName,
        cwd: session.cwd,
        jsonlPath: session.jsonlPath,
      });
    }
    setTimeout(() => {
      setImporting(false);
      onClose();
    }, 300);
  };

  const selectAllFilter = adapterFilter !== 'all'
    ? `(${adapterFilter === 'claude-code' ? 'CC' : adapterFilter === 'codex-cli' ? 'CX' : adapterFilter === 'opencode' ? 'OC' : adapterFilter === 'gsd' ? 'GSD' : adapterFilter})`
    : '';

  return (
    <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-50">
      <div className="bg-surface-elevated rounded-xl w-[560px] max-h-[70vh] flex flex-col border border-outline shadow-2xl">
        <div className="px-5 py-4 border-b border-outline flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-on-surface">
              {t('discover.title')}
            </h2>
            <p className="text-xs text-on-surface-secondary mt-0.5">
              {t('discover.subtitle', {
                count: discoveredSessions.length,
                suffix: discoveredSessions.length !== 1 ? 's' : '',
              })}
            </p>
            {adapterNames.length > 1 && (
              <div className="flex gap-1 mt-2">
                <button
                  onClick={() => setAdapterFilter('all')}
                  className={`px-2 py-0.5 rounded text-xs ${
                    adapterFilter === 'all'
                      ? 'bg-primary text-primary-on'
                      : 'bg-surface-elevated text-on-surface-muted hover:text-on-surface'
                  }`}
                >
                  {t('discover.all')} ({discoveredSessions.length})
                </button>
                {adapterNames.map((name) => {
                  const count = discoveredSessions.filter((s) => s.adapterName === name).length;
                  const label = name === 'claude-code' ? 'CC' : name === 'codex-cli' ? 'CX' : name === 'opencode' ? 'OC' : name === 'gsd' ? 'GSD' : name;
                  return (
                    <button
                      key={name}
                      onClick={() => setAdapterFilter(name)}
                      className={`px-2 py-0.5 rounded text-xs ${
                        adapterFilter === name
                          ? 'bg-primary text-primary-on'
                          : 'bg-surface-elevated text-on-surface-muted hover:text-on-surface'
                      }`}
                    >
                      {label} ({count})
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-on-surface-secondary hover:text-on-surface text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-1">
          {filteredSessions.length === 0 ? (
            <div className="text-on-surface-muted text-sm text-center py-8">
              {discoveredSessions.length === 0 ? t('discover.noSessions') : t('discover.noFilterMatches')}
            </div>
          ) : (
            <>
              <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-on-surface-secondary cursor-pointer hover:text-on-surface">
                <input
                  type="checkbox"
                  checked={
                    filteredSessions.filter((s) => !managedIds.has(s.id)).length > 0 &&
                    filteredSessions.filter((s) => !managedIds.has(s.id)).every((s) => selected.has(s.id))
                  }
                  onChange={toggleAll}
                  className="rounded border-on-surface-muted"
                />
                {t('discover.selectAll', { filter: selectAllFilter })}
              </label>

              {filteredSessions.map((session) => {
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

        <div className="px-5 py-3 border-t border-outline flex items-center justify-between">
          <span className="text-xs text-on-surface-secondary">
            {t('discover.selected', { count: selected.size })}
          </span>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-sm rounded-lg bg-surface-elevated hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary border border-outline"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleImport}
              disabled={selected.size === 0 || importing}
              className="px-4 py-1.5 text-sm rounded-lg bg-primary hover:bg-primary-hover disabled:opacity-50 text-primary-on font-medium"
            >
              {importing ? t('discover.importing') : `${t('common.import')} ${selected.size > 0 ? `(${selected.size})` : ''}`}
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
  const { t } = useI18nContext();
  const adapterLabel = session.adapterName === 'claude-code' ? 'CC' : session.adapterName === 'codex-cli' ? 'CX' : session.adapterName === 'opencode' ? 'OC' : session.adapterName === 'gsd' ? 'GSD' : session.adapterName;

  return (
    <label
      className={`flex items-start gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors ${
        isManaged
          ? 'opacity-50 cursor-default'
          : isSelected
            ? 'bg-primary-surface border border-primary/30'
            : 'hover:bg-[var(--color-sidebar-hover)] border border-transparent'
      }`}
    >
      <input
        type="checkbox"
        checked={isSelected}
        disabled={isManaged}
        onChange={onToggle}
        className="mt-1 rounded border-on-surface-muted"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-on-surface truncate">
            {session.displayName}
          </span>
          <span className="text-[10px] text-on-surface-muted bg-surface-elevated px-1.5 py-0.5 rounded uppercase">
            {adapterLabel}
          </span>
          {isManaged && (
            <span className="text-[10px] text-success bg-success-surface px-1.5 py-0.5 rounded">
              {t('discover.alreadyImported')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          <span className="text-xs text-on-surface-secondary truncate">{session.cwd}</span>
          <span className="text-xs text-on-surface-muted whitespace-nowrap">
            {formatRelativeTime(session.lastActiveAt, t)}
          </span>
        </div>
        {session.lastMessage && (
          <p className="text-xs text-on-surface-muted mt-0.5 truncate">
            {session.lastMessage}
          </p>
        )}
      </div>
    </label>
  );
}

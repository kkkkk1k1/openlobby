import React, { useEffect, useState } from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import type { SessionSummaryData } from '../stores/lobby-store';
import { wsRequestSessionHistory, wsDiscoverSessions, wsPinSession, wsRenameSession } from '../hooks/useWebSocket';
import { useThemeContext } from '../contexts/ThemeContext';
import { useI18nContext } from '../contexts/I18nContext';
import type { Theme } from '../hooks/useTheme';
import DiscoverDialog from './DiscoverDialog';
import ChannelManagePanel from './ChannelManagePanel';
import AgentsPanel from './AgentsPanel';
import GlobalSettingsDialog from './GlobalSettingsDialog';
import { useVersionCheck } from '../hooks/useVersionCheck';
import { UpdateDialog } from './UpdateDialog';

const APP_VERSION = __APP_VERSION__;

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

function SessionCard({
  session,
  isActive,
  onClick,
  onPin,
  onRename,
}: {
  session: SessionSummaryData;
  isActive: boolean;
  onClick: () => void;
  onPin: (pinned: boolean) => void;
  onRename: (name: string) => void;
}) {
  const { t } = useI18nContext();
  const agentName = useLobbyStore((s) => {
    if (!session.agentId) return undefined;
    const active = s.agents.find((a) => a.id === session.agentId);
    if (active) return active.displayName;
    const deleted = s.deletedAgents.find((a) => a.id === session.agentId);
    return deleted?.displayName;
  });
  const statusConfig: Record<string, { color: string; label: string; pulse?: boolean }> = {
    running: { color: 'bg-success', label: t('sidebar.statusRunning') },
    awaiting_approval: { color: 'bg-warning', label: t('sidebar.statusNeedsApproval'), pulse: true },
    idle: { color: 'bg-yellow-400', label: t('sidebar.statusIdle') },
    stopped: { color: 'bg-danger', label: t('sidebar.statusStopped') },
    error: { color: 'bg-red-500', label: t('sidebar.statusError') },
  };

  const config = statusConfig[session.status] ?? statusConfig.idle;
  const isAwaiting = session.status === 'awaiting_approval';
  const isPinned = session.pinned ?? false;
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(session.displayName);
  const [isHovered, setIsHovered] = useState(false);

  const handleRenameConfirm = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== session.displayName) {
      onRename(trimmed);
    }
    setIsEditing(false);
  };

  const handleRenameCancel = () => {
    setEditName(session.displayName);
    setIsEditing(false);
  };

  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors relative ${
        isActive
          ? 'bg-[var(--color-sidebar-active)] border-l-2 border-primary'
          : isPinned
            ? 'bg-primary-surface border-l-2 border-primary/50'
            : 'hover:bg-[var(--color-sidebar-hover)]'
      } ${
        isAwaiting
          ? 'bg-warning-surface border-l-2 border-warning ring-1 ring-warning/30'
          : ''
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${config.color} ${
            config.pulse ? 'animate-pulse' : ''
          }`}
          title={config.label}
        />
        {isEditing ? (
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameConfirm();
              if (e.key === 'Escape') handleRenameCancel();
            }}
            onBlur={handleRenameConfirm}
            onClick={(e) => e.stopPropagation()}
            className="text-sm font-medium text-on-surface bg-surface-elevated border border-outline rounded px-1 py-0 flex-1 min-w-0 outline-none focus:border-primary"
          />
        ) : (
          <>
            <span className="text-sm font-medium text-on-surface truncate">
              {session.displayName}
            </span>
            {isHovered && (
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  setEditName(session.displayName);
                  setIsEditing(true);
                }}
                className="shrink-0 p-0.5 rounded text-xs text-on-surface-muted hover:text-on-surface cursor-pointer transition-colors"
                title={t('sidebar.rename')}
              >
                ✏️
              </span>
            )}
          </>
        )}
        <span className="flex-1" />
        {(isHovered || isPinned) && !isEditing && (
          <span
            onClick={(e) => {
              e.stopPropagation();
              onPin(!isPinned);
            }}
            className={`shrink-0 p-0.5 rounded text-xs cursor-pointer transition-colors ${
              isPinned
                ? 'text-primary hover:text-primary-hover'
                : 'text-on-surface-muted hover:text-on-surface'
            }`}
            title={isPinned ? t('sidebar.unpin') : t('sidebar.pinToTop')}
          >
            📌
          </span>
        )}
        {session.agentId && (
          <span
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full border bg-purple-900/40 text-purple-200 border-purple-500/50 font-medium max-w-[96px] truncate"
            title={agentName ? t('sidebar.agent.badgeTitle', { name: agentName }) : t('sidebar.agent.label')}
          >
            &#x1F916; {agentName ?? t('sidebar.agent.label')}
          </span>
        )}
        {isAwaiting ? (
          <span className="shrink-0 text-[10px] text-warning bg-warning-surface px-1.5 py-0.5 rounded font-medium animate-pulse">
            {t('sidebar.approval')}
          </span>
        ) : (
          <span className="shrink-0 text-xs text-on-surface-muted uppercase">
            {session.adapterName === 'claude-code' ? 'CC' : session.adapterName === 'codex-cli' ? 'CX' : session.adapterName === 'opencode' ? 'OC' : session.adapterName === 'gsd' ? 'GSD' : session.adapterName}
          </span>
        )}
      </div>
      {session.channelBinding && (
        <div className="flex items-center gap-1 pl-4 mb-0.5">
          <span className="text-[10px] text-info bg-info-surface px-1.5 py-0.5 rounded">
            {session.channelBinding.channelName}: {session.channelBinding.peerDisplayName ?? session.channelBinding.peerId}
          </span>
        </div>
      )}
      <div className="flex items-center justify-between pl-4">
        <span className="text-xs text-on-surface-secondary truncate flex-1">
          {session.lastMessage ?? session.cwd}
        </span>
        <span className="text-xs text-on-surface-muted ml-2 whitespace-nowrap">
          {formatRelativeTime(session.lastActiveAt, t)}
        </span>
      </div>
    </button>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === 'dark') return <span>🌙</span>;
  if (theme === 'light') return <span>☀️</span>;
  return <span>💻</span>;
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
  const amAvailable = useLobbyStore((s) => s.amAvailable);
  const amSessionId = useLobbyStore((s) => s.amSessionId);
  const versionInfo = useVersionCheck();
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [showChannelPanel, setShowChannelPanel] = useState(false);
  const [showAgentsPanel, setShowAgentsPanel] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const agentsCount = useLobbyStore((s) => s.agents.length);
  const agentsPanelRequest = useLobbyStore((s) => s.agentsPanelRequest);
  const dismissAgentsPanel = useLobbyStore((s) => s.dismissAgentsPanel);

  useEffect(() => {
    if (agentsPanelRequest) {
      setShowAgentsPanel(true);
    }
  }, [agentsPanelRequest]);
  const channelProviders = useLobbyStore((s) => s.channelProviders);
  const { theme, setTheme } = useThemeContext();
  const { locale, setLocale, t } = useI18nContext();

  const sortedSessions = Object.values(sessions)
    .filter((s) => s.origin !== 'lobby-manager' && s.origin !== 'agent-manager')
    // Agent-mode sessions are managed from the AgentsPanel / ChannelManagePanel
    // — they can fan out to one-per-peer which would spam the Sidebar with
    // near-identical rows. Hide them here; real-time `session.updated`
    // broadcasts still land in the store so per-session routing keeps working.
    .filter((s) => !s.agentId)
    .sort((a, b) => {
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (bPinned !== aPinned) return bPinned - aPinned;
      return b.lastActiveAt - a.lastActiveAt;
    });

  const handleSelectSession = (id: string) => {
    setActiveSession(id);
    wsRequestSessionHistory(id);
  };

  const cycleTheme = () => {
    const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
  };

  const toggleLocale = () => {
    setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN');
  };

  const themeLabel =
    theme === 'system'
      ? t('common.system')
      : theme === 'light'
        ? t('common.light')
        : t('common.dark');

  return (
    <>
      <aside className="w-full md:w-72 bg-surface-secondary border-r border-outline flex flex-col h-full">
        <div className="px-4 py-3 border-b border-outline flex items-center justify-between">
          <h1 className="text-lg font-bold text-on-surface">OpenLobby</h1>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => wsDiscoverSessions()}
              disabled={!connected}
              title={t('sidebar.importCliSessions')}
              className="px-3 py-1 text-sm rounded-lg bg-primary hover:bg-primary-hover disabled:opacity-50 text-primary-on font-medium"
            >
              + {t('common.import')}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sortedSessions.length === 0 && (
            <div className="text-on-surface-muted text-sm text-center mt-8 px-4">
              {t('sidebar.empty')}
            </div>
          )}
          {sortedSessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              isActive={activeSessionId === session.id}
              onClick={() => handleSelectSession(session.id)}
              onPin={(pinned) => {
                useLobbyStore.getState().updateSession({ ...session, pinned });
                wsPinSession(session.id, pinned);
              }}
              onRename={(name) => {
                useLobbyStore.getState().updateSession({ ...session, displayName: name });
                wsRenameSession(session.id, name);
              }}
            />
          ))}
        </div>

        <div className="px-4 py-2 border-t border-outline">
          <button
            onClick={() => {
              if (lmSessionId) {
                handleSelectSession(lmSessionId);
              }
            }}
            disabled={!lmAvailable || !lmSessionId}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
              activeSessionId === lmSessionId
                ? 'bg-primary-surface text-primary border border-primary/30'
                : 'bg-surface-elevated text-on-surface-secondary hover:bg-[var(--color-sidebar-hover)]'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
            title={lmAvailable ? t('sidebar.openLobbyManagerSession') : t('sidebar.noCliAdapterAvailable')}
          >
            <span>&#x1F3E8;</span>
            <span className="font-medium">{t('sidebar.lobbyManager')}</span>
            {lmAvailable && (
              <span className="ml-auto inline-block w-2 h-2 rounded-full bg-success" />
            )}
          </button>
        </div>

        <div className="px-4 py-2 border-t border-outline">
          <button
            onClick={() => {
              if (amSessionId) {
                handleSelectSession(amSessionId);
              }
            }}
            disabled={!amAvailable || !amSessionId}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
              activeSessionId === amSessionId
                ? 'bg-primary-surface text-primary border border-primary/30'
                : 'bg-surface-elevated text-on-surface-secondary hover:bg-[var(--color-sidebar-hover)]'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
            title={amAvailable ? t('sidebar.openAgentManagerSession') : t('sidebar.noCliAdapterAvailable')}
          >
            <span>&#x1F9D9;</span>
            <span className="font-medium">{t('sidebar.agentManager')}</span>
            {amAvailable && (
              <span className="ml-auto inline-block w-2 h-2 rounded-full bg-success" />
            )}
          </button>
        </div>

        <div className="px-3 py-2 border-t border-outline flex items-center gap-1">
          <button
            onClick={() => setShowChannelPanel(true)}
            title={t('sidebar.imChannels')}
            className="relative p-2 rounded-lg hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary hover:text-on-surface transition-colors"
          >
            <span>&#x1F4AC;</span>
            {channelProviders.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-success text-[9px] leading-none flex items-center justify-center font-medium text-white border border-surface-secondary">
                {channelProviders.filter((p) => p.healthy).length}
              </span>
            )}
          </button>

          <button
            onClick={() => setShowAgentsPanel(true)}
            title={t('sidebar.agents')}
            className="relative p-2 rounded-lg hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary hover:text-on-surface transition-colors"
          >
            <span>&#x1F916;</span>
            {agentsCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-on text-[9px] leading-none flex items-center justify-center font-medium border border-surface-secondary">
                {agentsCount}
              </span>
            )}
          </button>

          <span className="flex-1" />

          <button
            onClick={() => setShowSettingsDialog(true)}
            title={t('common.settings')}
            className="p-2 rounded-lg hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary hover:text-on-surface transition-colors"
          >
            <span>⚙️</span>
          </button>
          <button
            onClick={cycleTheme}
            title={t('sidebar.themeTitle', { theme: themeLabel })}
            className="p-2 rounded-lg hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary hover:text-on-surface transition-colors"
          >
            <ThemeIcon theme={theme} />
          </button>
          <button
            onClick={toggleLocale}
            title={t('sidebar.toggleLanguage')}
            className="p-2 rounded-lg hover:bg-[var(--color-sidebar-hover)] text-on-surface-secondary hover:text-on-surface transition-colors text-xs font-bold min-w-[32px]"
          >
            {locale === 'zh-CN' ? 'EN' : '中'}
          </button>
        </div>

        <div className="px-4 py-1.5 border-t border-outline flex items-center justify-between">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              connected ? 'bg-success' : 'bg-danger'
            }`}
            title={connected ? 'connected' : 'disconnected'}
          />
          <div className="flex items-center gap-1">
            <span className="text-xs text-on-surface-muted">v{APP_VERSION}</span>
            {versionInfo.hasUpdate && versionInfo.latest && (
              <button
                onClick={() => setShowUpdateDialog(true)}
                className="text-xs text-primary hover:text-primary-hover transition-colors"
                title={`v${versionInfo.latest} available`}
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </aside>

      {showDiscoverDialog && (
        <DiscoverDialog onClose={() => setShowDiscoverDialog(false)} />
      )}
      {showChannelPanel && (
        <ChannelManagePanel onClose={() => setShowChannelPanel(false)} />
      )}
      {showAgentsPanel && (
        <AgentsPanel
          highlightId={agentsPanelRequest?.highlightId}
          onClose={() => {
            setShowAgentsPanel(false);
            dismissAgentsPanel();
          }}
        />
      )}
      {showSettingsDialog && (
        <GlobalSettingsDialog onClose={() => setShowSettingsDialog(false)} />
      )}
      {showUpdateDialog && versionInfo.latest && (
        <UpdateDialog
          latestVersion={versionInfo.latest}
          installMode={versionInfo.installMode}
          onClose={() => setShowUpdateDialog(false)}
        />
      )}
    </>
  );
}

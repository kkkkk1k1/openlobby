import { useCallback, useEffect } from 'react';
import { useWebSocketInit, wsSendMessage, wsRespondControl, wsConfigureSession, wsRecoverSession } from './hooks/useWebSocket';
import { useLobbyStore } from './stores/lobby-store';
import { useTheme } from './hooks/useTheme';
import { ThemeContext } from './contexts/ThemeContext';
import { I18nContext, useI18nContext } from './contexts/I18nContext';
import { useI18n } from './hooks/useI18n';
import Sidebar from './components/Sidebar';
import RoomHeader from './components/RoomHeader';
import MessageList from './components/MessageList';
import MessageInput from './components/MessageInput';
import TerminalView from './components/TerminalView';
import MobileDrawer from './components/MobileDrawer';
import MobileNav from './components/MobileNav';
import AgentsPanel from './components/AgentsPanel';
import ChannelManagePanel from './components/ChannelManagePanel';
import GlobalSettingsDialog from './components/GlobalSettingsDialog';
import { UpdateDialog } from './components/UpdateDialog';
import DiscoverDialog from './components/DiscoverDialog';
import { useVersionCheck } from './hooks/useVersionCheck';

const DEV_BACKEND_HOST =
  window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
    ? '127.0.0.1'
    : window.location.hostname;

const WS_URL =
  import.meta.env.VITE_WS_URL ??
  (import.meta.env.DEV
    ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${DEV_BACKEND_HOST}:3001/ws`
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`);

export default function App() {
  useWebSocketInit(WS_URL);
  const themeValue = useTheme();
  const i18nValue = useI18n();
  const versionInfo = useVersionCheck();

  const activeSessionId = useLobbyStore((s) => s.activeSessionId);
  const connected = useLobbyStore((s) => s.connected);
  const activeSession = useLobbyStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  );
  const isSessionAlive =
    activeSession != null &&
    activeSession.status !== 'stopped' &&
    activeSession.status !== 'error';

  const viewMode = useLobbyStore((s) =>
    s.activeSessionId ? (s.viewModeBySession[s.activeSessionId] ?? 'im') : 'im',
  );

  // Mobile UI state
  const drawerOpen = useLobbyStore((s) => s.drawerOpen);
  const setDrawerOpen = useLobbyStore((s) => s.setDrawerOpen);
  const showDiscoverDialog = useLobbyStore((s) => s.showDiscoverDialog);
  const setShowDiscoverDialog = useLobbyStore((s) => s.setShowDiscoverDialog);
  const showAgentsPanel = useLobbyStore((s) => s.showAgentsPanel);
  const setShowAgentsPanel = useLobbyStore((s) => s.setShowAgentsPanel);
  const showChannelPanel = useLobbyStore((s) => s.showChannelPanel);
  const setShowChannelPanel = useLobbyStore((s) => s.setShowChannelPanel);
  const showSettingsDialog = useLobbyStore((s) => s.showSettingsDialog);
  const setShowSettingsDialog = useLobbyStore((s) => s.setShowSettingsDialog);
  const showUpdateDialog = useLobbyStore((s) => s.showUpdateDialog);
  const setShowUpdateDialog = useLobbyStore((s) => s.setShowUpdateDialog);

  const handleCloseDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, [setDrawerOpen]);

  // matchMedia: auto-close drawer when crossing from <768px to >=768px
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) setDrawerOpen(false);
    };
    handler(mql);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [setDrawerOpen]);

  const handleChoiceSelect = useCallback(
    (label: string) => {
      if (!activeSessionId) return;
      if (label === 'Execute Plan') {
        wsConfigureSession(activeSessionId, { permissionMode: 'supervised' });
        wsSendMessage(activeSessionId, 'Please execute the plan above.');
      } else {
        wsSendMessage(activeSessionId, label);
      }
    },
    [activeSessionId],
  );

  return (
    <ThemeContext.Provider value={themeValue}>
      <I18nContext.Provider value={i18nValue}>
        <div className="h-screen h-dvh flex flex-col md:flex-row bg-surface text-on-surface">
          {/* Desktop sidebar — hidden on mobile */}
          <div className="hidden md:flex md:w-72 shrink-0">
            <Sidebar />
          </div>

          {/* Mobile drawer — only mounts children when open */}
          <MobileDrawer open={drawerOpen} onClose={handleCloseDrawer}>
            <Sidebar onSessionSelect={handleCloseDrawer} />
          </MobileDrawer>

          {/* Main content area */}
          <main className="flex-1 flex flex-col min-w-0 pb-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom,0px))] md:pb-0">
            {/* Mobile top bar with hamburger — hidden on desktop */}
            <div className="md:hidden flex items-center px-3 py-2 border-b border-outline bg-surface-secondary">
              <button
                onClick={() => setDrawerOpen(true)}
                aria-label="Open navigation menu"
                aria-expanded={drawerOpen}
                aria-controls="mobile-drawer"
                className="w-11 h-11 flex items-center justify-center rounded-lg tap-target"
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="3" y1="6" x2="21" y2="6" />
                  <line x1="3" y1="12" x2="21" y2="12" />
                  <line x1="3" y1="18" x2="21" y2="18" />
                </svg>
              </button>
              <h1 className="text-sm font-bold ml-3">OpenLobby</h1>
            </div>

            <RoomHeader />

            {activeSessionId ? (
              <>
                {viewMode === 'terminal' ? (
                  <TerminalView sessionId={activeSessionId} />
                ) : (
                  <>
                    <MessageList
                      sessionId={activeSessionId}
                      onControlRespond={wsRespondControl}
                      onChoiceSelect={handleChoiceSelect}
                    />
                    {!isSessionAlive && activeSession && (activeSession.status === 'stopped' || activeSession.status === 'error') && (
                      <SessionStatusBanner
                        sessionId={activeSessionId}
                        isErrored={activeSession.status === 'error'}
                      />
                    )}
                    <MessageInput
                      onSend={(content) => wsSendMessage(activeSessionId, content)}
                      disabled={!connected || !isSessionAlive}
                      placeholder={
                        isSessionAlive
                          ? undefined
                          : i18nValue.t('app.sessionEndedHint')
                      }
                    />
                  </>
                )}
              </>
            ) : (
              <>
                {/* Mobile empty state */}
                <div className="flex-1 flex items-center justify-center md:hidden">
                  <div className="text-center text-on-surface-muted px-4">
                    <p className="text-sm">{i18nValue.t('app.mobileEmptyState')}</p>
                  </div>
                </div>
                {/* Desktop empty state */}
                <div className="hidden md:flex flex-1 items-center justify-center">
                  <div className="text-center text-on-surface-muted">
                    <p className="text-lg mb-2">{i18nValue.t('app.emptyStateTitle')}</p>
                    <p className="text-sm">{i18nValue.t('app.emptyStateHint')}</p>
                  </div>
                </div>
              </>
            )}
          </main>

          <MobileNav />

          {/* Dialogs — rendered at App level, triggered from Sidebar toolbar and MobileNav */}
          {showDiscoverDialog && (
            <DiscoverDialog onClose={() => setShowDiscoverDialog(false)} />
          )}
          {showAgentsPanel && (
            <AgentsPanel onClose={() => setShowAgentsPanel(false)} />
          )}
          {showChannelPanel && (
            <ChannelManagePanel onClose={() => setShowChannelPanel(false)} />
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
        </div>
      </I18nContext.Provider>
    </ThemeContext.Provider>
  );
}

function SessionStatusBanner({ sessionId, isErrored }: { sessionId: string; isErrored: boolean }) {
  const { t } = useI18nContext();

  return (
    <div className="flex items-center justify-center gap-3 px-4 py-2 bg-surface-secondary border-t border-outline">
      <span className="text-xs text-on-surface-muted">
        {isErrored ? t('app.sessionErrored') : t('app.sessionStopped')}
      </span>
      <button
        onClick={() => wsRecoverSession(sessionId)}
        className="text-xs px-3 py-1 rounded bg-primary hover:bg-primary-hover text-primary-on transition-colors"
      >
        {t('app.recoverToIdle')}
      </button>
    </div>
  );
}

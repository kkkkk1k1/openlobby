import { useCallback, useEffect } from 'react';
import { useWebSocketInit, wsSendMessage, wsRespondControl, wsConfigureSession, wsRecoverSession } from './hooks/useWebSocket';
import { useLobbyStore } from './stores/lobby-store';
import { useTheme } from './hooks/useTheme';
import { ThemeContext } from './contexts/ThemeContext';
import { I18nContext, useI18nContext } from './contexts/I18nContext';
import { useI18n } from './hooks/useI18n';
import { useVersionCheck } from './hooks/useVersionCheck';
import Sidebar from './components/Sidebar';
import MobileDrawer from './components/MobileDrawer';
import MobileNav from './components/MobileNav';
import RoomHeader from './components/RoomHeader';
import MessageList from './components/MessageList';
import MessageInput from './components/MessageInput';
import TerminalView from './components/TerminalView';
import AgentsPanel from './components/AgentsPanel';
import ChannelManagePanel from './components/ChannelManagePanel';
import GlobalSettingsDialog from './components/GlobalSettingsDialog';
import { UpdateDialog } from './components/UpdateDialog';
import DiscoverDialog from './components/DiscoverDialog';

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

  // Dialog / drawer state
  const drawerOpen = useLobbyStore((s) => s.drawerOpen);
  const setDrawerOpen = useLobbyStore((s) => s.setDrawerOpen);
  const showAgentsPanel = useLobbyStore((s) => s.showAgentsPanel);
  const setShowAgentsPanel = useLobbyStore((s) => s.setShowAgentsPanel);
  const showChannelPanel = useLobbyStore((s) => s.showChannelPanel);
  const setShowChannelPanel = useLobbyStore((s) => s.setShowChannelPanel);
  const showSettingsDialog = useLobbyStore((s) => s.showSettingsDialog);
  const setShowSettingsDialog = useLobbyStore((s) => s.setShowSettingsDialog);
  const showUpdateDialog = useLobbyStore((s) => s.showUpdateDialog);
  const setShowUpdateDialog = useLobbyStore((s) => s.setShowUpdateDialog);
  const showDiscoverDialog = useLobbyStore((s) => s.showDiscoverDialog);
  const setShowDiscoverDialog = useLobbyStore((s) => s.setShowDiscoverDialog);
  const agentsPanelRequest = useLobbyStore((s) => s.agentsPanelRequest);
  const dismissAgentsPanel = useLobbyStore((s) => s.dismissAgentsPanel);

  // Session state
  const activeSessionId = useLobbyStore((s) => s.activeSessionId);
  const connected = useLobbyStore((s) => s.connected);
  const activeSession = useLobbyStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] : undefined,
  );
  const isSessionAlive =
    activeSession != null &&
    activeSession.status !== 'stopped' &&
    activeSession.status !== 'error';
  const sessions = useLobbyStore((s) => s.sessions);
  const sessionCount = Object.keys(sessions).length;

  const viewMode = useLobbyStore((s) =>
    s.activeSessionId ? (s.viewModeBySession[s.activeSessionId] ?? 'im') : 'im',
  );

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

  // React to agentsPanelRequest — triggers showAgentsPanel when programmatic open requested
  useEffect(() => {
    if (agentsPanelRequest) {
      setShowAgentsPanel(true);
    }
  }, [agentsPanelRequest]);

  // Close drawer on breakpoint cross (>=768px)
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 768px)');
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) {
        setDrawerOpen(false);
      }
    };
    handler(mql);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [setDrawerOpen]);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Mobile empty state: no sessions + drawer closed
  const showMobileEmpty = sessionCount === 0 && !drawerOpen;

  return (
    <ThemeContext.Provider value={themeValue}>
      <I18nContext.Provider value={i18nValue}>
        <div className="h-screen h-dvh flex flex-col md:flex-row bg-surface text-on-surface">
          {/* Desktop sidebar — hidden on mobile */}
          <div className="hidden md:flex md:w-72 shrink-0">
            <Sidebar />
          </div>

          {/* Mobile drawer — only mounts children when open */}
          <MobileDrawer open={drawerOpen} onClose={closeDrawer}>
            <Sidebar onSessionSelect={() => setDrawerOpen(false)} />
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
                className="w-11 h-11 flex items-center justify-center rounded-lg"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
                {/* Mobile empty state — only when no sessions + drawer closed, hidden on desktop */}
                {showMobileEmpty && (
                  <div className="flex-1 flex items-center justify-center md:hidden">
                    <div className="text-center text-on-surface-muted px-4">
                      <p className="text-sm">{i18nValue.t('app.mobileEmptyState')}</p>
                    </div>
                  </div>
                )}
                {/* Desktop empty state — hidden on mobile via CSS */}
                <div className="flex-1 hidden md:flex items-center justify-center">
                  <div className="text-center text-on-surface-muted">
                  <p className="text-lg mb-2">{i18nValue.t('app.emptyStateTitle')}</p>
                  <p className="text-sm">{i18nValue.t('app.emptyStateHint')}</p>
                </div>
              </div>
            </>
            )}
          </main>

          {/* Mobile bottom nav */}
          <MobileNav />

          {/* Dialogs — lifted from Sidebar to App for shared access */}
          {showDiscoverDialog && (
            <DiscoverDialog onClose={() => setShowDiscoverDialog(false)} />
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

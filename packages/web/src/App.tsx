import { useCallback, useEffect } from 'react';
import { useWebSocketInit, wsSendMessage, wsRespondControl, wsConfigureSession, wsRecoverSession } from './hooks/useWebSocket';
import { useLobbyStore } from './stores/lobby-store';
import { useTheme } from './hooks/useTheme';
import { ThemeContext } from './contexts/ThemeContext';
import { I18nContext, useI18nContext } from './contexts/I18nContext';
import { useI18n } from './hooks/useI18n';
import { useVersionCheck } from './hooks/useVersionCheck';
import Sidebar from './components/Sidebar';
import RoomHeader from './components/RoomHeader';
import MessageList from './components/MessageList';
import MessageInput from './components/MessageInput';
import TerminalView from './components/TerminalView';
import MobileDrawer from './components/MobileDrawer';
import MobileNav from './components/MobileNav';
import DiscoverDialog from './components/DiscoverDialog';
import ChannelManagePanel from './components/ChannelManagePanel';
import AgentsPanel from './components/AgentsPanel';
import GlobalSettingsDialog from './components/GlobalSettingsDialog';
import { UpdateDialog } from './components/UpdateDialog';

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

  const versionInfo = useVersionCheck();
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

  useEffect(() => {
    if (agentsPanelRequest) {
      setShowAgentsPanel(true);
    }
  }, [agentsPanelRequest, setShowAgentsPanel]);

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
          <Sidebar />

          <main className="flex-1 flex flex-col min-w-0">
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
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center text-on-surface-muted">
                  <p className="text-lg mb-2">{i18nValue.t('app.emptyStateTitle')}</p>
                  <p className="text-sm">{i18nValue.t('app.emptyStateHint')}</p>
                </div>
              </div>
            )}
          </main>
        </div>

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

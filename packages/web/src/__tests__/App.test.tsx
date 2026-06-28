import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { useLobbyStore } from '../stores/lobby-store';
import { I18nContext } from '../contexts/I18nContext';
import { ThemeContext } from '../contexts/ThemeContext';

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocketInit: vi.fn(),
  wsSendMessage: vi.fn(),
  wsRespondControl: vi.fn(),
  wsConfigureSession: vi.fn(),
  wsRecoverSession: vi.fn(),
  wsAgentList: vi.fn(),
  wsAgentDelete: vi.fn(),
  wsAgentRecover: vi.fn(),
  wsAgentHardDelete: vi.fn(),
  wsListProviders: vi.fn(),
  wsListBindings: vi.fn(),
  wsListAccountBindings: vi.fn(),
  wsAddProvider: vi.fn(),
  wsRemoveProvider: vi.fn(),
  wsToggleProvider: vi.fn(),
  wsUnbind: vi.fn(),
  wsChannelBind: vi.fn(),
  wsBindAgentToAccount: vi.fn(),
  wsUnbindAgentFromAccount: vi.fn(),
  wsWecomQrStart: vi.fn(),
  wsWecomQrCancel: vi.fn(),
  wsSetAdapterDefault: vi.fn(),
  wsSetConfig: vi.fn(),
  wsOpenPty: vi.fn(),
  wsPtyInput: vi.fn(),
  wsPtyResize: vi.fn(),
}));

vi.mock('../hooks/useVersionCheck', () => ({
  useVersionCheck: vi.fn().mockReturnValue({
    hasUpdate: false,
    latest: undefined,
    installMode: undefined,
  }),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,') },
}));

function tHelper(key: string, _params?: Record<string, unknown>): string {
  const map: Record<string, string> = {
    'app.emptyStateTitle': 'Select a session or create a new one',
    'app.emptyStateHint': 'Click "+ Import" in the sidebar to get started',
    'app.mobileEmptyState': 'Tap the menu or Sessions tab to choose a conversation',
    'app.sessionEndedHint': 'Session has ended.',
    'app.sessionErrored': 'Session errored.',
    'app.sessionStopped': 'Session stopped.',
    'app.recoverToIdle': 'Recover to Idle',
    'common.settings': 'Settings',
    'common.copied': 'Copied!',
    'common.copy': 'Copy',
    'common.language': 'Language',
    'common.theme': 'Theme',
    'common.system': 'System',
    'common.light': 'Light',
    'common.dark': 'Dark',
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.confirm': 'Confirm',
    'common.delete': 'Delete',
    'common.add': 'Add',
    'common.import': 'Import',
    'common.accountId': 'Account ID',
    'agents.title': 'Agents',
    'agents.newButton': '+ New Agent',
    'channelManage.title': 'IM Channels',
    'globalSettings.title': 'Settings',
  };
  return map[key] ?? key;
}

function renderApp() {
  return render(
    <ThemeContext.Provider value={{ theme: 'dark', setTheme: vi.fn(), resolvedTheme: 'dark' }}>
      <I18nContext.Provider value={{ t: tHelper, locale: 'en', setLocale: vi.fn() }}>
        <App />
      </I18nContext.Provider>
    </ThemeContext.Provider>,
  );
}

describe('App', () => {
  beforeEach(() => {
    useLobbyStore.setState({
      sessions: {},
      activeSessionId: null,
      connected: true,
      drawerOpen: false,
      showAgentsPanel: false,
      showChannelPanel: false,
      showSettingsDialog: false,
      showUpdateDialog: false,
      showDiscoverDialog: false,
      agentsPanelRequest: null,
      viewModeBySession: {},
    });
  });

  describe('AC7: Dialog rendering from store state', () => {
    it('renders AgentsPanel when showAgentsPanel is true', () => {
      useLobbyStore.setState({ showAgentsPanel: true });
      renderApp();
      // "New Agent" is unique to AgentsPanel (vs MobileNav "Agents" tab)
      expect(screen.getByText('+ New Agent')).toBeInTheDocument();
    });

    it('renders ChannelManagePanel when showChannelPanel is true', () => {
      useLobbyStore.setState({ showChannelPanel: true });
      renderApp();
      expect(screen.getByText('IM Channels')).toBeInTheDocument();
    });

    it('renders GlobalSettingsDialog when showSettingsDialog is true', () => {
      useLobbyStore.setState({ showSettingsDialog: true });
      renderApp();
      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('does not render dialog-specific content when store states are false', () => {
      renderApp();
      expect(screen.queryByText('+ New Agent')).not.toBeInTheDocument();
      expect(screen.queryByText('IM Channels')).not.toBeInTheDocument();
      expect(screen.queryByText('Language')).not.toBeInTheDocument();
    });
  });

  describe('AC6: Mobile empty state', () => {
    it('shows mobile empty state hint when no active session and drawer closed', () => {
      useLobbyStore.setState({ drawerOpen: false });
      renderApp();
      expect(screen.getByText('Tap the menu or Sessions tab to choose a conversation')).toBeInTheDocument();
    });

    it('hides mobile empty state hint when drawer is open', () => {
      useLobbyStore.setState({ drawerOpen: true });
      renderApp();
      expect(screen.queryByText('Tap the menu or Sessions tab to choose a conversation')).not.toBeInTheDocument();
    });
  });

  describe('AC3-AC4: Drawer state', () => {
    it('hamburger aria-expanded reflects drawerOpen', () => {
      useLobbyStore.setState({ drawerOpen: true });
      renderApp();
      const hamburger = screen.getByLabelText('Open navigation menu');
      expect(hamburger).toHaveAttribute('aria-expanded', 'true');
    });

    it('hamburger aria-expanded false when drawer closed', () => {
      useLobbyStore.setState({ drawerOpen: false });
      renderApp();
      const hamburger = screen.getByLabelText('Open navigation menu');
      expect(hamburger).toHaveAttribute('aria-expanded', 'false');
    });
  });
});

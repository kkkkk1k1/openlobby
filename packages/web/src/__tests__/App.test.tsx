import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App from '../App';
import { useLobbyStore } from '../stores/lobby-store';
import { I18nContext } from '../contexts/I18nContext';
import { ThemeContext } from '../contexts/ThemeContext';

// Mock all side-effect hooks
vi.mock('../hooks/useWebSocket', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
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
    wsAddProvider: vi.fn(),
    wsRemoveProvider: vi.fn(),
    wsToggleProvider: vi.fn(),
    wsListBindings: vi.fn(),
    wsListAccountBindings: vi.fn(),
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
    wsRequestSessionHistory: vi.fn(),
    wsDiscoverSessions: vi.fn(),
    wsPinSession: vi.fn(),
    wsRenameSession: vi.fn(),
  };
});

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,') },
}));

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }),
}));

vi.mock('../hooks/useI18n', () => ({
  useI18n: () => ({ locale: 'en', t: tHelper }),
}));

vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('../hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({ hasUpdate: true, latest: '1.0.0', installMode: 'npm' as const }),
}));

function tHelper(key: string, _params?: Record<string, unknown>) {
  const map: Record<string, string> = {
    'app.emptyStateTitle': 'Select a session or create a new one',
    'app.emptyStateHint': 'Click "+ Import" in the sidebar to get started',
    'app.sessionEndedHint': 'Session has ended.',
    'app.sessionErrored': 'Session errored.',
    'app.sessionStopped': 'Session stopped.',
    'app.recoverToIdle': 'Recover to Idle',
    'app.mobileEmptyState': 'Tap the menu or Sessions tab to choose a conversation',
    'nav.sessions': 'Sessions',
    'nav.agents': 'Agents',
    'nav.channels': 'Channels',
    'sidebar.empty': 'No sessions yet',
    'sidebar.statusRunning': 'Running',
    'sidebar.statusNeedsApproval': 'Needs approval',
    'sidebar.statusIdle': 'Idle',
    'sidebar.statusStopped': 'Stopped',
    'sidebar.statusError': 'Error',
    'sidebar.importCliSessions': 'Import CLI sessions',
    'sidebar.pinToTop': 'Pin to top',
    'sidebar.unpin': 'Unpin',
    'sidebar.rename': 'Rename',
    'sidebar.lobbyManager': 'Lobby Manager',
    'sidebar.agentManager': 'Agent Manager',
    'sidebar.agent.badgeTitle': 'Agent: {name}',
    'sidebar.agent.label': 'Agent',
    'sidebar.approval': 'Approval',
    'sidebar.imChannels': 'IM Channels',
    'sidebar.agents': 'Agents',
    'sidebar.themeTitle': 'Theme: {theme}',
    'sidebar.toggleLanguage': 'Toggle Language',
    'sidebar.noCliAdapterAvailable': 'No CLI adapter',
    'sidebar.openLobbyManagerSession': 'Open Lobby Manager',
    'sidebar.openAgentManagerSession': 'Open Agent Manager',
    'common.import': 'Import',
    'common.system': 'System',
    'common.light': 'Light',
    'common.dark': 'Dark',
    'common.settings': 'Settings',
    'common.close': 'Close',
    'common.copy': 'Copy',
    'common.copied': 'Copied!',
    'time.justNow': 'just now',
    'time.minutesAgo': '{count}m ago',
    'time.hoursAgo': '{count}h ago',
    'time.daysAgo': '{count}d ago',
    'agents.title': 'Agents',
    'agents.tabActive': 'Active',
    'agents.tabDeleted': 'Deleted',
    'agents.emptyActive': 'No agents yet',
    'agents.emptyDeleted': 'No deleted agents',
    'agents.newButton': '+ New Agent',
    'channelManage.title': 'IM Channels',
    'channelManage.providersTab': 'Providers',
    'channelManage.bindingsTab': 'Bindings',
    'channelManage.noProviders': 'No providers configured',
    'globalSettings.title': 'Settings',
    'globalSettings.defaultAdapter': 'Default adapter',
    'globalSettings.defaultAdapterHelp': 'Select which adapter',
    'globalSettings.defaultMessageMode': 'Default message mode',
    'globalSettings.defaultNewSessions': 'For new sessions',
    'common.language': 'Language',
    'common.theme': 'Theme',
    'common.terminal': 'Terminal',
  };
  return map[key] ?? key;
}

function renderApp() {
  return render(
    <ThemeContext.Provider value={{ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() } as any}>
      <I18nContext.Provider value={{ locale: 'en', setLocale: vi.fn(), t: tHelper } as any}>
        <App />
      </I18nContext.Provider>
    </ThemeContext.Provider>,
  );
}

describe('App layout — Issue #004', () => {
  // Helper to mock matchMedia
  function setMatchMedia(width: number) {
    const mql = { matches: width >= 768, media: '', onchange: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn() };
    window.matchMedia = vi.fn().mockReturnValue(mql);
    return mql;
  }

  beforeEach(() => {
    setMatchMedia(1024); // desktop by default
    useLobbyStore.setState({
      sessions: {},
      activeSessionId: null,
      connected: true,
      discoveredSessions: [],
      agents: [],
      deletedAgents: [],
      showDiscoverDialog: false,
      showAgentsPanel: false,
      showChannelPanel: false,
      showSettingsDialog: false,
      showUpdateDialog: false,
      drawerOpen: false,
      lmAvailable: false,
      lmSessionId: null,
      amAvailable: false,
      amSessionId: null,
      channelProviders: [],
      channelBindings: [],
      accountBindings: [],
      accountBindingConflict: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.style.overflow = '';
  });

  // JSDOM doesn't implement scrollIntoView
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  // ── AC10: h-dvh fallback ──
  describe('AC10: h-dvh double value fallback', () => {
    it('has h-screen h-dvh on root div', () => {
      const { container } = renderApp();
      const root = container.firstChild as HTMLElement;
      expect(root.className).toContain('h-screen');
      expect(root.className).toContain('h-dvh');
    });
  });

  // ── AC1: Desktop layout ──
  describe('AC1: Desktop (>=768px)', () => {
    beforeEach(() => {
      setMatchMedia(1024);
    });

    it('renders Sidebar visible on desktop', () => {
      renderApp();
      // Sidebar aside has "OpenLobby" — prefer the larger heading (desktop sidebar)
      const headings = screen.getAllByText('OpenLobby');
      expect(headings.length).toBeGreaterThanOrEqual(1);
      // At least one heading is in the sidebar aside
      const sidebarHeading = headings.find(h => h.className.includes('text-lg'));
      expect(sidebarHeading).toBeTruthy();
    });

    it('no MobileNav on desktop', () => {
      renderApp();
      // MobileNav has "Sessions" tab - should not be visible on desktop
      // The nav uses md:hidden so it exists but is hidden
      const nav = document.querySelector('.fixed.bottom-0');
      expect(nav).toBeTruthy();
      expect(nav?.className).toContain('md:hidden');
    });

    it('no hamburger on desktop', () => {
      renderApp();
      // Hamburger button has aria-label "Open navigation menu"
      const hamburger = screen.queryByLabelText('Open navigation menu');
      expect(hamburger).toBeTruthy();
      // It should be wrapped in md:hidden
      const header = hamburger?.closest('.md\\:hidden');
      expect(header).toBeTruthy();
    });
  });

  // ── AC2: Mobile layout ──
  describe('AC2: Mobile (<768px)', () => {
    beforeEach(() => {
      setMatchMedia(375);
    });

    it('MobileNav is visible', () => {
      renderApp();
      const nav = document.querySelector('.fixed.bottom-0');
      expect(nav).toBeTruthy();
      expect(screen.getByText('Sessions')).toBeInTheDocument();
      expect(screen.getByText('Agents')).toBeInTheDocument();
      expect(screen.getByText('Channels')).toBeInTheDocument();
    });

    it('hamburger is visible on mobile', () => {
      renderApp();
      const hamburger = screen.getByLabelText('Open navigation menu');
      expect(hamburger).toBeInTheDocument();
    });

    it('has responsive main padding for mobile nav', () => {
      renderApp();
      const main = document.querySelector('main');
      expect(main?.className).toContain('pb-[calc(var(--mobile-nav-height)+env(safe-area-inset-bottom,0px))]');
    });
  });

  // ── AC3: Hamburger → Drawer ──
  describe('AC3: Hamburger opens drawer', () => {
    beforeEach(() => {
      setMatchMedia(375);
    });

    it('clicking hamburger opens drawer', () => {
      renderApp();
      const hamburger = screen.getByLabelText('Open navigation menu');
      fireEvent.click(hamburger);
      expect(useLobbyStore.getState().drawerOpen).toBe(true);
    });

    it('hamburger has aria-expanded reflecting drawer state', () => {
      renderApp();
      const hamburger = screen.getByLabelText('Open navigation menu');
      expect(hamburger.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(hamburger);
      expect(hamburger.getAttribute('aria-expanded')).toBe('true');
    });

    it('hamburger has aria-controls pointing to mobile-drawer', () => {
      renderApp();
      const hamburger = screen.getByLabelText('Open navigation menu');
      expect(hamburger.getAttribute('aria-controls')).toBe('mobile-drawer');
    });
  });

  // ── AC4: Drawer session click → close + activate ──
  describe('AC4: Drawer session click behavior', () => {
    beforeEach(() => {
      setMatchMedia(375);
    });

    it('opens drawer and allows session selection', () => {
      useLobbyStore.setState({
        sessions: {
          'sess-1': {
            id: 'sess-1',
            adapterName: 'claude-code',
            displayName: 'Test Session',
            status: 'running',
            lastActiveAt: Date.now(),
            messageCount: 0,
            cwd: '/test',
            origin: 'user',
            resumeCommand: '',
            pinned: false,
          },
        },
      });
      renderApp();
      // Open drawer
      fireEvent.click(screen.getByLabelText('Open navigation menu'));

      // Click session in drawer — use within() to scope to dialog
      const drawer = screen.getByRole('dialog');
      const sessionCard = within(drawer).getByText('Test Session');
      fireEvent.click(sessionCard);

      // Session should be active
      expect(useLobbyStore.getState().activeSessionId).toBe('sess-1');
    });
  });

  // ── AC5: matchMedia breakpoint crossing ──
  describe('AC5: matchMedia auto-close on breakpoint', () => {
    it('listens for matchMedia change', () => {
      let mql = setMatchMedia(375);
      renderApp();
      // Open drawer
      useLobbyStore.getState().setDrawerOpen(true);

      // Simulate media query change (mobile → desktop)
      mql.matches = true;
      const listener = mql.addEventListener.mock.calls.find(([e]) => e === 'change')?.[1];
      if (listener) listener({ matches: true } as MediaQueryListEvent);

      expect(useLobbyStore.getState().drawerOpen).toBe(false);
    });
  });

  // ── AC6: Mobile empty state ──
  describe('AC6: Mobile empty state', () => {
    beforeEach(() => {
      setMatchMedia(375);
    });

    it('shows mobile empty state hint when no active session', () => {
      renderApp();
      // Mobile empty state should be visible
      expect(screen.getByText('Tap the menu or Sessions tab to choose a conversation')).toBeInTheDocument();
    });
  });

  // ── AC7: Dialogs rendered from App.tsx ──
  describe('AC7: Dialog rendering from App.tsx', () => {
    it('renders AgentsPanel when showAgentsPanel is true', () => {
      useLobbyStore.setState({ showAgentsPanel: true });
      renderApp();
      // AgentsPanel has heading h2 with "Agents" — prefer that over nav tab text
      const headings = screen.getAllByText('Agents');
      const panelHeading = headings.find(h => h.tagName === 'H2');
      expect(panelHeading).toBeTruthy();
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

    it('renders UpdateDialog when showUpdateDialog is true', () => {
      useLobbyStore.setState({ showUpdateDialog: true });
      renderApp();
      // UpdateDialog shows version info — just check the dialog container renders
      const overlay = document.querySelector('.fixed.inset-0');
      expect(overlay).toBeTruthy();
    });
  });
});

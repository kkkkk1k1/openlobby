import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App from '../App';
import { useLobbyStore } from '../stores/lobby-store';
import { ThemeContext } from '../contexts/ThemeContext';
import { I18nContext } from '../contexts/I18nContext';

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocketInit: vi.fn(),
  wsSendMessage: vi.fn(),
  wsRespondControl: vi.fn(),
  wsConfigureSession: vi.fn(),
  wsRecoverSession: vi.fn(),
  wsRequestSessionHistory: vi.fn(),
  wsDiscoverSessions: vi.fn(),
  wsPinSession: vi.fn(),
  wsRenameSession: vi.fn(),
  wsAgentList: vi.fn(),
  wsListProviders: vi.fn(),
  wsListBindings: vi.fn(),
  wsListAccountBindings: vi.fn(),
  wsOpenPty: vi.fn(),
  wsPtyInput: vi.fn(),
  wsPtyResize: vi.fn(),
}));

vi.mock('../hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({ hasUpdate: false, latest: undefined, installMode: undefined }),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,') },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: vi.fn(() => ({
    loadAddon: vi.fn(),
    open: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    focus: vi.fn(),
    options: {},
    buffer: { active: { length: 0, getLine: vi.fn() } },
  })),
  FitAddon: vi.fn(() => ({ fit: vi.fn() })),
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => ({ fit: vi.fn() })) }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

// Track matchMedia change handler
let triggerBreakpoint: ((matches: boolean) => void) | null = null;

function tHelper(key: string, _params?: Record<string, unknown>) {
  const map: Record<string, string> = {
    'app.emptyStateTitle': 'Select a session or create a new one',
    'app.emptyStateHint': 'Click "+ Import" in the sidebar to get started',
    'app.mobileEmptyState': 'Tap the menu or Sessions tab to choose a conversation',
    'app.sessionEndedHint': 'Session has ended',
    'app.sessionStopped': 'Session stopped',
    'app.sessionErrored': 'Session errored',
    'app.recoverToIdle': 'Recover to Idle',
    'nav.sessions': 'Sessions',
    'nav.agents': 'Agents',
    'nav.channels': 'Channels',
    'agents.title': 'Agents',
    'channelManage.title': 'IM Channels',
    'globalSettings.title': 'Settings',
    'discover.title': 'Discover CLI Sessions',
  };
  return map[key] ?? key;
}

function renderApp() {
  return render(
    <ThemeContext.Provider value={{ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }}>
      <I18nContext.Provider value={{ t: tHelper, locale: 'en', setLocale: vi.fn() }}>
        <App />
      </I18nContext.Provider>
    </ThemeContext.Provider>,
  );
}

beforeEach(() => {
  triggerBreakpoint = null;
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn((_type: string, handler: (e: { matches: boolean }) => void) => {
      triggerBreakpoint = (matches: boolean) => handler({ matches });
    }),
    removeEventListener: vi.fn(),
  })));
  // jsdom doesn't implement scrollIntoView
  Element.prototype.scrollIntoView = vi.fn() as any;
  // Reset store to default state
  useLobbyStore.setState({
    sessions: {},
    activeSessionId: null,
    drawerOpen: false,
    showAgentsPanel: false,
    showChannelPanel: false,
    showSettingsDialog: false,
    showUpdateDialog: false,
    showDiscoverDialog: false,
    connected: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe('App layout integration', () => {
  // ── AC1: Desktop layout ──
  it('AC1: renders Sidebar in desktop wrapper on md+', () => {
    renderApp();
    const sidebar = document.querySelector('.md\\:flex');
    expect(sidebar).toBeTruthy();
  });

  // ── AC2: Mobile layout elements ──
  it('AC2: renders hamburger button on mobile', () => {
    renderApp();
    expect(screen.getByLabelText('Open navigation menu')).toBeInTheDocument();
  });

  it('AC2: renders MobileNav bottom nav', () => {
    renderApp();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Channels')).toBeInTheDocument();
  });

  // ── AC3: Hamburger opens drawer ──
  it('AC3: clicking hamburger sets drawerOpen to true', () => {
    renderApp();
    expect(useLobbyStore.getState().drawerOpen).toBe(false);
    fireEvent.click(screen.getByLabelText('Open navigation menu'));
    expect(useLobbyStore.getState().drawerOpen).toBe(true);
  });

  // ── AC5: matchMedia auto-close ──
  it('AC5: crossing to desktop breakpoint closes drawer', () => {
    useLobbyStore.setState({ drawerOpen: true });
    renderApp();
    expect(triggerBreakpoint).not.toBeNull();
    triggerBreakpoint!(true);
    expect(useLobbyStore.getState().drawerOpen).toBe(false);
  });

  it('AC5: crossing to mobile breakpoint does not close drawer', () => {
    useLobbyStore.setState({ drawerOpen: true });
    renderApp();
    triggerBreakpoint!(false);
    expect(useLobbyStore.getState().drawerOpen).toBe(true);
  });

  // ── AC6: Mobile empty state ──
  it('AC6: shows mobile empty state when no active session and drawer closed', () => {
    renderApp();
    expect(screen.getByText('Tap the menu or Sessions tab to choose a conversation')).toBeInTheDocument();
  });

  it('AC6: mobile empty state hidden when a session is active', () => {
    useLobbyStore.setState({
      sessions: { s1: { id: 's1', displayName: 'Test', adapterName: 'claude-code', status: 'running', lastActiveAt: Date.now(), cwd: '/test', origin: 'web' } as any },
      activeSessionId: 's1',
    });
    renderApp();
    expect(screen.queryByText('Tap the menu or Sessions tab to choose a conversation')).toBeNull();
  });

  // ── AC7: Dialogs render from App store state ──
  it('AC7: renders DiscoverDialog when showDiscoverDialog is true', () => {
    useLobbyStore.setState({ showDiscoverDialog: true });
    renderApp();
    expect(screen.getByRole('heading', { level: 2, name: /Discover CLI Sessions/ })).toBeInTheDocument();
  });

  it('AC7: renders AgentsPanel when showAgentsPanel is true', () => {
    useLobbyStore.setState({ showAgentsPanel: true });
    renderApp();
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings.some((h) => h.textContent === 'Agents')).toBe(true);
  });

  it('AC7: renders ChannelManagePanel when showChannelPanel is true', () => {
    useLobbyStore.setState({ showChannelPanel: true });
    renderApp();
    expect(screen.getByRole('heading', { level: 2, name: 'IM Channels' })).toBeInTheDocument();
  });

  it('AC7: renders SettingsDialog when showSettingsDialog is true', () => {
    useLobbyStore.setState({ showSettingsDialog: true });
    renderApp();
    expect(screen.getByRole('heading', { level: 2, name: 'Settings' })).toBeInTheDocument();
  });

  // ── AC10: h-dvh dual-value ──
  it('AC10: outer div has h-dvh class for dvh support', () => {
    renderApp();
    const outer = document.querySelector('.h-dvh');
    expect(outer).toBeTruthy();
  });
});

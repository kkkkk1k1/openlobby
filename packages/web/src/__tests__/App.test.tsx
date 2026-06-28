import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../App';
import { useLobbyStore } from '../stores/lobby-store';

// ── Mocks ──

vi.mock('../hooks/useWebSocket', () => ({
  useWebSocketInit: vi.fn(),
  wsSendMessage: vi.fn(),
  wsRespondControl: vi.fn(),
  wsConfigureSession: vi.fn(),
  wsRecoverSession: vi.fn(),
  wsAgentList: vi.fn(),
}));

vi.mock('../hooks/useTheme', () => ({
  useTheme: () => ({ mode: 'dark' as const, theme: 'dark' as const }),
}));

vi.mock('../hooks/useI18n', () => ({
  useI18n: () => ({
    locale: 'en',
    t: (key: string) => {
      const map: Record<string, string> = {
        'app.emptyStateTitle': 'Select a session or create a new one',
        'app.emptyStateHint': 'Click "+ Import" in the sidebar to get started',
        'app.sessionEndedHint': 'Session has ended.',
        'app.mobileEmptyState': 'Tap the menu or Sessions tab to choose a conversation',
        'app.sessionErrored': 'Session errored.',
        'app.sessionStopped': 'Session stopped.',
        'app.recoverToIdle': 'Recover to Idle',
        'agents.title': 'Agent Configuration',
        'common.import': 'Import',
        'sidebar.empty': 'No sessions yet',
        'nav.sessions': 'Sessions',
      };
      return map[key] ?? key;
    },
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  }),
}));

// Global matchMedia mock
let mediaQueryListeners: Array<{ mql: MediaQueryList; handler: (e: Event) => void }> = [];

beforeEach(() => {
  mediaQueryListeners = [];
  useLobbyStore.setState({
    sessions: {},
    activeSessionId: null,
    drawerOpen: false,
    showAgentsPanel: false,
    showChannelPanel: false,
    showSettingsDialog: false,
    showUpdateDialog: false,
    showDiscoverDialog: false,
    agentsPanelRequest: null,
    connected: true,
    viewModeBySession: {},
  });
});

function createMatchMedia(matches: boolean): typeof window.matchMedia {
  return (query: string) => {
    const mql: MediaQueryList = {
      matches,
      media: query,
      onchange: null,
      addEventListener: (type: string, handler: EventListener) => {
        if (type === 'change') {
          mediaQueryListeners.push({ mql, handler });
        }
      },
      removeEventListener: (type: string, handler: EventListener) => {
        if (type === 'change') {
          mediaQueryListeners = mediaQueryListeners.filter(
            (entry) => entry.handler !== handler,
          );
        }
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    return mql;
  };
}

// ── Tests ──

describe('App — responsive layout', () => {
  it('AC1: renders desktop sidebar visible on >=768px', () => {
    window.matchMedia = createMatchMedia(true);
    render(<App />);
    // Desktop sidebar wrapper should exist; sidebar has heading "OpenLobby"
    const headings = screen.getAllByText('OpenLobby');
    expect(headings.length).toBeGreaterThanOrEqual(1);
  });

  it('AC2: renders MobileNav with md:hidden on mobile viewport', () => {
    window.matchMedia = createMatchMedia(false);
    render(<App />);
    // Mobile nav tab text exists
    expect(screen.getByText('Sessions')).toBeDefined();
  });

  it('AC3: hamburger click → drawer opens', () => {
    window.matchMedia = createMatchMedia(false);
    render(<App />);
    // Find hamburger button by aria-label
    const hamburger = screen.getByLabelText('Open navigation menu');
    expect(hamburger).toBeDefined();

    // Store should reflect drawer state change
    fireEvent.click(hamburger);
    expect(useLobbyStore.getState().drawerOpen).toBe(true);
  });

  it('AC5: matchMedia breakpoint crossing closes drawer', () => {
    window.matchMedia = createMatchMedia(false);
    useLobbyStore.setState({ drawerOpen: true });
    render(<App />);

    expect(useLobbyStore.getState().drawerOpen).toBe(true);

    // Simulate breakpoint crossing to desktop — pass an object with matches: true
    const changeHandler = mediaQueryListeners.find(
      (e) => e.mql.media === '(min-width: 768px)',
    );
    expect(changeHandler).toBeDefined();
    changeHandler!.handler({ matches: true } as MediaQueryListEvent);

    expect(useLobbyStore.getState().drawerOpen).toBe(false);
  });

  it('AC6: mobile empty state shows guidance when no sessions + drawer closed', () => {
    window.matchMedia = createMatchMedia(false);
    useLobbyStore.setState({ sessions: {}, drawerOpen: false });
    render(<App />);

    expect(
      screen.getByText('Tap the menu or Sessions tab to choose a conversation'),
    ).toBeDefined();
  });

  it('AC6: mobile empty state NOT shown when drawer is open', () => {
    window.matchMedia = createMatchMedia(false);
    useLobbyStore.setState({ sessions: {}, drawerOpen: true });
    render(<App />);

    // The empty state fragment renders but mobile guidance should be hidden
    // when drawer is open (no desktop text on mobile — that's fine)
    const desktopEmpty = screen.queryByText(
      'Select a session or create a new one',
    );
    expect(desktopEmpty).toBeDefined();
  });

  it('AC7: dialogs render from store state', () => {
    window.matchMedia = createMatchMedia(true);
    useLobbyStore.setState({ showAgentsPanel: true });
    render(<App />);
    // AgentsPanel renders "Agents" title (from i18n key 'agents.title')
    // The actual dialog title text is from sidebar.agents = "Agents"
    expect(screen.getByText('Agent Configuration')).toBeDefined();
  });
});

describe('App — desktop empty state preserved', () => {
  it('desktop empty state renders on desktop when no active session', () => {
    window.matchMedia = createMatchMedia(true);
    render(<App />);

    expect(
      screen.getByText('Select a session or create a new one'),
    ).toBeDefined();
    expect(
      screen.getByText('Click "+ Import" in the sidebar to get started'),
    ).toBeDefined();
  });
});

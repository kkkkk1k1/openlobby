import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Sidebar from '../Sidebar';
import { useLobbyStore } from '../../stores/lobby-store';
import { ThemeContext } from '../../contexts/ThemeContext';
import { I18nContext } from '../../contexts/I18nContext';

vi.mock('../hooks/useWebSocket', () => ({
  wsRequestSessionHistory: vi.fn(),
  wsDiscoverSessions: vi.fn(),
  wsPinSession: vi.fn(),
  wsRenameSession: vi.fn(),
}));

vi.mock('../hooks/useVersionCheck', () => ({
  useVersionCheck: () => ({ hasUpdate: false, latest: null }),
}));

vi.mock('../DiscoverDialog', () => ({
  default: () => <div data-testid="discover-dialog" />,
}));
vi.mock('../ChannelManagePanel', () => ({
  default: () => <div data-testid="channel-panel" />,
}));
vi.mock('../AgentsPanel', () => ({
  default: () => <div data-testid="agents-panel" />,
}));
vi.mock('../GlobalSettingsDialog', () => ({
  default: () => <div data-testid="settings-dialog" />,
}));
vi.mock('../UpdateDialog', () => ({
  UpdateDialog: () => <div data-testid="update-dialog" />,
}));

// --- Helpers ---

const mockSession = {
  id: 'session-1',
  adapterName: 'claude-code',
  displayName: 'Test Session',
  status: 'running',
  lastActiveAt: Date.now(),
  messageCount: 0,
  cwd: '/test',
  origin: 'user',
  resumeCommand: 'echo test',
};

function renderSidebar(props: { onSessionSelect?: (id: string) => void } = {}) {
  return render(
    <ThemeContext.Provider
      value={{ theme: 'dark', resolvedTheme: 'dark', setTheme: vi.fn() }}
    >
      <I18nContext.Provider
        value={{ locale: 'en', setLocale: vi.fn(), t: (key: string) => key }}
      >
        <Sidebar {...props} />
      </I18nContext.Provider>
    </ThemeContext.Provider>,
  );
}

function setupSessionInStore(sessionOverrides: Partial<typeof mockSession> = {}) {
  const s = { ...mockSession, ...sessionOverrides };
  useLobbyStore.setState({
    sessions: { [s.id]: s },
    activeSessionId: null,
    connected: true,
  });
}

// --- Tests ---

describe('Sidebar — #003', () => {
  beforeEach(() => {
    useLobbyStore.setState({
      sessions: {},
      activeSessionId: null,
      connected: false,
      showDiscoverDialog: false,
      showAgentsPanel: false,
      showChannelPanel: false,
      showSettingsDialog: false,
      showUpdateDialog: false,
      agents: [],
      deletedAgents: [],
      agentsPanelRequest: null,
      channelProviders: [],
      lmAvailable: false,
      lmSessionId: null,
      amAvailable: false,
      amSessionId: null,
    });
  });

  describe('AC1+AC2: Responsive width', () => {
    it('aside has w-full and md:w-72 classes', () => {
      renderSidebar();
      const aside = screen.getByRole('complementary');
      expect(aside.className).toContain('w-full');
      expect(aside.className).toContain('md:w-72');
    });
  });

  describe('AC3: onSessionSelect prop', () => {
    it('calls onSessionSelect with session id on session card click', () => {
      const onSessionSelect = vi.fn();
      setupSessionInStore();
      renderSidebar({ onSessionSelect });
      const buttons = screen.getAllByRole('button');
      const sessionBtn = buttons.find((b) =>
        b.textContent?.includes('Test Session'),
      );
      expect(sessionBtn).toBeDefined();
      fireEvent.click(sessionBtn!);
      expect(onSessionSelect).toHaveBeenCalledWith('session-1');
    });

    it('does not throw when onSessionSelect is omitted', () => {
      setupSessionInStore();
      expect(() => renderSidebar()).not.toThrow();
    });
  });

  describe('AC4: Dialog state from store', () => {
    it('renders AgentsPanel when store.showAgentsPanel is true', () => {
      useLobbyStore.setState({ showAgentsPanel: true });
      renderSidebar();
      expect(screen.getByTestId('agents-panel')).toBeInTheDocument();
    });

    it('renders ChannelManagePanel when store.showChannelPanel is true', () => {
      useLobbyStore.setState({ showChannelPanel: true });
      renderSidebar();
      expect(screen.getByTestId('channel-panel')).toBeInTheDocument();
    });

    it('renders GlobalSettingsDialog when store.showSettingsDialog is true', () => {
      useLobbyStore.setState({ showSettingsDialog: true });
      renderSidebar();
      expect(screen.getByTestId('settings-dialog')).toBeInTheDocument();
    });

    it('renders UpdateDialog when store.showUpdateDialog is true', () => {
      useLobbyStore.setState({ showUpdateDialog: true });
      renderSidebar();
      expect(screen.getByTestId('update-dialog')).toBeInTheDocument();
    });
  });

  describe('AC5+AC6: SessionCard group-hover + mobile visibility', () => {
    it('session card button has group class', () => {
      setupSessionInStore({ pinned: false });
      renderSidebar();
      const buttons = screen.getAllByRole('button');
      const sessionBtn = buttons.find((b) =>
        b.textContent?.includes('Test Session'),
      );
      expect(sessionBtn).toBeDefined();
      expect(sessionBtn!.className).toContain('group');
    });

    it('rename button has md:invisible and md:group-hover:visible classes', () => {
      setupSessionInStore({ pinned: false });
      renderSidebar();
      const renameBtn = screen.getByText('✏️');
      expect(renameBtn.className).toContain('md:invisible');
      expect(renameBtn.className).toContain('md:group-hover:visible');
    });

    it('unpinned pin button has group-hover visibility classes', () => {
      setupSessionInStore({ pinned: false });
      renderSidebar();
      const pinBtn = screen.getByText('📌');
      expect(pinBtn.className).toContain('md:invisible');
      expect(pinBtn.className).toContain('md:group-hover:visible');
    });

    it('pinned pin button does not have md:invisible', () => {
      setupSessionInStore({ pinned: true });
      renderSidebar();
      const pinBtn = screen.getByText('📌');
      expect(pinBtn.className).not.toContain('md:invisible');
    });
  });
});

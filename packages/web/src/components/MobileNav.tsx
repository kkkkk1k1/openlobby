import React from 'react';
import { useLobbyStore } from '../stores/lobby-store';
import { useI18nContext } from '../contexts/I18nContext';

function MobileNavInner() {
  const { t } = useI18nContext();
  const drawerOpen = useLobbyStore((s) => s.drawerOpen);
  const showAgentsPanel = useLobbyStore((s) => s.showAgentsPanel);
  const showChannelPanel = useLobbyStore((s) => s.showChannelPanel);
  const setDrawerOpen = useLobbyStore((s) => s.setDrawerOpen);
  const setShowAgentsPanel = useLobbyStore((s) => s.setShowAgentsPanel);
  const setShowChannelPanel = useLobbyStore((s) => s.setShowChannelPanel);
  const sessionsCount = useLobbyStore((s) => Object.keys(s.sessions).length);

  return (
    <nav className="fixed bottom-0 inset-x-0 z-40 md:hidden h-[var(--mobile-nav-height)] pb-safe bg-surface-secondary border-t border-outline flex items-center justify-around px-2">
      {/* Sessions tab */}
      <button
        onClick={() => setDrawerOpen(true)}
        className={`flex flex-col items-center justify-center flex-1 h-full text-xs gap-0.5 transition-colors ${
          drawerOpen
            ? 'text-primary'
            : 'text-on-surface-muted hover:text-on-surface-secondary'
        }`}
      >
        <span className="text-base leading-none">&#x1F4AC;</span>
        <span>{t('nav.sessions')}</span>
      </button>

      {/* Agents tab */}
      <button
        onClick={() => setShowAgentsPanel(true)}
        className={`relative flex flex-col items-center justify-center flex-1 h-full text-xs gap-0.5 transition-colors ${
          showAgentsPanel
            ? 'text-primary'
            : 'text-on-surface-muted hover:text-on-surface-secondary'
        }`}
      >
        <span className="text-base leading-none">&#x1F916;</span>
        <span>{t('nav.agents')}</span>
        {sessionsCount > 0 && (
          <span className="absolute -top-0.5 right-[calc(50%-24px)] min-w-[16px] h-4 px-1 rounded-full bg-primary text-primary-on text-[9px] leading-none flex items-center justify-center font-medium border border-surface-secondary">
            {sessionsCount}
          </span>
        )}
      </button>

      {/* Channels tab */}
      <button
        onClick={() => setShowChannelPanel(true)}
        className={`flex flex-col items-center justify-center flex-1 h-full text-xs gap-0.5 transition-colors ${
          showChannelPanel
            ? 'text-primary'
            : 'text-on-surface-muted hover:text-on-surface-secondary'
        }`}
      >
        <span className="text-base leading-none">&#x1F4E1;</span>
        <span>{t('nav.channels')}</span>
      </button>
    </nav>
  );
}

const MobileNav = React.memo(MobileNavInner);
export default MobileNav;

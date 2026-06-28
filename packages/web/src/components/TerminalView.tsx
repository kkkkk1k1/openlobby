import React, { useCallback, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useLobbyStore } from '../stores/lobby-store';
import { wsOpenPty, wsPtyInput, wsPtyResize } from '../hooks/useWebSocket';

interface TerminalViewProps {
  sessionId: string;
}

interface CachedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  element: HTMLDivElement | null;
  opened: boolean;
}

const terminalCache = new Map<string, CachedTerminal>();

function getTerminalTheme(): { background: string; foreground: string; cursor: string } {
  const style = getComputedStyle(document.documentElement);
  return {
    background: style.getPropertyValue('--color-terminal-bg').trim() || '#0c0c0c',
    foreground: style.getPropertyValue('--color-terminal-fg').trim() || '#e0e0e0',
    cursor: style.getPropertyValue('--color-terminal-cursor').trim() || '#4ade80',
  };
}

export default function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cached = terminalCache.get(sessionId);
    if (!cached) {
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
        theme: getTerminalTheme(),
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      cached = { terminal, fitAddon, element: null, opened: false };
      terminalCache.set(sessionId, cached);
    }

    const { terminal, fitAddon } = cached;

    if (!cached.opened) {
      terminal.open(container);
      cached.element = container.querySelector('.xterm') as HTMLDivElement;
      cached.opened = true;
    } else if (cached.element) {
      container.appendChild(cached.element);
    }

    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();

      if (!useLobbyStore.getState().ptyReadyBySession[sessionId]) {
        wsOpenPty(sessionId, terminal.cols, terminal.rows);
      }
    });

    const inputDisposable = terminal.onData((data) => {
      wsPtyInput(sessionId, data);
    });

    const store = useLobbyStore.getState();
    store.registerPtyOutputListener(sessionId, (data: string) => {
      terminal.write(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      wsPtyResize(sessionId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(container);

    // Watch for theme changes (dark class toggle on <html>)
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = getTerminalTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      cancelAnimationFrame(rafId);
      inputDisposable.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      useLobbyStore.getState().unregisterPtyOutputListener(sessionId);

      if (cached!.element && container.contains(cached!.element)) {
        container.removeChild(cached!.element);
      }
    };
  }, [sessionId]);

  const handleCopyLastCommand = useCallback(() => {
    const cached = terminalCache.get(sessionId);
    if (!cached?.terminal) return;
    const buffer = cached.terminal.buffer.active;
    for (let i = buffer.length - 1; i >= Math.max(0, buffer.length - 50); i--) {
      const line = buffer.getLine(i);
      if (line) {
        const text = line.translateToString().trim();
        if (text) {
          navigator.clipboard.writeText(text).catch(() => {});
          return;
        }
      }
    }
  }, [sessionId]);

  return (
    <div className="flex-1 relative bg-[var(--color-terminal-bg)]" style={{ minHeight: 0 }}>
      <div
        ref={containerRef}
        className="absolute inset-0"
      />
      <button
        onClick={handleCopyLastCommand}
        className="md:hidden absolute top-2 right-2 z-10 px-2 py-1 rounded bg-surface-elevated border border-outline text-xs text-on-surface-secondary hover:text-on-surface shadow-sm transition-colors"
        title="Copy last command"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>
    </div>
  );
}

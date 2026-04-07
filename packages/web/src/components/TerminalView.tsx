import React, { useEffect, useRef } from 'react';
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
  /** The wrapper element created by xterm.js — we re-parent this on re-mount */
  element: HTMLDivElement | null;
  opened: boolean;
}

// Cache xterm instances so switching IM/Terminal or switching sessions preserves state
const terminalCache = new Map<string, CachedTerminal>();

export default function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Get or create cached terminal
    let cached = terminalCache.get(sessionId);
    if (!cached) {
      const terminal = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'Menlo', 'Monaco', 'Courier New', monospace",
        theme: {
          background: '#0c0c0c',
          foreground: '#e0e0e0',
          cursor: '#4ade80',
        },
      });
      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      cached = { terminal, fitAddon, element: null, opened: false };
      terminalCache.set(sessionId, cached);
    }

    const { terminal, fitAddon } = cached;

    if (!cached.opened) {
      // First mount: let xterm create its DOM inside the container
      terminal.open(container);
      cached.element = container.querySelector('.xterm') as HTMLDivElement;
      cached.opened = true;
    } else if (cached.element) {
      // Re-mount: move the existing xterm DOM element back into the container
      container.appendChild(cached.element);
    }

    // Fit after layout is computed, then focus
    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      terminal.focus();

      // Request PTY from server if not already open
      if (!useLobbyStore.getState().ptyReadyBySession[sessionId]) {
        wsOpenPty(sessionId, terminal.cols, terminal.rows);
      }
    });

    // User input → PTY
    const inputDisposable = terminal.onData((data) => {
      wsPtyInput(sessionId, data);
    });

    // PTY output → xterm (register listener in Zustand for WebSocket handler to call)
    const store = useLobbyStore.getState();
    store.registerPtyOutputListener(sessionId, (data: string) => {
      terminal.write(data);
    });

    // Resize handling
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      wsPtyResize(sessionId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      inputDisposable.dispose();
      resizeObserver.disconnect();
      useLobbyStore.getState().unregisterPtyOutputListener(sessionId);

      // Detach xterm DOM from container (but don't destroy it — cached for re-mount)
      if (cached!.element && container.contains(cached!.element)) {
        container.removeChild(cached!.element);
      }
    };
  }, [sessionId]);

  return (
    <div
      ref={containerRef}
      className="flex-1 bg-[#0c0c0c] overflow-hidden"
      style={{ minHeight: 0 }}
    />
  );
}

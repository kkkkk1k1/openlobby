import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useLobbyStore } from '../stores/lobby-store';
import { wsOpenPty, wsPtyInput, wsPtyResize } from '../hooks/useWebSocket';

interface TerminalViewProps {
  sessionId: string;
}

// Cache xterm instances so switching back to terminal mode preserves state
const terminalCache = new Map<string, { terminal: Terminal; fitAddon: FitAddon }>();

export default function TerminalView({ sessionId }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ptyReady = useLobbyStore((s) => s.ptyReadyBySession[sessionId] ?? false);
  const registerListener = useLobbyStore((s) => s.registerPtyOutputListener);
  const unregisterListener = useLobbyStore((s) => s.unregisterPtyOutputListener);

  // Get or create terminal instance
  const getTerminal = useCallback(() => {
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
      cached = { terminal, fitAddon };
      terminalCache.set(sessionId, cached);
    }
    return cached;
  }, [sessionId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { terminal, fitAddon } = getTerminal();

    // Mount terminal to DOM
    terminal.open(container);

    // Delay fit() until after the browser has computed layout dimensions,
    // otherwise the container may still have 0×0 size.
    const rafId = requestAnimationFrame(() => {
      fitAddon.fit();
      // Request PTY from server (if not already open) — after fit so cols/rows are correct
      if (!useLobbyStore.getState().ptyReadyBySession[sessionId]) {
        wsOpenPty(sessionId, terminal.cols, terminal.rows);
      }
    });

    // Send user input → PTY
    const inputDisposable = terminal.onData((data) => {
      wsPtyInput(sessionId, data);
    });

    // Register PTY output listener so WebSocket data → xterm
    registerListener(sessionId, (data: string) => {
      terminal.write(data);
    });

    // Handle container resize
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      wsPtyResize(sessionId, terminal.cols, terminal.rows);
    });
    resizeObserver.observe(container);

    return () => {
      cancelAnimationFrame(rafId);
      inputDisposable.dispose();
      resizeObserver.disconnect();
      unregisterListener(sessionId);
      // Don't dispose terminal — keep it cached for re-mount
      // Just detach from DOM by clearing the container
      container.innerHTML = '';
    };
  }, [sessionId, getTerminal, registerListener, unregisterListener]);

  return (
    <div
      ref={containerRef}
      className="flex-1 bg-[#0c0c0c] overflow-hidden"
      style={{ minHeight: 0, position: 'relative' }}
    />
  );
}

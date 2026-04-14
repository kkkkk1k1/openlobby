import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import type { WebSocket } from '@fastify/websocket';

export interface PtySession {
  pty: pty.IPty;
  sessionId: string;
  /** The WebSocket client that opened this PTY */
  client: WebSocket;
}

export class PtyManager {
  private sessions = new Map<string, PtySession>();

  /**
   * Open a PTY for the given session, running the provided resume command.
   * PTY output is streamed to the client WebSocket as pty.output messages.
   */
  open(
    sessionId: string,
    resumeCommand: string,
    cwd: string,
    cols: number,
    rows: number,
    client: WebSocket,
  ): void {
    // If PTY already exists for this session, just re-attach the client
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.client = client;
      this.sendToClient(client, { type: 'pty.opened', sessionId });
      return;
    }

    // Spawn an interactive login shell, then feed the resume command as input.
    // This lets the user see the shell prompt and the resume process in real time.
    const isWindows = process.platform === 'win32';
    const shell = isWindows
      ? (process.env.COMSPEC || 'cmd.exe')
      : (process.env.SHELL || '/bin/bash');
    const shellArgs = isWindows ? [] : ['-l'];

    let ptyProcess: pty.IPty;
    try {
      ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env } as Record<string, string>,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.sendToClient(client, { type: 'pty.error', sessionId, error });
      return;
    }

    const session: PtySession = { pty: ptyProcess, sessionId, client };
    this.sessions.set(sessionId, session);

    // Pipe PTY output → WebSocket
    ptyProcess.onData((data: string) => {
      const current = this.sessions.get(sessionId);
      if (current) {
        this.sendToClient(current.client, {
          type: 'pty.output',
          sessionId,
          data,
        });
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      this.sessions.delete(sessionId);
      this.sendToClient(client, { type: 'pty.closed', sessionId });
    });

    this.sendToClient(client, { type: 'pty.opened', sessionId });

    // Feed resume command into the shell so the user sees it being executed
    ptyProcess.write(resumeCommand + '\n');
  }

  /** Write user input to PTY stdin */
  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.write(data);
    }
  }

  /** Resize PTY */
  resize(sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  /** Close and kill a PTY */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pty.kill();
      this.sessions.delete(sessionId);
    }
  }

  /** Check if a PTY is active for this session */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Clean up all PTYs (for server shutdown) */
  dispose(): void {
    for (const [id, session] of this.sessions) {
      session.pty.kill();
    }
    this.sessions.clear();
  }

  private sendToClient(client: WebSocket, msg: Record<string, unknown>): void {
    if (client.readyState === 1) {
      client.send(JSON.stringify(msg));
    }
  }
}

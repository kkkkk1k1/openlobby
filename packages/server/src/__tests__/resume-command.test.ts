import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  AgentProcess,
  ResumeOptions,
  SpawnOptions,
} from '@openlobby/core';
import { SessionManager, type ManagedSession } from '../session-manager.js';

class FakeProcess extends EventEmitter implements AgentProcess {
  sessionId = 'fake-session';
  readonly adapter = 'fake';
  status: AgentProcess['status'] = 'idle';

  sendMessage(): void {}

  respondControl(): void {}

  updateOptions(): void {}

  interrupt(): void {}

  kill(): void {}
}

function createAdapter(name: string, displayName: string, resumeCommand: string): AgentAdapter {
  return {
    name,
    displayName,
    permissionMeta: {
      modeLabels: {
        auto: 'native-auto',
        supervised: 'native-supervised',
        readonly: 'native-readonly',
      },
    },
    async detect() {
      return { installed: true, version: 'test', path: `/usr/bin/${name}` };
    },
    async spawn(_options: SpawnOptions) {
      return new FakeProcess();
    },
    async resume(_sessionId: string, _options?: ResumeOptions) {
      return new FakeProcess();
    },
    getSessionStoragePath() {
      return '/tmp';
    },
    async readSessionHistory(_sessionId: string) {
      return [];
    },
    async discoverSessions(_cwd?: string) {
      return [];
    },
    getResumeCommand(_sessionId: string) {
      return resumeCommand;
    },
    async listCommands() {
      return [];
    },
  };
}

function createManagedSession(overrides: Partial<ManagedSession>): ManagedSession {
  return {
    id: 'session-1',
    previousIds: [],
    adapterName: 'codex-cli',
    displayName: 'Test Session',
    status: 'idle',
    createdAt: 1,
    lastActiveAt: 1,
    cwd: '/tmp/my project',
    process: new FakeProcess(),
    messageCount: 0,
    model: 'test-model',
    permissionMode: 'auto',
    origin: 'lobby',
    messageMode: 'msg-tidy',
    pinned: false,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      compactCount: 0,
      compactPrompted: false,
    },
    ...overrides,
  };
}

function setActiveSession(manager: SessionManager, session: ManagedSession): void {
  (manager as { sessions: Map<string, ManagedSession> }).sessions.set(session.id, session);
}

describe('SessionManager resume command generation', () => {
  it('quotes POSIX working directories with spaces', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

    const manager = new SessionManager();
    manager.registerAdapter(createAdapter('codex-cli', 'Codex CLI', 'codex resume session-1'));
    const session = createManagedSession({});
    setActiveSession(manager, session);

    const summary = manager.getSessionInfo(session.id);

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(summary?.resumeCommand).toBe("cd '/tmp/my project' && codex resume session-1");
  });

  it('uses cd /d and quotes Windows working directories', () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    const manager = new SessionManager();
    manager.registerAdapter(createAdapter('codex-cli', 'Codex CLI', 'codex resume session-1'));
    const session = createManagedSession({ cwd: 'C:\\Users\\seaso\\My Project' });
    setActiveSession(manager, session);

    const summary = manager.getSessionInfo(session.id);

    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    expect(summary?.resumeCommand).toBe('cd /d "C:\\Users\\seaso\\My Project" && codex resume session-1');
  });
});

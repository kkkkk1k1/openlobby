import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  AgentProcess,
  ResumeOptions,
  SpawnOptions,
} from '@openlobby/core';
import { SessionManager, type ManagedSession } from './session-manager.js';

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
    adapterName: 'opencode',
    displayName: 'Test Session',
    status: 'idle',
    createdAt: 1,
    lastActiveAt: 1,
    cwd: '/tmp/workspace',
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
  it('keeps the adapter resume command untouched for active OpenCode sessions', () => {
    const manager = new SessionManager();
    manager.registerAdapter(createAdapter('opencode', 'OpenCode', 'opencode --session=session-1'));

    const session = createManagedSession({ adapterName: 'opencode' });
    setActiveSession(manager, session);

    const summary = manager.getSessionInfo(session.id);
    expect(summary?.resumeCommand).toBe('cd /tmp/workspace && opencode --session=session-1');
  });

  it('keeps the adapter resume command untouched for active Codex sessions', () => {
    const manager = new SessionManager();
    manager.registerAdapter(createAdapter('codex-cli', 'Codex CLI', 'codex resume session-1'));

    const session = createManagedSession({ adapterName: 'codex-cli' });
    setActiveSession(manager, session);

    const summary = manager.getSessionInfo(session.id);
    expect(summary?.resumeCommand).toBe('cd /tmp/workspace && codex resume session-1');
  });
});

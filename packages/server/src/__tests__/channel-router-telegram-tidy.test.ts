import { describe, expect, it, vi } from 'vitest';
import type { ChannelProvider, LobbyMessage } from '@openlobby/core';
import { ChannelRouterImpl } from '../channel-router.js';
import { initDb, upsertBinding } from '../db.js';

function createSessionManagerStub() {
  return {
    onMessage() {},
    onSessionUpdate() {},
    onNavigate() {},
    onCommands() {},
    onCompactSuggestion() {},
    onCompactComplete() {},
    getSessionMode() {
      return 'msg-tidy';
    },
    getSessionInfo() {
      return {
        id: 'session-1',
        adapterName: 'codex-cli',
        displayName: 'uboot',
        status: 'running',
        lastActiveAt: 0,
        messageCount: 0,
        cwd: '/tmp/uboot',
        origin: 'cli',
        resumeCommand: '',
      };
    },
    resolvePermissionMode() {
      return 'supervised';
    },
    isSessionViewedOnWeb() {
      return false;
    },
  };
}

function createMessage(
  type: LobbyMessage['type'],
  content: LobbyMessage['content'],
  toolName?: string,
): LobbyMessage {
  return {
    id: `${type}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-1',
    timestamp: Date.now(),
    type,
    content,
    meta: toolName ? { toolName } : undefined,
  };
}

function createTelegramProvider(sent: Array<{ text: string; kind?: string }>): ChannelProvider {
  return {
    channelName: 'telegram',
    accountId: 'SawOpenLobbyBot',
    async start() {},
    async stop() {},
    async sendMessage(msg) {
      sent.push({ text: msg.text, kind: msg.kind });
    },
    isHealthy() {
      return true;
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ChannelRouter telegram msg-tidy routing', () => {
  it('suppresses interim assistant commentary until the final result arrives', async () => {
    const db = initDb(':memory:');
    upsertBinding(db, {
      identity_key: 'telegram:SawOpenLobbyBot:342506780',
      channel_name: 'telegram',
      account_id: 'SawOpenLobbyBot',
      peer_id: '342506780',
      peer_display_name: 'Saw Xu',
      target: 'session-1',
      active_session_id: 'session-1',
      created_at: Date.now(),
      last_active_at: Date.now(),
    });

    const sent: Array<{ text: string; kind?: string }> = [];
    const router = new ChannelRouterImpl(createSessionManagerStub() as any, null, db);
    await router.registerProvider(createTelegramProvider(sent));

    (router as any).streamStates.set('telegram:SawOpenLobbyBot:342506780', {
      buffer: '',
      intermediateCount: 0,
      lastFlushAt: 0,
      flushTimer: null,
    });

    (router as any).handleSessionMessage(
      'session-1',
      createMessage('assistant', '我查一下当前仓库分支。'),
    );
    await flushAsyncWork();

    expect(sent).toEqual([]);

    (router as any).handleSessionMessage(
      'session-1',
      createMessage('assistant', '当前分支是 `feat/boot-adb-cherryusb`。'),
    );
    (router as any).handleSessionMessage(
      'session-1',
      createMessage('result', 'Completed'),
    );
    await flushAsyncWork();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'message' });
    expect(sent[0].text).toContain('当前分支是 `feat/boot-adb-cherryusb`。');
    expect(sent[0].text).not.toContain('我查一下当前仓库分支。');
  });

  it('shows only the latest telegram tidy tool preview and skips the tidy summary message', async () => {
    const db = initDb(':memory:');
    upsertBinding(db, {
      identity_key: 'telegram:SawOpenLobbyBot:342506780',
      channel_name: 'telegram',
      account_id: 'SawOpenLobbyBot',
      peer_id: '342506780',
      peer_display_name: 'Saw Xu',
      target: 'session-1',
      active_session_id: 'session-1',
      created_at: Date.now(),
      last_active_at: Date.now(),
    });

    const sent: Array<{ text: string; kind?: string }> = [];
    const router = new ChannelRouterImpl(createSessionManagerStub() as any, null, db);
    await router.registerProvider(createTelegramProvider(sent));

    (router as any).handleSessionMessage(
      'session-1',
      createMessage('tool_use', "/usr/bin/bash -lc 'git status'", 'shell'),
    );
    (router as any).handleSessionMessage(
      'session-1',
      createMessage('tool_use', "/usr/bin/bash -lc 'git branch --show-current'", 'shell'),
    );
    await flushAsyncWork();

    const typingMessages = sent.filter((msg) => msg.kind === 'typing');
    expect(typingMessages).toHaveLength(2);
    expect(typingMessages[1]?.text).toContain("git branch --show-current");
    expect(typingMessages[1]?.text).not.toContain('shell(2)');

    (router as any).handleSessionMessage(
      'session-1',
      createMessage('assistant', '当前分支是 `feat/boot-adb-cherryusb`。'),
    );
    (router as any).handleSessionMessage(
      'session-1',
      createMessage('result', 'Completed'),
    );
    await flushAsyncWork();

    const finalMessages = sent.filter((msg) => msg.kind === 'message');
    expect(finalMessages).toHaveLength(1);
    expect(finalMessages[0]?.text).toContain('当前分支是 `feat/boot-adb-cherryusb`。');
    expect(finalMessages[0]?.text).not.toContain('已完成');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { OutboundChannelMessage } from '@openlobby/core';
import { TelegramBotProvider } from '../telegram-provider.js';

function createTypingMessage(text: string): OutboundChannelMessage {
  return {
    identity: {
      channelName: 'telegram',
      accountId: 'SawOpenLobbyBot',
      peerId: '342506780',
      peerDisplayName: 'Saw Xu',
    },
    text: `<think>\n${text}\n</think>`,
    kind: 'typing',
  };
}

function createPlainMessage(text: string): OutboundChannelMessage {
  return {
    identity: {
      channelName: 'telegram',
      accountId: 'SawOpenLobbyBot',
      peerId: '342506780',
      peerDisplayName: 'Saw Xu',
    },
    text,
    kind: 'message',
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function createProvider() {
  const provider = new TelegramBotProvider({
    channelName: 'telegram',
    accountId: 'SawOpenLobbyBot',
    credentials: { botToken: 'test-token' },
  });

  const api = {
    sendMessage: vi.fn(),
    editMessageText: vi.fn(),
    sendChatAction: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
  };

  (provider as any).api = api;
  return { provider, api };
}

describe('TelegramBotProvider think message handling', () => {
  it('serializes concurrent think updates onto one telegram message', async () => {
    const { provider, api } = createProvider();
    const deferred = createDeferred<{ message_id: number }>();

    api.sendMessage.mockImplementationOnce(() => deferred.promise);
    api.editMessageText.mockResolvedValue(true);

    const firstUpdate = provider.sendMessage(createTypingMessage('【uboot】正在处理... 🔧 shell'));
    const secondUpdate = provider.sendMessage(
      createTypingMessage("【uboot】正在处理... 🔧 shell\n──\n📄 /usr/bin/bash -lc 'git branch --show-current'"),
    );

    deferred.resolve({ message_id: 123 });
    await Promise.all([firstUpdate, secondUpdate]);

    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).toHaveBeenCalledTimes(1);
    expect(api.editMessageText).toHaveBeenCalledWith(
      '342506780',
      123,
      expect.stringContaining("git branch \\-\\-show\\-current"),
      expect.any(Object),
    );
  });

  it('deletes the active think message before sending the final reply', async () => {
    const { provider, api } = createProvider();

    api.sendMessage.mockResolvedValueOnce({ message_id: 456 });
    api.sendMessage.mockResolvedValueOnce({ message_id: 789 });

    await provider.sendMessage(createTypingMessage('【uboot】正在处理... 🔧 shell'));
    await provider.sendMessage(createPlainMessage('【uboot】\n当前分支是 feat/boot-adb-cherryusb。'));

    expect(api.deleteMessage).toHaveBeenCalledWith('342506780', 456);
    expect(api.sendMessage).toHaveBeenLastCalledWith(
      '342506780',
      '【uboot】\n当前分支是 feat/boot-adb-cherryusb。',
      { disable_web_page_preview: true },
    );
    expect((provider as any).thinkMessages.has('342506780')).toBe(false);
  });
});

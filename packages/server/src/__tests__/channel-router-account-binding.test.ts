import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentAdapter,
  AgentProcess,
  ChannelIdentity,
  ChannelProvider,
  InboundChannelMessage,
  OutboundChannelMessage,
  ResumeOptions,
  SpawnOptions,
} from '@openlobby/core';
import { toAgentPeerKey } from '@openlobby/core';
import {
  initDb,
  upsertBinding,
  getAccountBinding,
  getAllAccountBindings,
  getBinding,
  migrateLegacyAgentBindings,
  type ChannelBindingRow,
} from '../db.js';
import { SessionManager } from '../session-manager.js';
import { AgentRegistry } from '../agent-registry.js';
import { ChannelRouterImpl } from '../channel-router.js';

class StubProcess extends EventEmitter implements AgentProcess {
  sessionId: string;
  readonly adapter = 'stub';
  status: AgentProcess['status'] = 'running';
  public killed = false;
  public sentMessages: string[] = [];

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  sendMessage(text: string): void {
    this.sentMessages.push(text);
  }
  respondControl(): void {}
  updateOptions(): void {}
  interrupt(): void {}
  kill(): void {
    this.killed = true;
    this.status = 'stopped';
    this.emit('exit', 0);
  }
}

interface StubAdapter extends AgentAdapter {
  spawnCount: number;
  resumeCount: number;
  spawnedProcesses: StubProcess[];
  lastSpawn?: SpawnOptions;
}

function createStubAdapter(name = 'stub'): StubAdapter {
  let counter = 0;
  const spawnedProcesses: StubProcess[] = [];
  const adapter: StubAdapter = {
    name,
    displayName: 'Stub',
    spawnCount: 0,
    resumeCount: 0,
    spawnedProcesses,
    permissionMeta: {
      modeLabels: {
        auto: 'auto',
        supervised: 'supervised',
        readonly: 'readonly',
      },
    },
    async detect() {
      return { installed: true, version: 'test' };
    },
    async spawn(options: SpawnOptions) {
      adapter.lastSpawn = options;
      adapter.spawnCount += 1;
      counter += 1;
      const proc = new StubProcess(`${name}-session-${counter}`);
      spawnedProcesses.push(proc);
      return proc;
    },
    async resume(sessionId: string, _options?: ResumeOptions) {
      adapter.resumeCount += 1;
      const proc = new StubProcess(sessionId);
      spawnedProcesses.push(proc);
      return proc;
    },
    getSessionStoragePath() {
      return '/tmp';
    },
    async readSessionHistory() {
      return [];
    },
    async discoverSessions() {
      return [];
    },
    getResumeCommand(sessionId: string) {
      return `stub --resume ${sessionId}`;
    },
    async listCommands() {
      return [];
    },
  };
  return adapter;
}

interface RecordedMessage {
  text: string;
  kind?: string;
  peerId: string;
}

function createStubProvider(
  channelName: string,
  accountId: string,
  sent: RecordedMessage[],
): ChannelProvider {
  return {
    channelName,
    accountId,
    async start() {},
    async stop() {},
    async sendMessage(msg: OutboundChannelMessage) {
      sent.push({
        text: msg.text,
        kind: msg.kind,
        peerId: msg.identity.peerId,
      });
    },
    isHealthy() {
      return true;
    },
  };
}

function makeInbound(
  identity: ChannelIdentity,
  text: string,
): InboundChannelMessage {
  return {
    externalMessageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    identity,
    text,
    timestamp: Date.now(),
  };
}

describe('ChannelRouter account-level Agent binding', () => {
  let tmp: string;
  let db: Database.Database;
  let agentsRoot: string;
  let sessionManager: SessionManager;
  let registry: AgentRegistry;
  let adapter: StubAdapter;
  let router: ChannelRouterImpl;
  let sent: RecordedMessage[];
  let provider: ChannelProvider;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'ol-cr-acct-'));
    db = initDb(join(tmp, 'sessions.db'));
    agentsRoot = join(tmp, 'agents');

    sessionManager = new SessionManager(db);
    adapter = createStubAdapter('stub');
    sessionManager.registerAdapter(adapter);

    registry = new AgentRegistry(db, agentsRoot);
    sessionManager.setAgentRegistry(registry);

    router = new ChannelRouterImpl(sessionManager, null, registry, db);

    sent = [];
    provider = createStubProvider('test-channel', 'bot-A', sent);
    await router.registerProvider(provider);
  });

  it('routes every peer of a (channel, account) to the bound Agent', async () => {
    registry.create({
      id: 'customer-support',
      displayName: 'Customer Support',
      description: '',
      adapter: 'stub',
      contextFiles: [],
      // Allow group responses without requiring a mention so the test can
      // exercise the fan-out logic directly.
      groupChat: { mentionPatterns: [], requireMention: false },
    });

    const bindResult = router.bindAgentToAccount(
      'test-channel',
      'bot-A',
      'customer-support',
    );
    expect(bindResult.ok).toBe(true);

    const user1Dm: ChannelIdentity = {
      channelName: 'test-channel',
      accountId: 'bot-A',
      peerId: 'user-1',
      peerKind: 'direct',
    };
    const user2Dm: ChannelIdentity = {
      channelName: 'test-channel',
      accountId: 'bot-A',
      peerId: 'user-2',
      peerKind: 'direct',
    };
    const user1InG1: ChannelIdentity = {
      channelName: 'test-channel',
      accountId: 'bot-A',
      peerId: 'user-1',
      peerKind: 'group',
      chatId: 'G1',
    };
    const user2InG1: ChannelIdentity = {
      channelName: 'test-channel',
      accountId: 'bot-A',
      peerId: 'user-2',
      peerKind: 'group',
      chatId: 'G1',
    };

    await router.handleInbound(makeInbound(user1Dm, 'hi from user-1 DM'));
    await router.handleInbound(makeInbound(user2Dm, 'hi from user-2 DM'));
    await router.handleInbound(makeInbound(user1InG1, 'hi from user-1 in G1'));
    await router.handleInbound(makeInbound(user2InG1, 'hi from user-2 in G1'));

    // Four distinct fan-out keys → four spawned sessions.
    expect(adapter.spawnCount).toBe(4);
    // Every text is prefixed with the sender tag so agents can attribute
    // the message to a real user. Identities here have no peerDisplayName,
    // so the tag falls back to peerId.
    const texts = adapter.spawnedProcesses.flatMap((p) => p.sentMessages);
    expect(texts).toContain('[from: user-1] hi from user-1 DM');
    expect(texts).toContain('[from: user-2] hi from user-2 DM');
    expect(texts).toContain('[from: user-1] hi from user-1 in G1');
    expect(texts).toContain('[from: user-2] hi from user-2 in G1');

    // No peer-level binding rows should have been written for the account.
    expect(getBinding(db, 'test-channel:bot-A:user-1')).toBeUndefined();
    expect(getBinding(db, 'test-channel:bot-A:user-2')).toBeUndefined();
  });

  it('prefixes inbound text with [from: <peerId>] so agents can see the real sender', async () => {
    // Regression: identity.{peerId, peerDisplayName} used to be dropped at the
    // sessionManager.sendMessage boundary, so agents that need to attribute a
    // message (e.g. arcs-sdk-collector's reporter field, sz-task audit log) saw
    // only msg.text and fell back to anonymous defaults. The router must inject
    // the sender into the text itself.
    registry.create({
      id: 'attributable',
      displayName: 'Attributable Agent',
      description: '',
      adapter: 'stub',
      contextFiles: [],
      groupChat: { mentionPatterns: [], requireMention: false },
    });

    const bindResult = router.bindAgentToAccount(
      'test-channel',
      'bot-A',
      'attributable',
    );
    expect(bindResult.ok).toBe(true);

    const identity: ChannelIdentity = {
      channelName: 'test-channel',
      accountId: 'bot-A',
      peerId: 'kyhuang',
      peerKind: 'direct',
    };

    await router.handleInbound(makeInbound(identity, 'hi'));

    expect(adapter.spawnCount).toBe(1);
    const proc = adapter.spawnedProcesses[0]!;
    expect(proc.sentMessages).toHaveLength(1);
    expect(proc.sentMessages[0]!.startsWith('[from: kyhuang]')).toBe(true);
    expect(proc.sentMessages[0]).toBe('[from: kyhuang] hi');
  });

  it('prefers peerDisplayName over peerId in the sender tag when present', async () => {
    registry.create({
      id: 'display-name-agent',
      displayName: 'Display Name Agent',
      description: '',
      adapter: 'stub',
      contextFiles: [],
      groupChat: { mentionPatterns: [], requireMention: false },
    });
    router.bindAgentToAccount('test-channel', 'bot-A', 'display-name-agent');

    const identity: ChannelIdentity = {
      channelName: 'test-channel',
      accountId: 'bot-A',
      peerId: 'wxid_abc123',
      peerDisplayName: 'Kun Huang',
      peerKind: 'direct',
    };

    await router.handleInbound(makeInbound(identity, 'ping'));

    const proc = adapter.spawnedProcesses[0]!;
    expect(proc.sentMessages[0]).toBe('[from: Kun Huang] ping');
  });

  it('toAgentPeerKey produces distinct keys for direct/group + user', () => {
    const user1Dm: ChannelIdentity = {
      channelName: 'c', accountId: 'a', peerId: 'user-1', peerKind: 'direct',
    };
    const user2Dm: ChannelIdentity = {
      channelName: 'c', accountId: 'a', peerId: 'user-2', peerKind: 'direct',
    };
    const user1G1: ChannelIdentity = {
      channelName: 'c', accountId: 'a', peerId: 'user-1', peerKind: 'group', chatId: 'G1',
    };
    const user2G1: ChannelIdentity = {
      channelName: 'c', accountId: 'a', peerId: 'user-2', peerKind: 'group', chatId: 'G1',
    };

    const keys = new Set([
      toAgentPeerKey(user1Dm),
      toAgentPeerKey(user2Dm),
      toAgentPeerKey(user1G1),
      toAgentPeerKey(user2G1),
    ]);
    expect(keys.size).toBe(4);
    expect(toAgentPeerKey(user1Dm)).toBe('direct:user-1');
    expect(toAgentPeerKey(user1G1)).toBe('group:G1:user-1');
  });

  it('rejects bindAgentToAccount when peer-level bindings exist (peer → account exclusivity)', () => {
    const now = Date.now();
    const peerRow: ChannelBindingRow = {
      identity_key: 'X:Y:Z',
      channel_name: 'X',
      account_id: 'Y',
      peer_id: 'Z',
      peer_display_name: null,
      peer_kind: 'direct',
      target: 'some-session-id',
      active_session_id: 'some-session-id',
      agent_id: null,
      created_at: now,
      last_active_at: now,
    };
    upsertBinding(db, peerRow);

    const result = router.bindAgentToAccount('X', 'Y', 'agent-id');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.identityKey).toBe('X:Y:Z');

    // No account binding row was written.
    expect(getAccountBinding(db, 'X', 'Y')).toBeUndefined();
  });

  it('rejects bindIdentity for a peer when its (channel, account) is locked to an Agent (account → peer exclusivity)', async () => {
    registry.create({
      id: 'locked-agent',
      displayName: 'Locked',
      description: '',
      adapter: 'stub',
      contextFiles: [],
    });
    const r = router.bindAgentToAccount('test-channel', 'bot-A', 'locked-agent');
    expect(r.ok).toBe(true);

    const identity: ChannelIdentity = {
      channelName: 'test-channel',
      accountId: 'bot-A',
      peerId: 'user-99',
      peerKind: 'direct',
    };
    await expect(
      router.bindIdentity(identity, 'lobby-manager'),
    ).rejects.toThrow(/locked to Agent/);

    // Account binding still present, no peer rows written.
    expect(getAccountBinding(db, 'test-channel', 'bot-A')).toBeDefined();
    expect(getBinding(db, 'test-channel:bot-A:user-99')).toBeUndefined();
  });

  it('migrates legacy peer-level Agent bindings into channel_account_bindings and is idempotent', () => {
    const now = Date.now();
    const peerWithAgent1: ChannelBindingRow = {
      identity_key: 'wecom:botX:userA',
      channel_name: 'wecom',
      account_id: 'botX',
      peer_id: 'userA',
      peer_display_name: null,
      peer_kind: 'direct',
      target: 'lobby-manager',
      active_session_id: null,
      agent_id: 'reviewer',
      created_at: now,
      last_active_at: now,
    };
    const peerWithAgent2: ChannelBindingRow = {
      identity_key: 'wecom:botY:userB',
      channel_name: 'wecom',
      account_id: 'botY',
      peer_id: 'userB',
      peer_display_name: null,
      peer_kind: 'direct',
      target: 'lobby-manager',
      active_session_id: null,
      agent_id: 'helper',
      created_at: now,
      last_active_at: now,
    };
    const peerWithoutAgent: ChannelBindingRow = {
      identity_key: 'wecom:botZ:userC',
      channel_name: 'wecom',
      account_id: 'botZ',
      peer_id: 'userC',
      peer_display_name: null,
      peer_kind: 'direct',
      target: 'lobby-manager',
      active_session_id: null,
      agent_id: null,
      created_at: now,
      last_active_at: now,
    };
    upsertBinding(db, peerWithAgent1);
    upsertBinding(db, peerWithAgent2);
    upsertBinding(db, peerWithoutAgent);

    const first = migrateLegacyAgentBindings(db);
    expect(first.legacyRows).toBe(2);
    expect(first.promoted).toBe(2);
    expect(first.skipped).toBe(0);

    const acct = getAllAccountBindings(db);
    expect(acct).toHaveLength(2);
    const byId = new Map(acct.map((r) => [r.account_id, r.agent_id]));
    expect(byId.get('botX')).toBe('reviewer');
    expect(byId.get('botY')).toBe('helper');

    // Legacy peer rows with agent_id are gone; the non-agent row survives.
    expect(getBinding(db, 'wecom:botX:userA')).toBeUndefined();
    expect(getBinding(db, 'wecom:botY:userB')).toBeUndefined();
    expect(getBinding(db, 'wecom:botZ:userC')).toBeDefined();

    // Idempotent: second run reports no legacy rows and leaves the state alone.
    const second = migrateLegacyAgentBindings(db);
    expect(second.legacyRows).toBe(0);
    expect(second.promoted).toBe(0);
    expect(getAllAccountBindings(db)).toHaveLength(2);
  });

  it('leaves legacy peer-level bindings without agent_id unchanged', async () => {
    const now = Date.now();
    upsertBinding(db, {
      identity_key: 'test-channel:bot-A:peer-X',
      channel_name: 'test-channel',
      account_id: 'bot-A',
      peer_id: 'peer-X',
      peer_display_name: null,
      peer_kind: 'direct',
      target: 'lobby-manager',
      active_session_id: null,
      agent_id: null,
      created_at: now,
      last_active_at: now,
    });

    const result = migrateLegacyAgentBindings(db);
    expect(result.legacyRows).toBe(0);
    expect(result.promoted).toBe(0);

    const row = getBinding(db, 'test-channel:bot-A:peer-X');
    expect(row).toBeDefined();
    expect(row!.target).toBe('lobby-manager');
    expect(row!.agent_id).toBeNull();
  });
});

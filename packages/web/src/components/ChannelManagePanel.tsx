import React, { useState, useEffect, useMemo } from 'react';
import QRCode from 'qrcode';
import { useLobbyStore } from '../stores/lobby-store';
import { useI18nContext } from '../contexts/I18nContext';
import {
  wsListProviders,
  wsAddProvider,
  wsRemoveProvider,
  wsToggleProvider,
  wsListBindings,
  wsListAccountBindings,
  wsUnbind,
  wsChannelBind,
  wsBindAgentToAccount,
  wsUnbindAgentFromAccount,
  wsWecomQrStart,
  wsWecomQrCancel,
} from '../hooks/useWebSocket';
import type {
  ChannelBindingData,
  ChannelAccountBindingData,
  ChannelProviderData,
} from '../stores/lobby-store';

interface Props {
  onClose: () => void;
}

export default function ChannelManagePanel({ onClose }: Props) {
  const [tab, setTab] = useState<'providers' | 'bindings'>('providers');
  const [showAddForm, setShowAddForm] = useState(false);

  const providers = useLobbyStore((s) => s.channelProviders);
  const bindings = useLobbyStore((s) => s.channelBindings);
  const accountBindings = useLobbyStore((s) => s.accountBindings);
  const { t } = useI18nContext();

  useEffect(() => {
    wsListProviders();
    wsListBindings();
    wsListAccountBindings();
  }, []);

  return (
    <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-secondary rounded-xl p-6 w-full max-w-lg border border-outline max-h-[80vh] max-h-[80dvh] overflow-y-auto w-[calc(100vw-32px)] md:w-96 mx-4 md:mx-0 flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-on-surface">{t('channelManage.title')}</h2>
          <button onClick={onClose} className="text-on-surface-secondary hover:text-on-surface text-xl">
            &times;
          </button>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab('providers')}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === 'providers'
                ? 'bg-primary text-primary-on'
                : 'bg-surface-elevated text-on-surface-secondary hover:text-on-surface'
            }`}
          >
            {t('channelManage.providersTab')} ({providers.length})
          </button>
          <button
            onClick={() => setTab('bindings')}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === 'bindings'
                ? 'bg-primary text-primary-on'
                : 'bg-surface-elevated text-on-surface-secondary hover:text-on-surface'
            }`}
          >
            {t('channelManage.bindingsTab')} ({bindings.length})
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {tab === 'providers' && (
            <>
              {providers.length === 0 && !showAddForm && (
                <p className="text-on-surface-muted text-sm text-center py-8">
                  {t('channelManage.noProviders')}
                </p>
              )}

              {providers.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between bg-surface-elevated rounded-lg p-3"
                >
                  <div className="flex items-center gap-3">
                    <span className={`w-2 h-2 rounded-full ${p.healthy ? 'bg-success' : 'bg-danger'}`} />
                    <div>
                      <span className="text-on-surface text-sm font-medium">
                        {p.channelName}
                      </span>
                      <span className="text-on-surface-muted text-xs ml-2">{p.accountId}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => wsToggleProvider(p.id, !p.enabled)}
                      className={`px-2 py-1 rounded text-xs ${
                        p.enabled
                          ? 'bg-success-surface text-success hover:bg-success-surface/80'
                          : 'bg-surface-elevated text-on-surface-secondary hover:bg-[var(--color-sidebar-hover)] border border-outline'
                      }`}
                    >
                      {p.enabled ? t('channelManage.providerOn') : t('channelManage.providerOff')}
                    </button>
                    <button
                      onClick={() => wsRemoveProvider(p.id)}
                      className="text-danger hover:text-danger-hover text-xs"
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </div>
              ))}

              {showAddForm ? (
                <AddProviderForm onDone={() => setShowAddForm(false)} />
              ) : (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="w-full py-2 border border-dashed border-outline rounded-lg text-on-surface-secondary hover:text-on-surface hover:border-on-surface-muted text-sm"
                >
                  + {t('channelManage.addProvider')}
                </button>
              )}
            </>
          )}

          {tab === 'bindings' && (
            <BindingsTab
              providers={providers}
              bindings={bindings}
              accountBindings={accountBindings}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function AddProviderForm({ onDone }: { onDone: () => void }) {
  const { t } = useI18nContext();

  const channelFields: Record<string, Array<{ key: string; label: string; required: boolean; type: string; placeholder?: string }>> = {
    wecom: [
      { key: 'botId', label: t('channelManage.fieldBotId'), required: true, type: 'text', placeholder: 'aibxxxxxxxx' },
      { key: 'secret', label: t('channelManage.fieldSecret'), required: true, type: 'password' },
    ],
    telegram: [
      { key: 'botToken', label: t('channelManage.fieldBotToken'), required: true, type: 'password', placeholder: '123456:ABC-DEF...' },
      { key: 'webhookUrl', label: t('channelManage.fieldWebhookUrl'), required: false, type: 'text', placeholder: 'https://example.com/webhook/telegram/...' },
      { key: 'webhookSecret', label: t('channelManage.fieldWebhookSecret'), required: false, type: 'password' },
    ],
  };

  const channelOptions: Array<{ value: string; label: string }> = [
    { value: 'wecom', label: t('channelManage.wecomOption') },
    { value: 'telegram', label: t('channelManage.telegramOption') },
  ];

  const [channelName, setChannelName] = useState('wecom');
  const [accountId, setAccountId] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [manualMode, setManualMode] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const qrStatus = useLobbyStore((s) => s.wecomQrStatus);
  const setQrStatus = useLobbyStore((s) => s.setWecomQrStatus);

  const fields = channelFields[channelName] ?? [];
  const isWecom = channelName === 'wecom';

  useEffect(() => {
    if (qrStatus?.status === 'waiting' && qrStatus.qrUrl) {
      QRCode.toDataURL(qrStatus.qrUrl, { width: 256, margin: 2 })
        .then(setQrDataUrl)
        .catch(() => setQrDataUrl(null));
    } else {
      setQrDataUrl(null);
    }
  }, [qrStatus?.status, qrStatus?.qrUrl]);

  useEffect(() => {
    if (qrStatus?.status === 'success' && qrStatus.botId && qrStatus.secret && accountId.trim()) {
      wsAddProvider({
        channelName: 'wecom',
        accountId: accountId.trim(),
        credentials: { botId: qrStatus.botId, secret: qrStatus.secret },
        enabled: true,
      });
      setQrStatus(null);
      onDone();
    }
  }, [qrStatus?.status, qrStatus?.botId, qrStatus?.secret, accountId, onDone, setQrStatus]);

  useEffect(() => {
    return () => {
      wsWecomQrCancel();
      setQrStatus(null);
    };
  }, [setQrStatus]);

  const updateCredential = (key: string, value: string) => {
    setCredentials((prev) => ({ ...prev, [key]: value }));
  };

  const handleChannelChange = (name: string) => {
    setChannelName(name);
    setCredentials({});
    setAccountId('');
    setManualMode(false);
    wsWecomQrCancel();
    setQrStatus(null);
  };

  const isManualValid = () => {
    if (!accountId.trim()) return false;
    return fields.filter((f) => f.required).every((f) => credentials[f.key]?.trim());
  };

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isManualValid()) return;

    const creds: Record<string, string> = {};
    for (const field of fields) {
      const val = credentials[field.key]?.trim();
      if (val) creds[field.key] = val;
    }

    wsAddProvider({
      channelName,
      accountId: accountId.trim(),
      credentials: creds,
      enabled: true,
    });
    onDone();
  };

  const handleStartQr = () => {
    if (!accountId.trim()) return;
    setQrStatus(null);
    wsWecomQrStart();
  };

  if (isWecom && !manualMode) {
    return (
      <div className="bg-surface-elevated rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-on-surface font-medium">{t('channelManage.addWecomScan')}</span>
          <button onClick={onDone} className="text-on-surface-secondary hover:text-on-surface text-xs">{t('common.cancel')}</button>
        </div>

        <div>
          <label className="block text-xs text-on-surface-secondary mb-1">{t('common.accountId')}</label>
          <input
            type="text"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder={t('channelManage.accountIdPlaceholder')}
            className="w-full bg-surface border border-outline rounded px-3 py-1.5 text-sm text-on-surface"
          />
        </div>

        <div className="flex flex-col items-center py-3 space-y-2">
          {!qrStatus && (
            <button
              onClick={handleStartQr}
              disabled={!accountId.trim()}
              className={`px-4 py-2 rounded-lg text-sm ${
                accountId.trim()
                  ? 'bg-primary text-primary-on hover:bg-primary-hover'
                  : 'bg-surface-elevated text-on-surface-muted cursor-not-allowed'
              }`}
            >
              {t('channelManage.generateQr')}
            </button>
          )}

          {qrStatus?.status === 'generating' && (
            <p className="text-on-surface-secondary text-sm">{t('channelManage.generatingQr')}</p>
          )}

          {qrStatus?.status === 'waiting' && qrDataUrl && (
            <>
              <img src={qrDataUrl} alt={t('channelManage.wecomQrAlt')} className="w-48 h-48 rounded-lg" />
              <p className="text-on-surface-secondary text-xs">{t('channelManage.scanWithWecom')}</p>
            </>
          )}

          {qrStatus?.status === 'expired' && (
            <div className="text-center space-y-2">
              <p className="text-warning text-sm">{t('channelManage.qrExpired')}</p>
              <button onClick={handleStartQr} className="px-3 py-1.5 bg-primary text-primary-on rounded text-sm hover:bg-primary-hover">
                {t('channelManage.regenerate')}
              </button>
            </div>
          )}

          {qrStatus?.status === 'error' && (
            <div className="text-center space-y-2">
              <p className="text-danger text-sm">{qrStatus.error ?? t('channelManage.unknownError')}</p>
              <button onClick={handleStartQr} className="px-3 py-1.5 bg-primary text-primary-on rounded text-sm hover:bg-primary-hover">
                {t('common.retry')}
              </button>
            </div>
          )}

          {qrStatus?.status === 'success' && (
            <p className="text-success text-sm">{t('channelManage.scanSuccess')}</p>
          )}
        </div>

        <div className="text-center">
          <button
            onClick={() => { setManualMode(true); wsWecomQrCancel(); setQrStatus(null); }}
            className="text-xs text-on-surface-muted hover:text-on-surface underline"
          >
            {t('channelManage.manualInput')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleManualSubmit} className="bg-surface-elevated rounded-lg p-4 space-y-3">
      <div>
        <label className="block text-xs text-on-surface-secondary mb-1">{t('channelManage.channelType')}</label>
        <select
          value={channelName}
          onChange={(e) => handleChannelChange(e.target.value)}
          className="w-full bg-surface border border-outline rounded px-3 py-1.5 text-sm text-on-surface"
        >
          {channelOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-xs text-on-surface-secondary mb-1">{t('common.accountId')}</label>
        <input
          type="text"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          placeholder={t('channelManage.accountIdPlaceholder')}
          className="w-full bg-surface border border-outline rounded px-3 py-1.5 text-sm text-on-surface"
        />
      </div>

      {fields.map((field) => (
        <div key={field.key}>
          <label className="block text-xs text-on-surface-secondary mb-1">{field.label}</label>
          <input
            type={field.type}
            value={credentials[field.key] ?? ''}
            onChange={(e) => updateCredential(field.key, e.target.value)}
            placeholder={field.placeholder}
            className="w-full bg-surface border border-outline rounded px-3 py-1.5 text-sm text-on-surface"
          />
        </div>
      ))}

      <div className="flex gap-2 justify-end items-center">
        {isWecom && (
          <button
            type="button"
            onClick={() => { setManualMode(false); }}
            className="text-xs text-on-surface-muted hover:text-on-surface underline mr-auto"
          >
            {t('channelManage.backToQr')}
          </button>
        )}
        <button
          type="button"
          onClick={onDone}
          className="px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface"
        >
          {t('common.cancel')}
        </button>
        <button
          type="submit"
          disabled={!isManualValid()}
          className={`px-3 py-1.5 rounded text-sm ${
            isManualValid()
              ? 'bg-primary text-primary-on hover:bg-primary-hover'
              : 'bg-surface-elevated text-on-surface-muted cursor-not-allowed'
          }`}
        >
          {t('common.add')}
        </button>
      </div>
    </form>
  );
}

type BindingTargetKind = 'lobby-manager' | 'session' | 'agent';

function BindingRow({
  binding,
}: {
  binding: import('../stores/lobby-store').ChannelBindingData;
}) {
  const { t } = useI18nContext();
  const agents = useLobbyStore((s) => s.agents);
  const deletedAgents = useLobbyStore((s) => s.deletedAgents);
  const sessions = useLobbyStore((s) => s.sessions);

  const initialKind: BindingTargetKind = binding.agentId
    ? 'agent'
    : binding.target === 'lobby-manager'
      ? 'lobby-manager'
      : 'session';

  const [editing, setEditing] = useState(false);
  const [kind, setKind] = useState<BindingTargetKind>(initialKind);
  const [selectedAgentId, setSelectedAgentId] = useState<string>(binding.agentId ?? '');
  const [selectedSessionId, setSelectedSessionId] = useState<string>(
    binding.target !== 'lobby-manager' ? binding.target : '',
  );

  const boundAgent =
    (binding.agentId && agents.find((a) => a.id === binding.agentId)) ||
    (binding.agentId && deletedAgents.find((a) => a.id === binding.agentId)) ||
    undefined;

  const sessionList = Object.values(sessions).filter((s) => s.origin !== 'lobby-manager');

  const canSave = (() => {
    if (kind === 'lobby-manager') return true;
    if (kind === 'agent') return !!selectedAgentId;
    if (kind === 'session') return !!selectedSessionId;
    return false;
  })();

  const handleSave = () => {
    if (kind === 'lobby-manager') {
      wsChannelBind(binding.identityKey, 'lobby-manager');
    } else if (kind === 'agent') {
      wsChannelBind(binding.identityKey, 'lobby-manager', selectedAgentId);
    } else {
      wsChannelBind(binding.identityKey, selectedSessionId);
    }
    setEditing(false);
  };

  return (
    <div className="bg-surface-elevated rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-on-surface text-sm truncate">
            {binding.peerDisplayName ?? binding.peerId}
            <span className="text-on-surface-muted text-xs ml-2">({binding.channelName})</span>
          </div>
          <div className="text-on-surface-muted text-xs mt-0.5 flex items-center gap-2 flex-wrap">
            <span>
              {t('channelManage.target')}:{' '}
              {binding.agentId
                ? t('channelManage.targetAgent')
                : binding.target === 'lobby-manager'
                  ? t('channelManage.targetLm')
                  : binding.activeSessionId?.slice(0, 8) ?? binding.target.slice(0, 8)}
            </span>
            {binding.agentId && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-purple-900/40 text-purple-200 border-purple-500/50 font-medium">
                &#x1F916; {boundAgent?.displayName ?? binding.agentId}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setEditing((v) => !v)}
            className="text-on-surface-secondary hover:text-on-surface text-xs"
          >
            {editing ? t('common.cancel') : t('channelManage.edit')}
          </button>
          <button
            onClick={() => wsUnbind(binding.identityKey)}
            className="text-on-surface-secondary hover:text-danger text-xs"
          >
            {t('channelManage.unbind')}
          </button>
        </div>
      </div>

      {editing && (
        <div className="border-t border-outline pt-2 space-y-2">
          <div>
            <label className="block text-xs text-on-surface-secondary mb-1">{t('channelManage.targetLabel')}</label>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as BindingTargetKind)}
              className="w-full bg-surface border border-outline rounded px-2 py-1 text-xs text-on-surface"
            >
              <option value="lobby-manager">{t('channelManage.bindTo.lobbyManager')}</option>
              <option value="session">{t('channelManage.bindTo.session')}</option>
              <option value="agent">{t('channelManage.bindTo.agent')}</option>
            </select>
          </div>

          {kind === 'agent' && (
            <div>
              <label className="block text-xs text-on-surface-secondary mb-1">{t('channelManage.agentSelectLabel')}</label>
              <select
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                className="w-full bg-surface border border-outline rounded px-2 py-1 text-xs text-on-surface"
              >
                <option value="">{t('channelManage.agentSelectPlaceholder')}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.displayName} ({a.id})
                  </option>
                ))}
              </select>
            </div>
          )}

          {kind === 'session' && (
            <div>
              <label className="block text-xs text-on-surface-secondary mb-1">{t('channelManage.sessionSelectLabel')}</label>
              <select
                value={selectedSessionId}
                onChange={(e) => setSelectedSessionId(e.target.value)}
                className="w-full bg-surface border border-outline rounded px-2 py-1 text-xs text-on-surface"
              >
                <option value="">{t('channelManage.sessionSelectPlaceholder')}</option>
                {sessionList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.displayName} ({s.id.slice(0, 8)})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={!canSave}
              className={`px-3 py-1 rounded text-xs ${
                canSave
                  ? 'bg-primary text-primary-on hover:bg-primary-hover'
                  : 'bg-surface-elevated text-on-surface-muted cursor-not-allowed'
              }`}
            >
              {t('channelManage.save')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Account-grouped Bindings tab ─────────────────────────────────────────

interface AccountGroupInfo {
  channelName: string;
  accountId: string;
  /** "channelName:accountId" — stable key, matches ChannelAccountBinding.accountKey. */
  accountKey: string;
  /** Optional matching provider row (gives healthy/enabled). */
  provider?: ChannelProviderData;
  peerBindings: ChannelBindingData[];
  accountBinding?: ChannelAccountBindingData;
}

function BindingsTab({
  providers,
  bindings,
  accountBindings,
}: {
  providers: ChannelProviderData[];
  bindings: ChannelBindingData[];
  accountBindings: ChannelAccountBindingData[];
}) {
  const { t } = useI18nContext();

  const groups = useMemo<AccountGroupInfo[]>(() => {
    const byKey = new Map<string, AccountGroupInfo>();
    const keyFor = (channelName: string, accountId: string) => `${channelName}:${accountId}`;

    const ensure = (channelName: string, accountId: string): AccountGroupInfo => {
      const k = keyFor(channelName, accountId);
      let g = byKey.get(k);
      if (!g) {
        g = {
          channelName,
          accountId,
          accountKey: k,
          peerBindings: [],
        };
        byKey.set(k, g);
      }
      return g;
    };

    for (const p of providers) {
      const g = ensure(p.channelName, p.accountId);
      g.provider = p;
    }
    for (const b of bindings) {
      const g = ensure(b.channelName, b.accountId);
      g.peerBindings.push(b);
    }
    for (const ab of accountBindings) {
      const g = ensure(ab.channelName, ab.accountId);
      g.accountBinding = ab;
    }

    return Array.from(byKey.values()).sort((a, b) => {
      if (a.channelName !== b.channelName) return a.channelName.localeCompare(b.channelName);
      return a.accountId.localeCompare(b.accountId);
    });
  }, [providers, bindings, accountBindings]);

  if (groups.length === 0) {
    return (
      <p className="text-on-surface-muted text-sm text-center py-8">
        {t('channelManage.noBindings')}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((g) => (
        <AccountGroup key={g.accountKey} group={g} />
      ))}
    </div>
  );
}

function AccountGroup({ group }: { group: AccountGroupInfo }) {
  const { t } = useI18nContext();
  const agents = useLobbyStore((s) => s.agents);
  const deletedAgents = useLobbyStore((s) => s.deletedAgents);
  const conflict = useLobbyStore((s) => s.accountBindingConflict);
  const setConflict = useLobbyStore((s) => s.setAccountBindingConflict);

  const [picking, setPicking] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [showLockedPeers, setShowLockedPeers] = useState(false);

  const isLocked = !!group.accountBinding;
  const boundAgent = isLocked
    ? agents.find((a) => a.id === group.accountBinding!.agentId) ??
      deletedAgents.find((a) => a.id === group.accountBinding!.agentId)
    : undefined;

  const groupConflict =
    conflict &&
    conflict.channelName === group.channelName &&
    conflict.accountId === group.accountId
      ? conflict
      : null;

  const handleBind = () => {
    if (!selectedAgentId) return;
    wsBindAgentToAccount(group.channelName, group.accountId, selectedAgentId);
    setPicking(false);
    setSelectedAgentId('');
  };

  const handleUnbind = () => {
    if (typeof window !== 'undefined' && !window.confirm(t('channelManage.confirmUnbindAgent'))) {
      return;
    }
    wsUnbindAgentFromAccount(group.channelName, group.accountId);
  };

  return (
    <div className="bg-surface-elevated rounded-lg p-3 space-y-3 border border-outline/40">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="text-on-surface text-sm font-medium">{group.channelName}</span>
          <span className="text-on-surface-muted text-xs ml-2">· {group.accountId}</span>
        </div>
        {group.provider && (
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full ${
              group.provider.healthy
                ? 'bg-success-surface text-success'
                : 'bg-surface text-on-surface-muted border border-outline'
            }`}
            title={group.provider.enabled ? 'enabled' : 'disabled'}
          >
            {group.provider.healthy ? '●' : '○'}
          </span>
        )}
      </div>

      {groupConflict && (
        <div className="bg-danger-surface/40 border border-danger/50 rounded-md p-2 space-y-2 text-xs">
          <div className="font-medium text-danger">
            &#x26A0; {t('channelManage.conflict.title')}
          </div>
          <div className="text-on-surface-secondary">
            {t('channelManage.conflict.body', { count: groupConflict.conflicts.length })}
          </div>
          <ul className="space-y-1">
            {groupConflict.conflicts.map((c) => (
              <li key={c.identityKey} className="flex items-center justify-between gap-2">
                <span className="truncate text-on-surface">
                  {c.peerDisplayName ?? c.peerId}
                  <span className="text-on-surface-muted ml-1">({c.peerId.slice(0, 16)})</span>
                </span>
                <button
                  onClick={() => wsUnbind(c.identityKey)}
                  className="text-danger hover:text-danger-hover shrink-0"
                >
                  {t('channelManage.unbind')}
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end">
            <button
              onClick={() => setConflict(null)}
              className="text-on-surface-secondary hover:text-on-surface"
            >
              {t('channelManage.conflict.dismiss')}
            </button>
          </div>
        </div>
      )}

      {/* Account-bound Agent section */}
      <div className="space-y-1">
        <div className="text-[11px] uppercase tracking-wide text-on-surface-muted">
          {t('channelManage.section.accountBindings')}
        </div>
        {isLocked ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-on-surface inline-flex items-center gap-2">
              <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-purple-900/40 text-purple-200 border-purple-500/50 font-medium">
                &#x1F916; {boundAgent?.displayName ?? group.accountBinding!.agentId}
              </span>
            </span>
            <button
              onClick={handleUnbind}
              className="text-on-surface-secondary hover:text-danger text-xs"
            >
              {t('channelManage.unbindAgent')}
            </button>
          </div>
        ) : picking ? (
          <div className="flex items-center gap-2">
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className="flex-1 bg-surface border border-outline rounded px-2 py-1 text-xs text-on-surface"
            >
              <option value="">{t('channelManage.agentSelectPlaceholder')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} ({a.id})
                </option>
              ))}
            </select>
            <button
              onClick={handleBind}
              disabled={!selectedAgentId}
              className={`px-2 py-1 rounded text-xs ${
                selectedAgentId
                  ? 'bg-primary text-primary-on hover:bg-primary-hover'
                  : 'bg-surface text-on-surface-muted cursor-not-allowed'
              }`}
            >
              {t('channelManage.save')}
            </button>
            <button
              onClick={() => {
                setPicking(false);
                setSelectedAgentId('');
              }}
              className="text-xs text-on-surface-secondary hover:text-on-surface"
            >
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            onClick={() => setPicking(true)}
            className="px-2 py-1 rounded text-xs bg-surface border border-outline text-on-surface-secondary hover:text-on-surface hover:border-on-surface-muted"
          >
            + {t('channelManage.bindAgentToAccount')}
          </button>
        )}
      </div>

      {/* Peer bindings section */}
      <div className="space-y-1 border-t border-outline/40 pt-2">
        <div className="text-[11px] uppercase tracking-wide text-on-surface-muted">
          {t('channelManage.section.peerBindings')}
        </div>
        {isLocked ? (
          <div className="text-xs text-on-surface-muted italic">
            {t('channelManage.accountLockedByAgent')}
            {group.peerBindings.length > 0 && (
              <>
                {' '}
                <button
                  onClick={() => setShowLockedPeers((v) => !v)}
                  className="underline hover:text-on-surface ml-1"
                >
                  {t('channelManage.viewLockedPeerRows', { count: group.peerBindings.length })}
                </button>
              </>
            )}
            {showLockedPeers && (
              <div className="mt-2 space-y-2 opacity-60 pointer-events-none">
                {group.peerBindings.map((b) => (
                  <BindingRow key={b.identityKey} binding={b} />
                ))}
              </div>
            )}
          </div>
        ) : group.peerBindings.length === 0 ? (
          <div className="text-xs text-on-surface-muted">
            {t('channelManage.noBindings')}
          </div>
        ) : (
          <div className="space-y-2">
            {group.peerBindings.map((b) => (
              <BindingRow key={b.identityKey} binding={b} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

import React, { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { useLobbyStore } from '../stores/lobby-store';
import { useI18nContext } from '../contexts/I18nContext';
import {
  wsListProviders,
  wsAddProvider,
  wsRemoveProvider,
  wsToggleProvider,
  wsListBindings,
  wsUnbind,
  wsWecomQrStart,
  wsWecomQrCancel,
} from '../hooks/useWebSocket';

interface Props {
  onClose: () => void;
}

export default function ChannelManagePanel({ onClose }: Props) {
  const [tab, setTab] = useState<'providers' | 'bindings'>('providers');
  const [showAddForm, setShowAddForm] = useState(false);

  const providers = useLobbyStore((s) => s.channelProviders);
  const bindings = useLobbyStore((s) => s.channelBindings);
  const { t } = useI18nContext();

  useEffect(() => {
    wsListProviders();
    wsListBindings();
  }, []);

  return (
    <div className="fixed inset-0 bg-[var(--color-surface-overlay)] flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-surface-secondary rounded-xl p-6 w-full max-w-lg border border-outline max-h-[80vh] flex flex-col"
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
            <>
              {bindings.length === 0 && (
                <p className="text-on-surface-muted text-sm text-center py-8">
                  {t('channelManage.noBindings')}
                </p>
              )}

              {bindings.map((b) => (
                <div
                  key={b.identityKey}
                  className="flex items-center justify-between bg-surface-elevated rounded-lg p-3"
                >
                  <div>
                    <div className="text-on-surface text-sm">
                      {b.peerDisplayName ?? b.peerId}
                      <span className="text-on-surface-muted text-xs ml-2">({b.channelName})</span>
                    </div>
                    <div className="text-on-surface-muted text-xs mt-0.5">
                      {t('channelManage.target')}: {b.target === 'lobby-manager' ? 'LM' : b.activeSessionId?.slice(0, 8) ?? b.target.slice(0, 8)}
                    </div>
                  </div>
                  <button
                    onClick={() => wsUnbind(b.identityKey)}
                    className="text-on-surface-secondary hover:text-danger text-xs"
                  >
                    {t('channelManage.unbind')}
                  </button>
                </div>
              ))}
            </>
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

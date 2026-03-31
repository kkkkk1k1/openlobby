// No external imports needed — uses native fetch only

/** Status updates pushed to the WebSocket client */
export interface WeComQrStatus {
  status: 'generating' | 'waiting' | 'success' | 'expired' | 'error';
  qrUrl?: string;
  botId?: string;
  secret?: string;
  error?: string;
}

const QR_GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/gen';
const QR_QUERY_URL = 'https://work.weixin.qq.com/ai/qc/query_result';

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function getPlatformType(): number {
  switch (process.platform) {
    case 'darwin': return 1;
    case 'win32': return 2;
    default: return 3;
  }
}

export async function startWeComQrFlow(
  onStatus: (status: WeComQrStatus) => void,
  signal: AbortSignal,
): Promise<void> {
  onStatus({ status: 'generating' });

  let scode: string;
  let authUrl: string;

  try {
    const genUrl = `${QR_GENERATE_URL}?source=wecom_cli_external&type=${getPlatformType()}`;
    const res = await fetch(genUrl, { signal });

    if (!res.ok) {
      onStatus({ status: 'error', error: `QR generate failed: HTTP ${res.status}` });
      return;
    }

    // Response is HTML with window.settings = {...} containing scode and auth_url
    const html = await res.text();
    const settingsMatch = html.match(/window\.settings\s*=\s*(\{[^}]+\})/);
    if (!settingsMatch) {
      onStatus({ status: 'error', error: 'QR generate: could not parse settings from response' });
      return;
    }

    const settings = JSON.parse(settingsMatch[1]);
    scode = settings.scode;
    authUrl = settings.auth_url;

    if (!scode || !authUrl) {
      onStatus({ status: 'error', error: 'QR generate returned invalid response (missing scode/auth_url)' });
      return;
    }
  } catch (err) {
    if (signal.aborted) return;
    onStatus({ status: 'error', error: `QR generate failed: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }

  onStatus({ status: 'waiting', qrUrl: authUrl });

  const startTime = Date.now();

  while (!signal.aborted) {
    if (Date.now() - startTime > POLL_TIMEOUT_MS) {
      onStatus({ status: 'expired' });
      return;
    }

    await new Promise((resolve) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(undefined); }, { once: true });
    });

    if (signal.aborted) return;

    try {
      const res = await fetch(`${QR_QUERY_URL}?scode=${encodeURIComponent(scode)}`, { signal });

      if (!res.ok) continue;

      const data = await res.json();
      const result = data.data ?? data;
      const pollStatus = result.status;

      if (pollStatus === 'success' || pollStatus === 'authorized') {
        // bot_info contains { botid, secret } (note: "botid" not "bot_id")
        const botInfo = result.bot_info ?? {};
        const botId = botInfo.botid ?? botInfo.bot_id ?? result.bot_id;
        const botSecret = botInfo.secret ?? result.bot_secret;

        if (!botId || !botSecret) {
          onStatus({ status: 'error', error: 'Scan succeeded but credentials missing from response' });
          return;
        }

        onStatus({ status: 'success', botId, secret: botSecret });
        return;
      }
    } catch (err) {
      if (signal.aborted) return;
      console.warn('[WeComQR] Poll error (will retry):', err instanceof Error ? err.message : err);
    }
  }
}

import { useState, useEffect, useCallback, useRef } from 'react';

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export interface VersionState {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  installMode: 'global' | 'npx';
  checking: boolean;
}

const initialState: VersionState = {
  current: '',
  latest: null,
  hasUpdate: false,
  installMode: 'global',
  checking: false,
};

export function useVersionCheck(): VersionState & { recheckNow: () => void } {
  const [state, setState] = useState<VersionState>(initialState);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchVersion = useCallback(async () => {
    setState((prev) => ({ ...prev, checking: true }));
    try {
      const res = await fetch('/api/version');
      if (!res.ok) return;
      const data = await res.json();
      setState({
        current: data.currentVersion ?? '',
        latest: data.latestVersion ?? null,
        hasUpdate: data.hasUpdate ?? false,
        installMode: data.installMode ?? 'global',
        checking: false,
      });
    } catch {
      setState((prev) => ({ ...prev, checking: false }));
    }
  }, []);

  const startPolling = useCallback(() => {
    if (timerRef.current) return;
    timerRef.current = setInterval(fetchVersion, POLL_INTERVAL_MS);
  }, [fetchVersion]);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => {
    fetchVersion();
    startPolling();

    const onVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        fetchVersion();
        startPolling();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [fetchVersion, startPolling, stopPolling]);

  return { ...state, recheckNow: fetchVersion };
}

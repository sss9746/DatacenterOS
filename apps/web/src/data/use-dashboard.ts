import { useEffect, useState, useSyncExternalStore } from 'react';
import { DashboardStore, emptyState, errorMessage, openDashboard, type Preview } from './dashboard';
const initial = emptyState();
const noSubscribe = () => () => {};
const getInitial = () => initial;
export function useDashboard(preview: Preview, revision: number) {
  const [store, setStore] = useState<DashboardStore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rawMode = import.meta.env.VITE_DATA_MODE || 'mock';
  const mode: 'mock' | 'live' = rawMode === 'live' ? 'live' : 'mock';
  const token = import.meta.env.DEV ? import.meta.env.VITE_ADMIN_TOKEN : undefined;
  useEffect(() => {
    let disposed = false;
    let active: DashboardStore | null = null;
    setError(null); setStore(null);
    if (rawMode !== 'mock' && rawMode !== 'live') { setError('VITE_DATA_MODE must be mock or live. Correct the setting and restart the dashboard.'); return; }
    void openDashboard(mode, preview, { uri: import.meta.env.VITE_STDB_URI || 'wss://maincloud.spacetimedb.com', db: import.meta.env.VITE_STDB_DB || 'dcos-dev', token })
      .then((next) => { if (disposed) { next.close(); return; } active = next; setStore(next); next.start(); })
      .catch((reason) => { if (!disposed) setError(errorMessage(reason)); });
    return () => { disposed = true; active?.close(); };
  }, [mode, preview, revision, rawMode, token]);
  const state = useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.getSnapshot ?? getInitial);
  return { store, state, error: error ?? state.error, mode, canAdmin: mode === 'mock' || Boolean(token) };
}

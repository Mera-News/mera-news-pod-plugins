'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

/** The part of the pod's status this site reads. */
export interface Status {
  reading: 'on' | 'pausing' | 'paused';
  everyMinutes: number;
  counts: { facts: number; topics: number; topicsPending: number; picks: number };
  ai: { host: string; model: string } | null;
  dataServer: { host: string };
}

export type Connection =
  | { kind: 'connecting' }
  | { kind: 'no-link' }
  | { kind: 'link-refused' }
  | { kind: 'ended' }
  | { kind: 'offline' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; status: Status };

// Per tab: a link opens one tab, and the pod forgets every session when it restarts.
const KEY = 'mera-news-session';

const stored = {
  get: () => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v === null) sessionStorage.removeItem(KEY);
      else sessionStorage.setItem(KEY, v);
    } catch {
      // Storage can be blocked; the session then lasts until the page is left.
    }
  },
};

const failed = (status: number): Connection => (status === 503 ? { kind: 'unavailable' } : { kind: 'offline' });

/** Swaps the one-time code from the address for a session, then reads the pod's status. */
async function connect(session: string | null): Promise<{ session: string | null; next: Connection }> {
  const code = /^#c=([\w.-]+)$/.exec(location.hash)?.[1];
  if (code) {
    // The code is spent either way: keep it out of the history and of anything copied from the address bar.
    history.replaceState(null, '', location.pathname + location.search);
    let res: Response;
    try {
      res = await fetch('/api/session/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
    } catch {
      return { session, next: { kind: 'offline' } };
    }
    if (res.status === 401) return { session, next: session ? await readStatus(session) : { kind: 'link-refused' } };
    if (!res.ok) return { session, next: failed(res.status) };
    session = ((await res.json()) as { session: string }).session;
  }
  if (!session) return { session, next: { kind: 'no-link' } };
  return { session, next: await readStatus(session) };
}

async function readStatus(session: string): Promise<Connection> {
  let res: Response;
  try {
    res = await fetch('/api/status/', { headers: { authorization: `Bearer ${session}` } });
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 401) return { kind: 'ended' };
  if (!res.ok) return failed(res.status);
  return { kind: 'ready', status: (await res.json()) as Status };
}

const Context = createContext<Connection>({ kind: 'connecting' });
export const useConnection = () => useContext(Context);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>({ kind: 'connecting' });

  const refresh = useCallback(async () => {
    const { session, next } = await connect(stored.get());
    stored.set(next.kind === 'ended' ? null : session);
    setConnection(next);
  }, []);

  useEffect(() => {
    void refresh();
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    // A new link pasted into this tab changes only the hash.
    const onHash = () => location.hash.startsWith('#c=') && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('hashchange', onHash);
    };
  }, [refresh]);

  return <Context.Provider value={connection}>{children}</Context.Provider>;
}

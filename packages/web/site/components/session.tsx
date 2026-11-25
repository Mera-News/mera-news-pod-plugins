'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** The part of the pod's status this site reads. */
export interface Status {
  reading: 'on' | 'pausing' | 'paused';
  everyMinutes: number;
  readingNow: boolean;
  lastRunAt: string | null;
  nextReadAt: string | null;
  counts: { facts: number; topics: number; topicsPending: number; picks: number };
  problems: { code: string; who: 'assistant' | 'person'; fix: string }[];
  ai: { host: string; model: string } | null;
  aiAfterRestart?: { host: string; model: string };
  dataServer: { host: string };
}

export type Connection =
  | { kind: 'connecting' }
  | { kind: 'no-link' }
  | { kind: 'link-refused' }
  | { kind: 'ended' }
  | { kind: 'offline' }
  | { kind: 'unavailable' }
  | { kind: 'not-paired' }
  | { kind: 'pair-refused'; error: string }
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

/** A phone reaches the pod at its public https address; this computer at http://127.0.0.1. */
export const onPhone = () => location.protocol === 'https:';

const phoneName = () => {
  const ua = navigator.userAgent;
  return /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : 'Phone';
};

/** A phone swaps the pairing code from the address for a device cookie the pod sets, then opens the feed. */
async function pairPhone(): Promise<Connection> {
  const code = /^#([A-Za-z2-7]{10})$/.exec(location.hash)?.[1];
  if (code) {
    history.replaceState(null, '', location.pathname + location.search);
    let res: Response;
    try {
      res = await fetch('/api/pair/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: phoneName() }) });
    } catch {
      return { kind: 'offline' };
    }
    if (res.ok) {
      location.replace('/');
      return { kind: 'connecting' };
    }
    const reply = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (typeof reply?.error === 'string') return { kind: 'pair-refused', error: reply.error };
    return failed(res.status);
  }
  let res: Response;
  try {
    res = await fetch('/api/status/');
  } catch {
    return { kind: 'offline' };
  }
  if (res.status === 401) return { kind: 'not-paired' };
  if (!res.ok) return failed(res.status);
  return { kind: 'ready', status: (await res.json()) as Status };
}

/** Swaps the one-time code from the address for a session, then reads the pod's status. */
async function connect(session: string | null): Promise<{ session: string | null; next: Connection }> {
  // A phone's session is its cookie, which the browser sends by itself.
  if (onPhone()) return { session: null, next: await pairPhone() };
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

/** A request the pod could not answer, in words the page can show: what happened and what to do. */
export class ApiError extends Error {
  constructor(
    message: string,
    public next: string,
  ) {
    super(message);
  }
}

type Get = <T>(path: string) => Promise<T>;
type Post = <T>(path: string, body: object) => Promise<T>;
const notConnected = () => Promise.reject(new ApiError('Not connected.', 'Reload the page.'));
const ApiContext = createContext<{ get: Get; post: Post }>({ get: notConnected, post: notConnected });
/** Reads one of the pod's JSON routes with this tab's session. */
export const useApi = () => useContext(ApiContext).get;
/** Sends a change to one of the pod's JSON routes with this tab's session. */
export const usePost = () => useContext(ApiContext).post;

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
    const onHash = () => /^#(c=|[A-Za-z2-7]{10}$)/.test(location.hash) && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('hashchange', onHash);
    };
  }, [refresh]);

  const call = useCallback(async (path: string, body?: object) => {
    let res: Response;
    try {
      const auth: Record<string, string> = onPhone() ? {} : { authorization: `Bearer ${stored.get() ?? ''}` };
      res = await fetch(path, body ? { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) } : { headers: auth });
    } catch {
      throw new ApiError('Mera News is not running.', 'Open your AI app, or start your pod, then try again.');
    }
    if (res.status === 401) {
      stored.set(null);
      if (onPhone()) {
        setConnection({ kind: 'not-paired' });
        throw new ApiError('This phone is no longer paired.', 'Pair it again from Mera News on your computer.');
      }
      setConnection({ kind: 'ended' });
      throw new ApiError('This page needs a new link.', 'Ask your assistant to open Mera News.');
    }
    const reply = (await res.json().catch(() => null)) as { message?: unknown; next?: unknown } | null;
    if (res.status === 400 && typeof reply?.message === 'string' && typeof reply.next === 'string') throw new ApiError(reply.message, reply.next);
    if (!res.ok || reply === null) throw new ApiError('Mera News could not answer.', 'Try again in a minute.');
    return reply as never;
  }, []);
  const api = useMemo(() => ({ get: ((path) => call(path)) as Get, post: ((path, body) => call(path, body)) as Post }), [call]);

  return (
    <Context.Provider value={connection}>
      <ApiContext.Provider value={api}>{children}</ApiContext.Provider>
    </Context.Provider>
  );
}

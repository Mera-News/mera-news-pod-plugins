'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, useApi, useConnection } from '@/components/session';
import type { FeedPage, FeedStory, FeedSummary } from '@/lib/feed';

/** How often the numbers are asked again while the tab is in front, so the page fills in as stories are judged. */
const POLL_MS = 5000;

export type Load = 'loading' | 'more' | 'end' | 'error';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('Mera News could not answer.', 'Try again in a minute.'));

const merge = (list: FeedStory[], page: FeedStory[]) => {
  const at = new Map(list.map((s, i) => [s.id, i]));
  const out = [...list];
  for (const s of page) {
    if (at.has(s.id)) out[at.get(s.id)!] = s;
    else out.push(s);
  }
  return out;
};

/**
 * The Feed's data for both the desktop and the phone: every page of stories that matched the
 * person's facts, loaded as the reader nears `sentinel` (every page at once while `q` is set), and
 * read again while the tab is in front so verdicts land as they are made.
 */
export function useFeed(q: string) {
  const c = useConnection();
  const get = useApi();
  const facts = c.kind === 'ready' ? c.status.counts.facts : 0;
  const ai = c.kind === 'ready' && !!c.status.ai;

  const [run, setRun] = useState<string | null>(null);
  const [summary, setSummary] = useState<FeedSummary | null>(null);
  const [stories, setStories] = useState<FeedStory[]>([]);
  // The cursor of every page loaded so far, so a change of verdicts can read them all again.
  const [cursors, setCursors] = useState<string[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<Load>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (after: string | null) => {
      setState('loading');
      setError(null);
      try {
        const page = await get<FeedPage>(`/api/feed/${after ? `?after=${encodeURIComponent(after)}` : ''}`);
        if (!after) {
          setStories(page.stories);
          setCursors([`${page.run}.0`]);
        } else {
          setStories((list) => merge(list, page.stories));
          setCursors((list) => [...list, after]);
        }
        setRun(page.run);
        setSummary(page.summary);
        setNext(page.nextCursor);
        setState(page.nextCursor ? 'more' : 'end');
      } catch (e) {
        setError(asError(e));
        setState('error');
      }
    },
    [get],
  );

  useEffect(() => {
    if (facts > 0) void load(null);
  }, [facts, load]);

  // The next page loads before the reader reaches the end; while searching, every page loads.
  useEffect(() => {
    if (state !== 'more') return;
    if (q) return void load(next);
    const el = sentinel.current;
    if (!el) return;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void load(next), { rootMargin: '800px 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, [state, next, load, q]);

  // While the tab is in front, the numbers are read again; when a verdict lands, every loaded page is too.
  const latest = useRef({ summary, cursors, state });
  latest.current = { summary, cursors, state };
  useEffect(() => {
    if (!run) return;
    const tick = async () => {
      const now = latest.current;
      if (document.visibilityState !== 'visible' || now.state === 'loading' || !now.summary) return;
      try {
        const counts = await get<FeedPage>(`/api/feed/?after=${run}.0&limit=0`);
        const s = counts.summary;
        if (s.picked === now.summary.picked && s.leftOut === now.summary.leftOut) return;
        let list: FeedStory[] = [];
        for (const after of now.cursors) list = merge(list, (await get<FeedPage>(`/api/feed/?after=${encodeURIComponent(after)}`)).stories);
        setStories((old) => merge(old, list));
        setSummary((old) => (old ? { ...s, publishers: Math.max(s.publishers, old.publishers), languages: Math.max(s.languages, old.languages) } : s));
      } catch (e) {
        // A run the pod no longer holds starts again from the first page.
        if (e instanceof ApiError && /expired/.test(e.message)) void load(null);
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => clearInterval(timer);
  }, [run, get, load]);

  return { ready: c.kind === 'ready', facts, ai, summary, stories, next, state, error, load, sentinel };
}

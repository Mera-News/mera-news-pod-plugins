'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, useApi, useConnection } from '@/components/session';
import type { FeedPage, FeedStory, FeedSummary } from '@/lib/feed';

/** How often each lane's numbers are asked again while the tab is in front, so it fills in as stories are judged. */
const POLL_MS = 5000;

export type Load = 'loading' | 'more' | 'end' | 'error';

export interface Fact {
  id: string;
  statement: string;
}

/** One fact's lane: its own run, pages and numbers, loaded and paged apart from the others. */
export interface Lane {
  fact: Fact;
  /** The numbers for this fact once its first page arrived. */
  counts: FeedSummary['facts'][number] | null;
  summary: FeedSummary | null;
  run: string | null;
  stories: FeedStory[];
  /** The cursor of every page loaded so far, so a change of verdicts can read them all again. */
  cursors: string[];
  next: string | null;
  state: Load;
  error: ApiError | null;
}

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

const empty = (fact: Fact): Lane => ({ fact, counts: null, summary: null, run: null, stories: [], cursors: [], next: null, state: 'loading', error: null });

const feedPath = (fact: string, after: string | null, limit?: 0) =>
  `/api/feed/?fact=${encodeURIComponent(fact)}${after ? `&after=${encodeURIComponent(after)}` : ''}${limit === 0 ? '&limit=0' : ''}`;

/**
 * The numbers over the whole Feed, added up from the lanes that have arrived. A story that matched two
 * facts counts in both; `partial` is true while a lane is still on its first page.
 */
function total(lanes: Lane[]): { summary: FeedSummary; partial: boolean } | null {
  const done = lanes.filter((l) => l.summary);
  if (!done.length) return null;
  const sum = (k: 'articles' | 'stories' | 'merged' | 'picked' | 'leftOut' | 'unjudged') => done.reduce((n, l) => n + l.summary![k], 0);
  const topics = new Map(done.flatMap((l) => l.summary!.topics.map((t) => [t.text.toLowerCase(), t])));
  return {
    summary: {
      windowHours: done[0].summary!.windowHours,
      articles: sum('articles'),
      stories: sum('stories'),
      merged: sum('merged'),
      topics: [...topics.values()],
      facts: done.map((l) => l.counts ?? { id: l.fact.id, statement: l.fact.statement, matched: 0, picked: 0, leftOut: 0 }),
      picked: sum('picked'),
      leftOut: sum('leftOut'),
      unjudged: sum('unjudged'),
      // Publishers and languages overlap between facts: the largest lane is the honest lower bound.
      publishers: Math.max(...done.map((l) => l.summary!.publishers)),
      languages: Math.max(...done.map((l) => l.summary!.languages)),
      complete: done.every((l) => l.summary!.complete),
    },
    partial: done.length < lanes.length,
  };
}

/**
 * The Feed's data for both the desktop and the phone: one lane per fact, each loading its own pages
 * (every page at once while `q` is set) and read again while the tab is in front so verdicts land
 * as they are made.
 */
export function useFeed(q: string) {
  const c = useConnection();
  const get = useApi();
  const factCount = c.kind === 'ready' ? c.status.counts.facts : 0;
  const ai = c.kind === 'ready' && !!c.status.ai;

  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [factsError, setFactsError] = useState<ApiError | null>(null);
  const [lanes, setLanes] = useState<Record<string, Lane>>({});
  const loading = useRef(new Set<string>());

  const patch = (id: string, fn: (l: Lane) => Lane) => setLanes((all) => (all[id] ? { ...all, [id]: fn(all[id]) } : all));

  /** Loads one page of one lane; nothing else waits for it. */
  const load = useCallback(
    async (fact: Fact, after: string | null) => {
      if (loading.current.has(fact.id)) return;
      loading.current.add(fact.id);
      setLanes((all) => ({ ...all, [fact.id]: { ...(after ? all[fact.id] : empty(fact)), fact, state: 'loading', error: null } }));
      try {
        const page = await get<FeedPage>(feedPath(fact.id, after));
        patch(fact.id, (l) => ({
          ...l,
          run: page.run,
          summary: page.summary,
          counts: page.summary.facts.find((f) => f.id === fact.id) ?? null,
          stories: after ? merge(l.stories, page.stories) : page.stories,
          cursors: after ? [...l.cursors, after] : [`${page.run}.0`],
          next: page.nextCursor,
          state: page.nextCursor ? 'more' : 'end',
        }));
      } catch (e) {
        patch(fact.id, (l) => ({ ...l, state: 'error', error: asError(e) }));
      } finally {
        loading.current.delete(fact.id);
      }
    },
    [get],
  );

  const loadFacts = useCallback(async () => {
    setFactsError(null);
    try {
      const p = await get<{ facts: Fact[] }>('/api/profile/');
      setFacts(p.facts.map(({ id, statement }) => ({ id, statement })));
    } catch (e) {
      setFactsError(asError(e));
    }
  }, [get]);

  useEffect(() => {
    if (factCount > 0) void loadFacts();
  }, [factCount, loadFacts]);

  // Every lane starts at once; each shows its stories the moment its own first page arrives. A fact
  // added later starts its own lane and leaves the others as they are.
  const started = useRef(new Set<string>());
  useEffect(() => {
    if (!facts) return;
    const ids = new Set(facts.map((f) => f.id));
    for (const id of started.current) if (!ids.has(id)) started.current.delete(id);
    setLanes((all) => Object.fromEntries(Object.entries(all).filter(([id]) => ids.has(id))));
    for (const f of facts) {
      if (started.current.has(f.id)) continue;
      started.current.add(f.id);
      void load(f, null);
    }
  }, [facts, load]);

  const list = useMemo(() => (facts ?? []).map((f) => lanes[f.id] ?? empty(f)), [facts, lanes]);

  /** Asks for a lane's next page, when it has one and is not already loading it. */
  const more = useCallback(
    (id: string) => {
      const l = lanes[id];
      if (l?.state === 'more' && l.next) void load(l.fact, l.next);
    },
    [lanes, load],
  );

  // While searching, each lane loads every page so the search covers all it holds.
  useEffect(() => {
    if (!q) return;
    for (const l of list) if (l.state === 'more' && l.next) void load(l.fact, l.next);
  }, [q, list, load]);

  // While the tab is in front, each lane's numbers are read again; when a verdict lands, that lane's loaded pages are too.
  const latest = useRef(list);
  latest.current = list;
  const any = list.some((l) => l.run);
  useEffect(() => {
    if (!any) return;
    const tick = (l: Lane) => async () => {
      if (!l.run || !l.summary || l.state === 'loading' || loading.current.has(l.fact.id)) return;
      try {
        const s = (await get<FeedPage>(feedPath(l.fact.id, `${l.run}.0`, 0))).summary;
        if (s.picked === l.summary.picked && s.leftOut === l.summary.leftOut) return;
        let stories: FeedStory[] = [];
        for (const after of l.cursors) stories = merge(stories, (await get<FeedPage>(feedPath(l.fact.id, after))).stories);
        patch(l.fact.id, (now) => ({
          ...now,
          stories: merge(now.stories, stories),
          counts: s.facts.find((f) => f.id === l.fact.id) ?? now.counts,
          summary: now.summary ? { ...s, publishers: Math.max(s.publishers, now.summary.publishers), languages: Math.max(s.languages, now.summary.languages) } : s,
        }));
      } catch (e) {
        // A run the pod no longer holds starts that lane again from its first page.
        if (e instanceof ApiError && /expired/.test(e.message)) void load(l.fact, null);
      }
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      for (const l of latest.current) void tick(l)();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [any, get, load]);

  const totals = useMemo(() => total(list), [list]);
  // A story that matched two facts is in both lanes, and once here.
  const stories = useMemo(() => [...new Map(list.flatMap((l) => l.stories.map((s) => [s.id, s]))).values()], [list]);

  return {
    ready: c.kind === 'ready',
    facts: factCount,
    ai,
    lanes: list,
    factsLoaded: facts !== null,
    factsError,
    retryFacts: loadFacts,
    summary: totals?.summary ?? null,
    /** True while any lane has not answered its first page yet. */
    partial: !facts || !totals || totals.partial,
    stories,
    load,
    more,
  };
}

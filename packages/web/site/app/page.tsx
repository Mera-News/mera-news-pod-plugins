'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lane, LaneSkeleton, type Show } from '@/components/lane';
import { SearchField } from '@/components/search-field';
import { ApiError, useApi, useConnection } from '@/components/session';
import { Empty, PublisherLine, TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { matches, type FeedPage, type FeedStory, type FeedSummary } from '@/lib/feed';
import { plural } from '@/lib/news';

/** How often the numbers are asked again while the tab is in front, so the lanes fill in as stories are judged. */
const POLL_MS = 5000;
/** Past this many facts the lanes scroll sideways, and a picker jumps to one. */
const LANES_IN_VIEW = 5;

type Load = 'loading' | 'more' | 'end' | 'error';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('Mera News could not answer.', 'Try again in a minute.'));

export default function FeedPage() {
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
  const [show, setShow] = useState<Show>('all');
  const [q, setQ] = useState('');
  const sentinel = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLDivElement>(null);

  const merge = (list: FeedStory[], page: FeedStory[]) => {
    const at = new Map(list.map((s, i) => [s.id, i]));
    const out = [...list];
    for (const s of page) {
      if (at.has(s.id)) out[at.get(s.id)!] = s;
      else out.push(s);
    }
    return out;
  };

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

  const shown = useMemo(() => (q ? stories.filter((s) => matches(s, q)) : stories), [stories, q]);
  const byFact = useMemo(() => {
    const m = new Map<string, FeedStory[]>();
    for (const s of shown) for (const f of s.facts) m.set(f, [...(m.get(f) ?? []), s]);
    return m;
  }, [shown]);

  if (c.kind === 'ready' && facts === 0) {
    return (
      <>
        <TopBar>
          <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Your news</h1>
        </TopBar>
        <Empty title="Mera News has no profile for you yet">
          <p>Ask your assistant to set up your news profile, or add a fact on You. Each fact about you gets its own lane of news here.</p>
        </Empty>
      </>
    );
  }

  const factList = summary?.facts ?? [];
  const n = (x: number) => x.toLocaleString('en');
  const loadingMore = state === 'loading' && stories.length > 0;

  return (
    <>
      <TopBar end={<SearchField placeholder="Search your news" value={q} onSearch={setQ} />}>
        <h1 className="sr-only">Your news</h1>
        <ToggleGroup aria-label="Show" value={[show]} onValueChange={(v: unknown[]) => typeof v[0] === 'string' && setShow(v[0] as Show)}>
          <ToggleGroupItem value="all">All {summary ? n(summary.stories) : ''}</ToggleGroupItem>
          <ToggleGroupItem value="picked">Picked {summary ? n(summary.picked) : ''}</ToggleGroupItem>
          <ToggleGroupItem value="left-out">Left out {summary ? n(summary.leftOut) : ''}</ToggleGroupItem>
        </ToggleGroup>
        <span className="inline-flex h-8 items-center rounded-full border px-3 text-[13px] text-muted-foreground">Last {summary?.windowHours ?? 48} hours</span>
        {factList.length > LANES_IN_VIEW && (
          <label className="relative inline-flex">
            <span className="sr-only">Go to a fact</span>
            <select
              value=""
              onChange={(e) => {
                const lane = document.getElementById(`lane-${e.target.value}`);
                const row = lanes.current;
                if (!lane || !row) return;
                // Only the row of lanes moves sideways; the page stays where it is. The row is positioned, so offsetLeft is within it.
                row.scrollTo({ left: lane.offsetLeft - 28, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
                lane.querySelector('h2')?.focus({ preventScroll: true });
              }}
              className="h-8 w-[180px] cursor-pointer appearance-none truncate rounded-full border border-dashed bg-transparent pr-8 pl-3 text-[13px] text-muted-foreground transition-colors outline-none hover:border-primary/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <option value="" disabled>
                Go to a fact
              </option>
              {factList.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.statement}
                </option>
              ))}
            </select>
            <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </label>
        )}
      </TopBar>

      {summary && (
        <div className="flex flex-col gap-1.5 px-7 pt-5">
          <p className="text-pretty text-muted-foreground tabular-nums">
            <span className="font-semibold text-foreground">{n(summary.articles)}</span> {summary.articles === 1 ? 'article' : 'articles'} matched your{' '}
            {plural(summary.topics.length, 'topic')} in the last {summary.windowHours} hours: <span className="font-semibold text-foreground">{n(summary.stories)}</span>{' '}
            {summary.stories === 1 ? 'story' : 'stories'} once {n(summary.merged)} {summary.merged === 1 ? 'duplicate was' : 'duplicates were'} merged, from{' '}
            {state === 'end' ? '' : 'at least '}
            {plural(summary.publishers, 'publisher')} in {plural(summary.languages, 'language')}.
            {!summary.complete && ' Mera News found more than one read can hold, so some matches are not here.'}
          </p>
          {!ai && summary.unjudged > 0 && (
            <p className="text-pretty">
              <span className="font-medium">{plural(summary.unjudged, 'story', 'stories')} not judged yet.</span>{' '}
              <span className="text-muted-foreground">
                Ask your assistant to pick, or{' '}
                <Link href="/you/#ai" className="text-accent-foreground underline decoration-primary/60 underline-offset-[3px] hover:decoration-primary">
                  add an AI service
                </Link>
                .
              </span>
            </p>
          )}
        </div>
      )}

      {state === 'error' && error && (
        <div role="alert" className="flex flex-col items-start gap-3 px-7 py-8">
          <p>
            <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
          </p>
          <Button variant="outline" size="sm" onClick={() => void load(stories.length ? next : null)}>
            Try again
          </Button>
        </div>
      )}

      {summary && summary.stories === 0 && state === 'end' ? (
        <Empty title="Nothing matched your topics yet">
          <p>Mera News looks for news on each of your topics from the last {summary.windowHours} hours. Check again later, or add more facts on You.</p>
        </Empty>
      ) : (
        <div
          ref={lanes}
          aria-busy={state === 'loading'}
          className="relative flex snap-x scroll-px-7 gap-[18px] overflow-x-auto px-7 pt-5 pb-4 [scrollbar-width:thin] *:snap-start"
        >
          {summary
            ? factList.map((f) => <Lane key={f.id} fact={f} stories={byFact.get(f.id) ?? []} show={show} searching={!!q} />)
            : state !== 'error' && Array.from({ length: Math.min(Math.max(facts, 1), LANES_IN_VIEW) }, (_, i) => <LaneSkeleton key={i} />)}
        </div>
      )}

      <div ref={sentinel} aria-hidden className="h-px" />
      <div className="px-7 pt-2" aria-live="polite">
        {loadingMore && <p className="text-muted-foreground">Loading more stories</p>}
        {q && state === 'end' && <p className="text-muted-foreground">{shown.length ? `${plural(shown.length, 'story', 'stories')} match “${q}”.` : `No story in your news matches “${q}”.`}</p>}
        {!q && state === 'end' && stories.length > 0 && (
          <p className="text-muted-foreground">{`That is every story that matched your facts, ${plural(stories.length, 'story', 'stories')}.`}</p>
        )}
      </div>
      <PublisherLine />
    </>
  );
}

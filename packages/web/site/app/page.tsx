'use client';

import { ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Lane, LaneError, LaneSkeleton, type Show } from '@/components/lane';
import { PhoneFeed } from '@/components/phone/feed';
import { SearchField } from '@/components/search-field';
import { Empty, PublisherLine, TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { matches, type FeedStory } from '@/lib/feed';
import { plural } from '@/lib/news';
import { useFeed } from '@/lib/use-feed';
import { usePhone } from '@/lib/use-phone';

/** Past this many facts the lanes scroll sideways, and a picker jumps to one. */
const LANES_IN_VIEW = 5;

export default function FeedPage() {
  return usePhone() ? <PhoneFeed /> : <DesktopFeed />;
}

function DesktopFeed() {
  const [show, setShow] = useState<Show>('all');
  const [q, setQ] = useState('');
  const { ready, facts, ai, lanes: laneList, factsError, retryFacts, summary, partial, stories, load, more } = useFeed(q);
  const lanes = useRef<HTMLDivElement>(null);

  const filter = useCallback((list: FeedStory[]) => (q ? list.filter((s) => matches(s, q)) : list), [q]);
  const shown = useMemo(() => filter(stories), [filter, stories]);

  if (ready && facts === 0) {
    return (
      <>
        <TopBar>
          <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Your news</h1>
        </TopBar>
        <Empty title="Mera News has no profile for you yet">
          <p>
            Ask your assistant to set up your news profile, or add a fact on{' '}
            <Link href="/you/" className="text-accent-foreground underline decoration-primary/60 underline-offset-[3px] hover:decoration-primary">
              You
            </Link>
            . Each fact about you gets its own lane of news here.
          </p>
        </Empty>
      </>
    );
  }

  const factList = laneList.map((l) => l.fact);
  const names = new Map(factList.map((f) => [f.id, f.statement]));
  const n = (x: number) => x.toLocaleString('en');
  const allEnded = laneList.length > 0 && laneList.every((l) => l.state === 'end');
  // A lane in error is settled for search: it will not load more until the person asks again.
  const settled = laneList.length > 0 && laneList.every((l) => l.state === 'end' || l.state === 'error');
  const searching = q && !settled;
  const atLeast = partial ? '+' : '';

  return (
    // The page itself never scrolls: the lanes do, each on its own.
    <div className="flex h-dvh min-h-0 flex-col">
      <TopBar end={<SearchField placeholder="Search your news" value={q} onSearch={setQ} />}>
        <h1 className="sr-only">Your news</h1>
        <ToggleGroup aria-label="Show" value={[show]} onValueChange={(v: unknown[]) => typeof v[0] === 'string' && setShow(v[0] as Show)}>
          <ToggleGroupItem value="all">All {summary ? n(summary.stories) + atLeast : ''}</ToggleGroupItem>
          <ToggleGroupItem value="picked">Picked {summary ? n(summary.picked) + atLeast : ''}</ToggleGroupItem>
          <ToggleGroupItem value="left-out">Left out {summary ? n(summary.leftOut) + atLeast : ''}</ToggleGroupItem>
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

      {summary && summary.articles > 0 && (
        <div className="flex flex-none flex-col gap-1.5 px-7 pt-5">
          <p className="text-pretty text-muted-foreground tabular-nums">
            {partial && 'At least '}
            <span className="font-semibold text-foreground">{n(summary.articles)}</span> {summary.articles === 1 ? 'article' : 'articles'} matched your{' '}
            {/* Topics are counted only once every lane has answered. */}
            {partial ? 'topics' : plural(summary.topics.length, 'topic')} in the last {summary.windowHours} hours: {partial && 'at least '}<span className="font-semibold text-foreground">{n(summary.stories)}</span>{' '}
            {summary.stories === 1 ? 'story' : 'stories'} once {n(summary.merged)} {summary.merged === 1 ? 'duplicate was' : 'duplicates were'} merged, from{' '}
            {laneList.length === 1 && allEnded ? '' : 'at least '}
            {plural(summary.publishers, 'publisher')} in {plural(summary.languages, 'language')}.
            {laneList.length > 1 && ' A story that matched two facts counts for each.'}
            {!summary.complete && ' Mera News found more than one read can hold, so some matches are not here.'}
          </p>
          {!ai && summary.unjudged > 0 && (
            <p className="text-pretty">
              <span className="font-medium">
                {partial && 'At least '}
                {plural(summary.unjudged, 'story', 'stories')} not judged yet.
              </span>{' '}
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

      {factsError && (
        <div role="alert" className="flex flex-col items-start gap-3 px-7 py-8">
          <p>
            <span className="font-medium">{factsError.message}</span> <span className="text-muted-foreground">{factsError.next}</span>
          </p>
          <Button variant="outline" size="sm" onClick={() => void retryFacts()}>
            Try again
          </Button>
        </div>
      )}

      {summary && summary.stories === 0 && allEnded ? (
        <Empty title="Nothing matched your topics yet">
          <p>
            Mera News looked for news on your {plural(summary.topics.length, 'topic')} from the last {summary.windowHours} hours. Check again later, or add more facts on{' '}
            <Link href="/you/" className="text-accent-foreground underline decoration-primary/60 underline-offset-[3px] hover:decoration-primary">
              You
            </Link>
            .
          </p>
        </Empty>
      ) : (
        <div
          ref={lanes}
          aria-busy={partial}
          className="relative flex min-h-0 flex-1 snap-x scroll-px-7 gap-[18px] overflow-x-auto px-7 pt-5 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] *:snap-start"
        >
          {laneList.length
            ? laneList.map((l) =>
                l.summary ? (
                  <Lane key={l.fact.id} lane={l} stories={filter(l.stories)} show={show} searching={!!q} names={names} onNearEnd={() => more(l.fact.id)} onRetry={() => void load(l.fact, l.next)} />
                ) : l.state === 'error' && l.error ? (
                  <LaneError key={l.fact.id} lane={l} onRetry={() => void load(l.fact, null)} />
                ) : (
                  <LaneSkeleton key={l.fact.id} title={l.fact.statement} />
                ),
              )
            : !factsError && Array.from({ length: Math.min(Math.max(facts, 1), LANES_IN_VIEW) }, (_, i) => <LaneSkeleton key={i} />)}
        </div>
      )}

      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-t px-7 py-2.5 text-[13px]" aria-live="polite">
        {searching && <p className="text-muted-foreground">Searching every story in your lanes</p>}
        {q && settled && <p className="text-muted-foreground">{shown.length ? `${plural(shown.length, 'story', 'stories')} match “${q}”.` : `No story in your news matches “${q}”.`}</p>}
        {!q && allEnded && stories.length > 0 && (
          <p className="text-muted-foreground">{`That is every story that matched your facts, ${plural(stories.length, 'story', 'stories')}.`}</p>
        )}
        <PublisherLine className="ml-auto mt-0 max-w-[70ch] p-0" />
      </div>
    </div>
  );
}

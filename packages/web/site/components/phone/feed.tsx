'use client';

import { ChevronDown, ChevronRight, EyeOff, Newspaper, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Headline } from '@/components/headline';
import { LevelChip, NoteBox, Panel, PhoneHeader, Pills, ReadOn, ShareButton, SourceRow, StoryImage, StoryRow } from '@/components/phone/ui';
import { Empty, PublisherLine } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { detailLink, fromFeed } from '@/lib/detail';
import { byLevel, type FeedStory, type FeedSummary } from '@/lib/feed';
import { plural } from '@/lib/news';
import { useFeed, type Lane } from '@/lib/use-feed';

type View = 'feed' | 'left-out';

const n = (x: number) => x.toLocaleString('en');
const LINK = 'font-semibold text-accent-foreground underline decoration-primary/60 underline-offset-[3px]';

/** The numbers over the Feed, as the app says them, opening to the numbers per fact. */
function CountsCard({ summary, ai, partial }: { summary: FeedSummary; ai: boolean; partial: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex items-start gap-3 text-left">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static export has no image server */}
        <img src="/mark.png" alt="" width={40} height={40} className="size-10 shrink-0 rounded-[10px]" />
        <p className="flex-1 text-[15px] leading-snug text-pretty tabular-nums">
          {partial && 'At least '}
          {plural(summary.articles, 'article')} {summary.articles === 1 ? 'was' : 'were'} read for you in the last {summary.windowHours} hours: {plural(summary.stories, 'story', 'stories')} matched, {n(summary.picked)} picked, {n(summary.leftOut)} left out
          {/* Every count grows as the remaining facts answer. */}
          {partial && ' so far'}.
        </p>
        <ChevronDown aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground transition-transform in-aria-expanded:rotate-180" />
        <span className="sr-only">{open ? 'Hide the numbers for each fact' : 'Show the numbers for each fact'}</span>
      </button>
      {open && (
        <div id={id} className="flex flex-col gap-3 border-t pt-3 text-[14px]">
          <p className="text-muted-foreground">
            {n(summary.merged)} {summary.merged === 1 ? 'duplicate was' : 'duplicates were'} merged. The stories come from at least 
            {plural(summary.publishers, 'publisher')} in {plural(summary.languages, 'language')}.
            {!summary.complete && ' Mera News found more than one read can hold, so some matches are not here.'}
          </p>
          <ul className="flex flex-col gap-2.5">
            {summary.facts.map((f) => (
              <li key={f.id} className="flex flex-col">
                <span className="font-medium text-pretty">{f.statement}</span>
                <span className="text-[13px] text-muted-foreground tabular-nums">
                  {n(f.matched)} matched, {n(f.picked)} picked, {n(f.leftOut)} left out
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!ai && summary.unjudged > 0 && (
        <p className="border-t pt-3 text-[14px] text-pretty">
          <span className="font-semibold">
            {partial && 'At least '}
            {plural(summary.unjudged, 'story', 'stories')} not judged yet.
          </span>{' '}
          <span className="text-muted-foreground">
            Ask your assistant to pick, or{' '}
            <Link href="/you/#ai" className={LINK}>
              add an AI service
            </Link>
            .
          </span>
        </p>
      )}
    </Panel>
  );
}

/** A pick as the app's full card: image, publisher and language, headline, why it matters with its level, share and read. */
function PickCard({ s, names }: { s: FeedStory; names: Map<string, string> }) {
  const v = s.verdict!;
  return (
    <Panel as="article" className="overflow-hidden">
      <StoryImage src={s.image} className="aspect-[12/5] w-full" />
      <div className="flex flex-col gap-3 p-4">
        <SourceRow report={s} />
        <Headline report={s} size="phone-card" opens={detailLink(fromFeed(s, names))} out={false} />
        <NoteBox
          top={
            <>
              {v.level ? <LevelChip level={v.level} /> : <span />}
              <span className="inline-flex items-center gap-1 text-[13px] text-muted-foreground">
                <Sparkles aria-hidden className="size-3.5" />
                AI-generated
              </span>
            </>
          }
        >
          {v.reason}
        </NoteBox>
        <div className="flex items-center gap-2">
          <ShareButton report={s} />
          <ReadOn report={s} />
        </div>
      </div>
    </Panel>
  );
}

const Reason = ({ children }: { children: string }) => <p className="rounded-[12px] bg-note px-3 py-2 text-[14px] leading-snug text-pretty text-foreground/85">{children}</p>;

function CardSkeleton() {
  return (
    <Panel aria-hidden className="overflow-hidden">
      <div className="aspect-[12/5] animate-pulse bg-muted" />
      <div className="flex flex-col gap-3 p-4">
        <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-5 w-11/12 animate-pulse rounded bg-muted" />
        <div className="h-20 animate-pulse rounded-[14px] bg-muted" />
      </div>
    </Panel>
  );
}

/** Asks for a section's next page as the reader nears its end. */
function NearEnd({ lane, onNear }: { lane: Lane; onNear: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const near = useRef(onNear);
  near.current = onNear;
  useEffect(() => {
    const el = ref.current;
    if (lane.state !== 'more' || !el) return;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && near.current(), { rootMargin: '800px 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, [lane.state, lane.next]);
  return <div ref={ref} aria-hidden className="h-px" />;
}

/** A section's state under its stories: loading more, or what went wrong with a way to ask again. */
function SectionFoot({ lane, onRetry }: { lane: Lane; onRetry: () => void }) {
  if (lane.state === 'loading' && lane.summary) return <p className="px-1 text-[14px] text-muted-foreground">Loading more stories</p>;
  if (lane.state !== 'error' || !lane.error) return null;
  return (
    <Panel role="alert" className="flex flex-col items-start gap-3 p-4">
      <p>
        <span className="font-semibold">{lane.error.message}</span> <span className="text-muted-foreground">{lane.error.next}</span>
      </p>
      <Button variant="outline" className="h-11 px-5" onClick={onRetry}>
        Try again
      </Button>
    </Panel>
  );
}

/** A fact's name and numbers over its stories, as each lane is on a computer. */
function SectionHead({ lane, id }: { lane: Lane; id: string }) {
  const c = lane.counts;
  return (
    <div className="px-1 pt-3">
      <h2 id={id} className="text-[20px] leading-[1.3] font-bold tracking-[-0.015em] text-pretty">
        {lane.fact.statement}
      </h2>
      {c && (
        <p className="text-[14px] text-muted-foreground tabular-nums">
          {n(c.matched)} matched · {n(c.picked)} picked · {n(c.leftOut)} left out
        </p>
      )}
    </div>
  );
}

/** One fact on the Feed: its picks as app cards, then what is not judged yet. It loads and pages on its own. */
function FactSection({ lane, ai, names, more, retry }: { lane: Lane; ai: boolean; names: Map<string, string>; more: () => void; retry: () => void }) {
  const id = useId();
  const picks = useMemo(() => lane.stories.filter((s) => s.verdict?.verdict === 'picked').sort(byLevel), [lane.stories]);
  const open = useMemo(() => lane.stories.filter((s) => !s.verdict), [lane.stories]);
  return (
    <section aria-labelledby={id} aria-busy={lane.state === 'loading'} className="flex flex-col gap-3">
      <SectionHead lane={lane} id={id} />
      {!lane.summary && lane.state === 'loading' && <CardSkeleton />}
      {picks.map((s) => (
        <PickCard key={s.id} s={s} names={names} />
      ))}
      {open.length > 0 && (
        <>
          <p className="px-1 pt-1 text-[14px] text-pretty text-muted-foreground">
            <span className="font-semibold text-foreground">Not judged yet.</span> {ai ? 'Mera News is reading these now.' : 'They matched this fact. Ask your assistant to pick from them.'}
          </p>
          {open.map((s) => (
            <StoryRow key={s.id} story={s} opens={detailLink(fromFeed(s, names))} />
          ))}
        </>
      )}
      {lane.summary && picks.length === 0 && open.length === 0 && lane.state === 'end' && (
        <p className="px-1 text-[14px] text-muted-foreground">{lane.counts?.matched ? 'Nothing was picked for this fact.' : 'Nothing matched this fact yet.'}</p>
      )}
      <SectionFoot lane={lane} onRetry={retry} />
      <NearEnd lane={lane} onNear={more} />
    </section>
  );
}

/** One fact's left-out stories, each with its reason. */
function LeftOutSection({ lane, names, more, retry }: { lane: Lane; names: Map<string, string>; more: () => void; retry: () => void }) {
  const id = useId();
  const left = useMemo(() => lane.stories.filter((s) => s.verdict?.verdict === 'left_out'), [lane.stories]);
  if (lane.summary && lane.counts?.leftOut === 0 && lane.state !== 'error') return null;
  return (
    <section aria-labelledby={id} aria-busy={lane.state === 'loading'} className="flex flex-col gap-3">
      <SectionHead lane={lane} id={id} />
      {!lane.summary && lane.state === 'loading' && <div aria-hidden className="h-[140px] animate-pulse rounded-[18px] bg-muted" />}
      {left.map((s) => (
        <StoryRow key={s.id} story={s} opens={detailLink(fromFeed(s, names))}>
          <Reason>{s.verdict!.reason}</Reason>
        </StoryRow>
      ))}
      <SectionFoot lane={lane} onRetry={retry} />
      <NearEnd lane={lane} onNear={more} />
    </section>
  );
}

/** The Feed on a phone: the counts card, then each fact with its picks and what is not judged yet, and what was left out. */
export function PhoneFeed() {
  const [view, setView] = useState<View>('feed');
  const { ready, facts, ai, lanes, factsError, retryFacts, summary, partial, stories, load, more } = useFeed('');
  const go = (v: View) => {
    setView(v);
    window.scrollTo({ top: 0 });
  };

  const header = (
    <PhoneHeader>
      <h1 className="sr-only">Your news</h1>
      <Pills
        label="Show"
        value={view}
        onChange={go}
        pills={[
          { value: 'feed', label: 'Feed', icon: Newspaper },
          { value: 'left-out', label: 'Left out', icon: EyeOff },
        ]}
      />
    </PhoneHeader>
  );

  if (ready && facts === 0) {
    return (
      <>
        {header}
        <Empty title="Mera News has no profile for you yet">
          <p>
            Ask your assistant to set up your news profile, or add a fact on{' '}
            <Link href="/you/" className={LINK}>
              You
            </Link>
            .
          </p>
        </Empty>
      </>
    );
  }

  const allEnded = lanes.length > 0 && lanes.every((l) => l.state === 'end');
  const nothing = summary && summary.stories === 0 && allEnded;
  const retry = (l: Lane) => () => void load(l.fact, l.summary ? l.next : null);
  const names = new Map(lanes.map((l) => [l.fact.id, l.fact.statement]));
  return (
    <>
      {header}
      <div className="flex flex-col gap-3 px-4 pt-3">
        {factsError && (
          <Panel role="alert" className="flex flex-col items-start gap-3 p-4">
            <p>
              <span className="font-semibold">{factsError.message}</span> <span className="text-muted-foreground">{factsError.next}</span>
            </p>
            <Button variant="outline" className="h-11 px-5" onClick={() => void retryFacts()}>
              Try again
            </Button>
          </Panel>
        )}

        {view === 'feed' ? (
          <>
            {summary ? summary.articles > 0 && <CountsCard summary={summary} ai={ai} partial={partial} /> : !factsError && <div aria-hidden className="h-[92px] animate-pulse rounded-[20px] bg-muted" />}
            {!lanes.length && !factsError && <CardSkeleton />}
            {nothing ? (
              <Empty title="Nothing matched your topics yet">
                <p>
                  Mera News looked for news on your {plural(summary.topics.length, 'topic')} from the last {summary.windowHours} hours. Check again later, or add more facts on{' '}
                  <Link href="/you/" className={LINK}>
                    You
                  </Link>
                  .
                </p>
              </Empty>
            ) : (
              lanes.map((l) => <FactSection key={l.fact.id} lane={l} ai={ai} names={names} more={() => more(l.fact.id)} retry={retry(l)} />)
            )}
            {summary && summary.leftOut > 0 && (
              <button type="button" onClick={() => go('left-out')} className="mt-3 flex min-h-14 items-center gap-3 rounded-[20px] border bg-card px-4 text-left">
                <EyeOff aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-[16px] font-semibold">Less likely to matter to you</span>
                <span className="text-muted-foreground tabular-nums">{n(summary.leftOut)}</span>
                <ChevronRight aria-hidden className="size-5 text-muted-foreground" />
              </button>
            )}
          </>
        ) : (
          <>
            <div className="px-1 pt-1">
              <h2 className="text-[22px] font-bold tracking-[-0.02em]">Less likely to matter to you</h2>
              <p className="text-[14px] text-pretty text-muted-foreground">
                {summary ? `${partial ? 'At least ' : ''}${plural(summary.leftOut, 'story', 'stories')} matched your facts and ${summary.leftOut === 1 ? 'was' : 'were'} left out, each with the reason.` : 'Loading'}
              </p>
            </div>
            {lanes.map((l) => (
              <LeftOutSection key={l.fact.id} lane={l} names={names} more={() => more(l.fact.id)} retry={retry(l)} />
            ))}
            {summary && summary.leftOut === 0 && allEnded && <p className="px-1 py-2 text-muted-foreground">Nothing was left out.</p>}
          </>
        )}
      </div>
      <div className="px-5 pt-3 text-[14px] text-muted-foreground" aria-live="polite">
        {allEnded && stories.length > 0 && view === 'feed' && <p>{`That is every story that matched your facts, ${plural(stories.length, 'story', 'stories')}.`}</p>}
      </div>
      <PublisherLine className="px-5" />
    </>
  );
}

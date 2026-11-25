'use client';

import { ChevronDown, ChevronRight, EyeOff, Newspaper, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useId, useMemo, useState } from 'react';
import { LevelChip, NoteBox, Panel, PhoneHeader, PhoneHeadline, Pills, ReadOn, ShareButton, SourceRow, StoryImage, StoryRow } from '@/components/phone/ui';
import { Empty, PublisherLine } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { byLevel, type FeedStory, type FeedSummary } from '@/lib/feed';
import { plural } from '@/lib/news';
import { useFeed, type Load } from '@/lib/use-feed';

type View = 'feed' | 'left-out';

const n = (x: number) => x.toLocaleString('en');
const LINK = 'font-semibold text-accent-foreground underline decoration-primary/60 underline-offset-[3px]';

/** The numbers over the Feed, as the app says them, opening to the numbers per fact. */
function CountsCard({ summary, ai, state }: { summary: FeedSummary; ai: boolean; state: Load }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Panel className="flex flex-col gap-3 p-4">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex items-start gap-3 text-left">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static export has no image server */}
        <img src="/mark.png" alt="" width={40} height={40} className="size-10 shrink-0 rounded-[10px]" />
        <p className="flex-1 text-[15px] leading-snug text-pretty tabular-nums">
          {plural(summary.articles, 'article')} {summary.articles === 1 ? 'was' : 'were'} read for you in the last {summary.windowHours} hours: {plural(summary.stories, 'story', 'stories')}{' '}
          matched, {n(summary.picked)} picked, {n(summary.leftOut)} left out.
        </p>
        <ChevronDown aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground transition-transform in-aria-expanded:rotate-180" />
        <span className="sr-only">{open ? 'Hide the numbers for each fact' : 'Show the numbers for each fact'}</span>
      </button>
      {open && (
        <div id={id} className="flex flex-col gap-3 border-t pt-3 text-[14px]">
          <p className="text-muted-foreground">
            {n(summary.merged)} {summary.merged === 1 ? 'duplicate was' : 'duplicates were'} merged. The stories come from {state === 'end' ? '' : 'at least '}
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
          <span className="font-semibold">{plural(summary.unjudged, 'story', 'stories')} not judged yet.</span>{' '}
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
function PickCard({ s }: { s: FeedStory }) {
  const v = s.verdict!;
  return (
    <Panel as="article" className="overflow-hidden">
      <StoryImage src={s.image} className="aspect-[12/5] w-full" />
      <div className="flex flex-col gap-3 p-4">
        <SourceRow report={s} />
        <PhoneHeadline report={s} as="h2" className="text-[20px] leading-[1.3] font-bold tracking-[-0.015em]" />
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

/** The Feed on a phone: the counts card, the picks as app cards, what is not judged yet, and what was left out. */
export function PhoneFeed() {
  const [view, setView] = useState<View>('feed');
  const { ready, facts, ai, summary, stories, next, state, error, load, sentinel } = useFeed('');
  const picks = useMemo(() => stories.filter((s) => s.verdict?.verdict === 'picked').sort(byLevel), [stories]);
  const open = useMemo(() => stories.filter((s) => !s.verdict), [stories]);
  const left = useMemo(() => stories.filter((s) => s.verdict?.verdict === 'left_out'), [stories]);
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

  const loadingMore = state === 'loading' && stories.length > 0;
  const nothing = summary && summary.stories === 0 && state === 'end';
  return (
    <>
      {header}
      <div aria-busy={state === 'loading'} className="flex flex-col gap-3 px-4 pt-3">
        {state === 'error' && error && (
          <Panel role="alert" className="flex flex-col items-start gap-3 p-4">
            <p>
              <span className="font-semibold">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
            </p>
            <Button variant="outline" className="h-11 px-5" onClick={() => void load(stories.length ? next : null)}>
              Try again
            </Button>
          </Panel>
        )}

        {view === 'feed' ? (
          <>
            {summary ? summary.articles > 0 && <CountsCard summary={summary} ai={ai} state={state} /> : state !== 'error' && <div aria-hidden className="h-[92px] animate-pulse rounded-[20px] bg-muted" />}
            {!summary && state === 'loading' && <CardSkeleton />}
            {nothing && (
              <Empty title="Nothing matched your topics yet">
                <p>
                  Mera News looked for news on your {plural(summary.topics.length, 'topic')} from the last {summary.windowHours} hours. Check again later, or add more facts on{' '}
                  <Link href="/you/" className={LINK}>
                    You
                  </Link>
                  .
                </p>
              </Empty>
            )}
            {picks.map((s) => (
              <PickCard key={s.id} s={s} />
            ))}
            {summary && !nothing && picks.length === 0 && open.length === 0 && state === 'end' && (
              <p className="px-1 py-2 text-muted-foreground">Nothing was picked for you this time.</p>
            )}
            {open.length > 0 && (
              <section aria-labelledby="unjudged" className="flex flex-col gap-3 pt-3">
                <div className="px-1">
                  <h2 id="unjudged" className="text-[20px] font-bold tracking-[-0.015em]">
                    Not judged yet
                  </h2>
                  <p className="text-[14px] text-pretty text-muted-foreground">
                    {ai ? 'Mera News is reading these now.' : 'They matched your facts. Ask your assistant to pick from them.'}
                  </p>
                </div>
                {open.map((s) => (
                  <StoryRow key={s.id} story={s} />
                ))}
              </section>
            )}
            {summary && summary.leftOut > 0 && (
              <button type="button" onClick={() => go('left-out')} className="mt-1 flex min-h-14 items-center gap-3 rounded-[20px] border bg-card px-4 text-left">
                <EyeOff aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                <span className="flex-1 text-[16px] font-semibold">Less likely to matter to you</span>
                <span className="text-muted-foreground tabular-nums">{n(summary.leftOut)}</span>
                <ChevronRight aria-hidden className="size-5 text-muted-foreground" />
              </button>
            )}
          </>
        ) : (
          <section aria-labelledby="left-out" className="flex flex-col gap-3">
            <div className="px-1 pt-1">
              <h2 id="left-out" className="text-[22px] font-bold tracking-[-0.02em]">
                Less likely to matter to you
              </h2>
              <p className="text-[14px] text-pretty text-muted-foreground">
                {summary ? `${plural(summary.leftOut, 'story', 'stories')} matched your facts and ${summary.leftOut === 1 ? 'was' : 'were'} left out, each with the reason.` : 'Loading'}
              </p>
            </div>
            {left.map((s) => (
              <StoryRow key={s.id} story={s}>
                <Reason>{s.verdict!.reason}</Reason>
              </StoryRow>
            ))}
            {summary && summary.leftOut === 0 && state === 'end' && <p className="px-1 py-2 text-muted-foreground">Nothing was left out.</p>}
          </section>
        )}
      </div>
      <div ref={sentinel} aria-hidden className="h-px" />
      <div className="px-5 pt-3 text-[14px] text-muted-foreground" aria-live="polite">
        {loadingMore && <p>Loading more stories</p>}
        {state === 'end' && stories.length > 0 && view === 'feed' && <p>{`That is every story that matched your facts, ${plural(stories.length, 'story', 'stories')}.`}</p>}
      </div>
      <PublisherLine className="px-5" />
    </>
  );
}

'use client';

import { ChevronDown, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { Headline } from '@/components/headline';
import { Meta } from '@/components/story-card';
import { byLevel, LEVEL_LABEL, type FeedStory, type FeedSummary, type Level as LevelName } from '@/lib/feed';
import { plural } from '@/lib/news';
import { cn } from '@/lib/utils';

export type Show = 'all' | 'picked' | 'left-out';

/**
 * Picked against left out, out of everything that matched this fact. The two widths move as stories
 * are judged, so a lane fills in while the assistant or the pod works.
 */
function CountBar({ matched, picked, leftOut }: { matched: number; picked: number; leftOut: number }) {
  const pct = (n: number) => `${matched ? (n / matched) * 100 : 0}%`;
  return (
    <div
      role="img"
      aria-label={`${plural(picked, 'story', 'stories')} picked and ${leftOut.toLocaleString('en')} left out, of ${matched.toLocaleString('en')} matched`}
      className="flex h-1.5 overflow-hidden rounded-full bg-border"
    >
      <div className="h-full rounded-full bg-primary transition-[width] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none" style={{ width: pct(picked) }} />
      <div className="h-full bg-muted-foreground/35 transition-[width] duration-700 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none" style={{ width: pct(leftOut) }} />
    </div>
  );
}

function Level({ level }: { level: LevelName }) {
  return (
    <span
      className={cn(
        'rounded-full border px-2 py-px text-[11px] font-medium',
        level === 'emergency' ? 'border-red-500/60 text-red-700 dark:text-red-400' : level === 'high' ? 'border-primary/60 text-accent-foreground' : 'text-muted-foreground',
      )}
    >
      {LEVEL_LABEL[level]}
    </span>
  );
}

/** Why Mera picked or left out a story, as the phone's note box: the level and an AI-generated mark on top, the reason under them. Left out is quieter so picks stand out. */
function Reason({ verdict, quiet }: { verdict: NonNullable<FeedStory['verdict']>; quiet?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-1.5 rounded-[8px] px-2.5 py-2', quiet ? 'bg-note/60' : 'bg-note')}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        {verdict.level ? <Level level={verdict.level} /> : <span />}
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Sparkles aria-hidden className="size-3" />
          AI-generated
        </span>
      </div>
      <p className={cn('leading-snug text-pretty', quiet ? 'text-[12.5px] text-muted-foreground' : 'text-[13px] text-foreground/85')}>{verdict.reason}</p>
    </div>
  );
}

/** A pick, or a story nobody has judged yet: the publisher's image on a lane's first card, where it came from, the headline and why. */
function Card({ s, image }: { s: FeedStory; image: boolean }) {
  const [shown, setShown] = useState(Boolean(s.image));
  const picked = s.verdict?.verdict === 'picked';
  return (
    <article className={cn('flex min-w-0 flex-col gap-2 rounded-[12px] border bg-card p-3', !picked && 'border-dashed bg-transparent')}>
      {image && s.image && shown && (
        // eslint-disable-next-line @next/next/no-img-element -- a static export has no image server
        <img
          src={s.image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setShown(false)}
          className="h-[90px] w-full rounded-[8px] bg-muted object-cover"
        />
      )}
      <Meta report={s} />
      <Headline report={s} size="card" />
      {picked ? (
        <Reason verdict={s.verdict!} />
      ) : (
        <p className="text-[12px] text-muted-foreground">Not judged yet</p>
      )}
    </article>
  );
}

/** Left out, with the reason each one was. Open by default only when that is all the page shows. */
function LeftOut({ stories, count, open: always }: { stories: FeedStory[]; count: number; open: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const list = (
    <ul id={id} className="flex flex-col gap-3 pt-1">
      {stories.map((s) => (
        <li key={s.id} className="flex flex-col gap-0.5">
          <Meta report={s} />
          <Headline report={s} size="row" />
          <div className="pt-1.5">
            <Reason verdict={s.verdict!} quiet />
          </div>
        </li>
      ))}
      {stories.length < count && <li className="text-[12px] text-muted-foreground">The rest load as you scroll this lane.</li>}
    </ul>
  );
  if (count === 0) return null;
  if (always) return list;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border text-[12px] text-muted-foreground tabular-nums transition-colors hover:border-primary/60 hover:text-foreground aria-expanded:border-primary aria-expanded:text-accent-foreground"
      >
        Left out · {count.toLocaleString('en')}
        <ChevronDown aria-hidden className="size-3.5 transition-transform in-aria-expanded:rotate-180" />
      </button>
      {open && list}
    </div>
  );
}

/** One fact's lane: its name and numbers, the count bar, the picks, what is not judged yet, and what was left out. */
export function Lane({ fact, stories, show, searching, onNearEnd }: { fact: FeedSummary['facts'][number]; stories: FeedStory[]; show: Show; searching: boolean; onNearEnd?: () => void }) {
  const picks = stories.filter((s) => s.verdict?.verdict === 'picked').sort(byLevel);
  const open = stories.filter((s) => !s.verdict);
  const left = stories.filter((s) => s.verdict?.verdict === 'left_out');
  const cards = show === 'all' ? [...picks, ...open] : show === 'picked' ? picks : [];
  const headingId = useId();
  return (
    <section id={`lane-${fact.id}`} aria-labelledby={headingId} className="flex min-h-0 w-[262px] flex-none flex-col gap-2.5">
      <div className="flex flex-none flex-col gap-1.5">
        <h2 id={headingId} tabIndex={-1} className="line-clamp-2 font-semibold tracking-[-0.01em] text-balance outline-offset-4">
          {fact.statement}
        </h2>
        <p className="text-[12px] text-muted-foreground tabular-nums">
          {fact.matched.toLocaleString('en')} matched · {fact.picked.toLocaleString('en')} picked · {fact.leftOut.toLocaleString('en')} left out
        </p>
        <CountBar matched={fact.matched} picked={fact.picked} leftOut={fact.leftOut} />
      </div>
      {/* Each lane scrolls on its own under its header; nearing its end asks for the next page. */}
      <div
        tabIndex={-1}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (onNearEnd && el.scrollTop + el.clientHeight > el.scrollHeight - 600) onNearEnd();
        }}
        className="-mx-1 flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain px-1 pb-4 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]"
      >
      {cards.map((s, i) => (
        <Card key={s.id} s={s} image={i === 0} />
      ))}
      {show !== 'left-out' && cards.length === 0 && (
        <p className="py-2 text-[13px] text-muted-foreground">{searching ? 'Nothing here matches your search.' : show === 'picked' ? 'Nothing picked for this fact yet.' : 'Nothing matched this fact yet.'}</p>
      )}
      {show !== 'picked' && <LeftOut stories={left} count={show === 'left-out' || searching ? left.length : fact.leftOut} open={show === 'left-out'} />}
      {show === 'left-out' && left.length === 0 && <p className="py-2 text-[13px] text-muted-foreground">{searching ? 'Nothing here matches your search.' : 'Nothing left out for this fact.'}</p>}
      </div>
    </section>
  );
}

/** A lane's shape while the first page loads. */
export function LaneSkeleton() {
  return (
    <div aria-hidden className="flex w-[262px] flex-none flex-col gap-2.5">
      <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-1.5 animate-pulse rounded-full bg-muted" />
      {[true, false, false].map((img, i) => (
        <div key={i} className="flex flex-col gap-2.5 rounded-[12px] border bg-card p-3">
          {img && <div className="h-[90px] animate-pulse rounded-[8px] bg-muted" />}
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

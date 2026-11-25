'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { Headline } from '@/components/headline';
import { ApiError } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { byDay, clock, FOLLOW_MAX, storyHref, updated, useTimeline, type Entry, type FollowedStory } from '@/lib/followed';
import { languageLabel, plural } from '@/lib/news';
import { cn } from '@/lib/utils';

const LINK = 'text-accent-foreground underline decoration-primary/60 underline-offset-[3px] hover:decoration-primary';

/** The small mark on a title Mera News wrote, as the app marks it. */
export function AiMark({ className }: { className?: string }) {
  return (
    <span role="img" aria-label="Title written by AI" title="Title written by AI" className={cn('inline-block align-[-0.05em] text-muted-foreground', className)}>
      <Sparkles aria-hidden className="size-[0.8em]" strokeWidth={2.25} />
    </span>
  );
}

/** A story's title, with the AI mark when Mera News wrote it. */
export function StoryTitle({ story }: { story: FollowedStory }) {
  if (!story.titleIsAi) return <>{story.title}</>;
  // The last character carries the mark, so it never sits alone on a line; a title with no spaces still wraps.
  const cut = [...new Intl.Segmenter().segment(story.title)].pop()?.index ?? 0;
  return (
    <>
      {story.title.slice(0, cut)}
      <span className="whitespace-nowrap">
        {story.title.slice(cut)}
        <AiMark className="ml-1.5" />
      </span>
    </>
  );
}

/** The count of stories added since the person last looked. */
export function NewBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return <span className={cn('inline-flex h-5 shrink-0 items-center rounded-full bg-foreground px-2 text-[11px] font-semibold text-background tabular-nums', className)}>{count.toLocaleString('en')} new</span>;
}

/** Said under the list while Mera News reads no news, which is what makes a followed story grow. */
export function NotGrowingNote({ className }: { className?: string }) {
  return (
    <p className={cn('text-pretty text-muted-foreground', className)}>
      A followed story grows only while Mera News reads the news, and reading needs an AI service.{' '}
      <Link href="/you/#ai" className={LINK}>
        Add an AI service
      </Link>{' '}
      to keep these stories up to date.
    </p>
  );
}

/** The second step of a two-step action: the question, then yes or keep it. Nothing can be undone after. */
export function ConfirmBox({ label, question, yes, doing, onYes, onNo, className }: { label: string; question: string; yes: string; doing: string; onYes: () => Promise<void>; onNo: () => void; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  return (
    <div role="group" aria-label={label} className={cn('relative z-10 flex flex-col gap-2', className)}>
      <p className="text-[13px] max-md:text-[15px]">{question}</p>
      {error && (
        <p role="alert" className="text-[13px] max-md:text-[15px]">
          <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onYes();
            } catch (e) {
              setError(e instanceof ApiError ? e : new ApiError('That did not work.', 'Try again in a minute.'));
              setBusy(false);
            }
          }}
        >
          {busy ? doing : yes}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onNo}>
          Keep it
        </Button>
      </div>
    </div>
  );
}

/** A two-step action: the trigger asks, and the box in its place does it. */
export function Confirm({ trigger, ...box }: Omit<Parameters<typeof ConfirmBox>[0], 'onNo'> & { trigger: (open: () => void) => ReactNode }) {
  const [asking, setAsking] = useState(false);
  return asking ? <ConfirmBox {...box} onNo={() => setAsking(false)} /> : <>{trigger(() => setAsking(true))}</>;
}

/** The field that follows a story by what to search for. */
export function FollowForm({ follow, className, onDone }: { follow: (text: string) => Promise<{ hint: string }>; className?: string; onDone: (hint: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const t = text.trim();
  return (
    <form
      className={cn('flex flex-col gap-2', className)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!t || busy) return;
        setBusy(true);
        setError(null);
        try {
          onDone((await follow(t)).hint);
          setText('');
        } catch (err) {
          setError(err instanceof ApiError ? err : new ApiError('The story could not be followed.', 'Try again in a minute.'));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Follow a story</span>
          <Input name="follow" maxLength={FOLLOW_MAX} autoComplete="off" placeholder="Follow a story" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <Button type="submit" size="sm" disabled={!t || busy}>
          {busy ? 'Following' : 'Follow'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-[13px] max-md:text-[15px]">
          <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
        </p>
      )}
    </form>
  );
}

/** One followed story in the list: its title opens the timeline; the latest headline opens the publisher's site. */
function StoryItem({ story, current, unfollow }: { story: FollowedStory; current: boolean; unfollow: (id: string) => Promise<void> }) {
  const meta = [updated(story.updatedAt), plural(story.articles, 'article')].filter(Boolean).join(' · ');
  return (
    <li
      className={cn(
        'relative flex flex-col gap-2 rounded-[12px] border bg-card p-3 transition-colors hover:border-primary/60',
        current && 'border-primary hover:border-primary',
      )}
    >
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 font-semibold leading-snug tracking-[-0.01em] text-balance">
          {/* The whole card opens the story; links and buttons inside sit above this cover. */}
          <Link href={storyHref(story.id)} aria-current={current ? 'page' : undefined} className="outline-none after:absolute after:inset-0 after:rounded-[12px] focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-ring">
            <StoryTitle story={story} />
          </Link>
        </h2>
        <NewBadge count={story.newCount} className="mt-0.5" />
      </div>
      {story.latest && (
        <div className="relative z-10 flex flex-col gap-0.5">
          <Headline report={story.latest} size="row" />
        </div>
      )}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-2">
        <p className="text-[12px] text-muted-foreground tabular-nums">{meta}</p>
        <Confirm
          label="Unfollow this story"
          question="Stop following this story? Its timeline goes too."
          yes="Unfollow"
          doing="Unfollowing"
          onYes={() => unfollow(story.id)}
          className="basis-full border-t pt-2"
          trigger={(open) => (
            <Button size="sm" variant="ghost" className="relative z-10 -mr-1.5" onClick={open}>
              Unfollow
            </Button>
          )}
        />
      </div>
    </li>
  );
}

/** Every followed story, newest news first. */
export function StoryList({ stories, current, unfollow }: { stories: FollowedStory[]; current: string | null; unfollow: (id: string) => Promise<void> }) {
  return (
    <ul className="flex flex-col gap-2.5">
      {stories.map((s) => (
        <StoryItem key={s.id} story={s} current={s.id === current} unfollow={unfollow} />
      ))}
    </ul>
  );
}

/** Publisher · time · language, and copies of the same event folded under it. */
export function EntryMeta({ e, className }: { e: Entry; className?: string }) {
  const parts = [clock(e.publishedAt), languageLabel(e.language)].filter(Boolean);
  return (
    <p className={cn('text-[12px] text-muted-foreground tabular-nums max-md:text-[13px]', className)}>
      <span className="font-medium text-foreground/80">{e.publisher || 'Unknown publisher'}</span>
      {parts.map((p) => ` · ${p}`)}
      {e.copies > 0 && ` · ${plural(e.copies, 'more report')}`}
    </p>
  );
}

/** One story's timeline on a computer: newest first, a heading for each day, each article a link out. */
export function Timeline({ id, onSeen, onGone }: { id: string; onSeen: (id: string) => void; onGone: () => void }) {
  const t = useTimeline(id, onSeen);
  if (!t.story) {
    if (t.state === 'error' && t.error) {
      return (
        <div role="alert" className="flex flex-col items-start gap-3 py-2">
          <p>
            <span className="font-medium">{t.error.message}</span> <span className="text-muted-foreground">{t.error.next}</span>
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={t.retry}>
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={onGone}>
              Back to your stories
            </Button>
          </div>
        </div>
      );
    }
    return <TimelineSkeleton />;
  }
  const s = t.story;
  return (
    <article aria-labelledby="timeline-title" aria-busy={t.state === 'loading'} className="flex max-w-[720px] flex-col gap-5">
      <header className="flex flex-col gap-1.5">
        <h2 id="timeline-title" className="text-[22px] leading-tight font-bold tracking-[-0.02em] text-balance">
          <StoryTitle story={s} />
        </h2>
        <p className="text-muted-foreground tabular-nums">
          {plural(s.articles, 'article')} · {updated(s.updatedAt)}
        </p>
      </header>
      {t.entries.length === 0 && t.state === 'end' && (
        <p className="text-pretty text-muted-foreground">Nothing on this story yet. New reports show here as Mera News finds them.</p>
      )}
      {/* A label can come back (dates out of order, several unknown), so a section is keyed by its place. */}
      {byDay(t.entries).map(({ day, entries }, i) => (
        <section key={`${i}-${day}`} aria-label={day} className="flex flex-col">
          <h3 className="sticky top-0 z-10 border-b bg-background py-2 text-[13px] font-semibold text-muted-foreground">{day}</h3>
          <ul className="flex flex-col">
            {entries.map((e) => (
              <EntryRow key={e.id} e={e} remove={t.remove} />
            ))}
          </ul>
        </section>
      ))}
      <div aria-live="polite" className="flex flex-col items-start gap-2 pb-6 empty:hidden">
        {t.state === 'loading' && t.entries.length > 0 && <p className="text-[13px] text-muted-foreground">Loading older articles</p>}
        {t.state === 'more' && (
          <Button variant="outline" size="sm" onClick={t.more}>
            Show older articles
          </Button>
        )}
        {t.state === 'error' && t.error && (
          <div role="alert" className="flex flex-col items-start gap-2 text-[13px]">
            <p>
              <span className="font-medium">{t.error.message}</span> <span className="text-muted-foreground">{t.error.next}</span>
            </p>
            <Button variant="outline" size="sm" onClick={t.retry}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}

function EntryRow({ e, remove }: { e: Entry; remove: (articleId: string) => Promise<void> }) {
  const [shown, setShown] = useState(Boolean(e.image));
  return (
    <li className="flex gap-3 border-b py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2">
          <EntryMeta e={e} className="min-w-0" />
          <Confirm
            label="Remove this article"
            question="Remove this article from the story for good?"
            yes="Remove"
            doing="Removing"
            onYes={() => remove(e.id)}
            className="order-last basis-full pt-1 pb-2"
            trigger={(open) => (
              <button type="button" onClick={open} className="-my-1 rounded-full px-2 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                Remove from story
              </button>
            )}
          />
        </div>
        <Headline report={e} size="card" />
        {!e.link && <p className="text-[12px] text-muted-foreground">Link no longer available</p>}
      </div>
      {/* The slot stays without an image, so Remove from story lines up down the timeline. */}
      {e.image && shown ? (
        // eslint-disable-next-line @next/next/no-img-element -- a static export has no image server
        <img src={e.image} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setShown(false)} className="size-[72px] shrink-0 rounded-[8px] bg-muted object-cover" />
      ) : (
        <div aria-hidden className="w-[72px] shrink-0" />
      )}
    </li>
  );
}

function TimelineSkeleton() {
  return (
    <div aria-hidden className="flex max-w-[720px] flex-col gap-4">
      <div className="h-6 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex flex-col gap-2 border-b py-3">
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

'use client';

import { ChevronLeft, CircleMinus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Confirm, ConfirmBox, EntryMeta, FollowForm, NotGrowingNote, StoryTitle } from '@/components/following';
import { Headline } from '@/components/headline';
import { Panel, PhoneHeader, StoryImage } from '@/components/phone/ui';
import { Empty, PublisherLine } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { byDay, storyHref, updated, useFollowed, useTimeline, type Entry, type FollowedStory } from '@/lib/followed';
import { plural } from '@/lib/news';

const ROUND = 'flex size-11 shrink-0 items-center justify-center rounded-full border bg-card text-foreground/85';

/** The app's "N new" pill: orange ink on an orange wash. */
function NewPill({ count }: { count: number }) {
  if (count <= 0) return null;
  return <span className="inline-flex h-7 shrink-0 items-center rounded-full bg-accent px-3 text-[14px] font-semibold text-accent-foreground tabular-nums">{count.toLocaleString('en')} new</span>;
}

/** A followed story as the app's card: title, new count, the latest headline, when it last grew, and unfollow. */
function StoryCard({ story, unfollow }: { story: FollowedStory; unfollow: (id: string) => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  return (
    <Panel as="article" className="relative flex flex-col gap-2 p-4">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-[20px] leading-[1.3] font-bold tracking-[-0.015em] text-pretty">
          <Link href={storyHref(story.id)} className="outline-none after:absolute after:inset-0 after:rounded-[20px] focus-visible:after:outline-2 focus-visible:after:outline-ring">
            <StoryTitle story={story} />
          </Link>
        </h2>
        <NewPill count={story.newCount} />
        <button
          type="button"
          aria-label={`Unfollow ${story.title}`}
          aria-expanded={asking}
          onClick={() => setAsking(!asking)}
          className="relative z-10 -mt-2 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/70 active:bg-muted"
        >
          <CircleMinus aria-hidden className="size-6" strokeWidth={1.5} />
        </button>
      </div>
      {story.latest && (
        <div className="relative z-10 flex flex-col gap-0.5 text-foreground/80">
          <Headline report={story.latest} size="row" />
        </div>
      )}
      <p className="text-[14px] text-muted-foreground tabular-nums">{[updated(story.updatedAt), plural(story.articles, 'article')].filter(Boolean).join(' · ')}</p>
      {asking && (
        <ConfirmBox
          label="Unfollow this story"
          question="Stop following this story? Its timeline goes too."
          yes="Unfollow"
          doing="Unfollowing"
          onYes={() => unfollow(story.id)}
          onNo={() => setAsking(false)}
          className="border-t pt-3"
        />
      )}
    </Panel>
  );
}

/** One article on a story's timeline, as the app's list row, with a way to take it off the story. */
function EntryCard({ e, remove }: { e: Entry; remove: (articleId: string) => Promise<void> }) {
  return (
    <Panel as="article" className="flex flex-col gap-2 rounded-[18px] p-3.5">
      <div className="flex gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <EntryMeta e={e} />
          <Headline report={e} size="phone-row" />
          {!e.link && <p className="text-[14px] text-muted-foreground">Link no longer available</p>}
        </div>
        <StoryImage src={e.image} className="size-[76px] shrink-0 rounded-[14px]" />
      </div>
      <Confirm
        label="Remove this article"
        question="Remove this article from the story for good?"
        yes="Remove"
        doing="Removing"
        onYes={() => remove(e.id)}
        className="border-t pt-3"
        trigger={(open) => (
          <Button variant="ghost" size="sm" className="-ml-3 self-start" onClick={open}>
            Remove from story
          </Button>
        )}
      />
    </Panel>
  );
}

/** One story's timeline on a phone: a back button and its title on top, the days and articles under it. */
function PhoneTimeline({ id, onSeen, back }: { id: string; onSeen: (id: string) => void; back: () => void }) {
  const t = useTimeline(id, onSeen);
  const s = t.story;
  return (
    <>
      <PhoneHeader className="justify-start">
        <button type="button" aria-label="Back to the stories you follow" onClick={back} className={ROUND}>
          <ChevronLeft aria-hidden className="size-6" />
        </button>
        {/* The story's title is the heading under it; the header names where Back goes. */}
        <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold">Following</h1>
      </PhoneHeader>
      <div aria-busy={t.state === 'loading'} className="flex flex-col gap-3 px-4 pt-3">
        {s && (
          <div className="px-1 pt-1">
            <h2 className="text-[22px] leading-tight font-bold tracking-[-0.02em] text-pretty">
              <StoryTitle story={s} />
            </h2>
            <p className="text-[14px] text-muted-foreground tabular-nums">
              {plural(s.articles, 'article')} · {updated(s.updatedAt)}
            </p>
          </div>
        )}
        {!s && t.state === 'loading' && <div aria-hidden className="h-[180px] animate-pulse rounded-[18px] bg-muted" />}
        {s && t.entries.length === 0 && t.state === 'end' && <p className="px-1 text-muted-foreground">Nothing on this story yet. New reports show here as Mera News finds them.</p>}
        {byDay(t.entries).map(({ day, entries }, i) => (
          <section key={`${i}-${day}`} aria-label={day} className="flex flex-col gap-3">
            <h3 className="px-1 pt-2 text-[15px] font-semibold text-muted-foreground">{day}</h3>
            {entries.map((e) => (
              <EntryCard key={e.id} e={e} remove={t.remove} />
            ))}
          </section>
        ))}
        {t.state === 'more' && (
          <Button variant="outline" className="h-11 self-center px-5" onClick={t.more}>
            Show older articles
          </Button>
        )}
        {t.state === 'loading' && t.entries.length > 0 && <p className="px-1 text-[14px] text-muted-foreground">Loading older articles</p>}
        {t.state === 'error' && t.error && (
          <Panel role="alert" className="flex flex-col items-start gap-3 p-4">
            <p>
              <span className="font-semibold">{t.error.message}</span> <span className="text-muted-foreground">{t.error.next}</span>
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="h-11 px-5" onClick={t.retry}>
                Try again
              </Button>
              {!s && (
                <Button variant="ghost" className="h-11 px-5" onClick={back}>
                  Back
                </Button>
              )}
            </div>
          </Panel>
        )}
      </div>
      <PublisherLine className="px-5" />
    </>
  );
}

/** Following on a phone: the follow field and the stories as app cards, or one story's timeline. */
export function PhoneFollowing({ id, followed, reading, back }: { id: string | null; followed: ReturnType<typeof useFollowed>; reading: boolean; back: () => void }) {
  const { stories, error, reload, unfollow, follow, seen } = followed;
  const [hint, setHint] = useState('');
  if (id) return <PhoneTimeline key={id} id={id} onSeen={seen} back={back} />;
  return (
    <>
      <PhoneHeader>
        <h1 className="text-[17px] font-semibold">Following</h1>
      </PhoneHeader>
      <div className="flex flex-col gap-3 px-4 pt-3">
        <Panel className="flex flex-col gap-2 p-3">
          <FollowForm follow={follow} onDone={setHint} />
          {hint && (
            <p role="status" className="px-1 text-[14px] text-pretty text-muted-foreground">
              {hint}
            </p>
          )}
        </Panel>
        {error && !stories && (
          <Panel role="alert" className="flex flex-col items-start gap-3 p-4">
            <p>
              <span className="font-semibold">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
            </p>
            <Button variant="outline" className="h-11 px-5" onClick={() => void reload()}>
              Try again
            </Button>
          </Panel>
        )}
        {!stories && !error && [0, 1].map((i) => <div key={i} aria-hidden className="h-[150px] animate-pulse rounded-[20px] bg-muted" />)}
        {stories?.length === 0 && (
          <Empty title="You are not following any story yet">
            <p>Follow a story to keep every new report on it in one timeline, newest first. Open any headline and choose Follow this story, type one above, or ask your assistant to follow one for you.</p>
          </Empty>
        )}
        {stories?.map((s) => (
          <StoryCard key={s.id} story={s} unfollow={unfollow} />
        ))}
        {stories && !reading && <NotGrowingNote className="px-1 text-[14px]" />}
      </div>
    </>
  );
}

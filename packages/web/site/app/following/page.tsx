'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { FollowForm, NotGrowingNote, StoryList, Timeline } from '@/components/following';
import { PhoneFollowing } from '@/components/phone/following';
import { useConnection } from '@/components/session';
import { Empty, TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { useFollowed } from '@/lib/followed';
import { usePhone } from '@/lib/use-phone';

export default function FollowingPage() {
  return (
    <Suspense fallback={null}>
      <Following />
    </Suspense>
  );
}

function Following() {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get('id') ?? '';
  const id = /^[\w.:-]{1,100}$/.test(raw) ? raw : null;
  const followed = useFollowed();
  const c = useConnection();
  const reading = c.kind === 'ready' && !!c.status.ai;
  const back = () => router.push('/following/');
  if (usePhone()) return <PhoneFollowing id={id} followed={followed} reading={reading} back={back} />;
  return <DesktopFollowing id={id} followed={followed} reading={reading} back={back} />;
}

/** On a computer: the stories on the left, the open story's timeline on the right; each side scrolls on its own. */
function DesktopFollowing({ id, followed, reading, back }: { id: string | null; followed: ReturnType<typeof useFollowed>; reading: boolean; back: () => void }) {
  const { stories, error, reload, unfollow, follow, seen } = followed;
  const [hint, setHint] = useState('');
  const gone = async (storyId: string) => {
    await unfollow(storyId);
    if (storyId === id) back();
  };
  return (
    <div className="flex h-dvh min-h-0 flex-col">
      <TopBar end={<FollowForm follow={follow} onDone={setHint} className="w-[360px] max-w-[42vw]" />}>
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">Following</h1>
      </TopBar>
      {hint && (
        <p role="status" className="flex-none border-b px-7 py-2.5 text-[13px] text-pretty">
          {hint}
        </p>
      )}
      {error && !stories ? (
        <div role="alert" className="flex flex-col items-start gap-3 px-7 py-8">
          <p>
            <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
          </p>
          <Button variant="outline" size="sm" onClick={() => void reload()}>
            Try again
          </Button>
        </div>
      ) : stories && stories.length === 0 ? (
        <Empty title="You are not following any story yet">
          <p>Follow a story to keep every new report on it in one timeline, newest first. Open any headline and choose Follow this story, type one above, or ask your assistant to follow one for you.</p>
          {!reading && <NotGrowingNote className="mt-3" />}
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1">
          <section aria-label="Stories you follow" className="flex w-[380px] flex-none flex-col gap-4 overflow-y-auto border-r px-7 pt-5 pb-8 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">
            {stories ? (
              <StoryList stories={stories} current={id} unfollow={gone} />
            ) : (
              <div aria-hidden className="flex flex-col gap-2.5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-[132px] animate-pulse rounded-[12px] bg-muted" />
                ))}
              </div>
            )}
            {stories && !reading && <NotGrowingNote className="text-[13px]" />}
          </section>
          <section aria-label="Timeline" className="min-w-0 flex-1 overflow-y-auto px-7 pt-5 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin]">
            {id ? (
              <Timeline key={id} id={id} onSeen={seen} onGone={back} />
            ) : (
              stories && (
                <p className="pt-10 text-center text-muted-foreground">Choose a story to see every report on it, newest first.</p>
              )
            )}
          </section>
        </div>
      )}
    </div>
  );
}

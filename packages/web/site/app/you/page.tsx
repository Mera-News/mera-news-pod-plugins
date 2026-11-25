'use client';

import { useCallback, useEffect, useState } from 'react';
import { Heading } from '@/components/heading';
import { AddFactNote, FactBoard, type Fact } from '@/components/profile';
import { ApiError, useApi, useConnection, type Status } from '@/components/session';
import { PhonesSection } from '@/components/phones';
import { PhoneYou } from '@/components/phone/you';
import { AiServiceSection, AppearanceSection, DigestSection, KeepRunningSection, PodSection, SignOutSection } from '@/components/settings';
import { TopBar } from '@/components/top-bar';
import { Button } from '@/components/ui/button';
import { usePhone } from '@/lib/use-phone';

export default function YouPage() {
  const c = useConnection();
  return c.kind === 'ready' ? <You initial={c.status} /> : null;
}

function You({ initial }: { initial: Status }) {
  const get = useApi();
  const [status, setStatus] = useState(initial);
  const [profile, setProfile] = useState<{ facts: Fact[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([get<{ facts: Fact[] }>('/api/profile/'), get<Status>('/api/status/')]);
      setProfile(p);
      setStatus(s);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError('Your profile could not load.', 'Try again in a minute.'));
    }
  }, [get]);
  useEffect(() => void load(), [load]);

  // Topics take a minute or two to make: look again until none is still being made.
  const making = !!status.ai && !!profile?.facts.some((f) => f.topicsStatus === 'pending');
  useEffect(() => {
    if (!making) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [making, load]);

  const hasAi = !!status.ai;
  const phone = usePhone();
  if (phone) return <PhoneYou status={status} profile={profile} error={error} reload={() => void load()} />;
  const topics = profile?.facts.reduce((n, f) => n + f.topics.length, 0) ?? status.counts.topics;
  return (
    <>
      <TopBar>
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">You</h1>
      </TopBar>
      <section aria-labelledby="profile-title" className="flex flex-col gap-6 pb-4">
        <Heading
          id="profile-title"
          title="Your profile"
          lead="What Mera News knows about you, as facts. Each fact has news topics; keep the ones that fit and remove the rest."
          numbers={[
            ['Facts', (profile?.facts.length ?? status.counts.facts).toLocaleString('en')],
            ['Topics', topics.toLocaleString('en')],
          ]}
        />
        <AddFactNote className="max-w-[68ch] px-7" />
        {error && (
          <div role="alert" className="flex flex-col items-start gap-3 px-7">
            <p>
              <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
            </p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        )}
        {profile === null && !error ? (
          <div aria-busy className="grid grid-cols-[repeat(auto-fill,minmax(262px,1fr))] gap-[18px] px-7">
            {[0, 1, 2].map((i) => (
              <div key={i} aria-hidden className="h-[148px] animate-pulse rounded-[12px] border bg-card" />
            ))}
          </div>
        ) : profile && profile.facts.length === 0 ? (
          <p className="max-w-[68ch] px-7 text-muted-foreground">
            No facts yet. Where you live, your work and the news you follow are good places to start.
          </p>
        ) : (
          profile && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(262px,1fr))] items-start gap-[18px] px-7">
              {profile.facts.map((f) => (
                <FactBoard key={f.id} fact={f} hasAi={hasAi} onChanged={() => void load()} />
              ))}
            </div>
          )
        )}
      </section>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-x-12 gap-y-10 px-7 pt-10 pb-12">
        <DigestSection />
        <AiServiceSection status={status} onSaved={() => void load()} />
        <PodSection status={status} />
        <AppearanceSection />
        <KeepRunningSection />
        <PhonesSection />
        <SignOutSection />
      </div>
    </>
  );
}

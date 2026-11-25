'use client';

import { ChevronDown, MapPin, Settings, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Panel, PhoneHeader, Pills } from '@/components/phone/ui';
import { PhonesSection } from '@/components/phones';
import { AddFactNote, FactBoard, reviewDue, statusLine, type Fact } from '@/components/profile';
import { onPhone, useApi, type ApiError, type Status } from '@/components/session';
import { AiServiceSection, AppearanceSection, DigestSection, KeepRunningSection, PodSection } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { plural } from '@/lib/news';
import { cn } from '@/lib/utils';

type Tab = 'profile' | 'settings';

/** Links into the settings (#ai from the Feed) open the Settings pill. */
const SETTINGS = ['#settings', '#ai', '#digest', '#pod', '#appearance', '#keep-running', '#phones'];
const tabOf = (): Tab => (SETTINGS.includes(location.hash) ? 'settings' : 'profile');

function FactRow({ fact, hasAi, onChanged }: { fact: Fact; hasAi: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const toReview = reviewDue(fact);
  return (
    <li className="border-t first:border-t-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left">
        <span className="flex-1 text-[16px] leading-snug text-pretty">{fact.statement}</span>
        <span className={cn('max-w-[40%] text-right text-[14px] text-muted-foreground tabular-nums', toReview && 'text-accent-foreground')}>{toReview || fact.topics.length === 0 || (fact.topicsStatus === 'pending' && hasAi) ? statusLine(fact, hasAi, 0) : plural(fact.topics.length, 'topic')}</span>
        <ChevronDown aria-hidden className="size-5 shrink-0 text-muted-foreground transition-transform in-aria-expanded:rotate-180" />
      </button>
      {open && (
        <div className="px-4 pb-4">
          <FactBoard bare fact={fact} hasAi={hasAi} onChanged={onChanged} />
        </div>
      )}
    </li>
  );
}

interface Place {
  name: string;
  role?: string;
}

const ROLE: Record<string, string> = { home: 'Home', work: 'Work', travel: 'Travel', family: 'Family', partner_family: "Partner's family", interest: 'Interest' };

/** The places Mera News took from the person's facts, as the app's Places card: each with its role. */
function PlacesCard() {
  const get = useApi();
  const [places, setPlaces] = useState<Place[] | null>(null);
  useEffect(() => {
    // The same answer World uses; a failure only leaves the card out.
    get<{ places?: Place[] }>('/api/countries/').then((c) => setPlaces(c.places ?? []), () => setPlaces(null));
  }, [get]);
  if (!places) return null;
  return (
    <Panel as="section" aria-labelledby="places-title" className="overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 id="places-title" className="text-[17px] font-bold">
          Places
        </h2>
        <span className="text-muted-foreground tabular-nums">{places.length.toLocaleString('en')}</span>
      </div>
      {places.length === 0 ? (
        <p className="p-4 text-pretty text-muted-foreground">No places yet. Mera News finds them in your facts, such as where you live or work.</p>
      ) : (
        <ul>
          {places.map((p, i) => (
            <li key={`${p.name}-${p.role ?? ''}-${i}`} className="flex min-h-14 items-center gap-3 border-t px-4 py-3 first:border-t-0">
              <span className="flex-1 text-[16px] leading-snug text-pretty">{p.name}</span>
              {p.role && ROLE[p.role] && (
                <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-[14px] font-semibold text-accent-foreground">
                  <MapPin aria-hidden className="size-4" />
                  {ROLE[p.role]}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** You on a phone, as in the app: Profile (facts and their topics, and how to add one) and Settings (digest, AI service, Mera News, phones). */
export function PhoneYou({ status, profile, error, reload }: { status: Status; profile: { facts: Fact[] } | null; error: ApiError | null; reload: () => void }) {
  const [tab, setTab] = useState<Tab>(tabOf);
  const hasAi = !!status.ai;

  useEffect(() => {
    const onHash = () => setTab(tabOf());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // A link to one setting lands on it once the Settings pill shows it.
  useEffect(() => {
    if (tab === 'settings' && location.hash.length > 1) document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [tab]);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', t === 'settings' ? '#settings' : location.pathname);
    window.scrollTo({ top: 0 });
  };

  return (
    <>
      <PhoneHeader>
        <h1 className="sr-only">You</h1>
        <Pills
          label="You"
          value={tab}
          onChange={go}
          pills={[
            { value: 'profile', label: 'Profile', icon: UserRound },
            { value: 'settings', label: 'Settings', icon: Settings },
          ]}
        />
      </PhoneHeader>
      {tab === 'profile' ? (
        <div className="flex flex-col gap-3 px-4 pt-3 pb-6">
          <p className="px-1 text-[14px] text-pretty text-muted-foreground">
            What Mera News knows about you. It stays on {onPhone() ? 'your computer' : 'this computer'}, and Mera Labs keeps no copy.
          </p>
          {error && (
            <Panel role="alert" className="flex flex-col items-start gap-3 p-4">
              <p>
                <span className="font-semibold">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
              </p>
              <Button variant="outline" onClick={reload}>
                Try again
              </Button>
            </Panel>
          )}
          <Panel as="section" aria-labelledby="facts-title" className="overflow-hidden">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 id="facts-title" className="text-[17px] font-bold">
                Facts
              </h2>
              <span className="text-muted-foreground tabular-nums">{(profile?.facts.length ?? status.counts.facts).toLocaleString('en')}</span>
            </div>
            {profile === null && !error ? (
              <div aria-busy className="flex flex-col gap-2 p-4">
                {[0, 1, 2].map((i) => (
                  <div key={i} aria-hidden className="h-6 animate-pulse rounded bg-muted" />
                ))}
              </div>
            ) : profile && profile.facts.length === 0 ? (
              <p className="p-4 text-pretty text-muted-foreground">No facts yet. Where you live, your work and the news you follow are good places to start.</p>
            ) : (
              <ul>{profile?.facts.map((f) => <FactRow key={f.id} fact={f} hasAi={hasAi} onChanged={reload} />)}</ul>
            )}
          </Panel>
          <PlacesCard />
          <Panel className="p-4">
            <AddFactNote className="text-[15px]" />
          </Panel>
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4 pt-3 pb-6">
          <Panel className="p-4">
            <DigestSection />
          </Panel>
          <Panel className="p-4">
            <AiServiceSection status={status} onSaved={reload} />
          </Panel>
          <Panel className="p-4">
            <PodSection status={status} />
          </Panel>
          <Panel className="p-4">
            <AppearanceSection />
          </Panel>
          {!onPhone() && (
            <Panel className="p-4">
              <KeepRunningSection />
            </Panel>
          )}
          <Panel className="p-4">
            <PhonesSection />
          </Panel>
        </div>
      )}
    </>
  );
}

'use client';

import { ChevronDown } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Heading } from '@/components/heading';
import { PublisherLine, TopBar } from '@/components/top-bar';
import { SearchField } from '@/components/search-field';
import { ApiError, useApi } from '@/components/session';
import { PhoneWorldBar } from '@/components/phone/world';
import { Panel, StoryRow } from '@/components/phone/ui';
import { AllReports, StoryCard, StoryCardSkeleton } from '@/components/story-card';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { plural, type Country, type Story } from '@/lib/news';
import { usePhone } from '@/lib/use-phone';

const WORLD = 'GLOBAL';

export default function WorldPage() {
  return (
    <Suspense fallback={null}>
      <World />
    </Suspense>
  );
}

function World() {
  const params = useSearchParams();
  const router = useRouter();
  const get = useApi();
  const q = (params.get('q') ?? '').trim().slice(0, 200);
  const c = params.get('c') ?? '';
  const scope = /^[A-Z]{3}$/.test(c) ? c : WORLD;
  const [countries, setCountries] = useState<{ yours: Country[]; all: Country[] } | null>(null);

  useEffect(() => {
    get<{ yours: Country[]; all: Country[] }>('/api/countries/').then(setCountries, () => setCountries({ yours: [], all: [] }));
  }, [get]);

  const show = (next: { c?: string; q?: string }) =>
    router.push(next.q ? `/world/?q=${encodeURIComponent(next.q)}` : next.c && next.c !== WORLD ? `/world/?c=${next.c}` : '/world/');
  const nameOf = (code: string) => (code === WORLD ? 'the world' : (countries?.all.find((x) => x.code === code) ?? countries?.yours.find((x) => x.code === code))?.name ?? code);
  // The world, the person's countries from their places, and a country chosen here while it is shown.
  const chips = [WORLD, ...(countries?.yours.map((x) => x.code) ?? [])];
  if (!q && !chips.includes(scope)) chips.push(scope);

  const phone = usePhone();
  return (
    <>
      {phone ? (
        <PhoneWorldBar chips={chips} scope={scope} q={q} nameOf={nameOf} all={countries?.all} show={show} />
      ) : (
      <TopBar end={<SearchField placeholder="Search all news" value={q} onSearch={(text) => show(text ? { q: text } : { c: scope })} />}>
        <ToggleGroup aria-label="Top stories for" value={q ? [] : [scope]} onValueChange={(v: unknown[]) => typeof v[0] === 'string' && show({ c: v[0] })} className="flex-wrap">
          {chips.map((code) => (
            <ToggleGroupItem key={code} value={code}>
              {code === WORLD ? 'World' : nameOf(code)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <label className="relative inline-flex">
          <span className="sr-only">Another country</span>
          <select
            value=""
            disabled={!countries?.all.length}
            onChange={(e) => e.target.value && show({ c: e.target.value })}
            className="h-8 cursor-pointer appearance-none rounded-full border border-dashed bg-transparent pr-8 pl-3 text-[13px] text-muted-foreground transition-colors outline-none hover:border-primary/60 hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-50"
          >
            <option value="" disabled>
              Another country
            </option>
            {countries?.all.map((x) => (
              <option key={x.code} value={x.code}>
                {x.name}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        </label>
      </TopBar>
      )}
      {q ? <SearchResults key={q} q={q} phone={phone} /> : <TopStories key={scope} scope={scope} name={nameOf(scope)} phone={phone} />}
      <PublisherLine className="max-md:px-5" />
    </>
  );
}

const Grid = ({ children, busy }: { children: ReactNode; busy?: boolean }) => (
  <div aria-busy={busy} className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-start gap-[18px] px-7 max-md:flex max-md:flex-col max-md:gap-3 max-md:px-4">
    {children}
  </div>
);

const Skeletons = ({ n, phone }: { n: number; phone: boolean }) =>
  Array.from({ length: n }, (_, i) => (phone ? <Panel key={i} aria-hidden className="h-[150px] animate-pulse rounded-[18px]" /> : <StoryCardSkeleton key={i} image={i % 3 === 0} />));

/** A story on the phone as the app's list card, with its reports from every publisher under it. */
const Card = ({ story, phone }: { story: Story; phone: boolean }) => (phone ? <StoryRow story={story} footer={story.reports > 1 && <AllReports story={story} />} /> : <StoryCard story={story} />);

/** The phone's quiet line over a list, in place of the desktop's heading and numbers. */
const PhoneLead = ({ id, title, children }: { id: string; title: string; children: ReactNode }) => (
  <div className="flex flex-col gap-0.5 px-5 pt-3 pb-3">
    <h2 id={id} className="text-[17px] font-semibold tracking-[-0.01em] text-pretty">
      {title}
    </h2>
    <p className="text-[14px] text-pretty text-muted-foreground">{children}</p>
  </div>
);

function Problem({ error, retry }: { error: ApiError; retry: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 px-7 py-10 max-md:px-5">
      <p>
        <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
      </p>
      <Button variant="outline" size="sm" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('Mera News could not answer.', 'Try again in a minute.'));

/** Every top story for one scope, a page at a time as the reader scrolls. Nothing is left out. */
function TopStories({ scope, name, phone }: { scope: string; name: string; phone: boolean }) {
  const get = useApi();
  const [stories, setStories] = useState<Story[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'more' | 'end' | 'error'>('loading');
  const [error, setError] = useState<ApiError | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const load = useCallback(
    async (after: string | null) => {
      setState('loading');
      try {
        const page = await get<{ stories: Story[]; nextCursor: string | null }>(`/api/top/?c=${scope}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        setStories((list) => {
          const ids = new Set(list.map((s) => s.id));
          return [...list, ...page.stories.filter((s) => !ids.has(s.id))];
        });
        setNext(page.nextCursor);
        setState(page.nextCursor ? 'more' : 'end');
      } catch (e) {
        setError(asError(e));
        setState('error');
      }
    },
    [get, scope],
  );

  useEffect(() => void load(null), [load]);

  // The next page loads before the reader reaches the end of this one.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || state !== 'more') return;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void load(next), { rootMargin: '800px 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, [state, next, load]);

  const where = scope === WORLD ? 'the world' : name;
  const reports = stories.reduce((n, s) => n + s.reports, 0);
  const more = state !== 'end' ? '+' : '';
  return (
    <section aria-labelledby="top-title" className="flex flex-col pb-4">
      {phone ? (
        <PhoneLead id="top-title" title={`Top stories in ${where}`}>
          {stories.length ? `${stories.length.toLocaleString('en')}${more} stories from ${reports.toLocaleString('en')}${more} reports. ` : ''}Most reported first, from the last 24 hours. No AI ranks
          this list.
        </PhoneLead>
      ) : (
        <Heading
          id="top-title"
          title={`Top stories in ${where}`}
          lead="The most reported stories of the last 24 hours, most reported first. Open a story's reports to see every publisher that carries it. No AI ranks this page."
          numbers={stories.length ? [['Stories', `${stories.length.toLocaleString('en')}${more}`], ['Reports', `${reports.toLocaleString('en')}${more}`]] : []}
        />
      )}
      {state === 'end' && stories.length === 0 ? (
        <p className="px-7 py-10 text-muted-foreground max-md:px-5">No top stories in {where} in the last 24 hours.</p>
      ) : (
        <Grid busy={state === 'loading'}>
          {stories.map((s) => (
            <Card key={s.id} story={s} phone={phone} />
          ))}
          {state === 'loading' && <Skeletons n={stories.length ? 5 : phone ? 4 : 10} phone={phone} />}
        </Grid>
      )}
      {state === 'error' && error && <Problem error={error} retry={() => void load(stories.length ? next : null)} />}
      <div ref={sentinel} aria-hidden className="h-px" />
      {state === 'end' && stories.length > 0 && (
        <p className="px-7 pt-8 text-muted-foreground max-md:px-5 max-md:text-[14px]">That is every top story in {where} from the last 24 hours.</p>
      )}
    </section>
  );
}

/** All of Mera News searched by words: its best matches from the last 48 hours. */
function SearchResults({ q, phone }: { q: string; phone: boolean }) {
  const get = useApi();
  const router = useRouter();
  const [stories, setStories] = useState<Story[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(() => {
    setStories(null);
    setError(null);
    get<{ stories: Story[] }>(`/api/search/?q=${encodeURIComponent(q)}`).then(
      (r) => setStories(r.stories),
      (e) => setError(asError(e)),
    );
  }, [get, q]);
  useEffect(load, [load]);

  return (
    <section aria-labelledby="search-title" className="flex flex-col pb-4">
      {phone ? (
        <PhoneLead id="search-title" title={`Results for “${q}”`}>
          Up to 25 of the best matches from the last 48 hours. Searches are not saved.
        </PhoneLead>
      ) : (
        <Heading
          id="search-title"
          title={`Results for “${q}”`}
          lead="Mera News searches the news of the last 48 hours and shows up to 25 of the best matches, with reports of one story shown together. Searches are not saved."
          numbers={stories?.length ? [['Stories', stories.length.toLocaleString('en')]] : []}
        />
      )}
      {error ? (
        <Problem error={error} retry={load} />
      ) : stories === null ? (
        <Grid busy>
          <Skeletons n={phone ? 4 : 8} phone={phone} />
        </Grid>
      ) : stories.length === 0 ? (
        <div className="flex flex-col items-start gap-3 px-7 py-10 max-md:px-5">
          <p className="text-muted-foreground">No news matches this in the last 48 hours. Try other words.</p>
          <Button variant="outline" size="sm" onClick={() => router.push('/world/')}>
            Back to top stories
          </Button>
        </div>
      ) : (
        <>
          <Grid>
            {stories.map((s) => (
              <Card key={s.id} story={s} phone={phone} />
            ))}
          </Grid>
          <p className="px-7 pt-8 text-muted-foreground max-md:px-5 max-md:text-[14px]">{`That is every match, ${plural(stories.length, 'story', 'stories')}.`}</p>
        </>
      )}
    </section>
  );
}

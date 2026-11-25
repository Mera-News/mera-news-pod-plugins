'use client';

import { ArrowLeft, Check, ExternalLink, Plus, Sparkles, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Headline } from '@/components/headline';
import { Reason } from '@/components/lane';
import { LevelChip, NoteBox, ReadOn, SourceRow, StoryImage } from '@/components/phone/ui';
import { ApiError, useApi, usePost } from '@/components/session';
import { PublisherLine } from '@/components/top-bar';
import { buttonVariants } from '@/components/ui/button';
import { closeDetail, detailGone, followText, knownStory, recheckDetail, useDetailId, type DetailStory } from '@/lib/detail';
import { storyHref, type FollowedStory } from '@/lib/followed';
import { age, languageName, plural, type Report } from '@/lib/news';
import { firstReports, moreReports } from '@/lib/reports';
import { usePhone } from '@/lib/use-phone';
import { cn } from '@/lib/utils';

const asError = (e: unknown, message: string) => (e instanceof ApiError ? e : new ApiError(message, 'Try again in a minute.'));

/**
 * Mera's article detail, over whatever page opened it: the article as the hero, and every other report
 * of its story beside it (under it on a phone). The address carries the article, so Back closes it.
 */
export function ArticleDetail() {
  const id = useDetailId();
  const pathname = usePathname();
  // Following, for one, is a link to another page: the address then names no article.
  useEffect(recheckDetail, [pathname]);
  const get = useApi();
  const [story, setStory] = useState<DetailStory | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(
    (id: string) => {
      setError(null);
      const held = knownStory(id);
      if (held) return setStory(held);
      setStory(null);
      get<{ story: DetailStory }>(`/api/article/?id=${encodeURIComponent(id)}`).then(
        (r) => setStory(r.story),
        (e) => setError(asError(e, 'This article could not load.')),
      );
    },
    [get],
  );

  useEffect(() => {
    if (id) load(id);
    else detailGone();
  }, [id, load]);

  // A modal <dialog>: the page under it is inert, Tab stays inside, Escape and a click on the backdrop close it.
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (id && !d.open) {
      d.showModal();
      // The dialog itself takes focus, so a screen reader names it and no button wears a focus ring for a click.
      d.focus();
    }
    else if (!id && d.open) d.close();
    // The page under it stays where it is.
    document.documentElement.style.overflow = id ? 'hidden' : '';
  }, [id]);

  const shown = story && story.id === id ? story : null;
  return (
    <dialog
      ref={ref}
      tabIndex={-1}
      // Named by the headline's text alone: the headline's link carries a hidden "(opens ...)" for readers.
      aria-labelledby={!shown && error ? 'detail-error' : undefined}
      aria-label={shown ? shown.titleEn || shown.title : error ? undefined : 'Article'}
      onCancel={(e) => {
        e.preventDefault();
        closeDetail();
      }}
      // The browser may close it without a cancel (a second Escape); the address follows.
      onClose={() => new URLSearchParams(location.search).has('article') && closeDetail()}
      onClick={(e) => e.target === e.currentTarget && closeDetail()}
      className={cn(
        'm-auto max-h-none max-w-none flex-col overflow-hidden bg-card p-0 text-foreground outline-none open:flex backdrop:bg-black/55',
        'transition-[opacity,translate,scale] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] starting:open:opacity-0 motion-reduce:transition-none',
        // A computer: a large panel, the hero on the left, more coverage scrolling on its own on the right.
        'md:max-h-[min(860px,calc(100dvh-64px))] md:min-h-[min(520px,calc(100dvh-64px))] md:w-[min(1180px,calc(100vw-64px))] md:rounded-[12px] md:border md:starting:open:scale-[0.98]',
        // A phone: a full-screen sheet with everything in one column, as the app's article page.
        'max-md:m-0 max-md:h-dvh max-md:w-full max-md:overflow-y-auto max-md:overscroll-contain max-md:bg-background max-md:starting:open:translate-y-6',
      )}
    >
      {id && (
        <>
          <button
            type="button"
            aria-label="Close"
            onClick={closeDetail}
            className="absolute top-3 right-3 z-10 flex size-8 items-center justify-center rounded-full border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-md:fixed max-md:top-[calc(env(safe-area-inset-top)+10px)] max-md:right-auto max-md:left-3 max-md:size-11 max-md:border-transparent max-md:bg-black/60 max-md:text-white"
          >
            <X aria-hidden className="size-4 max-md:hidden" />
            <ArrowLeft aria-hidden className="size-[22px] md:hidden" />
          </button>
          {shown ? (
            <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] max-md:block">
              <Hero story={shown} />
              <Coverage key={shown.id} story={shown} />
            </div>
          ) : error ? (
            <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-16 text-center">
              <h2 id="detail-error" className="text-[17px] font-semibold tracking-[-0.01em] max-md:text-[22px] max-md:font-bold">
                {error.message}
              </h2>
              <p className="max-w-[48ch] text-pretty text-muted-foreground">{error.next}</p>
              <button type="button" onClick={() => id && load(id)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                Try again
              </button>
            </div>
          ) : (
            <HeroSkeleton />
          )}
        </>
      )}
    </dialog>
  );
}

/** The article itself: the publisher's image, where and when, the headline, Mera's reason, and the ways out. */
function Hero({ story }: { story: DetailStory }) {
  const phone = usePhone();
  const v = story.verdict;
  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-8 pt-7 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] max-md:gap-4 max-md:overflow-visible max-md:p-0 max-md:pb-2">
      <StoryImage src={story.image} className="aspect-[16/9] max-h-[min(400px,34dvh)] w-full rounded-[8px] max-md:aspect-[12/8] max-md:max-h-none max-md:rounded-none" />
      <div className={cn('flex flex-col gap-4 max-md:px-5', !story.image && 'md:pr-10 max-md:pt-[calc(env(safe-area-inset-top)+68px)]')}>
        {phone ? <SourceRow report={story} /> : <Where report={story} className="text-[13px]" />}
        <div className="flex flex-col gap-1.5">
          <Headline report={story} size="detail" id="detail-title" />
        </div>
        {v?.verdict === 'picked' &&
          (phone ? (
            <NoteBox
              top={
                <>
                  {v.level ? <LevelChip level={v.level} /> : <span />}
                  <span className="inline-flex items-center gap-1 text-[13px] font-normal text-muted-foreground">
                    <Sparkles aria-hidden className="size-3.5" />
                    AI-generated
                  </span>
                </>
              }
            >
              {v.reason}
            </NoteBox>
          ) : (
            <div className="max-w-[64ch] [&_p]:text-[14px]">
              <Reason verdict={v} />
            </div>
          ))}
        {v?.verdict === 'left_out' && (
          <div className="flex max-w-[64ch] flex-col gap-1 rounded-[8px] bg-note/60 px-3 py-2.5 max-md:rounded-[14px]">
            <p className="text-[12px] font-medium text-muted-foreground max-md:text-[13px]">Left out by Mera</p>
            <p className="leading-snug text-pretty text-foreground/85 max-md:text-[15px]">{v.reason}</p>
          </div>
        )}
        {story.facts && story.facts.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[12px] text-muted-foreground max-md:text-[13px]">{story.facts.length === 1 ? 'Matched your fact' : 'Matched your facts'}</p>
            <ul className="flex flex-col gap-1">
              {story.facts.map((f) => (
                <li key={f} className="flex items-start gap-2 text-[13px] leading-snug text-pretty max-md:text-[15px]">
                  <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-accent-foreground max-md:size-4" />
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2.5 pt-1 max-md:flex-col max-md:items-stretch">
          {phone ? (
            <div className="flex">
              <ReadOn report={story} />
            </div>
          ) : (
            <a href={story.link} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), 'min-w-0 max-w-full')}>
              <ExternalLink aria-hidden />
              <span className="truncate">Read on {story.publisher || 'the publisher'}</span>
            </a>
          )}
          <Follow story={story} />
        </div>
      </div>
      <PublisherLine className="mt-auto px-0 pt-4 pb-0 max-md:px-5 max-md:pt-2" />
    </div>
  );
}

type FollowState = { kind: 'checking' } | { kind: 'open' } | { kind: 'busy' } | { kind: 'following'; id: string } | { kind: 'error'; error: ApiError };

/** Follow this story, as from the app's article page; Following once the person does, opening the story. */
function Follow({ story }: { story: DetailStory }) {
  const get = useApi();
  const post = usePost();
  const text = followText(story);
  const [state, setState] = useState<FollowState>({ kind: 'checking' });

  useEffect(() => {
    let live = true;
    get<{ stories: FollowedStory[] }>('/api/followed/').then(
      ({ stories }) => {
        const held = stories.find((s) => s.title === text || s.latest?.id === story.id);
        if (live) setState(held ? { kind: 'following', id: held.id } : { kind: 'open' });
      },
      // The list is only a hint: following again answers that it is already followed.
      () => live && setState({ kind: 'open' }),
    );
    return () => {
      live = false;
    };
  }, [get, story.id, text]);

  const follow = async () => {
    setState({ kind: 'busy' });
    try {
      const r = await post<{ id: string }>('/api/followed/follow/', { text, fromArticleId: story.id });
      setState({ kind: 'following', id: r.id });
    } catch (e) {
      setState({ kind: 'error', error: asError(e, 'This story could not be followed.') });
    }
  };

  const outline = cn(buttonVariants({ variant: 'outline' }), 'max-md:h-11 max-md:text-[15px]');
  if (state.kind === 'following') {
    return (
      <Link href={storyHref(state.id)} className={cn(outline, 'border-primary/70 text-accent-foreground')}>
        <Check aria-hidden />
        Following
      </Link>
    );
  }
  return (
    <>
      <button type="button" onClick={() => void follow()} disabled={state.kind !== 'open' && state.kind !== 'error'} aria-busy={state.kind === 'busy'} className={outline}>
        <Plus aria-hidden />
        {state.kind === 'busy' ? 'Following this story' : 'Follow this story'}
      </button>
      {state.kind === 'error' && (
        <p role="alert" className="basis-full text-[13px] text-pretty">
          <span className="font-medium">{state.error.message}</span> <span className="text-muted-foreground">{state.error.next}</span>
        </p>
      )}
    </>
  );
}

type Coverage = { reports: Report[]; next: string | null; state: 'loading' | 'more' | 'end' | 'error'; error?: ApiError };

/** Every other report of the story, from every publisher, a page at a time as the reader scrolls. */
function Coverage({ story }: { story: DetailStory }) {
  const get = useApi();
  const headingId = useId();
  const [c, setC] = useState<Coverage>({ reports: [], next: null, state: 'loading' });
  const end = useRef<HTMLDivElement>(null);

  const add = useCallback((page: { reports: Report[]; nextCursor: string | null }) => {
    setC((x) => {
      const ids = new Set([story.id, ...x.reports.map((r) => r.id)]);
      return { reports: [...x.reports, ...page.reports.filter((r) => !ids.has(r.id))], next: page.nextCursor, state: page.nextCursor ? 'more' : 'end' };
    });
  }, [story.id]);

  const load = useCallback(
    async (after: string | null) => {
      setC((x) => ({ ...x, state: 'loading', error: undefined }));
      try {
        // The person is waiting on these, so they go ahead of any card's.
        add(after ? await moreReports(get, story.id, after, true) : await firstReports(get, story.id, true));
      } catch (e) {
        setC((x) => ({ ...x, state: 'error', error: asError(e, 'More coverage could not load.') }));
      }
    },
    [add, get, story.id],
  );

  // Always asked: a Feed story counts only the reports that matched the person's topics, not its whole story.
  useEffect(() => {
    void load(null);
  }, [load]);

  // The next page loads before the reader reaches the end of this one, in the column or the phone's sheet.
  useEffect(() => {
    const el = end.current;
    if (!el || c.state !== 'more') return;
    const seen = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void load(c.next), { rootMargin: '400px 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, [c.state, c.next, load]);

  const publishers = new Set(c.reports.map((r) => r.publisher)).size;
  const none = c.state === 'end' && c.reports.length === 0;
  return (
    <section aria-labelledby={headingId} aria-busy={c.state === 'loading'} className="flex min-h-0 flex-col border-l bg-background/40 max-md:border-t max-md:border-l-0 max-md:bg-transparent max-md:pt-2">
      <div className="flex flex-none flex-col gap-0.5 border-b px-6 pt-7 pr-14 pb-4 max-md:border-b-0 max-md:px-5 max-md:pt-4 max-md:pb-2">
        <h3 id={headingId} className="text-[17px] font-semibold tracking-[-0.01em] max-md:text-[20px] max-md:font-bold">
          More coverage
        </h3>
        <p className="text-[12px] text-muted-foreground tabular-nums max-md:text-[14px]">
          {none
            ? 'One report so far'
            : c.state === 'end'
              ? `${plural(c.reports.length, 'other report')} from ${plural(publishers, 'publisher')}`
              : c.reports.length
                ? `${plural(c.reports.length, 'other report')} so far`
                : 'Looking for other reports'}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6 [scrollbar-color:var(--border)_transparent] [scrollbar-width:thin] max-md:overflow-visible max-md:px-4 max-md:pb-[calc(env(safe-area-inset-bottom)+24px)]">
        {none && <p className="pt-4 text-pretty text-muted-foreground max-md:px-1 max-md:text-[15px]">No other publisher has reported this story yet. When others do, Mera News groups them here.</p>}
        {c.reports.length > 0 && (
          <ul className="flex flex-col max-md:gap-2">
            {c.reports.map((r) => (
              <CoverageRow key={r.id} report={r} />
            ))}
          </ul>
        )}
        {c.state === 'loading' && <CoverageSkeleton rows={c.reports.length ? 2 : 5} />}
        {c.state === 'error' && c.error && (
          <div role="alert" className="flex flex-col items-start gap-2 pt-4 text-[13px]">
            <p>
              <span className="font-medium">{c.error.message}</span> <span className="text-muted-foreground">{c.error.next}</span>
            </p>
            <button type="button" onClick={() => void load(c.reports.length ? c.next : null)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              Try again
            </button>
          </div>
        )}
        <div ref={end} aria-hidden className="h-px" />
        {c.state === 'end' && !none && <p className="pt-4 text-[12px] text-muted-foreground max-md:px-1 max-md:text-[14px]">That is every report Mera News holds for this story.</p>}
      </div>
    </section>
  );
}

/** Publisher, how long ago and the language by name: the detail says it in full where a card abbreviates. */
function Where({ report, className }: { report: Report; className: string }) {
  const parts = [age(report.publishedAt), languageName(report.language)].filter(Boolean);
  return (
    <p className={cn('truncate text-muted-foreground tabular-nums', className)}>
      <span className="font-medium text-foreground/80">{report.publisher || 'Unknown publisher'}</span>
      {parts.map((p) => ` · ${p}`)}
    </p>
  );
}

/** One other report: publisher, time and language, then its headline, which opens the publisher's page. */
function CoverageRow({ report }: { report: Report }) {
  return (
    <li className="flex flex-col gap-1 border-b py-3.5 last:border-b-0 max-md:rounded-[18px] max-md:border max-md:bg-card max-md:p-3.5 max-md:last:border-b">
      <Where report={report} className="text-[12px] max-md:text-[13px]" />
      <Headline report={report} size="row" />
    </li>
  );
}

function CoverageSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-hidden className="flex flex-col">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 border-b py-3.5 last:border-b-0">
          <div className="h-3 w-2/5 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-3.5 w-3/5 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

function HeroSkeleton() {
  return (
    <div aria-hidden className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] max-md:block">
      <div className="flex flex-col gap-5 p-8 pt-7 max-md:p-0">
        <div className="aspect-[16/9] max-h-[400px] w-full animate-pulse rounded-[8px] bg-muted max-md:rounded-none" />
        <div className="flex flex-col gap-3 max-md:px-5">
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-6 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
          <div className="mt-2 h-16 animate-pulse rounded-[8px] bg-muted" />
        </div>
      </div>
      <div className="flex flex-col gap-3 border-l px-6 pt-7 max-md:hidden">
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <CoverageSkeleton rows={5} />
      </div>
    </div>
  );
}

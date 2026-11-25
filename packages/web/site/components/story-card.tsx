'use client';

import { ChevronDown, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, useApi } from '@/components/session';
import { age, languageLabel, plural, type Report, type Story } from '@/lib/news';

/** Publisher, age and language, the line over every headline. */
export function Meta({ report, className }: { report: Report; className?: string }) {
  const parts = [age(report.publishedAt), languageLabel(report.language)].filter(Boolean);
  return (
    <p className={className ?? 'truncate text-[12px] text-muted-foreground max-md:text-[13px]'}>
      <span className="font-medium text-foreground/80">{report.publisher || 'Unknown publisher'}</span>
      {parts.map((p) => ` · ${p}`)}
    </p>
  );
}

/** The headline in English where there is a translation, with the original under it. */
export function Headline({ report, size }: { report: Report; size: 'card' | 'row' }) {
  const lang = report.language === 'und' ? undefined : report.language;
  const Wrap = size === 'card' ? 'h3' : 'p';
  return (
    <>
      <Wrap className="min-w-0">
      <a
        href={report.link}
        target="_blank"
        rel="noopener noreferrer"
        lang={report.titleEn ? 'en' : lang}
        className={
          size === 'card'
            ? 'group text-[14px] leading-snug font-semibold tracking-[-0.01em] text-pretty underline-offset-[3px] hover:underline decoration-primary/70'
            : 'group text-[13px] leading-snug text-pretty underline-offset-[3px] hover:underline decoration-primary/70 max-md:text-[15px]'
        }
      >
        {report.titleEn ?? report.title}
        <ExternalLink aria-hidden className="ml-1 inline size-3 -translate-y-px text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        <span className="sr-only"> (opens {report.publisher || 'the publisher'}&apos;s site)</span>
      </a>
      </Wrap>
      {report.titleEn && (
        <p lang={lang} className="line-clamp-2 text-[12.5px] leading-snug text-muted-foreground">
          {report.title}
        </p>
      )}
    </>
  );
}

type Reports = { list: Report[]; next: string | null; state: 'idle' | 'loading' | 'done'; error?: ApiError };

/** Every report of the story, from every publisher, loaded a page at a time when asked. */
export function AllReports({ story }: { story: Story }) {
  const get = useApi();
  const [open, setOpen] = useState(false);
  const [r, setR] = useState<Reports>({ list: [], next: null, state: 'idle' });

  async function load(after: string | null) {
    setR((x) => ({ ...x, state: 'loading', error: undefined }));
    try {
      const page = await get<{ reports: Report[]; nextCursor: string | null }>(`/api/story/?id=${encodeURIComponent(story.id)}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
      setR((x) => {
        const ids = new Set(x.list.map((y) => y.id));
        return { list: [...x.list, ...page.reports.filter((y) => !ids.has(y.id))], next: page.nextCursor, state: 'done' };
      });
    } catch (e) {
      setR((x) => ({ ...x, state: 'done', error: e instanceof ApiError ? e : new ApiError('The reports could not load.', 'Try again.') }));
    }
  }

  if (story.reports <= 1) return <p className="text-[12px] text-muted-foreground max-md:hidden">1 report</p>;
  // A story the server no longer groups still shows its own report.
  const list = r.state === 'done' && !r.error && r.list.length === 0 ? [story] : r.list;
  const publishers = new Set(list.map((x) => x.publisher)).size;
  const complete = r.state === 'done' && !r.error && !r.next;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && r.state === 'idle') void load(null);
        }}
        className="inline-flex h-7 items-center gap-1 self-start rounded-full border px-2.5 text-[12px] text-muted-foreground tabular-nums max-md:h-11 max-md:px-4 max-md:text-[14px] transition-colors hover:border-primary/60 hover:text-foreground aria-expanded:border-primary aria-expanded:text-accent-foreground"
      >
        {plural(story.reports, 'report')}
        <ChevronDown aria-hidden className="size-3.5 transition-transform in-aria-expanded:rotate-180" />
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t pt-2">
          {complete && <p className="text-[12px] text-muted-foreground tabular-nums">{`${plural(list.length, 'report')} from ${plural(publishers, 'publisher')}`}</p>}
          {list.length > 0 && (
            <ul className="flex flex-col gap-2.5">
              {list.map((x) => (
                <li key={x.id} className="flex flex-col gap-0.5">
                  <Meta report={x} />
                  <Headline report={x} size="row" />
                </li>
              ))}
            </ul>
          )}
          {r.state === 'loading' && (
            <p role="status" className="text-[12px] text-muted-foreground">
              Loading reports
            </p>
          )}
          {r.error && (
            <div role="alert" className="flex flex-col items-start gap-1.5 text-[12px] text-muted-foreground">
              <p>
                {r.error.message} {r.error.next}
              </p>
              <Button size="sm" variant="outline" onClick={() => void load(r.next)}>
                Try again
              </Button>
            </div>
          )}
          {r.state === 'done' && !r.error && r.next && (
            <Button size="sm" variant="outline" className="self-start" onClick={() => void load(r.next)}>
              Show more reports
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** A story as a card: the publisher's image when it loads, where it came from, its headline, its reports. */
export function StoryCard({ story }: { story: Story }) {
  const [image, setImage] = useState(Boolean(story.image));
  return (
    <article className="flex min-w-0 flex-col gap-2 rounded-[12px] border bg-card p-3">
      {story.image && image && (
        // eslint-disable-next-line @next/next/no-img-element -- a static export has no image server
        <img
          src={story.image}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImage(false)}
          className="h-[90px] w-full rounded-[8px] bg-muted object-cover"
        />
      )}
      <Meta report={story} />
      <Headline report={story} size="card" />
      <AllReports story={story} />
    </article>
  );
}

/** A card's shape while the page loads. */
export function StoryCardSkeleton({ image }: { image?: boolean }) {
  return (
    <div aria-hidden className="flex flex-col gap-2.5 rounded-[12px] border bg-card p-3">
      {image && <div className="h-[90px] animate-pulse rounded-[8px] bg-muted" />}
      <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
      <div className="h-7 w-24 animate-pulse rounded-full bg-muted" />
    </div>
  );
}

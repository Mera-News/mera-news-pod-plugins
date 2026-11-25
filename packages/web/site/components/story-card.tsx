'use client';

import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Headline } from '@/components/headline';
import { StoryImage } from '@/components/phone/ui';
import { useApi } from '@/components/session';
import { detailLink } from '@/lib/detail';
import { age, languageLabel, plural, type Report, type Story } from '@/lib/news';
import { firstReports, otherPublishers } from '@/lib/reports';
import { usePhone } from '@/lib/use-phone';
import { cn } from '@/lib/utils';

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

/** Other publishers' reports of the story, from the same first page the detail reads; null while it loads. */
function useOthers(story: Story, n: number): Report[] | null {
  const get = useApi();
  const many = story.reports > 1;
  const [others, setOthers] = useState<Report[] | null>(many ? null : []);
  useEffect(() => {
    if (!many) return;
    let live = true;
    firstReports(get, story.id).then(
      (page) => live && setOthers(otherPublishers(story, page.reports, n)),
      // The card stands on its lead; Full coverage says what went wrong.
      () => live && setOthers([]),
    );
    return () => {
      live = false;
    };
  }, [get, story, many, n]);
  return others;
}

/** Other reports as compact rows: publisher and age, then the headline, which opens the publisher's page. */
function Others({ others, n }: { others: Report[] | null; n: number }) {
  if (others === null) {
    return (
      <ul aria-hidden className="flex flex-col">
        {Array.from({ length: n }, (_, i) => (
          <li key={i} className="flex flex-col gap-1.5 border-t py-2.5">
            <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
          </li>
        ))}
      </ul>
    );
  }
  if (others.length === 0) return null;
  return (
    <ul className="flex flex-col">
      {others.map((r) => (
        <li key={r.id} className="flex min-w-0 flex-col gap-0.5 border-t py-2.5">
          <Meta report={r} />
          <Headline report={r} size="row" />
        </li>
      ))}
    </ul>
  );
}

/** Opens the article detail with every report of the story. */
function FullCoverage({ story }: { story: Story }) {
  return (
    <a
      {...detailLink(story)}
      className="inline-flex h-8 items-center gap-1 self-start rounded-full border pr-2 pl-3 text-[13px] font-medium text-foreground/85 tabular-nums transition-colors hover:border-primary/60 hover:text-accent-foreground max-md:h-11 max-md:pr-3 max-md:pl-4 max-md:text-[15px]"
    >
      Full coverage
      <span className="font-normal text-muted-foreground">· {plural(story.reports, 'report')}</span>
      <ChevronRight aria-hidden className="size-4" />
    </a>
  );
}

/**
 * A story as a full-coverage card: its lead report with the publisher's image, two or three reports
 * from other publishers under it, and Full coverage. The first story of a page leads it, larger.
 */
export function ClusterCard({ story, lead }: { story: Story; lead?: boolean }) {
  const phone = usePhone();
  const n = 3;
  const others = useOthers(story, n);
  const opens = detailLink(story);
  const many = story.reports > 1;
  if (lead) {
    return (
      <article
        className={cn(
          'flex min-w-0 flex-col gap-5 rounded-[12px] border bg-card p-5 min-[1100px]:col-span-2 max-md:gap-0 max-md:overflow-hidden max-md:rounded-[20px] max-md:p-0',
          story.image && 'min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] min-[1100px]:gap-7',
        )}
      >
        <StoryImage src={story.image} className="aspect-[16/9] w-full rounded-[8px] min-[1100px]:h-full min-[1100px]:max-h-[420px] max-md:aspect-[12/6] max-md:rounded-none" />
        <div className="flex min-w-0 flex-col gap-2 max-md:p-4">
          <Meta report={story} />
          <Headline report={story} size={phone ? 'phone-card' : 'lead'} opens={opens} />
          {many && (
            <div className="pt-2">
              <Others others={others} n={n} />
            </div>
          )}
          {many && (
            <div className="pt-1">
              <FullCoverage story={story} />
            </div>
          )}
        </div>
      </article>
    );
  }
  return (
    <article className="flex min-w-0 flex-col gap-2.5 rounded-[12px] border bg-card p-4 max-md:rounded-[20px] max-md:p-3.5">
      <div className="flex items-start gap-4 max-md:gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Meta report={story} />
          <Headline report={story} size={phone ? 'phone-row' : 'card'} opens={opens} />
        </div>
        <StoryImage src={story.image} className="h-[84px] w-[120px] shrink-0 rounded-[8px] max-md:size-[92px] max-md:rounded-[14px]" />
      </div>
      {many && <Others others={others} n={n} />}
      {many && <FullCoverage story={story} />}
    </article>
  );
}

/** A full-coverage card's shape while the page loads. */
export function ClusterSkeleton({ lead }: { lead?: boolean }) {
  const rows = Array.from({ length: lead ? 3 : 2 }, (_, i) => (
    <div key={i} className="flex flex-col gap-1.5 border-t py-2.5">
      <div className="h-2.5 w-1/3 animate-pulse rounded bg-muted" />
      <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
    </div>
  ));
  if (lead) {
    return (
      <div aria-hidden className="flex flex-col gap-5 rounded-[12px] border bg-card p-5 min-[1100px]:col-span-2 min-[1100px]:grid min-[1100px]:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] min-[1100px]:gap-7 max-md:rounded-[20px] max-md:p-0">
        <div className="aspect-[16/9] w-full animate-pulse rounded-[8px] bg-muted max-md:aspect-[12/6] max-md:rounded-none" />
        <div className="flex flex-col gap-2.5 max-md:p-4">
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-5 w-11/12 animate-pulse rounded bg-muted" />
          <div className="mb-2 h-5 w-2/3 animate-pulse rounded bg-muted" />
          {rows}
        </div>
      </div>
    );
  }
  return (
    <div aria-hidden className={cn('flex flex-col gap-2.5 rounded-[12px] border bg-card p-4 max-md:rounded-[20px] max-md:p-3.5')}>
      <div className="flex items-start gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-11/12 animate-pulse rounded bg-muted" />
          <div className="h-4 w-3/5 animate-pulse rounded bg-muted" />
        </div>
        <div className="h-[84px] w-[120px] animate-pulse rounded-[8px] bg-muted max-md:size-[92px] max-md:rounded-[14px]" />
      </div>
      {rows}
    </div>
  );
}

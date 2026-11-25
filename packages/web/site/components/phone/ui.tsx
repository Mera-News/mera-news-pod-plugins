'use client';

import { Check, Clock, ExternalLink, Newspaper, Share } from 'lucide-react';
import { useState, type ComponentType, type HTMLAttributes, type ReactNode } from 'react';
import { LEVEL_LABEL, type Level } from '@/lib/feed';
import { age, type Report, type Story } from '@/lib/news';
import { cn } from '@/lib/utils';

/** A frosted, rounded panel on the gradient, the app's card. */
export function Panel({ className, children, as: As = 'div', ...rest }: { className?: string; children?: ReactNode; as?: 'div' | 'section' | 'article' } & HTMLAttributes<HTMLElement>) {
  return (
    <As className={cn('rounded-[20px] border bg-card', className)} {...rest}>
      {children}
    </As>
  );
}

export interface Pill<T extends string> {
  value: T;
  label: string;
  icon?: ComponentType<{ className?: string; 'aria-hidden'?: boolean; strokeWidth?: number }>;
}

/** The app's switcher: a frosted capsule of pills, the chosen one filled orange. */
export function Pills<T extends string>({ label, pills, value, onChange }: { label: string; pills: Pill<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-full border bg-card p-1">
      {pills.map(({ value: v, label: text, icon: Icon }) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className="inline-flex h-11 items-center gap-2 rounded-full px-4 text-[16px] font-semibold text-foreground/80 transition-colors aria-pressed:bg-primary aria-pressed:text-primary-foreground"
        >
          {Icon && <Icon aria-hidden className="size-[18px]" strokeWidth={2} />}
          {text}
        </button>
      ))}
    </div>
  );
}

/** The bar at the top of a phone page, under the status bar, with the switcher in the middle. */
export function PhoneHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <header
      className={cn(
        'sticky top-0 z-20 flex items-center justify-center gap-3 border-b bg-background/85 px-4 pt-[calc(env(safe-area-inset-top)+10px)] pb-2.5 backdrop-blur-xl',
        className,
      )}
    >
      {children}
    </header>
  );
}

const LEVEL_CHIP: Record<Level, string> = {
  emergency: 'bg-[#c62828] text-white',
  high: 'bg-[#ffebee] text-[#c62828]',
  medium: 'bg-[#fff3e0] text-[#9a4a00]',
  low: 'bg-[#eceff1] text-[#37474f]',
};

export function LevelChip({ level }: { level: Level }) {
  return <span className={cn('inline-flex h-6 items-center rounded-full px-2.5 text-[13px] font-semibold', LEVEL_CHIP[level])}>{LEVEL_LABEL[level]}</span>;
}

const names = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' });
  } catch {
    return null;
  }
})();

/** A language code as its English name: nl is Dutch. Unknown codes show nothing. */
export function languageName(code: string): string {
  if (!code || code === 'und') return '';
  const base = code.split('-')[0];
  try {
    const n = names?.of(base);
    return n && n !== base ? n : base.toUpperCase();
  } catch {
    return base.toUpperCase();
  }
}

/** 5m ago, 3h ago, Yesterday, 12 Nov. */
export const ago = (iso: string) => {
  const a = age(iso);
  return /\d[mh]$/.test(a) ? `${a} ago` : a;
};

/** The publisher's image, gone without a trace when it fails to load. */
export function StoryImage({ src, className }: { src?: string; className: string }) {
  const [shown, setShown] = useState(Boolean(src));
  if (!src || !shown) return null;
  // eslint-disable-next-line @next/next/no-img-element -- a static export has no image server
  return <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setShown(false)} className={cn('bg-muted object-cover', className)} />;
}

/** The headline as a link to the publisher, in English where there is a translation, the original under it. */
export function PhoneHeadline({ report, className, as: As = 'h3' }: { report: Report; className: string; as?: 'h2' | 'h3' | 'p' }) {
  const lang = report.language === 'und' ? undefined : report.language;
  return (
    <>
      <As className="min-w-0">
        <a href={report.link} target="_blank" rel="noopener noreferrer" lang={report.titleEn ? 'en' : lang} className={cn('text-pretty', className)}>
          {report.titleEn ?? report.title}
          <span className="sr-only"> (opens {report.publisher || 'the publisher'}&apos;s site)</span>
        </a>
      </As>
      {report.titleEn && (
        <p lang={lang} className="line-clamp-2 text-[14px] leading-snug text-muted-foreground">
          {report.title}
        </p>
      )}
    </>
  );
}

/** Shares the publisher's link with the phone's share sheet, or copies it where there is none. */
export function ShareButton({ report }: { report: Report }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    const title = report.titleEn ?? report.title;
    if (typeof navigator.share === 'function') {
      // A closed share sheet rejects; nothing to say about that.
      return navigator.share({ title, url: report.link }).catch(() => {});
    }
    try {
      await navigator.clipboard.writeText(report.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copying can be blocked; the link is still one tap away.
    }
  };
  return (
    <button
      type="button"
      onClick={() => void share()}
      aria-label={copied ? 'Link copied' : 'Share'}
      className="flex size-11 shrink-0 items-center justify-center rounded-full text-foreground/85 transition-colors active:bg-muted"
    >
      {copied ? <Check aria-hidden className="size-[22px]" /> : <Share aria-hidden className="size-[22px]" strokeWidth={1.75} />}
    </button>
  );
}

/** The green outlined button that sends the reader to the publisher, as in the app. */
export function ReadOn({ report }: { report: Report }) {
  return (
    <a
      href={report.link}
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-11 min-w-0 flex-1 items-center justify-center gap-2 rounded-full border border-read px-4 text-[15px] font-semibold text-read transition-colors active:bg-read/10"
    >
      <ExternalLink aria-hidden className="size-[18px] shrink-0" />
      <span className="truncate">Read on {report.publisher || 'the publisher'}</span>
    </a>
  );
}

/** The app's note box under a headline: a chip and a label on top, the words under them. */
export function NoteBox({ top, children }: { top: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-[14px] bg-note p-3">
      <div className="flex min-h-6 items-center justify-between gap-2">{top}</div>
      <div className="text-[15px] leading-snug font-medium text-pretty">{children}</div>
    </div>
  );
}

/** Publisher on the left, age and language on the right: the line over every headline. */
export function SourceRow({ report }: { report: Report }) {
  const right = [ago(report.publishedAt), languageName(report.language)].filter(Boolean).join(' · ');
  return (
    <div className="flex items-center justify-between gap-3 text-[13px] text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Newspaper aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{report.publisher || 'Unknown publisher'}</span>
      </span>
      <span className="shrink-0 tabular-nums">{right}</span>
    </div>
  );
}

/** A story as the app's list card: age and language on top, the headline, the publisher, the image at the side. */
export function StoryRow({ story, children, footer }: { story: Story; children?: ReactNode; footer?: ReactNode }) {
  return (
    <Panel as="article" className="flex flex-col gap-2 rounded-[18px] p-3.5">
      <div className="flex items-center justify-between gap-3 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <Clock aria-hidden className="size-3.5" />
          {ago(story.publishedAt)}
        </span>
        <span>{languageName(story.language)}</span>
      </div>
      <div className="flex gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <PhoneHeadline report={story} className="text-[17px] leading-snug font-semibold tracking-[-0.01em]" />
          <p className="truncate text-[13px] text-muted-foreground">{story.publisher || 'Unknown publisher'}</p>
        </div>
        <StoryImage src={story.image} className="size-[92px] shrink-0 rounded-[14px]" />
      </div>
      {children}
      {footer}
    </Panel>
  );
}

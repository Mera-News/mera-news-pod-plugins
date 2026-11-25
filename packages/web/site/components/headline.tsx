import { ExternalLink, Languages } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';
import { languageName, type Report } from '@/lib/news';
import { cn } from '@/lib/utils';

const HOVER = 'group underline-offset-[3px] decoration-primary/70 hover:underline';

// Desktop sizes underline on hover; the phone's are the app's, with the original at 14px.
const SIZE = {
  card: { as: 'h3', link: cn(HOVER, 'text-[14px] leading-snug font-semibold tracking-[-0.01em]'), original: 'text-[12.5px]' },
  row: { as: 'p', link: cn(HOVER, 'text-[13px] leading-snug max-md:text-[15px]'), original: 'text-[12.5px]' },
  'phone-card': { as: 'h2', link: 'text-[20px] leading-[1.3] font-bold tracking-[-0.015em]', original: 'text-[14px]' },
  'phone-row': { as: 'h3', link: 'text-[17px] leading-snug font-semibold tracking-[-0.01em]', original: 'text-[14px]' },
  // The article detail's hero: the page's own heading size, the phone card's a step up.
  detail: { as: 'h2', link: cn(HOVER, 'text-[24px] leading-[1.22] font-bold tracking-[-0.02em] max-md:text-[22px] max-md:leading-[1.27]'), original: 'text-[15px]' },
  // A World story's lead and its other reports.
  lead: { as: 'h3', link: cn(HOVER, 'text-[20px] leading-[1.25] font-bold tracking-[-0.02em] max-md:text-[20px]'), original: 'text-[13px] max-md:text-[14px]' },
} as const;

/** A headline that opens Mera's article detail in this site instead of the publisher's page. */
export interface Opens {
  href: string;
  onClick: (e: MouseEvent<HTMLAnchorElement>) => void;
}

/** The publisher's link, or plain text when there is none. */
function Link({ href, lang, className, children, opens }: { href: string | null; lang?: string; className: string; children: ReactNode; opens?: Opens }) {
  if (opens) {
    return (
      <a href={opens.href} onClick={opens.onClick} lang={lang} className={className}>
        {children}
      </a>
    );
  }
  if (!href) return <span lang={lang} className={cn(className, 'no-underline hover:no-underline')}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" lang={lang} className={className}>
      {children}
    </a>
  );
}

/**
 * Every headline on the site: in English as a link to the publisher (or, on a card, to Mera's
 * article detail), a translated mark when the English one is a translation, and the
 * original-language headline under it.
 */
export function Headline({
  report,
  size,
  opens,
  out = true,
  id,
}: {
  report: Pick<Report, 'title' | 'titleEn' | 'language' | 'publisher'> & { link: string | null };
  size: keyof typeof SIZE;
  /** Set on cards: the headline opens the detail, and a small mark beside it goes to the publisher. */
  opens?: Opens;
  /** False where the card has its own Read on button beside the headline. */
  out?: boolean;
  id?: string;
}) {
  const { as: As, link, original } = SIZE[size];
  const lang = report.language === 'und' ? undefined : report.language;
  const translated = Boolean(report.titleEn) && report.titleEn !== report.title;
  const name = languageName(report.language);
  const from = name ? `Translated from ${name}` : 'Translated';
  const text = translated ? report.titleEn! : report.title;
  // The last character (a whole grapheme) carries the marks, so neither wraps onto a line of its own: a word never
  // breaks between its letters, and a headline with no spaces (Japanese, Chinese, Thai) still wraps.
  const cut = [...new Intl.Segmenter().segment(text)].pop()?.index ?? 0;
  return (
    <>
      <As id={id} className="min-w-0">
        {/* A followed story can hold an article whose link the pod no longer has: then it is text only. */}
        <Link href={report.link} opens={opens} lang={translated ? 'en' : lang} className={cn('text-pretty', link)}>
          {text.slice(0, cut)}
          <span className="whitespace-nowrap">
            {text.slice(cut)}
            {translated && (
              <span role="img" aria-label={from} title={from} className="ml-1 inline-block align-[-0.08em] text-muted-foreground">
                <Languages aria-hidden className="size-[0.8em]" strokeWidth={2.25} />
              </span>
            )}
            {report.link && !opens && (
              <ExternalLink aria-hidden className="ml-1 inline size-3 -translate-y-px text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-md:hidden" />
            )}
          </span>
          {report.link && !opens && <span className="sr-only"> (opens {report.publisher || 'the publisher'}&apos;s site)</span>}
        </Link>
        {/* Straight to the publisher from a card, without the detail. On a phone the mark stays small and its tap area is 44px. */}
        {opens && out && report.link && (
          <a
            href={report.link}
            target="_blank"
            rel="noopener noreferrer"
            title={`Read on ${report.publisher || 'the publisher'}`}
            className="relative ml-1.5 inline-flex size-5 translate-y-[0.1em] items-center justify-center rounded-full align-baseline text-muted-foreground transition-colors hover:bg-muted hover:text-accent-foreground max-md:ml-2 max-md:size-6 max-md:after:absolute max-md:after:-inset-2.5 max-md:after:content-['']"
          >
            <ExternalLink aria-hidden className="size-3 max-md:size-4" />
            <span className="sr-only">Read on {report.publisher || 'the publisher'} (opens the publisher&apos;s site)</span>
          </a>
        )}
      </As>
      {translated && (
        <p lang={lang} className={cn('line-clamp-2 leading-snug text-muted-foreground', original)}>
          {report.title}
        </p>
      )}
    </>
  );
}

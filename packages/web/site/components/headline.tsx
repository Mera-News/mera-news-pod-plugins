import { ExternalLink, Languages } from 'lucide-react';
import { languageName, type Report } from '@/lib/news';
import { cn } from '@/lib/utils';

const HOVER = 'group underline-offset-[3px] decoration-primary/70 hover:underline';

// Desktop sizes underline on hover; the phone's are the app's, with the original at 14px.
const SIZE = {
  card: { as: 'h3', link: cn(HOVER, 'text-[14px] leading-snug font-semibold tracking-[-0.01em]'), original: 'text-[12.5px]' },
  row: { as: 'p', link: cn(HOVER, 'text-[13px] leading-snug max-md:text-[15px]'), original: 'text-[12.5px]' },
  'phone-card': { as: 'h2', link: 'text-[20px] leading-[1.3] font-bold tracking-[-0.015em]', original: 'text-[14px]' },
  'phone-row': { as: 'h3', link: 'text-[17px] leading-snug font-semibold tracking-[-0.01em]', original: 'text-[14px]' },
} as const;

/**
 * Every headline on the site: in English as a link to the publisher, a translated mark when the
 * English one is a translation, and the original-language headline under it.
 */
export function Headline({ report, size }: { report: Report; size: keyof typeof SIZE }) {
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
      <As className="min-w-0">
        <a href={report.link} target="_blank" rel="noopener noreferrer" lang={translated ? 'en' : lang} className={cn('text-pretty', link)}>
          {text.slice(0, cut)}
          <span className="whitespace-nowrap">
            {text.slice(cut)}
            {translated && (
              <span role="img" aria-label={from} title={from} className="ml-1 inline-block align-[-0.08em] text-muted-foreground">
                <Languages aria-hidden className="size-[0.8em]" strokeWidth={2.25} />
              </span>
            )}
            <ExternalLink aria-hidden className="ml-1 inline size-3 -translate-y-px text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 max-md:hidden" />
          </span>
          <span className="sr-only"> (opens {report.publisher || 'the publisher'}&apos;s site)</span>
        </a>
      </As>
      {translated && (
        <p lang={lang} className={cn('line-clamp-2 leading-snug text-muted-foreground', original)}>
          {report.title}
        </p>
      )}
    </>
  );
}

/** One report of a story, as the pod sends it: headline, link and where it came from, never its text. */
export interface Report {
  id: string;
  title: string;
  titleEn?: string;
  link: string;
  publisher: string;
  publishedAt: string;
  language: string;
}

export interface Story extends Report {
  image?: string;
  reports: number;
}

export interface Country {
  code: string;
  name: string;
  flag?: string;
}

/** How old a report is, the way a news list says it: 5m, 3h, Yesterday, 12 Nov. */
export function age(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const minutes = Math.max(1, Math.round((now - at) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  if (hours < 48) return 'Yesterday';
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

/** A language code as a short label, or nothing when the language is unknown. */
export const languageLabel = (code: string) => (code && code !== 'und' ? code.split('-')[0].toUpperCase() : '');

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

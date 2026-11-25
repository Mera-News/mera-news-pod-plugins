// Every report of a story comes from /api/story/ a page at a time. A World card and the article
// detail ask for the same first page, so it is asked once and kept for the tab, and only a few are
// asked at a time so a page of cards does not ask the pod for twenty stories at once.
import type { Report } from './news';

export interface ReportsPage {
  reports: Report[];
  nextCursor: string | null;
}

type Get = <T>(path: string) => Promise<T>;

/** Requests for reports in flight at once. */
const AT_ONCE = 3;
/** First pages kept; the oldest goes first. */
const KEEP = 300;

let running = 0;
const waiting: (() => void)[] = [];
const firsts = new Map<string, Promise<ReportsPage>>();

/** `urgent` goes to the front of the line: the detail the person opened waits on it, a card does not. */
async function inTurn<T>(fn: () => Promise<T>, urgent = false): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => (urgent ? waiting.unshift(go) : waiting.push(go)));
  running += 1;
  try {
    return await fn();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

export const reportsPath = (id: string, after: string | null) => `/api/story/?id=${encodeURIComponent(id)}${after ? `&after=${encodeURIComponent(after)}` : ''}`;

/** The story's first page of reports, asked once per tab; a failed ask is forgotten so it can be asked again. */
export function firstReports(get: Get, id: string, urgent = false): Promise<ReportsPage> {
  const held = firsts.get(id);
  if (held) return held;
  const asked = inTurn(() => get<ReportsPage>(reportsPath(id, null)), urgent);
  firsts.set(id, asked);
  asked.catch(() => firsts.delete(id));
  if (firsts.size > KEEP) firsts.delete(firsts.keys().next().value!);
  return asked;
}

/** A later page; the detail asks for these only as the reader scrolls, so they are not kept. */
export const moreReports = (get: Get, id: string, after: string, urgent = false) => inTurn(() => get<ReportsPage>(reportsPath(id, after)), urgent);

/**
 * Up to `n` other reports from other publishers than the lead, one each, for a card to list under
 * its lead.
 */
export function otherPublishers(lead: Report, reports: Report[], n: number): Report[] {
  const seen = new Set([lead.publisher]);
  const out: Report[] = [];
  for (const r of reports) {
    if (out.length >= n) break;
    if (r.id === lead.id || seen.has(r.publisher)) continue;
    seen.add(r.publisher);
    out.push(r);
  }
  return out;
}

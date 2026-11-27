import fs from 'node:fs';
import path from 'node:path';

/** When the person wants their news: times of day on this computer's clock, and or an interval. */
export interface DigestSchedule {
  times: string[];
  everyMinutes?: number;
  /** When a digest was last shown. */
  lastAt?: string;
}

export const DIGEST_FILE = 'digest.json';
/** Counts for the session hint, which must not start the pod to learn them. Never a fact statement. */
export const HINT_FILE = 'hint.json';
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * True when a scheduled moment passed after `lastAt`. Several missed moments make one due digest.
 * Times are local: each is built from the calendar day, so a day with a clock change still has it.
 */
export function isDue(schedule: Pick<DigestSchedule, 'times' | 'everyMinutes'>, lastAt: Date | undefined, now: Date): boolean {
  if (!lastAt || Number.isNaN(lastAt.getTime())) return false;
  if (schedule.everyMinutes && now.getTime() - lastAt.getTime() >= schedule.everyMinutes * 60_000) return true;
  for (const t of schedule.times) {
    if (!TIME.test(t)) continue;
    const [h, m] = t.split(':').map(Number);
    let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    if (at > now) at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, h, m);
    if (at > lastAt) return true;
  }
  return false;
}

/**
 * The latest scheduled moment at or before `now` after `lastAt`, or undefined. A digest is missed when
 * that moment is over an hour old: a chosen time passed and nothing showed the digest.
 */
export function lastMoment(schedule: Pick<DigestSchedule, 'times' | 'everyMinutes'>, lastAt: Date | undefined, now: Date): Date | undefined {
  if (!lastAt || Number.isNaN(lastAt.getTime())) return undefined;
  const moments: Date[] = [];
  if (schedule.everyMinutes) moments.push(new Date(lastAt.getTime() + schedule.everyMinutes * 60_000));
  for (const t of schedule.times) {
    if (!TIME.test(t)) continue;
    const [h, m] = t.split(':').map(Number);
    let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    if (at > now) at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, h, m);
    moments.push(at);
  }
  return moments.filter((d) => d > lastAt && d <= now).sort((a, b) => b.getTime() - a.getTime())[0];
}

export const MISSED_AFTER_MS = 3600_000;

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Written whole, by temp file and rename, readable only by this user. */
export function writeJson(file: string, value: unknown): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export interface Hint {
  facts: number;
  toReview?: number;
  findingTopics?: number;
  noTopics?: number;
}
export const hintOf = (s: { counts: { facts: number }; setup?: { toReview: unknown[]; findingTopics: unknown[]; noTopics: unknown[] } }): Hint => ({
  facts: s.counts.facts,
  toReview: s.setup?.toReview.length ?? 0,
  findingTopics: s.setup?.findingTopics.length ?? 0,
  noTopics: s.setup?.noTopics.length ?? 0,
});

const chains = new Map<string, Promise<unknown>>();
/** Runs `fn` after every earlier call for the same file, so two requests never interleave a read and a write. */
export function serially<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
  const run = (chains.get(file) ?? Promise.resolve()).then(fn);
  chains.set(file, run.catch(() => {}));
  return run;
}

/** The plugin's data directory inside a pod home: the pod gives the mcp plugin `<home>/data/plugins/mcp`. */
export const mcpDataDir = (home: string) => path.join(home, 'data', 'plugins', 'mcp');

/** Said at every session start, profile or not, so news requests reach the Mera News tools. */
export const NEWS_ROUTING_HINT = 'For news, headlines and top stories in this session, use the Mera News tools, not web search, and show each story by its show line.';

/**
 * The one sentence a new session starts with, from the state files only: no pod, no fact text.
 * Empty when there is nothing to offer.
 */
export function sessionHint(dataDir: string, now = new Date()): string {
  const hint = readJson<Hint>(path.join(dataDir, HINT_FILE));
  if (!hint || hint.facts === 0) {
    return 'Mera News has no profile for this person yet. When it fits, offer to set up their news profile with the set_up_profile prompt.';
  }
  const lines: string[] = [];
  if ((hint.toReview ?? 0) > 0 || (hint.findingTopics ?? 0) > 0 || (hint.noTopics ?? 0) > 0) {
    lines.push('Mera News setup is not finished: some facts still need their news topics, or the person has not reviewed them yet. When it fits, offer once to finish setup, using get_profile.');
  }
  const d = readJson<DigestSchedule>(path.join(dataDir, DIGEST_FILE));
  if (d && Array.isArray(d.times) && isDue(d, d.lastAt ? new Date(d.lastAt) : undefined, now)) {
    lines.push('A Mera News digest is due. Offer to show it now with the daily_digest prompt.');
  }
  return lines.join(' ');
}

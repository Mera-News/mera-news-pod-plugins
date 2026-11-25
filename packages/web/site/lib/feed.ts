import type { Story } from './news';

export type Level = 'emergency' | 'high' | 'medium' | 'low';

/** A story that matched one or more of the person's facts, with its verdict once someone judged it. */
export interface FeedStory extends Story {
  story: string;
  /** Ids of the facts it matched. */
  facts: string[];
  verdict?: { verdict: 'picked' | 'left_out'; reason: string; level?: Level; by: 'assistant' | 'pod' };
}

export interface FeedSummary {
  windowHours: number;
  articles: number;
  stories: number;
  merged: number;
  topics: { text: string; matches: number }[];
  facts: { id: string; statement: string; matched: number; picked: number; leftOut: number }[];
  picked: number;
  leftOut: number;
  unjudged: number;
  publishers: number;
  languages: number;
  complete: boolean;
}

export interface FeedPage {
  run: string;
  summary: FeedSummary;
  stories: FeedStory[];
  nextCursor: string | null;
}

export const LEVEL_ORDER: Record<Level, number> = { emergency: 0, high: 1, medium: 2, low: 3 };
export const LEVEL_LABEL: Record<Level, string> = { emergency: 'Emergency', high: 'High', medium: 'Medium', low: 'Low' };

/** Picks first by level, emergency on top, then newest first. */
export const byLevel = (a: FeedStory, b: FeedStory) =>
  LEVEL_ORDER[a.verdict?.level ?? 'low'] - LEVEL_ORDER[b.verdict?.level ?? 'low'] || b.publishedAt.localeCompare(a.publishedAt);

/** The headline matches every word of the search, in English or in its own language. */
export function matches(s: FeedStory, q: string) {
  const text = `${s.title} ${s.titleEn ?? ''} ${s.publisher}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w));
}

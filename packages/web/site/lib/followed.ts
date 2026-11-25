'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, useApi, usePost } from '@/components/session';
import { age } from '@/lib/news';

/** One article of a followed story: its headline and where it came from, never its text. */
export interface FollowedArticle {
  id: string;
  title: string;
  titleEn?: string;
  /** Null once the pod no longer holds the article's link. */
  link: string | null;
  publisher: string;
  publishedAt: string | null;
  language: string;
  image?: string;
}

export interface FollowedStory {
  id: string;
  title: string;
  /** The title was written by Mera News, not taken from a headline. */
  titleIsAi: boolean;
  newCount: number;
  articles: number;
  latest: FollowedArticle | null;
  updatedAt: string;
  followedAt: string;
  status: 'active' | 'ended';
}

/** A timeline entry: one event, with `copies` other reports of it folded under it. */
export interface Entry extends FollowedArticle {
  copies: number;
}

/** The most characters a story to follow may have. */
export const FOLLOW_MAX = 80;

const asError = (e: unknown, message: string) => (e instanceof ApiError ? e : new ApiError(message, 'Try again in a minute.'));

export const storyHref = (id: string) => `/following/?id=${encodeURIComponent(id)}`;

/** Updated 5m ago, Updated yesterday, Updated 12 Nov. */
export function updated(iso: string) {
  const a = age(iso);
  if (!a) return '';
  return /\d[mh]$/.test(a) ? `Updated ${a} ago` : a === 'Yesterday' ? 'Updated yesterday' : `Updated ${a}`;
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The day an entry belongs to on the timeline: Today, Yesterday, or the date. */
export function dayLabel(iso: string | null, now = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return 'Date unknown';
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
}

/** The time of day an article was published, in the reader's own clock. */
export const clock = (iso: string | null) => {
  const d = iso ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
};

/** Entries in runs of one day each, newest first as the pod sends them. */
export function byDay(entries: Entry[]): { day: string; entries: Entry[] }[] {
  const out: { day: string; entries: Entry[] }[] = [];
  for (const e of entries) {
    const day = dayLabel(e.publishedAt);
    if (out.at(-1)?.day === day) out.at(-1)!.entries.push(e);
    else out.push({ day, entries: [e] });
  }
  return out;
}

/** Every story the person follows, with unfollow and follow. */
export function useFollowed() {
  const get = useApi();
  const post = usePost();
  const [stories, setStories] = useState<FollowedStory[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const reload = useCallback(async () => {
    try {
      setStories((await get<{ stories: FollowedStory[] }>('/api/followed/')).stories);
      setError(null);
    } catch (e) {
      setError(asError(e, 'The stories you follow could not load.'));
    }
  }, [get]);
  useEffect(() => void reload(), [reload]);

  const unfollow = useCallback(
    async (id: string) => {
      await post('/api/followed/unfollow/', { id });
      setStories((list) => list?.filter((s) => s.id !== id) ?? null);
    },
    [post],
  );

  const follow = useCallback(
    async (text: string) => {
      const r = await post<{ id: string; state: 'followed' | 'already'; hint: string }>('/api/followed/follow/', { text });
      await reload();
      return r;
    },
    [post, reload],
  );

  /** The open story was seen: its new count is gone, here as on the pod. */
  const seen = useCallback((id: string) => setStories((list) => list?.map((s) => (s.id === id ? { ...s, newCount: 0 } : s)) ?? null), []);

  return { stories, error, reload, unfollow, follow, seen };
}

type TimelineState = 'loading' | 'more' | 'end' | 'error';

/** One story's timeline, a page at a time. Opening it marks it seen. */
export function useTimeline(id: string, onSeen: (id: string) => void) {
  const get = useApi();
  const post = usePost();
  const [story, setStory] = useState<FollowedStory | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<TimelineState>('loading');
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      setState('loading');
      setError(null);
      try {
        const r = await get<{ story: FollowedStory; entries: Entry[]; cursor: string | null; more: boolean }>(
          `/api/followed/story/?id=${encodeURIComponent(id)}${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        );
        setStory(r.story);
        setEntries((list) => {
          if (!after) return r.entries;
          const ids = new Set(list.map((e) => e.id));
          return [...list, ...r.entries.filter((e) => !ids.has(e.id))];
        });
        setCursor(r.cursor);
        setState(r.more && r.cursor ? 'more' : 'end');
        if (!after) onSeen(id);
      } catch (e) {
        setError(asError(e, 'This story could not load.'));
        setState('error');
      }
    },
    [get, id, onSeen],
  );

  useEffect(() => {
    setStory(null);
    setEntries([]);
    void load(null);
    // Only a new story starts over; `load` changes with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const remove = useCallback(
    async (articleId: string) => {
      await post('/api/followed/remove/', { id, articleId });
      const gone = entries.find((e) => e.id === articleId);
      setEntries((list) => list.filter((e) => e.id !== articleId));
      if (gone) setStory((s) => (s ? { ...s, articles: Math.max(0, s.articles - 1 - gone.copies) } : s));
    },
    [post, id, entries],
  );

  return { story, entries, state, error, more: () => cursor && void load(cursor), retry: () => void load(entries.length ? cursor : null), remove };
}

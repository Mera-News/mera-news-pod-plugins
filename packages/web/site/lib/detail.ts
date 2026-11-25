// An article's detail opens over the page it was opened from, with `?article=<id>` added to the
// address: Back closes it, and the address opens it again in this site. What the opening card knew
// (Mera's verdict, the facts it matched) is kept here for the tab; an address opened cold asks the pod
// for the article alone.
import { useSyncExternalStore, type MouseEvent } from 'react';
import type { FeedStory, Level } from './feed';
import type { Story } from './news';

export const ARTICLE_PARAM = 'article';
export const ARTICLE_ID = /^[\w.:-]{1,100}$/;

/** A story as the detail shows it: Mera's verdict and the person's facts it matched, when known. */
export interface DetailStory extends Story {
  verdict?: { verdict: 'picked' | 'left_out'; reason: string; level?: Level };
  /** Statements of the facts it matched. */
  facts?: string[];
}

const known = new Map<string, DetailStory>();
/** True while the detail on screen was opened here, so closing it is a step back. */
let pushed = false;

export const knownStory = (id: string) => known.get(id);

// The detail follows the address itself: the router does not see a step back over an address only this
// file pushed, so the page listens for Back and for its own changes.
const CHANGED = 'mera-news:detail';
const subscribe = (fn: () => void) => {
  addEventListener('popstate', fn);
  addEventListener(CHANGED, fn);
  return () => {
    removeEventListener('popstate', fn);
    removeEventListener(CHANGED, fn);
  };
};
const current = () => {
  const id = new URLSearchParams(location.search).get(ARTICLE_PARAM);
  return id && ARTICLE_ID.test(id) ? id : null;
};

/** Reads the address again: a link to another page moves it without a popstate. */
export const recheckDetail = () => void dispatchEvent(new Event(CHANGED));

/** The article the address names, or null. */
export const useDetailId = () => useSyncExternalStore(subscribe, current, () => null);

function addressWith(id: string | null) {
  const url = new URL(location.href);
  if (id) url.searchParams.set(ARTICLE_PARAM, id);
  else url.searchParams.delete(ARTICLE_PARAM);
  return url.pathname + url.search + url.hash;
}

export function openDetail(story: DetailStory) {
  known.set(story.id, story);
  history.pushState(history.state, '', addressWith(story.id));
  pushed = true;
  dispatchEvent(new Event(CHANGED));
}

export function closeDetail() {
  if (pushed) history.back();
  else {
    history.replaceState(history.state, '', addressWith(null));
    dispatchEvent(new Event(CHANGED));
  }
  pushed = false;
}

/** The detail's address was left by Back or a link: nothing to step back from. */
export const detailGone = () => void (pushed = false);

/** The link a headline gives for its detail. A plain click opens it here; a modified one opens a new tab at the address. */
export function detailLink(story: DetailStory) {
  return {
    href: `?${ARTICLE_PARAM}=${encodeURIComponent(story.id)}`,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openDetail(story);
    },
  };
}

/** What to follow for a story: its English headline, cut at a word to the 80 characters a followed search may have. */
export function followText(story: { title: string; titleEn?: string }, max = 80) {
  const t = (story.titleEn || story.title).trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1).lastIndexOf(' ');
  return (cut > max / 2 ? t.slice(0, cut) : t.slice(0, max)).trim();
}

/** A Feed story as its detail shows it, with the statements of the facts it matched. */
export const fromFeed = (s: FeedStory, names: Map<string, string>): DetailStory => ({ ...s, facts: s.facts.flatMap((id) => names.get(id) ?? []) });

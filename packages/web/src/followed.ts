// Followed stories: the list, one story's timeline, follow, unfollow and taking an article off a
// story. They are the person's own data, so a paired phone may use them too. Replies carry named
// fields only: a headline, never any article text. No title or search text is ever logged.
import type { FollowedArticle, FollowedStoryView, PodServices } from 'mera-news-pod/plugin-api';
import { NewsError } from './news';

/** Entries per page of a story's timeline. */
export const TIMELINE_PAGE = 20;
/** A followed story's search, as the pod keeps it. */
const MAX_TEXT = 80;
const ID = /^[\w.:-]{1,100}$/;

const bad = (message: string) => new NewsError('bad_input', message, 'Check it and try again.');

/** The pod's errors are written for an assistant; these are the ones the page can meet, in its own words. */
const POD_COPY: Record<string, [string, string]> = {
  unknown_story: ['You no longer follow this story.', 'Go back to the stories you follow.'],
  unknown_article: ['This article is no longer on the story.', 'Reload the story to see it as it is now.'],
  news_unavailable: ['The news server could not answer, so nothing was followed.', 'Try again in a minute.'],
  write_failed: ['The change could not be saved.', 'Try again. If it keeps failing, restart Mera News.'],
};
async function inSiteWords<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    const copy = Object.hasOwn(POD_COPY, code) ? POD_COPY[code] : undefined;
    if (copy) throw new NewsError(code, copy[0], copy[1]);
    throw e;
  }
}

/** An article as the site's headline shows it; `link` is null once the pod no longer holds it. */
const articleOut = (a: FollowedArticle) => ({
  id: a.id,
  title: a.title,
  ...(a.titleEn ? { titleEn: a.titleEn } : {}),
  link: a.url,
  publisher: a.publisher,
  publishedAt: a.publishedAt,
  language: a.lang,
  ...(a.image ? { image: a.image } : {}),
});

const storyOut = (s: FollowedStoryView) => ({
  id: s.id,
  title: s.title,
  titleIsAi: s.titleIsAi,
  newCount: s.newCount,
  articles: s.articles,
  latest: s.latest ? articleOut(s.latest) : null,
  updatedAt: s.updatedAt,
  followedAt: s.followedAt,
  status: s.status,
});

/** Text of 1 to `max` characters once spaces are tidied, or null. */
const text = (v: unknown, max: number) => {
  if (typeof v !== 'string') return null;
  const t = v.trim().replace(/\s+/g, ' ');
  return t.length >= 1 && t.length <= max ? t : null;
};

export function createFollowed(services: Pick<PodServices, 'followed'>) {
  const f = () => services.followed;
  const reads: Record<string, (q: URLSearchParams) => Promise<unknown>> = {
    '/api/followed/': async () => ({ stories: (await f().list()).stories.map(storyOut) }),
    // The first page marks the story seen, as opening it in the app does; later pages leave it.
    '/api/followed/story/': async (q) => {
      const id = q.get('id') ?? '';
      if (!ID.test(id)) throw bad('This story could not be found.');
      const after = q.get('after');
      if (after !== null && !/^\d{1,16}:[\w.:-]{1,100}$/.test(after)) throw bad('This page of the story could not be found.');
      const r = await inSiteWords(() => f().get(id, { limit: TIMELINE_PAGE, ...(after === null ? { markSeen: true } : { after }) }));
      return { story: storyOut(r.story), entries: r.entries.map((e) => ({ ...articleOut(e.head), copies: e.copies })), cursor: r.cursor, more: r.more };
    },
  };
  const writes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    async '/api/followed/follow/'(body) {
      const t = text(body.text, MAX_TEXT);
      if (!t) throw bad(`What to follow is 1 to ${MAX_TEXT} characters.`);
      const label = body.label === undefined ? undefined : text(body.label, MAX_TEXT);
      if (label === null) throw bad(`A story's title is 1 to ${MAX_TEXT} characters.`);
      const from = body.fromArticleId;
      if (from !== undefined && (typeof from !== 'string' || !ID.test(from))) throw bad('This article could not be found.');
      const r = await inSiteWords(() => f().follow({ text: t, ...(label ? { label } : {}), ...(from ? { fromArticleId: from as string } : {}) }));
      return { id: r.id, state: r.state, hint: r.hint };
    },
    async '/api/followed/unfollow/'(body) {
      if (typeof body.id !== 'string' || !ID.test(body.id)) throw bad('This story could not be found.');
      const id = body.id;
      return inSiteWords(() => f().unfollow(id));
    },
    async '/api/followed/remove/'(body) {
      const { id, articleId } = body;
      if (typeof id !== 'string' || !ID.test(id)) throw bad('This story could not be found.');
      if (typeof articleId !== 'string' || !ID.test(articleId)) throw bad('This article could not be found.');
      return inSiteWords(() => f().removeArticle(id, articleId));
    },
  };
  return { reads, writes };
}

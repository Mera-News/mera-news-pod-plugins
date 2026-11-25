// The Feed: every story that matched the person's topics, with its verdict. The website only shows
// stories, so it always reads with peek: viewing it never changes what the assistant is given next.
import type { PodServices, ProfileStory } from 'mera-news-pod/plugin-api';

/** Stories per page of the Feed. */
export const FEED_PAGE = 30;

// Only the named fields leave; facts go by id, since the summary names each one.
const storyOut = (s: ProfileStory) => ({
  id: s.id,
  story: s.story,
  title: s.title,
  ...(s.titleEn ? { titleEn: s.titleEn } : {}),
  link: s.link,
  publisher: s.publisher,
  publishedAt: s.publishedAt,
  language: s.language,
  ...(s.image ? { image: s.image } : {}),
  reports: s.reports,
  facts: s.facts.map((f) => f.id),
  ...(s.verdict ? { verdict: { verdict: s.verdict.verdict, reason: s.verdict.reason, ...(s.verdict.level ? { level: s.verdict.level } : {}), by: s.verdict.by } } : {}),
});

/**
 * One page of the Feed, or with `limit` 0 only the summary of the run `after` names. With `fact`, the
 * run holds only that fact's stories, so each lane of the site loads and pages on its own.
 */
export async function feed(services: Pick<PodServices, 'stories'>, after: string | null, limit: number, fact: string | null = null) {
  const page = await services.stories.forProfile({ ...(fact ? { fact } : {}), ...(after ? { after } : {}), limit, peek: true });
  const s = page.summary;
  return {
    run: page.run,
    summary: {
      windowHours: s.windowHours,
      articles: s.articles,
      stories: s.stories,
      merged: s.merged,
      topics: s.topics.map((t) => ({ text: t.text, matches: t.matches })),
      facts: s.facts.map((f) => ({ id: f.id, statement: f.statement, matched: f.matched, picked: f.picked, leftOut: f.leftOut })),
      picked: s.picked,
      leftOut: s.leftOut,
      unjudged: s.unjudged,
      publishers: s.publishers,
      languages: s.languages,
      complete: s.complete,
    },
    stories: page.stories.map(storyOut),
    nextCursor: page.nextCursor ?? null,
  };
}

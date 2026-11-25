// What the website shows from Mera News: top stories, every report of a story, search, and the
// countries to choose from. Every query goes through the pod, which sends only operations the client
// allows and keeps the key. A reply carries only the fields named here, never a description or any
// other article text.
import type { PodServices } from 'mera-news-pod/plugin-api';
import { alpha3Of, countryName, flagOf } from './countries';

/** The roles the client gives a place. */
const PLACE_ROLES = ['home', 'work', 'travel', 'family', 'partner_family', 'interest'];

type Services = Pick<PodServices, 'news' | 'display'>;

export class NewsError extends Error {
  constructor(
    public code: string,
    message: string,
    public next: string,
  ) {
    super(message);
  }
}

const ARTICLE = '_id title title_en article_url image_url pubDate original_language_code publicationSource { publication_name }';
const TOP = `query GetTopHeadlinesForCountry($countryCode: String, $first: Int, $after: String) { topHeadlinesForCountry(countryCode: $countryCode, first: $first, after: $after) { headlines { clusterSize article { ${ARTICLE} } } pageInfo { endCursor hasNextPage } } }`;
const STORY = `query GetNewsClusterForArticle($articleId: ID!, $first: Int, $after: String) { newsClusterForArticle(articleId: $articleId) { clusterSize articles(first: $first, after: $after) { articles { ${ARTICLE} } pageInfo { endCursor hasNextPage } } } }`;
const SEARCH = 'query SearchNews($query: String!, $limit: Int) { searchNews(query: $query, limit: $limit) { _id } }';
// The by-ids reply names the language and publisher differently from the other two.
const BY_IDS = 'query GetArticlesForTopicsByIds($articleIds: [ID!]!) { articlesForTopicsByIds(articleIds: $articleIds) { articles { _id title title_en article_url image_url pubDate language_code publication_name maxClusterSize } } }';
const CLUSTERS = 'query ClusterMembershipsForArticles($articleIds: [ID!]!) { clusterMembershipsForArticles(articleIds: $articleIds) { articleId clusters { clusterId stableClusterId confidence } } }';
const COUNTRIES = 'query AllCountries { allCountries }';

/** Stories asked for per page, and reports per page of one story (the server's most). */
export const STORIES_PER_PAGE = 20;
export const REPORTS_PER_PAGE = 50;

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
  /** How many reports of this story Mera News holds, this one included. */
  reports: number;
}
export interface Country {
  code: string;
  name: string;
  flag?: string;
}

interface ArticleIn {
  _id: string;
  title?: string | null;
  title_en?: string | null;
  article_url?: string | null;
  image_url?: string | null;
  pubDate?: string | null;
  original_language_code?: string | null;
  language_code?: string | null;
  publication_name?: string | null;
  publicationSource?: { publication_name?: string | null } | null;
  maxClusterSize?: number | null;
}

const KEY_NEXT = 'Paste the key from Mera Labs into the Mera News settings of your AI app, or into secrets.json if you run your own pod, then restart it.';

async function ask<T>(services: Services, operationName: string, query: string, variables: object): Promise<T> {
  let reply: { data?: T; errors?: { extensions?: { code?: string } }[] };
  try {
    reply = (await services.news.graphql({ operationName, query, variables })) as typeof reply;
  } catch {
    reply = { errors: [{}] };
  }
  if (!reply.errors?.length && reply.data) return reply.data;
  const code = reply.errors?.[0]?.extensions?.code;
  // The server's own text never reaches the page.
  if (code === 'UNAUTHENTICATED') throw new NewsError('key_refused', 'Mera News refused the key, or no key is set.', KEY_NEXT);
  if (code === 'BAD_USER_INPUT') throw new NewsError('bad_input', 'This page of news has expired.', 'Reload the page to start again.');
  throw new NewsError('news_unavailable', 'The news server could not answer.', 'Try again in a minute.');
}

// Text from a feed is capped, and only http(s) addresses leave.
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const web = (v: unknown, scheme: RegExp) => (typeof v === 'string' && scheme.test(v) ? v.slice(0, 2000) : undefined);

function reportOut(a: ArticleIn): Report | null {
  const link = web(a.article_url, /^https?:\/\//);
  if (!link || typeof a._id !== 'string') return null;
  const title = text(a.title || a.title_en, 500);
  const titleEn = text(a.title_en, 500);
  return {
    id: a._id.slice(0, 100),
    title,
    ...(titleEn && titleEn !== title ? { titleEn } : {}),
    link,
    publisher: text(a.publicationSource?.publication_name ?? a.publication_name, 200),
    publishedAt: text(a.pubDate, 40),
    language: text(a.original_language_code || a.language_code, 12) || 'und',
  };
}

function storyOut(a: ArticleIn, reports: number): Story | null {
  const r = reportOut(a);
  if (!r) return null;
  const image = web(a.image_url, /^https:\/\//);
  return { ...r, ...(image ? { image } : {}), reports: Math.max(1, Math.floor(reports) || 1) };
}

const cursorOf = (p: { endCursor?: string | null; hasNextPage?: boolean } | undefined) => (p?.hasNextPage && p.endCursor ? p.endCursor : null);

/** One page of the most reported stories, for the world (GLOBAL) or one alpha-3 country. */
export async function topStories(services: Services, country: string, after: string | null) {
  type Reply = { topHeadlinesForCountry: { headlines: { clusterSize?: number | null; article: ArticleIn }[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } };
  const got = (
    await ask<Reply>(services, 'GetTopHeadlinesForCountry', TOP, { countryCode: country === 'GLOBAL' ? null : country, first: STORIES_PER_PAGE, after })
  ).topHeadlinesForCountry;
  return {
    stories: got.headlines.flatMap((h) => storyOut(h.article, h.clusterSize ?? 1) ?? []),
    nextCursor: cursorOf(got.pageInfo),
  };
}

/** One page of every report of the story an article belongs to. */
export async function storyReports(services: Services, id: string, after: string | null) {
  type Reply = { newsClusterForArticle: { clusterSize?: number | null; articles: { articles: ArticleIn[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } } | null };
  const got = (await ask<Reply>(services, 'GetNewsClusterForArticle', STORY, { articleId: id, first: REPORTS_PER_PAGE, after })).newsClusterForArticle;
  if (!got) return { reports: [] as Report[], nextCursor: null };
  return { reports: got.articles.articles.flatMap((a) => reportOut(a) ?? []), nextCursor: cursorOf(got.articles.pageInfo) };
}

/**
 * Search all of Mera News by words: the server's best matches, at most 25, and reports of one story
 * shown as one. A server that cannot group leaves each match on its own.
 */
export async function search(services: Services, query: string) {
  const hits = (await ask<{ searchNews: { _id: string }[] }>(services, 'SearchNews', SEARCH, { query, limit: 25 })).searchNews.map((h) => h._id);
  if (hits.length === 0) return { stories: [] as Story[] };
  const got = await ask<{ articlesForTopicsByIds: { articles: ArticleIn[] } }>(services, 'GetArticlesForTopicsByIds', BY_IDS, { articleIds: hits });
  const byId = new Map(got.articlesForTopicsByIds.articles.map((a) => [a._id, a]));
  const found = hits.flatMap((id) => byId.get(id) ?? []);
  const storyOf = new Map<string, string>();
  try {
    type Rows = { clusterMembershipsForArticles: { articleId: string; clusters: { clusterId: string; stableClusterId?: string | null; confidence: number }[] }[] };
    const rows = (await ask<Rows>(services, 'ClusterMembershipsForArticles', CLUSTERS, { articleIds: found.map((a) => a._id) })).clusterMembershipsForArticles;
    for (const row of Array.isArray(rows) ? rows : []) {
      const best = (row.clusters ?? []).reduce<Rows['clusterMembershipsForArticles'][number]['clusters'][number] | undefined>((a, c) => (!a || c.confidence > a.confidence ? c : a), undefined);
      if (best) storyOf.set(row.articleId, String(best.stableClusterId ?? best.clusterId));
    }
  } catch {
    // no grouping: every match is its own story
  }
  // The best match of a story leads it; the others are among its reports.
  const lead = new Map<string, { a: ArticleIn; matches: number }>();
  for (const a of found) {
    const key = storyOf.get(a._id) ?? `article:${a._id}`;
    const seen = lead.get(key);
    if (seen) seen.matches += 1;
    else lead.set(key, { a, matches: 1 });
  }
  return { stories: [...lead.values()].flatMap(({ a, matches }) => storyOut(a, Math.max(matches, a.maxClusterSize ?? 1)) ?? []) };
}

/** Tables a countries read already holds, so the next snapshot sends rows for places only. */
export function createCountries(services: Services) {
  let held: Record<string, string> = {};
  return async (): Promise<{ yours: Country[]; all: Country[]; places: { name: string; role?: string }[] }> => {
    const [snapshot, all] = await Promise.all([
      services.display.snapshot({ hashes: held }),
      ask<{ allCountries: string[] }>(services, 'AllCountries', COUNTRIES, {}),
    ]);
    held = Object.fromEntries(Object.entries(snapshot.tables).flatMap(([name, t]) => (name === 'locations' ? [] : [[name, t.hash]])));
    const now = Date.now();
    // The person's places, the weightiest first; a place that has run out is left out.
    const places = (snapshot.tables.locations?.rows ?? [])
      .filter((r) => typeof r.country_code === 'string' && !(typeof r.valid_until === 'number' && r.valid_until < now))
      .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0));
    const yours = [...new Set(places.flatMap((r) => alpha3Of(r.country_code as string) ?? []))];
    const codes = [...new Set((Array.isArray(all.allCountries) ? all.allCountries : []).filter((c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c)))];
    const named = (code: string): Country => {
      const flag = flagOf(code);
      return { code, name: countryName(code), ...(flag ? { flag } : {}) };
    };
    // Each place as Profile lists it: the city where there is one, then the country, and its role.
    const placeList = places.flatMap((r) => {
      const code = alpha3Of(r.country_code as string);
      if (!code) return [];
      const city = typeof r.city === 'string' && r.city.trim() ? `${r.city.trim()}, ` : '';
      const role = typeof r.role === 'string' && PLACE_ROLES.includes(r.role) ? { role: r.role } : {};
      return [{ name: `${city}${countryName(code)}`, ...role }];
    });
    return { yours: yours.map(named), all: codes.map(named).sort((a, b) => a.name.localeCompare(b.name, 'en')), places: placeList };
  };
}

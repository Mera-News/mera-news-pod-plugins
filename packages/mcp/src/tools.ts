import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type ToolAnnotations } from '@modelcontextprotocol/server';
import path from 'node:path';
import type { PickView, PluginContext, PodStatus, ProfileSetup, ProfileStory, ProfileView, StoriesSummary } from 'mera-news-pod/plugin-api';
import { z } from 'zod';
import { DIGEST_FILE, HINT_FILE, hintOf, isDue, lastMoment, MISSED_AFTER_MS, readJson, serially, TIME, writeJson, type DigestSchedule } from './digest';
import { siteLink } from './link';
import { fail, fit, ok, TARGET_TOKENS } from './reply';
import { descriptions, instructions, newsOnlyLine, prompts } from './text';

const statement = z.string().min(1).max(300);
const statements = z.array(z.union([statement, z.object({ statement, topics: z.array(z.string().trim().min(1).max(80)).min(1).max(12).optional() })])).min(1).max(10);
const ids = z.array(z.string().min(1)).min(1).max(20);

const schemas = {
  get_profile: z.object({ offset: z.number().int().min(0).optional(), waitSeconds: z.number().min(0).max(45).optional() }),
  add_facts: z.object({ statements }),
  remove_facts: z.object({ ids }),
  edit_topics: z.object({
    remove: z.array(z.string().min(1)).optional(),
    weight: z.array(z.object({ topicId: z.string().min(1), weight: z.number().min(-1).max(1) })).optional(),
    reviewed: ids.optional(),
  }),
  get_suggestions: z.object({
    since: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  search_news: z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(25).default(10) }),
  latest_news: z.object({
    country: z.string().regex(/^[A-Z]{3}$/).optional(),
    limit: z.number().int().min(1).max(25).default(10),
    after: z.string().min(1).max(200).optional(),
  }),
  top_stories: z.object({
    country: z.string().regex(/^[A-Z]{3}$/).optional(),
    after: z.string().min(1).max(200).optional(),
    story: z.string().min(1).max(100).optional(),
  }),
  news_for_profile: z.object({ after: z.string().min(1).max(40).optional(), limit: z.number().int().min(1).max(50).default(20) }),
  rate_stories: z.object({
    stories: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          verdict: z.enum(['picked', 'left_out']),
          level: z.enum(['emergency', 'high', 'medium', 'low']).optional(),
          reason: z.string().trim().min(1).max(300),
        }),
      )
      .min(1)
      .max(50),
  }),
  get_status: z.object({}),
  set_reading: z.object({
    paused: z.boolean().optional(),
    everyMinutes: z.number().int().min(5).max(1440).optional(),
    digestTimes: z.array(z.string().regex(TIME)).max(48).optional(),
    digestEveryMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  }),
  digest_done: z.object({}),
  open_news_site: z.object({}),
};

/** The version 2 context: add_facts needs `profile.addTopics`. */
export type McpContext = Extract<PluginContext, { podApi: 2 }>;


const readOnly: ToolAnnotations = { readOnlyHint: true };
const writes: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
const destructive: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

/**
 * The SDK would answer a bad argument with the validator's own text. This keeps the advertised
 * input schema but lets every call through, so the handler can answer in the plugin's error shape.
 */
function advertise(schema: z.ZodType): StandardSchemaWithJSON {
  const std = (schema as unknown as { '~standard': Record<string, unknown> })['~standard'];
  return { '~standard': { ...std, validate: (value: unknown) => ({ value: value ?? {} }) } } as unknown as StandardSchemaWithJSON;
}

// Only the named fields leave: a service that ever hands back article text is not passed through.
// Text from a feed is capped, so one pick always fits a reply on its own.
const pickOut = (p: PickView): PickView => ({
  id: p.id,
  title: p.title.slice(0, 500),
  publication: p.publication.slice(0, 200),
  url: p.url,
  publishedAt: p.publishedAt,
  level: p.level,
  lang: p.lang,
  reason: p.reason.slice(0, 1000),
  facts: p.facts.slice(0, 10),
});

const SEARCH_NEWS = `query SearchNews($query: String!, $limit: Int) { searchNews(query: $query, limit: $limit) { _id } }`;
// The by-ids reply names the language and publisher differently from the country page.
const ARTICLES_BY_IDS = `query GetArticlesForTopicsByIds($articleIds: [ID!]!) { articlesForTopicsByIds(articleIds: $articleIds) { articles { _id title title_en article_url pubDate language_code publication_name } } }`;
const ARTICLE_FIELDS = `_id title title_en article_url pubDate original_language_code publicationSource { publication_name }`;
const ARTICLES_FOR_COUNTRY = `query GetArticlesForCountry($countryCode: String, $first: Int, $after: String) { articlesForCountry(countryCode: $countryCode, first: $first, after: $after) { articles { ${ARTICLE_FIELDS} } pageInfo { endCursor hasNextPage } } }`;

interface NewsArticleIn {
  _id: string;
  title?: string | null;
  title_en?: string | null;
  article_url?: string | null;
  pubDate?: string | null;
  original_language_code?: string | null;
  language_code?: string | null;
  publication_name?: string | null;
  publicationSource?: { publication_name?: string | null } | null;
}

const TOP_STORIES = `query GetTopHeadlinesForCountry($countryCode: String, $first: Int, $after: String) { topHeadlinesForCountry(countryCode: $countryCode, first: $first, after: $after) { headlines { clusterSize article { ${ARTICLE_FIELDS} } } pageInfo { endCursor hasNextPage } } }`;
const STORY_REPORTS = `query GetNewsClusterForArticle($articleId: ID!, $first: Int, $after: String) { newsClusterForArticle(articleId: $articleId) { clusterSize articles(first: $first, after: $after) { articles { ${ARTICLE_FIELDS} } pageInfo { endCursor hasNextPage } } } }`;
/** Stories per top_stories page, and reports listed per story in one reply. */
const STORIES_PER_PAGE = 10;
const REPORTS_PER_STORY = 25;

const CLUSTERS = `query ClusterMembershipsForArticles($articleIds: [ID!]!) { clusterMembershipsForArticles(articleIds: $articleIds) { articleId clusters { clusterId stableClusterId confidence } } }`;

// Only the named fields leave, never a description or other article text. Text from a feed is capped.
function newsOut(a: NewsArticleIn) {
  const link = a.article_url ?? '';
  if (!/^https?:\/\//.test(link)) return [];
  const title = (a.title || a.title_en || '').slice(0, 500);
  const titleEn = (a.title_en ?? '').slice(0, 500);
  return [
    {
      id: a._id,
      title,
      ...(titleEn && titleEn !== title ? { title_en: titleEn } : {}),
      link: link.slice(0, 2000),
      publisher: (a.publicationSource?.publication_name ?? a.publication_name ?? '').slice(0, 200),
      publishedAt: a.pubDate ?? '',
      language: a.original_language_code || a.language_code || 'und',
    },
  ];
}

class NewsError extends Error {
  constructor(public code: string, message: string, public next: string) {
    super(message);
  }
}

/** One news query. The store's own error text never reaches the reply. */
const KEY_FIX =
  "ask the person to paste the key from Mera Labs into the Mera News extension or plugin settings in their AI app (for a pod they run themselves: dataApiKey in secrets.json in the pod's folder), then start a new conversation; never ask them to paste the key in the chat";

const SITE_FIX =
  'tell the person they can turn on "Also run the Mera News website on this computer" in the Mera News extension or plugin settings of their AI app, then restart the app; a person who runs their own pod adds the web plugin to pod.json and restarts it';

async function ask<T>(graphql: (body: unknown) => Promise<unknown>, operationName: string, query: string, variables: object): Promise<T> {
  let reply: { data?: T; errors?: { extensions?: { code?: string } }[] };
  try {
    reply = (await graphql({ operationName, query, variables })) as typeof reply;
  } catch {
    reply = { errors: [{}] };
  }
  if (reply.errors?.length || !reply.data) {
    if (reply.errors?.[0]?.extensions?.code === 'BAD_USER_INPUT') throw new NewsError('bad_input', 'The field "after" is not valid for latest_news.', 'call latest_news again without "after"');
    // The news server refuses a key inside an ordinary reply, so this is the one place that can name it.
    if (reply.errors?.[0]?.extensions?.code === 'UNAUTHENTICATED') throw new NewsError('key_refused', 'The Mera News key was refused.', KEY_FIX);
    throw new NewsError('news_unavailable', 'The news server could not answer.', 'try again later; if it keeps failing, call get_status, which names what to fix');
  }
  return reply.data;
}

type NewsOut = ReturnType<typeof newsOut>[number] & { story?: string };

/**
 * Gives reports of one event in a reply the same `story`, from the news server's grouping (each
 * article's most confident group). A server that does not group, or fails, leaves the list as it is.
 */
async function withStories(graphql: (body: unknown) => Promise<unknown>, results: NewsOut[]): Promise<NewsOut[]> {
  if (results.length < 2) return results;
  type Rows = { clusterMembershipsForArticles: { articleId: string; clusters: { clusterId: string; stableClusterId?: string | null; confidence: number }[] }[] };
  let rows: Rows['clusterMembershipsForArticles'];
  try {
    rows = (await ask<Rows>(graphql, 'ClusterMembershipsForArticles', CLUSTERS, { articleIds: results.map((r) => r.id) })).clusterMembershipsForArticles;
  } catch {
    return results;
  }
  if (!Array.isArray(rows)) return results;
  const storyOf = new Map<string, string>();
  for (const row of rows) {
    const best = (row.clusters ?? []).reduce<(typeof row.clusters)[number] | undefined>((a, c) => (!a || c.confidence > a.confidence ? c : a), undefined);
    if (best) storyOf.set(row.articleId, String(best.stableClusterId ?? best.clusterId).slice(0, 100));
  }
  const size = new Map<string, number>();
  for (const r of results) if (storyOf.has(r.id)) size.set(storyOf.get(r.id)!, (size.get(storyOf.get(r.id)!) ?? 0) + 1);
  // Only a story with two or more reports in this reply is named: a story of one tells the reader nothing.
  return results.map((r) => (size.get(storyOf.get(r.id) ?? '')! > 1 ? { ...r, story: storyOf.get(r.id)! } : r));
}

// shortcut: each setup list is cut to 10 statements (one add_facts call) so a reply always fits; upgrade if people review more at once.
const setupOut = (s: ProfileSetup): ProfileSetup => ({ ...s, findingTopics: s.findingTopics.slice(0, 10), toReview: s.toReview.slice(0, 10), noTopics: s.noTopics.slice(0, 10) });
// Only setup.findingTopics: a pending fact in a pod with no AI service never gets topics on its own.
const stillFinding = (p: ProfileView) => p.setup.findingTopics.length > 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A page of news_for_profile: the run's summary numbers, the stories still to judge grouped by fact,
 * and the stories judged before with their verdicts. Only the named fields leave.
 */
function profileNews(page: { run: string; summary: StoriesSummary; stories: ProfileStory[]; nextCursor?: string; shownBefore: number }) {
  const head = (s: ProfileStory) => ({ id: s.id, title: s.title, ...(s.titleEn ? { title_en: s.titleEn } : {}), link: s.link, publisher: s.publisher });
  const toJudge = new Map<string, { factId: string; fact: string; stories: object[] }>();
  const picked: object[] = [];
  const leftOut: object[] = [];
  for (const s of page.stories) {
    const facts = s.facts.map((f) => f.statement);
    if (!s.verdict) {
      const f = s.facts[0] ?? { id: '', statement: '' };
      if (!toJudge.has(f.id)) toJudge.set(f.id, { factId: f.id, fact: f.statement, stories: [] });
      toJudge.get(f.id)!.stories.push({ ...head(s), publishedAt: s.publishedAt, language: s.language, reports: s.reports, ...(facts.length > 1 ? { alsoFacts: facts.slice(1) } : {}) });
    } else if (s.verdict.verdict === 'picked') picked.push({ ...head(s), level: s.verdict.level, reason: s.verdict.reason, facts });
    else leftOut.push({ ...head(s), reason: s.verdict.reason, facts });
  }
  const { summary } = page;
  const next = page.nextCursor
    ? 'Read every page before you pick or answer: call news_for_profile again with after set to nextCursor.'
    : summary.unjudged > 0
      ? 'This is the last page. Judge every story in toJudge, on every page, with rate_stories: picked, with a level and one sentence on why it matters to the person, or left_out, with one short reason. Then show the summary numbers, the picks by level with emergency first, and everything left out, each with its title, its link and its reason.'
      : 'This is the last page, and every story is judged. Show the summary numbers, the picks by level with emergency first, and everything left out, each with its title, its link and its reason.';
  return {
    summary,
    toJudge: [...toJudge.values()],
    picked,
    leftOut,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    ...(page.shownBefore ? { shownBefore: page.shownBefore } : {}),
    next,
  };
}

/** Room left in a reply for its state, hint, cursor and the like. */
const ENVELOPE_TOKENS = 400;

const saysCode = (e: unknown): e is { code: string; message: string; next: string } =>
  e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { next?: unknown }).next === 'string';

export function buildServer(ctx: McpContext): McpServer {
  const { services, estimateTokens: estimate } = ctx;
  const digestFile = path.join(ctx.dataDir, DIGEST_FILE);
  const digestView = (d = readJson<DigestSchedule>(digestFile)) => {
    const times = Array.isArray(d?.times) ? d.times : [];
    const schedule = { times, everyMinutes: d?.everyMinutes };
    const lastAt = d?.lastAt ? new Date(d.lastAt) : undefined;
    const now = new Date();
    const moment = lastMoment(schedule, lastAt, now);
    // A chosen time over an hour ago with no digest shown: most likely no scheduled task runs it.
    const missed = !!moment && now.getTime() - moment.getTime() > MISSED_AFTER_MS;
    return { times, everyMinutes: d?.everyMinutes ?? null, due: isDue(schedule, lastAt, now), ...(missed ? { missed: true } : {}) };
  };
  const changeDigest = (change: (d: DigestSchedule) => DigestSchedule) =>
    serially(digestFile, () => {
      const d = change(readJson<DigestSchedule>(digestFile) ?? { times: [] });
      writeJson(digestFile, d);
      return digestView(d);
    });
  // The session hint reads the fact count from this file, so it never has to start the pod.
  const noteFacts = (s: PodStatus) => {
    try {
      writeJson(path.join(ctx.dataDir, HINT_FILE), hintOf(s));
    } catch {
      ctx.log.warn('The session hint file could not be written.');
    }
  };
  const statusAndHint = () =>
    services.reading.status().then(
      (s) => (noteFacts(s), s),
      () => undefined,
    );
  const server = new McpServer({ name: 'mera-news-pod-mcp', version: '0.1.0' }, { instructions });

  function tool<K extends keyof typeof schemas>(
    name: K,
    annotations: ToolAnnotations,
    run: (input: z.output<(typeof schemas)[K]>) => Promise<CallToolResult>,
  ) {
    server.registerTool(name, { description: descriptions[name], inputSchema: advertise(schemas[name]), annotations }, async (raw: unknown) => {
      const parsed = schemas[name].safeParse(raw);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.join('.') || 'input';
        return fail('bad_input', `The field "${field}" is not valid for ${name}.`, `correct "${field}" and call ${name} again`);
      }
      try {
        return await run(parsed.data as z.output<(typeof schemas)[K]>);
      } catch (e) {
        if (saysCode(e)) return fail(e.code, e.message, e.next);
        ctx.log.error(`${name} failed`);
        const message = e instanceof Error ? e.message : 'The pod could not do that.';
        return fail('failed', message, 'try again, and if it keeps failing ask the person to run node build/cli.js check in the mera-news-pod folder');
      }
    });
  }

  tool('get_profile', readOnly, async ({ offset, waitSeconds }) => {
    const read = () => services.profile.get(offset === undefined ? undefined : { offset });
    let profile = await read();
    // Lets the assistant show "Generating topics for:" and wait within one turn, under the bridge's minute.
    for (const end = Date.now() + (waitSeconds ?? 0) * 1000; stillFinding(profile) && Date.now() < end; profile = await read()) {
      await sleep(Math.min(1000, end - Date.now()));
    }
    const base = offset ?? 0;
    const setup = setupOut(profile.setup);
    const make = (facts: typeof profile.facts, cut: boolean) =>
      cut ? { facts, nextOffset: base + facts.length, truncated: true, setup } : { facts, ...(profile.nextOffset === undefined ? {} : { nextOffset: profile.nextOffset }), setup };
    let { kept, cut } = fit(profile.facts, make, estimate);
    if (cut && kept.length === 0 && profile.facts.length > 0) {
      // One fact with a huge topic list: show it with the topics that fit.
      const first = profile.facts[0];
      kept = [{ ...first, topics: fit(first.topics, (topics) => make([{ ...first, topics }], true), estimate).kept }];
    }
    return ok(make(kept, cut), estimate);
  });

  tool('add_facts', writes, async ({ statements: items }) => {
    const result = await services.profile.addFacts(items.map((i) => (typeof i === 'string' ? i : i.statement)));
    const saved = [...result.added, ...result.already];
    // The pod's own key for a saved statement: case and spacing ignored.
    const key = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
    const idOf = (s: string) => (saved.find((f) => f.statement === s.trim()) ?? saved.find((f) => key(f.statement) === key(s)))?.id;
    const refused = new Set(result.refused.map((r) => key(String(r.statement))));
    // Topics go to facts already saved too, which mends a fact an earlier call left without topics.
    const topics: object[] = [];
    let withTopics = 0;
    for (const item of items) {
      if (typeof item === 'string' || !item.topics) continue;
      const id = idOf(item.statement);
      if (!id) {
        if (!refused.has(key(item.statement))) topics.push({ statement: item.statement, error: 'This fact was not saved, so its topics were not saved either.' });
        continue;
      }
      withTopics++;
      try {
        topics.push({ factId: id, ...(await services.profile.addTopics(id, item.topics)) });
      } catch (e) {
        topics.push({ factId: id, error: saysCode(e) ? e.message : 'These topics could not be saved.' });
      }
    }
    const s = await statusAndHint();
    const review = s?.setup
      ? ' Setup is not finished: show the person each fact\'s topics, let them remove any they do not want, then call edit_topics with reviewed set to those fact ids. Every topic they did not remove is kept.'
      : '';
    const note = s?.ai
      ? `Saved. Topics are made from the saved facts within a minute or two: call get_profile with waitSeconds to wait for them.${review}`
      : withTopics < saved.length
        ? 'This pod makes no topics on its own. Call add_facts again with the same statements and 4 to 8 news topics for each.'
        : `Saved.${review || ' Call get_profile to see the topics.'}`;
    return ok({ ...result, ...(topics.length ? { topics } : {}), note }, estimate);
  });

  tool('remove_facts', destructive, async ({ ids }) => {
    const removed = await services.profile.removeFacts(ids);
    await statusAndHint();
    return ok(removed, estimate);
  });

  tool('edit_topics', destructive, async ({ remove, weight, reviewed }) => {
    const result = await services.profile.editTopics({ ...(remove ? { remove } : {}), ...(weight ? { weight } : {}), ...(reviewed ? { reviewed } : {}) });
    if (reviewed) await statusAndHint();
    return ok(result, estimate);
  });

  tool('get_suggestions', readOnly, async ({ since, limit }) => {
    // The services cut the page until it fits and count only the picks returned as delivered.
    const fits = (picks: PickView[]) => estimate(JSON.stringify(picks.map(pickOut))) + ENVELOPE_TOKENS <= TARGET_TOKENS;
    const got = await services.suggestions.get({ ...(since ? { since } : {}), limit, fits });
    return ok({ ...got, picks: got.picks.map(pickOut) }, estimate);
  });

  // Replies are cut to the target, and a cut reply says so.
  const newsReply = (results: NewsOut[], extra: object = {}) => {
    const { kept, cut } = fit(results, (k, c) => ({ results: k, ...(c ? { truncated: true } : extra) }), estimate);
    return ok({ results: kept, ...(cut ? { truncated: true } : extra) }, estimate);
  };

  tool('search_news', readOnly, async ({ query, limit }) => {
    const hits = await ask<{ searchNews: { _id: string }[] }>(services.news.graphql, 'SearchNews', SEARCH_NEWS, { query, limit });
    const wanted = hits.searchNews.map((h) => h._id);
    if (wanted.length === 0) return ok({ results: [] }, estimate);
    const got = await ask<{ articlesForTopicsByIds: { articles: NewsArticleIn[] } }>(services.news.graphql, 'GetArticlesForTopicsByIds', ARTICLES_BY_IDS, { articleIds: wanted });
    const byId = new Map(got.articlesForTopicsByIds.articles.map((a) => [a._id, a]));
    return newsReply(await withStories(services.news.graphql, wanted.flatMap((id) => (byId.has(id) ? newsOut(byId.get(id)!) : []))));
  });

  tool('latest_news', readOnly, async ({ country, limit, after }) => {
    type Page = { articlesForCountry: { articles: NewsArticleIn[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } };
    const page = async (first: number) =>
      (await ask<Page>(services.news.graphql, 'GetArticlesForCountry', ARTICLES_FOR_COUNTRY, { countryCode: country ?? null, first, after: after ?? null })).articlesForCountry;
    const cursor = (p: Page['articlesForCountry']) => (p.pageInfo.hasNextPage && p.pageInfo.endCursor ? { nextCursor: p.pageInfo.endCursor } : {});
    const got = await page(limit);
    const out = got.articles.map(newsOut);
    const results = await withStories(services.news.graphql, out.flat());
    const { kept, cut } = fit(results, (k, c) => ({ results: k, ...(c ? { truncated: true, nextCursor: '' } : cursor(got)) }), estimate);
    if (!cut) return ok({ results: kept, ...cursor(got) }, estimate);
    // The server's cursor ends its whole page, so ask again for only the articles that fit: its cursor then ends there.
    let consumed = 0;
    for (let n = 0; n < kept.length; consumed++) n += out[consumed].length;
    return ok({ results: kept, truncated: true, ...cursor(await page(consumed)) }, estimate);
  });

  type ReportsPage = { newsClusterForArticle: { clusterSize?: number | null; articles: { articles: NewsArticleIn[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } } | null };
  // A report is where a story was published: the publisher, its link and its language.
  const reportsOf = async (articleId: string, after: string | null) => {
    const got = (await ask<ReportsPage>(services.news.graphql, 'GetNewsClusterForArticle', STORY_REPORTS, { articleId, first: REPORTS_PER_STORY, after })).newsClusterForArticle;
    const reports = (got?.articles.articles ?? []).flatMap(newsOut).map((r) => ({ publisher: r.publisher, link: r.link, language: r.language }));
    const p = got?.articles.pageInfo;
    return { count: got?.clusterSize ?? reports.length, reports, after: p?.hasNextPage && p.endCursor ? p.endCursor : null };
  };
  type Report = Awaited<ReturnType<typeof reportsOf>>['reports'][number];
  const summary = (stories: { reportCount: number; reports: Report[] }[]) => ({
    stories: stories.length,
    reports: stories.reduce((n, s) => n + s.reportCount, 0),
    publishers: new Set(stories.flatMap((s) => s.reports.map((r) => r.publisher))).size,
    languages: new Set(stories.flatMap((s) => s.reports.map((r) => r.language))).size,
  });

  tool('top_stories', readOnly, async ({ country, after, story }) => {
    if (story) {
      const got = await reportsOf(story, after ?? null);
      return ok({ story, reportCount: got.count, reports: got.reports, ...(got.after ? { nextCursor: got.after } : {}) }, estimate);
    }
    type Page = { topHeadlinesForCountry: { headlines: { clusterSize?: number | null; article: NewsArticleIn }[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } };
    const page = async (first: number) =>
      (await ask<Page>(services.news.graphql, 'GetTopHeadlinesForCountry', TOP_STORIES, { countryCode: country ?? null, first, after: after ?? null })).topHeadlinesForCountry;
    const got = await page(STORIES_PER_PAGE);
    // One entry per headline, empty when its link is unusable, so a cut can count headlines.
    const out = await Promise.all(
      got.headlines.map(async (h) => {
        const [lead] = newsOut(h.article);
        if (!lead) return [];
        const listed = (h.clusterSize ?? 0) > 1 ? await reportsOf(lead.id, null) : { count: 1, reports: [], after: null };
        const reports = listed.reports.length ? listed.reports : [{ publisher: lead.publisher, link: lead.link, language: lead.language }];
        const reportCount = Math.max(h.clusterSize ?? 1, listed.count, reports.length);
        const publishers = new Set(reports.map((r) => r.publisher)).size;
        return [{ ...lead, reportCount, ...(listed.after ? {} : { publisherCount: publishers }), reports, ...(listed.after ? { moreReports: { story: lead.id, after: listed.after } } : {}) }];
      }),
    );
    const stories = out.flat();
    const cursor = (p: Page['topHeadlinesForCountry']) => (p.pageInfo.hasNextPage && p.pageInfo.endCursor ? { nextCursor: p.pageInfo.endCursor } : {});
    const scope = { scope: country ?? 'world', windowHours: 24 };
    const { kept, cut } = fit(stories, (k, c) => ({ ...scope, summary: summary(k), stories: k, ...(c ? { truncated: true, nextCursor: '' } : cursor(got)) }), estimate);
    if (!cut) return ok({ ...scope, summary: summary(kept), stories: kept, ...cursor(got) }, estimate);
    // The server's cursor ends its whole page, so ask again for only the stories that fit: its cursor then ends there.
    let consumed = 0;
    for (let n = 0; n < kept.length; consumed++) n += out[consumed].length;
    return ok({ ...scope, summary: summary(kept), stories: kept, truncated: true, ...cursor(await page(consumed)) }, estimate);
  });

  // Not read-only: the unjudged stories it returns are recorded, and wait 72 hours before a later run returns them.
  tool('news_for_profile', writes, async ({ after, limit }) => {
    const page = await services.stories.forProfile({
      ...(after ? { after } : {}),
      limit,
      // The services cut the page until the whole reply fits, and record only the stories returned.
      fits: (stories, summary) => estimate(JSON.stringify(profileNews({ run: '', summary, stories, shownBefore: 0 }))) + ENVELOPE_TOKENS <= TARGET_TOKENS,
    });
    return ok(profileNews(page), estimate);
  });

  tool('rate_stories', writes, async ({ stories }) => {
    const result = await services.stories.judge(stories);
    const grounded = result.refused.filter((r) => r.code === 'reason_not_grounded');
    const note = grounded.length
      ? 'Some picks were not saved: their reason shares no word with the headline. Call rate_stories again for those with a reason that names something the headline says.'
      : 'Saved. Each story keeps this verdict, so it is never judged again. When every story is judged, show the person the summary numbers, then the picks by level with emergency first, then everything left out, each with its title, its link and its reason.';
    return ok({ ...result, note }, estimate);
  });

  // A pod with no AI service reads only when asked, so it is never shown as paused.
  const status = (s: PodStatus, extra: object = {}) =>
    ok({ ...s, ...(s.ai ? {} : { reading: 'when_asked', readingNote: newsOnlyLine }), ...(s.setup ? { setup: setupOut(s.setup) } : {}), digest: digestView(), ...extra }, estimate);
  tool('get_status', readOnly, async () => {
    const s = await services.reading.status();
    noteFacts(s);
    return status(s);
  });
  tool('set_reading', destructive, async ({ paused, everyMinutes, digestTimes, digestEveryMinutes }) => {
    let next: object = {};
    if (digestTimes !== undefined || digestEveryMinutes !== undefined) {
      const d = await changeDigest((d) => {
        const next: DigestSchedule = { times: digestTimes ? [...new Set(digestTimes)].sort() : d.times, lastAt: d.lastAt ?? new Date().toISOString() };
        const every = digestEveryMinutes === undefined ? d.everyMinutes : (digestEveryMinutes ?? undefined);
        return every ? { ...next, everyMinutes: every } : next;
      });
      const when = [...d.times, ...(d.everyMinutes ? [`every ${d.everyMinutes} minutes`] : [])];
      // Choosing a time is the person's go-ahead for the scheduled task.
      if (when.length) {
        const said = when.join(' and ');
        next = {
          next: `If you can schedule tasks, create one now that runs the daily_digest prompt ${d.times.length ? 'at' : ''} ${said}, then tell the person: "Your news will come ${d.times.length ? 'at ' : ''}${said}. If this app is closed then, it comes when you next open it.", naming the AI app they use in place of "this app". If you cannot schedule tasks, tell them how to set one up.`.replace(/\s+/g, ' '),
        };
      }
    }
    const change = { ...(paused === undefined ? {} : { paused }), ...(everyMinutes === undefined ? {} : { everyMinutes }) };
    return status(Object.keys(change).length ? await services.reading.set(change) : await services.reading.status(), next);
  });
  tool('digest_done', writes, async () => ok({ digest: await changeDigest((d) => ({ ...d, lastAt: new Date().toISOString() })) }, estimate));

  // The web plugin's data folder sits beside this one; its address and key files exist only while it runs.
  tool('open_news_site', readOnly, async () => {
    let url: string;
    try {
      url = siteLink(path.join(ctx.dataDir, '..', 'web'));
    } catch {
      return fail('site_off', 'The Mera News website is not running on this computer.', SITE_FIX);
    }
    return ok({ url, label: 'Open in Mera News', note: 'The link works once and for 10 minutes.' }, estimate);
  });

  for (const [name, p] of Object.entries(prompts)) {
    server.registerPrompt(name, { description: p.description }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text } }],
    }));
  }
  return server;
}

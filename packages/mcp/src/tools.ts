import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type ToolAnnotations } from '@modelcontextprotocol/server';
import path from 'node:path';
import type { JudgeResult, PickView, PluginContext, PodStatus, ProfileSetup, ProfileStory, ProfileView, StoriesSummary } from 'mera-news-pod/plugin-api';
import { z } from 'zod';
import { DIGEST_FILE, HINT_FILE, hintOf, isDue, lastMoment, MISSED_AFTER_MS, readJson, serially, TIME, writeJson, type DigestSchedule } from './digest';
import { siteLink } from './link';
import { badCursor, coded, decode, LIMIT_MAX, more, OLD_SERVER_NEXT, start } from './paging';
import { fail, fit, ok, within } from './reply';
import { descriptions, instructions, keepOrder, newsOnlyLine, prompts, showNext, showOf } from './text';

const statement = z.string().min(1).max(300);
const statements = z.array(z.union([statement, z.object({ statement, topics: z.array(z.string().trim().min(1).max(80)).min(1).max(12).optional() })])).min(1).max(10);
const ids = z.array(z.string().min(1)).min(1).max(20);
// A list tool cursor wraps the server's own, with the query for search.
const CURSOR_MAX = 2000;

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
    since: z.string().min(1).max(CURSOR_MAX).optional(),
    limit: z.number().int().min(1).max(LIMIT_MAX).default(10),
  }),
  search_news: z.object({
    query: z.string().trim().min(1).max(200),
    limit: z.number().int().min(1).max(LIMIT_MAX).default(20),
    after: z.string().min(1).max(CURSOR_MAX).optional(),
  }),
  latest_news: z.object({
    country: z.string().regex(/^[A-Z]{3}$/).optional(),
    limit: z.number().int().min(1).max(LIMIT_MAX).default(20),
    after: z.string().min(1).max(CURSOR_MAX).optional(),
  }),
  top_stories: z.object({
    country: z.string().regex(/^[A-Z]{3}$/).optional(),
    limit: z.number().int().min(1).max(LIMIT_MAX).default(20),
    after: z.string().min(1).max(CURSOR_MAX).optional(),
    story: z.string().min(1).max(100).optional(),
  }),
  news_for_profile: z.object({ after: z.string().min(1).max(CURSOR_MAX).optional(), limit: z.number().int().min(1).max(LIMIT_MAX).default(20) }),
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
      .max(500),
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
const pickOut = (p: PickView) => {
  const title = p.title.slice(0, 500);
  const publication = p.publication.slice(0, 200);
  return { id: p.id, title, publication, url: p.url, publishedAt: p.publishedAt, level: p.level, lang: p.lang, reason: p.reason.slice(0, 1000), facts: p.facts.slice(0, 10), show: showOf(title, p.url, publication) };
};

/** The next sentence every list reply ends with: how to show its stories, then any call for more. */
const nextOf = (ordered: boolean, ...then: (string | undefined)[]) => [ordered ? keepOrder : '', showNext, ...then].filter(Boolean).join(' ');
/** The paging fields of a reply with more, with next told how to show the stories first. */
const pagingOf = (ordered: boolean, paging: ReturnType<typeof more> | undefined, ...before: (string | undefined)[]) => ({
  ...(paging ? { nextCursor: paging.nextCursor, remaining: paging.remaining } : {}),
  next: nextOf(ordered, ...before, paging?.next),
});

// The paged queries keep the operation names the client allows; the old ones serve an older news server.
const SEARCH_PAGE = `query SearchNews($query: String!, $limit: Int, $after: String) { searchNewsPage(query: $query, limit: $limit, after: $after) { hits { _id } nextCursor } }`;
const SEARCH_NEWS = `query SearchNews($query: String!, $limit: Int) { searchNews(query: $query, limit: $limit) { _id } }`;
// The by-ids reply names the language and publisher differently from the country page.
const ARTICLES_BY_IDS = `query GetArticlesForTopicsByIds($articleIds: [ID!]!) { articlesForTopicsByIds(articleIds: $articleIds) { articles { _id title title_en article_url pubDate language_code publication_name } } }`;
const ARTICLE_FIELDS = `_id title title_en article_url pubDate original_language_code publicationSource { publication_name }`;
const LATEST = `query GetArticlesForCountry($countryCode: String, $first: Int, $after: String, $order: PublisherArticleOrder) { articlesForCountry(countryCode: $countryCode, first: $first, after: $after, order: $order) { articles { ${ARTICLE_FIELDS} } itemCursors pageInfo { endCursor hasNextPage } } }`;
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

const TOP_PAGE = `query GetTopHeadlinesForCountry($countryCode: String, $first: Int, $after: String) { topHeadlinesForCountry(countryCode: $countryCode, first: $first, after: $after) { headlines { clusterSize publisherCount cursor article { ${ARTICLE_FIELDS} } } pageInfo { endCursor hasNextPage } } }`;
const TOP_STORIES = `query GetTopHeadlinesForCountry($countryCode: String, $first: Int, $after: String) { topHeadlinesForCountry(countryCode: $countryCode, first: $first, after: $after) { headlines { clusterSize article { ${ARTICLE_FIELDS} } } pageInfo { endCursor hasNextPage } } }`;
const STORY_REPORTS = `query GetNewsClusterForArticle($articleId: ID!, $first: Int, $after: String) { newsClusterForArticle(articleId: $articleId) { clusterSize articles(first: $first, after: $after) { articles { ${ARTICLE_FIELDS} } pageInfo { endCursor hasNextPage } } } }`;
/** Reports listed per story in one reply, when the person asks for every publisher of a story. */
const REPORTS_PER_STORY = 25;

/**
 * Items asked for in one call: about what one reply holds, so a cut wastes little. Each is also
 * held to the server's own page limits (search 100, newest 50, ids 50, memberships 500); the pod's
 * story page (1000) is above it.
 */
const PER_REPLY = 100;
const SEARCH_MAX = 100;
const NEWEST_MAX = 50;
const BY_IDS_MAX = 50;
const MEMBERSHIPS_MAX = 500;
/** What an older pod takes: 50 stories a news_for_profile page, 50 verdicts a rate_stories call. */
const OLD_POD_MAX = 50;
// The older pod's own refusals of those caps, word for word: any other bad_input is the caller's to fix.
const OLD_POD_PAGE = 'limit must be a whole number from 0 to 50.';
const OLD_POD_VERDICTS = 'Pass 1 to 50 verdicts.';
const oldPodSays = (e: unknown, message: string) => saysCode(e) && e.code === 'bad_input' && e.message === message;
/** Refusals listed per code in a rate_stories reply, and codes listed, so 500 refusals still fit. */
const REFUSED_IDS = 10;
const REFUSED_CODES = 5;

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

/** One news query. The store's own error text never reaches the reply. */
const KEY_FIX =
  "ask the person to paste a Mera News key (they ask for one at https://mera.news/en/api-key) into the Mera News extension or plugin settings in their AI app, or to set News server address there to a news server they run (for a pod they run themselves: dataApiKey in secrets.json in the pod's folder), then start a new conversation; never ask them to paste the key in the chat";

const SITE_FIX =
  'tell the person they can turn on "Also run the Mera News website on this computer" in the Mera News extension or plugin settings of their AI app, then restart the app; a person who runs their own pod adds the web plugin to pod.json and restarts it';

type Graphql = (body: unknown) => Promise<unknown>;
/** The data, or the news server's error code (`NETWORK` when it could not be reached), so a caller can branch on it. */
type Answer<T> = { data: T; code?: undefined } | { data?: undefined; code: string };

async function ask<T>(graphql: Graphql, operationName: string, query: string, variables: object): Promise<Answer<T>> {
  let reply: { data?: T; errors?: { extensions?: { code?: string } }[] } | undefined;
  try {
    reply = (await graphql({ operationName, query, variables })) as typeof reply;
  } catch {
    return { code: 'NETWORK' };
  }
  if (reply?.errors?.length || !reply?.data) return { code: String(reply?.errors?.[0]?.extensions?.code ?? 'UNKNOWN') };
  return { data: reply.data };
}

/** The codes of a news server older than a field asked for: the tool remembers it and uses its old query. */
const OLD_SERVER = new Set(['GRAPHQL_VALIDATION_FAILED', 'NOT_IN_LOCAL_MODE', 'NOT_IMPLEMENTED']);

/** The data of an answer, or the error the tool answers with for its code. */
function need<T>(a: Answer<T>, tool: string, withCursor: boolean): T {
  if (a.code === undefined) return a.data;
  // A refused cursor: the data server says BAD_USER_INPUT, some servers in front of it BAD_REQUEST.
  if ((a.code === 'BAD_USER_INPUT' || a.code === 'BAD_REQUEST') && withCursor) throw badCursor(tool);
  if (a.code === 'EDITION_CHANGED') throw coded('edition_changed', 'The top stories were made again since that page.', `call ${tool} again without "after" for the new top stories; a story already shown can come again`);
  // The news server refuses a key inside an ordinary reply, so this is the one place that can name it.
  if (a.code === 'UNAUTHENTICATED') throw coded('key_refused', 'The Mera News key was refused.', KEY_FIX);
  throw coded('news_unavailable', 'The news server could not answer.', 'try again later; if it keeps failing, call get_status, which names what to fix');
}

/** A cursor made while the news server could page, used after it turned out not to. */
const cannotPage = (tool: string) => coded('cannot_page', 'This news server cannot give a next page.', `show the person what ${tool} gave so far; paging needs a newer news server`);

/** Said first in next when a top stories walk starts again because the edition was made again. */
const EDITION_RESTARTED = 'The top stories were made again since the last page, so this page starts again from the top, and a story already shown can come again.';

/**
 * The data server's search cursor (base64 JSON: asOf, from, offset) moved `back` hits earlier in the
 * same window, so a cut page goes on without starting a new window. Undefined for any other shape.
 * shortcut: reads the server's cursor shape; if it changes, a cut page falls back to reading its page again.
 */
function searchCursorBack(cursor: string, back: number): string | undefined {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
    if (typeof c?.asOf !== 'string' || typeof c?.from !== 'string' || !Number.isInteger(c.offset) || c.offset - back < 0) return undefined;
    return Buffer.from(JSON.stringify({ asOf: c.asOf, from: c.from, offset: c.offset - back })).toString('base64');
  } catch {
    return undefined;
  }
}

type NewsOut = ReturnType<typeof newsOut>[number] & { story?: string };

/**
 * Each article's story, from the news server's grouping (its most confident group). One call for
 * the whole page, before the cut. A server that does not group, or fails, gives none.
 */
async function storiesOf(graphql: Graphql, ids: string[]): Promise<Map<string, string>> {
  const storyOf = new Map<string, string>();
  if (ids.length < 2) return storyOf;
  type Rows = { clusterMembershipsForArticles: { articleId: string; clusters: { clusterId: string; stableClusterId?: string | null; confidence: number }[] }[] };
  const rows = (await ask<Rows>(graphql, 'ClusterMembershipsForArticles', CLUSTERS, { articleIds: ids.slice(0, MEMBERSHIPS_MAX) })).data?.clusterMembershipsForArticles;
  if (!Array.isArray(rows)) return storyOf;
  for (const row of rows) {
    const best = (row?.clusters ?? []).reduce<(typeof row.clusters)[number] | undefined>((a, c) => (!a || c.confidence > a.confidence ? c : a), undefined);
    if (best) storyOf.set(row.articleId, String(best.stableClusterId ?? best.clusterId).slice(0, 100));
  }
  return storyOf;
}

/**
 * Gives reports of one event in a reply the same `story`, and each result its show line. Only a story
 * with two or more reports in this reply is named: a story of one tells the reader nothing. Built for
 * the results kept, so the counts are this reply's.
 */
function withStories(results: NewsOut[], storyOf: Map<string, string>) {
  const size = new Map<string, number>();
  for (const r of results) if (storyOf.has(r.id)) size.set(storyOf.get(r.id)!, (size.get(storyOf.get(r.id)!) ?? 0) + 1);
  return results.map((r) => {
    const n = size.get(storyOf.get(r.id) ?? '') ?? 0;
    return { ...r, ...(n > 1 ? { story: storyOf.get(r.id)! } : {}), show: showOf(r.title, r.link, r.publisher, { reports: n, titleEn: r.title_en }) };
  });
}

/** A result with its place in the server's page, so a cut page continues right after the last one kept. */
type Row = { r: NewsOut; i: number };
const rowsOf = (articles: (NewsArticleIn | undefined)[]): Row[] => articles.flatMap((a, i) => (a ? newsOut(a).map((r) => ({ r, i })) : []));

// shortcut: each setup list is cut to 10 statements (one add_facts call) so a reply always fits; upgrade if people review more at once.
const setupOut = (s: ProfileSetup): ProfileSetup => ({ ...s, findingTopics: s.findingTopics.slice(0, 10), toReview: s.toReview.slice(0, 10), noTopics: s.noTopics.slice(0, 10) });
// Only setup.findingTopics: a pending fact in a pod with no AI service never gets topics on its own.
const stillFinding = (p: ProfileView) => p.setup.findingTopics.length > 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A page of news_for_profile: the run's summary numbers, the stories still to judge grouped by fact,
 * and the stories judged before with their verdicts. Only the named fields leave. The summary's
 * topic and fact lists are the same on every page, so only the first page carries them.
 */
function profileNews(page: { summary: StoriesSummary; stories: ProfileStory[]; shownBefore: number }, first: boolean, paging?: ReturnType<typeof more>) {
  const head = (s: ProfileStory) => ({ id: s.id, title: s.title, ...(s.titleEn ? { title_en: s.titleEn } : {}), link: s.link, publisher: s.publisher, reports: s.reports, show: showOf(s.title, s.link, s.publisher, { reports: s.reports, titleEn: s.titleEn }) });
  const toJudge = new Map<string, { factId: string; fact: string; stories: object[] }>();
  const picked: object[] = [];
  const leftOut: object[] = [];
  for (const s of page.stories) {
    const facts = s.facts.map((f) => f.statement);
    if (!s.verdict) {
      const f = s.facts[0] ?? { id: '', statement: '' };
      if (!toJudge.has(f.id)) toJudge.set(f.id, { factId: f.id, fact: f.statement, stories: [] });
      toJudge.get(f.id)!.stories.push({ ...head(s), publishedAt: s.publishedAt, language: s.language, ...(facts.length > 1 ? { alsoFacts: facts.slice(1) } : {}) });
    } else if (s.verdict.verdict === 'picked') picked.push({ ...head(s), level: s.verdict.level, reason: s.verdict.reason, facts });
    else leftOut.push({ ...head(s), reason: s.verdict.reason, facts });
  }
  const { topics, facts, ...light } = page.summary;
  const summary = first ? page.summary : light;
  const next = paging
    ? `Read every page before you pick or answer. ${showNext} ${paging.next}`
    : page.summary.unjudged > 0
      ? `This is the last page. Judge every story in toJudge, on every page, with rate_stories: picked, with a level and one sentence on why it matters to the person, or left_out, with one short reason. Then show the summary numbers, the picks by level with emergency first, and everything left out, each by its show line with its reason. ${showNext}`
      : `This is the last page, and every story is judged. Show the summary numbers, the picks by level with emergency first, and everything left out, each by its show line with its reason. ${showNext}`;
  return {
    summary,
    toJudge: [...toJudge.values()],
    picked,
    leftOut,
    ...(paging ? { nextCursor: paging.nextCursor, remaining: paging.remaining } : {}),
    ...(page.shownBefore ? { shownBefore: page.shownBefore } : {}),
    next,
  };
}

/** Room left in a reply for its state, hint, cursor and the like. */
const ENVELOPE_TOKENS = 400;

const saysCode = (e: unknown): e is { code: string; message: string; next: string } =>
  e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { next?: unknown }).next === 'string';

/** The pod's own suggestions cursor (epoch and sequence). */
const POD_CURSOR = /^[0-9a-f]+\.\d+$/;

/**
 * `old` holds the tools whose paged query this news server refused as unknown: kept by the plugin for
 * the life of the process, since a server is built per request.
 */
export function buildServer(ctx: McpContext, old: Set<string> = new Set()): McpServer {
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
    // `since` is 'all', a cursor of the pod's own, or this tool's cursor carrying the rest of the limit.
    const ours = since !== undefined && since !== 'all' && !POD_CURSOR.test(since);
    const p = ours ? decode('get_suggestions', '', since, 'since') : start('get_suggestions', '', limit);
    const pass = ours ? (p.c ?? undefined) : since;
    // The services cut the page until it fits and count only the picks returned as delivered.
    const fits = (picks: PickView[]) => within(JSON.stringify(picks.map(pickOut)), estimate, ENVELOPE_TOKENS);
    const got = await services.suggestions.get({ ...(pass ? { since: pass } : {}), limit: Math.min(p.r, PER_REPLY), fits });
    const r = p.r - got.picks.length;
    return ok({ ...got, picks: got.picks.map(pickOut), ...pagingOf(false, got.more && r > 0 ? more('get_suggestions', {}, 'since', { ...p, c: got.cursor, r }) : undefined) }, estimate);
  });

  // A page of news results cut to the target; `tail` adds the paging fields for what was kept, so they
  // are measured too. `reask` gives the real cursor of a cut page after the cut, when only a second
  // call can (an older news server); the measured reply uses the page's own cursor in its place.
  const newsPage = async (rows: Row[], storyOf: Map<string, string>, tail: (kept: Row[], cut: boolean, c?: string) => object, reask?: (kept: Row[]) => Promise<string | undefined>) => {
    const make = (k: Row[], cut: boolean, c?: string) => ({ results: withStories(k.map((x) => x.r), storyOf), ...(cut ? { truncated: true } : {}), ...tail(k, cut, c) });
    const { kept, cut } = fit(rows, (k, c) => make(k, c), estimate);
    return ok(make(kept, cut, cut && reask && kept.length ? await reask(kept) : undefined), estimate);
  };
  const graphql: Graphql = (body) => services.news.graphql(body);

  const hydrate = async (ids: string[]) => {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += BY_IDS_MAX) chunks.push(ids.slice(i, i + BY_IDS_MAX));
    type ByIds = { articlesForTopicsByIds: { articles: NewsArticleIn[] } };
    const got = await Promise.all(chunks.map((articleIds) => ask<ByIds>(graphql, 'GetArticlesForTopicsByIds', ARTICLES_BY_IDS, { articleIds })));
    const byId = new Map(got.flatMap((a) => need(a, 'search_news', false).articlesForTopicsByIds.articles.map((x) => [x._id, x] as const)));
    return (wanted: string[]) => rowsOf(wanted.map((id) => byId.get(id)));
  };

  // Search ranks a live store, so paging is best effort: the cursor holds the server's page and how many of its hits were shown.
  tool('search_news', readOnly, async ({ query, limit, after }) => {
    const p = after ? decode('search_news', query, after) : start('search_news', query, limit);
    if (!old.has('search_news')) {
      const size = p.m ?? Math.min(p.r, PER_REPLY, SEARCH_MAX);
      type Hits = { searchNewsPage: { hits: { _id: string }[]; nextCursor?: string | null } };
      const a = await ask<Hits>(graphql, 'SearchNews', SEARCH_PAGE, { query, limit: size, after: p.c });
      if (!OLD_SERVER.has(a.code ?? '')) {
        const page = need(a, 'search_news', !!after).searchNewsPage;
        const skip = p.s ?? 0;
        const wanted = page.hits.slice(skip).map((h) => h._id);
        const rows = (await hydrate(wanted))(wanted).slice(0, p.r);
        const storyOf = await storiesOf(graphql, rows.map((x) => x.r.id));
        return newsPage(rows, storyOf, (k, cut) => {
          const r = p.r - k.length;
          if (r <= 0 || (cut && !k.length)) return pagingOf(true, undefined);
          if (!cut) return pagingOf(true, page.nextCursor ? more('search_news', { query }, 'after', { t: p.t, k: p.k, c: page.nextCursor, r, n: p.n }) : undefined);
          // A cut page goes on right after its last hit shown, in the window the server froze into its cursor.
          const at = skip + k.at(-1)!.i + 1;
          const pinned = page.nextCursor ? searchCursorBack(page.nextCursor, page.hits.length - at) : undefined;
          return pagingOf(true, more('search_news', { query }, 'after', pinned ? { t: p.t, k: p.k, c: pinned, r, n: p.n } : { ...p, r, s: at, m: size }));
        });
      }
      old.add('search_news');
    }
    if (after) throw cannotPage('search_news');
    const size = Math.min(limit, 25);
    const hits = need(await ask<{ searchNews: { _id: string }[] }>(graphql, 'SearchNews', SEARCH_NEWS, { query, limit: size }), 'search_news', false);
    const wanted = hits.searchNews.map((h) => h._id);
    const rows = (await hydrate(wanted))(wanted);
    // An older search server: its first page only, saying so when it holds more than was shown.
    const full = wanted.length >= size;
    return newsPage(rows, await storiesOf(graphql, rows.map((x) => x.r.id)), (k, cut) => ({ next: nextOf(true, limit > k.length && (full || cut) ? OLD_SERVER_NEXT : undefined) }));
  });

  type Articles = { articles: NewsArticleIn[]; itemCursors?: string[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } };
  tool('latest_news', readOnly, async ({ country, limit, after }) => {
    const p = after ? decode('latest_news', country ?? '', after) : start('latest_news', country ?? '', limit);
    const args = country ? { country } : {};
    const first = Math.min(p.r, PER_REPLY, NEWEST_MAX);
    const get = (query: string, first: number) =>
      ask<{ articlesForCountry: Articles }>(graphql, 'GetArticlesForCountry', query, { countryCode: country ?? null, first, after: p.c, ...(query === LATEST ? { order: 'NEWEST' } : {}) });
    let a = old.has('latest_news') ? undefined : await get(LATEST, first);
    if (a && OLD_SERVER.has(a.code ?? '')) (old.add('latest_news'), (a = undefined));
    // An older news server pages by its page-end cursor, so a cut page is asked again for only the articles kept.
    const older = !a;
    const page = need(a ?? (await get(ARTICLES_FOR_COUNTRY, first)), 'latest_news', !!after).articlesForCountry;
    const rows = rowsOf(page.articles).slice(0, p.r);
    const storyOf = await storiesOf(graphql, rows.map((x) => x.r.id));
    const end = page.pageInfo.endCursor ?? undefined;
    return newsPage(
      rows,
      storyOf,
      (k, cut, again) => {
        const r = p.r - k.length;
        // A cut page goes on from its last kept article's own cursor; a whole one from the page's end.
        const c = cut ? (older ? (again ?? end) : k.length ? page.itemCursors?.[k.at(-1)!.i] : undefined) : page.pageInfo.hasNextPage ? end : undefined;
        return pagingOf(true, r > 0 && c ? more('latest_news', args, 'after', { ...p, c, r }) : undefined);
      },
      older ? async (k) => need(await get(ARTICLES_FOR_COUNTRY, k.at(-1)!.i + 1), 'latest_news', !!after).articlesForCountry.pageInfo.endCursor ?? undefined : undefined,
    );
  });

  type ReportsPage = { newsClusterForArticle: { clusterSize?: number | null; articles: { articles: NewsArticleIn[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } } | null };
  type Headline = { clusterSize?: number | null; publisherCount?: number | null; cursor?: string | null; article: NewsArticleIn };
  type Headlines = { topHeadlinesForCountry: { headlines: Headline[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } };
  // A list item: the lead report only, with how many reports and publishers the story has. A
  // publisherCount of 0 (an edition built before publishers were counted) is not known.
  const storyOut = (h: Headline) =>
    newsOut(h.article).map(({ language: _, ...lead }) => {
      const reportCount = Math.max(h.clusterSize ?? 1, 1);
      const publisherCount = typeof h.publisherCount === 'number' && h.publisherCount > 0 ? h.publisherCount : undefined;
      return { ...lead, reportCount, ...(publisherCount ? { publisherCount } : {}), show: showOf(lead.title, lead.link, lead.publisher, { publishers: publisherCount, reports: reportCount, titleEn: lead.title_en }) };
    });
  type StoryOut = ReturnType<typeof storyOut>[number];

  tool('top_stories', readOnly, async ({ country, limit, after, story }) => {
    if (story) {
      // Every publisher of one story: a report is where it was published, with its headline, link and language.
      const p = after ? decode('top_stories', `story:${story}`, after) : start('top_stories', `story:${story}`, limit);
      const get = (first: number) => ask<ReportsPage>(graphql, 'GetNewsClusterForArticle', STORY_REPORTS, { articleId: story, first, after: p.c });
      const got = need(await get(Math.min(p.r, REPORTS_PER_STORY)), 'top_stories', !!after).newsClusterForArticle;
      const rows = rowsOf(got?.articles.articles ?? []);
      const reports = rows.map(({ r }) => ({ title: r.title, publisher: r.publisher, link: r.link, language: r.language, show: showOf(r.title, r.link, r.publisher, { titleEn: r.title_en }) }));
      const pi = got?.articles.pageInfo;
      // The server's cursor ends its whole page, so a cut page is asked again for only the reports kept.
      const make = (k: typeof reports, cut: boolean, c = pi?.endCursor ?? undefined) => {
        const r = p.r - k.length;
        const go = r > 0 && c && (cut || pi?.hasNextPage) ? more('top_stories', { story }, 'after', { ...p, c, r }) : undefined;
        return { story, reportCount: got?.clusterSize ?? reports.length, reports: k, ...(cut ? { truncated: true } : {}), ...pagingOf(false, go) };
      };
      const { kept, cut } = fit(reports, make, estimate);
      const again = cut && kept.length ? (need(await get(rows[kept.length - 1].i + 1), 'top_stories', !!after).newsClusterForArticle?.articles.pageInfo.endCursor ?? undefined) : undefined;
      return ok(make(kept, cut, cut ? again : undefined), estimate);
    }
    let p = after ? decode('top_stories', country ?? '', after) : start('top_stories', country ?? '', limit);
    const args = country ? { country } : {};
    const reply = (k: { s: StoryOut }[], cut: boolean, tail: object) => ({
      scope: country ?? 'world',
      windowHours: 24,
      summary: { stories: k.length, reports: k.reduce((n, x) => n + x.s.reportCount, 0) },
      stories: k.map((x) => x.s),
      ...(cut ? { truncated: true } : {}),
      ...tail,
    });
    const rowsFrom = (headlines: Headline[]) => headlines.flatMap((h, i) => storyOut(h).map((s) => ({ s, i })));
    const get = (query: string, first: number) => ask<Headlines>(graphql, 'GetTopHeadlinesForCountry', query, { countryCode: country ?? null, first, after: p.c });
    let a = old.has('top_stories') ? undefined : await get(TOP_PAGE, Math.min(p.r, PER_REPLY));
    // A headline's own cursor names its edition: when the edition was made again since, the list starts again from the top.
    let restarted: string | undefined;
    if (a?.code === 'EDITION_CHANGED' && p.c) {
      p = { ...p, c: null };
      restarted = EDITION_RESTARTED;
      a = await get(TOP_PAGE, Math.min(p.r, PER_REPLY));
    }
    if (a && OLD_SERVER.has(a.code ?? '')) (old.add('top_stories'), (a = undefined));
    // An older news server pages by its page-end cursor, so a cut page is asked again for only the headlines kept.
    const older = !a;
    const page = need(a ?? (await get(TOP_STORIES, Math.min(p.r, PER_REPLY))), 'top_stories', !!after).topHeadlinesForCountry;
    const rows = rowsFrom(page.headlines).slice(0, p.r);
    const end = page.pageInfo.endCursor ?? undefined;
    const tail = (k: typeof rows, cut: boolean, again?: string) => {
      const r = p.r - k.length;
      // Every page goes on from its last headline's own cursor, which carries the edition; an older server's from its page end.
      const c = older ? (cut ? (again ?? end) : page.pageInfo.hasNextPage ? end : undefined) : cut ? (k.length ? page.headlines[k.at(-1)!.i].cursor : undefined) : page.pageInfo.hasNextPage ? (page.headlines.at(-1)?.cursor ?? end) : undefined;
      return pagingOf(true, r > 0 && c ? more('top_stories', args, 'after', { ...p, c, r }) : undefined, restarted);
    };
    const { kept, cut } = fit(rows, (k, c) => reply(k, c, tail(k, c)), estimate);
    const again = older && cut && kept.length ? (need(await get(TOP_STORIES, kept.at(-1)!.i + 1), 'top_stories', !!after).topHeadlinesForCountry.pageInfo.endCursor ?? undefined) : undefined;
    return ok(reply(kept, cut, tail(kept, cut, again)), estimate);
  });

  // Not read-only: the unjudged stories it returns are recorded, and wait 72 hours before a later run returns them.
  tool('news_for_profile', writes, async ({ after, limit }) => {
    const p = after ? decode('news_for_profile', '', after) : start('news_for_profile', '', limit);
    const first = !after;
    const read = (limit: number) =>
      services.stories.forProfile({
        ...(p.c ? { after: p.c } : {}),
        limit,
        // The services cut the page until the whole reply fits, and record only the stories returned.
        fits: (stories, summary) => within(JSON.stringify(profileNews({ summary, stories, shownBefore: 0 }, first)), estimate, ENVELOPE_TOKENS),
      });
    const most = old.has('news_for_profile') ? OLD_POD_MAX : PER_REPLY;
    const page = await read(Math.min(p.r, most)).catch((e) => {
      // An older pod takes pages of up to 50: ask it for that, and keep to it for the life of the process.
      if (!(oldPodSays(e, OLD_POD_PAGE) && Math.min(p.r, most) > OLD_POD_MAX)) throw e;
      old.add('news_for_profile');
      return read(OLD_POD_MAX);
    });
    const r = p.r - page.stories.length;
    return ok(profileNews(page, first, page.nextCursor && r > 0 ? more('news_for_profile', {}, 'after', { ...p, c: page.nextCursor, r }) : undefined), estimate);
  });

  tool('rate_stories', writes, async ({ stories }) => {
    const result = await services.stories.judge(stories).catch(async (e) => {
      // An older pod takes 50 verdicts a call. A verdict saved twice keeps its first, so a retry is safe.
      if (!(oldPodSays(e, OLD_POD_VERDICTS) && stories.length > OLD_POD_MAX)) throw e;
      const parts: JudgeResult[] = [];
      for (let i = 0; i < stories.length; i += OLD_POD_MAX) parts.push(await services.stories.judge(stories.slice(i, i + OLD_POD_MAX)));
      return { saved: parts.flatMap((x) => x.saved), already: parts.flatMap((x) => x.already), refused: parts.flatMap((x) => x.refused) };
    });
    // Counts, and per refusal code its first ids and one message: 500 verdicts with every id and message would not fit a reply.
    const byCode = new Map<string, { code: string; count: number; ids: string[]; message: string }>();
    for (const x of result.refused) {
      const g = byCode.get(x.code) ?? byCode.set(x.code, { code: String(x.code).slice(0, 40), count: 0, ids: [], message: String(x.message ?? '').slice(0, 300) }).get(x.code)!;
      g.count++;
      if (g.ids.length < REFUSED_IDS) g.ids.push(String(x.id).slice(0, 100));
    }
    const refused = [...byCode.values()].slice(0, REFUSED_CODES);
    const note = [
      byCode.has('reason_not_grounded')
        ? 'Some picks were not saved: their reason shares no word with the headline. Call rate_stories again for those with a reason that names something the headline says.'
        : `Saved. Each story keeps this verdict, so it is never judged again. When every story is judged, show the person the summary numbers, then the picks by level with emergency first, then everything left out, each by its show line with its reason. ${showNext}`,
      byCode.has('not_available') ? 'Stories refused as not_available were muted or already read: show them as left out and do not rate them again.' : '',
      result.refused.length > refused.reduce((n, g) => n + g.ids.length, 0) ? `refused gives each code's count and only its first ${REFUSED_IDS} ids.` : '',
    ].filter(Boolean).join(' ');
    return ok({ saved: result.saved.length, already: result.already.length, refused, note }, estimate);
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

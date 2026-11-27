import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type ToolAnnotations } from '@modelcontextprotocol/server';
import path from 'node:path';
import type { PickView, PluginContext, PodStatus, ProfileSetup, ProfileStory, ProfileView, StoriesSummary } from 'mera-news-pod/plugin-api';
import { z } from 'zod';
import { DIGEST_FILE, HINT_FILE, hintOf, isDue, lastMoment, MISSED_AFTER_MS, readJson, serially, TIME, writeJson, type DigestSchedule } from './digest';
import { CARD_MIME, CARD_TOOLS, CARD_URI, cardHtml } from './card';
import { siteLink } from './link';
import { badCursor, coded, decode, LIMIT_MAX, more, OLD_SERVER_NEXT, start } from './paging';
import { fail, fit, ok, within } from './reply';
import { descriptions, instructions, newsOnlyLine, prompts, showAsGiven } from './text';

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
  if (a.code === 'BAD_USER_INPUT' && withCursor) throw badCursor(tool);
  if (a.code === 'EDITION_CHANGED') throw coded('edition_changed', 'The top stories were made again since that page.', `call ${tool} again without "after" for the new top stories; a story already shown can come again`);
  // The news server refuses a key inside an ordinary reply, so this is the one place that can name it.
  if (a.code === 'UNAUTHENTICATED') throw coded('key_refused', 'The Mera News key was refused.', KEY_FIX);
  throw coded('news_unavailable', 'The news server could not answer.', 'try again later; if it keeps failing, call get_status, which names what to fix');
}

/** A cursor made while the news server could page, used after it turned out not to. */
const cannotPage = (tool: string) => coded('cannot_page', 'This news server cannot give a next page.', `show the person what ${tool} gave so far; paging needs a newer news server`);

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

/** Gives reports of one event in a reply the same `story`. Only a story with two or more reports in this reply is named: a story of one tells the reader nothing. */
function withStories(results: NewsOut[], storyOf: Map<string, string>): NewsOut[] {
  const size = new Map<string, number>();
  for (const r of results) if (storyOf.has(r.id)) size.set(storyOf.get(r.id)!, (size.get(storyOf.get(r.id)!) ?? 0) + 1);
  return results.map((r) => (size.get(storyOf.get(r.id) ?? '')! > 1 ? { ...r, story: storyOf.get(r.id)! } : r));
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
  const { topics, facts, ...light } = page.summary;
  const summary = first ? page.summary : light;
  const next = paging
    ? `Read every page before you pick or answer. ${paging.next}`
    : page.summary.unjudged > 0
      ? 'This is the last page. Judge every story in toJudge, on every page, with rate_stories: picked, with a level and one sentence on why it matters to the person, or left_out, with one short reason. Then show the summary numbers, the picks by level with emergency first, and everything left out, each with its title, its publisher, its link and its reason.'
      : 'This is the last page, and every story is judged. Show the summary numbers, the picks by level with emergency first, and everything left out, each with its title, its publisher, its link and its reason.';
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
  server.registerResource('news-card', CARD_URI, { title: 'Mera News stories', mimeType: CARD_MIME }, () => ({
    contents: [{ uri: CARD_URI, mimeType: CARD_MIME, text: cardHtml, _meta: { ui: { prefersBorder: false } } }],
  }));

  function tool<K extends keyof typeof schemas>(
    name: K,
    annotations: ToolAnnotations,
    run: (input: z.output<(typeof schemas)[K]>) => Promise<CallToolResult>,
  ) {
    // A tool in CARD_TOOLS names the news card, which apps that draw MCP Apps show under the reply.
    const _meta = CARD_TOOLS.has(name) ? { ui: { resourceUri: CARD_URI } } : undefined;
    server.registerTool(name, { description: descriptions[name], inputSchema: advertise(schemas[name]), annotations, ...(_meta ? { _meta } : {}) }, async (raw: unknown) => {
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
    return ok({ ...got, picks: got.picks.map(pickOut), ...(got.more && r > 0 ? more('get_suggestions', {}, 'since', { ...p, c: got.cursor, r }) : {}) }, estimate);
  });

  // A page of news results cut to the target; `tail` adds the paging fields for what was kept, so they are measured too.
  const newsPage = (rows: Row[], storyOf: Map<string, string>, tail: (kept: Row[], cut: boolean) => object) => {
    const make = (k: Row[], cut: boolean) => ({ results: withStories(k.map((x) => x.r), storyOf), ...(cut ? { truncated: true } : {}), ...tail(k, cut) });
    const { kept, cut } = fit(rows, make, estimate);
    return ok(make(kept, cut), estimate);
  };
  // An older news server: its first page only, saying so when it holds more than was shown.
  const firstOnly = (asked: number, more: boolean) => (k: Row[], cut: boolean) => (asked > k.length && (more || cut) ? { next: OLD_SERVER_NEXT } : {});
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
          if (r <= 0) return {};
          if (cut) return k.length ? more('search_news', { query }, 'after', { ...p, r, s: skip + k.at(-1)!.i + 1, m: size }) : {};
          return page.nextCursor ? more('search_news', { query }, 'after', { t: p.t, k: p.k, c: page.nextCursor, r, n: p.n }) : {};
        });
      }
      old.add('search_news');
    }
    if (after) throw cannotPage('search_news');
    const size = Math.min(limit, 25);
    const hits = need(await ask<{ searchNews: { _id: string }[] }>(graphql, 'SearchNews', SEARCH_NEWS, { query, limit: size }), 'search_news', false);
    const wanted = hits.searchNews.map((h) => h._id);
    const rows = (await hydrate(wanted))(wanted);
    return newsPage(rows, await storiesOf(graphql, rows.map((x) => x.r.id)), firstOnly(limit, wanted.length >= size));
  });

  tool('latest_news', readOnly, async ({ country, limit, after }) => {
    const p = after ? decode('latest_news', country ?? '', after) : start('latest_news', country ?? '', limit);
    const args = country ? { country } : {};
    type Articles = { articles: NewsArticleIn[]; itemCursors?: string[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } };
    if (!old.has('latest_news')) {
      const a = await ask<{ articlesForCountry: Articles }>(graphql, 'GetArticlesForCountry', LATEST, { countryCode: country ?? null, first: Math.min(p.r, PER_REPLY, NEWEST_MAX), after: p.c, order: 'NEWEST' });
      if (!OLD_SERVER.has(a.code ?? '')) {
        const page = need(a, 'latest_news', !!after).articlesForCountry;
        const rows = rowsOf(page.articles).slice(0, p.r);
        const storyOf = await storiesOf(graphql, rows.map((x) => x.r.id));
        return newsPage(rows, storyOf, (k, cut) => {
          const r = p.r - k.length;
          // A cut page goes on from its last kept article's own cursor; a whole one from the page's end.
          const c = cut ? (k.length ? page.itemCursors?.[k.at(-1)!.i] : undefined) : page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
          return r > 0 && c ? more('latest_news', args, 'after', { ...p, c, r }) : {};
        });
      }
      old.add('latest_news');
    }
    if (after) throw cannotPage('latest_news');
    const a = await ask<{ articlesForCountry: Articles }>(graphql, 'GetArticlesForCountry', ARTICLES_FOR_COUNTRY, { countryCode: country ?? null, first: Math.min(limit, NEWEST_MAX), after: null });
    const page = need(a, 'latest_news', false).articlesForCountry;
    const rows = rowsOf(page.articles);
    return newsPage(rows, await storiesOf(graphql, rows.map((x) => x.r.id)), firstOnly(limit, page.pageInfo.hasNextPage));
  });

  type ReportsPage = { newsClusterForArticle: { clusterSize?: number | null; articles: { articles: NewsArticleIn[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } } | null };
  type Headline = { clusterSize?: number | null; publisherCount?: number | null; cursor?: string | null; article: NewsArticleIn };
  type Headlines = { topHeadlinesForCountry: { headlines: Headline[]; pageInfo: { endCursor?: string | null; hasNextPage: boolean } } };
  // A list item: the lead report only, with how many reports and publishers the story has.
  const storyOut = (h: Headline) =>
    newsOut(h.article).map(({ language: _, ...lead }) => ({
      ...lead,
      reportCount: Math.max(h.clusterSize ?? 1, 1),
      ...(typeof h.publisherCount === 'number' ? { publisherCount: Math.max(h.publisherCount, 1) } : {}),
    }));
  type StoryOut = ReturnType<typeof storyOut>[number];

  tool('top_stories', readOnly, async ({ country, limit, after, story }) => {
    if (story) {
      // Every publisher of one story: a report is where it was published, with its link and language.
      const got = need(await ask<ReportsPage>(graphql, 'GetNewsClusterForArticle', STORY_REPORTS, { articleId: story, first: REPORTS_PER_STORY, after: after ?? null }), 'top_stories', !!after).newsClusterForArticle;
      const reports = (got?.articles.articles ?? []).flatMap(newsOut).map((r) => ({ publisher: r.publisher, link: r.link, language: r.language }));
      const pi = got?.articles.pageInfo;
      return ok({ story, reportCount: got?.clusterSize ?? reports.length, reports, ...(pi?.hasNextPage && pi.endCursor ? { nextCursor: pi.endCursor } : {}) }, estimate);
    }
    const p = after ? decode('top_stories', country ?? '', after) : start('top_stories', country ?? '', limit);
    const args = country ? { country } : {};
    const scope = { scope: country ?? 'world', windowHours: 24, show: showAsGiven };
    const reply = (k: { s: StoryOut }[], cut: boolean, tail: object) => ({
      ...scope,
      summary: { stories: k.length, reports: k.reduce((n, x) => n + x.s.reportCount, 0) },
      stories: k.map((x) => x.s),
      ...(cut ? { truncated: true } : {}),
      ...tail,
    });
    const rowsFrom = (headlines: Headline[]) => headlines.flatMap((h, i) => storyOut(h).map((s) => ({ s, i })));
    if (!old.has('top_stories')) {
      const a = await ask<Headlines>(graphql, 'GetTopHeadlinesForCountry', TOP_PAGE, { countryCode: country ?? null, first: Math.min(p.r, PER_REPLY), after: p.c });
      if (!OLD_SERVER.has(a.code ?? '')) {
        const page = need(a, 'top_stories', !!after).topHeadlinesForCountry;
        const rows = rowsFrom(page.headlines).slice(0, p.r);
        const tail = (k: typeof rows, cut: boolean) => {
          const r = p.r - k.length;
          // A cut page goes on from its last kept headline's own cursor; a whole one from the page's end.
          const c = cut ? (k.length ? page.headlines[k.at(-1)!.i].cursor : undefined) : page.pageInfo.hasNextPage ? page.pageInfo.endCursor : undefined;
          return r > 0 && c ? more('top_stories', args, 'after', { ...p, c, r }) : {};
        };
        const { kept, cut } = fit(rows, (k, c) => reply(k, c, tail(k, c)), estimate);
        return ok(reply(kept, cut, tail(kept, cut)), estimate);
      }
      old.add('top_stories');
    }
    if (after) throw cannotPage('top_stories');
    const a = await ask<Headlines>(graphql, 'GetTopHeadlinesForCountry', TOP_STORIES, { countryCode: country ?? null, first: Math.min(limit, PER_REPLY), after: null });
    const page = need(a, 'top_stories', false).topHeadlinesForCountry;
    const rows = rowsFrom(page.headlines);
    const tail = (k: typeof rows, cut: boolean) => (limit > k.length && (cut || page.pageInfo.hasNextPage) ? { next: OLD_SERVER_NEXT } : {});
    const { kept, cut } = fit(rows, (k, c) => reply(k, c, tail(k, c)), estimate);
    return ok(reply(kept, cut, tail(kept, cut)), estimate);
  });

  // Not read-only: the unjudged stories it returns are recorded, and wait 72 hours before a later run returns them.
  tool('news_for_profile', writes, async ({ after, limit }) => {
    const p = after ? decode('news_for_profile', '', after) : start('news_for_profile', '', limit);
    const first = !after;
    const page = await services.stories.forProfile({
      ...(p.c ? { after: p.c } : {}),
      limit: Math.min(p.r, PER_REPLY),
      // The services cut the page until the whole reply fits, and record only the stories returned.
      fits: (stories, summary) => within(JSON.stringify(profileNews({ summary, stories, shownBefore: 0 }, first)), estimate, ENVELOPE_TOKENS),
    });
    const r = p.r - page.stories.length;
    return ok(profileNews(page, first, page.nextCursor && r > 0 ? more('news_for_profile', {}, 'after', { ...p, c: page.nextCursor, r }) : undefined), estimate);
  });

  tool('rate_stories', writes, async ({ stories }) => {
    const result = await services.stories.judge(stories);
    const grounded = result.refused.filter((r) => r.code === 'reason_not_grounded');
    const gone = result.refused.some((r) => r.code === 'not_available') ? 'Stories refused as not_available were muted or already read: show them as left out and do not rate them again.' : '';
    const note = [
      grounded.length
        ? 'Some picks were not saved: their reason shares no word with the headline. Call rate_stories again for those with a reason that names something the headline says.'
        : 'Saved. Each story keeps this verdict, so it is never judged again. When every story is judged, show the person the summary numbers, then the picks by level with emergency first, then everything left out, each with its title, its publisher, its link and its reason.',
      gone,
    ].filter(Boolean).join(' ');
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

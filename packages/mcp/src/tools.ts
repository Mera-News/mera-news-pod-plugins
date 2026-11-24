import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type ToolAnnotations } from '@modelcontextprotocol/server';
import path from 'node:path';
import type { FactView, PickView, PluginContext, PodStatus } from 'mera-news-pod/plugin-api';
import { z } from 'zod';
import { DIGEST_FILE, HINT_FILE, isDue, readJson, serially, TIME, writeJson, type DigestSchedule } from './digest';
import { fail, fit, ok, TARGET_TOKENS } from './reply';
import { descriptions, instructions, prompts } from './text';

const statement = z.string().min(1).max(300);
const statements = z.array(z.union([statement, z.object({ statement, topics: z.array(z.string().trim().min(1).max(80)).min(1).max(12).optional() })])).min(1).max(10);
const ids = z.array(z.string().min(1)).min(1).max(20);

const schemas = {
  get_profile: z.object({ offset: z.number().int().min(0).optional() }),
  add_facts: z.object({ statements }),
  remove_facts: z.object({ ids }),
  edit_topics: z.object({
    remove: z.array(z.string().min(1)).optional(),
    weight: z.array(z.object({ topicId: z.string().min(1), weight: z.number().min(-1).max(1) })).optional(),
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
  news_for_profile: z.object({ limit: z.number().int().min(1).max(25).default(15) }),
  get_status: z.object({}),
  set_reading: z.object({
    paused: z.boolean().optional(),
    everyMinutes: z.number().int().min(5).max(1440).optional(),
    digestTimes: z.array(z.string().regex(TIME)).max(48).optional(),
    digestEveryMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  }),
  digest_done: z.object({}),
};

/** The version 2 context: add_facts needs `profile.addTopics`. */
export type McpContext = Extract<PluginContext, { podApi: 2 }>;

const PERSONA = `query GetArticleIdsForPersona($query: PersonaQueryInput!) { articleIdsForPersona(query: $query) { topicResults { topicText articleIds hasNextPage nextCursor } } }`;
/** Ids asked for per topic, and how many more pages news_for_profile may ask for topics it showed in full. */
const PER_TOPIC = 20;
const MORE_PAGES = 5;
/** Stories news_for_profile showed are not shown again for this long. */
const SHOWN_FOR_MS = 72 * 3600_000;


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
async function ask<T>(graphql: (body: unknown) => Promise<unknown>, operationName: string, query: string, variables: object): Promise<T> {
  let reply: { data?: T; errors?: { extensions?: { code?: string } }[] };
  try {
    reply = (await graphql({ operationName, query, variables })) as typeof reply;
  } catch {
    reply = { errors: [{}] };
  }
  if (reply.errors?.length || !reply.data) {
    if (reply.errors?.[0]?.extensions?.code === 'BAD_USER_INPUT') throw new NewsError('bad_input', 'The field "after" is not valid for latest_news.', 'call latest_news again without "after"');
    throw new NewsError('news_unavailable', 'The news server could not answer.', 'try again later, and if it keeps failing ask the person to run node build/cli.js check in the mera-news-pod folder');
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

/** Room left in a reply for its state, hint, cursor and the like. */
const ENVELOPE_TOKENS = 400;

const saysCode = (e: unknown): e is { code: string; message: string; next: string } =>
  e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { next?: unknown }).next === 'string';

export function buildServer(ctx: McpContext): McpServer {
  const { services, estimateTokens: estimate } = ctx;
  const digestFile = path.join(ctx.dataDir, DIGEST_FILE);
  const shownFile = path.join(ctx.dataDir, 'delivered.json');
  const digestView = (d = readJson<DigestSchedule>(digestFile)) => {
    const times = Array.isArray(d?.times) ? d.times : [];
    return { times, everyMinutes: d?.everyMinutes ?? null, due: isDue({ times, everyMinutes: d?.everyMinutes }, d?.lastAt ? new Date(d.lastAt) : undefined, new Date()) };
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
      writeJson(path.join(ctx.dataDir, HINT_FILE), { facts: s.counts.facts });
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

  tool('get_profile', readOnly, async ({ offset }) => {
    const profile = await services.profile.get(offset === undefined ? undefined : { offset });
    const base = offset ?? 0;
    const make = (facts: typeof profile.facts, cut: boolean) =>
      cut ? { facts, nextOffset: base + facts.length, truncated: true } : { facts, ...(profile.nextOffset === undefined ? {} : { nextOffset: profile.nextOffset }) };
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
    const note = s?.ai
      ? 'Topics are made from the saved facts within a minute or two. Call get_profile to see them.'
      : withTopics < saved.length
        ? 'This pod makes no topics on its own. Call add_facts again with the same statements and 4 to 8 news topics for each.'
        : 'Call get_profile to see the topics.';
    return ok({ ...result, ...(topics.length ? { topics } : {}), note }, estimate);
  });

  tool('remove_facts', destructive, async ({ ids }) => {
    const removed = await services.profile.removeFacts(ids);
    await statusAndHint();
    return ok(removed, estimate);
  });

  tool('edit_topics', destructive, async ({ remove, weight }) =>
    ok(await services.profile.editTopics({ ...(remove ? { remove } : {}), ...(weight ? { weight } : {}) }), estimate),
  );

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

  // Not read-only: what it shows is recorded, and not shown again for 72 hours.
  tool('news_for_profile', writes, async ({ limit }) => {
    const facts: FactView[] = [];
    for (let offset: number | undefined = 0, pages = 0; offset !== undefined && pages < 20; pages++) {
      const page = await services.profile.get(offset ? { offset } : undefined);
      facts.push(...page.facts);
      offset = page.nextOffset;
    }
    // Each topic text once, with the first fact it came from, one topic per fact in turn so the newest
    // facts come as early as the oldest. Only these texts leave the computer.
    const factOf = new Map<string, { fact: FactView; text: string }>();
    for (let i = 0, more = true; more; i++) {
      more = false;
      for (const f of facts) {
        const t = f.topics[i];
        if (!t) continue;
        more = true;
        if (!factOf.has(t.text.trim().toLowerCase())) factOf.set(t.text.trim().toLowerCase(), { fact: f, text: t.text.trim() });
      }
    }
    if (factOf.size === 0) {
      const hint = facts.length ? 'The saved facts have no topics yet. Call add_facts again with the same statements and 4 to 8 news topics for each.' : 'Nothing is saved yet. Offer to set up the news profile.';
      return ok({ groups: [], hint }, estimate);
    }
    const topics = [...factOf.values()].map((v) => v.text).slice(0, 200); // the server's limit per request
    type TopicResult = { topicText: string; articleIds: string[]; hasNextPage?: boolean; nextCursor?: string | null };
    // No total cap: the server would cut the last topics first, which are the newest facts'.
    const persona = async (list: { text: string; afterCursor?: string }[]) =>
      (await ask<{ articleIdsForPersona: { topicResults: TopicResult[] } }>(services.news.graphql, 'GetArticleIdsForPersona', PERSONA, { query: { limitPerTopic: PER_TOPIC, topics: list } })).articleIdsForPersona.topicResults;

    return serially(shownFile, async () => {
      const now = Date.now();
      const shown = Object.fromEntries(Object.entries(readJson<Record<string, number>>(shownFile) ?? {}).filter(([, at]) => typeof at === 'number' && now - at < SHOWN_FOR_MS));
      let lists = await persona(topics.map((text) => ({ text })));
      // A topic's best matches stay on top for a day, so a topic whose page was all shown is asked for its next page.
      for (let round = 0; round < MORE_PAGES; round++) {
        const spent = lists.filter((l) => l.hasNextPage && l.nextCursor && l.articleIds.every((id) => shown[id]));
        if (spent.length === 0) break;
        const next = await persona(spent.map((l) => ({ text: l.topicText, afterCursor: l.nextCursor! })));
        lists = lists.map((l) => (spent.includes(l) ? (next[spent.indexOf(l)] ?? { ...l, articleIds: [] }) : l));
      }
      // Round robin over the topics, so each one's best match comes before any topic's second.
      const topicOf = new Map<string, string>();
      for (let rank = 0; topicOf.size < limit && lists.some((l) => rank < l.articleIds.length); rank++) {
        for (const l of lists) {
          const id = l.articleIds[rank];
          if (id && !shown[id] && !topicOf.has(id) && topicOf.size < limit) topicOf.set(id, l.topicText);
        }
      }
      if (topicOf.size === 0) return ok({ groups: [], hint: 'No new stories since the last call. search_news finds more.' }, estimate);
      const got = await ask<{ articlesForTopicsByIds: { articles: NewsArticleIn[] } }>(services.news.graphql, 'GetArticlesForTopicsByIds', ARTICLES_BY_IDS, { articleIds: [...topicOf.keys()] });
      const byId = new Map(got.articlesForTopicsByIds.articles.map((a) => [a._id, a]));
      const results = await withStories(services.news.graphql, [...topicOf.keys()].flatMap((id) => (byId.has(id) ? newsOut(byId.get(id)!) : [])));
      const grouped = (kept: NewsOut[], cut: boolean) => {
        const groups = new Map<string, { factId: string; fact: string; results: NewsOut[] }>();
        for (const r of kept) {
          const f = factOf.get((topicOf.get(r.id) ?? '').trim().toLowerCase())?.fact;
          if (!f) continue;
          if (!groups.has(f.id)) groups.set(f.id, { factId: f.id, fact: f.statement.slice(0, 300), results: [] });
          groups.get(f.id)!.results.push(r);
        }
        return { groups: [...groups.values()], ...(cut ? { truncated: true } : {}) };
      };
      const { kept, cut } = fit(results, grouped, estimate);
      // Only what is in the reply counts as shown.
      for (const r of kept) shown[r.id] = now;
      writeJson(shownFile, shown);
      return ok(grouped(kept, cut), estimate);
    });
  });

  const status = (s: PodStatus) => ok({ ...s, digest: digestView() }, estimate);
  tool('get_status', readOnly, async () => {
    const s = await services.reading.status();
    noteFacts(s);
    return status(s);
  });
  tool('set_reading', destructive, async ({ paused, everyMinutes, digestTimes, digestEveryMinutes }) => {
    if (digestTimes !== undefined || digestEveryMinutes !== undefined) {
      await changeDigest((d) => {
        const next: DigestSchedule = { times: digestTimes ? [...new Set(digestTimes)].sort() : d.times, lastAt: d.lastAt ?? new Date().toISOString() };
        const every = digestEveryMinutes === undefined ? d.everyMinutes : (digestEveryMinutes ?? undefined);
        return every ? { ...next, everyMinutes: every } : next;
      });
    }
    const change = { ...(paused === undefined ? {} : { paused }), ...(everyMinutes === undefined ? {} : { everyMinutes }) };
    return status(Object.keys(change).length ? await services.reading.set(change) : await services.reading.status());
  });
  tool('digest_done', writes, async () => ok({ digest: await changeDigest((d) => ({ ...d, lastAt: new Date().toISOString() })) }, estimate));

  for (const [name, p] of Object.entries(prompts)) {
    server.registerPrompt(name, { description: p.description }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text } }],
    }));
  }
  return server;
}

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { PodServices, PodStatus, PickView, ProfileSetup } from 'mera-news-pod/plugin-api';
import type { McpContext } from '../../src/tools';
import { createPlugin } from '../../src';
import { MAX_CHARS, MAX_TOKENS } from '../../src/reply';

export const DONE: ProfileSetup = { complete: true, findingTopics: [], toReview: [], noTopics: [] };
export const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz0123456789';

export const status = (over: Partial<PodStatus> = {}): PodStatus => ({
  reading: 'on',
  everyMinutes: 60,
  readingNow: false,
  firstReadDone: true,
  lastRunAt: '2026-01-01T00:00:00.000Z',
  nextReadAt: '2026-01-01T01:00:00.000Z',
  unscored: 0,
  counts: { facts: 1, topics: 2, topicsPending: 0, picks: 3 },
  problems: [],
  limits: [],
  ai: { host: 'ai.example', model: 'm', relevanceModel: 'm', reasons: true },
  dataServer: { host: 'data.example' },
  ...over,
});

export const pick = (i: number): PickView => ({
  id: `p${i}`,
  title: `Title number ${i} of a news story`,
  publication: 'The Paper',
  url: `https://news.example/story/${i}`,
  publishedAt: '2026-01-01T00:00:00.000Z',
  level: 'medium',
  lang: 'en',
  reason: `This story matters to the person because of their saved fact number ${i}, which it touches directly.`,
  facts: ['Lives in Utrecht'],
});

/** Fake services; each member given replaces only those calls of that member. */
export function fakeServices(over: { [K in keyof PodServices]?: Partial<PodServices[K]> } = {}): PodServices {
  const base: PodServices = {
    profile: {
      get: async () => ({ facts: [], setup: DONE }),
      addFacts: async (s) => ({ added: s.map((statement, i) => ({ id: `f${i}`, statement })), already: [], refused: [] }),
      removeFacts: async (ids) => ({ removed: ids.map((id) => ({ id, statement: 'x', topics: ['t'] })), notFound: [] }),
      editTopics: async (e) => ({ results: [...(e.remove ?? []).map((id, index) => ({ op: 'remove' as const, index, ok: true, id }))] }),
      addTopics: async (_id, texts) => ({ added: texts.map((text, i) => ({ id: `t${i}`, text })), skipped: [] }),
    },
    suggestions: {
      get: async () => ({ state: 'ok', hint: 'Fine.', nextReadAt: null, picks: [pick(1)], cursor: 'a.1', more: false }),
    },
    reading: {
      status: async () => status(),
      set: async (c) => status({ reading: c.paused ? 'paused' : 'on', everyMinutes: c.everyMinutes ?? 60 }),
      readNow: async () => 'ran',
    },
    // The mcp plugin uses none of these; they are part of what a version 2 plugin is given.
    aiService: { set: async () => ({ set: true }), models: async () => ({ models: [] }), providers: () => [], setReasons: async () => ({ set: true }) },
    stories: {
      forProfile: async () => ({
        run: '00000000',
        summary: { windowHours: 48, articles: 0, stories: 0, merged: 0, topics: [], facts: [], picked: 0, leftOut: 0, unjudged: 0, publishers: 0, languages: 0, complete: true },
        stories: [],
        shownBefore: 0,
      }),
      judge: async () => ({ saved: [], already: [], refused: [] }),
    },
    followed: {
      list: async () => ({ stories: [] }),
      get: async () => Promise.reject(new Error('not used')),
      follow: async () => Promise.reject(new Error('not used')),
      unfollow: async () => ({ removed: true }),
      removeArticle: async () => ({ removed: true }),
    },
    model: { chatCompletions: async () => new Response('{}') },
    news: { graphql: async () => ({ data: null }) },
    commands: { run: async () => ({ results: [], snapshot: { schemaVersion: 0, registry: 0, tables: {} } }) },
    display: { snapshot: async () => ({ schemaVersion: 0, registry: 0, tables: {} }), versions: () => ({ schemaVersion: 0, registry: 0 }) },
    events: { on: () => () => {} },
  };
  for (const [k, v] of Object.entries(over)) Object.assign(base[k as keyof PodServices], v);
  return base;
}

/**
 * Suggestions that keep the services' promise: a page from `since` (the pod's `e.<n>` cursor, 'all',
 * or the last delivered), cut until `fits` passes (never below one pick), and only the picks
 * returned count as delivered.
 */
export function deliveringSuggestions(all: PickView[]): PodServices['suggestions'] {
  let delivered = 0;
  return {
    get: async ({ since, limit, fits, peek }) => {
      const from = since === undefined ? delivered : since === 'all' ? 0 : Number(/^e\.(\d+)$/.exec(since)?.[1] ?? NaN);
      if (Number.isNaN(from)) throw Object.assign(new Error('That cursor was not issued by this pod.'), { code: 'unknown_cursor', next: 'call without since' });
      let page = all.slice(from, from + limit);
      while (fits && page.length > 1 && !fits(page)) page = page.slice(0, -1);
      const last = from + page.length;
      if (!peek) delivered = Math.max(delivered, last);
      return { state: 'ok', hint: 'Reading is on.', nextReadAt: null, picks: page, cursor: `e.${last}`, more: last < all.length };
    },
  };
}

type Body = { operationName: string; query: string; variables: Record<string, any> };

/**
 * A news server for the news tools, with `count` articles, that holds every request to the real
 * server's limits: 50 ids for GetArticlesForTopicsByIds, 500 for ClusterMembershipsForArticles,
 * `first` 1 to 200 headlines, 1 to 50 newest articles, a search page of 1 to 100 (25 for the old
 * searchNews). A request over a limit is recorded in `over` and answered with an error, so the tool
 * fails. `old` makes it a server from before paging: the paged fields fail with `oldCode`.
 */
export function fakeNews(opts: { count?: number; titleLength?: number; old?: boolean; oldCode?: string } = {}) {
  const count = opts.count ?? 1000;
  const pad = 'w'.repeat(opts.titleLength ?? 40);
  const ids = Array.from({ length: count }, (_, i) => `a${String(i).padStart(4, '0')}`);
  const at = new Map(ids.map((id, i) => [id, i]));
  const article = (i: number) => ({
    _id: ids[i],
    title: `Kop ${ids[i]} ${pad}`,
    title_en: `Headline ${ids[i]} ${pad}`,
    article_url: `https://news.example/${ids[i]}`,
    pubDate: new Date(Date.UTC(2026, 0, 2) - i * 60_000).toISOString(),
    original_language_code: 'nl',
    publicationSource: { publication_name: `Paper ${i % 7}` },
    description: 'SECRET BODY TEXT',
  });
  const calls: Body[] = [];
  const over: string[] = [];
  const refuse = (what: string) => (over.push(what), { errors: [{ message: what, extensions: { code: 'OVER_CAP' } }] });
  const unknown = { errors: [{ message: 'Cannot query that field.', extensions: { code: opts.oldCode ?? 'GRAPHQL_VALIDATION_FAILED' } }] };
  const from = (after: string | null | undefined, tag: string) => (after ? Number(after.slice(tag.length + 1)) + 1 : 0);
  // The search cursor has the data server's shape, base64 JSON of the frozen window and the offset; each new window gets its own asOf.
  const windows: string[] = [];
  const searchCursor = (asOf: string, offset: number) => Buffer.from(JSON.stringify({ asOf, from: new Date(Date.parse(asOf) - 48 * 3600_000).toISOString(), offset })).toString('base64');
  const searchAt = (after: string | null | undefined) => {
    if (!after) {
      windows.push(new Date(Date.UTC(2026, 0, 2, 0, windows.length)).toISOString());
      return { asOf: windows.at(-1)!, offset: 0 };
    }
    const c = JSON.parse(Buffer.from(after, 'base64').toString('utf8'));
    return { asOf: c.asOf as string, offset: c.offset as number };
  };
  const graphql = async (raw: unknown): Promise<any> => {
    const b = raw as Body;
    calls.push(b);
    const v = b.variables;
    switch (b.operationName) {
      case 'SearchNews': {
        const paged = b.query.includes('searchNewsPage');
        if (paged && opts.old) return unknown;
        const max = paged ? 100 : 25;
        if (!(v.limit >= 1 && v.limit <= max)) return refuse(`search limit ${v.limit}`);
        const { asOf, offset: start } = paged ? searchAt(v.after) : { asOf: '', offset: 0 };
        const hits = ids.slice(start, start + v.limit).map((_id) => ({ _id }));
        return { data: paged ? { searchNewsPage: { hits, nextCursor: start + v.limit < count ? searchCursor(asOf, start + v.limit) : null } } : { searchNews: hits } };
      }
      case 'GetArticlesForTopicsByIds': {
        if (!(v.articleIds.length >= 1 && v.articleIds.length <= 50)) return refuse(`${v.articleIds.length} ids`);
        const articles = (v.articleIds as string[]).filter((id) => at.has(id)).map((id) => {
          const { original_language_code, publicationSource, ...rest } = article(at.get(id)!);
          return { ...rest, language_code: original_language_code, publication_name: publicationSource.publication_name };
        });
        return { data: { articlesForTopicsByIds: { articles } } };
      }
      case 'ClusterMembershipsForArticles': {
        if (v.articleIds.length > 500) return refuse(`${v.articleIds.length} membership ids`);
        // Three articles in a row are one story.
        return { data: { clusterMembershipsForArticles: (v.articleIds as string[]).map((id) => ({ articleId: id, clusters: [{ clusterId: `c${Math.floor(at.get(id)! / 3)}`, stableClusterId: null, confidence: 0.9 }] })) } };
      }
      case 'GetArticlesForCountry': {
        const paged = b.query.includes('itemCursors');
        if (paged && opts.old) return unknown;
        if (!(v.first >= 1 && v.first <= 50)) return refuse(`newest first ${v.first}`);
        const start = from(v.after, 'n');
        const page = ids.slice(start, start + v.first).map((_, j) => start + j);
        return {
          data: {
            articlesForCountry: {
              articles: page.map(article),
              ...(paged ? { itemCursors: page.map((i) => `n:${i}`) } : {}),
              pageInfo: { endCursor: page.length ? `n:${page.at(-1)}` : null, hasNextPage: start + page.length < count },
            },
          },
        };
      }
      case 'GetTopHeadlinesForCountry': {
        const paged = b.query.includes('publisherCount');
        if (paged && opts.old) return unknown;
        if (!(v.first >= 1 && v.first <= 200)) return refuse(`headlines first ${v.first}`);
        const start = from(v.after, 'h');
        const page = ids.slice(start, start + v.first).map((_, j) => start + j);
        const headlines = page.map((i) => ({ clusterSize: 12, article: article(i), ...(paged ? { publisherCount: 9, cursor: `h:${i}` } : {}) }));
        return { data: { topHeadlinesForCountry: { headlines, pageInfo: { endCursor: page.length ? `h:${page.at(-1)}` : null, hasNextPage: start + page.length < count } } } };
      }
      default:
        return { errors: [{ message: 'not served', extensions: { code: 'NOT_IMPLEMENTED' } }] };
    }
  };
  return { ids, calls, over, windows, services: fakeServices({ news: { graphql } }) };
}

export const estimate = (text: string) => Math.ceil(text.length / 4);

export interface Running {
  url: string;
  port: number;
  home: string;
  writeToken(token: string, mode?: number): void;
  client(token?: string): Promise<Client>;
  raw(options: { path?: string; headers?: Record<string, string>; method?: string; body?: string }): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>;
  stop(): Promise<void>;
}

export async function run(opts: { services?: PodServices; config?: unknown; token?: string | null } = {}): Promise<Running> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-'));
  const dataDir = path.join(home, 'data', 'plugins', 'mcp');
  mkdirSync(dataDir, { recursive: true });
  const writeToken = (t: string, mode = 0o600) => {
    writeFileSync(path.join(dataDir, 'token'), `${t}\n`, { mode });
    chmodSync(path.join(dataDir, 'token'), mode);
  };
  if (opts.token !== null) writeToken(opts.token ?? TOKEN);
  const ctx: McpContext = {
    podApi: 2,
    meraNewsApp: null,
    services: opts.services ?? fakeServices(),
    config: { port: 0, ...(opts.config as object | undefined) },
    dataDir,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    estimateTokens: estimate,
  };
  const plugin = await createPlugin(ctx);
  await plugin.start();
  const url = plugin.describe!()[0].replace('MCP address: ', '');
  const port = Number(new URL(url).port);
  const clients: Client[] = [];
  return {
    url,
    port,
    home,
    writeToken,
    async client(token = TOKEN) {
      const c = new Client({ name: 'test', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(c);
      return c;
    },
    raw: ({ path: p = '/mcp', headers = {}, method = 'POST', body = '{}' }) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
        });
        req.setTimeout(3000, () => req.destroy(new Error('no answer within 3 seconds')));
        req.on('error', reject);
        req.end(body);
      }),
    async stop() {
      await Promise.allSettled(clients.map((c) => c.close()));
      await plugin.stop();
    },
  };
}

/**
 * A story's show line is `[headline](link) · Publisher`, then `+N publications` when it has more than one
 * publisher, or `+N reports` when only its reports are known. Checks it against the item's own fields.
 */
export function assertShow(s: any, given?: number) {
  const reports = given ?? s?.reportCount ?? (typeof s?.reports === 'number' ? s.reports : 0);
  const m = /^\[((?:[^\[\]\\]|\\.)*)\]\((https?:\/\/[^\s()]+)\) · (.+?)(?: \+(\d+) (publications?|reports?))?$/.exec(s?.show ?? '');
  assert.ok(m, `a show line: ${JSON.stringify(s)}`);
  assert.equal(m[1].replace(/\\(.)/g, '$1'), s.title.replace(/\s+/g, ' ').trim(), 'the headline, word for word');
  assert.equal(m[2], s.link ?? s.url, 'the link');
  assert.equal(m[3].replace(/\\(.)/g, '$1'), s.publisher ?? s.publication, 'the publisher');
  const pubs = s.publisherCount ?? 0;
  const others = pubs > 1 ? [pubs - 1, 'publication'] : pubs === 0 && reports > 1 ? [reports - 1, 'report'] : undefined;
  assert.deepEqual(m[4] ? [Number(m[4]), m[5].replace(/s$/, '')] : undefined, others, `the count in ${s.show}`);
}

export const json = (result: { content?: unknown }) => JSON.parse(((result.content as { text: string }[])[0]).text);

/**
 * Calls a list tool, then each call its `next` names, until a reply has no next. Every reply must be
 * within the hard cap, and `remaining` must count down by what was shown.
 */
export async function walk(c: Client, name: string, args: Record<string, unknown>, items: (reply: any) => string[], total: number) {
  const seen: string[] = [];
  let cuts = 0;
  let calls = 0;
  let reply: any;
  for (let a: Record<string, unknown> | undefined = args; a; calls++) {
    assert.ok(calls < 100, 'the walk does not end');
    const res = await c.callTool({ name, arguments: a });
    const text = (res.content as { text: string }[])[0].text;
    assert.equal(res.isError, undefined, text);
    assert.ok(estimate(text) <= MAX_TOKENS && text.length <= MAX_CHARS, `reply ${calls} is ${text.length} characters`);
    reply = JSON.parse(text);
    assert.match(reply.next, /Show each story by its show line, exactly as written/, 'every reply says how to show its stories');
    seen.push(...items(reply));
    if (reply.truncated) cuts++;
    const call = /Call (\w+) with (\{.*\}): (\d+) of the (\d+) asked for are still to come\.$/.exec(reply.next ?? '');
    if (call) {
      assert.equal(call[1], name);
      assert.deepEqual([Number(call[3]), Number(call[4]), reply.remaining], [total - seen.length, total, total - seen.length]);
    }
    a = call ? JSON.parse(call[2]) : undefined;
    if (!call) assert.equal('remaining' in reply, false, 'a reply with nothing more to come has no remaining');
  }
  return { seen, cuts, calls, last: reply };
}

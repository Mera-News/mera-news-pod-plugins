import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PodServices, Snapshot } from 'mera-news-pod/plugin-api';
import { siteLink } from '../src/link';
import { run, type Running } from './helpers';

type Body = { operationName: string; query: string; variables: Record<string, any> };

const article = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Titel ${id}`,
  title_en: `Title ${id}`,
  article_url: `https://news.example/${id}`,
  image_url: `https://img.example/${id}.jpg`,
  pubDate: '2026-01-02T03:04:05.000Z',
  original_language_code: 'nl',
  publicationSource: { publication_name: `Paper ${id}` },
  description: 'SECRET BODY TEXT',
  description_en: 'SECRET BODY TEXT',
  ...over,
});
const headline = (id: string, clusterSize: number, over: Record<string, unknown> = {}) => ({ clusterSize, article: article(id, over) });

/** A news.graphql stub that records each request and answers by operation name. */
function news(answers: Record<string, (b: Body) => unknown>) {
  const calls: Body[] = [];
  const graphql = async (b: unknown) => {
    calls.push(b as Body);
    const answer = answers[(b as Body).operationName];
    return (answer ? answer(b as Body) : { errors: [{ message: 'no', extensions: { code: 'NOT_ALLOWED' } }] }) as any;
  };
  return { calls, news: { graphql } as PodServices['news'] };
}

async function signedIn(services: Partial<PodServices>) {
  const r = await run({ services });
  const code = /#c=(.+)$/.exec(siteLink(r.dataDir))![1];
  const { session } = JSON.parse((await r.session(code)).body);
  const get = async (path: string) => {
    const res = await r.request({ path, headers: { authorization: `Bearer ${session}` } });
    return { status: res.status, body: JSON.parse(res.body || 'null') };
  };
  return { r, get };
}

/** Every key anywhere in a reply. */
const keys = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
function assertNoArticleText(reply: unknown) {
  assert.deepEqual(keys(reply).filter((k) => /description/i.test(k)), [], 'no description key');
  assert.doesNotMatch(JSON.stringify(reply), /SECRET/);
}

async function using<T>(r: Running, fn: () => Promise<T>) {
  try {
    return await fn();
  } finally {
    await r.stop();
  }
}

test('top stories: one page for the world or a country, the named fields only, with how many reports each story has', async () => {
  const { calls, news: n } = news({
    GetTopHeadlinesForCountry: (b) =>
      b.variables.after
        ? { data: { topHeadlinesForCountry: { headlines: [headline('c', 0)], pageInfo: { endCursor: 'c', hasNextPage: false } } } }
        : {
            data: {
              topHeadlinesForCountry: {
                headlines: [headline('a', 14), headline('b', 3, { image_url: 'http://img.example/b.jpg', title_en: 'Titel b' }), headline('bad', 2, { article_url: 'javascript:alert(1)' })],
                pageInfo: { endCursor: 'b', hasNextPage: true },
              },
            },
          },
  });
  const { r, get } = await signedIn({ news: n });
  await using(r, async () => {
    const first = await get('/api/top/');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      stories: [
        { id: 'a', title: 'Titel a', titleEn: 'Title a', link: 'https://news.example/a', publisher: 'Paper a', publishedAt: '2026-01-02T03:04:05.000Z', language: 'nl', image: 'https://img.example/a.jpg', reports: 14 },
        // An image only over https, and no English title that repeats the original.
        { id: 'b', title: 'Titel b', link: 'https://news.example/b', publisher: 'Paper b', publishedAt: '2026-01-02T03:04:05.000Z', language: 'nl', reports: 3 },
      ],
      nextCursor: 'b',
    });
    assert.deepEqual(calls[0].variables, { countryCode: null, first: 20, after: null });
    assert.doesNotMatch(calls[0].query, /description/);
    const second = await get('/api/top/?c=NLD&after=b');
    const tops = () => calls.filter((c) => c.operationName === 'GetTopHeadlinesForCountry');
    assert.deepEqual(tops()[1].variables, { countryCode: 'NLD', first: 20, after: 'b' });
    assert.deepEqual(second.body.stories.map((s: { id: string; reports: number }) => [s.id, s.reports]), [['c', 1]], 'a story of one report counts one');
    assert.equal(second.body.nextCursor, null);
    for (const bad of ['/api/top/?c=nl', '/api/top/?c=NL', '/api/top/?c=GLOBAL&after=a%20b']) {
      const res = await get(bad);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.error, 'bad_input');
    }
    assert.equal(tops().length, 2, 'a bad argument asks nothing');
    assertNoArticleText([first.body, second.body]);
  });
});

test('a headline the list sends without an English title gets it by article id; English ones are not asked for', async () => {
  const { calls, news: n } = news({
    GetTopHeadlinesForCountry: () => ({
      data: { topHeadlinesForCountry: { headlines: [headline('fr1', 3, { title_en: null, original_language_code: 'fr' }), headline('en1', 2, { title: 'Plain', title_en: null, original_language_code: 'en' })], pageInfo: { endCursor: null, hasNextPage: false } } },
    }),
    GetArticlesForTopicsByIds: (b) => ({ data: { articlesForTopicsByIds: { articles: b.variables.articleIds.map((id: string) => ({ _id: id, title: 'Titre', title_en: 'The English title' })) } } }),
  });
  const { r, get } = await signedIn({ news: n });
  await using(r, async () => {
    const page = (await get('/api/top/?c=GLOBAL')).body;
    assert.equal(page.stories[0].titleEn, 'The English title');
    assert.equal(page.stories[1].titleEn, undefined);
    const ask = calls.find((c) => c.operationName === 'GetArticlesForTopicsByIds')!;
    assert.deepEqual(ask.variables.articleIds, ['fr1']);
  });
});

test('when the English titles cannot be read, the stories still come in their own language', async () => {
  const { news: n } = news({
    GetTopHeadlinesForCountry: () => ({ data: { topHeadlinesForCountry: { headlines: [headline('fr1', 3, { title_en: null, original_language_code: 'fr' })], pageInfo: { endCursor: null, hasNextPage: false } } } }),
  });
  const { r, get } = await signedIn({ news: n });
  await using(r, async () => {
    const page = (await get('/api/top/?c=GLOBAL')).body;
    assert.equal(page.stories.length, 1);
    assert.equal(page.stories[0].titleEn, undefined);
  });
});

test('every report of a story, page by page, and an article no story holds', async () => {
  const { calls, news: n } = news({
    GetNewsClusterForArticle: (b) =>
      b.variables.articleId === 'gone'
        ? { data: { newsClusterForArticle: null } }
        : { data: { newsClusterForArticle: { clusterSize: 3, articles: { articles: [article('a'), article('x', { original_language_code: null, publicationSource: null })], pageInfo: { endCursor: 'x', hasNextPage: true } } } } },
  });
  const { r, get } = await signedIn({ news: n });
  await using(r, async () => {
    const page = await get('/api/story/?id=a&after=q1');
    assert.deepEqual(calls[0].variables, { articleId: 'a', first: 50, after: 'q1' });
    assert.doesNotMatch(calls[0].query, /description/);
    assert.deepEqual(page.body.reports.map((x: { id: string; publisher: string; language: string }) => [x.id, x.publisher, x.language]), [['a', 'Paper a', 'nl'], ['x', '', 'und']]);
    assert.equal('image' in page.body.reports[0], false, 'a report carries no image');
    assert.equal(page.body.nextCursor, 'x');
    assert.deepEqual((await get('/api/story/?id=gone')).body, { reports: [], nextCursor: null });
    assert.equal((await get('/api/story/')).status, 400, 'an id is required');
    assertNoArticleText(page.body);
  });
});

test('search: the best matches with reports of one story shown as one, the words never logged', async () => {
  const words = 'tram strike utrecht';
  const byIds = (id: string, over: Record<string, unknown> = {}) => {
    const { original_language_code, publicationSource, ...rest } = article(id);
    return { ...rest, language_code: original_language_code, publication_name: publicationSource.publication_name, ...over };
  };
  let group = true;
  const { calls, news: n } = news({
    SearchNews: () => ({ data: { searchNews: [{ _id: 'b' }, { _id: 'gone' }, { _id: 'a' }, { _id: 'c' }] } }),
    GetArticlesForTopicsByIds: () => ({ data: { articlesForTopicsByIds: { articles: [byIds('a'), byIds('b', { maxClusterSize: 9 }), byIds('c')] } } }),
    ClusterMembershipsForArticles: () =>
      group
        ? {
            data: {
              clusterMembershipsForArticles: [
                { articleId: 'a', clusters: [{ clusterId: '1', stableClusterId: 's1', confidence: 0.9 }] },
                { articleId: 'b', clusters: [{ clusterId: '2', stableClusterId: 's2', confidence: 0.2 }, { clusterId: '1', stableClusterId: 's1', confidence: 0.8 }] },
                { articleId: 'c', clusters: [] },
              ],
            },
          }
        : { errors: [{ message: 'down' }] },
  });
  const { r, get } = await signedIn({ news: n });
  await using(r, async () => {
    const res = await get(`/api/search/?q=${encodeURIComponent(`  ${words} `)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(calls.map((c) => c.operationName), ['SearchNews', 'GetArticlesForTopicsByIds', 'ClusterMembershipsForArticles']);
    assert.deepEqual(calls[0].variables, { query: words, limit: 25 });
    assert.deepEqual(calls[1].variables, { articleIds: ['b', 'gone', 'a', 'c'] });
    // b and a are one story, led by the better match; c stands alone.
    assert.deepEqual(res.body.stories.map((s: { id: string; reports: number }) => [s.id, s.reports]), [['b', 9], ['c', 1]]);
    group = false;
    const ungrouped = await get(`/api/search/?q=${encodeURIComponent(words)}`);
    assert.deepEqual(ungrouped.body.stories.map((s: { id: string }) => s.id), ['b', 'a', 'c'], 'a server that cannot group leaves every match');
    for (const bad of ['/api/search/', '/api/search/?q=%20%20', `/api/search/?q=${'x'.repeat(201)}`]) assert.equal((await get(bad)).status, 400, bad);
    assertNoArticleText([res.body, ungrouped.body]);
    assert.doesNotMatch(r.logs.join('\n'), /tram|strike|utrecht/i);
  });
});

test('no hits asks nothing more', async () => {
  const { calls, news: n } = news({ SearchNews: () => ({ data: { searchNews: [] } }) });
  const { r, get } = await signedIn({ news: n });
  await using(r, async () => {
    assert.deepEqual((await get('/api/search/?q=nothing')).body, { stories: [] });
    assert.equal(calls.length, 1);
  });
});

test('countries: the person\'s from their places, weightiest first, and every country Mera News has, by name', async () => {
  const held: Record<string, string>[] = [];
  const table = (rows?: Record<string, unknown>[]) => ({ hash: 'h', mode: 'replace' as const, ...(rows ? { rows } : {}) });
  const display = {
    snapshot: async (o: { hashes?: Record<string, string> } = {}): Promise<Snapshot> => {
      held.push(o.hashes ?? {});
      return {
        schemaVersion: 1,
        registry: 1,
        tables: {
          facts: { ...table([{ statement: 'Lives in Utrecht' }]), hash: 'f1' },
          article_suggestions: { ...table([{ description_en: 'SECRET BODY TEXT' }]), hash: 's1' },
          locations: table([
            { country_code: 'us', weight: 0.2, role: 'not a role' },
            { country_code: 'NL', weight: 0.9, city: 'Utrecht', role: 'home' },
            { country_code: 'IN', weight: 0.5, valid_until: Date.now() - 1000 },
            { country_code: 'NL', weight: 0.3, role: 'interest' },
            { country_code: 'ZZ', weight: 1 },
          ]),
        },
      };
    },
  } as unknown as PodServices['display'];
  const { news: n } = news({ AllCountries: () => ({ data: { allCountries: ['NLD', 'DEU', 'GLOBAL', 'XKK', 'QQQ'] } }) });
  const { r, get } = await signedIn({ news: n, display });
  await using(r, async () => {
    const res = await get('/api/countries/');
    assert.deepEqual(res.body, {
      yours: [
        { code: 'NLD', name: 'Netherlands', flag: '\u{1F1F3}\u{1F1F1}' },
        { code: 'USA', name: 'United States', flag: '\u{1F1FA}\u{1F1F8}' },
      ],
      all: [
        { code: 'DEU', name: 'Germany', flag: '\u{1F1E9}\u{1F1EA}' },
        { code: 'XKK', name: 'Kosovo', flag: '\u{1F1FD}\u{1F1F0}' },
        { code: 'NLD', name: 'Netherlands', flag: '\u{1F1F3}\u{1F1F1}' },
        { code: 'QQQ', name: 'QQQ' },
      ],
      // Every place, the weightiest first, with its role where it has a known one.
      places: [
        { name: 'Utrecht, Netherlands', role: 'home' },
        { name: 'Netherlands', role: 'interest' },
        { name: 'United States' },
      ],
    });
    await get('/api/countries/');
    assert.deepEqual(held, [{}, { facts: 'f1', article_suggestions: 's1' }], 'the second read holds every table but places');
    assertNoArticleText(res.body);
  });
});

test('a refused key and a news server that cannot answer say what to do; no request without a session', async () => {
  const { news: n } = news({
    GetTopHeadlinesForCountry: () => ({ errors: [{ message: 'key secret-123 refused', extensions: { code: 'UNAUTHENTICATED' } }] }),
    SearchNews: () => {
      throw new Error('socket secret-123');
    },
  });
  const { r, get } = await signedIn({ news: n });
  await using(r, async () => {
    const refused = await get('/api/top/');
    assert.equal(refused.status, 400);
    assert.equal(refused.body.error, 'key_refused');
    assert.match(refused.body.next, /secrets\.json/);
    const down = await get('/api/search/?q=x');
    assert.deepEqual(down.body.error, 'news_unavailable');
    assert.doesNotMatch(JSON.stringify([refused.body, down.body]) + r.logs.join('\n'), /secret-123/);
    for (const path of ['/api/top/', '/api/story/?id=a', '/api/search/?q=x', '/api/countries/']) {
      assert.equal((await r.request({ path })).status, 401, path);
      assert.equal((await r.request({ path, method: 'POST', headers: { origin: r.origin(), 'content-type': 'application/json' }, body: '{}' })).status, 405, path);
    }
  });
});

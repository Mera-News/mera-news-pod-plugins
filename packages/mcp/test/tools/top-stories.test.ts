import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeServices, json, run } from './helpers';

type Body = { operationName: string; query: string; variables: Record<string, any> };

const article = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Titel ${id}`,
  title_en: `Title ${id}`,
  article_url: `https://news.example/${id}`,
  pubDate: '2026-01-02T03:04:05.000Z',
  original_language_code: 'nl',
  publicationSource: { publication_name: `Paper ${id}` },
  description: 'SECRET BODY TEXT',
  image_url: 'https://img.example/x.png',
  ...over,
});

function stub(answer: (b: Body) => unknown) {
  const calls: Body[] = [];
  const services = fakeServices({
    news: {
      graphql: async (b: unknown) => {
        calls.push(b as Body);
        return answer(b as Body) as any;
      },
    },
  });
  return { calls, services };
}

async function call(services: ReturnType<typeof fakeServices>, args: Record<string, unknown>) {
  const r = await run({ services });
  try {
    return await (await r.client()).callTool({ name: 'top_stories', arguments: args });
  } finally {
    await r.stop();
  }
}

const keys = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);

test('top_stories: the world by default, each story with its report count, every publisher\'s link and the page\'s summary numbers', async () => {
  const { calls, services } = stub((b) => {
    if (b.operationName === 'GetTopHeadlinesForCountry')
      return {
        data: {
          topHeadlinesForCountry: {
            headlines: [{ clusterSize: 3, article: article('a') }, { clusterSize: 0, article: article('solo', { original_language_code: 'de', title_en: 'Titel solo' }) }],
            pageInfo: { endCursor: 'solo', hasNextPage: true },
          },
        },
      };
    return {
      data: {
        newsClusterForArticle: {
          clusterSize: 3,
          articles: {
            articles: [article('a'), article('b', { publicationSource: { publication_name: 'Paper b' }, original_language_code: 'en' }), article('c', { publicationSource: { publication_name: 'Paper b' } })],
            pageInfo: { endCursor: 'c', hasNextPage: false },
          },
        },
      },
    };
  });
  const res = await call(services, {});
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => c.operationName), ['GetTopHeadlinesForCountry', 'GetNewsClusterForArticle']);
  assert.deepEqual(calls[0].variables, { countryCode: null, first: 10, after: null });
  assert.deepEqual(calls[1].variables, { articleId: 'a', first: 25, after: null });
  for (const c of calls) assert.doesNotMatch(c.query, /description/);
  const body = json(res);
  assert.deepEqual(body.summary, { stories: 2, reports: 4, publishers: 3, languages: 3 });
  assert.equal(body.scope, 'world');
  assert.equal(body.nextCursor, 'solo');
  const [a, solo] = body.stories;
  assert.equal(a.title, 'Titel a');
  assert.equal(a.title_en, 'Title a');
  assert.equal(a.reportCount, 3);
  assert.equal(a.publisherCount, 2, 'one publisher with two reports counts once');
  assert.deepEqual(a.reports, [
    { publisher: 'Paper a', link: 'https://news.example/a', language: 'nl' },
    { publisher: 'Paper b', link: 'https://news.example/b', language: 'en' },
    { publisher: 'Paper b', link: 'https://news.example/c', language: 'nl' },
  ]);
  assert.deepEqual([solo.reportCount, solo.publisherCount, solo.reports], [1, 1, [{ publisher: 'Paper solo', link: 'https://news.example/solo', language: 'de' }]]);
  assert.equal('title_en' in solo, false);
  assert.deepEqual(keys(body).filter((k) => /description|image/.test(k)), []);
  assert.doesNotMatch(JSON.stringify(body), /SECRET|img\.example/);
});

test('top_stories: a country and a cursor pass through, and a story with more reports than one reply lists says how to get the rest', async () => {
  const { calls, services } = stub((b) => {
    if (b.operationName === 'GetTopHeadlinesForCountry') return { data: { topHeadlinesForCountry: { headlines: [{ clusterSize: 60, article: article('big') }], pageInfo: { endCursor: null, hasNextPage: false } } } };
    const after = b.variables.after;
    return {
      data: {
        newsClusterForArticle: {
          clusterSize: 60,
          articles: { articles: [article(after ? 'r26' : 'big')], pageInfo: { endCursor: after ? 'r50' : 'r25', hasNextPage: true } },
        },
      },
    };
  });
  const page = json(await call(services, { country: 'NLD', after: 'x1' }));
  assert.deepEqual(calls[0].variables, { countryCode: 'NLD', first: 10, after: 'x1' });
  assert.equal(page.scope, 'NLD');
  assert.equal('nextCursor' in page, false, 'the last page has no cursor');
  const [big] = page.stories;
  assert.equal(big.reportCount, 60);
  assert.equal('publisherCount' in big, false, 'not counted until every report is listed');
  assert.deepEqual(big.moreReports, { story: 'big', after: 'r25' });

  const rest = json(await call(services, { story: 'big', after: 'r25' }));
  assert.deepEqual(calls.at(-1)!.variables, { articleId: 'big', first: 25, after: 'r25' });
  assert.deepEqual(rest, { story: 'big', reportCount: 60, reports: [{ publisher: 'Paper r26', link: 'https://news.example/r26', language: 'nl' }], nextCursor: 'r50' });
});

test('top_stories: a page too large for one reply keeps every story it can and a cursor that resumes right after them', async () => {
  const long = 'x'.repeat(480);
  const many = Array.from({ length: 10 }, (_, i) => ({ clusterSize: 25, article: article(`s${i}`, { title: `${long} ${i}`, title_en: `${long} en ${i}` }) }));
  const { calls, services } = stub((b) => {
    if (b.operationName === 'GetTopHeadlinesForCountry') {
      const n = b.variables.first;
      return { data: { topHeadlinesForCountry: { headlines: many.slice(0, n), pageInfo: { endCursor: `s${n - 1}`, hasNextPage: true } } } };
    }
    const id = b.variables.articleId;
    const reports = Array.from({ length: 25 }, (_, i) => article(`${id}-${i}`, { article_url: `https://news.example/a/very/long/path/to/the/report/${id}/${i}?utm=xxxxxxxxxxxxxxxx` }));
    return { data: { newsClusterForArticle: { clusterSize: 25, articles: { articles: reports, pageInfo: { endCursor: null, hasNextPage: false } } } } };
  });
  const body = json(await call(services, {}));
  assert.equal(body.truncated, true);
  const kept = body.stories.length;
  assert.ok(kept >= 1 && kept < 10, `kept ${kept}`);
  assert.equal(body.summary.stories, kept);
  const reask = calls.filter((c) => c.operationName === 'GetTopHeadlinesForCountry');
  assert.deepEqual(reask.map((c) => c.variables.first), [10, kept]);
  assert.equal(body.nextCursor, `s${kept - 1}`, 'the next page starts right after the last story shown');
});

test('top_stories: a bad country is refused before anything is asked', async () => {
  const { calls, services } = stub(() => ({ data: null }));
  const res = await call(services, { country: 'nl' });
  assert.equal(res.isError, true);
  assert.equal(json(res).code, 'bad_input');
  assert.equal(calls.length, 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertShow, fakeServices, json, run } from './helpers';

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

test('top_stories: the world by default, each story with its lead publisher, link, time and how many reports and publishers, and no report lookup', async () => {
  const { calls, services } = stub(() => ({
    data: {
      topHeadlinesForCountry: {
        headlines: [
          { clusterSize: 12, publisherCount: 9, cursor: 'h0', article: article('a') },
          { clusterSize: 0, publisherCount: 1, cursor: 'h1', article: article('solo', { original_language_code: 'de', title_en: 'Titel solo' }) },
          // An edition built before publishers were counted gives 0: not known, so the reports are counted.
          { clusterSize: 5, publisherCount: 0, cursor: 'h2', article: article('uncounted') },
        ],
        pageInfo: { endCursor: 'page-end', hasNextPage: true },
      },
    },
  }));
  const res = await call(services, {});
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => c.operationName), ['GetTopHeadlinesForCountry'], 'list mode asks for no story\'s reports');
  assert.deepEqual(calls[0].variables, { countryCode: null, first: 20, after: null });
  assert.match(calls[0].query, /cursor/);
  for (const c of calls) assert.doesNotMatch(c.query, /description/);
  const body = json(res);
  assert.deepEqual(body.summary, { stories: 3, reports: 18 });
  assert.equal(body.scope, 'world');
  // The reply itself says how to show it, last, before the call for more.
  assert.match(body.next, /^Keep the order given and show every story\. Show each story by its show line, exactly as written: only the headline text inside the brackets may be translated into the reader's language\. Never write a story without its show line\. Call top_stories with /);
  const [a, solo, uncounted] = body.stories;
  assert.deepEqual(a, { id: 'a', title: 'Titel a', title_en: 'Title a', link: 'https://news.example/a', publisher: 'Paper a', publishedAt: '2026-01-02T03:04:05.000Z', reportCount: 12, publisherCount: 9, show: '[Titel a](https://news.example/a) · Paper a +8 publications' });
  assert.deepEqual([solo.reportCount, solo.publisherCount, 'title_en' in solo, 'reports' in solo, solo.show], [1, 1, false, false, '[Titel solo](https://news.example/solo) · Paper solo']);
  assert.deepEqual([uncounted.reportCount, 'publisherCount' in uncounted, uncounted.show], [5, false, '[Titel uncounted](https://news.example/uncounted) · Paper uncounted +4 reports']);
  for (const s of body.stories) assertShow(s);
  assert.deepEqual(keys(body).filter((k) => /description|image/.test(k)), []);
  assert.doesNotMatch(JSON.stringify(body), /SECRET|img\.example/);
  // The page was whole but the limit is not reached: the next call goes on from the last headline's own
  // cursor, which names the edition, not from the page's end.
  assert.equal(body.remaining, 17);
  const again = await run({ services });
  try {
    await (await again.client()).callTool({ name: 'top_stories', arguments: { after: body.nextCursor } });
  } finally {
    await again.stop();
  }
  assert.deepEqual(calls[1].variables, { countryCode: null, first: 17, after: 'h2' });
});

test('top_stories: every publisher of one story, a page at a time, when the person asks', async () => {
  const { calls, services } = stub((b) => {
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
  const rest = json(await call(services, { story: 'big', after: 'r25' }));
  assert.deepEqual(calls.map((c) => c.operationName), ['GetNewsClusterForArticle']);
  assert.deepEqual(calls.at(-1)!.variables, { articleId: 'big', first: 25, after: 'r25' });
  const { next, ...data } = rest;
  assert.deepEqual(data, { story: 'big', reportCount: 60, reports: [{ title: 'Titel r26', publisher: 'Paper r26', link: 'https://news.example/r26', language: 'nl', show: '[Titel r26](https://news.example/r26) · Paper r26' }], nextCursor: 'r50' });
  assert.match(next, /Show each story by its show line/);
});

test('top_stories: a page too large for one reply keeps every story it can and goes on from the last kept headline\'s own cursor', async () => {
  const long = 'x'.repeat(480);
  const many = Array.from({ length: 100 }, (_, i) => ({ clusterSize: 25, publisherCount: 20, cursor: `c${i}`, article: article(`s${i}`, { title: `${long} ${i}`, title_en: `${long} en ${i}`, article_url: `https://news.example/${'p'.repeat(400)}/${i}` }) }));
  const { calls, services } = stub((b) => ({ data: { topHeadlinesForCountry: { headlines: many.slice(0, b.variables.first), pageInfo: { endCursor: 'end', hasNextPage: true } } } }));
  const body = json(await call(services, { country: 'NLD', limit: 100 }));
  assert.equal(body.truncated, true);
  const kept = body.stories.length;
  assert.ok(kept >= 1 && kept < 100, `kept ${kept}`);
  assert.equal(body.summary.stories, kept);
  assert.deepEqual(calls.map((c) => c.variables.first), [100], 'asked once');
  assert.equal(body.remaining, 100 - kept);
  assert.match(body.next, new RegExp(`Call top_stories with \\{"country":"NLD","after":"[^"]+"\\}: ${100 - kept} of the 100 asked for are still to come\\.$`));
  const r = await run({ services });
  try {
    await (await r.client()).callTool({ name: 'top_stories', arguments: { country: 'NLD', after: body.nextCursor } });
  } finally {
    await r.stop();
  }
  assert.deepEqual(calls[1].variables, { countryCode: 'NLD', first: 100 - kept, after: `c${kept - 1}` });
});

test('top_stories: an edition made again between calls starts the list again from the top and says so', async () => {
  const { calls, services } = stub((b) =>
    b.variables.after ? { errors: [{ message: 'edition 7 is gone', extensions: { code: 'EDITION_CHANGED' } }] } : { data: { topHeadlinesForCountry: { headlines: [{ clusterSize: 2, publisherCount: 2, cursor: 'c0@7', article: article('a') }], pageInfo: { endCursor: 'end', hasNextPage: true } } } },
  );
  const r = await run({ services });
  try {
    const c = await r.client();
    const first = json(await c.callTool({ name: 'top_stories', arguments: { limit: 3 } }));
    const res = json(await c.callTool({ name: 'top_stories', arguments: { after: first.nextCursor } }));
    assert.equal(res.code, undefined, JSON.stringify(res));
    assert.deepEqual(res.stories.map((s: { id: string }) => s.id), ['a']);
    assert.match(res.next, /^Keep the order given .* The top stories were made again since the last page, so this page starts again from the top, and a story already shown can come again\. Call top_stories with .*: 1 of the 3 asked for are still to come\.$/);
    assert.deepEqual(calls.map((b) => b.variables.after), [null, 'c0@7', null], 'the page after asked from the headline\'s own cursor, then the top');
    assert.doesNotMatch(JSON.stringify(res), /edition 7/);
  } finally {
    await r.stop();
  }
});

test('top_stories: a bad country is refused before anything is asked', async () => {
  const { calls, services } = stub(() => ({ data: null }));
  const res = await call(services, { country: 'nl' });
  assert.equal(res.isError, true);
  assert.equal(json(res).code, 'bad_input');
  assert.equal(calls.length, 0);
});

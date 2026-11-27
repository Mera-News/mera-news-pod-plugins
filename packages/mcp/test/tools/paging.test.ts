import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PodServices, ProfileStory, StoriesSummary } from 'mera-news-pod/plugin-api';
import { OLD_SERVER_NEXT } from '../../src/paging';
import { deliveringSuggestions, fakeNews, fakeServices, json, pick, run, walk } from './helpers';

// Long headlines, so a page of 100 is cut by the reply cap and the cut pages must go on exactly.
const LONG = 400;
const ids = (key: string) => (reply: any) => reply[key].map((x: { id: string }) => x.id);

for (const [name, args, key] of [
  ['top_stories', { limit: 1000 }, 'stories'],
  ['latest_news', { limit: 1000 }, 'results'],
  ['search_news', { query: 'storm', limit: 1000 }, 'results'],
] as const) {
  test(`${name}: limit 1000 walked by each reply's next gives every item once, within the cap and the server's page limits`, async () => {
    const news = fakeNews({ titleLength: LONG });
    const r = await run({ services: news.services });
    try {
      const { seen, cuts, calls, last } = await walk(await r.client(), name, args, ids(key), 1000);
      assert.deepEqual(news.over, [], 'no request over the server\'s limits');
      assert.ok(cuts > 0, 'the cap cut some pages');
      assert.equal(seen.length, 1000);
      assert.deepEqual(seen, news.ids, 'every item once, in order, with no gap');
      assert.equal('next' in last, false);
      assert.ok(calls <= 30, `${calls} calls`);
    } finally {
      await r.stop();
    }
  });

  test(`${name}: an older news server answers its first page, says paging needs a newer one, and is not asked the new query again`, async () => {
    const news = fakeNews({ old: true, oldCode: name === 'search_news' ? 'NOT_IN_LOCAL_MODE' : 'GRAPHQL_VALIDATION_FAILED' });
    const r = await run({ services: news.services });
    try {
      const c = await r.client();
      const paged = (q: string) => /searchNewsPage|itemCursors|publisherCount/.test(q);
      for (let i = 0; i < 2; i++) {
        const reply = json(await c.callTool({ name, arguments: args }));
        assert.ok(reply[key].length > 0, JSON.stringify(reply).slice(0, 300));
        assert.equal(reply.next, OLD_SERVER_NEXT);
        assert.equal('nextCursor' in reply, false);
      }
      const first = news.calls.filter((b) => b.operationName !== 'ClusterMembershipsForArticles' && b.operationName !== 'GetArticlesForTopicsByIds');
      assert.deepEqual(first.map((b) => paged(b.query)), [true, false, false], 'the new query once, then the old one');
      assert.deepEqual(news.over, []);
    } finally {
      await r.stop();
    }
  });
}

test('the fake news server refuses a request over the real server\'s limits', async () => {
  const { services, over } = fakeNews({ count: 600 });
  const ask = (operationName: string, query: string, variables: object) => services.news.graphql({ operationName, query, variables }) as Promise<any>;
  const many = (n: number) => Array.from({ length: n }, (_, i) => `a${String(i).padStart(4, '0')}`);
  assert.ok((await ask('GetArticlesForTopicsByIds', '', { articleIds: many(51) })).errors);
  assert.ok((await ask('ClusterMembershipsForArticles', '', { articleIds: many(501) })).errors);
  assert.ok((await ask('GetTopHeadlinesForCountry', 'publisherCount', { first: 201 })).errors);
  assert.ok((await ask('GetTopHeadlinesForCountry', 'publisherCount', { first: 0 })).errors);
  assert.ok((await ask('GetArticlesForCountry', 'itemCursors', { first: 51 })).errors);
  assert.ok((await ask('SearchNews', 'searchNewsPage', { limit: 101 })).errors);
  assert.ok((await ask('SearchNews', 'searchNews', { limit: 26 })).errors);
  assert.equal(over.length, 7);
  assert.ok((await ask('GetArticlesForTopicsByIds', '', { articleIds: many(50) })).data);
});

test('get_suggestions: limit 1000 walked by each reply\'s next gives every pick once, within the cap', async () => {
  const picks = Array.from({ length: 1000 }, (_, i) => ({ ...pick(i), reason: `Reason ${i}: ${'words '.repeat(60)}` }));
  const r = await run({ services: fakeServices({ suggestions: deliveringSuggestions(picks) }) });
  try {
    const { seen, calls } = await walk(await r.client(), 'get_suggestions', { limit: 1000 }, (reply) => reply.picks.map((p: { id: string }) => p.id), 1000);
    assert.deepEqual(seen, picks.map((p) => p.id));
    assert.ok(calls > 10, `${calls} calls`);
  } finally {
    await r.stop();
  }
});

test('get_suggestions: a cursor in the pod\'s own form, as older replies gave, still goes to the pod as it is', async () => {
  const seen: unknown[] = [];
  const all = deliveringSuggestions([pick(1), pick(2), pick(3)]);
  const r = await run({ services: fakeServices({ suggestions: { get: (o) => (seen.push(o.since), all.get(o)) } }) });
  try {
    const c = await r.client();
    const reply = json(await c.callTool({ name: 'get_suggestions', arguments: { since: 'e.1', limit: 1 } }));
    assert.deepEqual(reply.picks.map((p: { id: string }) => p.id), ['p2']);
    assert.equal(reply.remaining, undefined, 'the one asked for was given');
    const next = json(await c.callTool({ name: 'get_suggestions', arguments: { since: reply.cursor } }));
    assert.deepEqual(next.picks.map((p: { id: string }) => p.id), ['p3']);
    assert.deepEqual(seen, ['e.1', 'e.2']);
  } finally {
    await r.stop();
  }
});

const summary: StoriesSummary = { windowHours: 48, articles: 1000, stories: 1000, merged: 0, topics: [{ text: 'storm', matches: 1000 }], facts: [{ id: 'f1', statement: 'Lives in Utrecht', matched: 1000, picked: 0, leftOut: 0 }], picked: 0, leftOut: 0, unjudged: 1000, publishers: 7, languages: 1, complete: true };
const story = (i: number): ProfileStory => ({
  id: `s${String(i).padStart(4, '0')}`,
  story: `k${i}`,
  title: `Verhaal ${i} ${'w'.repeat(LONG)}`,
  link: `https://news.example/${i}`,
  publisher: 'De Krant',
  publishedAt: '2026-01-01T00:00:00.000Z',
  language: 'nl',
  reports: 1,
  facts: [{ id: 'f1', statement: 'Lives in Utrecht' }],
  topics: ['storm'],
});

test('news_for_profile: limit 1000 walked by each reply\'s next gives every story once, against the pod\'s page of at most 1000', async () => {
  const all = Array.from({ length: 1000 }, (_, i) => story(i));
  const forProfile: PodServices['stories']['forProfile'] = async (o = {}) => {
    if ((o.limit ?? 20) > 1000) throw Object.assign(new Error('limit must be a whole number from 0 to 1000.'), { code: 'bad_input', next: 'pass a smaller limit' });
    const from = o.after ? Number(o.after.split('.')[1]) : 0;
    let page = all.slice(from, from + (o.limit ?? 20));
    while (o.fits && page.length > 1 && !o.fits(page, summary)) page = page.slice(0, -1);
    const end = from + page.length;
    return { run: 'run', summary, stories: page, ...(end < all.length ? { nextCursor: `run.${end}` } : {}), shownBefore: 0 };
  };
  const r = await run({ services: fakeServices({ stories: { forProfile } }) });
  try {
    const { seen } = await walk(await r.client(), 'news_for_profile', { limit: 1000 }, (page) => page.toJudge.flatMap((g: any) => g.stories.map((x: { id: string }) => x.id)), 1000);
    assert.deepEqual(seen, all.map((s) => s.id));
  } finally {
    await r.stop();
  }
});

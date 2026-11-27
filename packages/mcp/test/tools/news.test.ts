import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_CHARS, MAX_TOKENS } from '../../src/reply';
import { estimate, fakeServices, json, run, walk } from './helpers';

type Body = { operationName: string; query: string; variables: Record<string, any> };
const NEXT = 'try again later; if it keeps failing, call get_status, which names what to fix';

const article = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Original title ${id}`,
  title_en: `English title ${id}`,
  article_url: `https://news.example/${id}`,
  pubDate: '2026-01-02T03:04:05.000Z',
  original_language_code: 'nl',
  publicationSource: { publication_name: 'The Paper' },
  description: 'SECRET BODY TEXT',
  image_url: 'https://img.example/x.png',
  entities: ['x'],
  ...over,
});

/** The same article as the by-ids query shapes it. */
const byIds = (id: string, over: Record<string, unknown> = {}) => {
  const { original_language_code, publicationSource, ...rest } = article(id);
  return { ...rest, language_code: original_language_code, publication_name: publicationSource.publication_name, ...over };
};

/** A news.graphql stub that records each request and answers by operation name. */
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

async function callWith(services: ReturnType<typeof fakeServices>, name: string, args: Record<string, unknown>) {
  const r = await run({ services });
  try {
    const c = await r.client();
    return await c.callTool({ name, arguments: args });
  } finally {
    await r.stop();
  }
}

test('search_news: sends SearchNews, GetArticlesForTopicsByIds and the story lookup, and returns only the named fields in rank order', async () => {
  const { calls, services } = stub((b) =>
    b.operationName === 'SearchNews'
      ? { data: { searchNewsPage: { hits: [{ _id: 'b' }, { _id: 'gone' }, { _id: 'a' }], nextCursor: null } } }
      : { data: { articlesForTopicsByIds: { articles: [byIds('a'), byIds('b')] } } },
  );
  const res = await callWith(services, 'search_news', { query: '  tram  ', limit: 5 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => c.operationName), ['SearchNews', 'GetArticlesForTopicsByIds', 'ClusterMembershipsForArticles']);
  assert.match(calls[0].query, /searchNewsPage\(/);
  assert.deepEqual(calls[0].variables, { query: 'tram', limit: 5, after: null });
  assert.deepEqual(calls[1].variables, { articleIds: ['b', 'gone', 'a'] });
  const body = json(res);
  assert.deepEqual(body.results.map((x: any) => x.title), ['Original title b', 'Original title a']);
  assert.deepEqual(Object.keys(body.results[0]).sort(), ['id', 'language', 'link', 'publishedAt', 'publisher', 'show', 'title', 'title_en']);
  assert.equal(body.results[0].id, 'b');
  assert.equal(body.results[0].language, 'nl');
  assert.doesNotMatch(JSON.stringify(body), /SECRET|img\.example/);
});

test('search_news: no hits makes one call and returns no results', async () => {
  const { calls, services } = stub(() => ({ data: { searchNewsPage: { hits: [], nextCursor: null } } }));
  const res = await callWith(services, 'search_news', { query: 'nothing' });
  assert.equal(calls.length, 1);
  const { next, ...rest } = json(res);
  assert.deepEqual(rest, { results: [] });
  assert.match(next, /Show each story by its show line/);
  assert.equal(calls[0].variables.limit, 20, 'the default total');
});

test('latest_news: asks for the newest with the country and limit, and its cursor carries the server\'s and the rest of the limit', async () => {
  let more = true;
  const { calls, services } = stub(() => ({
    data: { articlesForCountry: { articles: [article('a', { title: '', publicationSource: null, original_language_code: null })], itemCursors: ['ca'], pageInfo: { endCursor: 'end-a', hasNextPage: more } } },
  }));
  const r = await run({ services });
  try {
    const c = await r.client();
    const body = json(await c.callTool({ name: 'latest_news', arguments: { country: 'GBR', limit: 3 } }));
    assert.equal(calls[0].operationName, 'GetArticlesForCountry');
    assert.deepEqual(calls[0].variables, { countryCode: 'GBR', first: 3, after: null, order: 'NEWEST' });
    // With no publisher name, the show line names the publisher's site.
    assert.deepEqual(body.results[0], { id: 'a', title: 'English title a', link: 'https://news.example/a', publisher: '', publishedAt: '2026-01-02T03:04:05.000Z', language: 'und', show: '[English title a](https://news.example/a) · news.example' });
    assert.equal(body.remaining, 2);
    assert.match(body.next, /^Keep the order given and show every story\. Show each story by its show line/);
    assert.ok(body.next.endsWith(`Call latest_news with ${JSON.stringify({ country: 'GBR', after: body.nextCursor })}: 2 of the 3 asked for are still to come.`));
    await c.callTool({ name: 'latest_news', arguments: { country: 'GBR', after: body.nextCursor } });
    assert.deepEqual(calls[1].variables, { countryCode: 'GBR', first: 2, after: 'end-a', order: 'NEWEST' }, 'a whole page goes on from its end');
    // A cursor made for one country is not used for another.
    const other = json(await c.callTool({ name: 'latest_news', arguments: { country: 'NLD', after: body.nextCursor } }));
    assert.equal(other.code, 'bad_input');
    assert.equal(calls.length, 2);
    more = false;
    const last = json(await c.callTool({ name: 'latest_news', arguments: {} }));
    assert.equal('nextCursor' in last, false);
    assert.equal('remaining' in last, false);
    assert.doesNotMatch(last.next, /Call /);
    assert.deepEqual(calls[2].variables, { countryCode: null, first: 20, after: null, order: 'NEWEST' });
  } finally {
    await r.stop();
  }
});

test('news tools: a result without an http(s) link is left out', async () => {
  const { services } = stub((b) =>
    b.operationName === 'GetArticlesForCountry'
      ? { data: { articlesForCountry: { articles: [article('a', { article_url: 'javascript:alert(1)' }), article('b'), article('c', { article_url: 'http://ok.example/c' })], pageInfo: { endCursor: 'c', hasNextPage: false } } } }
      : b.operationName === 'SearchNews'
        ? { data: { searchNewsPage: { hits: [{ _id: 'a' }, { _id: 'b' }], nextCursor: null } } }
        : { data: { articlesForTopicsByIds: { articles: [byIds('a', { article_url: 'ftp://x' }), byIds('b')] } } },
  );
  assert.deepEqual(json(await callWith(services, 'latest_news', {})).results.map((x: any) => x.id), ['b', 'c']);
  assert.deepEqual(json(await callWith(services, 'search_news', { query: 'q' })).results.map((x: any) => x.id), ['b']);
});

test('news tools: a store error becomes news_unavailable without its text; a bad cursor is bad_input', async () => {
  const boom = stub((b) => ({ errors: [{ message: 'mongo at 10.0.0.5 exploded', extensions: { code: b.operationName === 'GetArticlesForCountry' ? 'INTERNAL' : 'X' } }] }));
  for (const [name, args] of [['search_news', { query: 'q' }], ['latest_news', {}]] as const) {
    const res = await callWith(boom.services, name, args);
    assert.equal(res.isError, true);
    assert.deepEqual(json(res), { code: 'news_unavailable', message: 'The news server could not answer.', next: NEXT });
  }
  const thrown = stub(() => {
    throw new Error('connect ECONNREFUSED 10.0.0.5');
  });
  const t = json(await callWith(thrown.services, 'latest_news', {}));
  assert.equal(t.code, 'news_unavailable');
  assert.doesNotMatch(JSON.stringify(t), /ECONNREFUSED/);
  // A cursor the tool did not make is refused before anything is asked, in each tool's own words.
  const cursor = stub(() => ({ errors: [{ message: 'after is not a cursor', extensions: { code: 'BAD_USER_INPUT' } }] }));
  for (const [name, args] of [['latest_news', { after: 'nope' }], ['search_news', { query: 'q', after: 'nope' }], ['top_stories', { after: 'nope' }], ['news_for_profile', { after: 'run.3' }], ['get_suggestions', { since: 'nope' }]] as const) {
    const res = await callWith(cursor.services, name, args);
    assert.equal(res.isError, true);
    const body = json(res);
    const field = name === 'get_suggestions' ? 'since' : 'after';
    assert.deepEqual(body, { code: 'bad_input', message: `The field "${field}" is not valid for ${name}.`, next: `call ${name} again without "${field}"` });
  }
  assert.equal(cursor.calls.length, 0);
  // A cursor of the tool's own that the server refuses is bad_input too, without the server's text.
  const first = stub(() => ({ data: { articlesForCountry: { articles: [article('a')], itemCursors: ['ca'], pageInfo: { endCursor: 'ca', hasNextPage: true } } } }));
  const mine = json(await callWith(first.services, 'latest_news', { limit: 2 })).nextCursor;
  for (const code of ['BAD_USER_INPUT', 'BAD_REQUEST']) {
    const refusing = stub(() => ({ errors: [{ message: 'after is not a cursor', extensions: { code } }] }));
    const res = json(await callWith(refusing.services, 'latest_news', { after: mine }));
    assert.deepEqual(res, { code: 'bad_input', message: 'The field "after" is not valid for latest_news.', next: 'call latest_news again without "after"' }, code);
  }
  // Without a cursor the same code is the server's fault, not the caller's.
  assert.equal(json(await callWith(cursor.services, 'latest_news', {})).code, 'news_unavailable');
});

test('news tools: bad input (empty query, limit 10001, country "gb", country "GB") is bad_input', async () => {
  const { calls, services } = stub(() => ({ data: {} }));
  const cases: [string, Record<string, unknown>, string][] = [
    ['search_news', { query: '   ' }, 'query'],
    ['search_news', {}, 'query'],
    ['search_news', { query: 'x'.repeat(201) }, 'query'],
    ['search_news', { query: 'q', limit: 10001 }, 'limit'],
    ['top_stories', { limit: 10001 }, 'limit'],
    ['latest_news', { limit: 0 }, 'limit'],
    ['latest_news', { country: 'gb' }, 'country'],
    ['latest_news', { country: 'GB' }, 'country'],
    ['latest_news', { after: 'x'.repeat(2001) }, 'after'],
  ];
  const r = await run({ services });
  try {
    const c = await r.client();
    for (const [name, args, field] of cases) {
      const res = await c.callTool({ name, arguments: args });
      assert.equal(res.isError, true, `${name} ${JSON.stringify(args)}`);
      const body = json(res);
      assert.equal(body.code, 'bad_input');
      assert.ok(body.message.includes(`"${field}"`), body.message);
    }
  } finally {
    await r.stop();
  }
  assert.equal(calls.length, 0);
});

test('news tools: a large page stays under the reply cap, and a cut page goes on from its last kept article\'s own cursor', async () => {
  const big = Array.from({ length: 50 }, (_, i) => article(`n${i}`, { title: 'T'.repeat(2000), article_url: `https://news.example/${i}/${'u'.repeat(1900)}`, publicationSource: { publication_name: 'P'.repeat(1000) } }));
  const { calls, services } = stub(() => ({ data: { articlesForCountry: { articles: big, itemCursors: big.map((a) => `c-${a._id}`), pageInfo: { endCursor: 'n49', hasNextPage: true } } } }));
  const r = await run({ services });
  try {
    const c = await r.client();
    const res = await c.callTool({ name: 'latest_news', arguments: { limit: 50 } });
    assert.equal(res.isError, undefined);
    const text = (res.content as { text: string }[])[0].text;
    assert.ok(estimate(text) <= MAX_TOKENS && text.length <= MAX_CHARS, `reply is ${text.length} characters`);
    const body = JSON.parse(text);
    const kept = body.results.length;
    assert.ok(kept > 0 && kept < 50);
    assert.equal(body.results[0].title.length, 500);
    assert.equal(body.truncated, true);
    assert.equal(body.remaining, 50 - kept);
    assert.equal(calls.length, 2, 'no second ask for a shorter page');
    await c.callTool({ name: 'latest_news', arguments: { after: body.nextCursor } });
    assert.equal(calls[2].variables.after, `c-n${kept - 1}`);
    assert.equal(calls[2].variables.first, 50 - kept);
  } finally {
    await r.stop();
  }
});

test('latest_news: a page cut to fit still continues, and paging returns every article exactly once', async () => {
  // Long links make each result large, so a full page of 25 is far over the reply cap.
  const all = Array.from({ length: 60 }, (_, i) => article(`a${String(i).padStart(2, '0')}`, { article_url: `https://news.example/${'x'.repeat(1900)}/${i}` }));
  const { services } = stub((b) => {
    if (b.operationName !== 'GetArticlesForCountry') return { data: null };
    const { first, after } = b.variables;
    const start = after === null ? 0 : all.findIndex((a) => a._id === after) + 1;
    const page = all.slice(start, start + first);
    return { data: { articlesForCountry: { articles: page, itemCursors: page.map((a) => a._id), pageInfo: { endCursor: page.at(-1)?._id ?? null, hasNextPage: start + page.length < all.length } } } };
  });
  const r = await run({ services });
  try {
    const { seen, cuts } = await walk(await r.client(), 'latest_news', { limit: 60 }, (reply) => reply.results.map((x: { id: string }) => x.id), 60);
    assert.ok(cuts > 0, 'the cap cut at least one page');
    assert.deepEqual(seen, all.map((a) => a._id), 'every article once, in order');
  } finally {
    await r.stop();
  }
});

test('news tools: reports of one event share a story, and a headline in another language carries its English title', async () => {
  const clusters = { a: 's-tram', b: 's-tram', c: 's-strike' };
  const { calls, services } = stub((b) => {
    if (b.operationName === 'ClusterMembershipsForArticles') {
      return {
        data: {
          clusterMembershipsForArticles: (b.variables.articleIds as string[]).map((id) => ({
            articleId: id,
            clusters: [
              { clusterId: `weak-${id}`, stableClusterId: null, confidence: 0.2 },
              { clusterId: `c-${id}`, stableClusterId: clusters[id as keyof typeof clusters], confidence: 0.9 },
            ],
          })),
        },
      };
    }
    return { data: { articlesForCountry: { articles: [article('a'), article('b', { title_en: 'Original title b' }), article('c')], itemCursors: ['a', 'b', 'c'], pageInfo: { hasNextPage: false } } } };
  });
  const body = json(await callWith(services, 'latest_news', {}));
  assert.deepEqual(calls.map((c) => c.operationName), ['GetArticlesForCountry', 'ClusterMembershipsForArticles']);
  assert.deepEqual(
    body.results.map((x: any) => [x.id, x.story, x.title_en]),
    [
      ['a', 's-tram', 'English title a'],
      ['b', 's-tram', undefined],
      ['c', undefined, 'English title c'],
    ],
  );
  // Two results of one story in this reply: each show line says one other report.
  assert.deepEqual(body.results.map((x: any) => x.show.replace(/^.*\) · /, '')), ['The Paper +1 report', 'The Paper +1 report', 'The Paper']);
});

test('news tools: a news server that cannot group still answers with the plain list', async () => {
  const { services } = stub((b) =>
    b.operationName === 'ClusterMembershipsForArticles'
      ? { errors: [{ extensions: { code: 'NOT_IMPLEMENTED' } }] }
      : { data: { articlesForCountry: { articles: [article('a'), article('b')], itemCursors: ['a', 'b'], pageInfo: { hasNextPage: false } } } },
  );
  const body = json(await callWith(services, 'latest_news', {}));
  assert.deepEqual(body.results.map((x: any) => [x.id, x.story]), [['a', undefined], ['b', undefined]]);
});

test('news tools: a refused Mera News key says where the person fixes it, never asking for the key in the chat', async () => {
  const { services } = stub(() => ({ errors: [{ message: 'Invalid API key', extensions: { code: 'UNAUTHENTICATED' } }], data: null }));
  const res = json(await callWith(services, 'search_news', { query: 'tram' }));
  assert.equal(res.code, 'key_refused');
  assert.match(res.next, /settings/);
  assert.match(res.next, /never ask/i);
  assert.doesNotMatch(JSON.stringify(res), /Invalid API key/);
});

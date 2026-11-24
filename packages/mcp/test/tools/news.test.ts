import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeServices, json, run } from './helpers';

type Body = { operationName: string; variables: Record<string, any> };
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
      ? { data: { searchNews: [{ _id: 'b' }, { _id: 'gone' }, { _id: 'a' }] } }
      : { data: { articlesForTopicsByIds: { articles: [byIds('a'), byIds('b')] } } },
  );
  const res = await callWith(services, 'search_news', { query: '  tram  ', limit: 5 });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => c.operationName), ['SearchNews', 'GetArticlesForTopicsByIds', 'ClusterMembershipsForArticles']);
  assert.deepEqual(calls[0].variables, { query: 'tram', limit: 5 });
  assert.deepEqual(calls[1].variables, { articleIds: ['b', 'gone', 'a'] });
  const body = json(res);
  assert.deepEqual(body.results.map((x: any) => x.title), ['Original title b', 'Original title a']);
  assert.deepEqual(Object.keys(body.results[0]).sort(), ['id', 'language', 'link', 'publishedAt', 'publisher', 'title', 'title_en']);
  assert.equal(body.results[0].id, 'b');
  assert.equal(body.results[0].language, 'nl');
  assert.doesNotMatch(JSON.stringify(body), /SECRET|img\.example/);
});

test('search_news: no hits makes one call and returns no results', async () => {
  const { calls, services } = stub(() => ({ data: { searchNews: [] } }));
  const res = await callWith(services, 'search_news', { query: 'nothing' });
  assert.equal(calls.length, 1);
  assert.deepEqual(json(res), { results: [] });
  assert.equal(calls[0].variables.limit, 10);
});

test('latest_news: passes country, limit and after, and returns nextCursor only when there is a next page', async () => {
  let more = true;
  const { calls, services } = stub(() => ({
    data: { articlesForCountry: { articles: [article('a', { title: '', publicationSource: null, original_language_code: null })], pageInfo: { endCursor: 'a', hasNextPage: more } } },
  }));
  const res = await callWith(services, 'latest_news', { country: 'GBR', limit: 3, after: 'z' });
  assert.equal(calls[0].operationName, 'GetArticlesForCountry');
  assert.deepEqual(calls[0].variables, { countryCode: 'GBR', first: 3, after: 'z' });
  const body = json(res);
  assert.equal(body.nextCursor, 'a');
  assert.deepEqual(body.results[0], { id: 'a', title: 'English title a', link: 'https://news.example/a', publisher: '', publishedAt: '2026-01-02T03:04:05.000Z', language: 'und' });
  more = false;
  const last = json(await callWith(services, 'latest_news', {}));
  assert.equal('nextCursor' in last, false);
  assert.deepEqual(calls[1].variables, { countryCode: null, first: 10, after: null });
});

test('news tools: a result without an http(s) link is left out', async () => {
  const { services } = stub((b) =>
    b.operationName === 'GetArticlesForCountry'
      ? { data: { articlesForCountry: { articles: [article('a', { article_url: 'javascript:alert(1)' }), article('b'), article('c', { article_url: 'http://ok.example/c' })], pageInfo: { endCursor: 'c', hasNextPage: false } } } }
      : b.operationName === 'SearchNews'
        ? { data: { searchNews: [{ _id: 'a' }, { _id: 'b' }] } }
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
  const cursor = stub(() => ({ errors: [{ message: 'after is not a cursor', extensions: { code: 'BAD_USER_INPUT' } }] }));
  const res = await callWith(cursor.services, 'latest_news', { after: 'nope' });
  assert.equal(res.isError, true);
  const body = json(res);
  assert.equal(body.code, 'bad_input');
  assert.ok(body.message.includes('"after"'), body.message);
  assert.doesNotMatch(JSON.stringify(body), /not a cursor/);
});

test('news tools: bad input (empty query, limit 26, country "gb", country "GB") is bad_input', async () => {
  const { calls, services } = stub(() => ({ data: {} }));
  const cases: [string, Record<string, unknown>, string][] = [
    ['search_news', { query: '   ' }, 'query'],
    ['search_news', {}, 'query'],
    ['search_news', { query: 'x'.repeat(201) }, 'query'],
    ['search_news', { query: 'q', limit: 26 }, 'limit'],
    ['latest_news', { limit: 0 }, 'limit'],
    ['latest_news', { country: 'gb' }, 'country'],
    ['latest_news', { country: 'GB' }, 'country'],
    ['latest_news', { after: 'x'.repeat(201) }, 'after'],
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

test('news tools: a large page stays under the reply cap', async () => {
  const big = Array.from({ length: 25 }, (_, i) => article(`n${i}`, { title: 'T'.repeat(2000), article_url: `https://news.example/${i}/${'u'.repeat(1900)}`, publicationSource: { publication_name: 'P'.repeat(1000) } }));
  const { services } = stub(() => ({ data: { articlesForCountry: { articles: big, pageInfo: { endCursor: 'n24', hasNextPage: true } } } }));
  const res = await callWith(services, 'latest_news', { limit: 25 });
  assert.equal(res.isError, undefined);
  const text = (res.content as { text: string }[])[0].text;
  assert.ok(Math.ceil(text.length / 4) <= 6000, `reply is ${text.length / 4} tokens`);
  const body = JSON.parse(text);
  assert.ok(body.results.length > 0 && body.results.length < 25);
  assert.equal(body.results[0].title.length, 500);
  // A cut page still offers a cursor, from asking again for only the articles that fit.
  assert.equal(body.truncated, true);
  assert.ok(body.nextCursor);
});

test('latest_news: a page cut to fit still continues, and paging returns every article exactly once', async () => {
  // Long links make each result large, so a full page of 25 is far over the reply cap.
  const all = Array.from({ length: 60 }, (_, i) => article(`a${String(i).padStart(2, '0')}`, { article_url: `https://news.example/${'x'.repeat(1900)}/${i}` }));
  const { services } = stub((b) => {
    const { first, after } = b.variables;
    const start = after === null ? 0 : all.findIndex((a) => a._id === after) + 1;
    const page = all.slice(start, start + first);
    return { data: { articlesForCountry: { articles: page, pageInfo: { endCursor: page.at(-1)?._id ?? null, hasNextPage: start + page.length < all.length } } } };
  });
  const r = await run({ services });
  try {
    const c = await r.client();
    const seen: string[] = [];
    let after: string | undefined;
    let cuts = 0;
    for (let call = 0; call < 40; call++) {
      const reply = json(await c.callTool({ name: 'latest_news', arguments: { limit: 25, ...(after ? { after } : {}) } }));
      seen.push(...reply.results.map((x: { id: string }) => x.id));
      if (reply.truncated) cuts++;
      after = reply.nextCursor;
      if (!after) break;
    }
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
    return { data: { articlesForCountry: { articles: [article('a'), article('b', { title_en: 'Original title b' }), article('c')], pageInfo: { hasNextPage: false } } } };
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
});

test('news tools: a news server that cannot group still answers with the plain list', async () => {
  const { services } = stub((b) =>
    b.operationName === 'ClusterMembershipsForArticles'
      ? { errors: [{ extensions: { code: 'NOT_IMPLEMENTED' } }] }
      : { data: { articlesForCountry: { articles: [article('a'), article('b')], pageInfo: { hasNextPage: false } } } },
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

import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { FactView } from 'mera-news-pod/plugin-api';
import { estimate, fakeServices, json, run, status } from './helpers';

type Body = { operationName: string; variables: Record<string, any> };

const fact = (id: string, statement: string, topics: string[]): FactView => ({
  id,
  statement,
  topicsStatus: 'done',
  addedAt: '2026-01-01T00:00:00.000Z',
  topics: topics.map((text, i) => ({ id: `${id}-t${i}`, text, weight: 0, source: 'generated' as const })),
});
const FACTS = [fact('f1', 'Lives in Utrecht with two children', ['utrecht council', 'utrecht trams']), fact('f2', 'Works night shifts as a nurse', ['nurse pay', 'Utrecht Council'])];
const ARTICLES: Record<string, string[]> = { 'utrecht council': ['a1', 'a2'], 'utrecht trams': ['a3', 'a1'], 'nurse pay': ['a4', 'a5', 'a6'] };

/** A news server that answers the persona query from ARTICLES, and records every request. */
function newsServer(link = (id: string) => `https://news.example/${id}`) {
  const calls: Body[] = [];
  const graphql = async (raw: unknown) => {
    const b = raw as Body;
    calls.push(b);
    if (b.operationName === 'GetArticleIdsForPersona') {
      return { data: { articleIdsForPersona: { topicResults: b.variables.query.topics.map((t: { text: string }) => ({ topicText: t.text, articleIds: ARTICLES[t.text.toLowerCase()] ?? [] })) } } };
    }
    if (b.operationName === 'GetArticlesForTopicsByIds') {
      return { data: { articlesForTopicsByIds: { articles: b.variables.articleIds.map((id: string) => ({ _id: id, title: `Story ${id}`, article_url: link(id), language_code: 'nl', publication_name: 'De Krant', description: 'SECRET BODY TEXT' })) } } };
    }
    return { data: { clusterMembershipsForArticles: [] } };
  };
  return { calls, graphql };
}

test('news_for_profile: sends only topic texts, groups by fact, and never shows a story twice', async () => {
  const news = newsServer();
  const r = await run({ services: fakeServices({ profile: { get: async () => ({ facts: FACTS }) }, news }) });
  try {
    const c = await r.client();
    const first = json(await c.callTool({ name: 'news_for_profile', arguments: { limit: 4 } }));
    const persona = news.calls[0];
    assert.equal(persona.operationName, 'GetArticleIdsForPersona');
    // The same topic of two facts goes once; the query has no date and no fact.
    assert.deepEqual(persona.variables.query, { limitPerTopic: 5, maxArticles: 150, topics: [{ text: 'utrecht council' }, { text: 'utrecht trams' }, { text: 'nurse pay' }] });
    const sent = JSON.stringify(news.calls);
    for (const f of FACTS) assert.ok(!sent.includes(f.statement), `the fact "${f.statement}" left the computer`);
    assert.doesNotMatch(sent, /Lives in|Works night/);

    // Round robin: each topic's best match first, then the second best.
    assert.deepEqual(first.groups.map((g: any) => [g.factId, g.fact, g.results.map((x: any) => x.id)]), [
      ['f1', 'Lives in Utrecht with two children', ['a1', 'a3', 'a2']],
      ['f2', 'Works night shifts as a nurse', ['a4']],
    ]);
    assert.deepEqual(Object.keys(first.groups[0].results[0]).sort(), ['id', 'language', 'link', 'publishedAt', 'publisher', 'title']);
    assert.doesNotMatch(JSON.stringify(first), /SECRET BODY TEXT/);

    const second = json(await c.callTool({ name: 'news_for_profile', arguments: {} }));
    assert.deepEqual(second.groups.flatMap((g: any) => g.results.map((x: any) => x.id)), ['a5', 'a6']);
    const third = json(await c.callTool({ name: 'news_for_profile', arguments: {} }));
    assert.deepEqual(third.groups, []);
    assert.match(third.hint, /No new stories/);

    const file = path.join(r.home, 'data', 'plugins', 'mcp', 'delivered.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
  } finally {
    await r.stop();
  }
});

test('news_for_profile: a story shown more than 72 hours ago may come back', async () => {
  const news = newsServer();
  const r = await run({ services: fakeServices({ profile: { get: async () => ({ facts: [fact('f2', 'Works night shifts as a nurse', ['nurse pay'])] }) }, news }) });
  try {
    const file = path.join(r.home, 'data', 'plugins', 'mcp', 'delivered.json');
    writeFileSync(file, JSON.stringify({ a4: Date.now() - 73 * 3600_000, a5: Date.now() - 71 * 3600_000 }));
    const c = await r.client();
    const got = json(await c.callTool({ name: 'news_for_profile', arguments: {} }));
    assert.deepEqual(got.groups[0].results.map((x: any) => x.id), ['a4', 'a6']);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['a4', 'a5', 'a6']);
  } finally {
    await r.stop();
  }
});

test('news_for_profile: a reply cut to fit counts only what it carries as shown', async () => {
  const many = fact('f9', 'Follows the local news', ['local news']);
  ARTICLES['local news'] = Array.from({ length: 25 }, (_, i) => `b${i}`);
  const news = newsServer((id) => `https://news.example/${id}/${'x'.repeat(1900)}`);
  const r = await run({ services: fakeServices({ profile: { get: async () => ({ facts: [many] }) }, news }) });
  try {
    const c = await r.client();
    const ids: string[] = [];
    for (let calls = 0; ; calls++) {
      assert.ok(calls < 10);
      const res = await c.callTool({ name: 'news_for_profile', arguments: { limit: 25 } });
      assert.ok(estimate(((res.content as any[])[0]).text) <= 6000);
      const got = json(res);
      if (got.groups.length === 0) break;
      if (calls === 0) assert.equal(got.truncated, true);
      ids.push(...got.groups[0].results.map((x: any) => x.id));
    }
    assert.deepEqual(ids, ARTICLES['local news'], 'every story arrived once, in order');
  } finally {
    delete ARTICLES['local news'];
    await r.stop();
  }
});

test('news_for_profile: no topics yet asks for them, without a request', async () => {
  const news = newsServer();
  const r = await run({ services: fakeServices({ profile: { get: async () => ({ facts: [fact('f1', 'Lives in Utrecht', [])] }) }, news }) });
  try {
    const c = await r.client();
    const got = json(await c.callTool({ name: 'news_for_profile', arguments: {} }));
    assert.deepEqual(got.groups, []);
    assert.match(got.hint, /add_facts again/);
    assert.equal(news.calls.length, 0);
  } finally {
    await r.stop();
  }
});

test('add_facts: topics go to new and already saved facts, never to a refused one, and the note fits the pod', async () => {
  const given: [string, string[]][] = [];
  const profile = {
    addFacts: async (s: string[]) => ({
      added: [{ id: 'f1', statement: s[0].trim() }],
      already: [{ id: 'f2', statement: 'works as a nurse' }],
      refused: [{ statement: s[2], code: 'conflict' as const, conflictsWith: { id: 'f2', statement: 'x' }, next: 'remove f2' }],
    }),
    addTopics: async (id: string, texts: string[]) => {
      given.push([id, texts]);
      if (id === 'f2') throw Object.assign(new Error('Topic 1 is longer than 80 characters.'), { code: 'bad_topics', next: 'shorten it' });
      return { added: texts.map((text, i) => ({ id: `t${i}`, text })), skipped: [] };
    },
  };
  let ai: { host: string; model: string } | null = null;
  const r = await run({ services: fakeServices({ profile, reading: { status: async () => status({ ai, counts: { facts: 2, topics: 0, topicsPending: 0, picks: 0 } }) } }) });
  try {
    const c = await r.client();
    const res = json(
      await c.callTool({
        name: 'add_facts',
        arguments: { statements: [{ statement: ' Lives in Utrecht ', topics: ['Utrecht council', 'Utrecht trams'] }, { statement: 'Works as a nurse', topics: ['nurse pay'] }, { statement: 'Lives in Paris', topics: ['Paris'] }] },
      }),
    );
    assert.deepEqual(given, [['f1', ['Utrecht council', 'Utrecht trams']], ['f2', ['nurse pay']]]);
    assert.deepEqual(res.topics, [{ factId: 'f1', added: [{ id: 't0', text: 'Utrecht council' }, { id: 't1', text: 'Utrecht trams' }], skipped: [] }, { factId: 'f2', error: 'Topic 1 is longer than 80 characters.' }]);
    assert.equal(res.note, 'Call get_profile to see the topics.');
    assert.deepEqual(JSON.parse(readFileSync(path.join(r.home, 'data', 'plugins', 'mcp', 'hint.json'), 'utf8')), { facts: 2 });

    const bare = json(await c.callTool({ name: 'add_facts', arguments: { statements: ['Lives in Utrecht'] } }));
    assert.match(bare.note, /makes no topics on its own/, 'no AI service: the assistant is asked for topics');
    assert.doesNotMatch(bare.note, /minute/);
    ai = { host: 'ai.example', model: 'm' };
    assert.match(json(await c.callTool({ name: 'add_facts', arguments: { statements: ['Lives in Utrecht'] } })).note, /within a minute or two/);

    const bad = json(await c.callTool({ name: 'add_facts', arguments: { statements: [{ statement: 'x', topics: Array(13).fill('t') }] } }));
    assert.equal(bad.code, 'bad_input');
  } finally {
    await r.stop();
  }
});

test('digest: set_reading saves the times, get_status says when one is due, digest_done clears it', async () => {
  const set: unknown[] = [];
  const r = await run({ services: fakeServices({ reading: { set: async (c) => (set.push(c), status()) } }) });
  try {
    const c = await r.client();
    const file = path.join(r.home, 'data', 'plugins', 'mcp', 'digest.json');
    const saved = json(await c.callTool({ name: 'set_reading', arguments: { digestTimes: ['18:00', '07:30', '07:30'], digestEveryMinutes: 90 } }));
    assert.deepEqual(saved.digest, { times: ['07:30', '18:00'], everyMinutes: 90, due: false });
    assert.deepEqual(set, [], 'only the digest changed, so the pod was not asked to change reading');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const lastAt = JSON.parse(readFileSync(file, 'utf8')).lastAt;
    assert.ok(Math.abs(Date.parse(lastAt) - Date.now()) < 60_000, 'the schedule starts from now');

    // A digest missed while the app was closed is due once.
    writeFileSync(file, JSON.stringify({ times: ['07:30'], lastAt: new Date(Date.now() - 3 * 86400_000).toISOString() }));
    assert.deepEqual(json(await c.callTool({ name: 'get_status', arguments: {} })).digest, { times: ['07:30'], everyMinutes: null, due: true });
    assert.equal(json(await c.callTool({ name: 'digest_done', arguments: {} })).digest.due, false);
    assert.equal(json(await c.callTool({ name: 'get_status', arguments: {} })).digest.due, false);

    const off = json(await c.callTool({ name: 'set_reading', arguments: { digestTimes: [], digestEveryMinutes: null, paused: true } }));
    assert.deepEqual(off.digest, { times: [], everyMinutes: null, due: false });
    assert.deepEqual(set, [{ paused: true }]);
    for (const args of [{ digestTimes: ['7:30'] }, { digestTimes: ['24:00'] }, { digestEveryMinutes: 0 }]) {
      assert.equal(json(await c.callTool({ name: 'set_reading', arguments: args })).code, 'bad_input', JSON.stringify(args));
    }
  } finally {
    await r.stop();
  }
});

test('the plugin notes the fact count at start for the session hint, and nothing else', async () => {
  const r = await run({ services: fakeServices({ reading: { status: async () => status({ counts: { facts: 0, topics: 0, topicsPending: 0, picks: 0 } }) } }) });
  try {
    assert.equal(readFileSync(path.join(r.home, 'data', 'plugins', 'mcp', 'hint.json'), 'utf8'), '{"facts":0}\n');
  } finally {
    await r.stop();
  }
});

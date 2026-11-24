import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FactView } from 'mera-news-pod/plugin-api';
import { instructions } from '../../src/text';
import { deliveringSuggestions, DONE, estimate, fakeServices, json, pick, run, status } from './helpers';

test('the server states its instructions, thirteen tools with annotations, and two prompts', async () => {
  const r = await run();
  try {
    const c = await r.client();
    assert.equal(c.getInstructions(), instructions);
    const { tools } = await c.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    assert.deepEqual(Object.keys(by).sort(), ['add_facts', 'digest_done', 'edit_topics', 'get_profile', 'get_status', 'get_suggestions', 'latest_news', 'news_for_profile', 'open_news_site', 'remove_facts', 'search_news', 'set_reading', 'top_stories']);
    const hints = (n: string) => by[n].annotations;
    for (const n of ['get_profile', 'get_suggestions', 'get_status', 'search_news', 'latest_news', 'top_stories', 'open_news_site']) assert.deepEqual(hints(n), { readOnlyHint: true });
    // news_for_profile records what it showed, so a retried or speculative call would take stories.
    for (const n of ['add_facts', 'digest_done', 'news_for_profile']) assert.deepEqual(hints(n), { readOnlyHint: false, destructiveHint: false });
    for (const n of ['remove_facts', 'edit_topics', 'set_reading']) assert.deepEqual(hints(n), { readOnlyHint: false, destructiveHint: true });
    assert.match(by.add_facts.description!, /^Save short facts about the person/);
    assert.deepEqual((by.add_facts.inputSchema as any).properties.statements.maxItems, 10);
    assert.deepEqual((by.get_suggestions.inputSchema as any).properties.limit.maximum, 25);
    const prompts = await c.listPrompts();
    assert.deepEqual(prompts.prompts.map((p) => p.name).sort(), ['daily_digest', 'set_up_profile']);
  } finally {
    await r.stop();
  }
});

test('each tool passes the service reply through in its documented shape', async () => {
  const seen: Record<string, unknown> = {};
  const services = fakeServices({
    profile: {
      get: async (o) => ((seen.get = o), { facts: [{ id: 'f1', statement: 'Lives in Utrecht', topicsStatus: 'done', addedAt: '2026-01-01T00:00:00.000Z', topics: [{ id: 't1', text: 'Utrecht', weight: 0, source: 'generated', reviewed: true }], needsReview: false }], nextOffset: 50, setup: DONE }),
      addFacts: async (s) => ((seen.add = s), { added: [{ id: 'f1', statement: s[0], retried: true }], already: [], refused: [{ statement: 'x', code: 'conflict', conflictsWith: { id: 'f9', statement: 'y' }, next: 'remove f9' }], localCoverageWeaker: true }),
      removeFacts: async (ids) => ((seen.remove = ids), { removed: [{ id: 'f1', statement: 's', topics: ['a'] }], notFound: ['zzz'] }),
      editTopics: async (e) => ((seen.edit = e), { results: [{ op: 'weight', index: 0, ok: true, id: 't1' }] }),
    },
    suggestions: {
      get: async (o) => ((seen.sugg = o), { state: 'topics_pending', hint: 'Topics are being made.', nextReadAt: '2026-01-01T01:00:00.000Z', picks: [pick(1)], cursor: 'c.9', more: true, reset: true }),
    },
    reading: { status: async () => status(), set: async (c) => ((seen.set = c), status({ reading: 'paused' })) },
  });
  const r = await run({ services });
  try {
    const c = await r.client();
    const call = async (name: string, args: Record<string, unknown> = {}) => json(await c.callTool({ name, arguments: args }));

    const profile = await call('get_profile', { offset: 50 });
    assert.deepEqual(seen.get, { offset: 50 });
    assert.equal(profile.facts[0].topics[0].source, 'generated');
    assert.equal(profile.nextOffset, 50);

    const added = await call('add_facts', { statements: ['Lives in Utrecht'] });
    assert.deepEqual(seen.add, ['Lives in Utrecht']);
    assert.equal(added.added[0].retried, true);
    assert.equal(added.refused[0].conflictsWith.id, 'f9');
    assert.equal(added.localCoverageWeaker, true);
    assert.equal(typeof added.note, 'string');

    assert.deepEqual((await call('remove_facts', { ids: ['f1'] })).notFound, ['zzz']);
    assert.deepEqual(seen.remove, ['f1']);

    await call('edit_topics', { weight: [{ topicId: 't1', weight: -1 }] });
    assert.deepEqual(seen.edit, { weight: [{ topicId: 't1', weight: -1 }] });

    const sugg = await call('get_suggestions');
    const { fits, ...asked } = seen.sugg as { fits?: unknown };
    assert.deepEqual(asked, { limit: 10 });
    assert.equal(typeof fits, 'function', 'the tool says what fits a reply');
    assert.deepEqual({ state: sugg.state, hint: sugg.hint, nextReadAt: sugg.nextReadAt, cursor: sugg.cursor, more: sugg.more, reset: sugg.reset }, { state: 'topics_pending', hint: 'Topics are being made.', nextReadAt: '2026-01-01T01:00:00.000Z', cursor: 'c.9', more: true, reset: true });
    assert.deepEqual(Object.keys(sugg.picks[0]).sort(), ['facts', 'id', 'lang', 'level', 'publication', 'publishedAt', 'reason', 'title', 'url']);
    await call('get_suggestions', { since: 'all', limit: 3 });
    assert.deepEqual({ ...(seen.sugg as object), fits: undefined }, { since: 'all', limit: 3, fits: undefined });

    assert.equal((await call('get_status')).counts.facts, 1);
    assert.equal((await call('set_reading', { paused: true, everyMinutes: 30 })).reading, 'paused');
    assert.deepEqual(seen.set, { paused: true, everyMinutes: 30 });
  } finally {
    await r.stop();
  }
});

test('no tool reply carries article body text, or any pick field the services add later', async () => {
  const withBody = { ...pick(1), body: 'FULL ARTICLE TEXT', content: 'FULL ARTICLE TEXT', someNewField: 'NEW FIELD' };
  const services = fakeServices({ suggestions: { get: async () => ({ state: 'ok', hint: '', nextReadAt: null, picks: [withBody], cursor: 'c', more: false }) } });
  const r = await run({ services });
  try {
    const c = await r.client();
    const reply = json(await c.callTool({ name: 'get_suggestions', arguments: {} }));
    assert.doesNotMatch(JSON.stringify(reply), /FULL ARTICLE TEXT|NEW FIELD/);
    assert.deepEqual(Object.keys(reply.picks[0]).sort(), ['facts', 'id', 'lang', 'level', 'publication', 'publishedAt', 'reason', 'title', 'url']);
  } finally {
    await r.stop();
  }
});

test('every error carries code, message and next, and a bad argument never shows validator text', async () => {
  const services = fakeServices({
    suggestions: {
      get: async () => {
        throw Object.assign(new Error('That cursor was not issued by this pod.'), { code: 'unknown_cursor', next: 'call without since' });
      },
    },
    reading: { status: async () => { throw new Error('The model host is down.'); }, set: async () => status() },
  });
  const r = await run({ services });
  try {
    const c = await r.client();
    const bad: [string, Record<string, unknown>, string][] = [
      ['add_facts', { statements: [] }, 'statements'],
      ['add_facts', { statements: ['x'.repeat(301)] }, 'statements.0'],
      ['add_facts', {}, 'statements'],
      ['remove_facts', { ids: 'f1' }, 'ids'],
      ['edit_topics', { weight: [{ topicId: 't', weight: 5 }] }, 'weight.0.weight'],
      ['get_suggestions', { limit: 99 }, 'limit'],
      ['set_reading', { everyMinutes: 2 }, 'everyMinutes'],
    ];
    for (const [name, args, field] of bad) {
      const res = await c.callTool({ name, arguments: args });
      assert.equal(res.isError, true, name);
      const body = json(res);
      assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'next']);
      assert.equal(body.code, 'bad_input');
      assert.ok(body.message.includes(`"${field}"`), body.message);
      assert.doesNotMatch(body.message, /expected|Too (small|big)|Invalid|Input validation/);
      assert.ok(body.next.length > 0);
    }
    const coded = await c.callTool({ name: 'get_suggestions', arguments: { since: 'zz' } });
    assert.equal(coded.isError, true);
    assert.deepEqual(json(coded), { code: 'unknown_cursor', message: 'That cursor was not issued by this pod.', next: 'call without since' });
    const plain = await c.callTool({ name: 'get_status', arguments: {} });
    assert.equal(plain.isError, true);
    assert.equal(json(plain).code, 'failed');
    // A command a checkout install has, as the docs give it.
    assert.equal(json(plain).next, 'try again, and if it keeps failing ask the person to run node build/cli.js check in the mera-news-pod folder');
  } finally {
    await r.stop();
  }
});

const bigFacts = (n: number, topicsEach: number): FactView[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `fact-${i}`,
    statement: `A fact about the person, number ${i}, with some words in it`,
    topicsStatus: 'done',
    addedAt: '2026-01-01T00:00:00.000Z',
    topics: Array.from({ length: topicsEach }, (_, j) => ({ id: `t-${i}-${j}`, text: `A topic about something, number ${i}.${j}`, weight: 0, source: 'generated' as const, reviewed: true })),
    needsReview: false,
  }));

test('no reply is over the cap with 200 facts, 300 topics and 25 picks', async () => {
  const facts = bigFacts(200, 1).map((f, i) => (i < 100 ? { ...f, topics: [...f.topics, ...bigFacts(1, 1)[0].topics.map((t, j) => ({ ...t, id: `x${i}-${j}` }))] } : f));
  assert.equal(facts.reduce((n, f) => n + f.topics.length, 0), 300);
  const picks = Array.from({ length: 25 }, (_, i) => ({ ...pick(i), reason: `${pick(i).reason} `.repeat(14) }));
  const services = fakeServices({
    profile: { ...fakeServices().profile, get: async () => ({ facts, nextOffset: 200, setup: DONE }) },
    suggestions: deliveringSuggestions(picks),
  });
  const r = await run({ services });
  try {
    const c = await r.client();
    const sizes: Record<string, number> = {};
    for (const [name, args] of [['get_profile', {}], ['get_suggestions', { limit: 25 }]] as const) {
      const text = (((await c.callTool({ name, arguments: args })).content as any[])[0]).text as string;
      sizes[name] = estimate(text);
      assert.ok(sizes[name] <= 6000, `${name} is ${sizes[name]} tokens`);
      const reply = json({ content: [{ text }] });
      if (name === 'get_profile') {
        assert.equal(reply.truncated, true);
        assert.equal(reply.nextOffset, reply.facts.length);
      } else {
        assert.ok(reply.picks.length < 25, 'the page was cut to fit');
        assert.equal(reply.more, true);
      }
    }
    console.log(`largest replies, in tokens: ${JSON.stringify(sizes)}`);
  } finally {
    await r.stop();
  }
});

test('picks cut to fit all arrive over successive calls, none twice and none lost', async () => {
  const picks = Array.from({ length: 25 }, (_, i) => ({ ...pick(i), reason: `Reason ${i}: ${'long words '.repeat(80)}` }));
  const r = await run({ services: fakeServices({ suggestions: deliveringSuggestions(picks) }) });
  try {
    const c = await r.client();
    const seen: string[] = [];
    let calls = 0;
    for (let more = true; more; calls++) {
      assert.ok(calls < 25, 'the picks ran out');
      const result = await c.callTool({ name: 'get_suggestions', arguments: { limit: 25 } });
      assert.ok(estimate(((result.content as any[])[0]).text) <= 6000);
      const reply = json(result);
      seen.push(...reply.picks.map((p: any) => p.id));
      more = reply.more;
    }
    assert.ok(calls > 1, 'the reasons were long enough to need more than one call');
    assert.deepEqual(seen, picks.map((p) => p.id));
  } finally {
    await r.stop();
  }
});

test('a pick far over the cap is still sent, with its text shortened so it fits', async () => {
  const huge = { ...pick(1), title: 'T'.repeat(50_000), reason: 'R'.repeat(50_000), facts: Array.from({ length: 50 }, (_, i) => `Fact ${i} ${'x'.repeat(250)}`) };
  const r = await run({ services: fakeServices({ suggestions: deliveringSuggestions([huge, pick(2)]) }) });
  try {
    const c = await r.client();
    const result = await c.callTool({ name: 'get_suggestions', arguments: {} });
    assert.ok(estimate(((result.content as any[])[0]).text) <= 6000);
    const reply = json(result);
    assert.deepEqual(reply.picks.map((p: any) => p.id), ['p1', 'p2']);
    assert.deepEqual([reply.picks[0].title.length, reply.picks[0].reason.length, reply.picks[0].facts.length], [500, 1000, 10]);
    assert.equal(reply.more, false);
  } finally {
    await r.stop();
  }
});

test('one fact with a huge topic list still fits', async () => {
  const [fact] = bigFacts(1, 3000);
  const services = fakeServices({ profile: { ...fakeServices().profile, get: async () => ({ facts: [fact], setup: DONE }) } });
  const r = await run({ services });
  try {
    const c = await r.client();
    const text = (((await c.callTool({ name: 'get_profile', arguments: {} })).content as any[])[0]).text as string;
    assert.ok(estimate(text) <= 6000);
    assert.equal(JSON.parse(text).facts.length, 1);
  } finally {
    await r.stop();
  }
});

test('a small reply is sent whole, without a truncated flag', async () => {
  const r = await run();
  try {
    const c = await r.client();
    assert.equal(json(await c.callTool({ name: 'get_profile', arguments: {} })).truncated, undefined);
  } finally {
    await r.stop();
  }
});

test('the other tools stay far under the cap at their largest inputs', async () => {
  const statement = 'a'.repeat(300);
  const services = fakeServices({
    profile: {
      ...fakeServices().profile,
      addFacts: async (s) => ({ added: [], already: [], refused: s.map((x) => ({ statement: x, code: 'conflict' as const, conflictsWith: { id: 'f-1', statement }, next: 'remove f-1 first' })) }),
      removeFacts: async (ids) => ({ removed: ids.map((id) => ({ id, statement, topics: Array.from({ length: 20 }, (_, i) => `A topic about something, number ${i}`) })), notFound: [] }),
      editTopics: async () => ({ results: Array.from({ length: 200 }, (_, index) => ({ op: 'remove' as const, index, ok: false, id: `t-${index}`, error: 'No such topic.' })) }),
    },
    reading: { status: async () => status({ problems: Array.from({ length: 10 }, (_, i) => ({ code: `p${i}`, who: 'person' as const, fix: 'a plain sentence on what to fix' })) }), set: async () => status() },
  });
  const r = await run({ services });
  try {
    const c = await r.client();
    const sizes: Record<string, number> = {};
    const size = async (name: string, args: Record<string, unknown>) => {
      const res = await c.callTool({ name, arguments: args });
      sizes[name] = estimate(((res.content as any[])[0]).text);
      assert.ok(sizes[name] <= 6000, name);
    };
    await size('add_facts', { statements: Array(10).fill(statement) });
    await size('remove_facts', { ids: Array.from({ length: 20 }, (_, i) => `fact-${i}`) });
    await size('edit_topics', { remove: ['t'] });
    await size('get_status', {});
    await size('set_reading', { paused: true });
    console.log(`other replies, in tokens: ${JSON.stringify(sizes)}`);
  } finally {
    await r.stop();
  }
});

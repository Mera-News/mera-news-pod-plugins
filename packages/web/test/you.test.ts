import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { FactView, PodServices, ProfileView } from 'mera-news-pod/plugin-api';
import { siteLink } from '../src/link';
import { run, type Running } from './helpers';

const fact = (id: string, over: Partial<FactView> = {}): FactView => ({
  id,
  statement: `Fact ${id}`,
  topicsStatus: 'done',
  addedAt: '2026-01-01T00:00:00.000Z',
  needsReview: true,
  topics: [{ id: `${id}-t1`, text: `topic ${id}`, weight: 1, source: 'generated', reviewed: false }],
  ...over,
});
const SETUP = { complete: false, findingTopics: ['Fact b'], toReview: ['Fact a'], noTopics: [] };

async function signedIn(services: Partial<PodServices>, before?: (dataDir: string) => void) {
  const r = await run({ services, before });
  const code = /#c=(.+)$/.exec(siteLink(r.dataDir))![1];
  const { session } = JSON.parse((await r.session(code)).body);
  const auth = { authorization: `Bearer ${session}` };
  const get = async (p: string) => {
    const res = await r.request({ path: p, headers: auth });
    return { status: res.status, body: JSON.parse(res.body || 'null') };
  };
  const post = async (p: string, body: unknown, headers: Record<string, string | undefined> = {}) => {
    const res = await r.request({ path: p, method: 'POST', headers: { ...auth, origin: r.origin(), 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: JSON.parse(res.body || 'null') };
  };
  return { r, get, post, session };
}

const withMcp = (dataDir: string) => fs.mkdirSync(path.join(dataDir, '..', 'mcp'), { recursive: true });

async function using<T>(r: Running, fn: () => Promise<T>) {
  try {
    return await fn();
  } finally {
    await r.stop();
  }
}

test('the profile is every page of facts, with only the fields the page shows, and where setup stands', async () => {
  const pages: Record<number, ProfileView> = {
    0: { facts: [fact('a', { reviewedAt: '2026-01-02T00:00:00.000Z' })], nextOffset: 1, setup: SETUP },
    1: { facts: [fact('b', { topicsStatus: 'pending', topics: [] })], setup: SETUP },
  };
  const asked: unknown[] = [];
  const { r, get } = await signedIn({ profile: { get: async (o) => (asked.push(o), pages[o?.offset ?? 0]) } as PodServices['profile'] });
  await using(r, async () => {
    const res = await get('/api/profile/');
    assert.equal(res.status, 200);
    assert.deepEqual(asked, [{ offset: 0 }, { offset: 1 }]);
    assert.deepEqual(res.body, {
      facts: [
        { id: 'a', statement: 'Fact a', topicsStatus: 'done', needsReview: true, reviewed: true, topics: [{ id: 'a-t1', text: 'topic a', source: 'generated', reviewed: false }] },
        { id: 'b', statement: 'Fact b', topicsStatus: 'pending', needsReview: true, reviewed: false, topics: [] },
      ],
      setup: SETUP,
    });
  });
});

test('adding a fact sends it as the person confirmed it and answers what happened, never more', async () => {
  const sent: string[][] = [];
  const answers: Record<string, Awaited<ReturnType<PodServices['profile']['addFacts']>>> = {
    'Lives in Utrecht': { added: [{ id: '1', statement: 'Lives in Utrecht' }], already: [], refused: [], localCoverageWeaker: true },
    'Works as a nurse': { added: [], already: [{ id: '2', statement: 'Works as a nurse' }], refused: [] },
    'Lives in Delft': { added: [], already: [], refused: [{ statement: 'Lives in Delft', code: 'conflict', conflictsWith: { id: '1', statement: 'Lives in Utrecht' }, next: 'call remove_facts' }] },
    'Follows chess': { added: [{ id: '3', statement: 'Follows chess', retried: true }], already: [], refused: [] },
  };
  const { r, post } = await signedIn({ profile: { addFacts: async (s: string[]) => (sent.push(s), answers[s[0]]) } as unknown as PodServices['profile'] });
  await using(r, async () => {
    assert.deepEqual((await post('/api/facts/', { statement: '  Lives \n in   Utrecht ' })).body, { result: 'added', localCoverageWeaker: true });
    assert.deepEqual(sent[0], ['Lives in Utrecht']);
    assert.deepEqual((await post('/api/facts/', { statement: 'Works as a nurse' })).body, { result: 'already' });
    assert.deepEqual((await post('/api/facts/', { statement: 'Lives in Delft' })).body, { result: 'conflict', conflictsWith: 'Lives in Utrecht' });
    assert.deepEqual((await post('/api/facts/', { statement: 'Follows chess' })).body, { result: 'retried' });
    for (const statement of ['', '   ', 'x'.repeat(301), 42, undefined]) {
      const res = await post('/api/facts/', { statement });
      assert.equal(res.status, 400, String(statement));
      assert.equal(res.body.error, 'bad_input');
      assert.ok(res.body.next);
    }
    assert.equal(sent.length, 4, 'a refused fact never reaches the pod');
  });
});

test('removing a fact answers only whether it went, without the fact or its topics', async () => {
  const { r, post } = await signedIn({
    profile: { removeFacts: async (ids: string[]) => ({ removed: ids.filter((i) => i === 'a').map((id) => ({ id, statement: 'Lives in Utrecht', topics: ['Utrecht news'] })), notFound: ids.filter((i) => i !== 'a') }) } as unknown as PodServices['profile'],
  });
  await using(r, async () => {
    const gone = await post('/api/facts/remove/', { id: 'a' });
    assert.deepEqual(gone.body, { removed: true });
    assert.deepEqual((await post('/api/facts/remove/', { id: 'zz' })).body, { removed: false });
    assert.equal((await post('/api/facts/remove/', { id: '../x' })).status, 400);
  });
});

test('saving a fact removes the topics turned down and records the review; the rest stay', async () => {
  const edits: unknown[] = [];
  let pending = false;
  const { r, post } = await signedIn({
    profile: {
      editTopics: async (e) => {
        edits.push(e);
        if (pending) throw Object.assign(new Error('Topics for this fact are still being made.'), { code: 'topics_pending', next: 'wait until its topics are ready, then review them' });
        return { results: (e.remove ?? []).map((id, index) => ({ op: 'remove' as const, index, ok: id !== 'gone', id })) };
      },
    } as PodServices['profile'],
  });
  await using(r, async () => {
    assert.deepEqual((await post('/api/topics/', { factId: 'a', remove: ['t1', 'gone'] })).body, { saved: true, notRemoved: 1 });
    assert.deepEqual((await post('/api/topics/', { factId: 'a', remove: [] })).body, { saved: true, notRemoved: 0 });
    assert.deepEqual(edits, [
      { remove: ['t1', 'gone'], reviewed: ['a'] },
      { remove: [], reviewed: ['a'] },
    ]);
    pending = true;
    const refused = await post('/api/topics/', { factId: 'a', remove: [] });
    assert.equal(refused.status, 400);
    // In the page's words, not the assistant's.
    assert.deepEqual(refused.body, { error: 'topics_pending', message: 'Topics for this fact are still being made.', next: 'Wait until they appear here, then save.' });
    for (const body of [{ factId: 'a' }, { factId: 'a', remove: [1] }, { factId: '', remove: [] }, { factId: 'a', remove: Array(101).fill('t') }]) {
      assert.equal((await post('/api/topics/', body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
    assert.equal(edits.length, 3);
  });
});

test('the digest schedule is the file the mcp plugin reads: times sorted once each, an interval or none, the last digest kept', async () => {
  const { r, get, post } = await signedIn({}, withMcp);
  await using(r, async () => {
    assert.deepEqual((await get('/api/digest/')).body, { times: [], everyMinutes: null, assistant: true });
    const saved = await post('/api/digest/', { times: ['18:00', '08:00', '18:00'], everyMinutes: null });
    assert.deepEqual(saved.body, { times: ['08:00', '18:00'], everyMinutes: null, assistant: true });
    const file = path.join(r.dataDir, '..', 'mcp', 'digest.json');
    const first = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(first.times, ['08:00', '18:00']);
    assert.ok(!Number.isNaN(Date.parse(first.lastAt)), 'starts counting from now, so no digest is due at once');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);

    fs.writeFileSync(file, JSON.stringify({ ...first, lastAt: '2026-01-01T08:00:00.000Z' }));
    assert.deepEqual((await post('/api/digest/', { times: [], everyMinutes: 120 })).body, { times: [], everyMinutes: 120, assistant: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { times: [], lastAt: '2026-01-01T08:00:00.000Z', everyMinutes: 120 });

    for (const body of [{ times: ['8:00'], everyMinutes: null }, { times: ['24:00'], everyMinutes: null }, { times: [], everyMinutes: 0 }, { times: [], everyMinutes: 1.5 }, { times: Array(49).fill('08:00'), everyMinutes: null }, { times: [] }]) {
      assert.equal((await post('/api/digest/', body)).status, 400, JSON.stringify(body).slice(0, 60));
    }
  });
});

test('with no assistant on this pod the digest says so and saves nothing', async () => {
  const { r, get, post } = await signedIn({});
  await using(r, async () => {
    assert.deepEqual((await get('/api/digest/')).body, { times: [], everyMinutes: null, assistant: false });
    const res = await post('/api/digest/', { times: ['08:00'], everyMinutes: null });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'no_assistant');
    assert.ok(!fs.existsSync(path.join(r.dataDir, '..', 'mcp')));
  });
});

test('the AI service goes to the pod as typed, an empty key keeps the saved one, and the answer is only that it is set', async () => {
  const given: unknown[] = [];
  const { r, post } = await signedIn({
    aiService: {
      set: async (c) => {
        given.push(c);
        if (c.baseUrl.startsWith('http://ai')) throw Object.assign(new Error('The AI service address must start with https://. Nothing was saved.'), { code: 'bad_input', next: 'Use the address your AI service gives.' });
        return { set: true };
      },
    },
  });
  await using(r, async () => {
    assert.deepEqual((await post('/api/ai/', { baseUrl: ' https://ai.example.org/v1 ', model: 'm', apiKey: ' sk-1 ' })).body, { set: true });
    assert.deepEqual((await post('/api/ai/', { baseUrl: 'https://ai.example.org/v1', model: 'm', apiKey: '' })).body, { set: true });
    assert.deepEqual(given, [
      { baseUrl: 'https://ai.example.org/v1', model: 'm', apiKey: 'sk-1' },
      { baseUrl: 'https://ai.example.org/v1', model: 'm' },
    ]);
    const refused = await post('/api/ai/', { baseUrl: 'http://ai.example.org', model: 'm', apiKey: 'sk-2' });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.next, 'Use the address your AI service gives.');
    assert.doesNotMatch(JSON.stringify(refused.body), /sk-2/);
    assert.equal((await post('/api/ai/', { model: 'm' })).status, 400);
  });
});

test('every write needs this page: its session, its origin and JSON; a write route answers no GET and a read route no POST', async () => {
  let calls = 0;
  const count = async () => (calls++, { set: true as const });
  const { r, post } = await signedIn({ aiService: { set: count } }, withMcp);
  await using(r, async () => {
    const body = { baseUrl: 'https://ai.example.org', model: 'm' };
    for (const p of ['/api/facts/', '/api/facts/remove/', '/api/topics/', '/api/ai/']) {
      assert.equal((await post(p, body, { authorization: undefined })).status, 401, `${p} without a session`);
      assert.equal((await post(p, body, { authorization: 'Bearer wrong' })).status, 401, `${p} with a wrong session`);
      assert.equal((await post(p, body, { origin: 'http://evil.example' })).status, 403, `${p} from another origin`);
      assert.equal((await post(p, body, { origin: undefined })).status, 403, `${p} with no origin`);
      assert.equal((await post(p, body, { 'content-type': 'text/plain' })).status, 415, `${p} as text`);
      assert.equal((await r.request({ path: p })).status, 405, `GET ${p}`);
      assert.equal((await post(p, '[1]')).status, 400, `${p} with a list`);
      assert.equal((await post(p, '{oops')).status, 400, `${p} with broken JSON`);
    }
    assert.equal((await post('/api/profile/', {})).status, 405);
    assert.equal((await post('/api/nothing/', {})).status, 404);
    assert.equal(calls, 0, 'nothing refused reached the pod');
  });
});

test('nothing typed on the You page reaches the log, even when the pod fails on it', async () => {
  const typed = ['Lives in Utrecht', 'sk-secret-key-123', 'https://private-ai.example.org', 'chess openings'];
  const fail = (text: string) => async () => {
    throw new Error(`failed on ${text}`);
  };
  const { r, post } = await signedIn(
    {
      profile: { addFacts: fail(typed[0]), editTopics: fail(typed[3]), removeFacts: fail(typed[0]) } as unknown as PodServices['profile'],
      aiService: { set: fail(`${typed[1]} ${typed[2]}`) },
    },
    withMcp,
  );
  await using(r, async () => {
    assert.equal((await post('/api/facts/', { statement: typed[0] })).status, 500);
    assert.equal((await post('/api/topics/', { factId: 'a', remove: ['chess'] })).status, 500);
    assert.equal((await post('/api/facts/remove/', { id: 'a' })).status, 500);
    assert.equal((await post('/api/ai/', { baseUrl: typed[2], model: 'm', apiKey: typed[1] })).status, 500);
    assert.equal((await post('/api/facts/', `{"statement":"${typed[0]}"`)).status, 400);
    assert.ok(r.logs.includes('A website request failed.'));
  });
  for (const line of r.logs) for (const secret of [...typed, 'Utrecht', 'sk-']) assert.ok(!line.includes(secret), line);
});

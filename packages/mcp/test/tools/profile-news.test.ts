import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { PodServices, ProfileStory, StoriesSummary } from 'mera-news-pod/plugin-api';
import { estimate, fakeServices, json, run, status } from './helpers';

const summary = (over: Partial<StoriesSummary> = {}): StoriesSummary => ({
  windowHours: 48,
  articles: 5,
  stories: 4,
  merged: 1,
  topics: [{ text: 'utrecht council', matches: 3 }, { text: 'nurse pay', matches: 2 }],
  facts: [{ id: 'f1', statement: 'Lives in Utrecht', matched: 3, picked: 1, leftOut: 1 }, { id: 'f2', statement: 'Works as a nurse', matched: 1, picked: 0, leftOut: 0 }],
  picked: 1,
  leftOut: 1,
  unjudged: 2,
  publishers: 3,
  languages: 2,
  complete: true,
  ...over,
});
const story = (id: string, over: Partial<ProfileStory> = {}): ProfileStory => ({
  id,
  story: `s:${id}`,
  title: `Verhaal ${id}`,
  titleEn: `Story ${id}`,
  link: `https://news.example/${id}`,
  publisher: 'De Krant',
  publishedAt: '2026-01-01T00:00:00.000Z',
  language: 'nl',
  image: `https://img.example/${id}.jpg`,
  reports: 2,
  facts: [{ id: 'f1', statement: 'Lives in Utrecht' }],
  topics: ['utrecht council'],
  ...over,
});
const STORIES = [
  story('a1', { verdict: { verdict: 'picked', level: 'high', reason: 'Utrecht council votes on your street.', by: 'assistant', at: '2026-01-01T00:00:00.000Z' } }),
  story('a2'),
  story('a3', { verdict: { verdict: 'left_out', reason: 'A council far from you.', by: 'assistant' } }),
  story('a4', { facts: [{ id: 'f2', statement: 'Works as a nurse' }, { id: 'f1', statement: 'Lives in Utrecht' }] }),
];

/** Stories that keep the services' promise: a page cut by `fits`, every page by cursor. */
function pagedStories(all = STORIES) {
  const asked: { after?: string; limit?: number; peek?: boolean }[] = [];
  const forProfile: PodServices['stories']['forProfile'] = async (o = {}) => {
    asked.push({ after: o.after, limit: o.limit, peek: o.peek });
    const from = o.after ? Number(o.after.split('.')[1]) : 0;
    let page = all.slice(from, from + (o.limit ?? 20));
    while (o.fits && page.length > 1 && !o.fits(page, summary())) page = page.slice(0, -1);
    const end = from + page.length;
    return { run: 'run', summary: summary(), stories: page, ...(end < all.length ? { nextCursor: `run.${end}` } : {}), shownBefore: 0 };
  };
  return { asked, stories: { forProfile, judge: async () => ({ saved: [], already: [], refused: [] }) } };
}

test('news_for_profile: the summary numbers, the stories still to judge by fact, and the picks and stories left out with their reasons', async () => {
  const s = pagedStories();
  const r = await run({ services: fakeServices({ stories: s.stories }) });
  try {
    const c = await r.client();
    const page = json(await c.callTool({ name: 'news_for_profile', arguments: {} }));
    assert.deepEqual(s.asked, [{ after: undefined, limit: 20, peek: undefined }], 'the assistant reads without peek, so what it saw is recorded');
    assert.deepEqual(page.summary, summary());
    assert.deepEqual(page.toJudge, [
      { factId: 'f1', fact: 'Lives in Utrecht', stories: [{ id: 'a2', title: 'Verhaal a2', title_en: 'Story a2', link: 'https://news.example/a2', publisher: 'De Krant', publishedAt: '2026-01-01T00:00:00.000Z', language: 'nl', reports: 2 }] },
      { factId: 'f2', fact: 'Works as a nurse', stories: [{ id: 'a4', title: 'Verhaal a4', title_en: 'Story a4', link: 'https://news.example/a4', publisher: 'De Krant', publishedAt: '2026-01-01T00:00:00.000Z', language: 'nl', reports: 2, alsoFacts: ['Lives in Utrecht'] }] },
    ]);
    assert.deepEqual(page.picked, [{ id: 'a1', title: 'Verhaal a1', title_en: 'Story a1', link: 'https://news.example/a1', publisher: 'De Krant', level: 'high', reason: 'Utrecht council votes on your street.', facts: ['Lives in Utrecht'] }]);
    assert.deepEqual(page.leftOut, [{ id: 'a3', title: 'Verhaal a3', title_en: 'Story a3', link: 'https://news.example/a3', publisher: 'De Krant', reason: 'A council far from you.', facts: ['Lives in Utrecht'] }]);
    assert.equal(page.nextCursor, undefined);
    assert.match(page.next, /^This is the last page\. Judge every story in toJudge, on every page, with rate_stories/);
    assert.doesNotMatch(JSON.stringify(page), /img\.example/, 'no image address for the assistant');
  } finally {
    await r.stop();
  }
});

test('news_for_profile: a page cut to fit continues by cursor, so every page together carries every story once', async () => {
  const many = Array.from({ length: 30 }, (_, i) => story(`m${i}`, { titleEn: 'A long English headline for this story '.repeat(12).slice(0, 480), title: `Een heel lang verhaal nummer ${i} `.repeat(14).slice(0, 480) }));
  const s = pagedStories(many);
  const r = await run({ services: fakeServices({ stories: s.stories }) });
  try {
    const c = await r.client();
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = json(await c.callTool({ name: 'news_for_profile', arguments: after ? { after, limit: 50 } : { limit: 50 } }));
      assert.ok(estimate(JSON.stringify(page)) <= 8000);
      if (page.nextCursor) assert.match(page.next, /call news_for_profile again with after set to nextCursor/);
      seen.push(...page.toJudge.flatMap((g: any) => g.stories.map((x: any) => x.id)));
      after = page.nextCursor;
      pages++;
    } while (after);
    assert.ok(pages > 1, 'the reply was cut');
    assert.deepEqual(seen, many.map((m) => m.id));
  } finally {
    await r.stop();
  }
});

test('rate_stories: passes each verdict to the pod, and asks again for a pick whose reason the pod refused', async () => {
  const judged: unknown[] = [];
  const judge: PodServices['stories']['judge'] = async (v) => {
    judged.push(v);
    return { saved: [{ id: 'a2', verdict: 'picked' }], already: [{ id: 'a3', verdict: 'left_out' }], refused: [{ id: 'a4', code: 'reason_not_grounded', message: 'No word from the headline.' }, { id: 'a5', code: 'not_available', message: 'Muted.' }] };
  };
  const r = await run({ services: fakeServices({ stories: { judge } }) });
  try {
    const c = await r.client();
    const stories = [
      { id: 'a2', verdict: 'picked', level: 'high', reason: ' Your council votes. ' },
      { id: 'a3', verdict: 'left_out', reason: 'Far away.' },
      { id: 'a4', verdict: 'picked', level: 'low', reason: 'Hm.' },
    ];
    const res = json(await c.callTool({ name: 'rate_stories', arguments: { stories } }));
    assert.deepEqual(judged, [[{ id: 'a2', verdict: 'picked', level: 'high', reason: 'Your council votes.' }, stories[1], stories[2]]]);
    assert.deepEqual(res.refused, [{ id: 'a4', code: 'reason_not_grounded', message: 'No word from the headline.' }, { id: 'a5', code: 'not_available', message: 'Muted.' }]);
    assert.match(res.note, /Call rate_stories again for those/);
    assert.match(res.note, /muted or already read: show them as left out and do not rate them again/);
    for (const bad of [{ stories: [] }, { stories: [{ id: 'a', verdict: 'maybe', reason: 'x' }] }, { stories: [{ id: 'a', verdict: 'picked', level: 'urgent', reason: 'x' }] }, { stories: Array(51).fill({ id: 'a', verdict: 'left_out', reason: 'x' }) }]) {
      assert.equal(json(await c.callTool({ name: 'rate_stories', arguments: bad })).code, 'bad_input');
    }
    // The pod's own refusal keeps its code and next step.
    const refusing = await run({ services: fakeServices({ stories: { judge: async () => Promise.reject(Object.assign(new Error('Verdict 1 is a pick, so it needs a level.'), { code: 'bad_input', next: 'add a level' })) } }) });
    try {
      const err = json(await (await refusing.client()).callTool({ name: 'rate_stories', arguments: { stories: [{ id: 'a', verdict: 'picked', reason: 'x' }] } }));
      assert.deepEqual(err, { code: 'bad_input', message: 'Verdict 1 is a pick, so it needs a level.', next: 'add a level' });
    } finally {
      await refusing.stop();
    }
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
  let ai: { host: string; model: string; relevanceModel: string; reasons: boolean } | null = null;
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
    assert.equal(res.note, 'Saved. Call get_profile to see the topics.');
    assert.deepEqual(JSON.parse(readFileSync(path.join(r.home, 'data', 'plugins', 'mcp', 'hint.json'), 'utf8')), { facts: 2, toReview: 0, findingTopics: 0, noTopics: 0 });

    const bare = json(await c.callTool({ name: 'add_facts', arguments: { statements: ['Lives in Utrecht'] } }));
    assert.match(bare.note, /makes no topics on its own/, 'no AI service: the assistant is asked for topics');
    assert.doesNotMatch(bare.note, /minute/);
    ai = { host: 'ai.example', model: 'm', relevanceModel: 'm', reasons: true };
    assert.match(json(await c.callTool({ name: 'add_facts', arguments: { statements: ['Lives in Utrecht'] } })).note, /within a minute or two/);

    // The pod matches a saved fact with case and spacing ignored, and hands back the saved wording.
    given.length = 0;
    const spaced = json(await c.callTool({ name: 'add_facts', arguments: { statements: ['Lives in Utrecht', { statement: 'Works  as a  Nurse', topics: ['nurse pay'] }] } }));
    assert.deepEqual(given, [['f2', ['nurse pay']]]);
    assert.deepEqual(spaced.topics, [{ factId: 'f2', error: 'Topic 1 is longer than 80 characters.' }]);

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
    const late = json(await c.callTool({ name: 'get_status', arguments: {} })).digest;
    assert.deepEqual({ ...late, missed: undefined }, { times: ['07:30'], everyMinutes: null, due: true, missed: undefined });
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

test('add_facts: topics for a fact that was neither saved nor refused say so', async () => {
  const profile = { addFacts: async () => ({ added: [], already: [], refused: [] }) };
  const r = await run({ services: fakeServices({ profile }) });
  try {
    const c = await r.client();
    const res = json(await c.callTool({ name: 'add_facts', arguments: { statements: [{ statement: 'Lives in Utrecht', topics: ['Utrecht council'] }] } }));
    assert.equal(res.topics.length, 1);
    assert.equal(res.topics[0].statement, 'Lives in Utrecht');
    assert.match(res.topics[0].error, /not saved/);
  } finally {
    await r.stop();
  }
});

test('the plugin notes the fact count at start for the session hint, without waiting for it to start', async () => {
  let answer!: () => void;
  const asked = new Promise<void>((resolve) => (answer = resolve));
  // The pod's status waits on the data server, which can take many seconds.
  const r = await run({ services: fakeServices({ reading: { status: () => asked.then(() => status({ counts: { facts: 0, topics: 0, topicsPending: 0, picks: 0 } })) } }) });
  try {
    const file = path.join(r.home, 'data', 'plugins', 'mcp', 'hint.json');
    assert.ok(!existsSync(file), 'started before the status answered');
    answer();
    for (let i = 0; !existsSync(file) && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(readFileSync(file, 'utf8'), '{"facts":0,"toReview":0,"findingTopics":0,"noTopics":0}\n');
  } finally {
    await r.stop();
  }
});

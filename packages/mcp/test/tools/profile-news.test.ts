import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { PodServices, ProfileStory, StoriesSummary } from 'mera-news-pod/plugin-api';
import { assertShow, fakeServices, json, run, status, walk } from './helpers';
import { MAX_CHARS } from '../../src/reply';

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
    // The pod's page limit, as in the pod this package pins.
    if ((o.limit ?? 20) > 1000) throw Object.assign(new Error('limit must be a whole number from 0 to 1000.'), { code: 'bad_input', next: 'pass a smaller limit' });
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
      { factId: 'f1', fact: 'Lives in Utrecht', stories: [{ id: 'a2', title: 'Verhaal a2', title_en: 'Story a2', link: 'https://news.example/a2', publisher: 'De Krant', reports: 2, show: '[Verhaal a2](https://news.example/a2) · De Krant +1 report', publishedAt: '2026-01-01T00:00:00.000Z', language: 'nl' }] },
      { factId: 'f2', fact: 'Works as a nurse', stories: [{ id: 'a4', title: 'Verhaal a4', title_en: 'Story a4', link: 'https://news.example/a4', publisher: 'De Krant', reports: 2, show: '[Verhaal a4](https://news.example/a4) · De Krant +1 report', publishedAt: '2026-01-01T00:00:00.000Z', language: 'nl', alsoFacts: ['Lives in Utrecht'] }] },
    ]);
    assert.deepEqual(page.picked, [{ id: 'a1', title: 'Verhaal a1', title_en: 'Story a1', link: 'https://news.example/a1', publisher: 'De Krant', reports: 2, show: '[Verhaal a1](https://news.example/a1) · De Krant +1 report', level: 'high', reason: 'Utrecht council votes on your street.', facts: ['Lives in Utrecht'] }]);
    assert.deepEqual(page.leftOut, [{ id: 'a3', title: 'Verhaal a3', title_en: 'Story a3', link: 'https://news.example/a3', publisher: 'De Krant', reports: 2, show: '[Verhaal a3](https://news.example/a3) · De Krant +1 report', reason: 'A council far from you.', facts: ['Lives in Utrecht'] }]);
    assert.equal(page.nextCursor, undefined);
    assert.match(page.next, /^This is the last page\. Judge every story in toJudge, on every page, with rate_stories/);
    assert.doesNotMatch(JSON.stringify(page), /img\.example/, 'no image address for the assistant');
    for (const x of [...page.picked, ...page.leftOut]) assertShow(x);
  } finally {
    await r.stop();
  }
});

test('news_for_profile: a page cut to fit continues by cursor, so every page together carries every story once, and only the first carries the topic and fact lists', async () => {
  const many = Array.from({ length: 60 }, (_, i) => story(`m${i}`, { titleEn: 'A long English headline for this story '.repeat(12).slice(0, 480), title: `Een heel lang verhaal nummer ${i} `.repeat(14).slice(0, 480) }));
  const s = pagedStories(many);
  const r = await run({ services: fakeServices({ stories: s.stories }) });
  try {
    const pages: any[] = [];
    const { seen } = await walk(await r.client(), 'news_for_profile', { limit: 60 }, (page) => (pages.push(page), page.toJudge.flatMap((g: any) => g.stories.map((x: any) => x.id))), 60);
    assert.ok(pages.length > 1);
    assert.ok(pages.some((p, i) => i < pages.length - 1 && p.toJudge[0].stories.length < 60), 'a page was cut below what was asked for');
    for (const p of pages.slice(0, -1)) assert.match(p.next, /^Read every page before you pick or answer\. Show each story by its show line, .* Call news_for_profile with /);
    for (const p of pages) for (const g of p.toJudge) for (const x of g.stories) assertShow(x);
    assert.match(pages.at(-1).next, /^This is the last page\./);
    assert.deepEqual(seen, many.map((m) => m.id));
    assert.deepEqual([pages[0].summary.topics, pages[0].summary.facts], [summary().topics, summary().facts]);
    for (const p of pages.slice(1)) assert.deepEqual(['topics' in p.summary, 'facts' in p.summary, p.summary.unjudged], [false, false, 2]);
    assert.equal(s.asked[0].limit, 60, 'the first call asks the pod for all 60: its page is 1000');
    assert.ok(s.asked.every((a) => (a.limit ?? 0) <= 100), 'never over what one reply holds');
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
    assert.deepEqual([res.saved, res.already], [1, 1]);
    assert.deepEqual(res.refused, [{ code: 'reason_not_grounded', count: 1, ids: ['a4'], message: 'No word from the headline.' }, { code: 'not_available', count: 1, ids: ['a5'], message: 'Muted.' }]);
    assert.match(res.note, /Call rate_stories again for those/);
    assert.match(res.note, /muted or already read: show them as left out and do not rate them again/);
    for (const bad of [{ stories: [] }, { stories: [{ id: 'a', verdict: 'maybe', reason: 'x' }] }, { stories: [{ id: 'a', verdict: 'picked', level: 'urgent', reason: 'x' }] }, { stories: Array(501).fill({ id: 'a', verdict: 'left_out', reason: 'x' }) }]) {
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

test('rate_stories: up to 500 verdicts go to the pod in one call; an older pod that takes 50 gets them 50 at a time', async () => {
  const verdicts = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, verdict: 'left_out', reason: 'Far away.' }));
  for (const cap of [500, 50]) {
    const sizes: number[] = [];
    const judge: PodServices['stories']['judge'] = async (v) => {
      sizes.push(v.length);
      if (v.length > cap) throw Object.assign(new Error(`Pass 1 to ${cap} verdicts.`), { code: 'bad_input', next: 'pass fewer verdicts' });
      return { saved: v.map((x) => ({ id: x.id, verdict: x.verdict })), already: [], refused: [] };
    };
    const r = await run({ services: fakeServices({ stories: { judge } }) });
    try {
      const res = json(await (await r.client()).callTool({ name: 'rate_stories', arguments: { stories: verdicts } }));
      assert.equal(res.saved, 120, JSON.stringify(res).slice(0, 200));
      assert.deepEqual(sizes, cap === 500 ? [120] : [120, 50, 50, 20]);
    } finally {
      await r.stop();
    }
  }
});

test('rate_stories: a current pod refusing one bad verdict in a batch of 120 returns that refusal, and nothing is sent twice', async () => {
  const verdicts = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, verdict: 'left_out', reason: 'Far away.' }));
  const sent: number[] = [];
  // The pod refuses the whole call for one bad item; only the old cap's own words mean "send fewer".
  const judge: PodServices['stories']['judge'] = async (v) => {
    sent.push(v.length);
    if (v.some((x) => x.id === 's70')) throw Object.assign(new Error('Verdict 71 has no valid id.'), { code: 'bad_input', next: 'correct it and call again; nothing was saved' });
    return { saved: v.map((x) => ({ id: x.id, verdict: x.verdict })), already: [], refused: [] };
  };
  const r = await run({ services: fakeServices({ stories: { judge } }) });
  try {
    const res = json(await (await r.client()).callTool({ name: 'rate_stories', arguments: { stories: verdicts } }));
    assert.deepEqual(res, { code: 'bad_input', message: 'Verdict 71 has no valid id.', next: 'correct it and call again; nothing was saved' });
    assert.deepEqual(sent, [120], 'one call: no 50s saved before the refusal');
  } finally {
    await r.stop();
  }
});

test('rate_stories: 500 refusals come back as a count per code with the first ids, within the reply caps', async () => {
  const verdicts = Array.from({ length: 500 }, (_, i) => ({ id: `${'x'.repeat(90)}${i}`, verdict: 'picked', level: 'low', reason: 'r'.repeat(300) }));
  const long = 'This pick was refused because its reason shares no word with its headline. '.repeat(10);
  const judge: PodServices['stories']['judge'] = async (v) => ({ saved: [], already: [], refused: v.map((x, i) => ({ id: x.id, code: i % 2 ? 'reason_not_grounded' : 'unknown_story', message: long })) });
  const r = await run({ services: fakeServices({ stories: { judge } }) });
  try {
    const out = await (await r.client()).callTool({ name: 'rate_stories', arguments: { stories: verdicts } });
    const text = (out.content as { text: string }[])[0].text;
    assert.ok(text.length <= MAX_CHARS, `${text.length} characters`);
    const res = JSON.parse(text);
    assert.equal(out.isError, undefined, text.slice(0, 200));
    assert.deepEqual(res.refused.map((g: any) => [g.code, g.count, g.ids.length, g.message.length]), [['unknown_story', 250, 10, 300], ['reason_not_grounded', 250, 10, 300]]);
    assert.equal(res.refused[0].ids[0], verdicts[0].id);
    assert.match(res.note, /Call rate_stories again for those/);
    assert.match(res.note, /refused gives each code's count and only its first 10 ids\./);
  } finally {
    await r.stop();
  }
});

test('rate_stories: the Saved note asks for each story by its show line', async () => {
  const r = await run({ services: fakeServices({ stories: { judge: async (v) => ({ saved: v.map((x) => ({ id: x.id, verdict: x.verdict })), already: [], refused: [] }) } }) });
  try {
    const res = json(await (await r.client()).callTool({ name: 'rate_stories', arguments: { stories: [{ id: 'a', verdict: 'left_out', reason: 'Far away.' }] } }));
    assert.match(res.note, /^Saved\. .*each by its show line with its reason\. Show each story by its show line, exactly as written/);
    assert.doesNotMatch(res.note, /its title, its publisher, its link/);
  } finally {
    await r.stop();
  }
});

test('news_for_profile: a current pod refusing for another reason returns that refusal, and is never asked again at 50', async () => {
  const asked: (number | undefined)[] = [];
  const forProfile: PodServices['stories']['forProfile'] = async (o = {}) => {
    asked.push(o.limit);
    throw Object.assign(new Error('fact must be the id of a saved fact.'), { code: 'bad_input', next: 'correct it and call again; nothing was saved' });
  };
  const r = await run({ services: fakeServices({ stories: { forProfile } }) });
  try {
    const res = json(await (await r.client()).callTool({ name: 'news_for_profile', arguments: { limit: 120 } }));
    assert.deepEqual(res, { code: 'bad_input', message: 'fact must be the id of a saved fact.', next: 'correct it and call again; nothing was saved' });
    assert.deepEqual(asked, [100]);
  } finally {
    await r.stop();
  }
});

test('news_for_profile: an older pod that refuses a page over 50 is asked for 50, and only 50 from then on', async () => {
  const all = Array.from({ length: 120 }, (_, i) => story(`o${i}`));
  const s = pagedStories(all);
  const older = s.stories.forProfile;
  const forProfile: PodServices['stories']['forProfile'] = async (o = {}) => {
    if ((o.limit ?? 20) > 50) {
      s.asked.push({ after: o.after, limit: o.limit, peek: o.peek });
      throw Object.assign(new Error('limit must be a whole number from 0 to 50.'), { code: 'bad_input', next: 'pass a smaller limit' });
    }
    return older(o);
  };
  const r = await run({ services: fakeServices({ stories: { ...s.stories, forProfile } }) });
  try {
    const { seen } = await walk(await r.client(), 'news_for_profile', { limit: 120 }, (page) => page.toJudge.flatMap((g: any) => g.stories.map((x: any) => x.id)), 120);
    assert.deepEqual(seen, all.map((x) => x.id));
    assert.deepEqual(s.asked.map((a) => a.limit), [100, 50, 50, 20], 'refused once, then never over 50');
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

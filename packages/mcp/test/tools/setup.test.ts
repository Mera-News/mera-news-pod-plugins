import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { FactView, ProfileSetup, TopicEdit } from 'mera-news-pod/plugin-api';
import { DONE, fakeServices, json, run, status } from './helpers';
import { instructions, prompts } from '../../src/text';

const fact = (topicsStatus: FactView['topicsStatus']): FactView => ({
  id: 'f1',
  statement: 'Lives in Utrecht',
  topicsStatus,
  addedAt: '2026-01-01T00:00:00.000Z',
  topics: topicsStatus === 'done' ? [{ id: 't1', text: 'Utrecht trams', weight: 0, source: 'generated', reviewed: false }] : [],
  needsReview: true,
});
const finding: ProfileSetup = { complete: false, findingTopics: ['Lives in Utrecht'], toReview: [], noTopics: [] };
const toReview: ProfileSetup = { complete: false, findingTopics: [], toReview: ['Lives in Utrecht'], noTopics: [] };

/** A profile whose one fact is still finding topics for the first `pendingCalls` reads. */
function profileAfter(pendingCalls: number) {
  let calls = 0;
  return {
    calls: () => calls,
    get: async () => (calls++ < pendingCalls ? { facts: [fact('pending')], setup: finding } : { facts: [fact('done')], setup: toReview }),
  };
}

test('get_profile: setup comes with the facts, and waitSeconds returns at once when nothing is finding topics', async () => {
  const p = profileAfter(0);
  const r = await run({ services: fakeServices({ profile: { get: p.get } }) });
  try {
    const c = await r.client();
    const started = Date.now();
    const got = json(await c.callTool({ name: 'get_profile', arguments: { waitSeconds: 45 } }));
    assert.ok(Date.now() - started < 900, 'it did not wait');
    assert.equal(p.calls(), 1);
    assert.deepEqual(got.setup, toReview);
    assert.equal(got.facts[0].topics[0].reviewed, false);
  } finally {
    await r.stop();
  }
});

test('get_profile: waitSeconds reads again each second until no fact is finding topics, or the time runs out', async () => {
  const p = profileAfter(2);
  const r = await run({ services: fakeServices({ profile: { get: p.get } }) });
  try {
    const c = await r.client();
    const got = json(await c.callTool({ name: 'get_profile', arguments: { waitSeconds: 10 } }));
    assert.equal(p.calls(), 3);
    assert.deepEqual(got.setup.findingTopics, []);
    assert.equal(got.facts[0].topicsStatus, 'done');

    const stuck = profileAfter(Infinity);
    const r2 = await run({ services: fakeServices({ profile: { get: stuck.get } }) });
    try {
      const started = Date.now();
      const late = json(await (await r2.client()).callTool({ name: 'get_profile', arguments: { waitSeconds: 1 } }));
      assert.ok(Date.now() - started >= 950 && Date.now() - started < 3000);
      assert.deepEqual(late.setup.findingTopics, ['Lives in Utrecht']);
    } finally {
      await r2.stop();
    }
    assert.equal(JSON.parse(((await c.callTool({ name: 'get_profile', arguments: { waitSeconds: 46 } })).content as { text: string }[])[0].text).code, 'bad_input');
  } finally {
    await r.stop();
  }
});

test('edit_topics: passes reviewed, notes the new counts for the session hint, and a refusal keeps its code', async () => {
  const edits: TopicEdit[] = [];
  let setup: ProfileSetup | undefined = toReview;
  const services = fakeServices({
    profile: {
      editTopics: async (e) => {
        edits.push(e);
        if (e.reviewed?.includes('pending')) throw Object.assign(new Error('Topics for this fact are still being made. Nothing was changed.'), { code: 'topics_pending', next: 'wait' });
        setup = undefined;
        return { results: [] };
      },
    },
    reading: { status: async () => status({ ...(setup ? { setup } : {}) }) },
  });
  const r = await run({ services });
  const hint = () => JSON.parse(readFileSync(path.join(r.home, 'data', 'plugins', 'mcp', 'hint.json'), 'utf8'));
  try {
    const c = await r.client();
    const s = json(await c.callTool({ name: 'get_status', arguments: {} }));
    assert.deepEqual(s.setup, toReview, 'get_status carries setup while it is not finished');
    assert.deepEqual(hint(), { facts: 1, toReview: 1, findingTopics: 0, noTopics: 0 });

    const refused = await c.callTool({ name: 'edit_topics', arguments: { reviewed: ['pending'] } });
    assert.equal(refused.isError, true);
    assert.equal(json(refused).code, 'topics_pending');

    await c.callTool({ name: 'edit_topics', arguments: { remove: ['t1'], reviewed: ['f1'] } });
    assert.deepEqual(edits.at(-1), { remove: ['t1'], reviewed: ['f1'] });
    assert.deepEqual(hint(), { facts: 1, toReview: 0, findingTopics: 0, noTopics: 0 });
    assert.ok(!readFileSync(path.join(r.home, 'data', 'plugins', 'mcp', 'hint.json'), 'utf8').includes('Utrecht'), 'the hint file holds counts only');
    assert.equal(json(await c.callTool({ name: 'get_status', arguments: {} })).setup, undefined);
  } finally {
    await r.stop();
  }
});

test('add_facts: while setup is not finished, the note asks for the topic review', async () => {
  let ai = true;
  const services = fakeServices({ reading: { status: async () => status({ setup: finding, ...(ai ? {} : { ai: null }) }) } });
  const r = await run({ services });
  try {
    const c = await r.client();
    const withAi = json(await c.callTool({ name: 'add_facts', arguments: { statements: ['Lives in Utrecht'] } }));
    assert.match(withAi.note, /waitSeconds/);
    assert.match(withAi.note, /edit_topics with reviewed/);
    ai = false;
    const written = json(await c.callTool({ name: 'add_facts', arguments: { statements: [{ statement: 'Lives in Utrecht', topics: ['Utrecht trams'] }] } }));
    assert.match(written.note, /^Saved\. Setup is not finished: .*edit_topics with reviewed/);
  } finally {
    await r.stop();
  }
});

test('get_profile: a long setup list is cut so the reply always fits', async () => {
  const many = Array.from({ length: 200 }, (_, i) => `A fact about the person, number ${i}, ${'with words '.repeat(25)}`);
  const services = fakeServices({ profile: { get: async () => ({ facts: [], setup: { ...DONE, complete: false, toReview: many, noTopics: many, findingTopics: many } }) } });
  const r = await run({ services });
  try {
    const got = json(await (await r.client()).callTool({ name: 'get_profile', arguments: {} }));
    assert.equal(got.setup.complete, false);
    assert.equal(got.setup.toReview.length, 10);
  } finally {
    await r.stop();
  }
});

test('get_profile: waitSeconds waits only for setup, not for a fact on the page that nothing is making topics for', async () => {
  let calls = 0;
  const appFact = { ...fact('pending'), needsReview: false };
  const r = await run({ services: fakeServices({ profile: { get: async () => (calls++, { facts: [appFact], setup: { ...DONE, complete: false, noTopics: ['Lives in Utrecht'] } }) } }) });
  try {
    const started = Date.now();
    await (await r.client()).callTool({ name: 'get_profile', arguments: { waitSeconds: 5 } });
    assert.ok(Date.now() - started < 900, 'it did not wait');
    assert.equal(calls, 1);
  } finally {
    await r.stop();
  }
});

test('the hint file counts facts left with no topics, and the review copy names no button', async () => {
  const setup: ProfileSetup = { complete: false, findingTopics: [], toReview: [], noTopics: ['Lives in Utrecht'] };
  const r = await run({ services: fakeServices({ reading: { status: async () => status({ setup }) } }) });
  try {
    const c = await r.client();
    const added = json(await c.callTool({ name: 'add_facts', arguments: { statements: ['Lives in Utrecht'] } }));
    assert.deepEqual(JSON.parse(readFileSync(path.join(r.home, 'data', 'plugins', 'mcp', 'hint.json'), 'utf8')), { facts: 1, toReview: 0, findingTopics: 0, noTopics: 1 });
    for (const text of [added.note, instructions, prompts.set_up_profile.text]) assert.doesNotMatch(text, /Save keeps/, text);
  } finally {
    await r.stop();
  }
});

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { descriptions, instructions, prompts } from '../../src/text';
import { fakeServices, json, run, status } from './helpers';

const COPYRIGHT =
  "Each article belongs to the publisher that reported it and is protected by copyright. It is meant to be read on the publisher's own site. Copying, downloading or summarising it without the publisher's permission may break copyright law, so I will not do that, and I will not get it another way, such as a web search. Journalism only survives when readers visit and support the people who make it. I can give you the headline and the link, open it in your browser, and if you read a publisher often, you can subscribe to it. Most AI apps' terms of use also forbid using them to copy or reproduce copyrighted work.";

test('the instructions give the copyright answer word for word, keep news to Mera News, label anything else, and offer next steps after news', () => {
  assert.ok(instructions.includes(`Whenever someone asks for a summary, the full text or a download of an article, answer with: "${COPYRIGHT}"`));
  assert.ok(instructions.includes('For any news question, use the Mera News tools. Do not use web search or your own knowledge for news unless the person asks for it by name.'));
  assert.ok(instructions.includes('mark it "Not from Mera News" above that part, or beside each such item.'));
  assert.match(instructions, /After every news answer, offer the next steps in one short line: top stories in the world, top stories in the person's countries \(from the places in their facts\), another country, everything left out, and the website as "Open in Mera News"\./);
  assert.match(instructions, /read every page, passing nextCursor as after, before you pick or answer\. Judge every story in toJudge with rate_stories/);
  assert.match(instructions, /put the summary numbers on top/);
  assert.doesNotMatch(descriptions.top_stories, /most reported first/);
  assert.match(descriptions.top_stories, /in the order Mera News ranks them, which is the order the Mera News app shows\. Show them in that order\./);
  assert.match(prompts.daily_digest.text, /read every page\. Judge every story in toJudge with rate_stories\. Show the summary numbers first/);
  assert.match(prompts.daily_digest.text, /then everything left out/);
  for (const text of [instructions, ...Object.values(descriptions), ...Object.values(prompts).map((p) => p.text)]) assert.doesNotMatch(text, /—|–/);
});

test('get_status with no AI service says the assistant fetches the news, never that reading is paused', async () => {
  const r = await run({ services: fakeServices({ reading: { status: async () => status({ ai: null, reading: 'paused' }) } }) });
  try {
    const s = json(await (await r.client()).callTool({ name: 'get_status', arguments: {} }));
    assert.equal(s.reading, 'when_asked');
    assert.equal(s.readingNote, 'Your assistant fetches the news when you ask, or when your digest runs.');
    assert.doesNotMatch(JSON.stringify(s), /paused/);
  } finally {
    await r.stop();
  }
  const ai = await run();
  try {
    assert.equal(json(await (await ai.client()).callTool({ name: 'get_status', arguments: {} })).reading, 'on', 'with an AI service the pod\'s own state shows');
  } finally {
    await ai.stop();
  }
});

test('choosing a digest time tells the assistant to create the scheduled task now and how to confirm it; a time long past with no digest is flagged', async () => {
  const r = await run();
  try {
    const c = await r.client();
    const saved = json(await c.callTool({ name: 'set_reading', arguments: { digestTimes: ['18:00', '08:00'] } }));
    assert.equal(
      saved.next,
      'If you can schedule tasks, create one now that runs the daily_digest prompt at 08:00 and 18:00, then tell the person: "Your news will come at 08:00 and 18:00. If this app is closed then, it comes when you next open it.", naming the AI app they use in place of "this app". If you cannot schedule tasks, tell them how to set one up.',
    );
    assert.equal(json(await c.callTool({ name: 'set_reading', arguments: { digestTimes: [] } })).next, undefined, 'no time, no task');
    assert.equal(json(await c.callTool({ name: 'get_status', arguments: {} })).digest.missed, undefined);

    const file = path.join(r.home, 'data', 'plugins', 'mcp', 'digest.json');
    writeFileSync(file, JSON.stringify({ times: [], everyMinutes: 60, lastAt: new Date(Date.now() - 3 * 3600_000).toISOString() }));
    const late = json(await c.callTool({ name: 'get_status', arguments: {} })).digest;
    assert.deepEqual([late.due, late.missed], [true, true]);
    json(await c.callTool({ name: 'digest_done', arguments: {} }));
    assert.equal(json(await c.callTool({ name: 'get_status', arguments: {} })).digest.missed, undefined);
    assert.ok(JSON.parse(readFileSync(file, 'utf8')).lastAt);
  } finally {
    await r.stop();
  }
});

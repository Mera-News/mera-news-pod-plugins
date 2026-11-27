import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lines, runCli } from '../bin/helpers';
import { run } from './helpers';

const NOTICE =
  "The articles in these results belong to their publishers. Give the reader the headline and the link, and send them to the publisher's site to read it there. Do not fetch, scrape, copy or summarise the article text from a publisher's site: that may breach the publisher's copyright. If the reader values a publisher, suggest they subscribe to it.";
const ATTRIBUTION = "Every story you show names its publisher and links to it, written as [headline](link), then the publisher's name.";
// A top_stories list names only the lead publisher; the person can still have every publisher.
const LEAD = 'A top_stories list gives the lead publisher and how many others reported the story';
const LINK_LINE = "Links go to the publisher's site. Do not extract article text from it; see the server instructions.";
// Owner rule: a headline is never reworded, the order is kept, and the number of reports is exact.
const VERBATIM = 'Never rewrite anything that comes from Mera News. Show every headline word for word as the result gives it';
const AS_GIVEN = 'Show every headline word for word, in the order given, with the exact number of reports.';
// Every tool whose reply carries links to articles.
const ARTICLE_TOOLS = ['get_suggestions', 'search_news', 'latest_news', 'top_stories', 'news_for_profile'];

test('publishers: the server instructions over HTTP carry the notice, and each article tool says it too', async () => {
  const r = await run();
  try {
    const c = await r.client();
    assert.ok(c.getInstructions()?.includes(NOTICE), 'the instructions carry the notice');
    assert.ok(c.getInstructions()?.includes(ATTRIBUTION), 'the instructions ask for the publisher and link on every story');
    const said = c.getInstructions() ?? '';
    assert.ok(said.includes(VERBATIM), 'the instructions forbid rewriting a headline');
    assert.match(said, /Translation is the one change allowed/);
    assert.match(said, /never re-rank them, sort them by number of reports, group them under your own headings or leave one out/);
    assert.match(said, /say so with the exact number from the result, never a rounded or estimated one: reportCount as "N reports"/);
    const { tools } = await c.listTools();
    for (const name of ARTICLE_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool?.description?.includes(LINK_LINE), `${name} carries the link line`);
      assert.ok(tool?.description?.includes(ATTRIBUTION), `${name} asks for the publisher and link`);
      assert.ok(tool?.description?.includes(AS_GIVEN), `${name} asks for headlines as given`);
      assert.ok(tool?.description?.includes(LEAD), `${name} says what a top_stories list names`);
    }
    assert.ok(c.getInstructions()?.includes(LEAD));
    const top = tools.find((t) => t.name === 'top_stories')!.description!;
    assert.match(top, /show the lead publisher and how many others reported it/);
    assert.match(top, /The person can ask for every publisher of a story: then call top_stories with story set to that story's id/);
  } finally {
    await r.stop();
  }
});

test('publishers: the notice reaches a client through the stdio bridge', async () => {
  const r = await run();
  try {
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    };
    const out = await runCli(['bridge', '--url', r.url, '--home', r.home], JSON.stringify(initialize) + '\n');
    assert.equal(out.code, 0, out.stderr);
    const answer = lines(out.stdout).map((l) => JSON.parse(l)).find((m) => m.id === 1);
    assert.ok(answer?.result?.instructions?.includes(NOTICE), out.stdout);
  } finally {
    await r.stop();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lines, runCli } from '../bin/helpers';
import { run } from './helpers';

const NOTICE =
  "The articles in these results belong to their publishers. Give the reader the headline and the link, and send them to the publisher's site to read it there. Do not fetch, scrape, copy or summarise the article text from a publisher's site: that may breach the publisher's copyright. If the reader values a publisher, suggest they subscribe to it.";
// Owner rule: every story carries its link, its publisher and how many others reported it, through a show line the code builds.
const SHOW_RULE = "Show each story by its show line, exactly as written. The headline text inside the brackets may be translated into the reader's language, and nothing else changes. Never write a story without its show line.";
const LINK_LINE = "Links go to the publisher's site. Do not extract article text from it; see the server instructions.";
// Owner rule: a headline is never reworded, the order is kept, and the number of reports is the one given.
const VERBATIM = 'Never rewrite anything from Mera News: do not shorten, reword or merge a headline';
// Every tool whose reply carries links to articles.
const ARTICLE_TOOLS = ['get_suggestions', 'search_news', 'latest_news', 'top_stories', 'news_for_profile'];

test('publishers: the server instructions over HTTP carry the notice, and each article tool says it too', async () => {
  const r = await run();
  try {
    const c = await r.client();
    const said = c.getInstructions() ?? '';
    assert.ok(said.includes(NOTICE), 'the instructions carry the notice');
    assert.ok(said.includes(SHOW_RULE), 'the instructions ask for every story by its show line');
    assert.ok(said.includes(VERBATIM), 'the instructions forbid rewriting a headline');
    assert.match(said, /never re-rank them, sort them by number of reports or leave one out/);
    assert.match(said, /A number of reports or publishers is only ever the one the show line gives/);
    const { tools } = await c.listTools();
    for (const name of ARTICLE_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool?.description?.includes(LINK_LINE), `${name} carries the link line`);
      assert.ok(tool?.description?.includes(SHOW_RULE), `${name} asks for every story by its show line`);
    }
    const top = tools.find((t) => t.name === 'top_stories')!.description!;
    assert.match(top, /its show line says how many other publications reported it/);
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

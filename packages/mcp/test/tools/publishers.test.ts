import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lines, runCli } from '../bin/helpers';
import { run } from './helpers';

const NOTICE =
  "The articles in these results belong to their publishers. Give the reader the headline and the link, and send them to the publisher's site to read it there. Do not fetch, scrape, copy or summarise the article text from a publisher's site: that may breach the publisher's copyright. If the reader values a publisher, suggest they subscribe to it.";
const LINK_LINE = "Links go to the publisher's site. Do not extract article text from it; see the server instructions.";
// Every tool whose reply carries links to articles.
const ARTICLE_TOOLS = ['get_suggestions'];

test('publishers: the server instructions over HTTP carry the notice, and each article tool says it too', async () => {
  const r = await run();
  try {
    const c = await r.client();
    assert.ok(c.getInstructions()?.includes(NOTICE), 'the instructions carry the notice');
    const { tools } = await c.listTools();
    for (const name of ARTICLE_TOOLS) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool?.description?.includes(LINK_LINE), `${name} carries the link line`);
    }
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

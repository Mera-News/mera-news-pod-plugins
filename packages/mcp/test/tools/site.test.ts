import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checkCode } from '../../src/link';
import { instructions, prompts } from '../../src/text';
import { json, run } from './helpers';

const KEY = 'a-link-key-for-tests-only-0123456789abcdef';

test('open_news_site gives a one-time link signed with the key the running website wrote', async () => {
  const r = await run();
  try {
    const c = await r.client();
    const web = path.join(r.home, 'data', 'plugins', 'web');
    const off = await c.callTool({ name: 'open_news_site', arguments: {} });
    assert.equal(off.isError, true);
    assert.equal(json(off).code, 'site_off');
    assert.match(json(off).next, /Also run the Mera News website on this computer/);

    mkdirSync(web, { recursive: true });
    writeFileSync(path.join(web, 'link-key'), `${KEY}\n`, { mode: 0o600 });
    writeFileSync(path.join(web, 'address.json'), JSON.stringify({ port: 4321, pid: process.pid }), { mode: 0o600 });
    const first = json(await c.callTool({ name: 'open_news_site', arguments: {} }));
    const second = json(await c.callTool({ name: 'open_news_site', arguments: {} }));
    assert.equal(first.label, 'Open in Mera News');
    const code = /^http:\/\/127\.0\.0\.1:4321\/#c=(\S+)$/.exec(first.url)![1];
    assert.ok(checkCode(KEY, code), 'the website accepts the code');
    assert.notEqual(first.url, second.url, 'every call gives a new code');

    // An address left by a process that is gone is not a running website.
    writeFileSync(path.join(web, 'address.json'), JSON.stringify({ port: 4321, pid: 2 ** 22 + 1 }));
    assert.equal(json(await c.callTool({ name: 'open_news_site', arguments: {} })).code, 'site_off');
    rmSync(path.join(web, 'address.json'));
  } finally {
    await r.stop();
  }
});

test('the assistant is told to offer the website after news and at first use', () => {
  assert.match(instructions, /The first time you help the person, and each time you show them news, offer it as a link named "Open in Mera News"/);
  assert.match(prompts.daily_digest.text, /the website as Open in Mera News with open_news_site/);
  for (const text of [instructions, prompts.daily_digest.text]) assert.doesNotMatch(text, /\u2014|\u2013/);
});

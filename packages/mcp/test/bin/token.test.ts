import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeEndpoint, lines, runCli, tempHome, tokenFile } from './helpers';

const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const echo = (b: any) => ({ json: { jsonrpc: '2.0', id: b.id, result: {} } });

test('rotate writes a new random token with mode 0600 and prints it once', async () => {
  const home = tempHome('old-token');
  const run = await runCli(['token', '--rotate', '--home', home]);
  assert.equal(run.code, 0, run.stderr);
  const now = readFileSync(tokenFile(home), 'utf8').trim();
  assert.notEqual(now, 'old-token');
  assert.ok(now.length >= 32);
  assert.equal(statSync(tokenFile(home)).mode & 0o777, 0o600);
  assert.equal(run.stdout.split(now).length - 1, 1);
  assert.ok(!run.stderr.includes(now));
  const again = await runCli(['token', '--rotate', '--home', home]);
  assert.notEqual(readFileSync(tokenFile(home), 'utf8').trim(), now);
  assert.ok(lines(again.stdout).length >= 1);
});

test('rotate creates the token and its folder when none exists', async () => {
  const home = tempHome();
  const run = await runCli(['token', '--rotate', '--home', home]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(statSync(tokenFile(home)).mode & 0o777, 0o600);
});

test('the old token stops working at once after rotation', async () => {
  const home = tempHome('old-token');
  // The fake endpoint reads the file on every request, the way the pod does.
  const fake = await fakeEndpoint(() => readFileSync(tokenFile(home), 'utf8').trim(), echo);
  const input = JSON.stringify(list) + '\n';
  const ask = (token: string) =>
    fetch(fake.url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: input });
  try {
    assert.equal((await ask('old-token')).status, 200);
    const rotated = await runCli(['token', '--rotate', '--home', home]);
    assert.equal((await ask('old-token')).status, 401);
    assert.equal((await ask(rotated.stdout.trim())).status, 200);
    const bridged = await runCli(['bridge', '--url', fake.url, '--home', home], input);
    assert.notEqual(JSON.parse(lines(bridged.stdout)[0]).result, undefined);
  } finally {
    await fake.close();
  }
});

test('rotate fails plainly without --rotate', async () => {
  const run = await runCli(['token', '--home', tempHome()]);
  assert.notEqual(run.code, 0);
  assert.equal(run.stdout, '');
});

test('a token file that is a link is refused, and the link target is never read', async () => {
  const home = tempHome();
  const elsewhere = `${home}-elsewhere`;
  writeFileSync(elsewhere, 'planted-token\n', { mode: 0o600 });
  mkdirSync(path.dirname(tokenFile(home)), { recursive: true });
  symlinkSync(elsewhere, tokenFile(home));
  const run = await runCli(['bridge', '--url', 'http://127.0.0.1:9/mcp', '--home', home], JSON.stringify(list) + '\n');
  assert.match(run.stderr, /not a plain file/);
  assert.ok(!run.stdout.includes('planted-token') && !run.stderr.includes('planted-token'));
});

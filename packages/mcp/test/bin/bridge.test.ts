import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeEndpoint, lines, runCli, tempHome, tokenFile } from './helpers';

const TOKEN = 'tok-abc';
const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_profile' } };
const note = { jsonrpc: '2.0', method: 'notifications/initialized' };

const echo = (b: any) => (b.id === undefined ? null : { json: { jsonrpc: '2.0', id: b.id, result: { method: b.method } } });

test('forwards requests with the bearer and prints answers one per line', async () => {
  const home = tempHome(TOKEN);
  const fake = await fakeEndpoint(() => TOKEN, echo);
  const run = await runCli(['bridge', '--url', fake.url, '--home', home], [list, call].map((m) => JSON.stringify(m)).join('\n') + '\n');
  await fake.close();
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(lines(run.stdout).map((l) => JSON.parse(l).id).sort(), [1, 2]);
  assert.deepEqual(fake.seen.map((s) => s.body.method).sort(), ['tools/call', 'tools/list']);
  for (const s of fake.seen) {
    assert.equal(s.auth, `Bearer ${TOKEN}`);
    assert.equal(s.accept, 'application/json, text/event-stream');
  }
});

test('writes each message of an event stream answer, and nothing for a 202', async () => {
  const home = tempHome(TOKEN);
  const fake = await fakeEndpoint(() => TOKEN, (b) =>
    b.id === undefined ? null : { sse: [{ jsonrpc: '2.0', method: 'notifications/progress' }, { jsonrpc: '2.0', id: b.id, result: {} }] });
  const run = await runCli(['bridge', '--url', fake.url, '--home', home], [note, list].map((m) => JSON.stringify(m)).join('\n') + '\n');
  await fake.close();
  assert.equal(run.code, 0, run.stderr);
  const out = lines(run.stdout).map((l) => JSON.parse(l));
  assert.equal(out.length, 2);
  assert.equal(out[1].id, 1);
});

test('standard output carries only protocol messages, even when everything fails', async () => {
  const home = tempHome(TOKEN);
  const fake = await fakeEndpoint(() => 'different', echo); // refuses our token
  const input = ['not json', JSON.stringify(list), JSON.stringify(note)].join('\n') + '\n';
  const refused = await runCli(['bridge', '--url', fake.url, '--home', home], input);
  await fake.close();
  const stopped = await runCli(['bridge', '--url', 'http://127.0.0.1:9/mcp', '--home', home], input);
  for (const run of [refused, stopped]) {
    for (const l of lines(run.stdout)) {
      const m = JSON.parse(l);
      assert.equal(m.jsonrpc, '2.0', l);
    }
    assert.ok(run.stderr.length > 0);
  }
});

test('a pod that is not running gives a plain sentence and a protocol error, not a hang', async () => {
  const home = tempHome(TOKEN);
  const run = await runCli(['bridge', '--url', 'http://127.0.0.1:9/mcp', '--home', home], JSON.stringify(list) + '\n');
  const out = lines(run.stdout).map((l) => JSON.parse(l));
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 1);
  assert.equal(typeof out[0].error.code, 'number');
  assert.match(out[0].error.message, /not running/);
  assert.match(run.stderr, /not running.*start it/i);
  assert.equal(lines(run.stderr).length, 1);
});

test('a pod that refuses the token gives a plain sentence and a protocol error', async () => {
  const home = tempHome(TOKEN);
  const fake = await fakeEndpoint(() => 'different', echo);
  const run = await runCli(['bridge', '--url', fake.url, '--home', home], JSON.stringify(list) + '\n');
  await fake.close();
  const out = lines(run.stdout).map((l) => JSON.parse(l));
  assert.match(out[0].error.message, /refused the token/);
  assert.match(run.stderr, /refused the token/);
  assert.equal(lines(run.stderr).length, 1);
});

test('a token file that others can read is refused with the fix, and the token is never echoed', async () => {
  const home = tempHome(TOKEN, 0o644);
  const fake = await fakeEndpoint(() => TOKEN, echo);
  const run = await runCli(['bridge', '--url', fake.url, '--home', home], JSON.stringify(list) + '\n');
  await fake.close();
  assert.equal(fake.seen.length, 0);
  assert.match(run.stderr, new RegExp(`chmod 600 .*${path.basename(tokenFile(home))}`));
  assert.ok(!run.stderr.includes(TOKEN) && !run.stdout.includes(TOKEN));
  assert.match(JSON.parse(lines(run.stdout)[0]).error.message, /chmod 600/);
});

test('a missing token file says how to create one', async () => {
  const home = tempHome();
  const run = await runCli(['bridge', '--url', 'http://127.0.0.1:9/mcp', '--home', home], JSON.stringify(list) + '\n');
  assert.match(run.stderr, /token --rotate/);
});

test('the bridge loads neither the pod package nor the client package', async () => {
  const home = tempHome(TOKEN);
  const fake = await fakeEndpoint(() => TOKEN, echo);
  const log = path.join(home, 'loaded.json');
  const hook = path.join(home, 'hook.cjs');
  writeFileSync(hook, `const M=require('module');const seen=new Set();const o=M._load;
M._load=function(r,...a){seen.add(r);return o.call(this,r,...a)};
process.on('exit',()=>require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify([...seen])));`);
  const run = await runCli(['bridge', '--url', fake.url, '--home', home], JSON.stringify(list) + '\n', {}, ['--require', hook]);
  await fake.close();
  assert.equal(run.code, 0, run.stderr);
  const loaded: string[] = JSON.parse(readFileSync(log, 'utf8'));
  assert.ok(loaded.length > 0);
  assert.deepEqual(loaded.filter((m) => /(^|node_modules\/)(mera-news-(pod|client)\b|.*sqlite)/.test(m)), []);
  // The same hook and the same pattern catch a script that does load the pod package.
  const control = path.join(home, 'control.cjs');
  writeFileSync(control, `require(require.resolve('mera-news-pod/plugin-api', { paths: [${JSON.stringify(path.resolve(__dirname, '../../../..'))}] }));`);
  execFileSync(process.execPath, ['--require', hook, control], { env: { ...process.env } });
  const controlLoaded: string[] = JSON.parse(readFileSync(log, 'utf8'));
  assert.ok(controlLoaded.some((m) => /(^|node_modules\/)(mera-news-(pod|client)\b|.*sqlite)/.test(m)), 'the control run loaded the pod package');
  const srcDir = path.resolve(__dirname, '../../src/bin');
  for (const f of readdirSync(srcDir)) {
    assert.doesNotMatch(readFileSync(path.join(srcDir, f), 'utf8'), /(from|require\()\s*['"]mera-news-(pod|client)['"/]/, f);
  }
});

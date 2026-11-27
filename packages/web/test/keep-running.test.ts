import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atLeast, codeOf, createKeepRunning, dataServerTakesKey, LABEL, plist, startedFile, type KeepRunningDeps, type NodeFound } from '../src/keep-running';

const KEY = 'news-key-from-the-app-0123456789';
// A Node.js that exists on every machine the tests run on: an agent naming a missing one is broken.
const NODE = process.execPath;

function setup(over: Partial<KeepRunningDeps> & { found?: NodeFound[]; failBootstrap?: boolean; failKickstart?: { times: number } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-running-'));
  const home = path.join(root, 'home & co');
  fs.mkdirSync(home);
  const serverFile = path.join(root, 'server', 'server.cjs');
  fs.mkdirSync(path.dirname(serverFile));
  fs.writeFileSync(serverFile, '');
  const calls: { args: string[]; later: boolean }[] = [];
  // The news key in secrets.json at the moment of each launchctl call.
  const keyAtCall: (string | undefined)[] = [];
  const deps: KeepRunningDeps = {
    home,
    serverFile,
    agentsDir: path.join(root, 'LaunchAgents'),
    platform: 'darwin',
    uid: 501,
    nodes: async () => over.found ?? [{ path: NODE, version: '24.4.1' }],
    hasBrew: () => true,
    launchctl(args, later = false) {
      calls.push({ args, later });
      try {
        keyAtCall.push(JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')).dataApiKey);
      } catch {
        keyAtCall.push(undefined);
      }
      if (args[0] === 'bootstrap' && over.failBootstrap) throw new Error('5: Input/output error');
      if (args[0] === 'kickstart' && over.failKickstart && over.failKickstart.times-- > 0) throw new Error('3: No such process');
    },
    env: { MERA_POD_DATA_API_KEY: KEY },
    // Unless a test says otherwise, the data server cannot be asked.
    keyAccepted: async () => null,
    ...over,
  };
  return { k: createKeepRunning(deps), deps, calls, keyAtCall, home, serverFile, file: path.join(deps.agentsDir, `${LABEL}.plist`) };
}

/** As after the agent was started on the files beside `serverFile`: an app start then has no update to apply. */
function startedOn(home: string, serverFile: string) {
  fs.mkdirSync(path.dirname(startedFile(home)), { recursive: true });
  fs.writeFileSync(startedFile(home), codeOf(path.dirname(serverFile)));
}

test('Node versions: 22.13 is the floor', () => {
  assert.ok(atLeast('22.13.0') && atLeast('v22.13.1') && atLeast('24.0.0'));
  assert.ok(!atLeast('22.12.9') && !atLeast('20.19.0') && !atLeast('v21.99.0'));
});

test('turning it on writes the LaunchAgent for this home and these server files, saves the app\'s key, and starts it', async () => {
  const { k, calls, home, serverFile, file } = setup();
  assert.deepEqual(await k.state(), {
    available: 'yes',
    on: false,
    broken: false,
    node: { path: NODE, version: '24.4.1' },
    oldNode: null,
    minNode: '22.13',
    install: 'brew install node',
    download: 'https://nodejs.org/en/download',
    copiesKey: true,
    log: path.join(home, 'logs', 'pod.log'),
  });
  const on = await k.turnOn();
  assert.equal(on.on, true);
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, plist(NODE, serverFile, home));
  // The serve mode of the same server.cjs, on the same home, logging under it; paths are XML-escaped.
  assert.match(text, /<key>Label<\/key><string>news\.mera\.pod<\/string>/);
  assert.ok(text.includes(`<string>${NODE}</string>\n    <string>${serverFile}</string>\n    <string>serve</string>`));
  assert.ok(text.includes(`<key>MERA_POD_HOME</key><string>${home.replace('&', '&amp;')}</string>`));
  assert.equal(text.match(new RegExp(`<string>${path.join(home, 'logs', 'pod.log').replace('&', '&amp;')}</string>`, 'g'))?.length, 2);
  assert.match(text, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.ok(!text.includes(KEY), 'no secret in the LaunchAgent');
  if (process.platform === 'darwin') execFileSync('plutil', ['-lint', file], { stdio: 'pipe' });
  assert.ok(fs.statSync(path.join(home, 'logs')).isDirectory());
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')), { dataApiKey: KEY });
  assert.equal(fs.statSync(path.join(home, 'secrets.json')).mode & 0o777, 0o600);
  assert.deepEqual(calls, [
    { args: ['bootout', 'gui/501/news.mera.pod'], later: false },
    { args: ['bootstrap', 'gui/501', file], later: false },
  ]);
  // Again: nothing more happens.
  await k.turnOn();
  assert.equal(calls.length, 2);
});

test('a key already in secrets.json is kept, and the others in it stay', async () => {
  const { k, home } = setup();
  fs.writeFileSync(path.join(home, 'secrets.json'), JSON.stringify({ dataApiKey: 'the-person-s-own-key-000', aiApiKey: 'ai' }));
  assert.equal((await k.state()).copiesKey, false);
  await k.turnOn();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')), { dataApiKey: 'the-person-s-own-key-000', aiApiKey: 'ai' });
});

test('turning it off removes the LaunchAgent and stops the job only after the reply', async () => {
  const { k, calls, file } = setup();
  await k.turnOn();
  calls.length = 0;
  const off = await k.turnOff();
  assert.equal(off.on, false);
  assert.ok(!fs.existsSync(file));
  assert.deepEqual(calls, [{ args: ['bootout', 'gui/501/news.mera.pod'], later: true }]);
  await k.turnOff();
  assert.equal(calls.length, 1, 'off when already off does nothing');
});

test('with no Node.js, or one too old, it says so, shows how to get one, and writes nothing', async () => {
  for (const found of [[], [{ path: '/usr/local/bin/node', version: '20.19.0' }]]) {
    const { k, calls, file, home } = setup({ found, hasBrew: () => false });
    const s = await k.state();
    assert.equal(s.node, null);
    assert.equal(s.oldNode, found[0]?.version ?? null);
    assert.equal(s.install, null);
    assert.equal(s.download, 'https://nodejs.org/en/download');
    await assert.rejects(k.turnOn(), (e: { code?: string; message: string }) => e.code === 'no_node' && /Node\.js 22\.13 or newer/.test(e.message));
    assert.ok(!fs.existsSync(file));
    assert.ok(!fs.existsSync(path.join(home, 'secrets.json')));
    assert.deepEqual(calls, []);
  }
});

test('off macOS, or outside the bundle, it is not offered', async () => {
  for (const [over, available] of [[{ platform: 'linux' }, 'not_mac'], [{ serverFile: null }, 'not_bundled']] as const) {
    const { k, calls } = setup(over);
    assert.deepEqual(await k.state(), { available, on: false });
    await assert.rejects(k.turnOn(), { code: 'not_available' });
    assert.deepEqual(calls, []);
  }
});

test('a LaunchAgent macOS refuses is removed again', async () => {
  const { k, file } = setup({ failBootstrap: true });
  await assert.rejects(k.turnOn(), { code: 'launchd_refused' });
  assert.ok(!fs.existsSync(file));
});

test('at an app\'s start, an agent whose server.cjs is gone is pointed at this one; one that exists is left alone', async () => {
  // No key from the app: this is about the agent's files only.
  const { k, calls, file, home, serverFile } = setup({ env: {} });
  await k.refresh();
  assert.equal(calls.length, 0, 'no agent, nothing to do');
  const other = path.join(path.dirname(path.dirname(serverFile)), 'other', 'server.cjs');
  fs.mkdirSync(path.dirname(other));
  fs.writeFileSync(other, '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist(process.execPath, other, home));
  startedOn(home, other);
  await k.refresh();
  assert.equal(calls.length, 0, 'another app\'s server.cjs that still exists keeps the agent');
  fs.rmSync(other);
  await k.refresh();
  assert.equal(fs.readFileSync(file, 'utf8'), plist(NODE, serverFile, home));
  assert.deepEqual(calls.map((c) => c.args[0]), ['bootout', 'bootstrap']);
});

test('a news.mera.pod LaunchAgent the person wrote, or one for another home, is never touched', async () => {
  const { k, calls, file, home } = setup();
  const handWritten = '<plist><dict><key>Label</key><string>news.mera.pod</string><key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/Users/you/mera-news-pod/build/cli.js</string><string>start</string></array></dict></plist>\n';
  for (const text of [handWritten, plist(NODE, path.join(home, 'gone', 'server.cjs'), '/Users/you/.other-pod')]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    assert.deepEqual(await k.state(), { available: 'other_agent', on: false });
    await assert.rejects(k.turnOn(), { code: 'not_available' });
    await k.turnOff();
    await k.refresh();
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.equal(calls.length, 0);
  }
});

test('an agent whose Node.js is gone is reported as broken, pointed at a Node.js that exists at the next app start, and turned on again', async () => {
  const { k, calls, file, home, serverFile } = setup();
  const gone = path.join(os.tmpdir(), 'no-such-node-version', 'bin', 'node');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist(gone, serverFile, home));
  const before = await k.state();
  assert.deepEqual([before.on, (before as { broken?: boolean }).broken], [true, true]);
  await k.refresh();
  assert.equal(fs.readFileSync(file, 'utf8'), plist(NODE, serverFile, home));
  assert.deepEqual(calls.map((c) => c.args[0]), ['bootout', 'bootstrap']);

  // Turning it on again rewrites a broken one too.
  fs.writeFileSync(file, plist(gone, serverFile, home));
  await k.turnOn();
  assert.equal(fs.readFileSync(file, 'utf8'), plist(NODE, serverFile, home));
});

const OLD_KEY = 'a-key-that-was-turned-off-0000';

function agentWithStoredKey(answers: { stored: boolean | null; app: boolean | null }, over: Parameters<typeof setup>[0] = {}) {
  const asked: string[] = [];
  const made = setup({ keyAccepted: async (key) => (asked.push(key), key === KEY ? answers.app : answers.stored), ...over });
  const secrets = path.join(made.home, 'secrets.json');
  fs.writeFileSync(secrets, JSON.stringify({ dataApiKey: OLD_KEY, aiApiKey: 'ai' }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(made.file), { recursive: true });
  fs.writeFileSync(made.file, plist(NODE, made.serverFile, made.home));
  startedOn(made.home, made.serverFile);
  return { ...made, asked, secrets, stored: () => JSON.parse(fs.readFileSync(secrets, 'utf8')) };
}

test('at an app\'s start, a key the data server refuses is replaced by the app\'s key it accepts, and the agent starts again', async () => {
  const { k, calls, keyAtCall, asked, secrets, stored } = agentWithStoredKey({ stored: false, app: true });
  await k.refresh();
  assert.deepEqual(stored(), { dataApiKey: KEY, aiApiKey: 'ai' });
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
  assert.deepEqual(calls, [{ args: ['kickstart', '-k', 'gui/501/news.mera.pod'], later: false }]);
  assert.deepEqual(keyAtCall, [KEY], 'the key is saved before the agent starts again, since it reads the file at its start');
  assert.deepEqual(asked, [OLD_KEY, KEY]);
  // The keys now match: the data server is not asked and nothing starts again.
  await k.refresh();
  assert.equal(calls.length, 1);
  assert.equal(asked.length, 2);
});

test('at an app\'s start, an agent whose secrets.json has no key gets the app\'s key without asking the data server', async () => {
  const { k, calls, asked, secrets, stored } = agentWithStoredKey({ stored: false, app: false });
  fs.writeFileSync(secrets, JSON.stringify({ aiApiKey: 'ai' }), { mode: 0o600 });
  await k.refresh();
  assert.deepEqual(stored(), { aiApiKey: 'ai', dataApiKey: KEY });
  assert.deepEqual(calls.map((c) => c.args), [['kickstart', '-k', 'gui/501/news.mera.pod']]);
  assert.equal(asked.length, 0);
});

test('a key in secrets.json that works or cannot be checked is never replaced, nor is any key by one the data server refuses', async () => {
  // Two apps can share a home: one still holding an old key must not break a pod that works.
  for (const answers of [
    { stored: true, app: true },
    { stored: null, app: true },
    { stored: false, app: false },
    { stored: false, app: null },
  ]) {
    const { k, calls, stored } = agentWithStoredKey(answers);
    await k.refresh();
    assert.deepEqual(stored(), { dataApiKey: OLD_KEY, aiApiKey: 'ai' }, JSON.stringify(answers));
    assert.equal(calls.length, 0, JSON.stringify(answers));
  }
  // A key that works is not even compared with the app's.
  const { k, asked } = agentWithStoredKey({ stored: true, app: true });
  await k.refresh();
  assert.deepEqual(asked, [OLD_KEY]);
});

test('with no agent, an app\'s start leaves secrets.json alone, and turning it on replaces a refused key', async () => {
  const { k, calls, file, stored } = agentWithStoredKey({ stored: false, app: true });
  fs.rmSync(file);
  await k.refresh();
  assert.deepEqual(stored(), { dataApiKey: OLD_KEY, aiApiKey: 'ai' });
  assert.equal(calls.length, 0);
  await k.turnOn();
  assert.deepEqual(stored(), { dataApiKey: KEY, aiApiKey: 'ai' });
  assert.deepEqual(calls.map((c) => c.args[0]), ['bootout', 'bootstrap']);
});

test('asking the data server about a key: refused, accepted, or not known', async () => {
  const seen: { url?: string; key?: string | string[]; body: string }[] = [];
  let answer: { status: number; body: string } = { status: 200, body: '{"data":{"recentArticleCount":3}}' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-api-key'], body });
      res.writeHead(answer.status, { 'content-type': 'application/json' }).end(answer.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-running-key-'));
  const results: (boolean | null)[] = [];
  try {
    fs.writeFileSync(path.join(root, 'pod.json'), JSON.stringify({ dataServer: { url: `${origin}/` } }));
    results.push(await dataServerTakesKey(root, KEY));
    answer = { status: 200, body: '{"errors":[{"message":"Invalid API key","extensions":{"code":"UNAUTHENTICATED"}}],"data":null}' };
    results.push(await dataServerTakesKey(root, KEY));
    answer = { status: 401, body: '' };
    results.push(await dataServerTakesKey(root, KEY));
    // Anything else says nothing about the key: a server error, another GraphQL error, no answer, no config.
    answer = { status: 503, body: '' };
    results.push(await dataServerTakesKey(root, KEY));
    answer = { status: 200, body: '{"errors":[{"message":"Not ready","extensions":{"code":"INDEX_NOT_READY"}}]}' };
    results.push(await dataServerTakesKey(root, KEY));
    fs.writeFileSync(path.join(root, 'pod.json'), JSON.stringify({ dataServer: { url: `${origin}/api/graphql` } }));
    answer = { status: 200, body: '{"data":{"recentArticleCount":0}}' };
    results.push(await dataServerTakesKey(root, KEY));
  } finally {
    await new Promise((r) => server.close(r));
  }
  results.push(await dataServerTakesKey(root, KEY));
  results.push(await dataServerTakesKey(path.join(root, 'no-such-home'), KEY));
  assert.deepEqual(results, [true, false, false, null, null, true, null, null]);
  assert.deepEqual(seen.map((s) => s.url), ['/graphql', '/graphql', '/graphql', '/graphql', '/graphql', '/api/graphql']);
  assert.ok(seen.every((s) => s.key === KEY && JSON.parse(s.body).query.includes('recentArticleCount')));
});

test('asking the data server about a key never follows a redirect, so the key reaches no other address', async () => {
  let elsewhere = 0;
  const other = http.createServer((_req, res) => {
    elsewhere++;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"recentArticleCount":1}}');
  });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(307, { location: `http://127.0.0.1:${(other.address() as AddressInfo).port}/graphql` }).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-running-key-'));
  fs.writeFileSync(path.join(root, 'pod.json'), JSON.stringify({ dataServer: { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } }));
  let result: boolean | null;
  try {
    result = await dataServerTakesKey(root, KEY);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => other.close(r));
  }
  assert.equal(result, null);
  assert.equal(elsewhere, 0);
});

test('a restart that fails leaves the old key in place, so the next app start tries again', async () => {
  const { k, calls, secrets, stored } = agentWithStoredKey({ stored: false, app: true }, { failKickstart: { times: 1 } });
  await k.refresh();
  assert.deepEqual(stored(), { dataApiKey: OLD_KEY, aiApiKey: 'ai' });
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
  await k.refresh();
  assert.deepEqual(stored(), { dataApiKey: KEY, aiApiKey: 'ai' });
  assert.deepEqual(calls.map((c) => c.args[0]), ['kickstart', 'kickstart']);
  // With no secrets.json before, a failed restart leaves none behind.
  const none = setup({ failKickstart: { times: 1 } });
  fs.mkdirSync(path.dirname(none.file), { recursive: true });
  fs.writeFileSync(none.file, plist(NODE, none.serverFile, none.home));
  await none.k.refresh();
  assert.ok(!fs.existsSync(path.join(none.home, 'secrets.json')));
  await none.k.refresh();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(none.home, 'secrets.json'), 'utf8')), { dataApiKey: KEY });
});

test('an agent pointed at new files at an app\'s start gets the changed key too', async () => {
  const { k, calls, keyAtCall, file, home, serverFile, stored } = agentWithStoredKey({ stored: false, app: true });
  // An update moved the plugin: the agent names a server.cjs that is gone.
  fs.writeFileSync(file, plist(NODE, path.join(path.dirname(serverFile), 'gone', 'server.cjs'), home));
  await k.refresh();
  assert.deepEqual(stored(), { dataApiKey: KEY, aiApiKey: 'ai' });
  assert.deepEqual(calls.map((c) => c.args[0]), ['bootout', 'bootstrap']);
  assert.deepEqual(keyAtCall, [KEY, KEY]);
});

test('after an update, an app start restarts the agent once, since it keeps running the code it loaded', async () => {
  const { k, calls, file, home, serverFile } = setup({ env: {} });
  await k.turnOn();
  const afterOn = calls.length;
  await k.refresh();
  assert.equal(calls.length, afterOn, 'turned on with these files: nothing to apply');

  // The update: new code in the agent's folder, and the website's build marker.
  fs.writeFileSync(path.join(path.dirname(serverFile), 'mcp-plugin.cjs'), 'new code');
  await k.refresh();
  assert.deepEqual(calls.slice(afterOn).map((c) => c.args), [['kickstart', '-k', `gui/501/${LABEL}`]]);
  await k.refresh();
  assert.equal(calls.length, afterOn + 1, 'once per update');
  fs.mkdirSync(path.join(path.dirname(serverFile), 'web'));
  fs.writeFileSync(path.join(path.dirname(serverFile), 'web', 'BUILD-SOURCE.txt'), 'site 2');
  await k.refresh();
  assert.equal(calls.length, afterOn + 2, 'a new website build is an update too');
  assert.equal(fs.readFileSync(file, 'utf8'), plist(NODE, serverFile, home), 'the agent itself is not rewritten');
});

test('an agent started before this was recorded is restarted once at the next app start, whichever app\'s files it runs', async () => {
  const { k, calls, file, home, serverFile } = setup({ env: {} });
  const other = path.join(path.dirname(path.dirname(serverFile)), 'other', 'server.cjs');
  fs.mkdirSync(path.dirname(other));
  fs.writeFileSync(other, 'the other app');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist(NODE, other, home));
  await k.refresh();
  await k.refresh();
  assert.deepEqual(calls.map((c) => c.args[0]), ['kickstart']);
  assert.equal(fs.readFileSync(file, 'utf8'), plist(NODE, other, home), 'still the other app\'s agent');
  assert.equal(fs.readFileSync(startedFile(home), 'utf8').trim(), codeOf(path.dirname(other)), 'judged by the files the agent runs, not this app\'s');
});

test('a restart after an update that fails is tried again at the next app start, and secrets.json is left alone', async () => {
  const { k, calls, file, home, serverFile } = setup({ env: {}, failKickstart: { times: 1 } });
  const secrets = path.join(home, 'secrets.json');
  fs.writeFileSync(secrets, JSON.stringify({ dataApiKey: 'kept' }), { mode: 0o600 });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist(NODE, serverFile, home));
  await k.refresh();
  assert.equal(fs.existsSync(startedFile(home)), false, 'not recorded as started');
  assert.equal(JSON.parse(fs.readFileSync(secrets, 'utf8')).dataApiKey, 'kept');
  await k.refresh();
  assert.deepEqual(calls.map((c) => c.args[0]), ['kickstart', 'kickstart']);
  assert.equal(fs.readFileSync(startedFile(home), 'utf8').trim(), codeOf(path.dirname(serverFile)));
});

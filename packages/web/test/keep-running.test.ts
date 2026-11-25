import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { atLeast, createKeepRunning, LABEL, plist, type KeepRunningDeps, type NodeFound } from '../src/keep-running';

const KEY = 'news-key-from-the-app-0123456789';

function setup(over: Partial<KeepRunningDeps> & { found?: NodeFound[]; failBootstrap?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'keep-running-'));
  const home = path.join(root, 'home & co');
  fs.mkdirSync(home);
  const serverFile = path.join(root, 'server', 'server.cjs');
  fs.mkdirSync(path.dirname(serverFile));
  fs.writeFileSync(serverFile, '');
  const calls: { args: string[]; later: boolean }[] = [];
  const deps: KeepRunningDeps = {
    home,
    serverFile,
    agentsDir: path.join(root, 'LaunchAgents'),
    platform: 'darwin',
    uid: 501,
    nodes: async () => over.found ?? [{ path: '/opt/homebrew/bin/node', version: '24.4.1' }],
    hasBrew: () => true,
    launchctl(args, later = false) {
      calls.push({ args, later });
      if (args[0] === 'bootstrap' && over.failBootstrap) throw new Error('5: Input/output error');
    },
    env: { MERA_POD_DATA_API_KEY: KEY },
    ...over,
  };
  return { k: createKeepRunning(deps), deps, calls, home, serverFile, file: path.join(deps.agentsDir, `${LABEL}.plist`) };
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
    node: { path: '/opt/homebrew/bin/node', version: '24.4.1' },
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
  assert.equal(text, plist('/opt/homebrew/bin/node', serverFile, home));
  // The serve mode of the same server.cjs, on the same home, logging under it; paths are XML-escaped.
  assert.match(text, /<key>Label<\/key><string>news\.mera\.pod<\/string>/);
  assert.ok(text.includes(`<string>/opt/homebrew/bin/node</string>\n    <string>${serverFile}</string>\n    <string>serve</string>`));
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
  const { k, calls, file, home, serverFile } = setup();
  await k.refresh();
  assert.equal(calls.length, 0, 'no agent, nothing to do');
  const other = path.join(path.dirname(path.dirname(serverFile)), 'other', 'server.cjs');
  fs.mkdirSync(path.dirname(other));
  fs.writeFileSync(other, '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, plist('/opt/homebrew/bin/node', other, home));
  await k.refresh();
  assert.equal(calls.length, 0, 'another app\'s server.cjs that still exists keeps the agent');
  fs.rmSync(other);
  await k.refresh();
  assert.equal(fs.readFileSync(file, 'utf8'), plist('/opt/homebrew/bin/node', serverFile, home));
  assert.deepEqual(calls.map((c) => c.args[0]), ['bootout', 'bootstrap']);
});

test('a news.mera.pod LaunchAgent the person wrote, or one for another home, is never touched', async () => {
  const { k, calls, file, home } = setup();
  const handWritten = '<plist><dict><key>Label</key><string>news.mera.pod</string><key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/Users/you/mera-news-pod/build/cli.js</string><string>start</string></array></dict></plist>\n';
  for (const text of [handWritten, plist('/opt/homebrew/bin/node', path.join(home, 'gone', 'server.cjs'), '/Users/you/.other-pod')]) {
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

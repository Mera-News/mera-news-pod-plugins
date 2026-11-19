// A paired phone, a stored wake-up pass and a new pick, end to end: the built pod and the built sync
// plugin under plain node, with a fake relay on loopback over https (the pod only accepts an https relay).
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { defaultSchemaPath, startFakeDataServer, startFakeModel, type FakeDataServer, type FakeModel } from 'mera-news-pod/testing';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CAP = 'wakeup-capability-for-the-e2e-test';
const plainEnv = (extra: NodeJS.ProcessEnv = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
};
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

const articles = ['Chess olympiad opens in Budapest with record entries', 'Harbour regatta moved to Sunday after storm warning'].map((title, i) => ({
  _id: `a${i + 1}`,
  title,
  pubDate: new Date(Date.now() - i * 60_000).toISOString(),
}));

let data: FakeDataServer;
let model: FakeModel;
let relay: https.Server;
let home: string;
let pod: ChildProcess;
const pings: { url?: string; body: string }[] = [];
const output: string[] = [];

before(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pod-wake-'));
  const key = path.join(home, 'relay.key');
  const cert = path.join(home, 'relay.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  relay = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      pings.push({ url: req.url, body });
      res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
    });
  });
  const relayPort = await new Promise<number>((resolve) => relay.listen(0, '127.0.0.1', () => resolve((relay.address() as net.AddressInfo).port)));
  data = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles, topics: { 'follows chess': ['a1'], 'chess latest': ['a1'] } });
  model = await startFakeModel();
  const port = await freePort();
  writeFileSync(
    path.join(home, 'pod.json'),
    JSON.stringify({
      dataServer: { url: data.origin },
      ai: { baseUrl: model.baseUrl, model: 'm' },
      language: 'en',
      wakeRelay: `https://127.0.0.1:${relayPort}`,
      plugins: [{ package: path.resolve(__dirname, '..', '..'), config: { port, podName: 'Test pod' } }],
    }),
    { mode: 0o600 },
  );
  const podCli = path.join(path.dirname(require.resolve('mera-news-pod/package.json')), 'build/cli.js');
  pod = spawn(process.execPath, [podCli, 'start'], { env: plainEnv({ MERA_POD_HOME: home, MERA_POD_INTERVAL_SECONDS: '2', NODE_EXTRA_CA_CERTS: cert }), stdio: ['ignore', 'pipe', 'pipe'] });
  process.on('exit', () => pod.kill('SIGKILL'));
  for (const stream of [pod.stdout!, pod.stderr!]) stream.on('data', (chunk) => output.push(...String(chunk).split('\n').filter(Boolean)));
  (globalThis as { __port?: number }).__port = port;
});

after(async () => {
  if (pod && pod.exitCode === null && pod.signalCode === null) pod.kill('SIGKILL');
  await Promise.all([data?.close(), model?.close(), new Promise((r) => (relay ? relay.close(r) : r(0)))]);
  if (home) rmSync(home, { recursive: true, force: true });
});

test('pairing, a stored capability and a planted pick give exactly one ping at the fake relay', async () => {
  const port = (globalThis as { __port?: number }).__port!;
  const tail = () => `last pod output:\n${output.slice(-15).join('\n')}`;
  let token = '';
  const request = (method: string, route: string, body?: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      });
      req.setTimeout(30_000, () => req.destroy(new Error(`no answer from ${route} within 30 s\n${tail()}`)));
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  for (const end = Date.now() + 60_000; ; await sleep(200)) {
    if (pod.exitCode !== null) assert.fail(`the pod ended early\n${tail()}`);
    if ((await request('GET', '/status').catch(() => ({ status: 0 }))).status === 401) break;
    if (Date.now() > end) assert.fail(`the sync address never answered\n${tail()}`);
  }

  const printed = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'build', 'bin', 'cli.js'), 'pair', '--home', home], { env: plainEnv(), encoding: 'utf8' });
  const code = /Pairing code: ([A-Z2-7]{10})/.exec(printed)?.[1];
  assert.ok(code, printed);
  const paired = JSON.parse((await request('POST', '/pair', { code, deviceName: 'Phone' })).text);
  token = paired.token;
  assert.equal((await request('POST', '/ping', { capability: CAP, expiresAt: 1_900_000_000 })).status, 200);
  const status = JSON.parse((await request('GET', '/status')).text);
  assert.deepEqual([status.wakeups, status.relayOrigin?.startsWith('https://127.0.0.1:')], ['on', true]);

  // The new pick: a fact makes the pod read and rate the planted article. The phone then goes quiet
  // (its last sighting is moved back), so the wake-up is not held for the 2 minutes after it.
  const versions = { schemaVersion: status.schemaVersion, registry: status.registry };
  assert.equal((await request('POST', '/commands', { ...versions, hashes: {}, commands: [{ name: 'addFact', args: ['Follows chess'] }] })).status, 200);
  const seenFile = path.join(home, 'data', 'plugins', 'sync', 'seen.json');
  writeFileSync(`${seenFile}.tmp`, JSON.stringify({ [paired.deviceId]: '2000-01-01T00:00:00.000Z' }), { mode: 0o600 });
  renameSync(`${seenFile}.tmp`, seenFile);

  for (const end = Date.now() + 45_000; pings.length === 0; await sleep(200)) if (Date.now() > end) assert.fail(`no ping reached the relay within 45 s\n${tail()}`);
  await sleep(6000); // more reading rounds: inside the window they add nothing
  assert.equal(pings.length, 1, tail());
  assert.equal(pings[0].url, '/api/pod/ping');
  assert.deepEqual(JSON.parse(pings[0].body), { capability: CAP });
  assert.deepEqual(output.filter((l) => l.includes(CAP)), [], 'the capability is printed nowhere');
  assert.deepEqual(output.filter((l) => l.includes('blocked request to')), []);
  pod.kill('SIGTERM');
});

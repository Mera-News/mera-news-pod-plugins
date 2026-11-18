// A paired phone end to end: the pod's own command and the built sync plugin and its command line,
// all under plain node, against the pod's fakes. The test plays the phone over HTTP.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { defaultSchemaPath, recordedOrigins, startFakeDataServer, startFakeModel, type FakeDataServer, type FakeModel } from 'mera-news-pod/testing';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUILT = path.resolve(__dirname, '..', '..', 'build');
// No loader reaches what a person runs.
const plainEnv = (extra: NodeJS.ProcessEnv = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

const articles = [
  'Chess olympiad opens in Budapest with record entries',
  'Harbour regatta moved to Sunday after storm warning',
  'Central bank holds interest rates steady',
].map((title, i) => ({ _id: `a${i + 1}`, title, pubDate: new Date(Date.now() - i * 60_000).toISOString() }));
// The topics the fake model makes for "Follows chess": "Follows news", "Follows chess", "chess latest".
const topics = { 'follows chess': ['a1'], 'chess latest': ['a1'] };

describe('a phone paired to a pod through the sync plugin', () => {
  let data: FakeDataServer;
  let model: FakeModel;
  let home: string;
  let pod: ChildProcess;
  let port: number;
  let exit: { code: number | null } | undefined;
  const output: string[] = [];
  let token = '';
  let deviceId = '';
  let versions = { schemaVersion: 0, registry: 0 };

  const tail = () => `last pod output:\n${output.slice(-15).join('\n')}`;
  const cli = (...args: string[]) => execFileSync(process.execPath, [path.join(BUILT, 'bin', 'cli.js'), ...args, '--home', home], { env: plainEnv(), encoding: 'utf8' });

  function request(method: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: route, method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } },
        (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.setTimeout(30_000, () => req.destroy(new Error(`no answer from ${route} within 30 s\n${tail()}`)));
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const post = async (route: string, body: unknown) => {
    const r = await request('POST', route, body);
    assert.equal(r.status, 200, `${route} answered ${r.status}: ${r.text}\n${tail()}`);
    return JSON.parse(r.text);
  };

  before(async () => {
    data = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles, topics });
    model = await startFakeModel();
    home = mkdtempSync(path.join(os.tmpdir(), 'pod-sync-'));
    port = await freePort();
    writeFileSync(
      path.join(home, 'pod.json'),
      JSON.stringify({
        dataServer: { url: data.origin },
        ai: { baseUrl: model.baseUrl, model: 'm' },
        language: 'en',
        plugins: [{ package: path.resolve(__dirname, '..', '..'), config: { port, podName: 'Test pod' } }],
      }),
      { mode: 0o600 },
    );
    const podCli = path.join(path.dirname(require.resolve('mera-news-pod/package.json')), 'build/cli.js');
    pod = spawn(process.execPath, [podCli, 'start'], { env: plainEnv({ MERA_POD_HOME: home, MERA_POD_INTERVAL_SECONDS: '2' }), stdio: ['ignore', 'pipe', 'pipe'] });
    // shortcut: a test runner killed with SIGKILL leaves the pod running, upgrade if that happens in CI.
    process.on('exit', () => pod.kill('SIGKILL'));
    for (const stream of [pod.stdout!, pod.stderr!]) stream.on('data', (chunk) => output.push(...String(chunk).split('\n').filter(Boolean)));
    pod.on('exit', (code) => (exit = { code }));
    for (const end = Date.now() + 60_000; ; await sleep(200)) {
      if (exit) assert.fail(`the pod ended early\n${tail()}`);
      if ((await request('GET', '/status').catch(() => ({ status: 0 }))).status === 401) break;
      if (Date.now() > end) assert.fail(`the sync address never answered\n${tail()}`);
    }
  });

  after(async () => {
    if (pod && pod.exitCode === null && pod.signalCode === null) pod.kill('SIGKILL');
    await Promise.all([data?.close(), model?.close()]);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('pairs with the code the command line prints, and refuses a wrong one first', async () => {
    const printed = cli('pair', '--base', 'https://pod.example.com');
    const code = /Pairing code: ([A-Z2-7]{10})/.exec(printed)?.[1];
    assert.ok(code, printed);
    assert.match(printed, new RegExp(`meraapp://pod-pair\\?u=https%3A%2F%2Fpod\\.example\\.com&c=${code}`));
    const wrong = await request('POST', '/pair', { code: code.slice(0, 9) + (code[9] === 'A' ? 'B' : 'A'), deviceName: 'Phone' });
    assert.equal(wrong.status, 403);
    const paired = await post('/pair', { code, deviceName: 'Phone' });
    assert.deepEqual(Object.keys(paired).sort(), ['deviceId', 'podName', 'token']);
    assert.equal(paired.podName, 'Test pod');
    token = paired.token;
    deviceId = paired.deviceId;
    const status = JSON.parse((await request('GET', '/status')).text);
    versions = { schemaVersion: status.schemaVersion, registry: status.registry };
    assert.ok(versions.schemaVersion > 0 && versions.registry > 0, JSON.stringify(status));
  });

  it('runs a command on the pod and answers with the pod\'s row in the same round trip', async () => {
    const reply = await post('/commands', { ...versions, hashes: {}, commands: [{ name: 'addFact', args: ['Follows chess'] }] });
    assert.ok('ok' in reply.results[0], JSON.stringify(reply.results));
    const facts = reply.snapshot.tables.facts.rows as { id: string; statement: string }[];
    assert.deepEqual(facts.map((f) => f.statement), ['Follows chess']);
    assert.ok(facts[0].id);
  });

  it('serves the feed the pod read, and only the tables that changed', async () => {
    let snapshot: any;
    for (const end = Date.now() + 90_000; ; await sleep(1000)) {
      snapshot = await post('/snapshot', { ...versions, hashes: {} });
      if ((snapshot.tables.article_suggestions.rows ?? []).some((r: { status: string }) => r.status === 'complete')) break;
      if (Date.now() > end) assert.fail(`no rated article within 90 s\n${tail()}`);
    }
    const hashes = Object.fromEntries(Object.entries(snapshot.tables).map(([name, t]) => [name, (t as { hash: string }).hash]));
    const again = await post('/snapshot', { ...versions, hashes });
    assert.deepEqual(Object.values(again.tables).filter((t) => (t as { rows?: unknown[] }).rows), []);
    assert.equal(snapshot.tables.conversations, undefined, 'a phone-only table is never served');
  });

  it('streams a chat completion from the pod\'s model with the pod\'s key, and passes a news query to its data server', async () => {
    const chat = await request('POST', '/v1/chat/completions', { messages: [{ role: 'user', content: 'Fact: "Follows chess"' }], stream: true });
    assert.equal(chat.status, 200, chat.text);
    const lines = chat.text.split('\n').filter((l) => l.startsWith('data: '));
    assert.equal(lines.at(-1), 'data: [DONE]');
    assert.ok(lines.length > 2, 'more than one delta');

    const before = data.requests.length;
    const news = await request('POST', '/graphql', { operationName: 'GetRecentArticleCount', query: 'query GetRecentArticleCount { recentArticleCount }' }, { cookie: 'session=phone' });
    assert.equal(news.status, 200, news.text);
    assert.equal(typeof JSON.parse(news.text).data.recentArticleCount, 'number');
    const sent = data.requests.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].headers.cookie, undefined, 'the phone\'s cookie never reaches the news server');
    const refused = await request('POST', '/graphql', { operationName: 'GetUserPersona', query: 'query GetUserPersona { me { id } }' });
    assert.equal(JSON.parse(refused.text).errors[0].extensions.code, 'NOT_ALLOWED');
  });

  it('issues no second pairing code while the phone is paired', () => {
    assert.throws(
      () => execFileSync(process.execPath, [path.join(BUILT, 'bin', 'cli.js'), 'pair', '--home', home], { env: plainEnv(), encoding: 'utf8', stdio: 'pipe' }),
      (e: { status?: number; stderr?: string }) => e.status === 1 && /already paired/.test(e.stderr ?? '') && new RegExp(`devices --revoke ${deviceId}`).test(e.stderr ?? ''),
    );
  });

  it('refuses a phone on another version, naming the older side', async () => {
    const reply = await request('POST', '/snapshot', { ...versions, registry: versions.registry + 1, hashes: {} });
    assert.equal(reply.status, 409);
    assert.match(JSON.parse(reply.text).message, /The pod is older/);
  });

  it('refuses a device revoked from the command line on its next request', async () => {
    cli('devices', '--revoke', deviceId);
    assert.equal((await request('GET', '/status')).status, 401);
  });

  it('reached only its two fakes and stops on SIGTERM with exit code 0', async () => {
    assert.deepEqual(recordedOrigins(data, model), [data.origin, model.origin].sort());
    assert.deepEqual(output.filter((l) => l.includes('blocked request to')), []);
    assert.deepEqual(output.filter((l) => l.includes(token)), [], 'the token is printed nowhere');
    pod.kill('SIGTERM');
    for (const end = Date.now() + 15_000; !exit && Date.now() < end; ) await sleep(100);
    assert.equal(exit?.code, 0, tail());
  });
});

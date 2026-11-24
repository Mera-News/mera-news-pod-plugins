import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, describe, it } from 'node:test';
import { defaultSchemaPath, startFakeDataServer, type FakeDataServer } from 'mera-news-pod/testing';

const pkg = path.resolve(__dirname, '..');
const repo = path.resolve(pkg, '../..');
const dist = path.join(pkg, 'dist');
const KEY = 'test-key-not-secret';

const newest = (dir: string): number =>
  Math.max(...readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? newest(path.join(dir, e.name)) : statSync(path.join(dir, e.name)).mtimeMs)));

/** One running copy of the bundle, spoken to over stdio as an AI app would. */
function startServer(dir: string, home: string, extraEnv: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = { ...process.env, MERA_POD_HOME: home, ...extraEnv };
  delete env.NODE_OPTIONS; // plain node, as the app runs it
  const child = spawn(process.execPath, [path.join(dir, 'server.cjs')], { env, stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
  process.on('exit', () => child.kill('SIGKILL'));
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => (waiting.length ? waiting.shift()!(line) : lines.push(line)));
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  let id = 0;
  const next = () =>
    new Promise<string>((resolve, reject) => {
      if (lines.length) return resolve(lines.shift()!);
      const timer = setTimeout(() => reject(new Error(`no answer in 45 s\n${stderr}`)), 45_000);
      waiting.push((l) => (clearTimeout(timer), resolve(l)));
    });
  return {
    child,
    stderr: () => stderr,
    async request(method: string, params: object = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })}\n`);
      const line = await next();
      return JSON.parse(line) as { result?: any; error?: { message: string } }; // every stdout line must be JSON
    },
    notify(method: string) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    async close() {
      const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
      child.stdin.end();
      return exited;
    },
  };
}

async function connect(s: ReturnType<typeof startServer>) {
  const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.ok(init.result, `initialize failed: ${init.error?.message}\n${s.stderr()}`);
  s.notify('notifications/initialized');
  const tools = await s.request('tools/list');
  return (tools.result?.tools ?? []).map((t: { name: string }) => t.name) as string[];
}

describe('the bundle, run as an AI app runs it', () => {
  let data: FakeDataServer;
  let dir: string;

  before(async () => {
    assert.ok(existsSync(path.join(dist, 'server.cjs')), 'run npm run build first');
    const built = statSync(path.join(dist, 'server.cjs')).mtimeMs;
    const sources = Math.max(newest(path.join(pkg, 'src')), newest(path.join(repo, 'packages/mcp/src')));
    assert.ok(built >= sources, 'the bundle is older than its sources: run npm run build');
    // A copy away from the repo: the bundle must need no node_modules.
    dir = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-'));
    for (const f of ['server.cjs', 'mcp-plugin.cjs']) copyFileSync(path.join(dist, f), path.join(dir, f));
    data = await startFakeDataServer({ schemaPath: defaultSchemaPath(), apiKey: KEY, articles: [{ _id: 'a1', title: 'Tram line approved' }], topics: { 'utrecht trams': ['a1'] } });
  });

  after(async () => {
    await data.close();
  });

  it('first run: writes pod.json without the key, serves the tools on stdio, and stops when the app closes stdin', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-home-'));
    const s = startServer(dir, home, { MERA_NEWS_DATA_SERVER_URL: data.origin, MERA_POD_DATA_API_KEY: KEY });
    const tools = await connect(s);
    assert.ok(tools.includes('search_news') && tools.includes('get_suggestions'), tools.join(','));
    const found = await s.request('tools/call', { name: 'search_news', arguments: { query: 'tram' } });
    assert.match(JSON.stringify(found.result), /Tram line approved/, s.stderr());

    const files = ['pod.json', 'secrets.json'].map((f) => readFileSync(path.join(home, f), 'utf8')).join('\n');
    assert.ok(!files.includes(KEY), 'the key is never written to disk');
    assert.equal(JSON.parse(readFileSync(path.join(home, 'pod.json'), 'utf8')).dataServer.url, data.origin);
    assert.equal(await s.close(), 0);

    // The lock went with the process: the next run starts its own pod again.
    const again = startServer(dir, home, { MERA_POD_DATA_API_KEY: KEY });
    assert.ok((await connect(again)).length > 0);
    assert.doesNotMatch(again.stderr(), /already running/);
    assert.equal(await again.close(), 0);
  });

  it('a second app on the same home connects to the pod the first one runs', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-home-'));
    const env = { MERA_NEWS_DATA_SERVER_URL: data.origin, MERA_POD_DATA_API_KEY: KEY };
    const first = startServer(dir, home, env);
    await connect(first);
    const second = startServer(dir, home, env);
    assert.ok((await connect(second)).includes('search_news'));
    assert.match(second.stderr(), /already running for this home/);
    assert.equal(await second.close(), 0);
    assert.equal(await first.close(), 0);
  });

  it('an unset key the app hands over as quoting debris falls back to the key in secrets.json', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-home-'));
    const first = startServer(dir, home, { MERA_NEWS_DATA_SERVER_URL: data.origin, MERA_POD_DATA_API_KEY: KEY });
    await connect(first);
    assert.equal(await first.close(), 0);
    writeFileSync(path.join(home, 'secrets.json'), JSON.stringify({ dataApiKey: KEY }), { mode: 0o600 });
    const s = startServer(dir, home, { MERA_POD_DATA_API_KEY: `'"'"'` });
    await connect(s);
    const found = await s.request('tools/call', { name: 'search_news', arguments: { query: 'tram' } });
    assert.match(JSON.stringify(found.result), /Tram line approved/, s.stderr());
    assert.equal(await s.close(), 0);
  });

  it('with no AI service the assistant writes the topics, and news_for_profile sends only them', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-home-'));
    const hint = () => {
      const env: NodeJS.ProcessEnv = { ...process.env, MERA_POD_HOME: home };
      delete env.NODE_OPTIONS;
      const run = spawnSync(process.execPath, [path.join(dir, 'server.cjs'), 'session-hint'], { env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stderr, '');
      return run.stdout;
    };
    assert.match(hint(), /^Mera News has no profile for this person yet\..*set_up_profile prompt\.\n$/);
    assert.ok(!existsSync(path.join(home, 'pod.json')), 'the hint never starts the pod');

    const s = startServer(dir, home, { MERA_NEWS_DATA_SERVER_URL: data.origin, MERA_POD_DATA_API_KEY: KEY });
    await connect(s);
    const call = async (name: string, args: object = {}) => {
      const r = await s.request('tools/call', { name, arguments: args });
      assert.ok(!r.result?.isError, `${name}: ${JSON.stringify(r)}\n${s.stderr()}`);
      return JSON.parse(r.result.content[0].text);
    };
    const status = await call('get_status');
    assert.ok(status.problems.some((p: { code: string; who: string }) => p.code === 'no_ai_service' && p.who === 'assistant'), JSON.stringify(status));
    const added = await call('add_facts', { statements: [{ statement: 'Lives in Utrecht', topics: ['Utrecht trams', 'Utrecht council'] }] });
    assert.deepEqual(added.topics[0].added.map((t: { text: string }) => t.text), ['Utrecht trams', 'Utrecht council']);
    const profile = await call('get_profile');
    assert.equal(profile.facts[0].topicsStatus, 'done');
    assert.deepEqual(profile.facts[0].topics.map((t: { text: string }) => t.text).sort(), ['Utrecht council', 'Utrecht trams']);
    const news = await call('news_for_profile');
    assert.deepEqual(news.groups.map((g: { fact: string; results: { title: string }[] }) => [g.fact, g.results.map((r) => r.title)]), [['Lives in Utrecht', ['Tram line approved']]]);
    assert.ok(!JSON.stringify(data.requests.map((r) => r.body)).includes('Lives in Utrecht'), 'a fact reached the news server');
    assert.equal(await s.close(), 0);

    assert.equal(hint(), '', 'a profile and no digest due');
    writeFileSync(path.join(home, 'data', 'plugins', 'mcp', 'digest.json'), JSON.stringify({ times: ['00:00'], lastAt: new Date(Date.now() - 2 * 86400_000).toISOString() }));
    assert.match(hint(), /^A Mera News digest is due\..*daily_digest prompt\.\n$/);
    assert.doesNotMatch(hint(), /Utrecht/);
  });

  it('the plugin folder carries this build', () => {
    // The marketplaces install from git, so the built files are committed; CI rebuilds and compares.
    for (const f of ['server.cjs', 'mcp-plugin.cjs']) {
      const committed = execFileSync('git', ['show', `HEAD:plugins/mera-news/server/${f}`], { cwd: repo, maxBuffer: 64e6 });
      assert.ok(committed.equals(readFileSync(path.join(dist, f))), `plugins/mera-news/server/${f} is stale: run npm run build and commit it`);
    }
  });
});

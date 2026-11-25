import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
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

const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/** A copy of the bundle with the website, away from the repo. */
function withWebsite(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-web-'));
  for (const f of ['server.cjs', 'mcp-plugin.cjs', 'web-plugin.cjs']) copyFileSync(path.join(dist, f), path.join(dir, f));
  cpSync(path.join(dist, 'web'), path.join(dir, 'web'), { recursive: true });
  return dir;
}

/** The link open_news_site gives. */
async function siteUrl(s: ReturnType<typeof startServer>): Promise<string> {
  const r = await s.request('tools/call', { name: 'open_news_site', arguments: {} });
  assert.ok(!r.result?.isError, `open_news_site: ${JSON.stringify(r)}\n${s.stderr()}`);
  return JSON.parse(r.result.content[0].text).url;
}

/** Swaps a link's code for a session, as the page does. */
const open = (origin: string, code: string) =>
  fetch(`${origin}/api/session/`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });

async function searchWorks(s: ReturnType<typeof startServer>) {
  await connect(s);
  const found = await s.request('tools/call', { name: 'search_news', arguments: { query: 'tram' } });
  assert.match(JSON.stringify(found.result), /Tram line approved/, s.stderr());
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
    const sources = Math.max(newest(path.join(pkg, 'src')), newest(path.join(repo, 'packages/mcp/src')), newest(path.join(repo, 'packages/web/src')));
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
    // After the close, so a failure leaves no server running. The extension page lists the manifest's tools: they are the tools the server serves.
    const declared = (JSON.parse(readFileSync(path.join(pkg, 'manifest.json'), 'utf8')).tools as { name: string }[]).map((t) => t.name);
    assert.deepEqual([...declared].sort(), [...tools].sort());

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
    // Topics the assistant wrote still wait for the person to keep or remove them.
    assert.deepEqual(profile.setup, { complete: false, findingTopics: [], toReview: ['Lives in Utrecht'], noTopics: [] });
    assert.match(hint(), /^Mera News setup is not finished: .*get_profile\.\n$/);
    assert.doesNotMatch(hint(), /Utrecht/);
    const council = profile.facts[0].topics.find((t: { text: string }) => t.text === 'Utrecht council');
    await call('edit_topics', { remove: [council.id], reviewed: [profile.facts[0].id] });
    assert.equal((await call('get_profile')).setup.complete, true);
    assert.equal((await call('get_status')).setup, undefined);
    // A removed topic is not made again when the same topics come back.
    await call('add_facts', { statements: [{ statement: 'Lives in Utrecht', topics: ['Utrecht trams', 'Utrecht council'] }] });
    const reviewed = await call('get_profile');
    assert.deepEqual(reviewed.facts[0].topics.map((t: { text: string }) => t.text), ['Utrecht trams']);
    assert.equal(reviewed.setup.complete, true);
    const news = await call('news_for_profile');
    assert.deepEqual(news.toJudge.map((g: { fact: string; stories: { title: string }[] }) => [g.fact, g.stories.map((r) => r.title)]), [['Lives in Utrecht', ['Tram line approved']]]);
    assert.deepEqual([news.summary.articles, news.summary.stories, news.summary.unjudged], [1, 1, 1]);
    assert.ok(!JSON.stringify(data.requests.map((r) => r.body)).includes('Lives in Utrecht'), 'a fact reached the news server');
    // The assistant's pick becomes one of the pod's own: get_suggestions gives it, and it is never judged again.
    const rated = await call('rate_stories', { stories: [{ id: 'a1', verdict: 'picked', level: 'high', reason: 'A tram line near your home was approved.' }] });
    assert.deepEqual(rated.saved, [{ id: 'a1', verdict: 'picked' }], JSON.stringify(rated));
    const picks = await call('get_suggestions');
    assert.deepEqual(picks.picks.map((p: { title: string; level: string; facts: string[] }) => [p.title, p.level, p.facts]), [['Tram line approved', 'high', ['Lives in Utrecht']]]);
    const after = await call('news_for_profile');
    assert.deepEqual([after.toJudge, after.picked.map((p: { id: string; reason: string }) => [p.id, p.reason])], [[], [['a1', 'A tram line near your home was approved.']]]);
    assert.equal((await call('rate_stories', { stories: [{ id: 'a1', verdict: 'left_out', reason: 'Changed my mind.' }] })).already[0].verdict, 'picked');
    assert.equal(await s.close(), 0);

    assert.equal(hint(), '', 'a profile and no digest due');
    writeFileSync(path.join(home, 'data', 'plugins', 'mcp', 'digest.json'), JSON.stringify({ times: ['00:00'], lastAt: new Date(Date.now() - 2 * 86400_000).toISOString() }));
    assert.match(hint(), /^A Mera News digest is due\..*daily_digest prompt\.\n$/);
    assert.doesNotMatch(hint(), /Utrecht/);
  });

  it('the website runs beside the tools, opens from open_news_site once per link, and goes when the setting says so', async () => {
    const full = withWebsite();
    const home = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-home-'));
    const env = { MERA_NEWS_DATA_SERVER_URL: data.origin, MERA_POD_DATA_API_KEY: KEY };
    const s = startServer(full, home, env);
    assert.ok((await connect(s)).includes('open_news_site'));
    const plugins = () => JSON.parse(readFileSync(path.join(home, 'pod.json'), 'utf8')).plugins.map((p: { package: string }) => path.basename(p.package));
    assert.deepEqual(plugins(), ['mcp-plugin.cjs', 'web-plugin.cjs']);
    const url = await siteUrl(s);
    const site = new URL(url);
    const page = await fetch(site.origin + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self' 'sha256-/);
    const code = site.hash.slice('#c='.length);
    const session = await open(site.origin, code);
    assert.equal(session.status, 200);
    const { session: token } = (await session.json()) as { session: string };
    const status = await fetch(`${site.origin}/api/status/`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(((await status.json()) as { dataServer: { host: string } }).dataServer.host, new URL(data.origin).host);
    assert.equal((await open(site.origin, code)).status, 401, 'a link works once');
    // Viewing the Feed never takes a story from the assistant: the site reads with peek.
    const tool = async (name: string, args: object = {}) => JSON.parse((await s.request('tools/call', { name, arguments: args })).result.content[0].text);
    await tool('add_facts', { statements: [{ statement: 'Lives in Utrecht', topics: ['Utrecht trams'] }] });
    const feed = async () => (await (await fetch(`${site.origin}/api/feed/`, { headers: { authorization: `Bearer ${token}` } })).json()) as { stories: { id: string; verdict?: unknown }[] };
    assert.deepEqual((await feed()).stories.map((x) => x.id), ['a1']);
    assert.deepEqual((await feed()).stories.map((x) => x.id), ['a1']);
    const first = await tool('news_for_profile');
    assert.deepEqual(first.toJudge.flatMap((g: { stories: { id: string }[] }) => g.stories.map((x) => x.id)), ['a1'], 'the site took nothing');
    const second = await tool('news_for_profile');
    assert.deepEqual([second.toJudge, second.shownBefore], [[], 1], 'the assistant\'s own read did');
    assert.deepEqual((await feed()).stories.map((x) => x.id), ['a1'], 'the site still shows it');
    assert.equal(await s.close(), 0);

    const off = startServer(full, home, { ...env, MERA_POD_WEB: 'false' });
    await connect(off);
    assert.deepEqual(plugins(), ['mcp-plugin.cjs']);
    const refused = await off.request('tools/call', { name: 'open_news_site', arguments: {} });
    assert.match(JSON.stringify(refused.result), /site_off/);
    await assert.rejects(fetch(site.origin + '/'), 'the website stopped with its setting');
    assert.equal(await off.close(), 0);
  });

  it('a busy website port, missing website files or a missing website plugin leave the tools working', async () => {
    const full = withWebsite();
    const home = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-home-'));
    const env = { MERA_NEWS_DATA_SERVER_URL: data.origin, MERA_POD_DATA_API_KEY: KEY };
    const first = startServer(full, home, env);
    await connect(first);
    assert.equal(await first.close(), 0);
    const webPort = JSON.parse(readFileSync(path.join(home, 'pod.json'), 'utf8')).plugins[1].config.port;

    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(webPort, '127.0.0.1', resolve));
    try {
      const busy = startServer(full, home, env);
      await searchWorks(busy);
      const moved = new URL(await siteUrl(busy));
      assert.notEqual(Number(moved.port), webPort);
      assert.equal((await fetch(moved.origin + '/')).status, 200);
      assert.equal(await busy.close(), 0);
    } finally {
      blocker.close();
    }

    rmSync(path.join(full, 'web'), { recursive: true });
    const noFiles = startServer(full, home, env);
    await searchWorks(noFiles);
    const down = new URL(await siteUrl(noFiles));
    assert.equal((await fetch(down.origin + '/')).status, 503);
    assert.match(noFiles.stderr(), /website files are missing/);
    assert.equal(await noFiles.close(), 0);

    rmSync(path.join(full, 'web-plugin.cjs'));
    const noPlugin = startServer(full, home, env);
    await searchWorks(noPlugin);
    assert.equal(JSON.parse(readFileSync(path.join(home, 'pod.json'), 'utf8')).plugins.length, 1);
    assert.equal(await noPlugin.close(), 0);
  });

  it('serve mode, what keep running starts, runs the pod with no bridge, never writes to stdout, and waits while an app holds the home', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'mera-bundle-home-'));
    const env = { MERA_NEWS_DATA_SERVER_URL: data.origin, MERA_POD_DATA_API_KEY: KEY };
    const app = startServer(dir, home, env);
    await connect(app);

    const serveEnv: NodeJS.ProcessEnv = { ...process.env, MERA_POD_HOME: home, ...env };
    delete serveEnv.NODE_OPTIONS;
    const serve = spawn(process.execPath, [path.join(dir, 'server.cjs'), 'serve'], { env: serveEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', () => serve.kill('SIGKILL'));
    let out = '';
    let err = '';
    serve.stdout.on('data', (c) => (out += c));
    serve.stderr.on('data', (c) => (err += c));
    const exited = new Promise<number | null>((r) => serve.once('exit', (code) => r(code)));
    const waitFor = async (re: RegExp) => {
      const end = Date.now() + 40_000;
      while (!re.test(err) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
      return re.test(err);
    };
    const waited = await waitFor(/open in an app/);
    assert.equal(await app.close(), 0);
    const tookOver = await waitFor(/running on its own/);
    // An app that opens now only connects to it.
    const again = startServer(dir, home, env);
    const tools: string[] = await connect(again).catch(() => []);
    const bridged = again.stderr();
    assert.equal(await again.close(), 0);
    serve.kill('SIGTERM');
    const code = await exited;
    // After everything stopped, so a failure leaves nothing running.
    assert.ok(waited, `serve did not wait for the app: ${err}`);
    assert.ok(tookOver, `serve did not take over: ${err}`);
    assert.ok(tools.includes('search_news'), bridged);
    assert.match(bridged, /already running for this home/);
    assert.equal(code, 0, err);
    assert.equal(out, '', 'serve mode writes nothing to stdout');
  });

  it('the plugin folder carries this build', () => {
    // The marketplaces install from git, so the built files are committed; CI rebuilds and compares.
    const fresh = [...['server.cjs', 'mcp-plugin.cjs', 'web-plugin.cjs', 'THIRD-PARTY-NOTICES.txt'], ...files(path.join(dist, 'web')).map((f) => path.relative(dist, f))].sort();
    const committed = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', 'plugins/mera-news/server/'], { cwd: repo, encoding: 'utf8' })
      .trim()
      .split('\n')
      .map((f) => f.slice('plugins/mera-news/server/'.length))
      .sort();
    // Next's export differs in bytes between machines (chunk names included): the website is checked by its
    // pages and by the hash of the sources it was built from; everything else must match byte for byte.
    const isWeb = (f: string) => f.startsWith('web/');
    const pages = (list: string[]) => list.filter((f) => isWeb(f) && f.endsWith('.html'));
    assert.deepEqual(committed.filter((f) => !isWeb(f)), fresh.filter((f) => !isWeb(f)), 'plugins/mera-news/server is stale: run npm run build and commit it');
    assert.deepEqual(pages(committed), pages(fresh), 'the website pages are stale: run npm run build and commit plugins/mera-news/server');
    const show = (f: string) => execFileSync('git', ['show', `HEAD:plugins/mera-news/server/${f}`], { cwd: repo, maxBuffer: 64e6 });
    assert.equal(show('web/BUILD-SOURCE.txt').toString(), readFileSync(path.join(dist, 'web/BUILD-SOURCE.txt'), 'utf8'), 'the website was built from other sources: run npm run build and commit plugins/mera-news/server');
    for (const f of committed) {
      const blob = show(f);
      if (!isWeb(f)) assert.ok(blob.equals(readFileSync(path.join(dist, f))), `plugins/mera-news/server/${f} is stale: run npm run build and commit it`);
      assert.ok(blob.length <= 5 * 1024 * 1024, `${f} is over the plugin directory's 5 MiB`);
    }
  });

  it('the website notices name every package that reaches the browser', () => {
    const list = JSON.parse(readFileSync(path.join(repo, 'packages/web/notices.json'), 'utf8')) as { shipped: string[]; buildOnly: string[] };
    const webPkg = JSON.parse(readFileSync(path.join(repo, 'packages/web/package.json'), 'utf8'));
    const dev = Object.keys(webPkg.devDependencies).sort();
    assert.deepEqual(webPkg.dependencies, undefined, 'the website ships as files, so its packages are development ones');
    // Each development package is either shipped to the browser or used only to build.
    assert.deepEqual([...list.shipped.filter((n) => dev.includes(n)), ...list.buildOnly].sort(), dev);
    assert.deepEqual(list.buildOnly.filter((n) => list.shipped.includes(n)), []);
    // The rest are what a shipped package depends on, or a copy inside one.
    // npm may nest a package under the one that needs it: search every node_modules level, shallowest first.
    const find = (n: string): string | undefined => {
      const queue = [path.join(repo, 'packages/web/node_modules'), path.join(repo, 'node_modules')];
      while (queue.length) {
        const nm = queue.shift()!;
        if (!existsSync(nm)) continue;
        if (existsSync(path.join(nm, n, 'package.json'))) return path.join(nm, n);
        for (const e of readdirSync(nm)) {
          const dirs = e.startsWith('@') ? readdirSync(path.join(nm, e)).map((s) => path.join(nm, e, s)) : [path.join(nm, e)];
          for (const d of dirs) if (existsSync(path.join(d, 'node_modules'))) queue.push(path.join(d, 'node_modules'));
        }
      }
      return undefined;
    };
    const manifest = (n: string) => {
      const dir = find(n);
      assert.ok(dir, `${n} is installed`);
      return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    };
    for (const n of list.shipped.filter((x) => !dev.includes(x))) {
      const from = list.shipped.filter((p) => p !== n && (n.startsWith(`${p}/`) || n in (manifest(p).dependencies ?? {})));
      assert.ok(from.length > 0, `${n} is listed but no shipped package brings it`);
    }
    const notices = readFileSync(path.join(dist, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
    for (const n of list.shipped) {
      const { version } = manifest(n);
      assert.ok(notices.includes(`\n${n}${version ? ` ${version}` : ''}\n`), `${n} is in the notices`);
    }
  });
});

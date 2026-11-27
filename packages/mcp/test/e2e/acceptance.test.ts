import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { defaultSchemaPath, recordedOrigins, startFakeDataServer, startFakeModel, type FakeDataServer, type FakeModel } from 'mera-news-pod/testing';

const INTERVAL_SECONDS = 2;
const MARKER = 'Explain in one short sentence why this story matters to this person.';
const BLOCKED = 'blocked request to';

// Ten unrelated stories: similar headlines would be grouped into one pick.
const articles = [
  'Utrecht council approves new tram line to the science park',
  'Nurses union and hospitals reach pay deal after strike vote',
  'Rail operator cancels night trains between Amsterdam and Berlin',
  'Heatwave record shatters temperatures across southern Spain',
  'Chipmaker unveils battery storage plant near Rotterdam harbour',
  'Football federation appoints new coach before qualifying round',
  'Archaeologists uncover Roman bathhouse beneath Cologne parking garage',
  'Central bank holds interest rates steady citing sluggish inflation',
  'Volcano eruption disrupts flights across Icelandic airspace',
  'Farmers protest fertiliser limits outside Brussels parliament',
].map((title, i) => ({ _id: `a${i + 1}`, title, ...(i === 7 ? { country_code: 'NLD' } : {}), pubDate: new Date(Date.now() - i * 60_000).toISOString() }));
const titles = new Set(articles.map((a) => a.title));
// The topics the fake model makes for the two facts below, and the stories each one matches: a1 to a8.
const topics = {
  'lives news': ['a1', 'a3'],
  'lives utrecht': ['a5', 'a8'],
  'utrecht latest': ['a3', 'a1'],
  'works news': ['a2', 'a4'],
  'works nurse': ['a6', 'a7'],
  'nurse latest': ['a4', 'a2'],
};
// a9 and a10 come only as top headlines, whose reasons use the headline reason prompt.
const headlines = ['a9', 'a10'];
const headlineTitles = new Set(articles.filter((a) => headlines.includes(a._id)).map((a) => a.title));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const estimate = (text: string) => Math.ceil(text.length / 4);

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


describe('the pod with the mcp plugin, driven by an MCP client', () => {
  let data: FakeDataServer;
  let model: FakeModel;
  let home: string;
  let pod: ChildProcess;
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let client: Client;
  let token = '';
  const output: string[] = [];
  const replies: string[] = [];
  const marks: Record<string, number> = {};
  let facts: { id: string; statement: string }[] = [];
  let topicsOfRemoved: string[] = [];
  let delivered: { id: string; title: string; url: string; reason: string }[] = [];

  const tail = () => `pod exit: ${exit ? `${exit.code ?? exit.signal}` : 'still running'}\nlast pod output:\n${output.slice(-15).join('\n')}`;
  async function until<T>(what: string, ms: number, step: number, probe: () => Promise<T | undefined | false> | T | undefined | false): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const got = await probe();
      if (got) return got;
      if (Date.now() > end) assert.fail(`timed out after ${ms} ms waiting for ${what}\n${tail()}`);
      await sleep(step);
    }
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0].text;
    replies.push(text);
    assert.ok(!result.isError, `${name} answered with an error: ${text}`);
    return JSON.parse(text);
  }
  const profile = () => call('get_profile');
  const status = () => call('get_status');

  before(async () => {
    data = await startFakeDataServer({ schemaPath: defaultSchemaPath(), articles, topics, headlines });
    model = await startFakeModel();
    home = mkdtempSync(path.join(os.tmpdir(), 'pod-acceptance-'));
    const port = await freePort();
    writeFileSync(
      path.join(home, 'pod.json'),
      JSON.stringify({
        dataServer: { url: data.origin },
        ai: { baseUrl: model.baseUrl, model: 'm' },
        language: 'en',
        plugins: [{ package: path.resolve(__dirname, '../..'), config: { port } }],
      }),
      { mode: 0o600 },
    );
    mkdirSync(path.join(home, 'harness', 'scoring'), { recursive: true });
    writeFileSync(path.join(home, 'harness', 'harness.json'), '{}');
    writeFileSync(path.join(home, 'harness', 'scoring', 'cloud-reason-system-prompt.md'), `${MARKER}\n`);

    const cli = path.join(path.dirname(require.resolve('mera-news-pod/package.json')), 'build/cli.js');
    // The entry a person uses, under plain node: no loader reaches the pod.
    const env: NodeJS.ProcessEnv = { ...process.env, MERA_POD_HOME: home, MERA_POD_INTERVAL_SECONDS: String(INTERVAL_SECONDS) };
    delete env.NODE_OPTIONS;
    pod = spawn(process.execPath, [cli, 'start'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    // shortcut: a test runner killed with SIGKILL leaves the pod running, upgrade if that happens in CI.
    process.on('exit', () => pod.kill('SIGKILL'));
    for (const stream of [pod.stdout!, pod.stderr!]) {
      let rest = '';
      stream.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop()!;
        output.push(...lines);
      });
      stream.on('end', () => rest && output.push(rest));
    }
    pod.on('exit', (code, signal) => (exit = { code, signal }));

    const tokenFile = path.join(home, 'data', 'plugins', 'mcp', 'token');
    await until('the token file', 60_000, 100, () => (exit ? assert.fail(`the pod ended early\n${tail()}`) : existsSync(tokenFile)));
    token = readFileSync(tokenFile, 'utf8').trim();
    client = new Client({ name: 'acceptance', version: '0' });
    await until('the MCP address to answer', 60_000, 200, async () => {
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
        return true;
      } catch {
        return false;
      }
    });
  });

  after(async () => {
    await client?.close().catch(() => {});
    if (pod && pod.exitCode === null && pod.signalCode === null) pod.kill('SIGKILL');
    await Promise.all([data?.close(), model?.close()]);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('saves facts, shows their topics, and drops a fact with its topics', async () => {
    const added = await call('add_facts', { statements: ['Lives in Utrecht', 'Works as a nurse'] });
    marks.factsAddedAt = Date.now();
    assert.equal(added.added.length, 2, JSON.stringify(added));
    facts = added.added;
    const both = await until('topics for both facts', 60_000, 2000, async () => {
      const p = await call('get_profile', { waitSeconds: 45 });
      return p.facts.length === 2 && p.facts.every((f: { topics: unknown[] }) => f.topics.length > 0) && p;
    });
    const [kept, removed] = facts;
    topicsOfRemoved = both.facts.find((f: { id: string }) => f.id === removed.id).topics.map((t: { text: string }) => t.text);
    const gone = await call('remove_facts', { ids: [removed.id] });
    assert.deepEqual(gone.removed.map((r: { id: string }) => r.id), [removed.id]);
    assert.deepEqual([...gone.removed[0].topics].sort(), [...topicsOfRemoved].sort(), 'the reply names the topics that went with the fact');
    const rest = await profile();
    assert.deepEqual(rest.facts.map((f: { id: string }) => f.id), [kept.id]);
    const left = rest.facts[0].topics.map((t: { text: string }) => t.text);
    for (const t of topicsOfRemoved) assert.ok(!left.includes(t), `topic "${t}" of the removed fact is still there`);
  });

  it('keeps setup open until the person reviewed the topics, and a topic they removed is not made again', async () => {
    const [kept] = facts;
    const before = await profile();
    assert.deepEqual(before.setup, { complete: false, findingTopics: [], toReview: [kept.statement], noTopics: [] });
    assert.equal((await status()).setup.complete, false);
    const dropped = before.facts[0].topics.at(-1);
    await call('edit_topics', { remove: [dropped.id], reviewed: [kept.id] });
    const after = await profile();
    assert.equal(after.setup.complete, true, JSON.stringify(after.setup));
    assert.equal((await status()).setup, undefined);
    await call('add_facts', { statements: [{ statement: kept.statement, topics: [dropped.text] }] });
    const again = await profile();
    assert.ok(!again.facts[0].topics.some((t: { text: string }) => t.text === dropped.text), `"${dropped.text}" came back`);
    assert.equal(again.setup.complete, true);
  });

  it('returns new picks with a title, a link and a reason, then none the second time', async () => {
    const picks = await until('the first picks', 90_000, 2000, async () => {
      const r = await call('get_suggestions');
      return r.picks.length > 0 && r;
    });
    marks.firstPicksMs = Date.now() - marks.factsAddedAt;
    assert.equal(picks.state, 'ok');
    assert.equal(typeof picks.cursor, 'string');
    delivered = [...picks.picks];
    let page = picks;
    while (page.more) {
      page = await call('get_suggestions', { since: page.cursor });
      delivered.push(...page.picks);
    }
    assert.equal(page.more, false);
    for (const p of delivered) {
      assert.ok(titles.has(p.title), `unexpected title ${p.title}`);
      assert.match(p.url, /^https?:\/\//);
      assert.ok(p.reason.trim().length > 0, `pick "${p.title}" has no reason`);
    }
    assert.equal(new Set(delivered.map((p) => p.id)).size, delivered.length, 'a pick was delivered twice in one pass');
    await until('the first read to settle', 60_000, 1000, async () => {
      const s = await status();
      return s.firstReadDone && s.unscored === 0 && !s.readingNow;
    });
    const again = await call('get_suggestions');
    const seen = new Set(delivered.map((p) => p.id));
    assert.deepEqual(again.picks.filter((p: { id: string }) => seen.has(p.id)), [], 'a pick came back without since');
    assert.equal(again.picks.length, 0, `new picks arrived after the read settled: ${again.picks.map((p: { title: string }) => p.title)}`);
    const replay = await call('get_suggestions', { since: 'all', limit: 25 });
    for (const id of seen) assert.ok(replay.picks.some((p: { id: string }) => p.id === id), `since "all" did not return pick ${id}`);
  });

  it('reaches neither server while paused, and reads again once resumed', async () => {
    await call('set_reading', { paused: true });
    await until('status to say paused', 60_000, 500, async () => (await status()).reading === 'paused');
    const counts = [data.requests.length, model.requests.length];
    await sleep(3 * INTERVAL_SECONDS * 1000); // absence cannot be observed, so wait three intervals
    assert.deepEqual([data.requests.length, model.requests.length], counts, 'a request reached a fake while paused');
    await call('set_reading', { paused: false });
    await until('a request after resuming', 60_000, 500, () => data.requests.length > counts[0] || model.requests.length > counts[1]);
  });

  it('applies a user prompt override to the one slot it names: topic reasons, not headline reasons', () => {
    const userOf = (b: { messages: { role: string; content: string }[] }) => [...b.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const systemOf = (b: { messages: { role: string; content: string }[] }) => b.messages.find((m) => m.role === 'system')?.content ?? '';
    const isReason = (b: Parameters<typeof userOf>[0]) => /<<ARTICLE [a-f0-9]{12}>>/.test(userOf(b)) && !userOf(b).includes('===== Article ');
    const titlesIn = (b: Parameters<typeof userOf>[0]) => [...userOf(b).matchAll(/News Title: (.*)/g)].map((m) => m[1].trim());
    const reason = model.bodies.filter(isReason);
    const headline = reason.filter((b) => titlesIn(b).every((t) => headlineTitles.has(t)));
    const topic = reason.filter((b) => titlesIn(b).every((t) => !headlineTitles.has(t)));
    const other = model.bodies.filter((b) => !isReason(b));
    assert.equal(headline.length + topic.length, reason.length, 'a reason request mixed topic and headline articles');
    assert.ok(topic.length > 0, 'no topic reason request reached the model');
    assert.ok(headline.length > 0, 'no headline reason request reached the model');
    assert.ok(other.length > 0, 'no other request reached the model');
    for (const b of topic) assert.ok(systemOf(b).includes(MARKER), 'a topic reason request lacks the marker');
    for (const b of headline) assert.ok(!systemOf(b).includes(MARKER), 'the marker reached the headline reason prompt');
    for (const b of other) assert.ok(!systemOf(b).includes(MARKER), `the marker leaked into another prompt: ${userOf(b).slice(0, 60)}`);
  });

  it('reads stored news with search_news and latest_news, without picks', async () => {
    const found = await call('search_news', { query: 'volcano flights' });
    assert.deepEqual(found.results.map((r: { title: string }) => r.title), ['Volcano eruption disrupts flights across Icelandic airspace']);
    assert.match(found.results[0].link, /^https?:\/\//);
    assert.ok(found.results[0].show.startsWith(`[${found.results[0].title}](${found.results[0].link}) · `), found.results[0].show);
    const latest = await call('latest_news', { limit: 3 });
    assert.equal(latest.results.length, 3);
    assert.ok(latest.results.every((r: { title: string }) => titles.has(r.title)));
    assert.equal('remaining' in latest, false, 'limit is the total, so the three asked for are all');
    const all = await call('latest_news', {});
    assert.equal(new Set(all.results.map((r: { id: string }) => r.id)).size, articles.length, 'every article once');
    assert.equal('remaining' in all, false, 'nothing more to come');
    assert.doesNotMatch(all.next, /Call /);
    const nl = await call('latest_news', { country: 'NLD' });
    assert.deepEqual(nl.results.map((r: { title: string }) => r.title), ['Central bank holds interest rates steady citing sluggish inflation']);
  });

  it('stops on SIGTERM with exit code 0', async () => {
    pod.kill('SIGTERM');
    await until('the pod to exit', 15_000, 100, () => exit);
    assert.equal(exit!.code, 0, tail());
  });

  it('contacts only the two fake servers, and never the gateway or account endpoints', () => {
    assert.deepEqual(recordedOrigins(data, model), [data.origin, model.origin].sort());
    assert.ok(data.requests.length > 0 && model.requests.length > 0);
    assert.deepEqual([...new Set(data.requests.map((r) => r.path))], ['/graphql']);
    assert.deepEqual([...new Set(model.requests.map((r) => r.path))], ['/v1/chat/completions']);
    assert.deepEqual(output.filter((l) => l.startsWith(BLOCKED)), []);
    assert.deepEqual(output.filter((l) => /gateway|\/api\/auth|account/i.test(l)), []);
  });

  it('prints the token nowhere', () => {
    assert.ok(token.length >= 16);
    assert.deepEqual(output.filter((l) => l.includes(token)), []);
    assert.deepEqual(replies.filter((r) => r.includes(token)), []);
    assert.ok(output.length > 0, 'the pod printed nothing at all');
    console.log(`numbers: data requests ${data.requests.length}, model requests ${model.requests.length}, first picks after ${marks.firstPicksMs} ms, largest reply ${Math.max(...replies.map(estimate))} tokens, picks ${delivered.length}`);
  });
});

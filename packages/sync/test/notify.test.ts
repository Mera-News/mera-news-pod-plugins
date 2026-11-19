import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { addDevice, removeDevice } from '../src/store';
import { pick, run, startRelay, type Relay, type Running } from './helpers';

const CAP = 'capability-secret-0123456789';
const MIN = 60_000;
const open: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  mock.timers.reset();
  mock.restoreAll();
  for (const c of open.splice(0)) await c.close();
});

const track = <T extends { close(): Promise<void> | void }>(x: T): T => (open.push(x), x);
const push = (r: Running, token: string, body: unknown = { capability: CAP, expiresAt: 1_900_000_000 }) => r.call(token, '/push-pass', body);
const readJson = (r: Running, file: string) => JSON.parse(readFileSync(path.join(r.dataDir, file), 'utf8'));
// Real turns of the event loop, so a test with mocked timers still lets the loopback I/O finish.
async function settle(until: () => boolean = () => false, ms = 1500) {
  const end = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (!until() && process.hrtime.bigint() < end) await new Promise((r) => setImmediate(r));
}
// Lets pending I/O and timer registrations finish, then moves the mocked clock.
async function advance(ms: number) {
  await settle(() => false, 100);
  mock.timers.tick(ms);
  await settle(() => false, 100);
}
const titles = (relay: Relay) => relay.requests.map((q) => JSON.parse(q.body).title);

async function paired(opts: { meraNewsApp?: string | null; pass?: unknown } = {}) {
  const r = await run({ meraNewsApp: opts.meraNewsApp });
  open.push({ close: () => r.stop() });
  const { token, deviceId } = await r.pair();
  if (opts.pass !== null) assert.equal((await push(r, token, opts.pass)).status, 200);
  return { r, token, deviceId };
}
async function withRelay(answer?: Parameters<typeof startRelay>[0], pass?: unknown) {
  const relay = track(await startRelay(answer));
  return { relay, ...(await paired({ meraNewsApp: relay.origin, pass })) };
}

test('notify: posts capability, title and pickId to the origin plus /api/pod/notify', async () => {
  const { relay, r } = await withRelay();
  await r.calls.notify([pick('pick-1', 'high', 'Dutch rail strike ends')]);
  await settle(() => relay.requests.length > 0);
  assert.equal(relay.requests.length, 1);
  assert.equal(relay.requests[0].method, 'POST');
  assert.equal(relay.requests[0].url, '/api/pod/notify');
  assert.deepEqual(JSON.parse(relay.requests[0].body), { capability: CAP, title: 'Dutch rail strike ends', pickId: 'pick-1' });
  assert.equal(relay.requests[0].headers.authorization, undefined);
  await r.calls.notify([pick('a/b', 'high', 'Another story')]);
  await settle(() => relay.requests.length > 1, 300);
  assert.equal(relay.requests.length, 1, 'the second story waits for the pace');
});

test('notify: a pick whose id does not fit the pickId rule is sent without pickId', async () => {
  const { relay, r } = await withRelay();
  await r.calls.notify([pick('a/b')]);
  await settle(() => relay.requests.length > 0);
  assert.deepEqual(Object.keys(JSON.parse(relay.requests[0].body)).sort(), ['capability', 'title']);
});

test('notify: one story per batch, emergency first', async () => {
  const { relay, r } = await withRelay();
  await r.calls.notify([pick('a', 'high', 'High story'), pick('b', 'emergency', 'Emergency story')]);
  await settle(() => relay.requests.length > 0);
  await settle(() => false, 200);
  assert.deepEqual(titles(relay), ['Emergency story']);
});

test('title: the cut', async () => {
  const { relay, r } = await withRelay();
  const emoji = '\u{1F600}';
  await r.calls.notify([pick('a', 'emergency', `${'a'.repeat(199)}${emoji}x`)]);
  await r.calls.notify([pick('b', 'emergency', `${'b'.repeat(199)} y`)]);
  await r.calls.notify([pick('c', 'emergency', `${'c'.repeat(249)}www.${'c'.repeat(50)}`)]);
  await settle(() => relay.requests.length >= 2);
  await settle(() => false, 200);
  const sent = titles(relay);
  assert.equal(sent.length, 2, 'the headline with www. is skipped');
  assert.equal(Array.from(sent[0]).length, 200);
  assert.equal(sent[0], `${'a'.repeat(199)}${emoji}`);
  assert.equal(sent[1], 'b'.repeat(199));
});

test('notify: a refused title is skipped and the next story of the batch is sent', async () => {
  const { relay, r } = await withRelay();
  await r.calls.notify([pick('a', 'high', 'Read more at www.example.org'), pick('b', 'high', 'A plain title')]);
  await settle(() => relay.requests.length > 0);
  await settle(() => false, 200);
  assert.deepEqual(titles(relay), ['A plain title']);
});

test('pace: a second high story within 15 minutes waits and is sent when they end', async () => {
  const { relay, r } = await withRelay();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const t0 = Date.now();
  await r.calls.notify([pick('a', 'high', 'Story A')]);
  await settle(() => relay.requests.length === 1);
  await advance(MIN);
  await r.calls.notify([pick('b', 'high', 'Story B')]);
  await advance(MIN);
  await r.calls.notify([pick('c', 'high', 'Story C')]);
  await advance(12 * MIN);
  assert.equal(relay.requests.length, 1);
  await advance(MIN);
  await settle(() => relay.requests.length === 2);
  await advance(60 * MIN);
  assert.deepEqual(titles(relay), ['Story A', 'Story B']);
  assert.deepEqual(relay.requests.map((q) => q.at - t0), [0, 15 * MIN]);
});

test('pace: an emergency is sent at once during the wait', async () => {
  const { relay, r } = await withRelay();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const t0 = Date.now();
  await r.calls.notify([pick('a', 'high', 'Story A')]);
  await settle(() => relay.requests.length === 1);
  await advance(3 * MIN);
  await r.calls.notify([pick('b', 'high', 'Story B')]);
  await advance(2 * MIN);
  await r.calls.notify([pick('e', 'emergency', 'Story E')]);
  await settle(() => relay.requests.length === 2);
  await advance(14 * MIN);
  assert.equal(relay.requests.length, 2, 'the slot waits for 15 minutes after the emergency');
  await advance(MIN);
  await settle(() => relay.requests.length === 3);
  await advance(60 * MIN);
  assert.deepEqual(titles(relay), ['Story A', 'Story E', 'Story B']);
  assert.deepEqual(relay.requests.map((q) => q.at - t0), [0, 5 * MIN, 20 * MIN]);
});

test('notify: a story already tried is skipped', async () => {
  const { relay, r, token } = await withRelay();
  await r.calls.notify([pick('a')]);
  await r.calls.notify([pick('a')]);
  await settle(() => relay.requests.length > 0);
  await settle(() => false, 200);
  assert.equal(relay.requests.length, 1);
  await r.stop();
  const again = await run({ home: r.home, meraNewsApp: relay.origin });
  open.push({ close: () => again.stop() });
  void token;
  await again.calls.notify([pick('a')]);
  await settle(() => false, 300);
  assert.equal(relay.requests.length, 1, 'a fresh plugin on the same folder knows it was tried');
});

test('notify: the record is written before the request', async () => {
  const { relay, r } = await withRelay();
  let record: unknown;
  relay.onRequest = () => (record = readJson(r, 'notified.json'));
  await r.calls.notify([pick('a')]);
  await settle(() => relay.requests.length > 0);
  assert.equal((record as { articleId: string }[])[0].articleId, 'a');
  assert.equal(statSync(path.join(r.dataDir, 'notified.json')).mode & 0o777, 0o600);
});

test('notify: an expired pass is deleted with no request, and status says needs_pass', async () => {
  const { relay, r, token, deviceId } = await withRelay(undefined, { capability: CAP, expiresAt: 1_000_000_000 });
  await r.calls.notify([pick('a')]);
  await settle(() => !readJson(r, 'push-pass.json')[deviceId]);
  assert.equal(relay.requests.length, 0);
  assert.deepEqual(readJson(r, 'push-pass.json'), {});
  assert.equal(JSON.parse((await r.call(token, '/status', undefined, 'GET')).body).appNotifications, 'needs_pass');
});

test('notify: a 401 deletes the pass; a 410 deletes the pass; a 400 keeps it', async () => {
  for (const [status, kept] of [[401, false], [410, false], [400, true]] as const) {
    const { relay, r, deviceId } = await withRelay({ status });
    await r.calls.notify([pick('a')]);
    await settle(() => relay.requests.length > 0);
    await settle(() => false, 150);
    assert.equal(relay.requests.length, 1, String(status));
    assert.equal(readJson(r, 'push-pass.json')[deviceId]?.capability, kept ? CAP : undefined, String(status));
    assert.equal(r.logs.some((l) => l.startsWith('warn relay_bad_request')), status === 400);
    assert.equal(r.logs.some((l) => l.includes("A phone's notification pass was refused. Open the app on that phone to get a new one.")), !kept);
  }
});

test('race: a 401 for an old pass keeps a pass stored while it was in flight', async () => {
  const { relay, r, token, deviceId } = await withRelay({ status: 401, delayMs: 300 });
  await r.calls.notify([pick('a')]);
  await settle(() => relay.requests.length === 1);
  assert.equal((await push(r, token, { capability: 'newer-capability', expiresAt: 1_900_000_000 })).status, 200);
  await settle(() => false, 600);
  assert.equal(readJson(r, 'push-pass.json')[deviceId].capability, 'newer-capability');
});

test('race: a retry after a revoke sends nothing, and neither does one after a new pass', async () => {
  const revoked = await withRelay({ status: 500 });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  await revoked.r.calls.notify([pick('a')]);
  await settle(() => revoked.relay.requests.length === 1);
  assert.equal((await revoked.r.call(revoked.token, '/devices/revoke', {})).status, 200);
  await advance(MIN);
  assert.equal(revoked.relay.requests.length, 1);

  const replaced = await withRelay({ status: 500 });
  await replaced.r.calls.notify([pick('b')]);
  await settle(() => replaced.relay.requests.length === 1);
  await push(replaced.r, replaced.token, { capability: 'newer-capability', expiresAt: 1_900_000_000 });
  await advance(MIN);
  assert.equal(replaced.relay.requests.length, 1);
});

test('notify: a 429 with Retry-After 5 is retried once; with 600 it is dropped and the pod stays quiet', async () => {
  const short = await withRelay();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  short.relay.queue.push({ status: 429, headers: { 'retry-after': '5' } });
  await short.r.calls.notify([pick('a', 'high', 'Story A')]);
  await settle(() => short.relay.requests.length === 1);
  await advance(4_000);
  assert.equal(short.relay.requests.length, 1);
  await advance(1_000);
  await settle(() => short.relay.requests.length === 2);
  await advance(10 * MIN);
  assert.equal(short.relay.requests.length, 2, 'one retry only');

  const long = await withRelay();
  long.relay.queue.push({ status: 429, headers: { 'retry-after': '600' } });
  await long.r.calls.notify([pick('b', 'high', 'Story B')]);
  await settle(() => long.relay.requests.length === 1);
  await advance(MIN);
  await long.r.calls.notify([pick('c', 'emergency', 'Story C')]);
  await advance(20 * MIN);
  assert.equal(long.relay.requests.length, 1, 'quiet until the Retry-After ends');
  await advance(10 * MIN);
  await long.r.calls.notify([pick('d', 'high', 'Story D')]);
  await settle(() => long.relay.requests.length === 2);
  assert.equal(JSON.parse(long.relay.requests[1].body).title, 'Story D');

  const bare = await withRelay({ status: 429 });
  await bare.r.calls.notify([pick('e')]);
  await settle(() => bare.relay.requests.length === 1);
  await advance(10 * MIN);
  assert.equal(bare.relay.requests.length, 1, 'no Retry-After: dropped');
});

test('notify: a 5xx is retried once after 60 s with the same pickId, then dropped', async () => {
  for (const status of [500, 502, 503]) {
    const { relay, r } = await withRelay({ status });
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    await r.calls.notify([pick('same-id')]);
    await settle(() => relay.requests.length === 1);
    await advance(MIN - 1000);
    assert.equal(relay.requests.length, 1, String(status));
    await advance(1000);
    await settle(() => relay.requests.length === 2);
    await advance(10 * MIN);
    assert.equal(relay.requests.length, 2, String(status));
    assert.equal(relay.requests[1].body, relay.requests[0].body);
    assert.equal(JSON.parse(relay.requests[1].body).pickId, 'same-id');
    mock.timers.reset();
  }
});

// A timeout ends the same way as a dropped connection (no answer), so this covers the 10 s timeout's path too.
test('notify: a dropped connection is retried once after 60 s with the same pickId', async () => {
  const { relay, r } = await withRelay();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  relay.queue.push({ status: 0, drop: true });
  await r.calls.notify([pick('same-id')]);
  await settle(() => relay.requests.length === 1);
  await advance(MIN - 1000);
  assert.equal(relay.requests.length, 1);
  await advance(1000);
  await settle(() => relay.requests.length === 2);
  assert.equal(relay.requests[1].body, relay.requests[0].body);
});

test('stop: a request cut short by stop schedules no retry', async () => {
  const { relay, r } = await withRelay({ status: 200, delayMs: 5_000 });
  await r.calls.notify([pick('a')]);
  await settle(() => relay.requests.length === 1);
  const timeouts = mock.method(globalThis, 'setTimeout');
  await r.stop();
  await settle(() => false, 300);
  assert.deepEqual(timeouts.mock.calls.filter((c) => Number(c.arguments[1]) >= MIN), []);
});

test('notify: a redirect is refused and nothing reaches its target', async () => {
  const target = track(await startRelay());
  const { relay, r } = await withRelay({ status: 307, location: `${target.origin}/landing` });
  await r.calls.notify([pick('a')]);
  await settle(() => relay.requests.length > 0);
  await settle(() => false, 200);
  assert.equal(relay.requests.length, 1);
  assert.deepEqual(target.requests, []);
});

test('notify: with meraNewsApp null the plugin subscribes to nothing, and a stored pass is deleted at start', async () => {
  const stale = (dir: string) => writeFileSync(path.join(dir, 'push-pass.json'), JSON.stringify({ someone: { capability: CAP, expiresAt: 1_900_000_000 } }), { mode: 0o600 });
  const off = await run({ meraNewsApp: null, prepare: stale });
  open.push({ close: () => off.stop() });
  assert.equal(off.calls.listeners, 0);
  assert.equal(existsSync(path.join(off.dataDir, 'push-pass.json')), false);
  const on = await run({ meraNewsApp: 'http://127.0.0.1:9', prepare: stale });
  open.push({ close: () => on.stop() });
  assert.equal(on.calls.listeners, 1);
  assert.equal(existsSync(path.join(on.dataDir, 'push-pass.json')), true, 'kept while notifications are on');
});

test('/push-pass: refused without a device token, over 2048 bytes, or with extra keys; {} clears it', async () => {
  const { r, token, deviceId } = await paired({ meraNewsApp: 'http://127.0.0.1:9', pass: null });
  assert.equal((await r.raw({ path: '/push-pass', body: JSON.stringify({ capability: CAP, expiresAt: 1 }) })).status, 401);
  assert.equal((await push(r, token, { capability: 'x'.repeat(2048), expiresAt: 1 })).status, 413);
  assert.equal((await r.raw({ path: '/push-pass', headers: { authorization: `Bearer ${token}` }, body: 'null' })).status, 400);
  for (const body of [{ capability: CAP }, { expiresAt: 1 }, { capability: 5, expiresAt: 1 }, { capability: CAP, expiresAt: '1' }, { capability: '', expiresAt: 1 }, { capability: CAP, expiresAt: 1, url: 'https://evil.example' }, [], 'text']) {
    const res = await push(r, token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(JSON.parse(res.body).error, 'bad_request');
  }
  assert.equal(existsSync(path.join(r.dataDir, 'push-pass.json')), false, 'nothing stored by a refused body');
  assert.deepEqual(JSON.parse((await push(r, token)).body), {});
  assert.equal(readJson(r, 'push-pass.json')[deviceId].capability, CAP);
  assert.equal((await push(r, token, {})).status, 200);
  assert.deepEqual(readJson(r, 'push-pass.json'), {});
});

test('push-pass.json: mode 0600; revoking the device deletes its pass at once', async () => {
  const { r, token, deviceId } = await paired({ meraNewsApp: 'http://127.0.0.1:9' });
  const second = addDevice(r.dataDir, 'Tablet', 'second-device-token');
  await push(r, 'second-device-token', { capability: 'second-capability', expiresAt: 3 });
  assert.equal(statSync(path.join(r.dataDir, 'push-pass.json')).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(readJson(r, 'push-pass.json')).sort(), [deviceId, second.id].sort());
  assert.equal((await r.call(token, '/devices/revoke', {})).status, 200);
  assert.deepEqual(readJson(r, 'push-pass.json'), { [second.id]: { capability: 'second-capability', expiresAt: 3 } });
  removeDevice(r.dataDir, second.id);
  assert.deepEqual(readJson(r, 'push-pass.json'), {}, 'the command line revokes through the same path');
});

test('status: appNotifications off, needs_pass and on; relayOrigin is the origin, or null when off', async () => {
  const relay = track(await startRelay());
  const { r, token } = await paired({ meraNewsApp: relay.origin, pass: null });
  const status = async (x = r, t = token) => JSON.parse((await x.call(t, '/status', undefined, 'GET')).body);
  assert.deepEqual([(await status()).appNotifications, (await status()).relayOrigin], ['needs_pass', relay.origin]);
  await push(r, token);
  assert.equal((await status()).appNotifications, 'on');
  await push(r, token, {});
  assert.equal((await status()).appNotifications, 'needs_pass');
  const off = await paired({ meraNewsApp: null });
  const s = await status(off.r, off.token);
  assert.deepEqual([s.appNotifications, s.relayOrigin], ['off', null]);
  assert.equal('wakeups' in s, false);
});

test('logs: no line carries the pass, the title or the pickId', async () => {
  const title = 'Zanzibar ferry resumes service';
  const id = 'pickid-secret-42';
  for (const answer of [{ status: 400 }, { status: 401, body: `{"echo":"${CAP}"}` }, { status: 418 }, { status: 307, location: 'http://127.0.0.1:9/x' }, { status: 500 }]) {
    const { relay, r } = await withRelay(answer);
    await r.calls.notify([pick(id, 'high', title)]);
    await settle(() => relay.requests.length > 0);
    await settle(() => false, 100);
    assert.ok(r.logs.length > 0 || answer.status !== 401);
    const all = r.logs.join('\n');
    for (const secret of [CAP, title, id, 'Zanzibar']) assert.ok(!all.includes(secret), `${answer.status} leaked ${secret}`);
  }
});

test('stop: no retry or pace timer outlives the plugin', async () => {
  const timers = () => process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;
  const base = timers();
  const { relay, r } = await withRelay({ status: 500 });
  await r.calls.notify([pick('a')]);
  await settle(() => relay.requests.length === 1);
  await r.calls.notify([pick('b')]); // waits in the slot behind a pace timer
  await settle(() => false, 100); // a retry timer is waiting too
  assert.ok(timers() >= base + 2, 'a pace timer and a retry timer are waiting');
  await r.stop();
  await settle(() => timers() === base, 300);
  assert.equal(timers(), base);
  assert.equal(r.calls.listeners, 0);
});

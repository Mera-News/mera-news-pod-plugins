import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { addDevice, removeDevice } from '../src/store';
import { run, startRelay, type Relay, type Running } from './helpers';

const CAP = 'capability-secret-0123456789';
const MIN = 60_000;
const open: { close(): Promise<void> | void }[] = [];
afterEach(async () => {
  mock.timers.reset();
  mock.restoreAll();
  for (const c of open.splice(0)) await c.close();
});

const track = <T extends { close(): Promise<void> | void }>(x: T): T => (open.push(x), x);
const ping = (r: Running, token: string, body: unknown = { capability: CAP, expiresAt: 1_900_000_000 }) => r.call(token, '/ping', body);
const readJson = (r: Running, file: string) => JSON.parse(readFileSync(path.join(r.dataDir, file), 'utf8'));
// Real turns of the event loop, so a test with mocked timers still lets the loopback I/O finish.
async function settle(until: () => boolean = () => false, ms = 1500) {
  const end = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (!until() && process.hrtime.bigint() < end) await new Promise((r) => setImmediate(r));
}
const backdateSeen = (r: Running, id: string) => writeFileSync(path.join(r.dataDir, 'seen.json'), JSON.stringify({ [id]: '2000-01-01T00:00:00.000Z' }), { mode: 0o600 });

async function paired(opts: { wakeRelay?: string | null } = {}) {
  const r = await run(opts);
  open.push({ close: () => r.stop() });
  const { token, deviceId } = await r.pair();
  return { r, token, deviceId };
}

test('ping: the URL is the relay origin plus /api/pod/ping, whatever the phone sent', async () => {
  const relay = track(await startRelay());
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  const res = await ping(r, token, { capability: 'https://evil.example/steal', expiresAt: 1_900_000_000 });
  assert.equal(res.status, 200);
  backdateSeen(r, deviceId);
  r.calls.emit();
  await settle(() => relay.requests.length > 0);
  assert.equal(relay.requests.length, 1);
  assert.equal(relay.requests[0].method, 'POST');
  assert.equal(relay.requests[0].url, '/api/pod/ping');
  assert.deepEqual(JSON.parse(relay.requests[0].body), { capability: 'https://evil.example/steal' });
});

test('ping: a redirect from the relay is refused and nothing reaches its target', async () => {
  const target = track(await startRelay());
  const relay = track(await startRelay({ status: 307, location: `${target.origin}/landing` }));
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  await ping(r, token);
  backdateSeen(r, deviceId);
  r.calls.emit();
  await settle(() => relay.requests.length > 0);
  await settle(() => false, 200);
  assert.equal(relay.requests.length, 1);
  assert.deepEqual(target.requests, []);
  assert.ok(readJson(r, 'ping.json')[deviceId], 'a failed send keeps the entry');
});

test('ping: with wakeRelay null nothing is sent and status says disabled', async () => {
  const fetchSpy = mock.method(globalThis, 'fetch', async () => new Response(null, { status: 202 }));
  const { r, token, deviceId } = await paired({ wakeRelay: null });
  assert.equal((await ping(r, token)).status, 200);
  backdateSeen(r, deviceId);
  r.calls.emit();
  await settle(() => false, 200);
  assert.equal(fetchSpy.mock.callCount(), 0);
  const status = JSON.parse((await r.call(token, '/status', undefined, 'GET')).body);
  assert.equal(status.wakeups, 'disabled');
  assert.equal(status.relayOrigin, null);
});

test('/ping: refused without a device token, over 2048 bytes, and with a malformed body', async () => {
  const { r, token } = await paired({ wakeRelay: 'http://127.0.0.1:9' });
  assert.equal((await r.raw({ path: '/ping', body: JSON.stringify({ capability: CAP, expiresAt: 1 }) })).status, 401);
  assert.equal((await ping(r, token, { capability: 'x'.repeat(2048), expiresAt: 1 })).status, 413);
  assert.equal((await r.raw({ path: '/ping', headers: { authorization: `Bearer ${token}` }, body: 'null' })).status, 400);
  for (const body of [{ capability: CAP }, { expiresAt: 1 }, { capability: 5, expiresAt: 1 }, { capability: CAP, expiresAt: '1' }, { capability: '', expiresAt: 1 }, { capability: CAP, expiresAt: 1, url: 'https://evil.example' }, [], 'text']) {
    const res = await ping(r, token, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(JSON.parse(res.body).error, 'bad_request');
  }
  const bad = await r.call(token, '/ping', undefined);
  assert.equal(bad.status, 200, 'an empty body is the clear request');
  assert.equal((await r.raw({ path: '/ping', headers: { authorization: `Bearer ${token}` }, body: '{nope' })).status, 400);
  assert.equal((await ping(r, token)).status, 200);
  assert.deepEqual(JSON.parse((await ping(r, token)).body), {});
});

test("/ping: an empty body clears that device's entry", async () => {
  const { r, token, deviceId } = await paired({ wakeRelay: 'http://127.0.0.1:9' });
  await ping(r, token);
  assert.equal(readJson(r, 'ping.json')[deviceId].capability, CAP);
  assert.equal((await ping(r, token, {})).status, 200);
  assert.deepEqual(readJson(r, 'ping.json'), {});
  const status = JSON.parse((await r.call(token, '/status', undefined, 'GET')).body);
  assert.equal(status.wakeups, 'off');
});

test("ping.json: one entry per device, mode 0600; revoking one device keeps the other's entry", async () => {
  const { r, token, deviceId } = await paired();
  const second = addDevice(r.dataDir, 'Tablet', 'second-device-token');
  await ping(r, token, { capability: 'first-capability', expiresAt: 1 });
  await ping(r, token, { capability: CAP, expiresAt: 2 });
  await ping(r, 'second-device-token', { capability: 'second-capability', expiresAt: 3 });
  const file = path.join(r.dataDir, 'ping.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readJson(r, 'ping.json'), { [deviceId]: { capability: CAP, expiresAt: 2 }, [second.id]: { capability: 'second-capability', expiresAt: 3 } });
  assert.equal((await r.call(token, '/devices/revoke', {})).status, 200);
  assert.deepEqual(readJson(r, 'ping.json'), { [second.id]: { capability: 'second-capability', expiresAt: 3 } });
  removeDevice(r.dataDir, second.id);
  assert.deepEqual(readJson(r, 'ping.json'), {}, 'the command line revokes through the same path');
});

test('ping: a change inside the 31-minute window sends one trailing ping when it ends, and that ping goes out after the relay\'s 30-minute slot', async () => {
  const relay = track(await startRelay());
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  await ping(r, token);
  // Seen just now: the first ping waits for the 2 minutes to end, then goes out and opens the window.
  r.calls.emit();
  mock.timers.tick(2 * MIN);
  await settle(() => relay.requests.length === 1);
  assert.equal(relay.requests.length, 1);
  await settle(() => readJson(r, 'ping.json')[deviceId].lastSentAt !== undefined);
  const sentAt = readJson(r, 'ping.json')[deviceId].lastSentAt;
  mock.timers.tick(1000);
  r.calls.emit();
  r.calls.emit();
  assert.equal(readJson(r, 'ping.json')[deviceId].pending, true);
  mock.timers.tick(30 * MIN - 1000);
  await settle(() => false, 100);
  assert.equal(Date.now() - sentAt, 30 * MIN);
  assert.equal(relay.requests.length, 1, 'nothing goes out inside the relay\'s 30-minute slot');
  mock.timers.tick(MIN);
  await settle(() => relay.requests.length === 2);
  assert.equal(relay.requests.length, 2);
  await settle(() => false, 100);
  mock.timers.tick(60 * MIN);
  await settle(() => false, 100);
  assert.equal(relay.requests.length, 2, 'one trailing ping, not one per change');
  assert.equal(readJson(r, 'ping.json')[deviceId].pending, undefined);
});

test('ping: a change while the device was seen in the last 2 minutes pings when the 2 minutes end, and reschedules if it was seen again', async () => {
  const relay = track(await startRelay());
  const { r, token } = await paired({ wakeRelay: relay.origin });
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  await ping(r, token);
  mock.timers.tick(10_000);
  r.calls.emit();
  mock.timers.tick(90_000);
  assert.equal((await r.call(token, '/status', undefined, 'GET')).status, 200); // seen again at 100 s
  mock.timers.tick(20_000); // 120 s: the first timer fires and finds the phone seen 20 s ago
  await settle(() => relay.requests.length > 0, 100);
  assert.equal(relay.requests.length, 0);
  mock.timers.tick(99_000);
  await settle(() => relay.requests.length > 0, 100);
  assert.equal(relay.requests.length, 0, 'still inside 2 minutes of the second sighting');
  mock.timers.tick(1000);
  await settle(() => relay.requests.length === 1);
  assert.equal(relay.requests.length, 1);
});

test('ping: only a 401 whose body error is capability_invalid deletes; a 500, a 503, a 429 and a bare 401 keep', async () => {
  const relay = track(await startRelay());
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  await ping(r, token);
  backdateSeen(r, deviceId);
  let sent = 0;
  for (const answer of [
    { status: 500 },
    { status: 503 },
    { status: 429 },
    { status: 401, body: '' },
    { status: 401, body: 'not json' },
    { status: 401, body: '{"error":"other"}' },
    { status: 403, body: '{"error":"capability_invalid"}' },
  ]) {
    relay.answer = answer;
    r.calls.emit();
    await settle(() => relay.requests.length === sent + 1);
    await settle(() => false, 50);
    assert.equal(relay.requests.length, ++sent, JSON.stringify(answer));
    assert.equal(readJson(r, 'ping.json')[deviceId].capability, CAP, `kept after ${JSON.stringify(answer)}`);
  }
  relay.answer = { status: 401, body: '{"error":"capability_invalid"}' };
  r.calls.emit();
  await settle(() => readJson(r, 'ping.json')[deviceId] === undefined);
  assert.deepEqual(readJson(r, 'ping.json'), {});
  assert.ok(r.logs.some((l) => l.includes("A phone's wake-up pass was refused. Open the app on that phone to resume wake-ups.")));
  r.calls.emit();
  await settle(() => false, 100);
  assert.equal(relay.requests.length, sent + 1, 'with no entry nothing more is sent');
});

test('status: wakeups on, off and disabled, and relayOrigin', async () => {
  const relay = track(await startRelay());
  const { r, token } = await paired({ wakeRelay: relay.origin });
  const status = async () => JSON.parse((await r.call(token, '/status', undefined, 'GET')).body);
  assert.deepEqual([(await status()).wakeups, (await status()).relayOrigin], ['off', relay.origin]);
  await ping(r, token);
  assert.equal((await status()).wakeups, 'on');
  await ping(r, token, {});
  assert.equal((await status()).wakeups, 'off');
  const off = await paired({ wakeRelay: null });
  await ping(off.r, off.token);
  assert.deepEqual([(await off.r.call(off.token, '/status', undefined, 'GET')).body].map((b) => [JSON.parse(b).wakeups, JSON.parse(b).relayOrigin]), [['disabled', null]]);
});

test('logs: no line carries a capability', async () => {
  const relay = track(await startRelay());
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  await ping(r, token);
  backdateSeen(r, deviceId);
  for (const answer of [{ status: 500 }, { status: 307, location: `${relay.origin}/x` }, { status: 401, body: `{"error":"capability_invalid","echo":"${CAP}"}` }]) {
    relay.answer = answer;
    r.calls.emit();
    await settle(() => false, 100);
  }
  assert.equal(relay.requests.length, 3);
  const second = await paired({ wakeRelay: relay.origin });
  await ping(second.r, second.token);
  backdateSeen(second.r, second.deviceId);
  relay.answer = { status: 202 };
  second.r.calls.emit();
  await settle(() => relay.requests.length === 4);
  const logs = [...r.logs, ...second.r.logs];
  assert.ok(logs.length > 0);
  assert.ok(!logs.join('\n').includes(CAP));
});

test('stop: no timer outlives the plugin', async () => {
  const relay = track(await startRelay());
  const timers = () => process.getActiveResourcesInfo().filter((n) => n === 'Timeout').length;
  const base = timers();
  const { r, token } = await paired({ wakeRelay: relay.origin });
  await ping(r, token);
  r.calls.emit(); // seen just now, so a 2-minute timer is waiting
  assert.ok(timers() > base, 'a timer is waiting');
  await r.stop();
  await settle(() => timers() === base, 200);
  assert.equal(timers(), base);
  assert.equal(r.calls.listeners, 0);
});

test('ping: a change while a refused wake-up is in flight leads to one more wake-up, with the newer pass', async () => {
  const relay = track(await startRelay({ status: 401, body: '{"error":"capability_invalid"}', delayMs: 300 }));
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  await ping(r, token);
  backdateSeen(r, deviceId);
  r.calls.emit();
  await settle(() => relay.requests.length === 1);
  r.calls.emit();
  await ping(r, token, { capability: 'newer-capability', expiresAt: 1_900_000_000 });
  backdateSeen(r, deviceId); // posting the pass was a sighting; move it back so the phone counts as closed
  await settle(() => relay.requests.length === 2, 3000);
  assert.equal(relay.requests.length, 2, 'the change that came during the send is not lost');
  assert.deepEqual(JSON.parse(relay.requests[1].body), { capability: 'newer-capability' });
});

test('ping: a change while an accepted wake-up is in flight is kept for the trailing ping', async () => {
  const relay = track(await startRelay({ status: 202, delayMs: 300 }));
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  await ping(r, token);
  backdateSeen(r, deviceId);
  r.calls.emit();
  await settle(() => relay.requests.length === 1);
  r.calls.emit();
  await settle(() => readJson(r, 'ping.json')[deviceId]?.pending === true, 3000);
  assert.equal(readJson(r, 'ping.json')[deviceId].pending, true);
  assert.equal(relay.requests.length, 1, 'still inside the window');
});

test('ping: with wake-ups off the plugin subscribes to nothing', async () => {
  const { r } = await paired({ wakeRelay: null });
  assert.equal(r.calls.listeners, 0);
});

test('/ping: posting a pass again keeps when the last wake-up went out', async () => {
  const relay = track(await startRelay());
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  await ping(r, token);
  backdateSeen(r, deviceId);
  r.calls.emit();
  await settle(() => readJson(r, 'ping.json')[deviceId]?.lastSentAt !== undefined);
  const sentAt = readJson(r, 'ping.json')[deviceId].lastSentAt;
  await ping(r, token);
  await ping(r, token, { capability: 'newer-capability', expiresAt: 1_900_000_000 });
  assert.equal(readJson(r, 'ping.json')[deviceId].lastSentAt, sentAt);
});

test('ping: an expired pass is dropped without asking the relay', async () => {
  const relay = track(await startRelay());
  const { r, token, deviceId } = await paired({ wakeRelay: relay.origin });
  await ping(r, token, { capability: CAP, expiresAt: 1_000_000_000 }); // 2001, in seconds
  backdateSeen(r, deviceId);
  r.calls.emit();
  await settle(() => !readJson(r, 'ping.json')[deviceId]);
  assert.equal(relay.requests.length, 0);
  assert.equal(readJson(r, 'ping.json')[deviceId], undefined);
});

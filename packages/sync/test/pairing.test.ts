import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, mock, test } from 'node:test';
import { run } from './helpers';

afterEach(() => mock.timers.reset());

const WRONG = 'AAAAAAAAAA';
const tryCode = (r: Awaited<ReturnType<typeof run>>, code: string) => r.raw({ path: '/pair', body: JSON.stringify({ code, deviceName: 'P' }) });
const reason = (res: { body: string }) => JSON.parse(res.body).error;

test('a code is 10 base32 characters', async () => {
  const r = await run();
  try {
    assert.match(r.newCode(), /^[A-Z2-7]{10}$/);
  } finally {
    await r.stop();
  }
});

test('a wrong code is refused and counted', async () => {
  const r = await run();
  try {
    r.newCode();
    const res = await tryCode(r, WRONG);
    assert.equal(res.status, 403);
    assert.equal(reason(res), 'wrong_code');
    assert.equal(JSON.parse(readFileSync(path.join(r.dataDir, 'pairing.json'), 'utf8')).wrong, 1);
  } finally {
    await r.stop();
  }
});

test('after 10 wrong codes in total the pending code is dead, even the right one', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const r = await run();
  try {
    const code = r.newCode();
    for (let i = 0; i < 10; i++) {
      assert.equal(reason(await tryCode(r, WRONG)), 'wrong_code');
      if (i % 4 === 3) mock.timers.tick(61_000);
    }
    mock.timers.tick(61_000);
    assert.equal(reason(await tryCode(r, WRONG)), 'pairing_closed');
    assert.equal(reason(await tryCode(r, code)), 'pairing_closed');
    // a new code opens pairing again
    assert.equal((await r.pair('Again')).firstDevice, true);
  } finally {
    await r.stop();
  }
});

test('more than 5 tries a minute answer too_many_tries whatever the address', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const r = await run();
  try {
    r.newCode();
    for (let i = 0; i < 5; i++) {
      const res = await r.raw({ path: '/pair', headers: { 'x-forwarded-for': `10.0.0.${i}` }, body: JSON.stringify({ code: WRONG, deviceName: 'P' }) });
      assert.equal(reason(res), 'wrong_code');
    }
    const sixth = await r.raw({ path: '/pair', headers: { 'x-forwarded-for': '10.9.9.9' }, body: JSON.stringify({ code: WRONG, deviceName: 'P' }) });
    assert.equal(sixth.status, 429);
    assert.equal(reason(sixth), 'too_many_tries');
    mock.timers.tick(61_000);
    assert.equal(reason(await tryCode(r, WRONG)), 'wrong_code');
  } finally {
    await r.stop();
  }
});

test('a right code pairs once, returns the token once and is dead after', async () => {
  const r = await run({ profile: { has: true } });
  try {
    const code = r.newCode();
    const res = await tryCode(r, code);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'firstDevice', 'hasProfile', 'podName', 'token']);
    assert.equal(body.podName, 'Test pod');
    assert.equal(body.hasProfile, true);
    assert.equal(body.firstDevice, true);
    assert.ok(body.token.length >= 43);

    const file = path.join(r.dataDir, 'devices.json');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const stored = readFileSync(file, 'utf8');
    assert.ok(!stored.includes(body.token), 'only the hash is stored');
    assert.ok(stored.includes(body.deviceId));

    assert.equal(reason(await tryCode(r, code)), 'pairing_closed');
  } finally {
    await r.stop();
  }
});

test('the pairing file is readable only by the owner', async () => {
  const r = await run();
  try {
    r.newCode();
    assert.equal(statSync(path.join(r.dataDir, 'pairing.json')).mode & 0o777, 0o600);
    assert.ok(!readFileSync(path.join(r.dataDir, 'pairing.json'), 'utf8').includes('"code"'));
  } finally {
    await r.stop();
  }
});

test('a code expires after 10 minutes', async () => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const r = await run();
  try {
    const code = r.newCode();
    mock.timers.tick(10 * 60_000 + 1);
    assert.equal(reason(await tryCode(r, code)), 'pairing_closed');
  } finally {
    await r.stop();
  }
});

test('without a pending code pairing is closed', async () => {
  const r = await run();
  try {
    assert.equal(reason(await tryCode(r, WRONG)), 'pairing_closed');
  } finally {
    await r.stop();
  }
});

test('several devices pair; only the first is told it is first, and a replace works only while one device is paired', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    assert.equal(a.firstDevice, true);
    // Alone, the first device may replace the profile.
    assert.equal((await r.call(a.token, '/profile/replace', { schemaVersion: 7, tables: { facts: { rows: [] } } })).status, 200);
    assert.equal(r.calls.replace.length, 1);

    const b = await r.pair('B');
    assert.equal(b.firstDevice, false);
    assert.equal((await r.call(a.token, '/status', undefined, 'GET')).status, 200);
    assert.equal((await r.call(b.token, '/status', undefined, 'GET')).status, 200);

    // Once a second device has paired the profile is theirs too: A, paired first, is refused now.
    const late = await r.call(a.token, '/profile/replace', { schemaVersion: 7, tables: {} });
    assert.equal(late.status, 403);
    assert.deepEqual(JSON.parse(late.body), { error: 'not_only_device' });
    assert.equal((await r.call(b.token, '/profile/replace', { schemaVersion: 7, tables: {} })).status, 403);
    assert.equal(r.calls.replace.length, 1);
  } finally {
    await r.stop();
  }
});

test('after every device is revoked the next one is first again', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    assert.equal((await r.call(a.token, '/devices/revoke')).status, 200);
    const b = await r.pair('B');
    assert.equal(b.firstDevice, true);
    assert.equal((await r.call(b.token, '/profile/replace', { schemaVersion: 7, tables: {} })).status, 200);
  } finally {
    await r.stop();
  }
});

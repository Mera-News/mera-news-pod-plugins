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
    assert.ok((await r.pair('Again')).token);
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
  const r = await run();
  try {
    const code = r.newCode();
    const res = await tryCode(r, code);
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body).sort(), ['deviceId', 'podName', 'token']);
    assert.equal(body.podName, 'Test pod');
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

test('while a device is paired, a second pairing is refused even with a valid code', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    const second = await tryCode(r, r.newCode());
    assert.equal(second.status, 409);
    assert.equal(reason(second), 'already_paired');
    assert.equal(JSON.parse(readFileSync(path.join(r.dataDir, 'devices.json'), 'utf8')).length, 1);
    assert.equal((await r.call(a.token, '/status', undefined, 'GET')).status, 200);
  } finally {
    await r.stop();
  }
});

test('after a revoke a new device pairs, and the revoked one gets 401', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    assert.equal((await r.call(a.token, '/devices/revoke')).status, 200);
    const b = await r.pair('B');
    assert.equal((await r.call(b.token, '/status', undefined, 'GET')).status, 200);
    assert.equal((await r.call(a.token, '/status', undefined, 'GET')).status, 401);
  } finally {
    await r.stop();
  }
});

test('a phone cannot replace the pod\'s profile', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    assert.equal((await r.call(a.token, '/profile/replace', { schemaVersion: 7, tables: {} })).status, 404);
  } finally {
    await r.stop();
  }
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { siteLink } from '../src/link';
import { createRemote, MAX_WRONG_CODES, PAIR_MS, parsePublicHost, viaPublic } from '../src/remote';
import { run, type Running } from './helpers';

const HOST = 'mac.tail1234.ts.net';
const ORIGIN = `https://${HOST}`;
/** What tailscale serve adds to a request it forwards from the tailnet. */
const parse = (body: string) => {
  try {
    return JSON.parse(body || 'null');
  } catch {
    return body;
  }
};
const FORWARDED = { host: HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-host': HOST };

async function signedIn(opts: Parameters<typeof run>[0] = {}) {
  const r = await run(opts);
  const code = /#c=(.+)$/.exec(siteLink(r.dataDir))![1];
  const { session } = JSON.parse((await r.session(code)).body);
  const local = async (p: string, body?: unknown) => {
    const res = await r.request({
      path: p,
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${session}`, ...(body === undefined ? {} : { origin: r.origin(), 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: parse(res.body), headers: res.headers };
  };
  /** A request from a phone through the forwarder; `headers` override what tailscale serve adds. */
  const phone = async (p: string, o: { body?: unknown; cookie?: string; headers?: Record<string, string | undefined> } = {}) => {
    const res = await r.request({
      path: p,
      method: o.body === undefined ? 'GET' : 'POST',
      headers: { ...FORWARDED, ...(o.body === undefined ? {} : { origin: ORIGIN, 'content-type': 'application/json' }), ...(o.cookie ? { cookie: o.cookie } : {}), ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    return { status: res.status, body: parse(res.body), headers: res.headers };
  };
  const startPairing = async () => {
    const res = await local('/api/pair/start/', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { ...res.body, code: /#([A-Z2-7]{10})$/.exec(res.body.url)![1] as string };
  };
  /** Pairs a phone and returns its cookie as the browser would send it back. */
  const pairPhone = async (name = 'iPhone') => {
    const { code } = await startPairing();
    const res = await phone('/api/pair/', { body: { code, name } });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return String(res.headers['set-cookie']).split(';')[0];
  };
  return { r, local, phone, startPairing, pairPhone };
}

const withHost = { before: (dir: string) => createRemote(dir).saveRemote({ publicHost: HOST }) };

async function using(r: Running, fn: () => Promise<void>) {
  try {
    await fn();
  } finally {
    await r.stop();
  }
}

test('the public address is set from this computer, checked, and comes back with the exact forwarding command', async () => {
  const { r, local } = await signedIn();
  await using(r, async () => {
    const before = await local('/api/remote/');
    assert.deepEqual(before.body, { publicHost: null, port: r.port(), command: `tailscale serve --bg --https=443 http://127.0.0.1:${r.port()}`, tunnelTo: `http://127.0.0.1:${r.port()}` });
    for (const bad of ['not a host', 'localhost', '127.0.0.1', 'http://mac.ts.net', 'mac.ts.net:8443', 'mac.ts.net/path', 42]) {
      const res = await local('/api/remote/', { publicHost: bad });
      assert.equal(res.status, 400, String(bad));
      assert.equal(res.body.error, 'bad_input');
    }
    const set = await local('/api/remote/', { publicHost: ` https://MAC.tail1234.ts.net/ ` });
    assert.equal(set.status, 200);
    assert.equal(set.body.publicHost, HOST);
    assert.equal(statSync(path.join(r.dataDir, 'remote.json')).mode & 0o777, 0o600);
    assert.ok(r.plugin.describe!().some((l) => l.includes(`https://${HOST}/`) && l.includes(`http://127.0.0.1:${r.port()}`)));
    assert.equal((await local('/api/remote/', { publicHost: null })).body.publicHost, null);
  });
});

test('a phone pairs with a one-time code and keeps a device session in a cookie only https gets', async () => {
  const { r, phone, startPairing } = await signedIn(withHost);
  await using(r, async () => {
    const start = await startPairing();
    assert.match(start.url, new RegExp(`^https://${HOST.replace(/\./g, '\\.')}/pair/#[A-Z2-7]{10}$`));
    assert.ok(Date.parse(start.expiresAt) - Date.now() > PAIR_MS - 5000);
    assert.ok(start.qr.length >= 21 && start.qr.every((row: string) => /^[01]+$/.test(row) && row.length === start.qr.length), 'a square of modules');

    // Not paired yet: the API refuses the phone.
    assert.equal((await phone('/api/status/')).status, 401);

    const paired = await phone('/api/pair/', { body: { code: start.code.toLowerCase().replace(/(.{5})/, '$1-'), name: 'iPhone <b>' } });
    assert.equal(paired.status, 200);
    const cookie = String(paired.headers['set-cookie']);
    assert.match(cookie, /^__Host-mera-device=[\w-]{43}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
    const token = /=([\w-]{43})/.exec(cookie)![1];

    const devices = readFileSync(path.join(r.dataDir, 'devices.json'), 'utf8');
    assert.equal(statSync(path.join(r.dataDir, 'devices.json')).mode & 0o777, 0o600);
    assert.ok(!devices.includes(token), 'only the hash is kept');
    assert.deepEqual(JSON.parse(devices).map((d: { name: string }) => d.name), ['iPhone b']);

    const status = await phone('/api/status/', { cookie: cookie.split(';')[0] });
    assert.equal(status.status, 200);
    assert.match(String(status.headers['set-cookie']), /^__Host-mera-device=.*HttpOnly; Secure; SameSite=Strict$/, 'each answer renews the cookie');
    assert.equal((await phone('/api/devices/', { cookie: cookie.split(';')[0] })).body.devices.length, 1);

    // The code worked once.
    const again = await phone('/api/pair/', { body: { code: start.code } });
    assert.deepEqual([again.status, again.body], [403, { error: 'pairing_closed' }]);
  });
});

test('a wrong code is refused and counted on disk, and a new code voids the one before', async () => {
  const { r, phone, startPairing } = await signedIn(withHost);
  await using(r, async () => {
    const first = await startPairing();
    const wrong = await phone('/api/pair/', { body: { code: first.code === 'AAAAAAAAAA' ? 'BBBBBBBBBB' : 'AAAAAAAAAA' } });
    assert.deepEqual([wrong.status, wrong.body], [403, { error: 'wrong_code' }]);
    assert.equal(wrong.headers['set-cookie'], undefined);
    assert.equal(JSON.parse(readFileSync(path.join(r.dataDir, 'pairing.json'), 'utf8')).wrong, 1);
    for (const code of [undefined, 42, '']) assert.equal((await phone('/api/pair/', { body: { code } })).body.error, 'wrong_code');
    const second = await startPairing();
    assert.notEqual(second.code, first.code);
    assert.equal((await phone('/api/pair/', { body: { code: first.code } })).body.error, 'wrong_code', 'the first code is void');
    assert.equal((await phone('/api/pair/', { body: { code: second.code } })).body.error, 'too_many_tries', 'five tries this minute');
  });
});

test('pairing: five tries a minute, ten wrong codes close it even across a restart, and a code lasts ten minutes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'web-remote-'));
  let now = Date.parse('2026-01-01T00:00:00Z');
  let store = createRemote(dir);
  const { code } = store.startPairing(now);
  for (let i = 0; i < 5; i++) assert.equal(store.pair('WRONGWRONG', 'Phone', now).ok, false);
  const limited = store.pair(code, 'Phone', now);
  assert.deepEqual(limited, { ok: false, status: 429, error: 'too_many_tries' });

  // A restart forgets the per-minute count but not the wrong codes.
  store = createRemote(dir);
  for (let i = 5; i < MAX_WRONG_CODES; i++) {
    now += 60_000 / 5;
    assert.equal(store.pair('WRONGWRONG', 'Phone', now).ok, false);
  }
  now += 60_000;
  assert.deepEqual(store.pair(code, 'Phone', now), { ok: false, status: 403, error: 'pairing_closed' });

  const fresh = store.startPairing(now);
  assert.deepEqual(store.pair(fresh.code, 'Phone', now + PAIR_MS), { ok: false, status: 403, error: 'pairing_closed' }, 'expired');
  const last = store.startPairing(now);
  assert.equal(store.pair(last.code, 'Phone', now + PAIR_MS - 1).ok, true);
  assert.deepEqual(store.pair(last.code, 'Phone', now + PAIR_MS - 1), { ok: false, status: 403, error: 'pairing_closed' }, 'used');
});

test('a removed phone is out at once, and a phone can remove itself', async () => {
  const { r, local, phone, pairPhone } = await signedIn(withHost);
  await using(r, async () => {
    const a = await pairPhone('iPhone');
    const b = await pairPhone('Android phone');
    const list = (await local('/api/devices/')).body.devices as { id: string; name: string; pairedAt: string }[];
    assert.deepEqual(list.map((d) => Object.keys(d).sort()), [['id', 'name', 'pairedAt'], ['id', 'name', 'pairedAt']]);
    assert.deepEqual((await local('/api/devices/remove/', { id: list[0].id })).body, { removed: true });
    assert.equal((await phone('/api/status/', { cookie: a })).status, 401);
    assert.equal((await phone('/api/status/', { cookie: b })).status, 200);
    assert.deepEqual((await phone('/api/devices/remove/', { cookie: b, body: { id: list[1].id } })).body, { removed: true });
    assert.equal((await phone('/api/status/', { cookie: b })).status, 401);
    assert.deepEqual((await local('/api/devices/remove/', { id: list[1].id })).body, { removed: false });
    assert.equal((await local('/api/devices/remove/', { id: '../x' })).status, 400);
  });
});

test('only this computer sets the public address, adds a phone or keeps Mera News running, and only a phone pairs', async () => {
  const { r, local, phone, pairPhone } = await signedIn(withHost);
  await using(r, async () => {
    const cookie = await pairPhone();
    assert.equal((await phone('/api/pair/start/', { cookie, body: {} })).status, 403);
    assert.equal((await phone('/api/remote/', { cookie })).status, 403);
    assert.equal((await phone('/api/remote/', { cookie, body: { publicHost: 'evil.example' } })).status, 403);
    assert.equal((await phone('/api/keep-running/', { cookie })).status, 403, 'a phone cannot see or change keep running');
    assert.equal((await phone('/api/keep-running/', { cookie, body: { on: true } })).status, 403);
    assert.equal((await local('/api/keep-running/')).body.available, process.platform === 'darwin' ? 'not_bundled' : 'not_mac', 'outside the bundle it is not offered');
    assert.equal((await phone('/api/session/', { body: { code: 'x' } })).status, 403, 'the one-time link is for this computer');
    const onComputer = await local('/api/pair/', { code: 'AAAAAAAAAA' });
    assert.deepEqual([onComputer.status, onComputer.body], [403, null], 'refused before any code is checked');
    // A cookie means nothing on this computer, and a bearer session nothing on the public address.
    assert.equal((await r.request({ path: '/api/status/', headers: { cookie } })).status, 401);
    assert.equal((await r.request({ path: '/api/pair/start/', method: 'POST', headers: { origin: r.origin(), 'content-type': 'application/json' }, body: '{}' })).status, 401);
  });
});

test('adding a phone needs the public address first', async () => {
  const { r, local } = await signedIn();
  await using(r, async () => {
    const res = await local('/api/pair/start/', {});
    assert.deepEqual([res.status, res.body.error], [400, 'no_public_address']);
  });
});

test('the public address answers only over HTTPS as the forwarder saw it, and only for its own name and origin', async () => {
  const { r, phone, pairPhone } = await signedIn(withHost);
  await using(r, async () => {
    const cookie = await pairPhone();
    assert.equal((await phone('/', { cookie })).status, 200);
    assert.equal((await phone('/pair/')).status, 200, 'the pairing page needs no cookie');
    const refused: [string, Record<string, string | undefined>][] = [
      ['plain http at the forwarder', { 'x-forwarded-proto': 'http' }],
      ['no protocol from the forwarder', { 'x-forwarded-proto': undefined }],
      ['a list starting with http', { 'x-forwarded-proto': 'http, https' }],
      ['another name', { host: 'evil.example' }],
      ['a name that only starts with it', { host: `${HOST}.evil.example` }],
      ['another port', { host: `${HOST}:8443` }],
      ['a forwarded request naming this computer', { host: `127.0.0.1:${r.port()}` }],
      ['a forwarded request naming localhost', { host: `localhost:${r.port()}` }],
    ];
    for (const [why, headers] of refused) {
      assert.equal((await phone('/api/status/', { cookie, headers })).status, 403, why);
      assert.equal((await phone('/', { headers })).status, 403, why);
    }
    // The public name without a forwarder did not come through HTTPS.
    assert.equal((await r.request({ path: '/', headers: { host: HOST } })).status, 403);
    assert.equal((await r.request({ path: '/', headers: { host: HOST, 'x-forwarded-proto': undefined, forwarded: 'proto=https' } })).status, 403);

    for (const origin of ['https://evil.example', `http://${HOST}`, r.origin(), `${ORIGIN}.evil.example`, 'null']) {
      assert.equal((await phone('/api/pair/', { body: { code: 'AAAAAAAAAA' }, headers: { origin } })).status, 403, origin);
      assert.equal((await phone('/api/devices/', { cookie, headers: { origin } })).status, 403, origin);
    }
    assert.equal((await phone('/api/pair/', { body: { code: 'AAAAAAAAAA' }, headers: { origin: undefined } })).status, 403, 'a POST with no Origin');
    // On this computer the public origin is not this page's.
    assert.equal((await r.request({ path: '/', headers: { origin: ORIGIN } })).status, 403);
  });
});

test('X-Forwarded-Proto is believed only from this computer, and only for the public name', () => {
  const h = { host: HOST, 'x-forwarded-proto': 'https' };
  assert.equal(viaPublic(h, '127.0.0.1', HOST), true);
  assert.equal(viaPublic(h, '::ffff:127.0.0.1', HOST), true);
  assert.equal(viaPublic({ ...h, host: `${HOST}:443` }, '127.0.0.1', HOST), true);
  for (const peer of ['100.64.0.2', '192.168.1.5', '::ffff:10.0.0.1', undefined]) assert.equal(viaPublic(h, peer, HOST), false, String(peer));
  assert.equal(viaPublic(h, '127.0.0.1', undefined), false, 'no public address set');
  assert.equal(viaPublic({ ...h, 'x-forwarded-proto': ['https'] as unknown as string }, '127.0.0.1', HOST), false);
  assert.equal(parsePublicHost('mac.tail1234.ts.net'), HOST);
  assert.equal(parsePublicHost('https://abc.ngrok-free.app/'), 'abc.ngrok-free.app');
  for (const bad of ['', '-a.ts.net', 'a..ts.net', 'a.ts.net.', '127.0.0.1', 'x'.repeat(64) + '.ts.net']) assert.equal(parsePublicHost(bad), null, bad);
});

test('the port is kept once chosen, and a move is reported with the new command', async () => {
  const first = await run({ config: { port: 0 } });
  const port = first.port();
  await first.stop();
  createRemote(first.dataDir).saveRemote({ ...createRemote(first.dataDir).remote(), publicHost: HOST });
  const again = await run({ home: first.home, config: { port: 0 } });
  await using(again, async () => assert.equal(again.port(), port));

  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  const moved = await run({ home: first.home, config: { port: 0 } });
  try {
    assert.notEqual(moved.port(), port);
    assert.ok(moved.logs.some((l) => l.includes(`tailscale serve --bg --https=443 http://127.0.0.1:${moved.port()}`)));
  } finally {
    await moved.stop();
    blocker.close();
  }
  const last = await run({ home: first.home, config: { port: 0 } });
  await using(last, async () => assert.equal(last.port(), moved.port(), 'the new port is the kept one now'));
});

test('no code, token or cookie ever reaches the log', async () => {
  const { r, phone, startPairing, pairPhone } = await signedIn(withHost);
  const secrets: string[] = [];
  await using(r, async () => {
    const { code, url } = await startPairing();
    secrets.push(code, url);
    await phone('/api/pair/', { body: { code: 'AAAAAAAAAA' } });
    const res = await phone('/api/pair/', { body: { code } });
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    secrets.push(cookie, cookie.split('=')[1]);
    await phone('/api/status/', { cookie });
    const other = await pairPhone();
    secrets.push(other.split('=')[1]);
  });
  const all = r.logs.join('\n');
  assert.ok(all.includes('A phone was paired.'));
  for (const s of secrets) assert.ok(!all.includes(s), 'a secret was logged');
});

test('Done voids the code on screen, and only this computer can void it', async () => {
  const { r, local, phone, startPairing, pairPhone } = await signedIn(withHost);
  await using(r, async () => {
    const cookie = await pairPhone();
    const { code } = await startPairing();
    assert.equal((await phone('/api/pair/stop/', { cookie, body: {} })).status, 403);
    assert.deepEqual((await local('/api/pair/stop/', {})).body, { stopped: true });
    const res = await phone('/api/pair/', { body: { code } });
    assert.deepEqual([res.status, res.body], [403, { error: 'pairing_closed' }]);
  });
});

test('a phone that pairs again replaces its own entry instead of adding one', async () => {
  const { r, local, phone, startPairing, pairPhone } = await signedIn(withHost);
  await using(r, async () => {
    const first = await pairPhone();
    const { code } = await startPairing();
    const again = await phone('/api/pair/', { cookie: first, body: { code, name: 'iPhone' } });
    assert.equal(again.status, 200);
    const second = String(again.headers['set-cookie']).split(';')[0];
    assert.equal((await local('/api/devices/')).body.devices.length, 1);
    assert.equal((await phone('/api/status/', { cookie: first })).status, 401, 'the old token is gone');
    assert.equal((await phone('/api/status/', { cookie: second })).status, 200);
  });
});

test('a phone sees which entry in the list is itself; this computer sees none marked', async () => {
  const { r, local, phone, pairPhone } = await signedIn(withHost);
  await using(r, async () => {
    const a = await pairPhone('iPhone');
    await pairPhone('iPad');
    const mine = (await phone('/api/devices/', { cookie: a })).body.devices as { name: string; current?: boolean }[];
    assert.deepEqual(mine.map((d) => [d.name, d.current]), [['iPhone', true], ['iPad', false]]);
    assert.ok((await local('/api/devices/')).body.devices.every((d: { current?: boolean }) => d.current === undefined));
  });
});

test('turning phone access off, or changing the address, removes every paired phone and the code on screen', async () => {
  const { r, local, phone, startPairing, pairPhone } = await signedIn(withHost);
  await using(r, async () => {
    const cookie = await pairPhone();
    await startPairing();
    assert.equal((await local('/api/remote/', { publicHost: null })).status, 200);
    assert.equal((await local('/api/remote/', { publicHost: HOST })).status, 200);
    assert.equal((await phone('/api/status/', { cookie })).status, 401, 'the same address again lets no old phone back in');
    assert.deepEqual((await local('/api/devices/')).body.devices, []);
    const again = await pairPhone();
    const { code } = await startPairing();
    await local('/api/remote/', { publicHost: 'other.tail1234.ts.net' });
    assert.deepEqual((await local('/api/devices/')).body.devices, []);
    await local('/api/remote/', { publicHost: HOST });
    assert.equal((await phone('/api/pair/', { body: { code } })).body.error, 'pairing_closed');
    assert.equal((await phone('/api/status/', { cookie: again })).status, 401);
    // Saving the same address leaves the phones alone.
    const kept = await pairPhone();
    await local('/api/remote/', { publicHost: HOST });
    assert.equal((await phone('/api/status/', { cookie: kept })).status, 200);
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statSync } from 'node:fs';
import { readToken, tokenPath } from '../../src/bin/token';
import { TOKEN, run } from './helpers';

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
const bearer = (t = TOKEN) => ({ authorization: `Bearer ${t}` });

test('binds to loopback unless the config says otherwise', async (t) => {
  const r = await run();
  try {
    const net = await import('node:net');
    const reach = (host: string) =>
      new Promise<boolean>((resolve) => {
        const s = net.connect({ host, port: r.port }, () => (s.destroy(), resolve(true)));
        s.on('error', () => resolve(false));
      });
    assert.equal(await reach('127.0.0.1'), true);
    const external = Object.values((await import('node:os')).networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) t.skip('this machine has no address other than loopback, so nothing outside it can be tried');
    else assert.equal(await reach(external.address), false);
  } finally {
    await r.stop();
  }
});

test('a request without the right token is refused with no detail', async () => {
  const r = await run();
  try {
    for (const headers of [{}, bearer('wrong'), { authorization: TOKEN }, { authorization: 'Bearer ' }]) {
      const res = await r.raw({ headers, body: initialize });
      assert.equal(res.status, 401);
      assert.equal(res.body, '');
    }
    assert.equal((await r.raw({ headers: bearer(), body: initialize })).status, 200);
  } finally {
    await r.stop();
  }
});

test('a rotated token takes effect at once, and an unusable token file refuses everything', async () => {
  const r = await run();
  try {
    assert.equal((await r.raw({ headers: bearer(), body: initialize })).status, 200);
    r.writeToken('a-new-token');
    assert.equal((await r.raw({ headers: bearer(), body: initialize })).status, 401);
    assert.equal((await r.raw({ headers: bearer('a-new-token'), body: initialize })).status, 200);
    r.writeToken('a-new-token', 0o644);
    assert.equal((await r.raw({ headers: bearer('a-new-token'), body: initialize })).status, 401);
    r.writeToken('');
    assert.equal((await r.raw({ headers: bearer(''), body: initialize })).status, 401);
  } finally {
    await r.stop();
  }
});

test('the Host header must be local or the configured public host', async () => {
  const r = await run({ config: { publicHost: 'pod.example.com' } });
  try {
    const hit = (host: string) => r.raw({ headers: { ...bearer(), host }, body: initialize }).then((x) => x.status);
    assert.equal(await hit('evil.example'), 403);
    assert.equal(await hit('localhost.evil.example'), 403);
    assert.equal(await hit('localhost:1234'), 200);
    assert.equal(await hit('127.0.0.1'), 200);
    assert.equal(await hit('[::1]:9'), 200);
    assert.equal(await hit('pod.example.com'), 200);
  } finally {
    await r.stop();
  }
});

test('a present Origin that is not allowed is refused', async () => {
  const r = await run({ config: { publicHost: 'pod.example.com' } });
  try {
    const hit = (origin?: string) => r.raw({ headers: { ...bearer(), ...(origin ? { origin } : {}) }, body: initialize }).then((x) => x.status);
    assert.equal(await hit(), 200);
    assert.equal(await hit('http://localhost:3000'), 200);
    assert.equal(await hit('http://127.0.0.1:5173'), 200);
    assert.equal(await hit('https://pod.example.com'), 200);
    assert.equal(await hit('https://evil.example'), 403);
    assert.equal(await hit('http://pod.example.com'), 403);
    assert.equal(await hit('null'), 403);
  } finally {
    await r.stop();
  }
});

test('the capability path is off by default and works when enabled', async () => {
  const off = await run();
  try {
    assert.equal((await off.raw({ path: `/mcp/${TOKEN}`, body: initialize })).status, 404);
  } finally {
    await off.stop();
  }
  const on = await run({ config: { capabilityUrl: true } });
  try {
    assert.equal((await on.raw({ path: `/mcp/${TOKEN}`, body: initialize })).status, 200);
    assert.equal((await on.raw({ path: `/mcp/${TOKEN}?x=1`, body: initialize })).status, 200);
    assert.equal((await on.raw({ path: '/mcp/not-it', body: initialize })).status, 401);
    assert.equal((await on.raw({ path: '/mcp', headers: bearer(), body: initialize })).status, 200);
    assert.equal((await on.raw({ path: '/other', headers: bearer(), body: initialize })).status, 404);
  } finally {
    await on.stop();
  }
});

test('the first start creates a token file only its owner can read', async () => {
  const r = await run({ token: null });
  try {
    const token = readToken(tokenPath(r.home));
    assert.ok(token.length >= 32);
    assert.equal(statSync(`${r.home}/data/plugins/mcp/token`).mode & 0o077, 0);
    assert.equal((await r.raw({ headers: bearer(token), body: initialize })).status, 200);
  } finally {
    await r.stop();
  }
});

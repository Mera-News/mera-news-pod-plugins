import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './helpers';

const PATHS: [string, string][] = [['POST', '/pair'], ['POST', '/snapshot'], ['POST', '/commands'], ['POST', '/profile/replace'], ['POST', '/v1/chat/completions'], ['POST', '/graphql'], ['GET', '/status'], ['POST', '/devices/revoke']];

test('a foreign Origin is refused on every route, even with a valid token', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    for (const [method, path] of PATHS) {
      for (const origin of ['https://evil.example', 'null', 'http://localhost.evil.example']) {
        const res = await r.raw({ path, method, headers: { origin, authorization: `Bearer ${a.token}` }, body: method === 'GET' ? undefined : '{}' });
        assert.equal(res.status, 403, `${method} ${path} ${origin}`);
      }
    }
  } finally {
    await r.stop();
  }
});

test('a loopback http Origin is allowed, a foreign Host is not', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    const auth = { authorization: `Bearer ${a.token}` };
    assert.equal((await r.raw({ path: '/status', method: 'GET', headers: { ...auth, origin: 'http://localhost:3000' } })).status, 200);
    assert.equal((await r.raw({ path: '/status', method: 'GET', headers: { ...auth, host: 'evil.example' } })).status, 403);
  } finally {
    await r.stop();
  }
});

test('with publicHost set, exactly https://<publicHost> is an allowed Origin and its Host is accepted', async () => {
  const r = await run({ config: { publicHost: 'pod.example.com' } });
  try {
    const a = await r.pair('A');
    const auth = { authorization: `Bearer ${a.token}`, host: 'pod.example.com' };
    assert.equal((await r.raw({ path: '/status', method: 'GET', headers: { ...auth, origin: 'https://pod.example.com' } })).status, 200);
    assert.equal((await r.raw({ path: '/status', method: 'GET', headers: { ...auth, origin: 'http://pod.example.com' } })).status, 403);
    assert.equal((await r.raw({ path: '/status', method: 'GET', headers: { ...auth, origin: 'https://pod.example.com.evil.example' } })).status, 403);
  } finally {
    await r.stop();
  }
});

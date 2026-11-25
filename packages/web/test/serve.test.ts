import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { before, test } from 'node:test';
import { run, SITE } from './helpers';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : [path.join(dir, f)]));

before(() => assert.ok(existsSync(path.join(SITE, 'index.html')), 'build the site first: npm run build'));

test('every page is served with a policy that allows exactly its own inline scripts', async () => {
  const r = await run();
  try {
    for (const p of ['/', '/world/', '/world', '/you/']) {
      const res = await r.request({ path: p });
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      const policy = Object.fromEntries(String(res.headers['content-security-policy']).split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));
      const inline = [...res.body.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
      assert.ok(inline.length > 0, 'the export has inline scripts');
      assert.deepEqual(policy['script-src'], ["'self'", ...inline], p);
      assert.deepEqual(policy['img-src'], ["'self'", 'https:'], 'publishers\' images over https, nothing else from outside');
      assert.deepEqual(policy['connect-src'], ["'self'"]);
      assert.deepEqual(policy['default-src'], ["'none'"]);
      assert.deepEqual(policy['frame-ancestors'], ["'none'"]);
    }
    assert.equal((await r.request({ path: '/world' })).body, (await r.request({ path: '/world/' })).body);
    const head = await r.request({ path: '/', method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
  } finally {
    await r.stop();
  }
});

test('static files carry their type, and only the hashed build files are cached for good', async () => {
  const r = await run();
  try {
    const all = files(SITE).map((f) => `/${path.relative(SITE, f)}`);
    const js = all.find((f) => f.startsWith('/_next/static/') && f.endsWith('.js'))!;
    const css = all.find((f) => f.endsWith('.css'))!;
    const res = await r.request({ path: js });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await r.request({ path: css })).headers['content-type'], 'text/css; charset=utf-8');
    const mark = await r.request({ path: '/mark.png' });
    assert.equal(mark.headers['content-type'], 'image/png');
    assert.equal(mark.headers['cache-control'], 'no-cache');
    const txt = all.find((f) => f.endsWith('.txt'))!;
    assert.equal((await r.request({ path: txt })).headers['content-type'], 'text/plain; charset=utf-8');
    const missing = await r.request({ path: '/no-such-page/' });
    assert.equal(missing.status, 404);
    assert.match(missing.body, /This page does not exist/);
    assert.match(String(missing.headers['content-security-policy']), /script-src 'self' 'sha256-/);
  } finally {
    await r.stop();
  }
});

test('the site can be added to a home screen: every page links the manifest, and every icon it names is served', async () => {
  const r = await run();
  try {
    const page = await r.request({ path: '/' });
    assert.match(page.body, /<link rel="manifest" href="\/manifest.webmanifest"/);
    assert.match(page.body, /<link rel="apple-touch-icon" href="\/apple-touch-icon.png"/);
    const res = await r.request({ path: '/manifest.webmanifest' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/manifest+json');
    const m = JSON.parse(res.body) as { name: string; start_url: string; display: string; icons: { src: string; sizes: string }[] };
    assert.equal(m.name, 'Mera News');
    assert.equal(m.start_url, '/');
    assert.equal(m.display, 'standalone');
    assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'));
    for (const src of [...m.icons.map((i) => i.src), '/apple-touch-icon.png']) {
      const icon = await r.request({ path: src });
      assert.equal(icon.status, 200, src);
      assert.equal(icon.headers['content-type'], 'image/png', src);
    }
  } finally {
    await r.stop();
  }
});

test('the export asks no other host for anything, and no file is over 5 MiB', () => {
  for (const f of files(SITE)) {
    assert.ok(statSync(f).size < 5 * 1024 * 1024, f);
    if (!/\.(html|css)$/.test(f)) continue;
    const text = readFileSync(f, 'utf8');
    // React's and Next's error texts name their sites inside scripts; what loads is src, href and url().
    for (const m of text.matchAll(/(?:\ssrc=|\shref=|url\()["']?([^"')\s>]+)/g)) assert.doesNotMatch(m[1], /^(https?:)?\/\//, `${f} loads ${m[1]}`);
  }
});

test('requests for another host, port or origin are refused', async () => {
  const r = await run();
  try {
    const other = String(r.port() + 1);
    for (const host of ['evil.example', `evil.example:${r.port()}`, `127.0.0.1:${other}`, `localhost:${other}`, `127.0.0.1:${r.port()}.evil.example`]) {
      assert.equal((await r.request({ headers: { host } })).status, 403, `Host ${host}`);
    }
    // Node itself answers 400 to a request with no Host.
    assert.equal((await r.request({ headers: { host: undefined } })).status, 400);
    assert.equal((await r.request({ headers: { host: `localhost:${r.port()}` } })).status, 200);
    for (const origin of ['http://evil.example', `http://127.0.0.1:${other}`, `http://localhost:${other}`, 'null', `https://127.0.0.1:${r.port()}`]) {
      assert.equal((await r.request({ headers: { origin } })).status, 403, `GET from ${origin}`);
      const post = await r.request({ path: '/api/session/', method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
      assert.equal(post.status, 403, `POST from ${origin}`);
    }
    assert.equal((await r.request({ headers: { origin: r.origin() } })).status, 200);
    // A browser always sends Origin on a POST: one without it did not come from this page.
    assert.equal((await r.request({ path: '/api/session/', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  } finally {
    await r.stop();
  }
});

test('only GET, HEAD and POST are answered, and nothing ever opens the site to another origin', async () => {
  const r = await run();
  try {
    const seen: Record<string, unknown>[] = [];
    for (const method of ['OPTIONS', 'PUT', 'DELETE', 'PATCH']) {
      for (const p of ['/', '/api/session/', '/api/status/']) {
        const res = await r.request({ path: p, method, headers: { origin: r.origin(), 'access-control-request-method': 'POST' } });
        assert.equal(res.status, 405, `${method} ${p}`);
        seen.push(res.headers);
      }
    }
    seen.push((await r.request({ path: '/', method: 'POST', headers: { origin: r.origin(), 'content-type': 'application/json' }, body: '{}' })).headers);
    seen.push((await r.request({ path: '/api/session/' })).headers);
    assert.equal((await r.request({ path: '/', method: 'POST', headers: { origin: r.origin(), 'content-type': 'application/json' }, body: '{}' })).status, 405);
    assert.equal((await r.request({ path: '/api/session/' })).status, 405, 'GET on the write route');
    assert.equal((await r.request({ path: '/api/status/', method: 'POST', headers: { origin: r.origin(), 'content-type': 'application/json' }, body: '{}' })).status, 405);
    for (const h of seen) assert.deepEqual(Object.keys(h).filter((k) => k.startsWith('access-control-')), []);
  } finally {
    await r.stop();
  }
});

test('a POST must be JSON and small', async () => {
  const r = await run();
  try {
    const post = (type: string | undefined, body: string | Buffer) =>
      r.request({ path: '/api/session/', method: 'POST', headers: { origin: r.origin(), 'content-type': type }, body });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
      assert.equal((await post(type, '{"code":"x"}')).status, 415, String(type));
    }
    assert.equal((await post('application/json', Buffer.alloc(64 * 1024 + 1, 'a'))).status, 413);
    assert.equal((await post('application/json; charset=utf-8', '{"code":"x"}')).status, 401);
    assert.equal((await post('application/json', 'not json')).status, 400);
  } finally {
    await r.stop();
  }
});

test('the API needs a session', async () => {
  const r = await run();
  try {
    for (const authorization of [undefined, 'Bearer nope', 'Bearer ', 'Basic abc', `Bearer ${'a'.repeat(43)}`]) {
      const res = await r.request({ path: '/api/status/', headers: { authorization } });
      assert.equal(res.status, 401, String(authorization));
      assert.equal(res.body, '');
    }
    assert.equal((await r.request({ path: '/api/nothing/' })).status, 404);
  } finally {
    await r.stop();
  }
});

test('no request path reaches a file outside the export', async () => {
  const r = await run();
  try {
    const paths = ['/../package.json', '/%2e%2e/package.json', '/%2E%2E%2Fpackage.json', '/..%2fpackage.json', '/..\\package.json', '/%5c..%5cpackage.json', '/index.html%00', '/%00', '/_next/../../package.json', '//etc/passwd', '/./index.html/..'];
    for (const p of paths) {
      const res = await r.request({ path: p });
      assert.equal(res.status, 404, p);
      assert.doesNotMatch(res.body, /mera-news-pod-web|root:/, p);
    }
  } finally {
    await r.stop();
  }
});

test('a busy port leaves the site running on another, and the address file says which', async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const taken = (blocker.address() as net.AddressInfo).port;
  const r = await run({ config: { port: taken } });
  try {
    assert.notEqual(r.port(), taken);
    assert.deepEqual(JSON.parse(readFileSync(path.join(r.dataDir, 'address.json'), 'utf8')), { port: r.port(), pid: process.pid });
    assert.equal((await r.request({})).status, 200);
    assert.ok(r.logs.some((l) => l.includes(`Port ${taken} is in use`)));
  } finally {
    await r.stop();
    blocker.close();
  }
});

test('when the link key cannot be written, start still succeeds and every route answers 503', async () => {
  const { mkdirSync } = await import('node:fs');
  // A folder where the key goes: the key cannot be written there.
  const r = await run({ before: (dir) => mkdirSync(path.join(dir, 'link-key', 'x'), { recursive: true }) });
  try {
    for (const p of ['/', '/api/status/']) assert.equal((await r.request({ path: p })).status, 503, p);
    assert.equal((await r.session('x')).status, 503);
    assert.ok(r.logs.some((l) => l.includes('link key could not be written')));
  } finally {
    await r.stop();
  }
});

test('a bad port in the config falls back to the default instead of stopping the pod', async () => {
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => blocker.once('error', reject).listen(8790, '127.0.0.1', resolve)).catch(() => {});
  const r = await run({ config: { port: 'eighty' } });
  try {
    assert.ok(r.logs.some((l) => l.includes('"port" is not a whole number')));
    assert.equal((await r.request({})).status, 200);
  } finally {
    await r.stop();
    blocker.close();
  }
});

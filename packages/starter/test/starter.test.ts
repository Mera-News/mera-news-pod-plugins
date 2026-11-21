import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import type { PluginContext, PodPlugin, PodServices } from 'mera-news-pod/plugin-api';
import * as starter from '../src';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const pick = { id: 'p1', title: 'Tram line approved', publication: 'Utrecht Daily', url: 'https://example.org/a', publishedAt: '2026-01-01T00:00:00Z', level: 'low', lang: 'en', reason: 'r', facts: [] };

class PodErrorLike extends Error {
  constructor(readonly code: string, message: string, readonly next: string) {
    super(message);
  }
}

function setup(config: unknown = { port: 0 }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'starter-'));
  const dataDir = path.join(dir, 'plugins', 'starter');
  const calls: { since?: string; limit: number; peek?: boolean }[] = [];
  const services = {
    suggestions: {
      get: async (o: { since?: string; limit: number; peek?: boolean }) => {
        calls.push(o);
        if (o.since === 'bogus') throw new PodErrorLike('unknown_cursor', 'That cursor was not issued by this pod.', 'call without since');
        return { state: 'ok', hint: 'h', nextReadAt: null, picks: [pick], cursor: 'c', more: false };
      },
    },
    profile: { get: async (o?: { offset?: number }) => ({ facts: [], offset: o?.offset }) },
    reading: { status: async () => ({ reading: 'on' }) },
  } as unknown as PodServices;
  const logs: string[] = [];
  const log = { debug() {}, info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) };
  const ctx = { podApi: 2, services, config, dataDir, log, estimateTokens: (t: string) => t.length, meraNewsApp: null } as unknown as PluginContext;
  return { dir, dataDir, calls, ctx, logs, tokenFile: path.join(dataDir, 'token') };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(config?: unknown) {
  const s = setup(config);
  cleanups.push(() => rmSync(s.dir, { recursive: true, force: true }));
  const plugin = await starter.createPlugin(s.ctx);
  await plugin.start();
  cleanups.push(() => plugin.stop());
  const port = Number(/127\.0\.0\.1:(\d+)\//.exec(plugin.describe!()[0])![1]);
  const token = readFileSync(s.tokenFile, 'utf8').trim();
  return { ...s, plugin, port, token };
}

const send = (port: number, method: string, url: string, headers: Record<string, string> = {}) =>
  new Promise<Reply>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.once('error', reject);
    req.end();
  });
const authed = (token: string) => ({ authorization: `Bearer ${token}` });

describe('the starter plugin', () => {
  it('is a plugin module for the second contract', () => {
    assert.equal(starter.podApi, 2);
    assert.equal(starter.name, 'starter');
  });

  it('picks: every read passes peek, so it never takes picks from another caller', async () => {
    const t = await boot();
    const a = await send(t.port, 'GET', '/picks', authed(t.token));
    const b = await send(t.port, 'GET', '/picks?since=c1&limit=5', authed(t.token));
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(JSON.parse(a.body).picks[0].id, 'p1');
    assert.equal(t.calls.length, 2);
    assert.ok(t.calls.every((c) => c.peek === true));
    assert.deepEqual(t.calls.map((c) => c.since), ['all', 'c1']);
    assert.deepEqual(t.calls.map((c) => c.limit), [20, 5]);
  });

  it('profile and status: answer the services as JSON', async () => {
    const t = await boot();
    assert.deepEqual(JSON.parse((await send(t.port, 'GET', '/profile?offset=3', authed(t.token))).body), { facts: [], offset: 3 });
    assert.deepEqual(JSON.parse((await send(t.port, 'GET', '/status', authed(t.token))).body), { reading: 'on' });
    assert.equal((await send(t.port, 'GET', '/nope', authed(t.token))).status, 404);
  });

  it('token: no token, a wrong token, or a token in the query answer 401 with an empty body', async () => {
    const t = await boot();
    for (const r of [
      await send(t.port, 'GET', '/picks'),
      await send(t.port, 'GET', '/picks', authed('wrong')),
      await send(t.port, 'GET', `/picks?token=${t.token}`),
    ]) {
      assert.equal(r.status, 401);
      assert.equal(r.body, '');
    }
    assert.equal(t.calls.length, 0);
  });

  it('token: the file is made 0600 at start, and a replaced file takes effect without a restart', async () => {
    const t = await boot();
    assert.equal(statSync(t.tokenFile).mode & 0o777, 0o600);
    assert.equal(statSync(t.dataDir).mode & 0o777, 0o700);
    assert.equal((await send(t.port, 'GET', '/status', authed(t.token))).status, 200);
    writeFileSync(t.tokenFile, 'replaced-token\n', { mode: 0o600 });
    assert.equal((await send(t.port, 'GET', '/status', authed(t.token))).status, 401);
    assert.equal((await send(t.port, 'GET', '/status', authed('replaced-token'))).status, 200);
  });

  it('token: a token file others can read stops the start with a plain sentence', async () => {
    const s = setup();
    cleanups.push(() => rmSync(s.dir, { recursive: true, force: true }));
    const first = await starter.createPlugin(s.ctx);
    await first.start();
    await first.stop();
    chmodSync(s.tokenFile, 0o644);
    const second = await starter.createPlugin(s.ctx);
    cleanups.push(() => second.stop()); // a start that wrongly succeeds must not leave a server running
    await assert.rejects(second.start(), /can be read by other users/);
  });

  it('host: a foreign Host or Origin answers 403', async () => {
    const t = await boot();
    const h = authed(t.token);
    assert.equal((await send(t.port, 'GET', '/', { host: 'evil.example' })).status, 403);
    assert.equal((await send(t.port, 'GET', '/', { host: '127.0.0.1:1' })).status, 403);
    assert.equal((await send(t.port, 'GET', '/status', { ...h, origin: 'http://evil.example' })).status, 403);
    assert.equal((await send(t.port, 'GET', '/status', { ...h, origin: `http://localhost:${t.port}` })).status, 200);
    assert.equal((await send(t.port, 'GET', '/status', { ...h, host: `localhost:${t.port}` })).status, 200);
  });

  it('method: POST answers 405', async () => {
    const t = await boot();
    assert.equal((await send(t.port, 'POST', '/picks', authed(t.token))).status, 405);
  });

  it('limit: 0, 51 and "x" answer 400 bad_limit; an unknown cursor answers 400 with the pod code', async () => {
    const t = await boot();
    for (const l of ['0', '51', 'x']) {
      const r = await send(t.port, 'GET', `/picks?limit=${l}`, authed(t.token));
      assert.equal(r.status, 400);
      assert.deepEqual(JSON.parse(r.body), { error: 'bad_limit' });
    }
    const r = await send(t.port, 'GET', '/picks?since=bogus', authed(t.token));
    assert.equal(r.status, 400);
    assert.equal(JSON.parse(r.body).error, 'unknown_cursor');
    assert.equal(JSON.parse(r.body).next, 'call without since');
  });

  it('page: served without a token, with the content security policy, and holds no absolute URL', async () => {
    const t = await boot();
    const r = await send(t.port, 'GET', '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(String(r.headers['content-security-policy']), /^default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cache-control'], 'no-store');
    // The only absolute URLs the page may name are the two schemes its link check looks for.
    assert.deepEqual(r.body.match(/https?:\/\/\S*/g)?.map((m) => m.slice(0, 8)) ?? [], []);
    for (const word of ['innerHTML', 'localStorage', 'sessionStorage', 'document.cookie']) assert.ok(!r.body.includes(word), word);
    assert.ok(r.body.includes("These articles belong to their publishers. Read them on the publisher's site, and subscribe to the ones you value."), 'the publishers line');
  });

  it('describe: names the token file and never prints the token', async () => {
    const t = await boot();
    const lines = t.plugin.describe!();
    assert.equal(lines.length, 2);
    assert.match(lines[0], new RegExp(`^Starter page: http://127\\.0\\.0\\.1:${t.port}/#`));
    assert.equal(lines[1], `Token file: ${t.tokenFile}`);
    assert.ok(!lines.join('\n').includes(t.token));
    assert.ok(!t.logs.join('\n').includes(t.token));
  });

  it('config: a port that is not a whole number from 0 to 65535 is refused', async () => {
    const s = setup({ port: 70000 });
    cleanups.push(() => rmSync(s.dir, { recursive: true, force: true }));
    await assert.rejects(Promise.resolve().then(() => starter.createPlugin(s.ctx)), /port/);
  });

  it('listen: only on 127.0.0.1, never on another address of this machine', async (t) => {
    const other = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (!other) return t.skip('this machine has no other IPv4 address');
    const b = await boot();
    const reached = await new Promise<boolean>((resolve) => {
      const socket = net.connect(b.port, other.address, () => (socket.destroy(), resolve(true)));
      socket.once('error', () => resolve(false));
      socket.setTimeout(2000, () => (socket.destroy(), resolve(false)));
    });
    assert.equal(reached, false);
  });

  it('stop: the port is free after stop', async () => {
    const t = await boot();
    await t.plugin.stop();
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer();
      s.once('error', reject);
      s.listen(t.port, '127.0.0.1', () => s.close(() => resolve()));
    });
  });
});

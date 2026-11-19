import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { listDevices, removeDevice } from '../src/store';
import { fakeServices, REGISTRY, run, SCHEMA, status } from './helpers';

const ROUTES: [string, string][] = [
  ['POST', '/snapshot'],
  ['POST', '/commands'],
  ['POST', '/v1/chat/completions'],
  ['POST', '/graphql'],
  ['GET', '/status'],
  ['POST', '/devices/revoke'],
  ['POST', '/reading'],
  ['GET', '/nothing-here'],
];
const peer = { schemaVersion: SCHEMA, registry: REGISTRY };

test('every route but /pair answers 401 with no body and no data without a valid token', async () => {
  const r = await run();
  try {
    const gone = await r.pair('B');
    assert.equal((await r.call(gone.token, '/devices/revoke')).status, 200);
    const good = await r.pair('A');
    for (const [method, path] of ROUTES) {
      for (const authorization of [undefined, 'Bearer wrong', good.token, 'Bearer ', `Bearer ${gone.token}`]) {
        const res = await r.raw({ path, method, headers: authorization ? { authorization } : {}, body: method === 'GET' ? undefined : '{}' });
        assert.equal(res.status, 401, `${method} ${path} with ${authorization}`);
        assert.equal(res.body, '');
      }
    }
    assert.deepEqual([r.calls.snapshot, r.calls.commands, r.calls.chat, r.calls.graphql].map((c) => c.length), [0, 0, 0, 0]);
  } finally {
    await r.stop();
  }
});

test('a revoked device gets 401 on its next request', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    assert.equal((await r.call(a.token, '/status', undefined, 'GET')).status, 200);
    assert.equal((await r.call(a.token, '/devices/revoke')).status, 200);
    assert.equal((await r.call(a.token, '/status', undefined, 'GET')).status, 401);
  } finally {
    await r.stop();
  }
});

test('/status shows the pod status, name and versions to a paired device', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    const body = JSON.parse((await r.call(a.token, '/status', undefined, 'GET')).body);
    assert.deepEqual(body, { ...status(), podName: 'Test pod', schemaVersion: SCHEMA, registry: REGISTRY, appNotifications: 'off', relayOrigin: null });
    assert.equal(r.calls.snapshot.length, 0, 'the versions come without reading any table');
  } finally {
    await r.stop();
  }
});

test('/snapshot with matching hashes returns no rows for those tables', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    const full = JSON.parse((await r.call(a.token, '/snapshot', { ...peer, hashes: {} })).body);
    assert.equal(full.schemaVersion, SCHEMA);
    assert.deepEqual(full.tables.facts.rows, [{ id: 'f1' }]);
    const part = JSON.parse((await r.call(a.token, '/snapshot', { ...peer, hashes: { facts: full.tables.facts.hash } })).body);
    assert.equal(part.tables.facts.rows, undefined);
    assert.ok(part.tables.topics.rows);
    assert.deepEqual(r.calls.snapshot[1], { hashes: { facts: 'h-facts' }, peer });
  } finally {
    await r.stop();
  }
});

test('a different version is refused on /snapshot and /commands and says which side is older', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    for (const [path, body] of [['/snapshot', { schemaVersion: SCHEMA, registry: 1, hashes: {} }], ['/commands', { schemaVersion: SCHEMA, registry: 1, commands: [{ name: 'x' }] }]] as const) {
      const res = await r.call(a.token, path, body);
      assert.equal(res.status, 409, path);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.error, 'version_mismatch');
      assert.match(parsed.message, /phone is older/);
    }
  } finally {
    await r.stop();
  }
});

test('/commands passes the batch through and answers one result per command and the snapshot', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    const commands = [{ name: 'one', args: [1] }, { name: 'two' }];
    const res = await r.call(a.token, '/commands', { ...peer, hashes: { facts: 'h-facts' }, commands });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(body.results, [{ ok: 'one' }, { ok: 'two' }]);
    assert.equal(body.snapshot.tables.facts.rows, undefined);
    assert.deepEqual(r.calls.commands[0], { ...peer, hashes: { facts: 'h-facts' }, commands });
  } finally {
    await r.stop();
  }
});

test('nothing in a request body is logged, even when a service fails on it', async () => {
  const { services, calls } = fakeServices();
  services.commands.run = async (req) => {
    throw new Error(`failed on ${JSON.stringify(req)}`);
  };
  const r = await run({ services, calls });
  try {
    const a = await r.pair('A');
    const res = await r.call(a.token, '/commands', { ...peer, commands: [{ name: 'x', args: ['SECRET-MARKER-123'] }] });
    assert.equal(res.status, 500);
    assert.ok(!res.body.includes('SECRET-MARKER-123'));
    await r.call(a.token, '/graphql', { query: 'SECRET-MARKER-123' });
    assert.ok(!r.logs.join('\n').includes('SECRET-MARKER-123'));
  } finally {
    await r.stop();
  }
});

test('/graphql forwards the body to the news service and returns its answer', async () => {
  const { services, calls } = fakeServices();
  services.news.graphql = async (b) => {
    calls.graphql.push(b);
    return { errors: [{ message: 'no', extensions: { code: 'NOT_ALLOWED' } }] };
  };
  const r = await run({ services, calls });
  try {
    const a = await r.pair('A');
    const res = await r.call(a.token, '/graphql', { query: '{ me }' });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).errors[0].extensions.code, 'NOT_ALLOWED');
    assert.deepEqual(calls.graphql, [{ query: '{ me }' }]);
  } finally {
    await r.stop();
  }
});

test('chat streams: the first chunk arrives before the upstream ends, and an abort ends the upstream call', async () => {
  const { services, calls } = fakeServices();
  let upstreamSignal: AbortSignal | undefined;
  services.model.chatCompletions = async (body, signal) => {
    calls.chat.push({ body, signal, extra: 0 });
    upstreamSignal = signal;
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(enc.encode('data: first\n\n'));
          signal?.addEventListener('abort', () => c.error(new Error('aborted')));
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
  const r = await run({ services, calls });
  try {
    const a = await r.pair('A');
    const req = http.request({ host: '127.0.0.1', port: r.port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', 'x-phone-header': 'nope' } });
    const first = new Promise<string>((resolve, reject) => {
      req.on('response', (res) => res.once('data', (d) => resolve(String(d))));
      req.on('error', reject);
    });
    req.end(JSON.stringify({ model: 'm', stream: true, messages: [] }));
    assert.equal(await first, 'data: first\n\n');
    assert.ok(upstreamSignal && !upstreamSignal.aborted);
    req.destroy();
    for (let i = 0; i < 50 && !upstreamSignal.aborted; i++) await new Promise((res) => setTimeout(res, 20));
    assert.equal(upstreamSignal.aborted, true);
    // the service is given the body and the signal only, so no header of the phone goes upstream
    assert.deepEqual(calls.chat[0].body, { model: 'm', stream: true, messages: [] });
  } finally {
    await r.stop();
  }
});

test('a paused pod still serves the snapshot, commands and chat, and this plugin never starts a read', async () => {
  const { services, calls } = fakeServices();
  services.reading.status = async () => status({ reading: 'paused' });
  const r = await run({ services, calls });
  try {
    const a = await r.pair('A');
    assert.equal((await r.call(a.token, '/snapshot', { ...peer, hashes: {} })).status, 200);
    assert.equal((await r.call(a.token, '/commands', { ...peer, commands: [{ name: 'x' }] })).status, 200);
    assert.equal((await r.call(a.token, '/v1/chat/completions', { model: 'm' })).status, 200);
    assert.equal(JSON.parse((await r.call(a.token, '/status', undefined, 'GET')).body).reading, 'paused');
    assert.equal(calls.readNow, 0);
  } finally {
    await r.stop();
  }
});

test('oversize bodies answer 413', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    const big = (n: number) => JSON.stringify({ pad: 'x'.repeat(n) });
    assert.equal((await r.call(a.token, '/commands', JSON.parse(big(2 * 1024 * 1024 + 10)))).status, 413);
    assert.equal(r.calls.commands.length, 0);
  } finally {
    await r.stop();
  }
});

test('a body that is not JSON answers 400', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    const res = await r.raw({ path: '/graphql', headers: { authorization: `Bearer ${a.token}` }, body: '{nope' });
    assert.equal(res.status, 400);
  } finally {
    await r.stop();
  }
});

test('a device revoked from the command line while the pod runs is refused at once, and a later request cannot bring it back', async () => {
  const r = await run();
  try {
    const a = await r.pair('A');
    assert.equal((await r.call(a.token, '/status', undefined, 'GET')).status, 200);
    // What `mera-news-pod-sync devices --revoke` does, on the same files, while the plugin runs.
    assert.equal(removeDevice(r.dataDir, a.deviceId), true);
    assert.equal((await r.call(a.token, '/status', undefined, 'GET')).status, 401);
    // The next phone's request records when it was seen; that must not write A back.
    const b = await r.pair('B');
    assert.equal((await r.call(b.token, '/status', undefined, 'GET')).status, 200);
    assert.deepEqual(listDevices(r.dataDir).map((d) => d.id), [b.deviceId]);
    assert.equal((await r.call(a.token, '/status', undefined, 'GET')).status, 401);
  } finally {
    await r.stop();
  }
});

test('an error from the AI service goes back as its status only, never its body, which can echo the key', async () => {
  const { services } = fakeServices({
    model: { chatCompletions: async () => new Response(JSON.stringify({ error: { message: 'bad key sk-pod-secret-123' } }), { status: 401, headers: { 'content-type': 'application/json' } }) },
  });
  const r = await run({ services });
  try {
    const a = await r.pair('A');
    const reply = await r.call(a.token, '/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(reply.status, 401);
    assert.doesNotMatch(reply.body, /sk-pod-secret/);
    assert.deepEqual(JSON.parse(reply.body), { error: 'upstream_error' });
  } finally {
    await r.stop();
  }
});

test('no log line carries a pairing code or a device token', async () => {
  const r = await run();
  try {
    const code = r.newCode();
    const wrong = await r.raw({ path: '/pair', body: JSON.stringify({ code: `${code.slice(0, 9)}${code[9] === 'X' ? 'Y' : 'X'}`, deviceName: 'A' }) });
    assert.equal(wrong.status, 403);
    const a = await r.pair('A');
    await r.call(a.token, '/status', undefined, 'GET');
    await r.call(`${a.token}x`, '/status', undefined, 'GET');
    await r.call(a.token, '/devices/revoke');
    const joined = r.logs.join('\n');
    assert.ok(r.logs.length > 0, 'something was logged');
    assert.doesNotMatch(joined, new RegExp(code));
    assert.ok(!joined.includes(a.token), 'the token is not in the log');
  } finally {
    await r.stop();
  }
});

test('/reading pauses or resumes reading on the pod and answers the status', async () => {
  const { services, calls } = fakeServices();
  const r = await run({ services, calls });
  try {
    const a = await r.pair('A');
    const paused = await r.call(a.token, '/reading', { paused: true });
    assert.equal(paused.status, 200);
    assert.equal(JSON.parse(paused.body).reading, 'paused');
    assert.deepEqual(calls.reading, [{ paused: true }]);
    assert.equal((await r.call(a.token, '/reading', { paused: 'yes' })).status, 400);
    assert.equal((await r.call(a.token, '/reading', { everyMinutes: 5 })).status, 400, 'only the pause is set from a phone');
    assert.deepEqual(calls.reading, [{ paused: true }]);
  } finally {
    await r.stop();
  }
});

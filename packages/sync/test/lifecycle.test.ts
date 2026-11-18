import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { run } from './helpers';

const reach = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => (s.destroy(), resolve(true)));
    s.on('error', () => resolve(false));
  });
const servers = () => process.getActiveResourcesInfo().filter((n) => n === 'TCPServerWrap').length;

test('stop closes the listener, leaves no event listener and no server handle', async () => {
  const before = servers();
  const r = await run();
  assert.equal(await reach(r.port), true);
  await r.pair('A');
  await r.stop();
  assert.equal(await reach(r.port), false);
  assert.equal(r.calls.listeners, 0);
  assert.equal(servers(), before);
});

test('it binds to loopback by default', async () => {
  const r = await run();
  try {
    const external = Object.values((await import('node:os')).networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!external) return;
    const open = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: external.address, port: r.port }, () => (s.destroy(), resolve(true)));
      s.on('error', () => resolve(false));
    });
    assert.equal(open, false);
  } finally {
    await r.stop();
  }
});

test('no secret appears in any log line', async () => {
  const r = await run();
  try {
    const code = r.newCode();
    const res = await r.raw({ path: '/pair', body: JSON.stringify({ code, deviceName: 'P' }) });
    const { token } = JSON.parse(res.body);
    await r.call(token, '/status', undefined, 'GET');
    await r.raw({ path: '/pair', body: JSON.stringify({ code: 'ZZZZZZZZZZ', deviceName: 'P' }) });
    const all = r.logs.join('\n');
    assert.ok(!all.includes(token));
    assert.ok(!all.includes(code));
  } finally {
    await r.stop();
  }
});

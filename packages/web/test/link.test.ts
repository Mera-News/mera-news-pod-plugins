import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import { MAX_SESSIONS, SESSION_IDLE_MS } from '../src';
import { LINK_TTL_MS, mintCode, siteLink } from '../src/link';
import { run, STATUS } from './helpers';

const codeOf = (url: string) => /#c=(.+)$/.exec(url)![1];
const key = (dataDir: string) => readFileSync(path.join(dataDir, 'link-key'), 'utf8').trim();

test('a link opens one session, which reads the status; the code then works no more', async () => {
  const r = await run();
  try {
    const url = siteLink(r.dataDir);
    assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:${r.port()}/#c=v1\\.`));
    const res = await r.session(codeOf(url));
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const { session } = JSON.parse(res.body);
    const status = await r.request({ path: '/api/status/', headers: { authorization: `Bearer ${session}` } });
    assert.equal(status.status, 200);
    assert.deepEqual(JSON.parse(status.body), STATUS);
    assert.equal((await r.session(codeOf(url))).status, 401, 'a code works once');
    for (const f of ['link-key', 'address.json']) {
      const stat = lstatSync(path.join(r.dataDir, f));
      assert.ok(stat.isFile() && (stat.mode & 0o077) === 0, `${f} is a plain file only its owner reads`);
    }
  } finally {
    await r.stop();
  }
  assert.ok(!existsSync(path.join(r.dataDir, 'address.json')), 'a stopped site has no address');
  assert.throws(() => siteLink(r.dataDir), /not running/);
});

test('expired, foreign, malformed and pre-restart codes are refused, and a restart ends every session', async () => {
  const r = await run();
  try {
    assert.equal((await r.session(mintCode(key(r.dataDir), Date.now() - LINK_TTL_MS - 1))).status, 401, 'expired');
    assert.equal((await r.session(mintCode('another key'))).status, 401, 'signed with another key');
    const good = mintCode(key(r.dataDir));
    const forged = `${good.slice(0, 3)}9${good.slice(4)}`;
    for (const bad of [forged, 'v1.x', '', 'v2' + good.slice(2), good + 'x', 42, null, { code: good }]) {
      assert.equal((await r.session(bad as string)).status, 401, JSON.stringify(bad));
    }
    const before = mintCode(key(r.dataDir));
    const { session } = JSON.parse((await r.session(mintCode(key(r.dataDir)))).body);
    await r.plugin.stop();
    await r.plugin.start();
    assert.equal((await r.session(before)).status, 401, 'a code from before the restart');
    assert.equal((await r.request({ path: '/api/status/', headers: { authorization: `Bearer ${session}` } })).status, 401, 'a session from before the restart');
    assert.equal((await r.session(codeOf(siteLink(r.dataDir)))).status, 200);
  } finally {
    await r.stop();
  }
});

test(`at most ${MAX_SESSIONS} sessions: one more ends the least recently used`, async () => {
  const r = await run();
  try {
    const open = async () => JSON.parse((await r.session(codeOf(siteLink(r.dataDir)))).body).session as string;
    const status = (s: string) => r.request({ path: '/api/status/', headers: { authorization: `Bearer ${s}` } }).then((x) => x.status);
    const sessions: string[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) sessions.push(await open());
    assert.equal(await status(sessions[0]), 200); // now the most recently used
    sessions.push(await open());
    assert.equal(await status(sessions[1]), 401, 'the least recently used went');
    assert.equal(await status(sessions[0]), 200);
    assert.equal(await status(sessions[MAX_SESSIONS]), 200);
  } finally {
    await r.stop();
  }
});

test('a session left unused ends', async () => {
  const r = await run();
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const { session } = JSON.parse((await r.session(codeOf(siteLink(r.dataDir)))).body);
    const status = () => r.request({ path: '/api/status/', headers: { authorization: `Bearer ${session}` } }).then((x) => x.status);
    mock.timers.tick(SESSION_IDLE_MS - 1000);
    assert.equal(await status(), 200, 'use keeps it alive');
    mock.timers.tick(SESSION_IDLE_MS + 1);
    assert.equal(await status(), 401);
  } finally {
    mock.timers.reset();
    await r.stop();
  }
});

test('nothing secret or typed reaches the log', async () => {
  let fail = false;
  const r = await run({
    status: async () => {
      if (fail) throw new Error('a failure that quotes Lives in Utrecht');
      return STATUS;
    },
  });
  const said: string[] = [];
  try {
    const url = siteLink(r.dataDir);
    said.push(codeOf(url), key(r.dataDir));
    const { session } = JSON.parse((await r.session(codeOf(url))).body);
    said.push(session);
    await r.session(codeOf(url));
    await r.request({ path: '/api/session/', method: 'POST', headers: { origin: r.origin(), 'content-type': 'application/json' }, body: '{"code":"Lives in Utrecht"}' });
    fail = true;
    assert.equal((await r.request({ path: '/api/status/', headers: { authorization: `Bearer ${session}` } })).status, 500);
    assert.ok(r.logs.some((l) => l === 'A website request failed.'));
  } finally {
    await r.stop();
  }
  for (const line of r.logs) for (const secret of [...said, 'Utrecht']) assert.ok(!line.includes(secret), line);
});

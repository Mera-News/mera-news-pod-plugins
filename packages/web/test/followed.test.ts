import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FollowedArticle, FollowedStoryView, PodServices } from 'mera-news-pod/plugin-api';
import { siteLink } from '../src/link';
import { createRemote } from '../src/remote';
import { run } from './helpers';

const HOST = 'mac.tail1234.ts.net';
const FORWARDED = { host: HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-host': HOST };

const article = (id: string, over: Partial<FollowedArticle> = {}): FollowedArticle => ({
  id,
  title: `Kop ${id}`,
  titleEn: `Headline ${id}`,
  lang: 'nl',
  publisher: 'Het Parool',
  country: 'NLD',
  url: `https://news.example/${id}`,
  image: null,
  publishedAt: '2026-01-02T03:04:05.000Z',
  ...over,
});
const STORY: FollowedStoryView = {
  id: 'ts1',
  title: 'Amsterdam housing plans',
  titleIsAi: true,
  newCount: 2,
  articles: 5,
  latest: article('a1', { image: 'https://img.example/a1.jpg' }),
  updatedAt: '2026-01-02T03:04:05.000Z',
  followedAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
};

const podError = (code: string) => Object.assign(new Error('The person follows no story with that id.'), { code, next: 'call followed.list for the stories followed now' });

function fake() {
  const calls: { op: string; args: unknown[] }[] = [];
  const followed: PodServices['followed'] = {
    list: async () => (calls.push({ op: 'list', args: [] }), { stories: [{ ...STORY, secret: 'SEARCH TEXT' } as FollowedStoryView] }),
    get: async (id, o) => {
      calls.push({ op: 'get', args: [id, o] });
      if (id !== 'ts1') throw podError('unknown_story');
      return { story: STORY, entries: [{ head: article('a1'), copies: 2 }, { head: article('a2', { url: null, titleEn: undefined, publishedAt: null }), copies: 0 }], cursor: o?.after ? null : '1767323045000:a2', more: !o?.after };
    },
    follow: async (input) => (calls.push({ op: 'follow', args: [input] }), { id: 'ts2', state: 'followed', hint: 'Following this story. It grows each time Mera News reads the news.' }),
    unfollow: async (id) => {
      calls.push({ op: 'unfollow', args: [id] });
      if (id !== 'ts1') throw podError('unknown_story');
      return { removed: true };
    },
    removeArticle: async (id, articleId) => (calls.push({ op: 'remove', args: [id, articleId] }), { removed: true }),
  };
  return { followed, calls };
}

async function signedIn(followed: PodServices['followed'], opts: { publicHost?: boolean } = {}) {
  const r = await run({ services: { followed } as Partial<PodServices>, ...(opts.publicHost ? { before: (d: string) => createRemote(d).saveRemote({ publicHost: HOST }) } : {}) });
  const code = /#c=(.+)$/.exec(siteLink(r.dataDir))![1];
  const { session } = JSON.parse((await r.session(code)).body);
  const call = async (path: string, body?: unknown) => {
    const res = await r.request({
      path,
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${session}`, ...(body === undefined ? {} : { origin: r.origin(), 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: JSON.parse(res.body || 'null'), headers: res.headers };
  };
  return { r, call };
}

test('the followed list and a timeline send only the named fields, and only the first page marks the story seen', async () => {
  const { followed, calls } = fake();
  const { r, call } = await signedIn(followed);
  try {
    const list = await call('/api/followed/');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, {
      stories: [
        {
          id: 'ts1',
          title: 'Amsterdam housing plans',
          titleIsAi: true,
          newCount: 2,
          articles: 5,
          latest: { id: 'a1', title: 'Kop a1', titleEn: 'Headline a1', link: 'https://news.example/a1', publisher: 'Het Parool', publishedAt: '2026-01-02T03:04:05.000Z', language: 'nl', image: 'https://img.example/a1.jpg' },
          updatedAt: '2026-01-02T03:04:05.000Z',
          followedAt: '2026-01-01T00:00:00.000Z',
          status: 'active',
        },
      ],
    });
    assert.doesNotMatch(JSON.stringify(list.body), /SEARCH TEXT/);

    const first = await call('/api/followed/story/?id=ts1');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.entries, [
      { id: 'a1', title: 'Kop a1', titleEn: 'Headline a1', link: 'https://news.example/a1', publisher: 'Het Parool', publishedAt: '2026-01-02T03:04:05.000Z', language: 'nl', copies: 2 },
      { id: 'a2', title: 'Kop a2', link: null, publisher: 'Het Parool', publishedAt: null, language: 'nl', copies: 0 },
    ]);
    assert.deepEqual([first.body.cursor, first.body.more], ['1767323045000:a2', true]);
    const next = await call('/api/followed/story/?id=ts1&after=1767323045000:a2');
    assert.deepEqual([next.status, next.body.more], [200, false]);
    assert.deepEqual(
      calls.filter((c) => c.op === 'get').map((c) => c.args),
      [
        ['ts1', { limit: 20, markSeen: true }],
        ['ts1', { limit: 20, after: '1767323045000:a2' }],
      ],
    );

    for (const bad of ['/api/followed/story/', '/api/followed/story/?id=a/b', '/api/followed/story/?id=ts1&after=x', '/api/followed/story/?id=ts1&after=1:a/b']) {
      assert.equal((await call(bad)).status, 400, bad);
    }
    assert.equal(calls.filter((c) => c.op === 'get').length, 2, 'a bad argument asks the pod nothing');

    const gone = await call('/api/followed/story/?id=ts9');
    assert.deepEqual([gone.status, gone.body], [400, { error: 'unknown_story', message: 'You no longer follow this story.', next: 'Go back to the stories you follow.' }]);
  } finally {
    await r.stop();
  }
});

test('follow, unfollow and remove check every field before the pod is asked', async () => {
  const { followed, calls } = fake();
  const { r, call } = await signedIn(followed);
  try {
    const ok = await call('/api/followed/follow/', { text: '  Amsterdam   housing ', label: 'Housing', fromArticleId: 'a1' });
    assert.deepEqual([ok.status, ok.body], [200, { id: 'ts2', state: 'followed', hint: 'Following this story. It grows each time Mera News reads the news.' }]);
    assert.equal((await call('/api/followed/follow/', { text: 'x'.repeat(80) })).status, 200, '80 characters is allowed');
    for (const bad of [{}, { text: '' }, { text: '   ' }, { text: 'x'.repeat(81) }, { text: 42 }, { text: 'ok', label: '' }, { text: 'ok', label: 'x'.repeat(81) }, { text: 'ok', fromArticleId: 'a/b' }, { fromArticleId: 'a1' }]) {
      const res = await call('/api/followed/follow/', bad);
      assert.deepEqual([res.status, res.body.error], [400, 'bad_input'], JSON.stringify(bad));
    }
    assert.deepEqual(
      calls.filter((c) => c.op === 'follow').map((c) => c.args[0]),
      [{ text: 'Amsterdam housing', label: 'Housing', fromArticleId: 'a1' }, { text: 'x'.repeat(80) }],
    );

    assert.deepEqual((await call('/api/followed/unfollow/', { id: 'ts1' })).body, { removed: true });
    const unknown = await call('/api/followed/unfollow/', { id: 'ts9' });
    assert.deepEqual([unknown.status, unknown.body.error], [400, 'unknown_story']);
    assert.equal((await call('/api/followed/unfollow/', { id: 7 })).status, 400);

    assert.deepEqual((await call('/api/followed/remove/', { id: 'ts1', articleId: 'a2' })).body, { removed: true });
    for (const bad of [{ id: 'ts1' }, { articleId: 'a2' }, { id: 'ts1', articleId: '../x' }]) assert.equal((await call('/api/followed/remove/', bad)).status, 400, JSON.stringify(bad));
    assert.deepEqual(
      calls.filter((c) => c.op === 'unfollow' || c.op === 'remove').map((c) => [c.op, ...c.args]),
      [
        ['unfollow', 'ts1'],
        ['unfollow', 'ts9'],
        ['remove', 'ts1', 'a2'],
      ],
    );

    assert.equal((await call('/api/followed/follow/', 'not json')).status, 400);
  } finally {
    await r.stop();
  }
});

test('followed stories need a session, refuse a wrong method, and a paired phone may use them', async () => {
  const { followed, calls } = fake();
  const { r, call } = await signedIn(followed, { publicHost: true });
  try {
    assert.equal((await r.request({ path: '/api/followed/' })).status, 401);
    assert.equal((await r.request({ path: '/api/followed/unfollow/', method: 'POST', headers: { origin: r.origin(), 'content-type': 'application/json' }, body: '{"id":"ts1"}' })).status, 401);
    assert.equal((await call('/api/followed/follow/')).status, 405, 'follow is a POST');
    assert.equal((await call('/api/followed/', {})).status, 405, 'the list is a GET');
    assert.equal(calls.length, 0);

    // A phone pairs through the public address, then reads and changes its followed stories like this computer.
    const start = await call('/api/pair/start/', {});
    const code = /#([A-Z2-7]{10})$/.exec(start.body.url)![1];
    const paired = await r.request({ path: '/api/pair/', method: 'POST', headers: { ...FORWARDED, origin: `https://${HOST}`, 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'iPhone' }) });
    assert.equal(paired.status, 200);
    const cookie = String(paired.headers['set-cookie']).split(';')[0];
    const phone = (path: string, body?: unknown) =>
      r.request({
        path,
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...FORWARDED, cookie, ...(body === undefined ? {} : { origin: `https://${HOST}`, 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    assert.equal((await phone('/api/followed/')).status, 200);
    assert.equal((await phone('/api/followed/story/?id=ts1')).status, 200);
    assert.equal((await phone('/api/followed/follow/', { text: 'Ajax' })).status, 200);
    assert.equal((await phone('/api/followed/remove/', { id: 'ts1', articleId: 'a1' })).status, 200);
    assert.equal((await phone('/api/followed/unfollow/', { id: 'ts1' })).status, 200);
    const unpaired = await r.request({ path: '/api/followed/', headers: FORWARDED });
    assert.equal(unpaired.status, 401, 'a phone that is not paired gets nothing');
    assert.equal((await r.request({ path: '/api/followed/unfollow/', method: 'POST', headers: { ...FORWARDED, cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"id":"ts1"}' })).status, 403, 'another origin cannot unfollow');
  } finally {
    await r.stop();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PodServices, ProfileStory, StoriesSummary } from 'mera-news-pod/plugin-api';
import { siteLink } from '../src/link';
import { run } from './helpers';

const SUMMARY: StoriesSummary = {
  windowHours: 48,
  articles: 3,
  stories: 2,
  merged: 1,
  topics: [{ text: 'utrecht council', matches: 3 }],
  facts: [{ id: 'f1', statement: 'Lives in Utrecht', matched: 2, picked: 1, leftOut: 0 }],
  picked: 1,
  leftOut: 0,
  unjudged: 1,
  publishers: 2,
  languages: 1,
  complete: true,
};
const story = (id: string, over: Partial<ProfileStory> = {}): ProfileStory => ({
  id,
  story: `s:${id}`,
  title: `Titel ${id}`,
  titleEn: `Title ${id}`,
  link: `https://news.example/${id}`,
  publisher: `Paper ${id}`,
  publishedAt: '2026-01-02T03:04:05.000Z',
  language: 'nl',
  image: `https://img.example/${id}.jpg`,
  reports: 2,
  facts: [{ id: 'f1', statement: 'Lives in Utrecht' }],
  topics: ['utrecht council'],
  ...over,
});

const keys = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(keys) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);

async function signedIn(stories: Partial<PodServices['stories']>) {
  const r = await run({ services: { stories } as Partial<PodServices> });
  const code = /#c=(.+)$/.exec(siteLink(r.dataDir))![1];
  const { session } = JSON.parse((await r.session(code)).body);
  const get = async (path: string) => {
    const res = await r.request({ path, headers: { authorization: `Bearer ${session}` } });
    return { status: res.status, body: JSON.parse(res.body || 'null') };
  };
  return { r, get };
}

test('the Feed reads every page with peek, so viewing it never changes what the assistant gets, and sends only the named fields', async () => {
  const asked: unknown[] = [];
  const forProfile: PodServices['stories']['forProfile'] = async (o) => {
    asked.push(o);
    const extra = { description: 'SECRET BODY TEXT', topics: ['x'] } as object;
    return {
      run: '0a1b2c3d',
      summary: { ...SUMMARY, secret: 'SECRET' } as StoriesSummary,
      stories: o?.limit === 0 ? [] : [{ ...story('a1', { verdict: { verdict: 'picked', level: 'high', reason: 'Your council votes.', by: 'assistant', at: 'x' } }), ...extra }, story('a2', { titleEn: undefined, image: undefined })],
      ...(o?.after ? {} : { nextCursor: '0a1b2c3d.2' }),
      shownBefore: 0,
    };
  };
  const { r, get } = await signedIn({ forProfile });
  try {
    const first = await get('/api/feed/');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, {
      run: '0a1b2c3d',
      summary: SUMMARY,
      stories: [
        { id: 'a1', story: 's:a1', title: 'Titel a1', titleEn: 'Title a1', link: 'https://news.example/a1', publisher: 'Paper a1', publishedAt: '2026-01-02T03:04:05.000Z', language: 'nl', image: 'https://img.example/a1.jpg', reports: 2, facts: ['f1'], verdict: { verdict: 'picked', reason: 'Your council votes.', level: 'high', by: 'assistant' } },
        { id: 'a2', story: 's:a2', title: 'Titel a2', link: 'https://news.example/a2', publisher: 'Paper a2', publishedAt: '2026-01-02T03:04:05.000Z', language: 'nl', reports: 2, facts: ['f1'] },
      ],
      nextCursor: '0a1b2c3d.2',
    });
    assert.deepEqual(keys(first.body).filter((k) => /description/i.test(k)), []);
    assert.doesNotMatch(JSON.stringify(first.body), /SECRET/);

    assert.equal((await get('/api/feed/?after=0a1b2c3d.2')).body.nextCursor, null);
    assert.deepEqual((await get('/api/feed/?after=0a1b2c3d.0&limit=0')).body.stories, []);
    assert.deepEqual(asked, [
      { limit: 30, peek: true },
      { after: '0a1b2c3d.2', limit: 30, peek: true },
      { after: '0a1b2c3d.0', limit: 0, peek: true },
    ]);
    for (const bad of ['/api/feed/?after=../x', '/api/feed/?limit=31', '/api/feed/?limit=-1', '/api/feed/?after=ZZ.1']) {
      assert.equal((await get(bad)).status, 400, bad);
    }
    assert.equal(asked.length, 3, 'a bad argument asks the pod nothing');
  } finally {
    await r.stop();
  }
});

test('an expired page of the Feed says to start again, with the pod\'s own words', async () => {
  const expired = Object.assign(new Error('That page of stories has expired.'), { code: 'run_expired', next: 'call again without after to start from the first page' });
  const { r, get } = await signedIn({ forProfile: async () => Promise.reject(expired) });
  try {
    const res = await get('/api/feed/?after=0a1b2c3d.4');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'run_expired');
  } finally {
    await r.stop();
  }
});

test('a lane reads its own fact\'s run, still with peek, and a bad fact id asks the pod nothing', async () => {
  const asked: unknown[] = [];
  const forProfile: PodServices['stories']['forProfile'] = async (o) => {
    asked.push(o);
    if (o?.fact === 'gone') throw Object.assign(new Error('There is no saved fact with that id.'), { code: 'bad_input', next: 'correct it and call again; nothing was saved' });
    return { run: '0a1b2c3d', summary: SUMMARY, stories: [story('a1')], ...(o?.after ? {} : { nextCursor: '0a1b2c3d.1' }), shownBefore: 0 };
  };
  const { r, get } = await signedIn({ forProfile });
  try {
    const first = await get('/api/feed/?fact=f1');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.summary.facts, SUMMARY.facts);
    assert.equal((await get('/api/feed/?fact=f1&after=0a1b2c3d.1')).body.nextCursor, null);
    assert.equal((await get('/api/feed/?fact=f1&after=0a1b2c3d.0&limit=0')).status, 200);
    assert.deepEqual(asked, [
      { fact: 'f1', limit: 30, peek: true },
      { fact: 'f1', after: '0a1b2c3d.1', limit: 30, peek: true },
      { fact: 'f1', after: '0a1b2c3d.0', limit: 0, peek: true },
    ]);
    for (const bad of ['/api/feed/?fact=', '/api/feed/?fact=a/b', `/api/feed/?fact=${'x'.repeat(101)}`, '/api/feed/?fact=a%20b']) {
      assert.equal((await get(bad)).status, 400, bad);
    }
    assert.equal(asked.length, 3, 'a bad fact id asks the pod nothing');
    const gone = await get('/api/feed/?fact=gone');
    assert.deepEqual([gone.status, gone.body.error], [400, 'bad_input']);
  } finally {
    await r.stop();
  }
});

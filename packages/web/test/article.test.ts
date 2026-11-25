import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PodServices } from 'mera-news-pod/plugin-api';
import { siteLink } from '../src/link';
import { createRemote } from '../src/remote';
import { run } from './helpers';

const HOST = 'mac.tail1234.ts.net';
const FORWARDED = { host: HOST, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.2', 'x-forwarded-host': HOST };

type Body = { operationName: string; query: string; variables: Record<string, any> };

const row = (id: string, over: Record<string, unknown> = {}) => ({
  _id: id,
  title: `Kop ${id}`,
  title_en: `Headline ${id}`,
  article_url: `https://news.example/${id}`,
  image_url: `https://img.example/${id}.jpg`,
  pubDate: '2026-01-02T03:04:05.000Z',
  language_code: 'nl',
  publication_name: 'Het Parool',
  maxClusterSize: 7,
  description: 'SECRET BODY TEXT',
  ...over,
});

function fake() {
  const calls: Body[] = [];
  const news = {
    graphql: async (b: unknown) => {
      const body = b as Body;
      calls.push(body);
      if (body.operationName !== 'GetArticlesForTopicsByIds') return { errors: [{ extensions: { code: 'NOT_ALLOWED' } }] };
      const ids: string[] = body.variables.articleIds;
      return { data: { articlesForTopicsByIds: { articles: ids.flatMap((id) => (id === 'gone' ? [] : id === 'bad' ? [row(id, { article_url: 'javascript:alert(1)' })] : [row(id)])) } } };
    },
  } as unknown as PodServices['news'];
  return { news, calls };
}

test('an article opened from a link: its story with the named fields only, and what is wrong with a bad or missing one', async () => {
  const { news, calls } = fake();
  const r = await run({ services: { news }, before: (d) => createRemote(d).saveRemote({ publicHost: HOST }) });
  try {
    const code = /#c=(.+)$/.exec(siteLink(r.dataDir))![1];
    const { session } = JSON.parse((await r.session(code)).body);
    const get = async (path: string) => {
      const res = await r.request({ path, headers: { authorization: `Bearer ${session}` } });
      return { status: res.status, body: JSON.parse(res.body || 'null') };
    };

    assert.equal((await r.request({ path: '/api/article/?id=a1' })).status, 401, 'no session, no article');
    assert.equal(calls.length, 0);

    const ok = await get('/api/article/?id=a1');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, {
      story: {
        id: 'a1',
        title: 'Kop a1',
        titleEn: 'Headline a1',
        link: 'https://news.example/a1',
        publisher: 'Het Parool',
        publishedAt: '2026-01-02T03:04:05.000Z',
        language: 'nl',
        image: 'https://img.example/a1.jpg',
        reports: 7,
      },
    });
    assert.deepEqual(calls[0].variables, { articleIds: ['a1'] });
    assert.doesNotMatch(JSON.stringify(ok.body), /SECRET|description/);

    for (const id of ['', 'a b', 'x'.repeat(101), '../etc']) assert.equal((await get(`/api/article/?id=${encodeURIComponent(id)}`)).status, 400, `id ${JSON.stringify(id)}`);
    assert.equal((await get('/api/article/')).status, 400, 'an id is required');
    const gone = await get('/api/article/?id=gone');
    assert.equal(gone.status, 400);
    assert.equal(gone.body.error, 'not_found');
    assert.equal((await get('/api/article/?id=bad')).body.error, 'not_found', 'an article with no web link is not shown');
    assert.equal((await r.request({ path: '/api/article/?id=a1', method: 'POST', headers: { authorization: `Bearer ${session}`, origin: r.origin(), 'content-type': 'application/json' }, body: '{}' })).status, 405);

    // A paired phone opens articles like this computer; one that is not paired gets nothing.
    assert.equal((await r.request({ path: '/api/article/?id=a1', headers: FORWARDED })).status, 401);
    const start = await r.request({ path: '/api/pair/start/', method: 'POST', headers: { authorization: `Bearer ${session}`, origin: r.origin(), 'content-type': 'application/json' }, body: '{}' });
    const pairCode = /#([A-Z2-7]{10})$/.exec(JSON.parse(start.body).url)![1];
    const paired = await r.request({ path: '/api/pair/', method: 'POST', headers: { ...FORWARDED, origin: `https://${HOST}`, 'content-type': 'application/json' }, body: JSON.stringify({ code: pairCode, name: 'iPhone' }) });
    const cookie = String(paired.headers['set-cookie']).split(';')[0];
    const phone = await r.request({ path: '/api/article/?id=a1', headers: { ...FORWARDED, cookie } });
    assert.equal(phone.status, 200);
    assert.equal(JSON.parse(phone.body).story.id, 'a1');
    assert.ok(!r.logs.some((l) => /Kop|Headline/.test(l)), 'no headline is logged');
  } finally {
    await r.stop();
  }
});

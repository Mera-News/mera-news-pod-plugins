import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followText } from '../site/lib/detail';
import { firstReports, moreReports, otherPublishers } from '../site/lib/reports';

const report = (id: string, publisher: string) => ({ id, title: id, link: `https://news.example/${id}`, publisher, publishedAt: '', language: 'en' });

test('a card lists other publishers only, one report each, up to the number asked', () => {
  const lead = report('a', 'Reuters');
  const list = [lead, report('b', 'Reuters'), report('c', 'Le Monde'), report('d', 'Le Monde'), report('e', 'NHK'), report('f', 'El País')];
  assert.deepEqual(otherPublishers(lead, list, 3).map((r) => r.id), ['c', 'e', 'f']);
  assert.deepEqual(otherPublishers(lead, list, 2).map((r) => r.id), ['c', 'e']);
  assert.deepEqual(otherPublishers(lead, [lead, report('b', 'Reuters')], 3), [], 'the lead publisher alone lists nothing');
});

test('what to follow is the English headline, cut at a word to 80 characters', () => {
  assert.equal(followText({ title: 'Kop', titleEn: 'Headline' }), 'Headline');
  assert.equal(followText({ title: '  Only   the  original  ' }), 'Only the original');
  const long = 'Climate researchers warn that sea levels along the North Sea coast are rising faster than any model expected';
  const cut = followText({ title: long });
  assert.ok(cut.length <= 80 && long.startsWith(cut) && long[cut.length] === ' ', cut);
  const word = 'x'.repeat(120);
  assert.equal(followText({ title: word }).length, 80, 'a headline with no space is cut at 80');
});

test("the detail's reports go ahead of every card's waiting in line", async () => {
  const asked: string[] = [];
  const held: (() => void)[] = [];
  const get = <T,>(path: string) => {
    asked.push(new URLSearchParams(path.split('?')[1]).get('id')!);
    return new Promise<T>((done) => held.push(() => done({ reports: [], nextCursor: null } as T)));
  };
  const cards = ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => firstReports(get, `q-${id}`));
  const detail = firstReports(get, 'q-detail', true);
  const later = moreReports(get, 'q-detail', 'cur', true);
  assert.deepEqual(asked, ['q-c1', 'q-c2', 'q-c3'], 'three at once');
  held.shift()!();
  await new Promise((r) => setTimeout(r, 0));
  // Both urgent asks jumped the two waiting cards; the later one was put at the very front.
  assert.equal(asked[3], 'q-detail');
  while (held.length) {
    held.shift()!();
    await new Promise((r) => setTimeout(r, 0));
  }
  await Promise.all([...cards, detail, later]);
  assert.deepEqual(asked.slice(3), ['q-detail', 'q-detail', 'q-c4', 'q-c5']);
});

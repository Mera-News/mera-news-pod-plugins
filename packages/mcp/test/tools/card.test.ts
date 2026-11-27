import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CARD_MIME, CARD_URI, cardHtml, sectionsOf } from '../../src/card';
import { run } from './helpers';

const CARDED = ['get_suggestions', 'top_stories', 'news_for_profile', 'search_news', 'latest_news'];

test('card: the news tools name the card, other tools do not, and the card is a self-contained page', async () => {
  const r = await run();
  try {
    const c = await r.client();
    const { tools } = await c.listTools();
    for (const t of tools) {
      const uri = (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri;
      assert.equal(uri, CARDED.includes(t.name) ? CARD_URI : undefined, t.name);
    }
    const read = await c.readResource({ uri: CARD_URI });
    const page = read.contents[0] as { mimeType?: string; text?: string };
    assert.equal(page.mimeType, CARD_MIME);
    assert.match(page.text ?? '', /^<!doctype html>/);
    // Nothing is loaded from elsewhere: no src or href attribute in the page itself.
    assert.doesNotMatch(page.text ?? '', /\s(src|href)=["']/);
    assert.doesNotMatch(page.text ?? '', /—/, 'no em dash in card copy');
  } finally {
    await r.stop();
  }
});

test('card: the page script runs sectionsOf as copied, with no outside reference', () => {
  // The page holds sectionsOf as source text; rebuilt in isolation it must give the same sections.
  const copy = new Function('var __name = (f) => f; return ' + sectionsOf.toString())() as typeof sectionsOf;
  const reply = { picks: [{ title: 'A', publication: 'P', url: 'https://p.example/a', level: 'high', reason: 'Why' }] };
  assert.deepEqual(copy(reply), sectionsOf(reply));
});

test('card: every story keeps its publisher and link; reports, groups and levels are drawn', () => {
  const picks = sectionsOf({
    picks: [
      { title: 'Low one', publication: 'Low Paper', url: 'https://low.example/1', level: 'low', reason: 'r1' },
      { title: 'Urgent', publication: 'Urgent Paper', url: 'https://urgent.example/1', level: 'emergency', reason: 'r2' },
      { title: 'Bad link', publication: 'X', url: 'javascript:alert(1)', level: 'high', reason: 'r3' },
    ],
  });
  assert.deepEqual(picks.map((s) => s.heading), ['Picked for you']);
  assert.deepEqual(picks[0].stories.map((s) => [s.title, s.publisher, s.link]), [
    ['Urgent', 'Urgent Paper', 'https://urgent.example/1'],
    ['Low one', 'Low Paper', 'https://low.example/1'],
  ]);

  const top = sectionsOf({
    scope: 'NLD',
    stories: [{ title: 'Storm', link: 'https://a.example/s', publisher: 'A', reports: [{ publisher: 'A', link: 'https://a.example/s' }, { publisher: 'B', link: 'https://b.example/s' }] }],
  });
  assert.equal(top[0].heading, 'Top stories in NLD');
  assert.deepEqual(top[0].stories[0].others, [{ publisher: 'B', link: 'https://b.example/s' }]);

  const news = sectionsOf({
    results: [
      { title: 'One', link: 'https://a.example/1', publisher: 'A', story: 'k' },
      { title: 'One again', link: 'https://b.example/1', publisher: 'B', story: 'k' },
      { title: 'Two', link: 'https://c.example/2', publisher: 'C' },
    ],
  });
  assert.deepEqual(news[0].stories.map((s) => [s.publisher, s.others.map((o) => o.publisher)]), [['A', ['B']], ['C', []]]);

  const profile = sectionsOf({
    toJudge: [{ fact: 'Lives in Delhi', stories: [{ title: 'Smog', link: 'https://d.example/1', publisher: 'D' }] }],
    picked: [{ title: 'F1', link: 'https://f.example/1', publisher: 'F', level: 'medium', reason: 'You follow F1' }],
    leftOut: [{ title: 'Other', link: 'https://o.example/1', publisher: 'O', reason: 'Not yours' }],
  });
  assert.deepEqual(profile.map((s) => s.heading), ['Picked for you', 'Left out', 'Matches for: Lives in Delhi']);
  assert.deepEqual(sectionsOf(null), []);
});

test('card: a top_stories list item says how many reports and publishers it has, and a story of one says nothing', () => {
  const [top] = sectionsOf({
    scope: 'world',
    stories: [
      { id: 'a', title: 'Storm closes Schiphol runways', link: 'https://nos.example/a', publisher: 'NOS', reportCount: 12, publisherCount: 9 },
      { id: 'b', title: 'Two reports', link: 'https://b.example/b', publisher: 'B', reportCount: 2, publisherCount: 1 },
      { id: 'c', title: 'Old server', link: 'https://c.example/c', publisher: 'C', reportCount: 3 },
      { id: 'd', title: 'Alone', link: 'https://d.example/d', publisher: 'D', reportCount: 1, publisherCount: 1 },
    ],
  });
  assert.equal(top.heading, 'Top stories');
  assert.deepEqual(top.stories.map((s) => s.coverage), ['12 reports from 9 publishers', '2 reports from 1 publisher', '3 reports', undefined]);
  assert.deepEqual(top.stories.map((s) => s.others), [[], [], [], []]);
});

test('card: the list scrolls inside a card at most 560 px high, under a header that counts the stories', () => {
  assert.match(cardHtml, /body\{display:flex;flex-direction:column;max-height:560px\}/);
  assert.match(cardHtml, /main\{[^}]*overflow-y:auto/);
  assert.match(cardHtml, /<body><header><\/header><main><\/main><footer><\/footer>/);
  assert.match(cardHtml, /' stories'/);
});

test('card: the page script parses', () => {
  const script = /<script>([\s\S]*)<\/script>/.exec(cardHtml)?.[1] ?? '';
  assert.ok(script.includes("'ui/initialize'"));
  assert.doesNotThrow(() => new Function(script));
});

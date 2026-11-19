import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkTitle, clean } from '../src/title';
import vectors from './title-vectors.json';

test('title: the shared vectors', () => {
  assert.ok(vectors.rows.length >= 33);
  for (const row of vectors.rows) assert.equal(checkTitle(row.in), row.out, row.name);
});

test('title: clean cuts nothing and refuses nothing', () => {
  assert.equal(clean(`${'a'.repeat(300)} www.example.org`).length, 316);
  assert.equal(clean('  a\u200Bb \n c  '), 'ab c');
  assert.equal(checkTitle('a'.repeat(201)), null);
  assert.equal(checkTitle('See WWW.x'), null);
  assert.equal(checkTitle('See HTTP://x'), null);
});

// The sync plugin carries a copy of the mcp plugin's request guard, so each package builds on its own.
// Two copies of a security check must not drift: they stay byte for byte the same.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

test('the sync guard is the mcp guard, byte for byte', () => {
  const read = (pkg: string) => readFileSync(path.join(__dirname, '..', '..', pkg, 'src', 'guard.ts'), 'utf8');
  assert.equal(read('sync'), read('mcp'));
});

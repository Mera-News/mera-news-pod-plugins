// The web plugin carries copies of the mcp plugin's request guard and link code, so each package
// builds on its own. Two copies of a security check must not drift: they stay byte for byte the same.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const read = (pkg: string, file: string) => readFileSync(path.join(__dirname, '..', '..', pkg, 'src', file), 'utf8');

test('the web guard is the mcp guard, byte for byte', () => {
  assert.equal(read('web', 'guard.ts'), read('mcp', 'guard.ts'));
});

test('the web link code is the mcp link code, byte for byte', () => {
  assert.equal(read('web', 'link.ts'), read('mcp', 'link.ts'));
});

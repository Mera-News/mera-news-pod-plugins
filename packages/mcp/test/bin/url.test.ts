import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli, tempHome } from './helpers';

test('url prints the capability address only when asked, with the current token', async () => {
  const home = tempHome('the-token');
  const run = await runCli(['url', '--base', 'https://pod.example.com/', '--home', home]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'https://pod.example.com/mcp/the-token\n');
  const missing = await runCli(['url', '--home', home]);
  assert.equal(missing.code, 2);
  assert.doesNotMatch(missing.stdout + missing.stderr, /the-token/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { run } from './helpers';

const cli = (args: string[]) => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, '..', 'src', 'bin', 'cli.ts'), ...args], { encoding: 'utf8', env });
};

test('mera-news-pod-web link prints a link that opens the site once', async () => {
  const r = await run();
  const home = path.resolve(r.dataDir, '..', '..', '..');
  try {
    const out = cli(['link', '--home', home]);
    assert.equal(out.status, 0, out.stderr);
    const code = /^http:\/\/127\.0\.0\.1:\d+\/#c=(\S+)\n$/.exec(out.stdout)![1];
    assert.match(out.stderr, /works once, for 10 minutes/);
    assert.equal((await r.session(code)).status, 200);
  } finally {
    await r.stop();
  }
  const stopped = cli(['link', '--home', home]);
  assert.equal(stopped.status, 1);
  assert.equal(stopped.stdout, '');
  assert.match(stopped.stderr, /^The Mera News website is not running\./);
  assert.equal(cli([]).status, 2);
});

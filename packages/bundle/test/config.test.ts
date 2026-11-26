import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureConfig } from '../src/config';

/** A folder like the plugin's server folder: the two plugin files the app ships. */
function serverDir(files = ['mcp-plugin.cjs', 'web-plugin.cjs']): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bundle-server-'));
  for (const f of files) writeFileSync(path.join(dir, f), '');
  return dir;
}
const home = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'bundle-config-')), 'home');
const plugins = (h: string) => (JSON.parse(readFileSync(path.join(h, 'pod.json'), 'utf8')).plugins as { package: string; config?: { port?: number } }[]).map((p) => p.package);

test('the first run names the website after mcp, unless the setting turns it off', async () => {
  const dir = serverDir();
  const on = home();
  const port = await ensureConfig(on, dir, {});
  assert.deepEqual(plugins(on), [path.join(dir, 'mcp-plugin.cjs'), path.join(dir, 'web-plugin.cjs')]);
  const written = JSON.parse(readFileSync(path.join(on, 'pod.json'), 'utf8'));
  assert.equal(written.plugins[0].config.port, port);
  assert.ok(Number.isInteger(written.plugins[1].config.port) && written.plugins[1].config.port !== port);
  for (const value of ['false', '0', 'FALSE', ' off ', 'no']) {
    const off = home();
    await ensureConfig(off, dir, { MERA_POD_WEB: value });
    assert.deepEqual(plugins(off), [path.join(dir, 'mcp-plugin.cjs')], value);
  }
  // An app that hands over an unset setting as its template, or as nothing, leaves the default: on.
  for (const value of ['true', '${user_config.web}', '']) {
    const h = home();
    await ensureConfig(h, dir, { MERA_POD_WEB: value });
    assert.equal(plugins(h).length, 2, value);
  }
});

test('later runs add, remove and move the bundled website, and keep its port', async () => {
  const h = home();
  const first = serverDir();
  await ensureConfig(h, first, { MERA_POD_WEB: 'false' });
  assert.equal(plugins(h).length, 1);
  await ensureConfig(h, first, {});
  assert.deepEqual(plugins(h), [path.join(first, 'mcp-plugin.cjs'), path.join(first, 'web-plugin.cjs')]);
  const webPort = JSON.parse(readFileSync(path.join(h, 'pod.json'), 'utf8')).plugins[1].config.port;

  // An update installs the plugin at a new path.
  const updated = serverDir();
  await ensureConfig(h, updated, {});
  assert.deepEqual(plugins(h), [path.join(updated, 'mcp-plugin.cjs'), path.join(updated, 'web-plugin.cjs')]);
  assert.equal(JSON.parse(readFileSync(path.join(h, 'pod.json'), 'utf8')).plugins[1].config.port, webPort);

  // A website file that is gone would stop the pod, the mcp tools with it.
  rmSync(path.join(updated, 'web-plugin.cjs'));
  await ensureConfig(h, updated, {});
  assert.deepEqual(plugins(h), [path.join(updated, 'mcp-plugin.cjs')]);

  writeFileSync(path.join(updated, 'web-plugin.cjs'), '');
  await ensureConfig(h, updated, {});
  await ensureConfig(h, updated, { MERA_POD_WEB: 'false' });
  assert.deepEqual(plugins(h), [path.join(updated, 'mcp-plugin.cjs')]);
});

test('the website always starts after mcp, and a website the person installed is left alone', async () => {
  const dir = serverDir();
  const h = home();
  mkdirSync(h, { recursive: true });
  const write = (list: object[]) => writeFileSync(path.join(h, 'pod.json'), JSON.stringify({ dataServer: { url: 'https://example.org' }, plugins: list }));
  write([{ package: '/old/web-plugin.cjs', config: { port: 1 } }, { package: 'sync' }, { package: '/old/mcp-plugin.cjs', config: { port: 2 } }]);
  assert.equal(await ensureConfig(h, dir, {}), 2);
  assert.deepEqual(plugins(h), ['sync', path.join(dir, 'mcp-plugin.cjs'), path.join(dir, 'web-plugin.cjs')]);

  write([{ package: 'mera-news-pod-mcp' }, { package: 'mera-news-pod-web', config: { port: 3 } }]);
  await ensureConfig(h, dir, {});
  assert.deepEqual(plugins(h), ['mera-news-pod-mcp', 'mera-news-pod-web'], 'no second web plugin');
  await ensureConfig(h, dir, { MERA_POD_WEB: 'false' });
  assert.deepEqual(plugins(h), ['mera-news-pod-mcp', 'mera-news-pod-web']);
});

test('serve mode, which has no app settings, never adds the website the person turned off, and still moves one that is there', async () => {
  const h = home();
  const dir = serverDir();
  await ensureConfig(h, dir, { MERA_POD_WEB: 'false' });
  const before = readFileSync(path.join(h, 'pod.json'), 'utf8');
  await ensureConfig(h, dir, {}, { addWeb: false });
  assert.equal(readFileSync(path.join(h, 'pod.json'), 'utf8'), before, 'pod.json is unchanged');

  await ensureConfig(h, dir, {});
  const updated = serverDir();
  await ensureConfig(h, updated, {}, { addWeb: false });
  assert.deepEqual(plugins(h), [path.join(updated, 'mcp-plugin.cjs'), path.join(updated, 'web-plugin.cjs')]);
});

test('the news server setting: an address is used on the first run and on later ones; empty or leftover text changes nothing', async () => {
  const dir = serverDir();
  const h = home();
  const url = () => JSON.parse(readFileSync(path.join(h, 'pod.json'), 'utf8')).dataServer.url as string;
  await ensureConfig(h, dir, { MERA_NEWS_DATA_SERVER_URL: '' });
  assert.equal(url(), 'https://api.mera.news', 'empty means Mera News');
  await ensureConfig(h, dir, { MERA_NEWS_DATA_SERVER_URL: ' http://127.0.0.1:3002 ' });
  assert.equal(url(), 'http://127.0.0.1:3002', 'a later run switches to the person\'s own server');
  for (const left of ['', '${user_config.data_server_url}', `'"'"'`, 'not a web address', 'ftp://x.example']) {
    await ensureConfig(h, dir, { MERA_NEWS_DATA_SERVER_URL: left });
    assert.equal(url(), 'http://127.0.0.1:3002', JSON.stringify(left));
  }
  await ensureConfig(h, dir, { MERA_NEWS_DATA_SERVER_URL: 'https://api.mera.news' });
  assert.equal(url(), 'https://api.mera.news', 'Mera News again, by its address');
  const fresh = home();
  await ensureConfig(fresh, dir, { MERA_NEWS_DATA_SERVER_URL: '${user_config.data_server_url}' });
  assert.equal(JSON.parse(readFileSync(path.join(fresh, 'pod.json'), 'utf8')).dataServer.url, 'https://api.mera.news', 'leftover text on the first run means Mera News');
});

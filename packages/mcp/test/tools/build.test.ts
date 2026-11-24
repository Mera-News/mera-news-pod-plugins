import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const PACKAGE = path.resolve(__dirname, '../..');
const ROOT = path.resolve(PACKAGE, '../..');
const out = mkdtempSync(path.join(os.tmpdir(), 'mcp-build-'));
const env = { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') };

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : [path.join(dir, f)]));

test('the built plugin never requires the pod or the client, and loads and serves without them', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', path.join(PACKAGE, 'tsconfig.json'), '--outDir', out, '--declaration', 'false'], { stdio: 'pipe' });
  const js = files(out).filter((f) => f.endsWith('.js'));
  assert.ok(js.length > 0);
  for (const f of js) assert.doesNotMatch(readFileSync(f, 'utf8'), /require\(["']mera-news-(pod|client)/, f);

  // Load it with a hook that fails on either package, then run it against fake services.
  const probe = `
    const Module = require('node:module');
    const load = Module._load;
    Module._load = function (request, ...rest) {
      if (/^mera-news-(pod|client)/.test(request)) throw new Error('required ' + request);
      return load.call(this, request, ...rest);
    };
    const m = require(${JSON.stringify(path.join(out, 'index.js'))});
    if (m.podApi !== 2 || m.name !== 'mcp' || typeof m.createPlugin !== 'function') throw new Error('bad module');
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-built-'));
    const dataDir = path.join(home, 'data', 'plugins', 'mcp');
    fs.mkdirSync(dataDir, { recursive: true });
    const quiet = () => {};
    const plugin = m.createPlugin({ podApi: 2, meraNewsApp: null, config: { port: 0 }, dataDir, estimateTokens: (t) => Math.ceil(t.length / 4),
      log: { debug: quiet, info: quiet, warn: quiet, error: quiet },
      services: { profile: {}, suggestions: {}, reading: { status: async () => ({ reading: 'on' }) } } });
    (async () => {
      await plugin.start();
      const url = plugin.describe()[0].replace('MCP address: ', '');
      const token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
      const res = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
      const body = await res.text();
      await plugin.stop();
      if (!body.includes('get_suggestions')) throw new Error('no tools: ' + body);
      console.log('ok');
    })().catch((e) => { console.error(e.message); process.exit(1); });
  `;
  const run = spawnSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /ok/);
});

test('the built bin rotates the token', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mcp-built-bin-'));
  mkdirSync(home, { recursive: true });
  const run = spawnSync(process.execPath, [path.join(out, 'bin', 'cli.js'), 'token', '--rotate', '--home', home], { env, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const token = readFileSync(path.join(home, 'data', 'plugins', 'mcp', 'token'), 'utf8').trim();
  assert.equal(run.stdout.trim(), token);
  assert.ok(token.length >= 32);
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addDevice } from '../src/store';

const CLI = path.resolve(__dirname, '../src/bin/cli.ts');
const ROOT = path.resolve(__dirname, '../../..');
const home = () => mkdtempSync(path.join(os.tmpdir(), 'sync-cli-'));
const dir = (h: string) => path.join(h, 'data', 'plugins', 'sync');

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { cwd: ROOT });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('pair writes a 0600 pending code and prints the code and the link', async () => {
  const h = home();
  const out = await cli(['pair', '--home', h, '--base', 'https://pod.example.com/']);
  assert.equal(out.code, 0, out.stderr);
  const code = /\b([A-Z2-7]{10})\b/.exec(out.stdout)?.[1];
  assert.ok(code);
  const link = /meraapp:\/\/\S+/.exec(out.stdout)?.[0];
  assert.ok(link);
  const url = new URL(link);
  assert.equal(url.protocol, 'meraapp:');
  assert.equal(url.host, 'pod-pair');
  assert.equal(url.searchParams.get('u'), 'https://pod.example.com');
  assert.equal(url.searchParams.get('c'), code);
  assert.equal(statSync(path.join(dir(h), 'pairing.json')).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path.join(dir(h), 'pairing.json'), 'utf8').includes(code));
  assert.equal(out.stderr.includes(code), false);
});

test('pair without --base prints the code and says the link needs the public address', async () => {
  const out = await cli(['pair', '--home', home()]);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /[A-Z2-7]{10}/);
  assert.ok(!out.stdout.includes('meraapp://'));
});

test('devices lists paired devices without secrets and --revoke removes one', async () => {
  const h = home();
  const a = addDevice(dir(h), 'Phone A', 'token-a');
  const b = addDevice(dir(h), 'Phone B', 'token-b');
  const list = await cli(['devices', '--home', h]);
  assert.equal(list.code, 0, list.stderr);
  assert.ok(list.stdout.includes(a.id) && list.stdout.includes('Phone B'));
  assert.ok(!list.stdout.includes('token-a'));
  assert.equal((await cli(['devices', '--revoke', a.id, '--home', h])).code, 0);
  const after = (await cli(['devices', '--home', h])).stdout;
  assert.ok(!after.includes(a.id) && after.includes(b.id));
  assert.equal((await cli(['devices', '--revoke', 'nope', '--home', h])).code, 1);
});

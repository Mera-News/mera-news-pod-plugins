import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const CLI = path.resolve(__dirname, '../../src/bin/cli.ts');
const ROOT = path.resolve(__dirname, '../../../..');

export function tempHome(token?: string, mode = 0o600): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mcp-bin-'));
  if (token !== undefined) {
    const dir = path.join(home, 'data', 'plugins', 'mcp');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'token'), token, { mode });
  }
  return home;
}

export const tokenFile = (home: string) => path.join(home, 'data', 'plugins', 'mcp', 'token');

const digest = (s: string) => createHash('sha256').update(s).digest();

export interface Fake {
  url: string;
  seen: { auth?: string; accept?: string; body: any }[];
  close(): Promise<void>;
}

/** A local MCP endpoint. `answer` returns a reply per request body, or null for a 202. */
export async function fakeEndpoint(
  token: () => string,
  answer: (body: any) => { json?: unknown; sse?: unknown[] } | null,
): Promise<Fake> {
  const seen: Fake['seen'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      const body = JSON.parse(raw);
      seen.push({ auth, accept: req.headers.accept, body });
      const ok = timingSafeEqual(digest(auth ?? ''), digest(`Bearer ${token()}`));
      if (!ok) return void res.writeHead(401).end();
      const reply = answer(body);
      if (!reply) return void res.writeHead(202).end();
      if (reply.sse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const m of reply.sse) res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    seen,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export interface Run { code: number | null; stdout: string; stderr: string }

/** Runs the command line with the given stdin and waits for it to exit. */
export function runCli(args: string[], stdin = '', env: Record<string, string> = {}, execArgv: string[] = []): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...execArgv, '--import', 'tsx', CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

export const lines = (s: string) => s.split('\n').filter(Boolean);

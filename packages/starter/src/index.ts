import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { PluginContext, PluginModule, PodPlugin } from 'mera-news-pod/plugin-api';

export const podApi = 2 as const;
export const name = 'starter';

// The page holds no data, so it needs no token. It reads the token from the address after the #,
// asks /picks for the picks and draws them. It never stores the token and only calls its own origin.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your picks</title>
<style>
body{font:16px/1.4 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}
li{margin:0 0 1rem;list-style:none}small{display:block;color:#666}ul{padding:0}
</style></head><body>
<h1>Your picks</h1><p id="note"></p><ul id="list"></ul>
<script>
const note = document.getElementById('note');
const list = document.getElementById('list');
const token = location.hash.slice(1);
if (!token) {
  note.textContent = 'Add the token to the address: #<token>';
} else {
  fetch('/picks', { headers: { authorization: 'Bearer ' + token } })
    .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
    .then(({ ok, body }) => {
      if (!ok) { note.textContent = body.message || 'The picks could not be loaded.'; return; }
      if (!body.picks.length) note.textContent = body.hint;
      for (const p of body.picks) {
        const li = document.createElement('li');
        const head = document.createElement('span');
        if (/^https?:\\/\\//.test(p.url)) {
          const a = document.createElement('a');
          a.href = p.url;
          a.target = '_blank';
          a.rel = 'noreferrer noopener';
          a.textContent = p.title;
          head.appendChild(a);
        } else {
          head.textContent = p.title;
        }
        const pub = document.createElement('small');
        pub.textContent = p.publication;
        li.append(head, pub);
        list.appendChild(li);
      }
    })
    .catch(() => { note.textContent = 'The picks could not be loaded.'; });
}
</script></body></html>`;

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

/** Reads the token file, refusing one that group or others can read. Throws a plain sentence. */
function readToken(file: string): string {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    throw new Error(`There is no token at ${file}.`);
  }
  // A link could point the read at a file someone else controls; the token is always a plain file.
  if (!stat.isFile()) throw new Error(`The token at ${file} is not a plain file. Remove it and restart.`);
  if (stat.mode & 0o077) throw new Error(`The token file ${file} can be read by other users. Fix it with: chmod 600 ${file}`);
  return readFileSync(file, 'utf8').trim();
}

/** Writes a new random token to the file, readable only by its owner. */
function createToken(file: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function readPort(raw: unknown): number {
  const port = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).port : undefined) ?? 8789;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('The starter plugin needs "port" to be a whole number from 0 to 65535.');
  }
  return port;
}

export const createPlugin: PluginModule['createPlugin'] = (ctx: PluginContext): PodPlugin => {
  const configured = readPort(ctx.config);
  const tokenFile = path.join(ctx.dataDir, 'token');
  let server: http.Server | undefined;
  let port = configured;

  const json = (res: http.ServerResponse, status: number, body: unknown) =>
    void res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  const refuse = (res: http.ServerResponse, status: number) => void res.writeHead(status).end();

  async function route(url: URL): Promise<unknown | 'bad_limit'> {
    if (url.pathname === '/status') return ctx.services.reading.status();
    if (url.pathname === '/profile') {
      const offset = url.searchParams.get('offset');
      return ctx.services.profile.get(offset === null ? undefined : { offset: Number(offset) });
    }
    const limit = Number(url.searchParams.get('limit') ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return 'bad_limit';
    // peek: this page only shows picks, so it must not take them from another caller.
    return ctx.services.suggestions.get({ since: url.searchParams.get('since') ?? 'all', limit, peek: true });
  }

  async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return refuse(res, 403);
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return refuse(res, 403);
    if (req.method !== 'GET') return refuse(res, 405);

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname === '/') return void res.writeHead(200, PAGE_HEADERS).end(PAGE);
    if (!['/picks', '/profile', '/status'].includes(url.pathname)) return refuse(res, 404);

    let expected = '';
    try {
      expected = readToken(tokenFile);
    } catch {
      ctx.log.warn('The token file cannot be used, so every request is refused.');
    }
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!expected || !sameSecret(given, expected)) return refuse(res, 401);

    try {
      const body = await route(url);
      if (body === 'bad_limit') return json(res, 400, { error: 'bad_limit' });
      json(res, 200, body);
    } catch (e) {
      const err = e as { code?: unknown; next?: unknown; message?: unknown };
      // The pod's own errors carry a code and a next step; show those as they are.
      if (typeof err.code === 'string' && typeof err.next === 'string') {
        return json(res, 400, { error: err.code, message: err.message, next: err.next });
      }
      ctx.log.error('A request failed.', { route: url.pathname });
      json(res, 500, { error: 'failed' });
    }
  }

  return {
    async start() {
      if (!existsSync(tokenFile)) {
        createToken(tokenFile);
        ctx.log.info(`A token was created at ${tokenFile}. Read it from that file.`);
      }
      readToken(tokenFile); // fail at start, in plain words, if the file cannot be trusted
      const s = http.createServer((req, res) => void onRequest(req, res));
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(configured, '127.0.0.1', resolve);
      });
      server = s;
      port = (s.address() as AddressInfo).port;
    },
    async stop() {
      const s = server;
      server = undefined;
      if (!s) return;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
    describe() {
      return [`Starter page: http://127.0.0.1:${port}/#<the token in ${tokenFile}>`, `Token file: ${tokenFile}`];
    },
  };
};

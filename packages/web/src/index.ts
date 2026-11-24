// The Mera News website, served by the pod on this computer only. A one-time link from the person's
// assistant (or `mera-news-pod-web link`) lets one browser tab in. Nothing here may stop the pod:
// the mcp tools run in the same process, so a failure is logged and the site answers 503.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { PluginContext, PluginModule, PodPlugin } from 'mera-news-pod/plugin-api';
import { hostAllowed, originAllowed } from './guard';
import { ADDRESS_FILE, checkCode, LINK_KEY_FILE } from './link';
import { loadSite, type SiteFile } from './site';

export const podApi = 2 as const;
export const name = 'web';

const DEFAULT_PORT = 8790;
const MAX_BODY = 64 * 1024;
export const MAX_SESSIONS = 20;
export const SESSION_IDLE_MS = 12 * 3600_000;

const COMMON = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

/** Where the export is: beside the bundled plugin file, or in this package after its build. */
const siteDirs = () => [path.join(__dirname, 'web'), path.join(__dirname, '..', 'site', 'out')];

const digest = (s: string) => createHash('sha256').update(s).digest('hex');

function writePrivate(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  rmSync(file, { force: true }); // never write through a link someone left in its place
  writeFileSync(file, text, { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
}

/** Runs a cleanup that must never stop the pod. */
const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    // nothing to do: the next start or stop tries again
  }
};

class HttpError extends Error {
  constructor(public status: number) {
    super(String(status));
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return Promise.reject(new HttpError(413));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.removeAllListeners('data');
        reject(new HttpError(413));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const createPlugin: PluginModule['createPlugin'] = (ctx: PluginContext): PodPlugin => {
  const raw = (ctx.config && typeof ctx.config === 'object' ? (ctx.config as Record<string, unknown>).port : undefined) ?? DEFAULT_PORT;
  const valid = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 65535;
  if (!valid) ctx.log.warn(`The web plugin's "port" is not a whole number from 0 to 65535, so it uses ${DEFAULT_PORT}.`);
  const configured = valid ? raw : DEFAULT_PORT;
  const addressFile = path.join(ctx.dataDir, ADDRESS_FILE);
  const keyFile = path.join(ctx.dataDir, LINK_KEY_FILE);

  let server: http.Server | undefined;
  let port = configured;
  let files: Map<string, SiteFile> | undefined;
  let key = '';
  /** Session digest to last use, oldest first. */
  const sessions = new Map<string, number>();
  /** Spent code ids to their expiry. */
  const spent = new Map<string, number>();

  const send = (res: http.ServerResponse, status: number, headers: Record<string, string> = {}, body?: Buffer | string) =>
    void res.writeHead(status, { ...COMMON, ...headers }).end(body);
  const json = (res: http.ServerResponse, status: number, body: unknown) =>
    send(res, status, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(body));

  const ownHost = (h: string | undefined) => hostAllowed(h, undefined) && h!.endsWith(`:${port}`);
  const ownOrigin = (o: string) => originAllowed(o, undefined) && o.endsWith(`:${port}`);

  function startSession(code: unknown): string | null {
    const now = Date.now();
    for (const [id, expires] of spent) if (expires <= now) spent.delete(id);
    const ok = key ? checkCode(key, code, now) : null;
    if (!ok || spent.has(ok.id)) return null;
    spent.set(ok.id, ok.expires);
    const session = randomBytes(32).toString('base64url');
    sessions.set(digest(session), now);
    // The cap keeps the newest: a link opened in one more tab ends the tab least recently used.
    while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    return session;
  }

  function sessionValid(header: string | undefined): boolean {
    const given = /^Bearer ([\w-]{1,100})$/.exec(header ?? '')?.[1];
    if (!given) return false;
    const id = digest(given);
    const last = sessions.get(id);
    if (last === undefined) return false;
    sessions.delete(id);
    if (Date.now() - last > SESSION_IDLE_MS) return false;
    sessions.set(id, Date.now());
    return true;
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
    if (pathname === '/api/session/') {
      if (req.method !== 'POST') return send(res, 405, { allow: 'POST' });
      let code: unknown;
      try {
        code = (JSON.parse(await readBody(req)) as { code?: unknown })?.code;
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { connection: 'close' });
        return json(res, 400, { error: 'bad_input' });
      }
      const session = startSession(code);
      return session ? json(res, 200, { session }) : send(res, 401);
    }
    if (pathname !== '/api/status/') return send(res, 404);
    if (req.method !== 'GET') return send(res, 405, { allow: 'GET' });
    if (!sessionValid(req.headers.authorization)) return send(res, 401, { 'www-authenticate': 'Bearer realm="mera-news-pod"' });
    try {
      json(res, 200, await ctx.services.reading.status());
    } catch (e) {
      const err = e as { code?: unknown; next?: unknown; message?: unknown };
      // The pod's own errors carry a code and a next step; show those as they are.
      if (typeof err.code === 'string' && typeof err.next === 'string') return json(res, 400, { error: err.code, message: err.message, next: err.next });
      ctx.log.error('A website request failed.');
      json(res, 500, { error: 'failed' });
    }
  }

  async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!ownHost(req.headers.host)) return send(res, 403);
    const origin = req.headers.origin;
    // A browser always sends Origin on a POST, so a POST without one did not come from this page.
    if (origin === undefined ? req.method === 'POST' : !ownOrigin(origin)) return send(res, 403);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') return send(res, 405, { allow: 'GET, HEAD, POST' });
    const pathname = (req.url ?? '/').split('?')[0];
    const isApi = pathname.startsWith('/api/');
    if (req.method === 'POST') {
      if (!isApi) return send(res, 405, { allow: 'GET, HEAD' });
      if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) return send(res, 415);
    }
    if (!files || !key) {
      return isApi ? send(res, 503) : send(res, 503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, 'The Mera News website could not start. Restart your AI app or your pod.\n');
    }
    if (isApi) return api(req, res, pathname);
    const file = files.get(pathname);
    if (file) return send(res, 200, file.headers, req.method === 'HEAD' ? undefined : file.body);
    const missing = files.get('/404.html');
    return missing ? send(res, 404, missing.headers, req.method === 'HEAD' ? undefined : missing.body) : send(res, 404);
  }

  async function listen(at: number): Promise<http.Server> {
    const s = http.createServer((req, res) =>
      onRequest(req, res).catch(() => {
        ctx.log.error('A website request failed.');
        if (!res.headersSent) send(res, 500);
      }),
    );
    await new Promise<void>((resolve, reject) => {
      s.once('error', reject);
      s.listen(at, '127.0.0.1', resolve);
    });
    return s;
  }

  return {
    async start() {
      sessions.clear();
      spent.clear();
      key = '';
      files = undefined;
      quietly(() => rmSync(addressFile, { force: true }));
      try {
        const next = randomBytes(32).toString('base64url');
        writePrivate(keyFile, `${next}\n`);
        key = next;
      } catch {
        ctx.log.error(`The link key could not be written to ${keyFile}, so the website answers that it is unavailable.`);
      }
      const dir = siteDirs().find((d) => existsSync(path.join(d, 'index.html')));
      try {
        if (!dir) throw new Error('missing');
        files = loadSite(dir);
      } catch {
        ctx.log.error('The website files are missing or unreadable, so the website answers that it is unavailable. Reinstall the plugin.');
      }
      try {
        server = await listen(configured).catch(async (e: NodeJS.ErrnoException) => {
          if (e.code !== 'EADDRINUSE' || configured === 0) throw e;
          ctx.log.warn(`Port ${configured} is in use, so the website takes another one.`);
          return listen(0);
        });
      } catch {
        ctx.log.error('The website could not start: no port was free.');
        return;
      }
      port = (server.address() as AddressInfo).port;
      try {
        writeFileSync(addressFile, `${JSON.stringify({ port, pid: process.pid })}\n`, { mode: 0o600 });
      } catch {
        ctx.log.error(`The website's address could not be written to ${addressFile}, so no link can open it.`);
      }
    },
    async stop() {
      quietly(() => rmSync(addressFile, { force: true }));
      sessions.clear();
      const s = server;
      server = undefined;
      if (!s) return;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
    describe() {
      const home = path.resolve(ctx.dataDir, '..', '..', '..');
      return [`Website: http://127.0.0.1:${port}/`, `A link that opens it, once: mera-news-pod-web link --home ${home}`];
    },
  };
};

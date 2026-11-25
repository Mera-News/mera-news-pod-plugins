// The Mera News website, served by the pod on 127.0.0.1 only. A one-time link from the person's
// assistant (or `mera-news-pod-web link`) lets one browser tab in. A phone reaches it through a
// forwarder on this computer, on the public address, once paired (see remote.ts). Nothing here may
// stop the pod: the mcp tools run in the same process, so a failure is logged and the site answers 503.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { PluginContext, PluginModule, PodPlugin } from 'mera-news-pod/plugin-api';
import { hostAllowed, originAllowed } from './guard';
import { ADDRESS_FILE, checkCode, LINK_KEY_FILE, readPrivate } from './link';
import { feed, FEED_PAGE } from './feed';
import { createCountries, NewsError, search, storyReports, topStories } from './news';
import { loadSite, type SiteFile } from './site';
import { createYou } from './you';
import { encode } from 'uqr';
import { createKeepRunning, systemDeps } from './keep-running';
import { createRemote, deviceCookie, deviceName, forwarded, parsePublicHost, tailscaleCommand, tokenFromCookie, viaPublic, type Remote } from './remote';

export const podApi = 2 as const;
export const name = 'web';

const DEFAULT_PORT = 8790;
const MAX_BODY = 64 * 1024;
export const MAX_SESSIONS = 20;
export const SESSION_IDLE_MS = 12 * 3600_000;
/** Session digests to last use, so an open tab stays signed in when the pod restarts (an update does). */
export const SESSIONS_FILE = 'sessions.json';
/** How stale a saved last use may get: a crash loses at most this much of a session's idle time. */
const SAVE_EVERY_MS = 60_000;

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
  // A new file renamed into place: never written through a link left there, and a failed write leaves the old file whole.
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Runs a cleanup that must never stop the pod. */
const quietly = (fn: () => void) => {
  try {
    fn();
  } catch {
    // nothing to do: the next start or stop tries again
  }
};

/** Which way a request came: from this computer, or from a phone through the public address. */
type Channel = 'local' | 'public';

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
  const sessionsFile = path.join(ctx.dataDir, SESSIONS_FILE);

  let server: http.Server | undefined;
  let port = configured;
  let files: Map<string, SiteFile> | undefined;
  let key = '';
  /** Session digest to last use, oldest first. */
  const sessions = new Map<string, number>();
  /** Spent code ids to their expiry. */
  const spent = new Map<string, number>();
  let savedAt = 0;

  // Only digests are written, never a session itself; a file that cannot be read starts with none.
  function loadSessions() {
    sessions.clear();
    let saved: unknown;
    try {
      saved = JSON.parse(readPrivate(sessionsFile));
    } catch {
      return;
    }
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    const now = Date.now();
    const live = Object.entries(saved as Record<string, unknown>)
      .filter((e): e is [string, number] => /^[0-9a-f]{64}$/.test(e[0]) && Number.isFinite(e[1]) && now - (e[1] as number) <= SESSION_IDLE_MS)
      .sort((a, b) => a[1] - b[1])
      .slice(-MAX_SESSIONS);
    for (const [id, last] of live) sessions.set(id, Math.min(last, now));
  }

  function saveSessions() {
    savedAt = Date.now();
    quietly(() => writePrivate(sessionsFile, `${JSON.stringify(Object.fromEntries(sessions))}\n`));
  }

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
    saveSessions();
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
    if (Date.now() - savedAt > SAVE_EVERY_MS) saveSessions();
    return true;
  }

  const remote = createRemote(ctx.dataDir);
  // A broken remote.json turns phone access off; the You page's phone section says why.
  const publicHost = () => {
    try {
      return remote.remote().publicHost;
    } catch {
      return undefined;
    }
  };

  // The bundle's server.cjs sits beside this file; outside the bundle there is none, and the setting says so.
  const keepRunning = createKeepRunning(systemDeps(path.resolve(ctx.dataDir, '..', '..', '..'), path.join(__dirname, 'server.cjs')));

  const services = (ctx as Extract<PluginContext, { podApi: 2 }>).services;
  const countries = createCountries(services);
  const you = createYou(services, ctx.dataDir);
  // Each argument is checked here; a bad one answers the pod's error shape with what to do.
  const arg = (q: URLSearchParams, key: string, pattern: RegExp, fallback?: string) => {
    const v = q.get(key) ?? fallback;
    if (v === undefined || !pattern.test(v)) throw new NewsError('bad_input', `The "${key}" in this address is not valid.`, 'Go back to your news and try again.');
    return v;
  };
  const cursor = (q: URLSearchParams) => (q.has('after') ? arg(q, 'after', /^[\w.:-]{1,200}$/) : null);
  // `phone` is the device a phone's cookie names; requests from this computer have none.
  const routes: Record<string, (q: URLSearchParams, phone?: string) => Promise<unknown>> = {
    '/api/status/': () => services.reading.status(),
    '/api/countries/': () => countries(),
    '/api/top/': (q) => topStories(services, arg(q, 'c', /^(GLOBAL|[A-Z]{3})$/, 'GLOBAL'), cursor(q)),
    '/api/story/': (q) => storyReports(services, arg(q, 'id', /^[\w.:-]{1,100}$/), cursor(q)),
    // `after` is a run and a position (the pod's own form); `limit=0` asks for the run's numbers only.
    '/api/feed/': (q) => feed(services, q.has('after') ? arg(q, 'after', /^[0-9a-f]{8}\.\d{1,6}$/) : null, Number(arg(q, 'limit', /^(0|30)$/, String(FEED_PAGE)))),
    '/api/search/': (q) => search(services, arg(q, 'q', /^(?=[\s\S]*\S)[\s\S]{1,200}$/).trim()),
    ...you.reads,
    '/api/remote/': async () => phoneAccess(),
    '/api/keep-running/': () => keepRunning.state(),
    '/api/devices/': async (_q, phone) => ({
      devices: remote.devices().map(({ id, name, pairedAt }) => ({ id, name, pairedAt, ...(phone === undefined ? {} : { current: id === phone }) })),
    }),
  };
  /** Only the computer sets the public address, adds a phone and sets the AI service; a phone could otherwise keep itself in, or send a key over the tunnel. */
  const LOCAL_ONLY = new Set(['/api/ai/', '/api/ai/providers/', '/api/ai/models/', '/api/ai/reasons/', '/api/remote/', '/api/pair/start/', '/api/pair/stop/', '/api/keep-running/', '/api/sign-out/']);

  function phoneAccess() {
    let r: Remote;
    try {
      r = remote.remote();
    } catch (e) {
      throw new NewsError('remote_unreadable', (e as Error).message, 'Then reload this page.');
    }
    return { publicHost: r.publicHost ?? null, port, command: tailscaleCommand(port), tunnelTo: `http://127.0.0.1:${port}` };
  }

  const writes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    ...you.writes,
    async '/api/remote/'(body) {
      const given = body.publicHost;
      const host = given === null || given === '' ? undefined : typeof given === 'string' ? parsePublicHost(given) : null;
      if (host === null) throw new NewsError('bad_input', 'The public address is one https name, such as mac.tail1234.ts.net.', 'Copy the address tailscale serve or your tunnel printed, and try again.');
      const before = remote.remote();
      remote.saveRemote({ ...before, publicHost: host });
      // A phone's cookie belongs to one address, so a new address or none starts with no phones.
      if (host !== before.publicHost) remote.clearPhones();
      return phoneAccess();
    },
    async '/api/pair/stop/'() {
      remote.clearPairing();
      return { stopped: true };
    },
    async '/api/pair/start/'() {
      const host = publicHost();
      if (!host) throw new NewsError('no_public_address', 'A phone needs the public address first.', 'Set it above, then add a phone.');
      const { code, expiresAt } = remote.startPairing();
      const url = `https://${host}/pair/#${code}`;
      // Rows of 1 for dark and 0 for light; the page draws them.
      return { url, expiresAt: new Date(expiresAt).toISOString(), qr: encode(url, { ecc: 'M' }).data.map((row) => row.map((dark) => (dark ? '1' : '0')).join('')) };
    },
    async '/api/keep-running/'(body) {
      if (typeof body.on !== 'boolean') throw new NewsError('bad_input', 'Say whether Mera News keeps running.', 'Reload the page and try again.');
      const r = await (body.on ? keepRunning.turnOn() : keepRunning.turnOff());
      ctx.log.info(body.on ? 'Mera News now keeps running on its own.' : 'Mera News no longer keeps running on its own.');
      return r;
    },
    // A restart keeps open tabs signed in, so this is how every tab on this computer is signed out, this one too.
    async '/api/sign-out/'() {
      sessions.clear();
      saveSessions();
      ctx.log.info('Every website tab on this computer was signed out.');
      return { signedOut: true };
    },
    async '/api/devices/remove/'(body) {
      if (typeof body.id !== 'string' || !/^[0-9a-f]{16}$/.test(body.id)) throw new NewsError('bad_input', 'This phone could not be found.', 'Reload the page to see the phones as they are now.');
      return { removed: remote.removeDevice(body.id) };
    },
  };

  /** Swaps a pairing code for a device token, set as a cookie only this site's https address gets. */
  async function pair(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.method !== 'POST') return send(res, 405, { allow: 'POST' });
    const body = await jsonBody(req, res);
    if (!body) return;
    const r = remote.pair(body.code, deviceName(body.name), Date.now(), tokenFromCookie(req.headers.cookie));
    if (!r.ok) return json(res, r.status, { error: r.error });
    ctx.log.info('A phone was paired.');
    send(res, 200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'set-cookie': deviceCookie(r.token) }, JSON.stringify({ paired: true }));
  }

  /** The body as an object, or undefined once an error answer was sent. Never logged: it can hold a fact, a key or a code. */
  async function jsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | undefined> {
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { connection: 'close' });
      else json(res, 400, { error: 'bad_input' });
      return undefined;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      json(res, 400, { error: 'bad_input' });
      return undefined;
    }
    return body as Record<string, unknown>;
  }

  async function api(req: http.IncomingMessage, res: http.ServerResponse, pathname: string, channel: Channel) {
    if (pathname === '/api/pair/') return channel === 'public' ? pair(req, res) : send(res, 403);
    if (pathname === '/api/session/') {
      // The one-time link is for this computer; a phone pairs instead.
      if (channel !== 'local') return send(res, 403);
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
    const read = Object.hasOwn(routes, pathname) ? routes[pathname] : undefined;
    const write = Object.hasOwn(writes, pathname) ? writes[pathname] : undefined;
    if (!read && !write) return send(res, 404);
    const allow = [read && 'GET', write && 'POST'].filter(Boolean).join(', ');
    if ((req.method === 'POST' ? !write : !read) || req.method === 'HEAD') return send(res, 405, { allow });
    let phone: string | undefined;
    if (channel === 'local') {
      if (!sessionValid(req.headers.authorization)) return send(res, 401, { 'www-authenticate': 'Bearer realm="mera-news-pod"' });
    } else {
      const token = tokenFromCookie(req.headers.cookie);
      phone = remote.device(token)?.id;
      if (!phone) return send(res, 401);
      if (LOCAL_ONLY.has(pathname)) return send(res, 403);
      // Sent again with every answer, so a phone in use stays paired until it is removed.
      res.setHeader('set-cookie', deviceCookie(token!));
    }
    try {
      if (req.method === 'POST') {
        // The body is read only here, after the session.
        const body = await jsonBody(req, res);
        if (!body) return;
        return json(res, 200, await write!(body));
      }
      json(res, 200, await read!(new URLSearchParams((req.url ?? '').split('?')[1] ?? ''), phone));
    } catch (e) {
      const err = e as { code?: unknown; next?: unknown; message?: unknown };
      // The pod's own errors carry a code and a next step; show those as they are.
      if (typeof err.code === 'string' && typeof err.next === 'string') return json(res, 400, { error: err.code, message: err.message, next: err.next });
      ctx.log.error('A website request failed.');
      json(res, 500, { error: 'failed' });
    }
  }

  async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const host = publicHost();
    // A forwarded request is a phone's, whatever Host it names: it must be the public address over HTTPS.
    const channel: Channel | null = forwarded(req.headers) ? (viaPublic(req.headers, req.socket.remoteAddress, host) ? 'public' : null) : ownHost(req.headers.host) ? 'local' : null;
    if (!channel) return send(res, 403);
    const origin = req.headers.origin;
    const originOk = (o: string) => (channel === 'local' ? ownOrigin(o) : o === `https://${host}`);
    // A browser always sends Origin on a POST, so a POST without one did not come from this page.
    if (origin === undefined ? req.method === 'POST' : !originOk(origin)) return send(res, 403);
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
    if (isApi) return api(req, res, pathname, channel);
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
      // Codes die with the old key below; sessions already open carry on.
      loadSessions();
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
      // The port, once chosen, is kept: the forwarder's command names it.
      let kept: Remote = {};
      try {
        kept = remote.remote();
      } catch {
        ctx.log.warn(`The website's phone settings in ${ctx.dataDir} cannot be read, so phones cannot reach it. The You page says why.`);
      }
      const first = kept.port?.configured === configured ? kept.port.port : configured;
      try {
        server = await listen(first).catch(async (e: NodeJS.ErrnoException) => {
          if (e.code !== 'EADDRINUSE' || first === 0) throw e;
          ctx.log.warn(`Port ${first} is in use, so the website takes another one.`);
          return listen(0);
        });
      } catch {
        ctx.log.error('The website could not start: no port was free.');
        return;
      }
      port = (server.address() as AddressInfo).port;
      if (kept.port?.port !== port || kept.port.configured !== configured) {
        if (kept.publicHost && kept.port) ctx.log.warn(`The website moved to port ${port}, so phones cannot reach it until you run: ${tailscaleCommand(port)}`);
        quietly(() => remote.saveRemote({ ...remote.remote(), port: { configured, port } }));
      }
      try {
        writeFileSync(addressFile, `${JSON.stringify({ port, pid: process.pid })}\n`, { mode: 0o600 });
      } catch {
        ctx.log.error(`The website's address could not be written to ${addressFile}, so no link can open it.`);
      }
    },
    async stop() {
      quietly(() => rmSync(addressFile, { force: true }));
      saveSessions();
      sessions.clear();
      const s = server;
      server = undefined;
      if (!s) return;
      s.closeAllConnections();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    },
    describe() {
      const home = path.resolve(ctx.dataDir, '..', '..', '..');
      const host = publicHost();
      return [
        `Website: http://127.0.0.1:${port}/`,
        `A link that opens it, once: mera-news-pod-web link --home ${home}`,
        ...(host ? [`On your phones: https://${host}/ (forwarded with: ${tailscaleCommand(port)})`] : []),
      ];
    },
  };
};

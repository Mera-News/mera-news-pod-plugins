import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PluginContext, PluginModule, PodPlugin, PodServices } from 'mera-news-pod/plugin-api';
import { hostAllowed, originAllowed, sameSecret } from './guard';
import {
  addDevice,
  clearPairing,
  type Device,
  listDevices,
  MAX_WRONG_CODES,
  normalizeCode,
  type PingEntry,
  readPairing,
  removeDevice,
  sha256,
  lastSeen,
  readPings,
  setPing,
  touchDevice,
  writePairing,
} from './store';

export const podApi = 2 as const;
export const name = 'sync';

const MB = 1024 * 1024;
const TRIES_PER_MINUTE = 5;
const SEEN_MS = 2 * 60_000;
// The relay lets one wake-up through per 30 minutes; a minute more keeps the trailing ping out of that slot.
const WINDOW_MS = 31 * 60_000;
const SEND_TIMEOUT_MS = 10_000;

interface Config {
  host: string;
  port: number;
  publicHost?: string;
  podName: string;
}

function readConfig(raw: unknown): Config {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const port = c.port === undefined ? 8788 : c.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('The sync plugin needs "port" to be a whole number from 0 to 65535.');
  }
  for (const key of ['host', 'publicHost', 'podName'] as const) {
    if (c[key] !== undefined && typeof c[key] !== 'string') throw new Error(`The sync plugin needs "${key}" to be text.`);
  }
  return {
    host: (c.host as string | undefined) ?? '127.0.0.1',
    port,
    publicHost: c.publicHost as string | undefined,
    podName: (c.podName as string | undefined) ?? os.hostname(),
  };
}

class HttpError extends Error {
  constructor(readonly status: number, readonly error: string) {
    super(error);
  }
}

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const refuse = (res: http.ServerResponse, status: number) => void res.writeHead(status).end();

function readJson(req: http.IncomingMessage, limit: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return; // keep draining so the caller can read the answer, but keep nothing
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        reject(new HttpError(413, 'too_large'));
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'bad_json'));
      }
    });
    req.on('error', reject);
  });
}

export const createPlugin: PluginModule['createPlugin'] = (ctx: PluginContext): PodPlugin => {
  if (ctx.podApi !== 2) throw new Error('The sync plugin needs a pod that speaks plugin API version 2.');
  const services: PodServices = ctx.services;
  const config = readConfig(ctx.config);
  const wakeRelay = ctx.wakeRelay;
  const dir = ctx.dataDir;
  let listening: http.Server | undefined;
  let port = config.port;
  const tries: number[] = []; // times of recent /pair tries, kept for the global limit
  const timers = new Map<string, NodeJS.Timeout>(); // at most one per device, cleared on stop
  const sending = new Set<string>();
  const changedWhileSending = new Set<string>(); // a change during a send still leads to a later wake-up
  const stopped = new AbortController();
  let unsubscribe: (() => void) | undefined;

  // Decides what a change means for one device: wait until the phone has been quiet, wait out the
  // window since the last wake-up, or send. Every timer comes back here, so each wait re-checks.
  function consider(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const entry = readPings(dir)[id];
    if (!entry || !wakeRelay) return;
    if (sending.has(id)) return void changedWhileSending.add(id);
    const now = Date.now();
    // An expired pass would only be refused: drop it without asking, and the phone mints a new one.
    if (entry.expiresAt * 1000 <= now) {
      setPing(dir, id, undefined);
      return ctx.log.warn("A phone's wake-up pass has expired. Open the app on that phone to resume wake-ups.");
    }
    const wait = (until: number) => timers.set(id, setTimeout(() => (timers.delete(id), consider(id)), Math.max(0, until - now)));
    const seen = Date.parse(lastSeen(dir)[id] ?? '');
    if (now - seen < SEEN_MS) return wait(seen + SEEN_MS);
    if (entry.lastSentAt !== undefined && now < entry.lastSentAt + WINDOW_MS) {
      if (!entry.pending) setPing(dir, id, { ...entry, pending: true });
      return wait(entry.lastSentAt + WINDOW_MS);
    }
    void send(id, entry, wakeRelay);
  }

  // Only the capability goes out: nothing about what was read is in a wake-up.
  async function send(id: string, entry: PingEntry, relay: string) {
    sending.add(id);
    let status = 0;
    let invalid = false;
    try {
      const res = await fetch(new URL('/api/pod/ping', relay), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ capability: entry.capability }),
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT_MS), stopped.signal]),
      });
      status = res.status;
      if (status === 401) invalid = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error === 'capability_invalid';
      else void res.body?.cancel().catch(() => {});
    } catch {
      // a network error or a refused redirect: keep the entry, the next change tries again
    } finally {
      sending.delete(id);
    }
    if (stopped.signal.aborted) return;
    const again = changedWhileSending.delete(id);
    // The phone may have stored a newer capability while this one was in flight.
    const current = readPings(dir)[id];
    if (!current || current.capability !== entry.capability) {
      if (again) consider(id);
      return;
    }
    if (status === 202) {
      const { pending: _pending, ...rest } = current;
      setPing(dir, id, { ...rest, lastSentAt: Date.now() });
    } else if (invalid) {
      setPing(dir, id, undefined);
      ctx.log.warn("A phone's wake-up pass was refused. Open the app on that phone to resume wake-ups.");
    } else {
      ctx.log.debug('A wake-up was not sent.', { reason: status ? `status_${status}` : 'no_answer' });
    }
    if (again) consider(id);
  }

  function onChanged() {
    try {
      for (const id of Object.keys(readPings(dir))) consider(id);
    } catch {
      ctx.log.warn('The wake-up file cannot be used, so no wake-up is sent.');
    }
  }

  function authenticate(header: string | undefined): Device | undefined {
    const given = /^Bearer (.+)$/.exec(header ?? '')?.[1];
    if (!given) return undefined;
    const hash = sha256(given);
    let found: Device | undefined;
    for (const d of listDevices(dir)) if (sameSecret(hash, d.tokenHash)) found = d;
    return found;
  }

  async function pair(res: http.ServerResponse, body: any) {
    const now = Date.now();
    while (tries.length && now - tries[0] >= 60_000) tries.shift();
    if (tries.length >= TRIES_PER_MINUTE) return sendJson(res, 429, { error: 'too_many_tries' });
    tries.push(now);

    const pending = readPairing(dir);
    if (pending && now > pending.expiresAt) clearPairing(dir);
    if (!pending || now > pending.expiresAt || pending.wrong >= MAX_WRONG_CODES) return sendJson(res, 403, { error: 'pairing_closed' });
    const code = typeof body?.code === 'string' ? normalizeCode(body.code) : '';
    if (!sameSecret(sha256(code), pending.codeHash)) {
      writePairing(dir, { ...pending, wrong: pending.wrong + 1 });
      return sendJson(res, 403, { error: 'wrong_code' });
    }
    clearPairing(dir);
    // One pod, one device: a paired device sees the whole profile, its chats and the reading.
    // The code is checked first, so only someone holding a valid code learns a device is paired.
    if (listDevices(dir).length > 0) return sendJson(res, 409, { error: 'already_paired' });
    const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 64) : 'Phone';
    const token = randomBytes(32).toString('base64url');
    const device = addDevice(dir, deviceName, token);
    ctx.log.info('A device was paired.');
    sendJson(res, 200, { deviceId: device.id, token, podName: config.podName });
  }

  async function chat(res: http.ServerResponse, body: unknown) {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    const upstream = await services.model.chatCompletions(body, abort.signal);
    // An error body can echo the request, the pod's key included, so only the status goes back.
    if (!upstream.ok) {
      void upstream.body?.cancel().catch(() => {});
      return sendJson(res, upstream.status, { error: 'upstream_error' });
    }
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.flushHeaders();
    if (!upstream.body) return void res.end();
    try {
      await pipeline(Readable.fromWeb(upstream.body as never), res);
    } catch {
      res.destroy(); // an abort or a failed upstream ends the answer; the phone sees a cut stream
    }
  }

  const routes: Record<string, { limit: number; run(res: http.ServerResponse, body: any, device: Device): Promise<void> | void }> = {
    'POST /snapshot': {
      limit: 2 * MB,
      run: async (res, b) => sendJson(res, 200, await services.display.snapshot({ hashes: b.hashes, peer: { schemaVersion: b.schemaVersion, registry: b.registry } })),
    },
    'POST /commands': {
      limit: 2 * MB,
      run: async (res, b) => {
        if (!Array.isArray(b.commands)) throw new HttpError(400, 'bad_request');
        sendJson(res, 200, await services.commands.run({ schemaVersion: b.schemaVersion, registry: b.registry, hashes: b.hashes, commands: b.commands }));
      },
    },
    'POST /v1/chat/completions': { limit: 2 * MB, run: (res, b) => chat(res, b) },
    'POST /graphql': { limit: 2 * MB, run: async (res, b) => sendJson(res, 200, await services.news.graphql(b)) },
    'GET /status': {
      limit: 0,
      run: async (res, _b, device) => {
        const wakeups = !wakeRelay ? 'disabled' : readPings(dir)[device.id] ? 'on' : 'off';
        sendJson(res, 200, { ...(await services.reading.status()), podName: config.podName, ...services.display.versions(), wakeups, relayOrigin: wakeRelay });
      },
    },
    // The paired page's "Read the news" switch: only the pause, never the interval, which is the pod's own setting.
    'POST /reading': {
      limit: 1024,
      run: async (res, b) => {
        if (typeof b.paused !== 'boolean' || Object.keys(b).length !== 1) throw new HttpError(400, 'bad_request');
        sendJson(res, 200, await services.reading.set({ paused: b.paused }));
      },
    },
    // The phone's pass for the relay: a capability and when it ends, or `{}` to stop wake-ups.
    'POST /ping': {
      limit: 2048,
      run: (res, b, device) => {
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_request');
        const keys = Object.keys(b);
        if (keys.length === 0) setPing(dir, device.id, undefined);
        else if (keys.length === 2 && typeof b.capability === 'string' && b.capability && typeof b.expiresAt === 'number' && Number.isFinite(b.expiresAt)) {
          // A new pass is for the same phone, and the relay's slot is per phone: keep the window and any pending change.
          const { lastSentAt, pending } = readPings(dir)[device.id] ?? {};
          setPing(dir, device.id, { capability: b.capability, expiresAt: b.expiresAt, ...(lastSentAt !== undefined ? { lastSentAt } : {}), ...(pending ? { pending } : {}) });
        } else throw new HttpError(400, 'bad_request');
        sendJson(res, 200, {});
      },
    },
    'POST /devices/revoke': {
      limit: 1024,
      run: (res, _b, device) => {
        removeDevice(dir, device.id);
        sendJson(res, 200, {});
      },
    },
  };

  async function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!hostAllowed(req.headers.host, config.publicHost)) return refuse(res, 403);
    if (!originAllowed(req.headers.origin, config.publicHost)) return refuse(res, 403);
    const pathname = (req.url ?? '').split('?')[0];
    const key = `${req.method} ${pathname}`;
    try {
      if (key === 'POST /pair') return await pair(res, await readJson(req, 4096));

      let device: Device | undefined;
      try {
        device = authenticate(req.headers.authorization);
      } catch {
        ctx.log.warn('The devices file cannot be used, so every request is refused.');
      }
      if (!device) return refuse(res, 401);
      const seen = lastSeen(dir)[device.id];
      if (!seen || Date.now() - Date.parse(seen) > 60_000) touchDevice(dir, device.id);

      const route = routes[key];
      if (!route) return refuse(res, 404);
      await route.run(res, route.limit ? await readJson(req, route.limit) : {}, device);
    } catch (e) {
      if (res.headersSent) return void res.destroy();
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.error });
      const code = (e as { code?: unknown })?.code;
      if (code === 'version_mismatch') return sendJson(res, 409, { error: code, message: (e as Error).message });
      ctx.log.warn('A request failed.', { route: key }); // never the body or the error text, which can echo it
      sendJson(res, 500, { error: typeof code === 'string' ? code : 'failed' });
    }
  }

  return {
    async start() {
      const server = http.createServer((req, res) => void onRequest(req, res));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
      listening = server;
      port = (server.address() as AddressInfo).port;
      if (wakeRelay) unsubscribe = services.events.on('changed', onChanged);
    },
    async stop() {
      stopped.abort();
      unsubscribe?.();
      unsubscribe = undefined;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      const server = listening;
      listening = undefined;
      if (!server) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    describe() {
      const home = path.resolve(dir, '..', '..', '..');
      const base = config.publicHost ? `https://${config.publicHost}` : '<the https address of this pod>';
      return [`Sync address: http://127.0.0.1:${port}`, `Pair a phone: mera-news-pod-sync pair --base ${base} --home ${home}`];
    },
  };
};

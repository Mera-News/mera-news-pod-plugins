import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { PickView, PluginContext, PluginModule, PodPlugin, PodServices } from 'mera-news-pod/plugin-api';
import { hostAllowed, originAllowed, sameSecret } from './guard';
import {
  addDevice,
  clearPairing,
  type Device,
  listDevices,
  MAX_WRONG_CODES,
  normalizeCode,
  clearPasses,
  readNotified,
  readPairing,
  readPasses,
  recordNotified,
  removeDevice,
  setPass,
  sha256,
  lastSeen,
  touchDevice,
  writePairing,
} from './store';
import { checkTitle, clean, hasLink } from './title';

export const podApi = 2 as const;
export const name = 'sync';

const MB = 1024 * 1024;
const TRIES_PER_MINUTE = 5;
const SEND_TIMEOUT_MS = 10_000;
const PACE_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const QUIET_OVER_S = 300;
const PICK_ID = /^[A-Za-z0-9_-]{1,64}$/;

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
  const app = ctx.meraNewsApp;
  const dir = ctx.dataDir;
  let listening: http.Server | undefined;
  let port = config.port;
  const tries: number[] = []; // times of recent /pair tries, kept for the global limit
  const stopped = new AbortController();
  let unsubscribe: (() => void) | undefined;

  interface Story {
    pick: PickView;
    title: string;
  }
  const timers = new Set<NodeJS.Timeout>(); // retry and pace timers, cleared on stop
  const inFlight = new Set<string>();
  let lastSend: number | undefined;
  let slot: Story | undefined;
  let paceTimer: NodeJS.Timeout | undefined;
  let quietUntil = 0;

  // The relay refuses a title over 200 code points and never cuts one, so the cut happens here, after the link check on the whole headline.
  function titleOf(raw: string): string | null {
    const full = clean(raw);
    return !full || hasLink(full) ? null : checkTitle(Array.from(full).slice(0, 200).join(''));
  }

  const rank = (s: Story) => (s.pick.level === 'emergency' ? 2 : 1);

  function onNotify(picks: PickView[]) {
    try {
      const now = Date.now();
      if (now < quietUntil) return;
      const tried = new Set(readNotified(dir).map((e) => e.articleId));
      const stories: Story[] = [];
      for (const pick of picks) {
        if (tried.has(pick.id) || inFlight.has(pick.id) || slot?.pick.id === pick.id) continue;
        const title = titleOf(pick.title);
        if (title !== null) stories.push({ pick, title });
      }
      const story = stories.find((s) => s.pick.level === 'emergency') ?? stories[0];
      if (!story) return;
      if (rank(story) === 2 || lastSend === undefined || now - lastSend >= PACE_MS) return send(story);
      if (!slot || rank(slot) < rank(story)) slot = story;
      if (!paceTimer) armPace();
    } catch {
      ctx.log.warn('A notification could not be prepared.');
    }
  }

  function armPace() {
    if (paceTimer) timers.delete(paceTimer), clearTimeout(paceTimer);
    paceTimer = undefined;
    if (!slot || lastSend === undefined) return;
    const t = (paceTimer = setTimeout(() => {
      timers.delete(t);
      paceTimer = undefined;
      const story = slot;
      slot = undefined;
      if (story && Date.now() >= quietUntil) send(story);
    }, Math.max(0, lastSend + PACE_MS - Date.now())));
    timers.add(t);
  }

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => (timers.delete(t), resolve()), ms);
      timers.add(t);
    });

  function send(story: Story) {
    void deliver(story).catch(() => ctx.log.warn('A notification could not be sent.')); // never reject out of the plugin
  }

  async function post(body: unknown): Promise<{ status: number; retryAfter?: number }> {
    try {
      const res = await fetch(new URL('/api/pod/notify', app!), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(SEND_TIMEOUT_MS), stopped.signal]),
      });
      void res.body?.cancel().catch(() => {});
      const given = res.headers.get('retry-after');
      return { status: res.status, retryAfter: given && /^\d+$/.test(given) ? Number(given) : undefined };
    } catch {
      return { status: 0 }; // a network error, a timeout or a refused redirect
    }
  }

  // What an answer means. Returns how long to wait before the one retry, or undefined when the story is done.
  function answered(res: { status: number; retryAfter?: number }, id: string, sent: string): number | undefined {
    const { status, retryAfter } = res;
    if (status === 200) return;
    if (status === 401 || status === 410) {
      // The phone may have stored a newer pass while this one was in flight.
      if (readPasses(dir)[id]?.capability === sent) {
        setPass(dir, id, undefined);
        ctx.log.warn("A phone's notification pass was refused. Open the app on that phone to get a new one.");
      }
      return;
    }
    if (status === 400) return void ctx.log.warn('relay_bad_request');
    if (status === 429) {
      if (retryAfter === undefined) return;
      if (retryAfter > QUIET_OVER_S) return void (quietUntil = Date.now() + retryAfter * 1000);
      return retryAfter * 1000;
    }
    if (status === 0 || status >= 500) return RETRY_MS;
    ctx.log.debug(`status_${status}`);
  }

  async function deliver(story: Story) {
    const id = listDevices(dir)[0]?.id;
    const entry = id ? readPasses(dir)[id] : undefined;
    if (!id || !entry) return;
    if (entry.expiresAt * 1000 <= Date.now()) {
      setPass(dir, id, undefined);
      return ctx.log.warn("A phone's notification pass has expired. Open the app on that phone to get a new one.");
    }
    const now = Date.now();
    lastSend = now;
    armPace();
    recordNotified(dir, story.pick.id, now); // before the request: a crash must not send the story twice
    inFlight.add(story.pick.id);
    const body = { capability: entry.capability, title: story.title, ...(PICK_ID.test(story.pick.id) ? { pickId: story.pick.id } : {}) };
    try {
      const delay = answered(await post(body), id, entry.capability);
      if (delay === undefined || stopped.signal.aborted) return;
      await wait(delay);
      if (stopped.signal.aborted || readPasses(dir)[id]?.capability !== entry.capability) return;
      answered(await post(body), id, entry.capability);
    } finally {
      inFlight.delete(story.pick.id);
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
        const pass = readPasses(dir)[device.id];
        const appNotifications = !app ? 'off' : pass && pass.expiresAt * 1000 > Date.now() ? 'on' : 'needs_pass';
        sendJson(res, 200, { ...(await services.reading.status()), podName: config.podName, ...services.display.versions(), appNotifications, relayOrigin: app });
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
    // The phone's pass for the app notifier: a capability and when it ends, or `{}` to stop notifications.
    'POST /push-pass': {
      limit: 2048,
      run: (res, b, device) => {
        if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_request');
        const keys = Object.keys(b);
        if (keys.length === 0) setPass(dir, device.id, undefined);
        else if (keys.length === 2 && typeof b.capability === 'string' && b.capability && typeof b.expiresAt === 'number' && Number.isFinite(b.expiresAt)) setPass(dir, device.id, { capability: b.capability, expiresAt: b.expiresAt });
        else throw new HttpError(400, 'bad_request');
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
      // Without the app notifier a stored pass is never used, so it is not kept.
      if (app) unsubscribe = services.events.on('notify', onNotify);
      else clearPasses(dir);
    },
    async stop() {
      stopped.abort();
      unsubscribe?.();
      unsubscribe = undefined;
      for (const t of timers) clearTimeout(t);
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

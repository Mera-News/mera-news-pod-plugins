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
  readPairing,
  removeDevice,
  sha256,
  lastSeen,
  touchDevice,
  writePairing,
} from './store';

export const podApi = 2 as const;
export const name = 'sync';

const MB = 1024 * 1024;
const TRIES_PER_MINUTE = 5;

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
  const dir = ctx.dataDir;
  let listening: http.Server | undefined;
  let port = config.port;
  const tries: number[] = []; // times of recent /pair tries, kept for the global limit

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
    const deviceName = typeof body.deviceName === 'string' && body.deviceName.trim() ? body.deviceName.trim().slice(0, 64) : 'Phone';
    const token = randomBytes(32).toString('base64url');
    const firstDevice = listDevices(dir).length === 0;
    const device = addDevice(dir, deviceName, token);
    const hasProfile = await services.profile.hasProfile();
    ctx.log.info('A device was paired.');
    sendJson(res, 200, { deviceId: device.id, token, podName: config.podName, hasProfile, firstDevice });
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

  const routes: Record<string, { limit: number; aloneOnly?: boolean; run(res: http.ServerResponse, body: any, device: Device): Promise<void> | void }> = {
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
    'POST /profile/replace': {
      limit: 8 * MB,
      // Replacing the profile is offered only to a device paired while no other was. It must still be
      // the only one: once a second device pairs, the profile is theirs too.
      aloneOnly: true,
      run: async (res, b) => {
        await services.profile.replaceProfile({ schemaVersion: b.schemaVersion, tables: b.tables });
        sendJson(res, 200, {});
      },
    },
    'POST /v1/chat/completions': { limit: 2 * MB, run: (res, b) => chat(res, b) },
    'POST /graphql': { limit: 2 * MB, run: async (res, b) => sendJson(res, 200, await services.news.graphql(b)) },
    'GET /status': {
      limit: 0,
      run: async (res) => sendJson(res, 200, { ...(await services.reading.status()), podName: config.podName, ...services.display.versions() }),
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
      if (route.aloneOnly && listDevices(dir).length !== 1) return sendJson(res, 403, { error: 'not_only_device' });
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
    },
    async stop() {
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

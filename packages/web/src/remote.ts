// Reaching the website from a phone. The plugin keeps listening on 127.0.0.1 only; a forwarder on
// this computer (tailscale serve, or a tunnel) brings HTTPS requests for one public name to it. A
// phone gets in once with a pairing code and then keeps a device session until it is removed.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { sameSecret } from './guard';

export const REMOTE_FILE = 'remote.json';
export const DEVICES_FILE = 'devices.json';
export const PAIRING_FILE = 'pairing.json';
export const PAIR_MS = 10 * 60_000;
export const MAX_WRONG_CODES = 10;
export const TRIES_PER_MINUTE = 5;
export const MAX_DEVICES = 10;
// __Host- makes the browser keep it only from a secure origin, for this host and every path.
export const DEVICE_COOKIE = '__Host-mera-device';
// Browsers keep a cookie at most 400 days; it is sent again with every answer, so it lasts while used.
const COOKIE_MAX_AGE = 400 * 86_400;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Remote {
  /** The port this website keeps, with the config's port it was chosen for. */
  port?: { configured: number; port: number };
  publicHost?: string;
}

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  pairedAt: string;
}

interface Pairing {
  codeHash: string;
  expiresAt: number;
  wrong: number;
}

/** A JSON file only this user can read, never read through a link; a missing file is undefined. */
function readSecret<T>(file: string): T | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) throw new Error(`${file} is not a plain file. Remove it.`);
  if (stat.mode & 0o077) throw new Error(`${file} can be read by other users. Fix it with: chmod 600 ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeSecret(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*\\.(?=[a-z0-9-]*[a-z])${LABEL}$`);

/** One https name such as mac.tail1234.ts.net, also taken as a pasted https address; otherwise null. */
export function parsePublicHost(input: string): string | null {
  const name = input.trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/$/, '');
  return HOST.test(name) ? name : null;
}

const LOOPBACK_PEERS = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Whether a forwarder brought this request. A forwarder keeps whatever Host the browser sent, so a
 * request through it naming 127.0.0.1 must not count as one made on this computer. Every forwarder
 * this site expects (tailscale serve, ngrok, cloudflared) adds one of these headers.
 */
export const forwarded = (headers: http.IncomingHttpHeaders) => ['forwarded', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host'].some((h) => headers[h] !== undefined);

/**
 * Whether a request came through the public name: its Host is that name, and the forwarder on this
 * computer says the browser used HTTPS. X-Forwarded-Proto is believed only from a loopback peer,
 * which is the only peer the forwarder can be.
 */
export function viaPublic(headers: http.IncomingHttpHeaders, peer: string | undefined, publicHost: string | undefined): boolean {
  if (!publicHost || !peer || !LOOPBACK_PEERS.includes(peer)) return false;
  const host = (headers.host ?? '').toLowerCase();
  if (host !== publicHost && host !== `${publicHost}:443`) return false;
  const proto = headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim().toLowerCase() === 'https';
}

export const deviceCookie = (token: string) => `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
export const clearedCookie = `${DEVICE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
export const tokenFromCookie = (header: string | undefined) => new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE}=([\\w-]{43})(?:;|$)`).exec(header ?? '')?.[1];

/** The name a phone gives itself, kept short and plain because the device list shows it. */
export const deviceName = (input: unknown) => {
  const name = typeof input === 'string' ? input.replace(/[^\p{L}\p{N} ._'-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
  return name || 'Phone';
};

/** The command that brings HTTPS from the person's tailnet to this website, which stays on 127.0.0.1. */
export const tailscaleCommand = (port: number) => `tailscale serve --bg --https=443 http://127.0.0.1:${port}`;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

export type PairResult = { ok: true; device: Device; token: string } | { ok: false; status: number; error: string };

/** The phone's files in the web plugin's data folder. Every call reads the disk, so a removal holds at once. */
export function createRemote(dir: string) {
  const file = (name: string) => path.join(dir, name);
  const tries: number[] = [];

  const remote = (): Remote => readSecret<Remote>(file(REMOTE_FILE)) ?? {};
  const devices = (): Device[] => readSecret<Device[]>(file(DEVICES_FILE)) ?? [];

  return {
    remote,
    saveRemote: (r: Remote) => writeSecret(file(REMOTE_FILE), r),
    devices,

    /** A new code, which only its hash outlives; it voids the code before it. */
    startPairing(now = Date.now()): { code: string; expiresAt: number } {
      // 256 is a multiple of 32, so each byte maps onto the alphabet without bias.
      const code = Array.from(randomBytes(10), (b) => BASE32[b % 32]).join('');
      const expiresAt = now + PAIR_MS;
      writeSecret(file(PAIRING_FILE), { codeHash: sha256(code), expiresAt, wrong: 0 } satisfies Pairing);
      return { code, expiresAt };
    },
    clearPairing: () => rmSync(file(PAIRING_FILE), { force: true }),

    /** Every paired phone and any code on screen: a phone paired for one address never comes back with another. */
    clearPhones() {
      rmSync(file(PAIRING_FILE), { force: true });
      rmSync(file(DEVICES_FILE), { force: true });
    },

    /**
     * Swaps a code for a device token: 5 tries a minute, 10 wrong codes close the pairing, and a code
     * works once. A phone already paired (its token in `current`) gets a new token in its own entry.
     */
    pair(code: unknown, name: string, now = Date.now(), current?: string): PairResult {
      while (tries.length && now - tries[0] >= 60_000) tries.shift();
      if (tries.length >= TRIES_PER_MINUTE) return { ok: false, status: 429, error: 'too_many_tries' };
      tries.push(now);
      const pending = readSecret<Pairing>(file(PAIRING_FILE));
      if (!pending || now >= pending.expiresAt || pending.wrong >= MAX_WRONG_CODES) return { ok: false, status: 403, error: 'pairing_closed' };
      const given = typeof code === 'string' ? normalizeCode(code) : '';
      if (!sameSecret(sha256(given), pending.codeHash)) {
        writeSecret(file(PAIRING_FILE), { ...pending, wrong: pending.wrong + 1 });
        return { ok: false, status: 403, error: 'wrong_code' };
      }
      const same = this.device(current);
      const list = devices().filter((d) => d.id !== same?.id);
      if (list.length >= MAX_DEVICES) return { ok: false, status: 409, error: 'too_many_devices' };
      rmSync(file(PAIRING_FILE), { force: true });
      const token = randomBytes(32).toString('base64url');
      const device: Device = { id: same?.id ?? randomBytes(8).toString('hex'), name, tokenHash: sha256(token), pairedAt: new Date(now).toISOString() };
      writeSecret(file(DEVICES_FILE), [...list, device]);
      return { ok: true, device, token };
    },

    /** The paired device a cookie's token belongs to. */
    device(token: string | undefined): Device | undefined {
      if (!token) return undefined;
      const hash = sha256(token);
      let found: Device | undefined;
      for (const d of devices()) if (sameSecret(hash, d.tokenHash)) found = d;
      return found;
    },

    removeDevice(id: string): boolean {
      const list = devices();
      if (!list.some((d) => d.id === id)) return false;
      writeSecret(file(DEVICES_FILE), list.filter((d) => d.id !== id));
      return true;
    },
  };
}

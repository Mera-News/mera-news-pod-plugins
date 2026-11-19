import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CODE_MINUTES = 10;
export const MAX_WRONG_CODES = 10;

export const syncDir = (home: string) => path.join(path.resolve(home), 'data', 'plugins', 'sync');

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  pairedAt: string;
}

export interface Pairing {
  codeHash: string;
  expiresAt: number;
  wrong: number;
}

/** Reads a JSON file only the owner can read; a missing file is `undefined`, a bad one throws a plain sentence. */
function readSecretJson<T>(file: string): T | undefined {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    return undefined;
  }
  // A link could point the read at a file someone else controls.
  if (!stat.isFile()) throw new Error(`${file} is not a plain file. Remove it.`);
  if (stat.mode & 0o077) throw new Error(`${file} can be read by other users. Fix it with: chmod 600 ${file}`);
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function writeSecretJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const devicesFile = (dir: string) => path.join(dir, 'devices.json');
// Last seen times live apart from the devices, so a request never rewrites the devices file: a write
// from the running pod could otherwise put back a device the command line had just revoked.
const seenFile = (dir: string) => path.join(dir, 'seen.json');
const pairingFile = (dir: string) => path.join(dir, 'pairing.json');

// Read from disk on every call, so a revoke from the command line takes effect at once.
export const listDevices = (dir: string): Device[] => readSecretJson<Device[]>(devicesFile(dir)) ?? [];

export function addDevice(dir: string, name: string, token: string): Device {
  const devices = listDevices(dir);
  const now = new Date().toISOString();
  const device: Device = { id: randomBytes(8).toString('hex'), name, tokenHash: sha256(token), pairedAt: now };
  writeSecretJson(devicesFile(dir), [...devices, device]);
  return device;
}

export function removeDevice(dir: string, id: string): boolean {
  const devices = listDevices(dir);
  if (!devices.some((d) => d.id === id)) return false;
  writeSecretJson(devicesFile(dir), devices.filter((d) => d.id !== id));
  setPass(dir, id, undefined); // the command line revokes through here too, so a revoked phone is never notified
  return true;
}

/** What the app notifier needs for one device, kept apart from the devices file like the seen times. */
export interface PassEntry {
  capability: string;
  expiresAt: number;
}

const passFile = (dir: string) => path.join(dir, 'push-pass.json');

export const readPasses = (dir: string): Record<string, PassEntry> => readSecretJson<Record<string, PassEntry>>(passFile(dir)) ?? {};

/** Stores one device's pass, or removes it when `entry` is undefined. Other devices' passes are untouched. */
export function setPass(dir: string, id: string, entry: PassEntry | undefined): void {
  const all = readPasses(dir);
  if (!entry && !(id in all)) return;
  const { [id]: _old, ...rest } = all;
  writeSecretJson(passFile(dir), entry ? { ...rest, [id]: entry } : rest);
}

export const clearPasses = (dir: string) => rmSync(passFile(dir), { force: true });

const NOTIFIED_KEEP = 100;
const NOTIFIED_DAYS = 7;
const notifiedFile = (dir: string) => path.join(dir, 'notified.json');

export interface Notified {
  articleId: string;
  at: number;
}

export const readNotified = (dir: string): Notified[] => readSecretJson<Notified[]>(notifiedFile(dir)) ?? [];

/** Remembers that a story was tried: the newest 100 of the last 7 days. */
export function recordNotified(dir: string, articleId: string, now: number): void {
  const fresh = readNotified(dir).filter((e) => now - e.at < NOTIFIED_DAYS * 86_400_000);
  writeSecretJson(notifiedFile(dir), [...fresh, { articleId, at: now }].slice(-NOTIFIED_KEEP));
}

/** When each device was last seen, by id. */
export const lastSeen = (dir: string): Record<string, string> => readSecretJson<Record<string, string>>(seenFile(dir)) ?? {};

export function touchDevice(dir: string, id: string): void {
  writeSecretJson(seenFile(dir), { ...lastSeen(dir), [id]: new Date().toISOString() });
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, '');

/** Writes a new pending code (only its hash) and returns the code, which is shown once. */
export function createPairing(dir: string): string {
  // 256 is a multiple of 32, so a byte maps onto the alphabet without bias.
  const code = Array.from(randomBytes(10), (b) => BASE32[b % 32]).join('');
  writeSecretJson(pairingFile(dir), { codeHash: sha256(code), expiresAt: Date.now() + CODE_MINUTES * 60_000, wrong: 0 } satisfies Pairing);
  return code;
}

export const readPairing = (dir: string) => readSecretJson<Pairing>(pairingFile(dir));
export const writePairing = (dir: string, p: Pairing) => writeSecretJson(pairingFile(dir), p);
export const clearPairing = (dir: string) => rmSync(pairingFile(dir), { force: true });

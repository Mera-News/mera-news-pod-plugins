// A link that opens the Mera News website already signed in: the site's address with a one-time
// code, signed with a key the web plugin writes at every start, so a restart voids every code.
// The mcp and web packages each carry this file, byte for byte, so each builds on its own.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const LINK_TTL_MS = 10 * 60_000;
export const LINK_KEY_FILE = 'link-key';
export const ADDRESS_FILE = 'address.json';

const sign = (key: string, body: string) => createHmac('sha256', key).update(body).digest('base64url');

/** Version, expiry, a random id, and the signature over the three. */
export function mintCode(key: string, now = Date.now()): string {
  const body = `v1.${now + LINK_TTL_MS}.${randomBytes(12).toString('base64url')}`;
  return `${body}.${sign(key, body)}`;
}

/** The code's id and expiry when it carries this key's signature and has not expired; otherwise null. */
export function checkCode(key: string, code: unknown, now = Date.now()): { id: string; expires: number } | null {
  const m = typeof code === 'string' ? /^v1\.(\d{1,15})\.([\w-]{16})\.([\w-]{43})$/.exec(code) : null;
  if (!m) return null;
  const expected = Buffer.from(sign(key, `v1.${m[1]}.${m[2]}`));
  if (!timingSafeEqual(Buffer.from(m[3]), expected)) return null;
  const expires = Number(m[1]);
  return expires > now ? { id: m[2], expires } : null;
}

/** Reads a file only this user can read, and never through a link. Throws a plain sentence. */
export function readPrivate(file: string): string {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    throw new Error(`There is no file at ${file}.`);
  }
  if (!stat.isFile()) throw new Error(`${file} is not a plain file.`);
  if (stat.mode & 0o077) throw new Error(`${file} can be read by other users. Fix it with: chmod 600 ${file}`);
  return readFileSync(file, 'utf8').trim();
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The website's address with a new one-time code, from the files the running web plugin keeps in
 * its data directory. Throws a plain sentence when the website is not running.
 */
export function siteLink(webDir: string, now = Date.now()): string {
  let address: { port?: unknown; pid?: unknown } = {};
  try {
    address = JSON.parse(readFileSync(path.join(webDir, ADDRESS_FILE), 'utf8'));
  } catch {
    // no file: not running
  }
  const { port, pid } = address;
  if (!Number.isInteger(port) || !Number.isInteger(pid) || !alive(pid as number)) throw new Error('The Mera News website is not running.');
  return `http://127.0.0.1:${port}/#c=${mintCode(readPrivate(path.join(webDir, LINK_KEY_FILE)), now)}`;
}

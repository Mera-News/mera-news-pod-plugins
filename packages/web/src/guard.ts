import { createHash, timingSafeEqual } from 'node:crypto';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** Compares two secrets without leaking where they differ or how long they are. */
export const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

const hostname = (hostHeader: string) => hostHeader.toLowerCase().replace(/:\d+$/, '');

export function hostAllowed(hostHeader: string | undefined, publicHost: string | undefined): boolean {
  if (!hostHeader) return false;
  const name = hostname(hostHeader);
  return LOCAL_HOSTS.includes(name) || (publicHost !== undefined && (name === hostname(publicHost) || hostHeader.toLowerCase() === publicHost.toLowerCase()));
}

export function originAllowed(origin: string | undefined, publicHost: string | undefined): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin.replace(/\/$/, '')) return false;
  if (url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname)) return true;
  return publicHost !== undefined && url.origin === `https://${publicHost.toLowerCase()}`;
}

import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const tokenPath = (home: string) => path.join(path.resolve(home), 'data', 'plugins', 'mcp', 'token');

/** Reads the token, refusing a file that group or others can read. Throws a plain sentence. */
export function readToken(home: string): string {
  const file = tokenPath(home);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch {
    throw new Error(`There is no token at ${file}. Create one with: mera-news-pod-mcp token --rotate`);
  }
  // A link could point the read at a file someone else controls; the token is always a plain file.
  if (!stat.isFile()) throw new Error(`The token at ${file} is not a plain file. Remove it and run: mera-news-pod-mcp token --rotate`);
  if (stat.mode & 0o077) {
    throw new Error(`The token file ${file} can be read by other users. Fix it with: chmod 600 ${file}`);
  }
  return readFileSync(file, 'utf8').trim();
}

/** Writes a new random token readable only by its owner and returns it. */
export function rotateToken(home: string): string {
  const file = tokenPath(home);
  const token = randomBytes(32).toString('base64url');
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its old mode on write
  return token;
}

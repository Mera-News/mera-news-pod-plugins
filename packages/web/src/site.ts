import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface SiteFile {
  body: Buffer;
  headers: Record<string, string>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;

/**
 * The page's policy: its own files, its inline scripts by hash, publishers' images over https, and
 * no request to any other host.
 */
export function csp(html: string): string {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
  return [
    "default-src 'none'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Every file of the static export, read once, by the exact path a browser asks for. Nothing else is
 * served: a request path is only looked up here, never joined onto a folder. Links are skipped.
 */
export function loadSite(dir: string): Map<string, SiteFile> {
  const files = new Map<string, SiteFile>();
  const walk = (rel: string) => {
    for (const name of readdirSync(path.join(dir, rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      const stat = lstatSync(path.join(dir, relPath));
      if (stat.isDirectory()) walk(relPath);
      if (!stat.isFile()) continue;
      const type = TYPES[path.extname(name)];
      if (!type) continue;
      const body = readFileSync(path.join(dir, relPath));
      const headers: Record<string, string> = {
        'content-type': type,
        'cache-control': relPath.startsWith('_next/static/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      };
      if (type.startsWith('text/html')) headers['content-security-policy'] = csp(body.toString('utf8'));
      const file = { body, headers };
      files.set(`/${relPath}`, file);
      // trailingSlash export: /world/ is world/index.html, and /world serves it too.
      if (name === 'index.html') {
        files.set(`/${rel}${rel ? '/' : ''}`, file);
        if (rel) files.set(`/${rel}`, file);
      }
    }
  };
  walk('');
  if (!files.has('/')) throw new Error('The website files have no index.html.');
  return files;
}

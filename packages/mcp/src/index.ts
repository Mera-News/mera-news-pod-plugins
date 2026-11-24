import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { PluginContext, PluginModule, PodPlugin } from 'mera-news-pod/plugin-api';
import { readToken, rotateToken } from './bin/token';
import { hostAllowed, originAllowed, sameSecret } from './guard';
import { HINT_FILE, hintOf, writeJson } from './digest';
import { buildServer } from './tools';

export const podApi = 2 as const;
export const name = 'mcp';

interface Config {
  host: string;
  port: number;
  publicHost?: string;
  capabilityUrl: boolean;
}

function readConfig(raw: unknown): Config {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const port = c.port === undefined ? 8787 : c.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('The mcp plugin needs "port" to be a whole number from 0 to 65535.');
  }
  for (const key of ['host', 'publicHost'] as const) {
    if (c[key] !== undefined && typeof c[key] !== 'string') throw new Error(`The mcp plugin needs "${key}" to be text.`);
  }
  return {
    host: (c.host as string | undefined) ?? '127.0.0.1',
    port,
    publicHost: c.publicHost as string | undefined,
    capabilityUrl: c.capabilityUrl === true,
  };
}

export const createPlugin: PluginModule['createPlugin'] = (ctx: PluginContext): PodPlugin => {
  if (ctx.podApi !== 2) throw new Error('The mcp plugin needs plugin API version 2, and this pod gave version 1.');
  const v2 = ctx;
  const config = readConfig(ctx.config);
  // The pod gives this plugin `<home>/data/plugins/mcp`, which is where the bridge and the bin look.
  const tokenFile = path.join(ctx.dataDir, 'token');
  const handler = createMcpHandler(() => buildServer(v2), { legacy: 'stateless', onerror: () => ctx.log.error('The MCP handler failed.') });
  const serve = toNodeHandler(handler, { onerror: () => ctx.log.error('A request could not be served.') });
  let listening: http.Server | undefined;
  let port = config.port;

  const refuse = (res: http.ServerResponse, status: number) => void res.writeHead(status).end();
  // RFC 6750 section 3: the bearer scheme on every 401, an error code only when a token was sent and
  // was wrong. No resource_metadata: the pod offers no OAuth to discover. The body stays empty.
  const challenge = (res: http.ServerResponse, tokenSent: boolean) =>
    void res
      .writeHead(401, { 'www-authenticate': `Bearer realm="mera-news-pod"${tokenSent ? ', error="invalid_token"' : ''}` })
      .end();

  function onRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!hostAllowed(req.headers.host, config.publicHost)) return refuse(res, 403);
    if (!originAllowed(req.headers.origin, config.publicHost)) return refuse(res, 403);

    const pathname = (req.url ?? '').split('?')[0];
    const viaPath = config.capabilityUrl ? /^\/mcp\/([^/]+)$/.exec(pathname) : null; // the token is url-safe, so no decoding
    if (pathname !== '/mcp' && !viaPath) return refuse(res, 404);

    let expected: string;
    try {
      expected = readToken(tokenFile);
      if (!expected) throw new Error('empty');
    } catch {
      ctx.log.warn('The token file cannot be used, so every request is refused.');
      return challenge(res, false);
    }
    const given = viaPath ? viaPath[1] : /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!sameSecret(given, expected)) return challenge(res, given !== '');

    req.url = '/mcp';
    void serve(req, res);
  }

  return {
    async start() {
      if (!existsSync(tokenFile)) {
        rotateToken(tokenFile);
        ctx.log.info(`A token was created at ${tokenFile}. Read it from that file.`);
      }
      readToken(tokenFile); // fail at start, in plain words, if the file cannot be trusted
      const server = http.createServer(onRequest);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, resolve);
      });
      listening = server;
      port = (server.address() as AddressInfo).port;
      // The session hint's fact count, fresh at every start; the tools that change facts update it.
      // Not awaited: the status waits on the data server, which would hold up the tools.
      void v2.services.reading
        .status()
        .then((s) => writeJson(path.join(ctx.dataDir, HINT_FILE), hintOf(s)))
        .catch(() => ctx.log.warn('The session hint file could not be written.'));
    },
    async stop() {
      const server = listening;
      listening = undefined;
      if (!server) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handler.close();
    },
    describe() {
      const url = `http://127.0.0.1:${port}/mcp`;
      const home = path.resolve(ctx.dataDir, '..', '..', '..');
      const lines = [
        `MCP address: ${url}`,
        `Header for an MCP client: Authorization: Bearer <the token in ${tokenFile}>`,
      ];
      if (config.capabilityUrl) {
        const base = config.publicHost ? `https://${config.publicHost}` : `http://127.0.0.1:${port}`;
        lines.push(`Address with the token in it, for a remote client: mera-news-pod-mcp url --base ${base} --home ${home}`);
      }
      return lines;
    },
  };
};

import { mkdirSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { PluginContext, PodPlugin, PodServices, PodStatus } from 'mera-news-pod/plugin-api';
import { createPlugin } from '../src';

export const SITE = path.resolve(__dirname, '..', 'site', 'out');

export const STATUS = {
  reading: 'paused',
  everyMinutes: 15,
  readingNow: false,
  firstReadDone: false,
  lastRunAt: null,
  nextReadAt: null,
  unscored: 0,
  counts: { facts: 2, topics: 9, topicsPending: 0, picks: 0 },
  problems: [],
  limits: [],
  ai: null,
  dataServer: { host: 'api.mera.news' },
} satisfies PodStatus;

export interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface Running {
  plugin: PodPlugin;
  dataDir: string;
  logs: string[];
  port(): number;
  origin(): string;
  request(o: { path?: string; method?: string; headers?: Record<string, string | undefined>; body?: string | Buffer }): Promise<Reply>;
  session(code: string): Promise<Reply>;
  stop(): Promise<void>;
}

/** The web plugin on fake services, serving the built export, on a free port. */
export async function run(opts: { status?: () => Promise<PodStatus>; services?: Partial<PodServices>; config?: object; before?: (dataDir: string) => void } = {}): Promise<Running> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'web-plugin-'));
  const dataDir = path.join(home, 'data', 'plugins', 'web');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  opts.before?.(dataDir);
  const logs: string[] = [];
  const log = (m: string) => void logs.push(m);
  const services = { reading: { status: opts.status ?? (async () => STATUS) }, ...opts.services } as unknown as PodServices;
  const ctx: PluginContext = { podApi: 2, meraNewsApp: null, services, config: { port: 0, ...opts.config }, dataDir, log: { debug: log, info: log, warn: log, error: log }, estimateTokens: (t) => t.length / 4 };
  const plugin = await createPlugin(ctx);
  await plugin.start();
  const port = () => Number(/127\.0\.0\.1:(\d+)/.exec(plugin.describe!()[0])![1]);
  const origin = () => `http://127.0.0.1:${port()}`;
  const request: Running['request'] = ({ path: p = '/', method = 'GET', headers = {}, body }) =>
    new Promise((resolve, reject) => {
      const h: Record<string, string> = { host: `127.0.0.1:${port()}` };
      for (const [k, v] of Object.entries(headers)) if (v === undefined) delete h[k];
      else h[k] = v;
      const req = http.request({ host: '127.0.0.1', port: port(), path: p, method, headers: h, setHost: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('no answer within 5 seconds')));
      req.on('error', reject);
      req.end(body);
    });
  return {
    plugin,
    dataDir,
    logs,
    port,
    origin,
    request,
    session: (code) =>
      request({ path: '/api/session/', method: 'POST', headers: { origin: origin(), 'content-type': 'application/json' }, body: JSON.stringify({ code }) }),
    stop: () => plugin.stop(),
  };
}

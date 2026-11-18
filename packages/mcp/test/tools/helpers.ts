import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { PluginContext, PodServices, PodStatus, PickView } from 'mera-news-pod/plugin-api';
import { createPlugin } from '../../src';

export const TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz0123456789';

export const status = (over: Partial<PodStatus> = {}): PodStatus => ({
  reading: 'on',
  everyMinutes: 60,
  readingNow: false,
  firstReadDone: true,
  lastRunAt: '2026-01-01T00:00:00.000Z',
  nextReadAt: '2026-01-01T01:00:00.000Z',
  unscored: 0,
  counts: { facts: 1, topics: 2, topicsPending: 0, picks: 3 },
  problems: [],
  limits: [],
  ai: { host: 'ai.example', model: 'm' },
  dataServer: { host: 'data.example' },
  ...over,
});

export const pick = (i: number): PickView => ({
  id: `p${i}`,
  title: `Title number ${i} of a news story`,
  publication: 'The Paper',
  url: `https://news.example/story/${i}`,
  publishedAt: '2026-01-01T00:00:00.000Z',
  level: 'medium',
  lang: 'en',
  reason: `This story matters to the person because of their saved fact number ${i}, which it touches directly.`,
  facts: ['Lives in Utrecht'],
});

export function fakeServices(over: Partial<PodServices> = {}): PodServices {
  return {
    profile: {
      get: async () => ({ facts: [] }),
      addFacts: async (s) => ({ added: s.map((statement, i) => ({ id: `f${i}`, statement })), already: [], refused: [] }),
      removeFacts: async (ids) => ({ removed: ids.map((id) => ({ id, statement: 'x', topics: ['t'] })), notFound: [] }),
      editTopics: async (e) => ({ results: [...(e.remove ?? []).map((id, index) => ({ op: 'remove' as const, index, ok: true, id }))] }),
    },
    suggestions: {
      get: async () => ({ state: 'ok', hint: 'Fine.', nextReadAt: null, picks: [pick(1)], cursor: 'a.1', more: false }),
    },
    reading: { status: async () => status(), set: async (c) => status({ reading: c.paused ? 'paused' : 'on', everyMinutes: c.everyMinutes ?? 60 }) },
    ...over,
  };
}

/**
 * Suggestions that keep the services' promise: a page is cut until `fits` passes (never below one
 * pick), and only the picks returned count as delivered.
 */
export function deliveringSuggestions(all: PickView[]): PodServices['suggestions'] {
  let delivered = 0;
  return {
    get: async ({ limit, fits }) => {
      let page = all.slice(delivered, delivered + limit);
      while (fits && page.length > 1 && !fits(page)) page = page.slice(0, -1);
      delivered += page.length;
      return { state: 'ok', hint: 'Reading is on.', nextReadAt: null, picks: page, cursor: `e.${delivered}`, more: delivered < all.length };
    },
  };
}

export const estimate = (text: string) => Math.ceil(text.length / 4);

export interface Running {
  url: string;
  port: number;
  home: string;
  writeToken(token: string, mode?: number): void;
  client(token?: string): Promise<Client>;
  raw(options: { path?: string; headers?: Record<string, string>; method?: string; body?: string }): Promise<{ status: number; body: string }>;
  stop(): Promise<void>;
}

export async function run(opts: { services?: PodServices; config?: unknown; token?: string | null } = {}): Promise<Running> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mcp-tools-'));
  const dataDir = path.join(home, 'data', 'plugins', 'mcp');
  mkdirSync(dataDir, { recursive: true });
  const writeToken = (t: string, mode = 0o600) => {
    writeFileSync(path.join(dataDir, 'token'), `${t}\n`, { mode });
    chmodSync(path.join(dataDir, 'token'), mode);
  };
  if (opts.token !== null) writeToken(opts.token ?? TOKEN);
  const ctx: PluginContext = {
    podApi: 1,
    services: opts.services ?? fakeServices(),
    config: { port: 0, ...(opts.config as object | undefined) },
    dataDir,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    estimateTokens: estimate,
  };
  const plugin = await createPlugin(ctx);
  await plugin.start();
  const url = plugin.describe!()[0].replace('MCP address: ', '');
  const port = Number(new URL(url).port);
  const clients: Client[] = [];
  return {
    url,
    port,
    home,
    writeToken,
    async client(token = TOKEN) {
      const c = new Client({ name: 'test', version: '0' });
      await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(c);
      return c;
    },
    raw: ({ path: p = '/mcp', headers = {}, method = 'POST', body = '{}' }) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
          let data = '';
          res.on('data', (d) => (data += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        });
        req.setTimeout(3000, () => req.destroy(new Error('no answer within 3 seconds')));
        req.on('error', reject);
        req.end(body);
      }),
    async stop() {
      await Promise.allSettled(clients.map((c) => c.close()));
      await plugin.stop();
    },
  };
}

export const json = (result: { content?: unknown }) => JSON.parse(((result.content as { text: string }[])[0]).text);

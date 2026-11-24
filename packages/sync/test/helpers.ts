import { mkdirSync, mkdtempSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { PickLevel, PickView, PluginContext, PodServices, PodStatus, Snapshot } from 'mera-news-pod/plugin-api';
import { createPlugin } from '../src';
import { createPairing } from '../src/store';

export const SCHEMA = 7;
export const REGISTRY = 3;

export const status = (over: Partial<PodStatus> = {}): PodStatus => ({
  reading: 'on',
  everyMinutes: 60,
  readingNow: false,
  firstReadDone: true,
  lastRunAt: null,
  nextReadAt: null,
  unscored: 0,
  counts: { facts: 1, topics: 2, topicsPending: 0, picks: 3 },
  problems: [],
  limits: [],
  ai: { host: 'ai.example', model: 'm' },
  dataServer: { host: 'data.example' },
  ...over,
});

export interface Calls {
  snapshot: { hashes?: Record<string, string>; peer?: { schemaVersion: number; registry: number } }[];
  commands: unknown[];
  reading: unknown[];
  chat: { body: unknown; signal?: AbortSignal; extra: number }[];
  graphql: unknown[];
  readNow: number;
  listeners: number;
  /** Hands a batch to every 'notify' listener, as the pod does, and returns what they return. */
  notify(picks: PickView[]): Promise<unknown>;
}

const TABLES: Record<string, Record<string, unknown>[]> = { facts: [{ id: 'f1' }], topics: [{ id: 't1' }] };

function snapshotFor(hashes: Record<string, string> = {}): Snapshot {
  const tables: Snapshot['tables'] = {};
  for (const [name, rows] of Object.entries(TABLES)) {
    const hash = `h-${name}`;
    tables[name] = hashes[name] === hash ? { hash, mode: 'replace' } : { hash, mode: 'replace', rows };
  }
  return { schemaVersion: SCHEMA, registry: REGISTRY, tables };
}

export class Mismatch extends Error {
  code = 'version_mismatch';
}

export function fakeServices(over: Partial<PodServices> = {}): { services: PodServices; calls: Calls } {
  const notifying = new Set<(picks: PickView[]) => unknown>();
  const calls: Calls = { snapshot: [], commands: [], reading: [], chat: [], graphql: [], readNow: 0, listeners: 0, notify: async (picks) => [...notifying].map((l) => l(picks)) };
  const services: PodServices = {
    profile: {
      get: async () => ({ facts: [] }),
      addFacts: async () => ({ added: [], already: [], refused: [] }),
      removeFacts: async () => ({ removed: [], notFound: [] }),
      editTopics: async () => ({ results: [] }),
      addTopics: async () => ({ added: [], skipped: [] }),
    },
    suggestions: { get: async () => ({ state: 'ok', hint: '', nextReadAt: null, picks: [], cursor: 'a.1', more: false }) },
    reading: {
      status: async () => status(),
      set: async (c) => (calls.reading.push(c), status({ reading: c.paused ? 'paused' : 'on' })),
      readNow: async () => {
        calls.readNow++;
        return 'ran';
      },
    },
    commands: {
      run: async (r) => {
        calls.commands.push(r);
        if (r.registry !== REGISTRY) throw new Mismatch('The phone is older than the pod.');
        return { results: r.commands.map((c) => ({ ok: c.name })), snapshot: snapshotFor(r.hashes) };
      },
    },
    model: { chatCompletions: async (body, signal) => (calls.chat.push({ body, signal, extra: 0 }), new Response('{}')) },
    news: { graphql: async (body) => (calls.graphql.push(body), { data: { ok: true } }) },
    display: {
      snapshot: async (o) => {
        calls.snapshot.push(o ?? {});
        if (o?.peer && o.peer.registry !== REGISTRY) throw new Mismatch('The phone is older than the pod.');
        return snapshotFor(o?.hashes);
      },
      versions: () => ({ schemaVersion: SCHEMA, registry: REGISTRY }),
    },
    events: {
      on: ((event: string, listener: (picks: PickView[]) => unknown) => {
        if (event !== 'notify') return () => {};
        calls.listeners++;
        notifying.add(listener);
        return () => (calls.listeners--, void notifying.delete(listener));
      }) as PodServices['events']['on'],
    },
    ...over,
  };
  return { services, calls };
}

export interface Reply {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface Running {
  port: number;
  home: string;
  dataDir: string;
  calls: Calls;
  logs: string[];
  /** Writes a pending pairing code and returns it. */
  newCode(): string;
  /** Pairs a device with a fresh code and returns the reply body. */
  pair(deviceName?: string): Promise<{ deviceId: string; token: string; podName: string }>;
  raw(o: { path: string; method?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply>;
  call(token: string, path: string, body?: unknown, method?: string): Promise<Reply>;
  stop(): Promise<void>;
}

export const pick = (id: string, level: PickLevel = 'high', title = `Headline ${id}`): PickView => ({
  id,
  title,
  publication: 'Paper',
  url: `https://example.org/${id}`,
  publishedAt: '2026-11-18T01:00:00.000Z',
  level,
  lang: 'en',
  reason: 'A reason.',
  facts: [],
});

export async function run(opts: { services?: PodServices; calls?: Calls; config?: object; meraNewsApp?: string | null; home?: string; prepare?: (dataDir: string) => void } = {}): Promise<Running> {
  const home = opts.home ?? mkdtempSync(path.join(os.tmpdir(), 'sync-'));
  const dataDir = path.join(home, 'data', 'plugins', 'sync');
  mkdirSync(dataDir, { recursive: true });
  opts.prepare?.(dataDir);
  const fake = opts.services ? { services: opts.services, calls: opts.calls ?? fakeServices().calls } : fakeServices();
  const logs: string[] = [];
  const log = (level: string) => (m: string, c?: unknown) => void logs.push(`${level} ${m} ${c ? JSON.stringify(c) : ''}`);
  const ctx: PluginContext = {
    podApi: 2,
    meraNewsApp: opts.meraNewsApp ?? null,
    services: fake.services,
    config: { port: 0, podName: 'Test pod', ...opts.config },
    dataDir,
    log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    estimateTokens: (t) => t.length,
  };
  const plugin = await createPlugin(ctx);
  await plugin.start();
  const port = Number(new URL(plugin.describe!()[0].replace('Sync address: ', '')).port);
  const raw: Running['raw'] = ({ path: p, method = 'POST', headers = {}, body }) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers }));
      });
      req.setTimeout(5000, () => req.destroy(new Error('no answer within 5 seconds')));
      req.on('error', reject);
      req.end(body);
    });
  const r: Running = {
    port,
    home,
    dataDir,
    calls: fake.calls,
    logs,
    newCode: () => createPairing(dataDir),
    async pair(deviceName = 'Phone') {
      const code = createPairing(dataDir);
      const res = await raw({ path: '/pair', body: JSON.stringify({ code, deviceName }) });
      if (res.status !== 200) throw new Error(`pairing failed with ${res.status} ${res.body}`);
      return JSON.parse(res.body);
    },
    raw,
    call: (token, p, body, method = 'POST') =>
      raw({ path: p, method, headers: { authorization: `Bearer ${token}` }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) }),
    stop: () => plugin.stop(),
  };
  return r;
}

export interface RelayRequest {
  method?: string;
  url?: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** Date.now() when it arrived, so a test with mocked time can see when each was sent. */
  at: number;
}

export interface Relay {
  origin: string;
  requests: RelayRequest[];
  /** What the next requests get; defaults to 200. */
  answer: Answer;
  /** Answers used first, one per request, before `answer`. */
  queue: Answer[];
  /** Called as each request arrives, before it is answered. */
  onRequest?: (r: RelayRequest) => void;
  close(): Promise<void>;
}

export interface Answer {
  status: number;
  body?: string;
  location?: string;
  delayMs?: number;
  headers?: Record<string, string>;
  /** Drops the connection instead of answering, as a network error does. */
  drop?: boolean;
}

/** A relay on loopback that records what it is sent. */
export async function startRelay(answer: Answer = { status: 200 }): Promise<Relay> {
  const requests: RelayRequest[] = [];
  const relay: Relay = { origin: '', requests, answer, queue: [], close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const seen = { method: req.method, url: req.url, headers: req.headers, body, at: Date.now() };
      requests.push(seen);
      relay.onRequest?.(seen);
      const a = relay.queue.shift() ?? relay.answer;
      if (a.drop) return void req.socket.destroy();
      const reply = () => res.writeHead(a.status, { ...(a.location ? { location: a.location } : {}), ...a.headers, 'content-type': 'application/json' }).end(a.body ?? '{}');
      if (a.delayMs) setTimeout(reply, a.delayMs);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  relay.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return relay;
}

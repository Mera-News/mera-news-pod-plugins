import { createInterface } from 'node:readline';
import { readToken, tokenPath } from './token';

// Every tool answers from the pod's own database, so a minute is long; a client showing a spinner gets an answer.
const REQUEST_TIMEOUT_MS = 60_000;

interface Streams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

/** Splits an event stream into the JSON payloads of its `data:` lines, one per event. */
function sseMessages(text: string): unknown[] {
  return text
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n'),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

// Where the name header comes from, for the methods that have one.
const NAME_FIELD: Record<string, string> = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri', 'tasks/get': 'taskId', 'tasks/update': 'taskId', 'tasks/cancel': 'taskId' };

/**
 * A request in the 2026 protocol revision names its version in `params._meta`; over HTTP the server
 * refuses it with a 400 unless the version, the method and the name also come as headers.
 */
function revisionHeaders(message: any): Record<string, string> {
  const version = message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  if (typeof version !== 'string' || typeof message.method !== 'string' || message.id === undefined) return {};
  const headers: Record<string, string> = { 'mcp-protocol-version': version, 'mcp-method': message.method };
  const name = message.params[NAME_FIELD[message.method]];
  if (Object.hasOwn(NAME_FIELD, message.method) && typeof name === 'string') {
    // Plain printable ASCII goes as it is; anything else as the spec's base64 form.
    const plain = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(name) && !/^=\?base64\?.*\?=$/.test(name);
    headers['mcp-name'] = plain ? name : `=?base64?${Buffer.from(name, 'utf8').toString('base64')}?=`;
  }
  return headers;
}

/** Relays newline-delimited JSON-RPC from stdin to the pod's HTTP endpoint and back to stdout. */
export async function runBridge(opts: { url: string; home: string; fetchImpl?: typeof globalThis.fetch } & Partial<Streams>): Promise<void> {
  const { stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, fetchImpl = globalThis.fetch } = opts;
  const send = (m: unknown) => stdout.write(`${JSON.stringify(m)}\n`);

  // One plain sentence on stderr, and a protocol error when the message expects an answer.
  const fail = (id: unknown, sentence: string) => {
    stderr.write(`${sentence}\n`);
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32000, message: sentence } });
  };

  async function relay(line: string): Promise<void> {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      stderr.write('Ignored a line on standard input that is not JSON.\n');
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const id = message?.id;
    let token: string;
    try {
      token = readToken(tokenPath(opts.home));
    } catch (e) {
      return fail(id, (e as Error).message);
    }
    let res: Response;
    try {
      res = await fetchImpl(opts.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          ...revisionHeaders(message),
        },
        body: line,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if ((e as Error).name === 'TimeoutError') return fail(id, 'The pod did not answer within a minute. Check its log.');
      return fail(id, `The pod is not running at ${opts.url}. Start it, then try again.`);
    }
    if (res.status === 401 || res.status === 403) {
      return fail(id, 'The pod refused the token. Check that this bridge and the pod use the same home (--home).');
    }
    if (res.status === 202) return;
    if (!res.ok) return fail(id, `The pod answered with status ${res.status}. Check its log.`);
    try {
      const text = await res.text();
      const type = res.headers.get('content-type') ?? '';
      const parsed = type.includes('text/event-stream') ? sseMessages(text) : [JSON.parse(text)];
      for (const m of parsed.flat()) send(m);
    } catch {
      fail(id, 'The pod sent an answer that is not valid JSON-RPC. Check its log.');
    }
  }

  const pending: Promise<void>[] = [];
  for await (const line of createInterface({ input: stdin })) {
    if (line.trim()) pending.push(relay(line));
  }
  await Promise.all(pending);
}

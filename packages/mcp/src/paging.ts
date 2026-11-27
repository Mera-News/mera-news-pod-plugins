// Paging for the list tools: `limit` is the total the person asked for, and the tool's own cursor
// carries the rest, so the model only repeats the call the reply names.

/** The most a list tool hands out in total, over every call. */
export const LIMIT_MAX = 10000;

/** What one list tool cursor holds. */
export interface Page {
  /** The tool it was made for, and the scope it reads (the query or the country), so it is never used elsewhere. */
  t: string;
  k: string;
  /** The server's (or the pod's) cursor to continue from; null for the start. */
  c: string | null;
  /** Items still to come, and the total first asked for. */
  r: number;
  n: number;
  /** Search only: hits of the page at `c` already shown, and the page size it was read with. */
  s?: number;
  m?: number;
}

export const coded = (code: string, message: string, next: string) => Object.assign(new Error(message), { code, next });

/** The answer to a cursor this tool cannot use, in every tool's own words. */
export const badCursor = (tool: string, field = 'after') => coded('bad_input', `The field "${field}" is not valid for ${tool}.`, `call ${tool} again without "${field}"`);

export const encode = (p: Page) => Buffer.from(JSON.stringify(p)).toString('base64url');

export function decode(tool: string, scope: string, cursor: string, field = 'after'): Page {
  let p: Page;
  try {
    p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badCursor(tool, field);
  }
  const count = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= LIMIT_MAX;
  if (!p || p.t !== tool || p.k !== scope || (p.c !== null && typeof p.c !== 'string') || !count(p.r) || !count(p.n) || p.r < 1) throw badCursor(tool, field);
  if ((p.s !== undefined && !count(p.s)) || (p.m !== undefined && !count(p.m))) throw badCursor(tool, field);
  return p;
}

/**
 * The fields a reply with more adds: the cursor, what is still to come, and the exact next call as a
 * sentence built here, so the count never depends on the model's prose.
 */
export function more(tool: string, args: Record<string, unknown>, field: string, p: Page) {
  const nextCursor = encode(p);
  return {
    nextCursor,
    remaining: p.r,
    next: `Call ${tool} with ${JSON.stringify({ ...args, [field]: nextCursor })}: ${p.r} of the ${p.n} asked for are still to come.`,
  };
}

/** Said in place of `next` when the news server cannot page this tool. */
export const OLD_SERVER_NEXT = 'This news server gives only this first page. Paging needs a newer news server.';

/** The cursor of a first call: nothing shown yet. */
export const start = (tool: string, scope: string, limit: number): Page => ({ t: tool, k: scope, c: null, r: limit, n: limit });

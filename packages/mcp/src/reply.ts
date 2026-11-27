import type { CallToolResult } from '@modelcontextprotocol/server';

export const TARGET_TOKENS = 11000;
export const MAX_TOKENS = 12000;
// Some clients save a reply over 50,000 characters to a file instead of reading it.
export const MAX_CHARS = 48000;
const TARGET_CHARS = 44000;

export type Estimate = (text: string) => number;

/** Whether a reply's text, plus `reserve` tokens for what is added around it, stays within the target. */
export const within = (text: string, estimate: Estimate, reserve = 0) => estimate(text) + reserve <= TARGET_TOKENS && text.length + reserve * 4 <= TARGET_CHARS;

/** The one error shape every tool returns. */
export function fail(code: string, message: string, next: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message, next }) }] };
}

/** A JSON reply. A reply that still passes the hard cap is replaced by an error rather than sent. */
export function ok(value: unknown, estimate: Estimate): CallToolResult {
  const text = JSON.stringify(value);
  if (estimate(text) > MAX_TOKENS || text.length > MAX_CHARS) {
    return fail('too_large', 'The reply is too large to send.', 'ask for fewer items and try again');
  }
  return { content: [{ type: 'text', text }] };
}

/**
 * The most items of `items` whose reply, built by `make`, stays within the target. Replies grow with
 * the item count, so a binary search finds the cut.
 */
export function fit<T>(items: T[], make: (kept: T[], cut: boolean) => unknown, estimate: Estimate): { kept: T[]; cut: boolean } {
  const size = (k: number) => within(JSON.stringify(make(items.slice(0, k), k < items.length)), estimate);
  if (size(items.length)) return { kept: items, cut: false };
  let lo = 0;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (size(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { kept: items.slice(0, lo), cut: true };
}

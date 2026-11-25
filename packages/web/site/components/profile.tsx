'use client';

import { Check, MessageCircle, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { ApiError, usePost } from '@/components/session';
import { Button } from '@/components/ui/button';
import { plural } from '@/lib/news';
import { cn } from '@/lib/utils';

export interface Topic {
  id: string;
  text: string;
  source: 'generated' | 'added' | 'followed';
  reviewed: boolean;
}

export interface Fact {
  id: string;
  statement: string;
  topicsStatus: 'pending' | 'done' | 'error' | 'none';
  needsReview: boolean;
  reviewed: boolean;
  topics: Topic[];
}

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('Mera News could not answer.', 'Try again in a minute.'));
const ASK_FOR_TOPICS = 'Ask your assistant for topics.';

function Problem({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-[13px]">
      <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
    </p>
  );
}

/** How a fact gets added: by telling Mera. The second line names where, until the site has its own chat with Mera. */
export function AddFactNote({ className }: { className?: string }) {
  return (
    <p className={cn('flex items-start gap-2 text-muted-foreground', className)}>
      <MessageCircle aria-hidden className="mt-[3px] size-4 shrink-0" />
      To add a fact, tell Mera about yourself. Ask your assistant to add it.
    </p>
  );
}

/** Topics are waiting for the person to keep or remove them. */
export const reviewDue = (f: Fact) => f.topics.length > 0 && f.needsReview && (!f.reviewed || f.topics.some((t) => !t.reviewed));

export function statusLine(f: Fact, hasAi: boolean, staged: number): string {
  if (f.topicsStatus === 'pending' && hasAi) return 'Generating topics';
  if (f.topics.length === 0) return hasAi ? 'Topics could not be made' : 'No topics yet';
  const fresh = f.topics.filter((t) => !t.reviewed).length;
  const parts = [plural(f.topics.length - staged, 'topic')];
  if (staged) parts.push(`${staged} to remove`);
  else if (fresh) parts.push(`${fresh} new to review`);
  else if (reviewDue(f)) parts.push('To review');
  else if (f.needsReview && f.reviewed) parts.push('Reviewed');
  return parts.join(' · ');
}

/** One fact as a board: its topics as chips to keep or remove, and Save, which records the review. Bare, it sits inside a row that already names the fact. */
export function FactBoard({ fact, hasAi, onChanged, bare }: { fact: Fact; hasAi: boolean; onChanged: () => void; bare?: boolean }) {
  const post = usePost();
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<'save' | 'remove' | 'retry' | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  // With no AI service nothing makes topics, so a fact waiting for them simply has none yet.
  const pending = fact.topicsStatus === 'pending' && hasAi;
  const toReview = reviewDue(fact);
  const live = fact.topics.filter((t) => !removed.has(t.id));
  const staged = fact.topics.length - live.length;

  const act = async (what: 'save' | 'remove' | 'retry', fn: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    setSaved(false);
    try {
      await fn();
      if (what === 'save') {
        setRemoved(new Set());
        setSaved(true);
      }
      onChanged();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(null);
    }
  };
  const toggle = (id: string) =>
    setRemoved((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      setSaved(false);
      return n;
    });

  return (
    <article
      aria-labelledby={bare ? undefined : `fact-${fact.id}`}
      aria-label={bare ? fact.statement : undefined}
      className={cn('flex min-w-0 flex-col gap-3 rounded-[12px] border bg-card p-3.5', bare && 'rounded-none border-0 bg-transparent p-0')}
    >
      <header className={cn('flex flex-col gap-1', bare && 'sr-only')}>
        <h3 id={`fact-${fact.id}`} className="font-semibold tracking-[-0.01em] text-pretty">
          {fact.statement}
        </h3>
        <p className={cn('flex items-center gap-1.5 text-[12px] text-muted-foreground tabular-nums', toReview && !pending && 'text-accent-foreground')}>
          {pending && <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-primary" />}
          {statusLine(fact, hasAi, staged)}
        </p>
      </header>

      {pending ? (
        <div aria-hidden className="flex flex-wrap gap-1.5">
          {[64, 92, 52, 80].map((w) => (
            <span key={w} style={{ width: w }} className="h-7 animate-pulse rounded-full bg-muted max-md:h-11" />
          ))}
        </div>
      ) : fact.topics.length === 0 ? (
        hasAi ? (
          <Button variant="outline" size="sm" className="self-start" disabled={busy !== null} onClick={() => void act('retry', () => post('/api/facts/', { statement: fact.statement }))}>
            {busy === 'retry' ? 'Trying again' : 'Try again'}
          </Button>
        ) : (
          <p className="text-[13px] text-muted-foreground">{ASK_FOR_TOPICS} It writes them for this fact in your AI app.</p>
        )
      ) : (
        <ul aria-label={`Topics for ${fact.statement}`} className="flex flex-wrap gap-1.5">
          {fact.topics.map((t) => {
            const off = removed.has(t.id);
            return (
              <li
                key={t.id}
                className={cn(
                  'inline-flex h-7 max-w-full items-center gap-0.5 rounded-full border pr-0.5 pl-2.5 text-[12px] transition-colors max-md:h-11 max-md:pr-0 max-md:pl-4 max-md:text-[15px]',
                  !t.reviewed && !off && 'border-primary/70 text-accent-foreground',
                  off && 'border-dashed text-muted-foreground line-through',
                )}
              >
                <span className="truncate">{t.text}</span>
                <button
                  type="button"
                  onClick={() => toggle(t.id)}
                  aria-label={off ? `Keep ${t.text}` : `Remove ${t.text}`}
                  className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground no-underline transition-colors hover:bg-muted hover:text-foreground max-md:size-11"
                >
                  {off ? <RotateCcw aria-hidden className="size-3" /> : <X aria-hidden className="size-3.5" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {toReview && !pending && <p className="text-[12px] text-pretty text-muted-foreground max-md:text-[14px]">Keep the topics that fit, remove the rest, then press Save.</p>}

      <Problem error={error} />

      {confirmRemove ? (
        <div role="group" aria-label="Remove this fact" className="mt-auto flex flex-col gap-2 border-t pt-3">
          <p className="text-[13px]">Remove this fact and its topics? News for it stops.</p>
          <div className="flex gap-2">
            <Button size="sm" disabled={busy !== null} onClick={() => void act('remove', () => post('/api/facts/remove/', { id: fact.id }))}>
              {busy === 'remove' ? 'Removing' : 'Remove'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-auto flex items-center gap-2 pt-1">
          {fact.topics.length > 0 && (staged > 0 || toReview || pending) ? (
            <Button size="sm" disabled={pending || busy !== null} onClick={() => void act('save', () => post('/api/topics/', { factId: fact.id, remove: [...removed] }))}>
              {busy === 'save' ? 'Saving' : 'Save'}
            </Button>
          ) : (
            saved && (
              <p role="status" className="inline-flex items-center gap-1 text-[12px] text-accent-foreground">
                <Check aria-hidden className="size-3.5" />
                Saved
              </p>
            )
          )}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>
            Remove fact
          </Button>
        </div>
      )}
    </article>
  );
}

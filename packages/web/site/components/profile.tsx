'use client';

import { Check, RotateCcw, X } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, usePost } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

export interface Setup {
  complete: boolean;
  findingTopics: string[];
  toReview: string[];
  noTopics: string[];
}

export const MAX_STATEMENT = 300;
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

/** What is left to do before the profile is set up, from the pod's own count over every fact. */
export function SetupPanel({ setup, hasAi, className }: { setup: Setup; hasAi: boolean; className?: string }) {
  if (setup.complete) return null;
  const rows: [string, string[], ReactNode][] = [
    ['Generating topics for:', setup.findingTopics, 'They appear on each fact below in a minute or two.'],
    ['Topics to review for:', setup.toReview, 'Keep the topics that fit, remove the rest, then press Save on the fact.'],
    ['No topics yet for:', setup.noTopics, hasAi ? 'Try again on the fact below, or remove it.' : ASK_FOR_TOPICS],
  ];
  return (
    <section aria-labelledby="setup-title" className={cn('mx-7 flex flex-col gap-4 rounded-[12px] border border-primary/40 bg-accent p-5', className)}>
      <h2 id="setup-title" className="text-[17px] font-semibold tracking-[-0.01em]">
        Finish setting up your profile
      </h2>
      <dl className="flex flex-col gap-3">
        {rows
          .filter(([, list]) => list.length > 0)
          .map(([label, list, next]) => (
            <div key={label}>
              <dt className="inline font-medium">{label}</dt> <dd className="inline">{list.map((s) => `“${s}”`).join(', ')}</dd>
              <dd className="mt-0.5 text-muted-foreground">{next}</dd>
            </div>
          ))}
      </dl>
    </section>
  );
}

type AddResult = { result: 'added' | 'already' | 'conflict' | 'retried'; conflictsWith?: string; localCoverageWeaker?: boolean };

function addedLine(r: AddResult, hasAi: boolean): string {
  const near = r.localCoverageWeaker ? ' News near this place may be thin, because the news server cannot look up places yet.' : '';
  switch (r.result) {
    case 'added':
      return (hasAi ? 'Saved. Its topics appear below in a minute or two.' : `Saved. ${ASK_FOR_TOPICS}`) + near;
    case 'retried':
      return 'You already have this fact. Mera News is making its topics again.' + near;
    case 'already':
      return 'You already have this fact.';
    case 'conflict':
      return `This does not fit with “${r.conflictsWith}”. If that changed, remove it first, then add this one.`;
  }
}

/** Type a fact, read it back as it will be saved, then confirm. */
export function AddFact({ hasAi, onSaved, className }: { hasAi: boolean; onSaved: () => void; className?: string }) {
  const post = usePost();
  const [text, setText] = useState('');
  const [check, setCheck] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const next = (e: FormEvent) => {
    e.preventDefault();
    const statement = text.replace(/\s+/g, ' ').trim();
    if (!statement) return;
    setDone(null);
    setError(null);
    setCheck(statement);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<AddResult>('/api/facts/', { statement: check });
      setDone(addedLine(r, hasAi));
      if (r.result !== 'conflict') {
        setText('');
        setCheck(null);
      }
      onSaved();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex max-w-[640px] flex-col gap-3 px-7', className)}>
      {check === null ? (
        <form onSubmit={next} className="flex flex-col gap-1.5">
          <label htmlFor="new-fact" className="font-medium">
            Add a fact about you
          </label>
          <div className="flex gap-2 max-md:flex-col max-md:items-start">
            <Input
              id="new-fact"
              value={text}
              maxLength={MAX_STATEMENT}
              autoComplete="off"
              placeholder="Such as: I live in Utrecht, or I work as a nurse"
              onChange={(e) => setText(e.target.value)}
              className="h-9 text-sm"
            />
            <Button type="submit" variant="outline" disabled={!text.trim()}>
              Next
            </Button>
          </div>
        </form>
      ) : (
        <div role="group" aria-labelledby="check-title" className="flex flex-col gap-3 rounded-[12px] border bg-card p-4">
          <p id="check-title" className="text-muted-foreground">
            Mera News will remember this about you. Is it right?
          </p>
          <p className="text-[15px] font-semibold tracking-[-0.01em]">{check}</p>
          <div className="flex gap-2">
            <Button onClick={() => void save()} disabled={busy}>
              {busy ? 'Saving' : 'Save fact'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setCheck(null)}>
              Change it
            </Button>
          </div>
        </div>
      )}
      <Problem error={error} />
      {done && (
        <p role="status" className="text-[13px] text-muted-foreground">
          {done}
        </p>
      )}
    </div>
  );
}

export function statusLine(f: Fact, hasAi: boolean, staged: number): string {
  if (f.topicsStatus === 'pending' && hasAi) return 'Generating topics';
  if (f.topics.length === 0) return hasAi ? 'Topics could not be made' : 'No topics yet';
  const fresh = f.topics.filter((t) => !t.reviewed).length;
  const parts = [plural(f.topics.length - staged, 'topic')];
  if (staged) parts.push(`${staged} to remove`);
  else if (fresh) parts.push(`${fresh} new to review`);
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
  const toReview = fact.topics.length > 0 && fact.needsReview && (!fact.reviewed || fact.topics.some((t) => !t.reviewed));
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

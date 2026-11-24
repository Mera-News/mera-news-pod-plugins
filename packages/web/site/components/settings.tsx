'use client';

import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, useApi, usePost, type Status } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('Mera News could not answer.', 'Try again in a minute.'));

function Section({ id, title, lead, children }: { id: string; title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 id={id} className="text-[17px] font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        {lead && <p className="mt-1 max-w-[60ch] text-pretty text-muted-foreground">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

function Problem({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-[13px]">
      <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
    </p>
  );
}

const Label = ({ htmlFor, children }: { htmlFor: string; children: ReactNode }) => (
  <label htmlFor={htmlFor} className="text-[12px] text-muted-foreground">
    {children}
  </label>
);

const clock = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null);
const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** How Mera News reads the news, in plain words. With no AI service it reads nothing on its own, so "paused" would mislead. */
export function readingLine(s: Status): string {
  if (!s.ai) return 'Your assistant fetches the news when you ask, or when your digest runs.';
  if (s.reading !== 'on') return 'Reading is paused. Your profile can still change while it is paused.';
  if (s.readingNow) return 'Mera News is reading the news now.';
  const next = clock(s.nextReadAt);
  return `Mera News reads the news every ${s.everyMinutes} minutes.${next ? ` The next read is at ${next}.` : ''}`;
}

export function PodSection({ status }: { status: Status }) {
  // Fixes addressed to the assistant are for it to act on, not for this page.
  const problems = status.problems.filter((p) => p.who === 'person');
  return (
    <Section id="pod" title="Mera News on this computer" lead={`Mera Labs keeps no copy of your profile. It stays on this computer${status.ai ? ', and your AI service sees your facts to make topics and picks' : ''}.`}>
      <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-6 gap-y-3">
        <dt className="text-muted-foreground">Reading</dt>
        <dd>{readingLine(status)}</dd>
        {status.ai && status.lastRunAt && (
          <>
            <dt className="text-muted-foreground">Last read</dt>
            <dd className="tabular-nums">{clock(status.lastRunAt)}</dd>
          </>
        )}
        <dt className="text-muted-foreground">News from</dt>
        <dd>{status.dataServer.host}</dd>
        {problems.length > 0 && (
          <>
            <dt className="text-muted-foreground">To fix</dt>
            <dd>
              <ul className="flex flex-col gap-1.5">
                {problems.map((p) => (
                  <li key={p.code}>{p.fix}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
    </Section>
  );
}

interface Digest {
  times: string[];
  everyMinutes: number | null;
  assistant: boolean;
}

/** When the assistant shows the person their news: times of day, every so many minutes, or both. */
export function DigestSection() {
  const get = useApi();
  const post = usePost();
  const [saved, setSaved] = useState<Digest | null>(null);
  const [times, setTimes] = useState<string[]>([]);
  const [every, setEvery] = useState('');
  const [adding, setAdding] = useState('08:00');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const take = (d: Digest) => {
    setSaved(d);
    setTimes(d.times);
    setEvery(d.everyMinutes ? String(d.everyMinutes) : '');
  };
  useEffect(() => {
    get<Digest>('/api/digest/').then(take, (e) => setError(asError(e)));
  }, [get]);

  const lead = 'When your assistant shows you the news picked for you. Two or three times a day suits most people.';
  if (!saved) {
    return (
      <Section id="digest" title="Your digest" lead={lead}>
        {error ? <Problem error={error} /> : <div aria-hidden className="h-9 w-48 animate-pulse rounded-full bg-muted" />}
      </Section>
    );
  }
  if (!saved.assistant) {
    return (
      <Section id="digest" title="Your digest" lead="Your assistant shows your digest. Add the Mera News plugin to your AI app to get one.">
        {null}
      </Section>
    );
  }

  const add = (e: FormEvent) => {
    e.preventDefault();
    if (/^\d\d:\d\d$/.test(adding) && !times.includes(adding)) setTimes([...times, adding].sort());
    setDone(null);
  };
  const minutes = every.trim() ? Number(every) : null;
  const badEvery = minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 10080);
  const changed = times.join() !== saved.times.join() || minutes !== saved.everyMinutes;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const d = await post<Digest>('/api/digest/', { times, everyMinutes: minutes });
      take(d);
      const when = [d.times.length ? `at ${andList(d.times)}` : '', d.everyMinutes ? `every ${d.everyMinutes} minutes` : ''].filter(Boolean).join(' and ');
      setDone(
        when
          ? `Your news will come ${when}. If your AI app is closed then, it comes when you next open it. If your assistant can schedule tasks, ask it to set one up for these times.`
          : 'No digest is set. Your assistant shows your news when you ask.',
      );
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="digest" title="Your digest" lead={lead}>
      <div className="flex flex-col gap-1.5">
        <span id="digest-times" className="text-[12px] text-muted-foreground">
          Times of day
        </span>
        {times.length ? (
          <ul aria-labelledby="digest-times" className="flex flex-wrap gap-1.5">
            {times.map((t) => (
              <li key={t} className="inline-flex h-8 items-center gap-0.5 rounded-full border border-primary/70 pr-1 pl-3 text-[13px] text-accent-foreground tabular-nums">
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => (setTimes(times.filter((x) => x !== t)), setDone(null))}
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X aria-hidden className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[13px] text-muted-foreground">No times yet.</p>
        )}
        <form onSubmit={add} className="mt-1 flex items-center gap-2">
          <label htmlFor="digest-add" className="sr-only">
            A time to add
          </label>
          <Input id="digest-add" type="time" required value={adding} onChange={(e) => setAdding(e.target.value)} className="w-[120px] tabular-nums" />
          <Button type="submit" size="sm" variant="outline" disabled={times.length >= 48}>
            Add time
          </Button>
        </form>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="digest-every">Every so many minutes, as well or instead</Label>
        <div className="flex items-center gap-2">
          <Input
            id="digest-every"
            type="number"
            inputMode="numeric"
            min={1}
            max={10080}
            placeholder="Off"
            value={every}
            aria-invalid={badEvery}
            aria-describedby={badEvery ? 'digest-every-bad' : undefined}
            onChange={(e) => (setEvery(e.target.value), setDone(null))}
            className="w-[120px] tabular-nums aria-invalid:border-red-500"
          />
          <span className="text-[13px] text-muted-foreground">minutes</span>
        </div>
        {badEvery && (
          <p id="digest-every-bad" className="text-[12px]">
            Use a whole number from 1 to 10080, or leave it empty.
          </p>
        )}
      </div>
      <div className="flex flex-col items-start gap-2">
        <Button onClick={() => void save()} disabled={!changed || badEvery || busy}>
          {busy ? 'Saving' : 'Save schedule'}
        </Button>
        <Problem error={error} />
        {done && (
          <p role="status" className="max-w-[60ch] text-[13px] text-muted-foreground">
            {done}
          </p>
        )}
      </div>
    </Section>
  );
}

/** The person's own AI service. The key goes to the pod's secrets and is never shown again. */
export function AiServiceSection({ status, onSaved }: { status: Status; onSaved: () => void }) {
  const post = usePost();
  const [open, setOpen] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const after = status.aiAfterRestart;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/ai/', { baseUrl, model, ...(apiKey ? { apiKey } : {}) });
      setOpen(false);
      onSaved();
    } catch (err) {
      setError(asError(err));
    } finally {
      // The key leaves the page as soon as it is sent, whatever the answer.
      setApiKey('');
      setBusy(false);
    }
  };

  return (
    <Section
      id="ai"
      title="AI service"
      lead={status.ai ? 'Mera News makes topics and picks with it while Mera News is running, without waiting for your assistant.' : 'None. Your assistant picks for you when you ask. Add an AI service to have Mera News pick while you are away.'}
    >
      {status.ai && (
        <p>
          <span className="font-medium">{status.ai.model}</span> <span className="text-muted-foreground">at {status.ai.host}</span>
        </p>
      )}
      {after && (
        <p role="status" className="rounded-[12px] border border-primary/40 bg-accent p-3 text-[13px]">
          <span className="font-medium">
            Saved: {after.model} at {after.host}.
          </span>{' '}
          It applies after Mera News restarts. Quit and reopen your AI app, or restart your pod.
        </p>
      )}
      {open ? (
        <form onSubmit={save} className="flex flex-col gap-3" autoComplete="off">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-url">Address for OpenAI-compatible requests</Label>
            <Input id="ai-url" type="url" required value={baseUrl} placeholder="https://api.example.com/v1" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} className="h-9" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-model">Model</Label>
            <Input id="ai-model" required maxLength={200} value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} className="h-9" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ai-key">Key</Label>
            <Input
              id="ai-key"
              type="password"
              value={apiKey}
              autoComplete="new-password"
              spellCheck={false}
              aria-describedby="ai-key-note"
              onChange={(e) => setApiKey(e.target.value)}
              className="h-9"
            />
            <p id="ai-key-note" className="text-[12px] text-muted-foreground">
              Kept on this computer and never shown again. Leave it empty to keep the saved key for the same address.
            </p>
          </div>
          <p className="text-[13px] text-muted-foreground">Mera News sends your facts and the headlines it reads to this service to make topics and picks.</p>
          <Problem error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !baseUrl.trim() || !model.trim()}>
              {busy ? 'Saving' : 'Save AI service'}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => (setOpen(false), setError(null))}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <Button variant="outline" className="self-start" onClick={() => setOpen(true)}>
          {status.ai || after ? 'Change AI service' : 'Add an AI service'}
        </Button>
      )}
    </Section>
  );
}

'use client';

import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Pills } from '@/components/phone/ui';
import { Command } from '@/components/phones';
import { ApiError, onPhone, useApi, usePost, type Status } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { currentAppearance, setAppearance, type Appearance } from '@/lib/appearance';
import { usePhone } from '@/lib/use-phone';

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
  const here = onPhone() ? 'your computer' : 'this computer';
  return (
    <Section id="pod" title={`Mera News on ${here}`} lead={`Mera Labs keeps no copy of your profile. It stays on ${here}${status.ai ? ', and your AI service sees your facts to make topics and picks' : ''}.`}>
      <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-6 gap-y-3">
        <dt className="text-muted-foreground">Reading</dt>
        <dd>{readingLine(status)}</dd>
        {status.ai && status.lastRunAt && (
          <>
            <dt className="text-muted-foreground">Last read</dt>
            <dd className="tabular-nums">{clock(status.lastRunAt)}</dd>
          </>
        )}
        {/* On a phone a loopback address would name the phone itself, so the computer alone shows it. */}
        {!onPhone() && (
          <>
            <dt className="text-muted-foreground">News from</dt>
            <dd>{status.dataServer.host}</dd>
          </>
        )}
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
              <li key={t} className="inline-flex h-8 items-center gap-0.5 rounded-full border border-primary/70 pr-1 pl-3 text-[13px] text-accent-foreground tabular-nums max-md:h-11 max-md:pl-4 max-md:text-[15px]">
                {t}
                <button
                  type="button"
                  aria-label={`Remove ${t}`}
                  onClick={() => (setTimes(times.filter((x) => x !== t)), setDone(null))}
                  className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground max-md:size-11"
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
              Kept on {onPhone() ? 'your computer' : 'this computer'} and never shown again. Leave it empty to keep the saved key for the same address.
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

const APPEARANCE: { value: Appearance; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/** Light, dark or the device's own setting, kept in this browser only. */
export function AppearanceSection() {
  const phone = usePhone();
  const [value, setValue] = useState<Appearance>(currentAppearance);
  const choose = (a: Appearance) => {
    setAppearance(a);
    setValue(a);
  };
  return (
    <Section id="appearance" title="Appearance" lead="Match your device, or always use light or dark. This browser remembers your choice.">
      {phone ? (
        <div>
          <Pills label="Appearance" pills={APPEARANCE} value={value} onChange={choose} />
        </div>
      ) : (
        <ToggleGroup aria-label="Appearance" value={[value]} onValueChange={(v: unknown[]) => typeof v[0] === 'string' && choose(v[0] as Appearance)}>
          {APPEARANCE.map((a) => (
            <ToggleGroupItem key={a.value} value={a.value}>
              {a.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
    </Section>
  );
}

const GUIDE = 'https://github.com/Mera-News/mera-news-pod/blob/main/docs/self-hosting.md#keep-it-running';

interface KeepRunningState {
  available: 'yes' | 'not_mac' | 'not_bundled' | 'other_agent';
  on: boolean;
  /** On, but naming a Node.js that was removed, so macOS cannot start it. */
  broken?: boolean;
  node?: { path: string; version: string } | null;
  oldNode?: string | null;
  minNode?: string;
  install?: string | null;
  download?: string;
  copiesKey?: boolean;
  log?: string;
}

/** Keep the pod going after the AI app quits, through a macOS login item that runs the same Mera News. This computer only. */
export const KeepRunningSection = () => (onPhone() ? null : <KeepRunning />);

function KeepRunning() {
  const get = useApi();
  const post = usePost();
  const [state, setState] = useState<KeepRunningState | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const load = () => get<KeepRunningState>('/api/keep-running/').then(setState, (e) => setError(asError(e)));
  useEffect(() => void load(), [get]);

  const set = async (on: boolean) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setState(await post<KeepRunningState>('/api/keep-running/', { on }));
      setDone(
        on
          ? 'Done. Mera News takes over within a minute after you quit your AI app, and starts again when you log in.'
          : 'Done. If Mera News was running on its own, it stops in a few seconds, and starts again the next time you open your AI app.',
      );
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(false);
    }
  };

  const title = 'Keep Mera News running';
  const lead = 'Mera News runs while your AI app is open. Keep it running to have it read the news and answer your phone after you quit the app, while this Mac is awake.';
  if (!state) {
    return (
      <Section id="keep-running" title={title} lead={lead}>
        {error ? <Problem error={error} /> : <div aria-hidden className="h-9 w-48 animate-pulse rounded-full bg-muted" />}
      </Section>
    );
  }
  if (state.available === 'not_mac') {
    return (
      <Section id="keep-running" title={title} lead="Mera News can keep running on its own on macOS only, for now. On this computer, it runs while your AI app is open.">
        {null}
      </Section>
    );
  }
  if (state.available === 'other_agent') {
    return (
      <Section
        id="keep-running"
        title={title}
        lead="A login item you set up yourself already starts a Mera News pod on this Mac (news.mera.pod in your LaunchAgents folder). Mera News leaves it as it is."
      >
        {null}
      </Section>
    );
  }
  if (state.available === 'not_bundled') {
    return (
      <Section
        id="keep-running"
        title={title}
        lead={
          <>
            This pod runs for as long as you keep it running. To start it when you log in, see{' '}
            <a href={GUIDE} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
              Keep it running
            </a>{' '}
            in the pod&apos;s self-hosting guide.
          </>
        }
      >
        {null}
      </Section>
    );
  }
  if (!state.on && !state.node) {
    return (
      <Section id="keep-running" title={title} lead={lead}>
        <p className="max-w-[60ch] text-pretty">
          {state.oldNode
            ? `This needs Node.js ${state.minNode} or newer, and this Mac has Node.js ${state.oldNode}.`
            : `This needs Node.js ${state.minNode} or newer, and none was found on this Mac.`}{' '}
          Mera News does not install it for you.
        </p>
        {state.install ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted-foreground">To install it with Homebrew, run this in Terminal:</p>
            <Command text={state.install} />
          </div>
        ) : (
          <p className="text-[13px] text-muted-foreground">
            Get the macOS installer from{' '}
            <a href={state.download} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
              nodejs.org
            </a>
            .
          </p>
        )}
        <Button variant="outline" className="self-start" onClick={() => void load()}>
          Check again
        </Button>
        <Problem error={error} />
      </Section>
    );
  }
  return (
    <Section id="keep-running" title={title} lead={lead}>
      {state.on ? (
        <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-6 gap-y-3">
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            {state.broken
              ? `Not running. The Node.js it used was removed from this Mac.${state.node ? '' : ` Install Node.js ${state.minNode} or newer, then reload this page.`}`
              : 'On. Mera News starts when you log in to this Mac.'}
          </dd>
          <dt className="text-muted-foreground">Log</dt>
          <dd className="min-w-0 text-[13px] break-all">{state.log}</dd>
        </dl>
      ) : (
        state.copiesKey && (
          <p className="max-w-[60ch] text-[13px] text-muted-foreground">
            Your news key is saved in secrets.json in the Mera News folder, readable by you only, so Mera News can start without your AI app.
          </p>
        )
      )}
      <div className="flex flex-col items-start gap-2">
        {state.broken && state.node && (
          <Button disabled={busy} onClick={() => void set(true)}>
            {busy ? 'Saving' : `Start it with Node.js ${state.node.version}`}
          </Button>
        )}
        <Button variant={state.on ? 'outline' : 'default'} disabled={busy} onClick={() => void set(!state.on)}>
          {busy ? 'Saving' : state.on ? 'Stop keeping it running' : 'Keep Mera News running'}
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

/** Open tabs outlive a restart, so this is the way to sign every one out, this tab too. Not on a phone: a phone is removed under Phones. */
export const SignOutSection = () => (onPhone() ? null : <SignOut />);

function SignOut() {
  const post = usePost();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/sign-out/', {});
      // The pod no longer knows this tab: reloading shows the page that asks for a new link.
      location.reload();
    } catch (e) {
      setError(asError(e));
      setBusy(false);
    }
  };
  return (
    <Section id="sign-out" title="Sign out" lead="Tabs stay signed in when Mera News restarts. Sign out every tab on this computer, this one too. To open Mera News again, ask your assistant.">
      <Button variant="outline" className="self-start" disabled={busy} onClick={() => void signOut()}>
        {busy ? 'Signing out' : 'Sign out every tab'}
      </Button>
      <Problem error={error} />
    </Section>
  );
}

'use client';

import { Check, Copy } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, onPhone, useApi, usePost } from '@/components/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError('Mera News could not answer.', 'Try again in a minute.'));

interface Access {
  publicHost: string | null;
  port: number;
  command: string;
  tunnelTo: string;
}
interface Device {
  id: string;
  name: string;
  pairedAt: string;
}
interface Pairing {
  url: string;
  expiresAt: string;
  qr: string[];
}

function Problem({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-[13px]">
      <span className="font-medium">{error.message}</span> <span className="text-muted-foreground">{error.next}</span>
    </p>
  );
}

function Section({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section aria-labelledby="phones" className="flex min-w-0 flex-col gap-4">
      <div>
        <h2 id="phones" className="text-[17px] font-semibold tracking-[-0.01em]">
          {title}
        </h2>
        <p className="mt-1 max-w-[60ch] text-pretty text-muted-foreground">{lead}</p>
      </div>
      {children}
    </section>
  );
}

/** A command to run, with a button that copies it. */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copying can be blocked; the command can still be selected by hand.
    }
  };
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-[10px] border bg-muted/60 py-1 pr-1 pl-3">
      <code className="min-w-0 flex-1 py-1 text-[12.5px] break-all select-all">{text}</code>
      <Button type="button" size="sm" variant="ghost" onClick={() => void copy()} aria-label={copied ? 'Copied' : 'Copy the command'}>
        {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
      </Button>
    </div>
  );
}

/** The pairing code as a QR code: dark modules on white with a quiet zone, in either theme, since cameras need that. */
function QrCode({ rows, label }: { rows: string[]; label: string }) {
  const n = rows.length;
  const d = rows.flatMap((row, y) => [...row].map((m, x) => (m === '1' ? `M${x + 4} ${y + 4}h1v1h-1z` : ''))).join('');
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${n + 8} ${n + 8}`} shapeRendering="crispEdges" className="size-[208px] rounded-[12px]">
      <rect width={n + 8} height={n + 8} fill="#fff" />
      <path d={d} fill="#000" />
    </svg>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function DeviceList({ devices, onRemoved }: { devices: Device[]; onRemoved: () => void }) {
  const post = usePost();
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await post('/api/devices/remove/', { id });
      onRemoved();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(null);
    }
  };
  if (!devices.length) return <p className="text-[13px] text-muted-foreground">No phones yet.</p>;
  return (
    <>
      <ul className="flex flex-col divide-y rounded-[12px] border max-md:rounded-none max-md:border-x-0">
        {devices.map((d) => (
          <li key={d.id} className="flex items-center gap-3 py-2 pr-2 pl-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{d.name}</p>
              <p className="text-[12px] text-muted-foreground">Paired {day(d.pairedAt)}</p>
            </div>
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void remove(d.id)} aria-label={`Remove ${d.name}`}>
              {busy === d.id ? 'Removing' : 'Remove'}
            </Button>
          </li>
        ))}
      </ul>
      <Problem error={error} />
    </>
  );
}

/** Reading Mera News on a phone: the address the phone uses, adding a phone, and the phones that can open it. */
export function PhonesSection() {
  const get = useApi();
  const post = usePost();
  const phone = onPhone();
  const [access, setAccess] = useState<Access | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [address, setAddress] = useState('');
  const [editing, setEditing] = useState(false);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const loadDevices = useCallback(async () => {
    const { devices: list } = await get<{ devices: Device[] }>('/api/devices/');
    setDevices(list);
    return list;
  }, [get]);
  useEffect(() => {
    // The address and pairing are this computer's to set; a phone sees only the list.
    (phone ? loadDevices() : Promise.all([get<Access>('/api/remote/').then(setAccess), loadDevices()])).catch((e) => setError(asError(e)));
  }, [get, loadDevices, phone]);

  // While the code is on screen, look for the phone that used it, and close the code when it expires.
  useEffect(() => {
    if (!pairing || !devices) return;
    const known = new Set(devices.map((d) => d.id));
    const timer = setInterval(async () => {
      if (Date.now() >= Date.parse(pairing.expiresAt)) return setPairing(null);
      const list = await loadDevices().catch(() => null);
      const added = list?.find((d) => !known.has(d.id));
      if (added) {
        setPairing(null);
        setPaired(`${added.name} is paired.`);
      }
    }, 3000);
    return () => clearInterval(timer);
    // Only a new code restarts the look.
  }, [pairing]);

  if (phone) {
    return (
      <Section title="Phones" lead="The phones that can open your Mera News. Remove one you no longer use. You add a phone from Mera News on your computer.">
        {devices ? <DeviceList devices={devices} onRemoved={() => void loadDevices().catch((e) => setError(asError(e)))} /> : <Loading />}
        <Problem error={error} />
      </Section>
    );
  }

  const lead = 'Read your news on your phone, wherever you are. Tailscale connects your phone to this computer, so your news goes only between your own devices.';
  if (!access || !devices) {
    return (
      <Section title="Your phone" lead={lead}>
        {error ? <Problem error={error} /> : <Loading />}
      </Section>
    );
  }

  const saveAddress = async (e: FormEvent | null, publicHost: string | null) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setAccess(await post<Access>('/api/remote/', { publicHost }));
      setEditing(false);
      setPairing(null);
      setAddress('');
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  };
  const addPhone = async () => {
    setBusy(true);
    setError(null);
    setPaired(null);
    try {
      setPairing(await post<Pairing>('/api/pair/start/', {}));
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  };

  const showSetup = !access.publicHost || editing;
  return (
    <Section title="Your phone" lead={lead}>
      {showSetup ? (
        <form onSubmit={(e) => void saveAddress(e, address)} className="flex flex-col gap-4">
          <ol className="flex list-decimal flex-col gap-3 pl-5 marker:text-muted-foreground">
            <li>Install Tailscale on this computer and on your phone, and sign in to the same account on both.</li>
            <li>
              <p className="mb-2">On this computer, run this command in Terminal:</p>
              <Command text={access.command} />
            </li>
            <li>
              <label htmlFor="public-address" className="mb-2 block">
                Paste the https address it prints.
              </label>
              <Input
                id="public-address"
                required
                value={address}
                inputMode="url"
                spellCheck={false}
                autoCapitalize="none"
                placeholder="your-mac.tail1234.ts.net"
                onChange={(e) => setAddress(e.target.value)}
                className="h-9"
              />
            </li>
          </ol>
          <p className="max-w-[60ch] text-[13px] text-muted-foreground">
            You can use a public tunnel such as ngrok or Cloudflare Tunnel instead. Point it at <code>{access.tunnelTo}</code> and paste the https address it gives you. Everything your
            phone reads and changes then passes through the tunnel provider.
          </p>
          <Problem error={error} />
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !address.trim()}>
              {busy ? 'Saving' : 'Save address'}
            </Button>
            {editing && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => (setEditing(false), setError(null))}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <>
          <dl className="grid grid-cols-[minmax(96px,auto)_1fr] gap-x-6 gap-y-3">
            <dt className="text-muted-foreground">Address</dt>
            <dd className="min-w-0 break-all">https://{access.publicHost}</dd>
          </dl>
          <p className="max-w-[60ch] text-[13px] text-muted-foreground">
            If your phone cannot reach it, run <code className="break-all">{access.command}</code> on this computer again.
          </p>
          {pairing ? (
            <div className="flex flex-col items-start gap-3">
              <QrCode rows={pairing.qr} label="Code to pair your phone" />
              <p className="max-w-[44ch] text-[13px] text-muted-foreground">
                Scan this with your phone&apos;s camera and open the link. It works once, until {clock(pairing.expiresAt)}.
              </p>
              <Button variant="ghost" size="sm" onClick={() => setPairing(null)}>
                Done
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void addPhone()} disabled={busy}>
                {busy ? 'Making a code' : 'Add a phone'}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => (setEditing(true), setAddress(access.publicHost ?? ''))}>
                Change address
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void saveAddress(null, null)}>
                Turn off phone access
              </Button>
            </div>
          )}
          {paired && (
            <p role="status" className="text-[13px]">
              {paired}
            </p>
          )}
          <Problem error={error} />
        </>
      )}
      <div className="flex flex-col gap-2">
        <h3 className="text-[13px] font-medium">Paired phones</h3>
        <DeviceList devices={devices} onRemoved={() => void loadDevices().catch((e) => setError(asError(e)))} />
      </div>
    </Section>
  );
}

const Loading = () => <div aria-hidden className="h-9 w-48 animate-pulse rounded-full bg-muted" />;

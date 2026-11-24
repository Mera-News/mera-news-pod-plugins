'use client';

import { TopBar } from '@/components/top-bar';
import { useConnection, type Status } from '@/components/session';

function readingLine(s: Status): string {
  // With no AI service the pod reads nothing on its own, so "paused" would mislead.
  if (!s.ai) return 'Your assistant fetches the news when you ask, or when your digest runs.';
  if (s.reading !== 'on') return 'Paused. Your profile can still change while reading is paused.';
  return `Mera News reads the news every ${s.everyMinutes} minutes.`;
}

export default function YouPage() {
  const c = useConnection();
  if (c.kind !== 'ready') return null;
  const s = c.status;
  return (
    <>
      <TopBar>
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">You</h1>
      </TopBar>
      <div className="flex max-w-[720px] flex-col gap-10 px-7 py-8">
        <section aria-labelledby="profile" className="flex flex-col gap-4">
          <div>
            <h2 id="profile" className="text-[17px] font-semibold tracking-[-0.01em]">
              Your profile
            </h2>
            <p className="mt-1 text-muted-foreground">Mera Labs keeps no copy of your profile. It stays on this computer.</p>
          </div>
          <dl className="flex gap-10">
            {[
              ['Facts', s.counts.facts],
              ['Topics', s.counts.topics],
            ].map(([label, n]) => (
              <div key={label} className="flex flex-col">
                <dd className="text-[30px] leading-none font-bold tracking-[-0.02em] tabular-nums">{n}</dd>
                <dt className="order-first mb-2 text-[12px] text-muted-foreground">{label}</dt>
              </div>
            ))}
          </dl>
        </section>
        <section aria-labelledby="pod" className="flex flex-col gap-4">
          <h2 id="pod" className="text-[17px] font-semibold tracking-[-0.01em]">
            Mera News on this computer
          </h2>
          <dl className="grid grid-cols-[minmax(120px,auto)_1fr] gap-x-8 gap-y-3">
            <dt className="text-muted-foreground">Reading</dt>
            <dd>{readingLine(s)}</dd>
            <dt className="text-muted-foreground">AI service</dt>
            <dd>{s.ai ? `${s.ai.model} at ${s.ai.host}` : 'None. Ask your assistant to pick, or add an AI service.'}</dd>
            <dt className="text-muted-foreground">News from</dt>
            <dd>{s.dataServer.host}</dd>
          </dl>
        </section>
      </div>
    </>
  );
}

import type { ReactNode } from 'react';

/** The heading over a list: what it is on the left, its numbers on the right. */
export function Heading({ id, title, lead, numbers }: { id: string; title: string; lead: ReactNode; numbers: [string, string][] }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4 px-7 pt-7 pb-5">
      <div className="min-w-0">
        <h1 id={id} className="text-[22px] leading-tight font-bold tracking-[-0.02em] text-balance">{title}</h1>
        <p className="mt-1.5 max-w-[68ch] text-pretty text-muted-foreground">{lead}</p>
      </div>
      {numbers.length > 0 && (
        <dl className="flex gap-8">
          {numbers.map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-[12px] text-muted-foreground">{label}</dt>
              <dd className="text-[30px] leading-none font-bold tracking-[-0.02em] tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

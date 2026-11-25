'use client';

import { CircleHelp, Globe, Plus, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PhoneHeader } from '@/components/phone/ui';
import type { Country } from '@/lib/news';

const ROUND = 'flex size-11 shrink-0 items-center justify-center rounded-full border bg-card text-foreground/85';

/** Every country, searched by name, in a sheet over the page. */
function CountryPicker({ open, countries, onPick, onClose }: { open: boolean; countries: Country[]; onPick: (code: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setText('');
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);
  const shown = useMemo(() => {
    const t = text.trim().toLowerCase();
    return t ? countries.filter((c) => c.name.toLowerCase().includes(t)) : countries;
  }, [countries, text]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="pick-country"
      onClose={onClose}
      className="m-0 h-dvh max-h-none w-full max-w-none bg-background p-0 text-foreground backdrop:bg-black/40"
    >
      <div className="flex h-full flex-col">
        <div className="flex flex-col gap-3 border-b px-4 pt-[calc(env(safe-area-inset-top)+12px)] pb-3">
          <div className="flex items-center justify-between gap-3">
            <h2 id="pick-country" className="text-[20px] font-bold tracking-[-0.015em]">
              Another country
            </h2>
            <button type="button" aria-label="Close" onClick={onClose} className={ROUND}>
              <X aria-hidden className="size-5" />
            </button>
          </div>
          <label className="relative block">
            <span className="sr-only">Search countries</span>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={text}
              autoComplete="off"
              placeholder="Search countries"
              onChange={(e) => setText(e.target.value)}
              className="h-11 w-full rounded-full border bg-card pr-4 pl-10 outline-none focus-visible:border-primary [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
        </div>
        <ul className="flex-1 overflow-y-auto px-2 pb-[calc(env(safe-area-inset-bottom)+16px)]">
          {shown.map((c) => (
            <li key={c.code}>
              <button type="button" onClick={() => onPick(c.code)} className="flex min-h-12 w-full items-center gap-3 rounded-[12px] px-3 text-left text-[16px] active:bg-muted">
                {c.flag && <span aria-hidden>{c.flag}</span>}
                {c.name}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="px-3 py-4 text-muted-foreground">No country is called that.</li>}
        </ul>
      </div>
    </dialog>
  );
}

/**
 * The top of World on a phone, as in the app: the title with search, then the world, the person's
 * countries and another country as pills.
 */
export function PhoneWorldBar({
  chips,
  scope,
  q,
  nameOf,
  flagOf,
  all,
  show,
}: {
  chips: string[];
  scope: string;
  q: string;
  nameOf: (code: string) => string;
  flagOf: (code: string) => string | undefined;
  all: Country[] | undefined;
  show: (next: { c?: string; q?: string }) => void;
}) {
  const [searching, setSearching] = useState(!!q);
  const [help, setHelp] = useState(false);
  const [text, setText] = useState(q);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    setText(q);
    if (q) setSearching(true);
  }, [q]);

  return (
    <PhoneHeader className="flex-col items-stretch gap-3">
      {searching ? (
        <form
          role="search"
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) show({ q: text.trim() });
          }}
        >
          <label className="relative block flex-1">
            <span className="sr-only">Search all news</span>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              name="q"
              maxLength={200}
              enterKeyHint="search"
              autoFocus={!q}
              value={text}
              placeholder="Search all news"
              onChange={(e) => setText(e.target.value)}
              className="h-11 w-full rounded-full border bg-card pr-4 pl-10 outline-none focus-visible:border-primary [&::-webkit-search-cancel-button]:hidden"
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setSearching(false);
              if (q) show({ c: scope });
            }}
            className="h-11 shrink-0 px-2 text-[16px] font-medium text-accent-foreground"
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-[20px] font-bold tracking-[-0.015em]">Top headlines</h1>
          <div className="flex gap-2">
            <button type="button" aria-label="How this list is made" aria-expanded={help} aria-controls="world-help" onClick={() => setHelp(!help)} className={`${ROUND} aria-expanded:border-primary aria-expanded:text-accent-foreground`}>
              <CircleHelp aria-hidden className="size-5" />
            </button>
            <button type="button" aria-label="Search all news" onClick={() => setSearching(true)} className={ROUND}>
              <Search aria-hidden className="size-5" />
            </button>
          </div>
        </div>
      )}
      {help && !searching && (
        <p id="world-help" className="text-[14px] text-pretty text-muted-foreground">
          The most reported stories of the last 24 hours, most reported first. No AI ranks this list.
        </p>
      )}
      {!q && (
        <div role="group" aria-label="Top stories for" className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none]">
          {chips.map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={code === scope}
              onClick={() => show({ c: code })}
              className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full border bg-card px-4 text-[16px] font-semibold text-foreground/85 aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-foreground"
            >
              {code === 'GLOBAL' ? <Globe aria-hidden className="size-[18px]" /> : flagOf(code) && <span aria-hidden>{flagOf(code)}</span>}
              {code === 'GLOBAL' ? 'World' : nameOf(code)}
            </button>
          ))}
          <button type="button" aria-label="Another country" disabled={!all?.length} onClick={() => setPicking(true)} className={`${ROUND} disabled:opacity-50`}>
            <Plus aria-hidden className="size-5" />
          </button>
        </div>
      )}
      <CountryPicker
        open={picking}
        countries={all ?? []}
        onClose={() => setPicking(false)}
        onPick={(code) => {
          setPicking(false);
          show({ c: code });
        }}
      />
    </PhoneHeader>
  );
}

'use client';

import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

// shortcut: disabled until the pod serves news to this site; enable with the Feed and World data.
export function SearchField({ placeholder }: { placeholder: string }) {
  return (
    <label className="relative block w-[320px] max-w-[40vw]">
      <span className="sr-only">{placeholder}</span>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" placeholder={placeholder} className="pl-8" disabled />
    </label>
  );
}

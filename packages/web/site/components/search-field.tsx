'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';

/**
 * The search field at the right of the top bar. Without `onSearch` it is shown but off.
 * shortcut: the Feed's field stays off until the pod serves the Feed's data.
 */
export function SearchField({ placeholder, value = '', onSearch }: { placeholder: string; value?: string; onSearch?: (q: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <form
      role="search"
      className="relative block w-[320px] max-w-[40vw]"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch?.(text.trim());
      }}
    >
      <label>
        <span className="sr-only">{placeholder}</span>
        <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          name="q"
          maxLength={200}
          placeholder={placeholder}
          className="pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
          disabled={!onSearch}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {onSearch && text && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            setText('');
            onSearch('');
          }}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </form>
  );
}

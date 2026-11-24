import type { ReactNode } from 'react';

/** The bar over each page: its controls on the left, search on the right. */
export function TopBar({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <header className="sticky top-0 z-10 flex min-h-[68px] items-center gap-3 border-b bg-background/90 px-7 py-[18px] backdrop-blur-md">
      {children}
      <div className="flex-1" />
      {end}
    </header>
  );
}

/** A quiet line in the middle of an empty page. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-start justify-center gap-2 px-7 py-16 sm:items-center sm:text-center">
      <h1 className="text-balance text-[17px] font-semibold tracking-[-0.01em]">{title}</h1>
      {children && <div className="max-w-[56ch] text-pretty text-muted-foreground">{children}</div>}
    </div>
  );
}

/** Under every list of news: whose articles these are. */
export function PublisherLine() {
  return (
    <p className="mt-auto px-7 pt-10 pb-8 text-[12px] text-muted-foreground">
      These articles belong to their publishers. Read them on the publisher&apos;s site, and subscribe to the ones you value.
    </p>
  );
}

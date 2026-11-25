import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

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
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-16 text-center md:px-7">
      {/* The app's mark heads a phone's empty and connection screens. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a static export has no image server */}
      <img src="/mark.png" alt="" width={64} height={64} className="mb-3 size-16 rounded-[16px] md:hidden" />
      <h1 className="text-balance text-[17px] font-semibold tracking-[-0.01em] max-md:text-[22px] max-md:font-bold">{title}</h1>
      {children && <div className="max-w-[56ch] text-pretty text-muted-foreground max-md:text-[16px]">{children}</div>}
    </div>
  );
}

/** Under every list of news: whose articles these are, and where to read them. */
export function PublisherLine({ className }: { className?: string }) {
  return (
    <p className={cn('mt-auto px-7 pt-10 pb-8 text-[12px] text-muted-foreground', className)}>
      Each article belongs to the publisher that reported it and is protected by copyright. It is meant to be read on the publisher&apos;s own site. Subscribe to the publishers you value.
    </p>
  );
}

'use client';

import { Globe, Newspaper, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

export const NAV = [
  { href: '/', label: 'Feed', icon: Newspaper },
  { href: '/world/', label: 'World', icon: Globe },
  { href: '/you/', label: 'You', icon: UserRound },
] as const;

export function Rail() {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href.slice(0, -1)));
  return (
    <nav aria-label="Main" className="sticky top-0 hidden h-dvh w-[76px] shrink-0 flex-col items-center gap-[22px] border-r py-[22px] md:flex">
      <Link href="/" aria-label="Mera News" className="rounded-[9px]">
        {/* eslint-disable-next-line @next/next/no-img-element -- a static export has no image server */}
        <img src="/mark.png" alt="" width={34} height={34} className="size-[34px] rounded-[9px]" />
      </Link>
      <ul className="flex flex-col items-center gap-2">
        {NAV.map(({ href, label, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              aria-current={active(href) ? 'page' : undefined}
              className={cn(
                'flex size-[52px] flex-col items-center justify-center gap-1 rounded-[12px] text-[11px] text-muted-foreground transition-colors',
                'hover:bg-muted hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground',
              )}
            >
              <Icon aria-hidden className="size-5" strokeWidth={1.75} />
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

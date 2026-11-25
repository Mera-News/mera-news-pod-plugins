'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV } from '@/components/rail';
import { useConnection } from '@/components/session';

/** The phone's floating capsule of tabs, as in the app: Feed, World, You. Shown once the pod has let the phone in. */
export function TabBar() {
  const path = usePathname();
  if (useConnection().kind !== 'ready') return null;
  const active = (href: string) => (href === '/' ? path === '/' : path.startsWith(href.slice(0, -1)));
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+10px)] z-30 mx-auto max-w-[440px] rounded-full border bg-tabbar p-1.5 shadow-[0_8px_30px_rgb(0_0_0/0.28)] backdrop-blur-2xl md:hidden"
    >
      <ul className="flex">
        {NAV.map(({ href, label, icon: Icon }) => (
          <li key={href} className="flex-1">
            <Link
              href={href}
              aria-label={label}
              aria-current={active(href) ? 'page' : undefined}
              className="flex h-[52px] items-center justify-center rounded-full text-foreground/85 transition-colors aria-[current=page]:bg-tab-active aria-[current=page]:text-primary"
            >
              <Icon aria-hidden className="size-[26px]" strokeWidth={1.6} />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Gate } from '@/components/gate';
import { Rail } from '@/components/rail';
import { SessionProvider } from '@/components/session';
import { TabBar } from '@/components/tab-bar';
import { APPEARANCE_SCRIPT } from '@/lib/appearance';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mera News',
  description: 'Your news, top stories and your profile, from the Mera News pod on this computer.',
  icons: { icon: '/mark.png', apple: '/apple-touch-icon.png' },
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Mera News', statusBarStyle: 'black-translucent' },
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  viewportFit: 'cover',
  // The first match wins: a phone gets the top of its gradient ground.
  themeColor: [
    { media: '(prefers-color-scheme: dark) and (max-width: 767.98px)', color: '#140d10' },
    { media: '(prefers-color-scheme: light) and (max-width: 767.98px)', color: '#f7ece6' },
    { media: '(prefers-color-scheme: light)', color: '#f7f7f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // The head script sets data-theme before React loads.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: APPEARANCE_SCRIPT }} />
      </head>
      <body className="flex min-h-dvh bg-background font-sans text-foreground antialiased">
        <SessionProvider>
          <Rail />
          <main className="flex min-w-0 flex-1 flex-col max-md:pb-[calc(env(safe-area-inset-bottom)+84px)]">
            <Gate>{children}</Gate>
          </main>
          <TabBar />
        </SessionProvider>
      </body>
    </html>
  );
}

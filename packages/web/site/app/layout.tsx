import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { Gate } from '@/components/gate';
import { Rail } from '@/components/rail';
import { SessionProvider } from '@/components/session';
import './globals.css';

export const metadata: Metadata = {
  title: 'Mera News',
  description: 'Your news, top stories and your profile, from the Mera News pod on this computer.',
  icons: { icon: '/mark.png' },
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f7f7f7' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0a' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh bg-background font-sans text-foreground antialiased">
        <SessionProvider>
          <Rail />
          <main className="flex min-w-0 flex-1 flex-col">
            <Gate>{children}</Gate>
          </main>
        </SessionProvider>
      </body>
    </html>
  );
}

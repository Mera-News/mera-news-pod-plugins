'use client';

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Empty } from '@/components/top-bar';
import { useConnection } from '@/components/session';

const ASK = 'Ask your assistant to open Mera News.';

/** Shows the page once the pod has let this tab in, and says what to do until then. */
export function Gate({ children }: { children: ReactNode }) {
  const c = useConnection();
  switch (c.kind) {
    case 'ready':
      return children;
    case 'connecting':
      return (
        <p role="status" className="px-7 py-16 text-muted-foreground sm:text-center">
          Connecting to Mera News
        </p>
      );
    case 'no-link':
      return (
        <Empty title="Open Mera News from your assistant">
          <p>{ASK} Each link works once, in one tab, so a new tab needs a new link.</p>
          <p className="mt-2">
            Running your own pod? Get a link with <code>mera-news-pod-web link</code>.
          </p>
        </Empty>
      );
    case 'link-refused':
      return (
        <Empty title="This link has expired">
          <p>A link works once and for 10 minutes. {ASK}</p>
        </Empty>
      );
    case 'ended':
      return (
        <Empty title="This page needs a new link">
          <p>Mera News restarted, or this page was left open unused for a long time. {ASK}</p>
        </Empty>
      );
    case 'offline':
      return (
        <Empty title="Mera News is not running">
          <p>Open your AI app, or start your pod, then try again.</p>
          <Button className="mt-4" onClick={() => location.reload()}>
            Try again
          </Button>
        </Empty>
      );
    case 'unavailable':
      return (
        <Empty title="The Mera News website could not start">
          <p>Restart your AI app or your pod. If it happens again, the pod&apos;s log says why.</p>
        </Empty>
      );
  }
}

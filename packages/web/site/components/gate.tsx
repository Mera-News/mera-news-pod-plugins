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
    case 'not-paired':
      return (
        <Empty title="Pair this phone with Mera News">
          <p>On your computer, open Mera News, go to You and choose Add a phone. Then scan the code with this phone&apos;s camera.</p>
        </Empty>
      );
    case 'pair-refused':
      return <PairRefused error={c.error} />;
    case 'unavailable':
      return (
        <Empty title="The Mera News website could not start">
          <p>Restart your AI app or your pod. If it happens again, the pod&apos;s log says why.</p>
        </Empty>
      );
  }
}

function PairRefused({ error }: { error: string }) {
  if (error === 'too_many_tries') {
    return (
      <Empty title="Too many tries">
        <p>Wait a minute, then scan the code again.</p>
      </Empty>
    );
  }
  if (error === 'too_many_devices') {
    return (
      <Empty title="Too many phones are paired">
        <p>On your computer, go to You and remove a phone you no longer use. Then add this one again.</p>
      </Empty>
    );
  }
  return (
    <Empty title="This code no longer works">
      <p>A code works once, for 10 minutes. On your computer, go to You and choose Add a phone again.</p>
    </Empty>
  );
}

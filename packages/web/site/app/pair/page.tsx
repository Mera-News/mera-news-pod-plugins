'use client';

import { useEffect } from 'react';
import { useConnection } from '@/components/session';

/** Where a phone's pairing code lands. Pairing happens as the page connects; a paired phone goes on to its news. */
export default function PairPage() {
  const ready = useConnection().kind === 'ready';
  useEffect(() => {
    if (ready) location.replace('/');
  }, [ready]);
  return null;
}

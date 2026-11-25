'use client';

import { useSyncExternalStore } from 'react';

/** Below this width the site is the phone version: the app's look, its pill switcher and tab bar. */
const QUERY = '(max-width: 767.98px)';

const subscribe = (fn: () => void) => {
  const m = matchMedia(QUERY);
  m.addEventListener('change', fn);
  return () => m.removeEventListener('change', fn);
};

/** True on a phone-sized screen. The export is built for the desktop; a phone switches as the page starts. */
export const usePhone = () =>
  useSyncExternalStore(
    subscribe,
    () => matchMedia(QUERY).matches,
    () => false,
  );

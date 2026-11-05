'use client';

import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getSnapshot() {
  return window.matchMedia(QUERY).matches;
}

/**
 * Whether the visitor asked for reduced motion, safe to branch markup on.
 *
 * framer-motion's useReducedMotion() reads matchMedia during the first
 * client render, so markup chosen from it differs from the server's and
 * hydration fails. Here the server snapshot is false, React hydrates with
 * that, and re-renders with the visitor's real preference straight after,
 * and again whenever it changes.
 */
export function useHydratedReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

'use client';

import { useSyncExternalStore } from 'react';

import LocalTime from '@/components/LocalTime';
import { WINDOW_HEAD, WINDOW_TAIL } from '@/lib/schedule/rules';

const TICK_MS = 15_000;
const subscribe = (notify: () => void) => {
  const timer = window.setInterval(notify, TICK_MS);
  return () => window.clearInterval(timer);
};

/**
 * The clock the window line reads: the viewer's own, ticking a few times a
 * minute so the line goes away when the window ends. On the server it is 0, so
 * a window in the future is shown there and then corrected on the first tick.
 */
export function useNow(): number {
  const tick = useSyncExternalStore(subscribe, () => Math.floor(Date.now() / TICK_MS), () => 0);
  return tick * TICK_MS;
}

/** Is this run's warning window still open? */
export function windowIsOpen(startsAt: string | null | undefined, nowMs: number): boolean {
  if (!startsAt) return false;
  const at = Date.parse(startsAt);
  return Number.isFinite(at) && at > nowMs;
}

/**
 * "Starts at 14:10, Skip or Stop until then", in the viewer's own clock, while a
 * run's warning window is open, and nothing once it is over. The Scheduled tab
 * and History say it in the same words.
 */
export default function RunWindow({ startsAt, className = '' }: { startsAt: string | null | undefined; className?: string }) {
  const now = useNow();
  if (!startsAt || !windowIsOpen(startsAt, now)) return null;
  return (
    <p className={className}>
      {WINDOW_HEAD}
      <LocalTime value={startsAt} format="time" options={{ hour: '2-digit', minute: '2-digit', hour12: false }} />
      {WINDOW_TAIL}
    </p>
  );
}

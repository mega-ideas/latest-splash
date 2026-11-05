'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';

import LocalTime from '@/components/LocalTime';
import { WINDOW_HEAD, WINDOW_TAIL, windowOpenNow } from '@/lib/schedule/rules';

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

/**
 * How far the server's clock is ahead of this device's, read when the answer arrived. The window is open or over by the SERVER's time:
 * a device whose clock runs fast must not hide the line, or the Stop button, while the window is still open.
 */
export function useSkew(serverNowMs: number | null | undefined): number {
  const [skew, setSkew] = useState(0);
  // A new answer carries a new server time, so the skew is read again with it (the device clock is read here, not while rendering).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the skew is measured when an answer arrives
    setSkew(typeof serverNowMs === 'number' && Number.isFinite(serverNowMs) ? serverNowMs - Date.now() : 0);
  }, [serverNowMs]);
  return skew;
}

/** Is this run's warning window still open? The server said so (when it did), and by its clock it has not ended. */
export function windowIsOpen(startsAt: string | null | undefined, nowMs: number, skewMs = 0, serverSaysOpen: boolean | undefined = undefined): boolean {
  if (serverSaysOpen === false) return false;
  return windowOpenNow(startsAt, nowMs, skewMs);
}

/**
 * "Starts at 14:10, Skip or Stop until then", in the viewer's own clock, while a
 * run's warning window is open, and nothing once it is over. The Scheduled tab
 * and History say it in the same words.
 */
export default function RunWindow({ startsAt, windowOpen, serverNowMs, className = '' }: { startsAt: string | null | undefined; windowOpen?: boolean; serverNowMs?: number | null; className?: string }) {
  const now = useNow();
  const skew = useSkew(serverNowMs);
  if (!startsAt || !windowIsOpen(startsAt, now, skew, windowOpen)) return null;
  return (
    <p className={className}>
      {WINDOW_HEAD}
      <LocalTime value={startsAt} format="time" options={{ hour: '2-digit', minute: '2-digit', hour12: false }} />
      {WINDOW_TAIL}
    </p>
  );
}

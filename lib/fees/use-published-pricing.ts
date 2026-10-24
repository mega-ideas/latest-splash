'use client';

import { useEffect, useState } from 'react';

import { scheduleFromWire, type FeeScheduleWire, type PricingSummary } from './copy.ts';
import type { FeeSchedule } from './schedule.ts';

/**
 * The published schedule, its prices in words, and whether Splash's fees are
 * on. While they are off (no fee recipient applied yet) a fee computed under
 * the schedule is 0: pass `{ feesOn, schedule }` as the quote's state.
 */
export type PublishedFees = { pricing: PricingSummary; schedule: FeeSchedule; feesOn: boolean };

/**
 * GET /api/fees/schedule's answer, checked: null unless it says whether the
 * fees are on and carries a schedule that checks out. A caller then shows no
 * price rather than a guessed one.
 */
export function publishedFeesFromBody(body: unknown): PublishedFees | null {
  if (!body || typeof body !== 'object') return null;
  const { pricing, schedule, feesOn } = body as { pricing?: PricingSummary; schedule?: FeeScheduleWire; feesOn?: unknown };
  if (typeof feesOn !== 'boolean' || !pricing || pricing.feesOn !== feesOn || !schedule) return null;
  try {
    return { pricing, schedule: scheduleFromWire(schedule), feesOn };
  } catch {
    // A schedule that does not check out is no schedule.
    return null;
  }
}

/**
 * Splash's published schedule for a client component, and its prices in
 * words, from the schedule in force (GET /api/fees/schedule). Null until it
 * has loaded, and null if it cannot: a caller shows no price rather than a
 * remembered one. A payment's own fee is its quote, never this.
 */
export function usePublishedFees(): PublishedFees | null {
  const [fees, setFees] = useState<PublishedFees | null>(null);
  useEffect(() => {
    let active = true;
    void fetch('/api/fees/schedule')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (!active) return;
        const published = publishedFeesFromBody(body);
        if (published) setFees(published);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return fees;
}

/** The prices in words alone. */
export function usePublishedPricing(): PricingSummary | null {
  return usePublishedFees()?.pricing ?? null;
}

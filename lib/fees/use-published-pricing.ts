'use client';

import { useEffect, useState } from 'react';

import { scheduleFromWire, type FeeScheduleWire, type PricingSummary } from './copy.ts';
import type { FeeSchedule } from './schedule.ts';

export type PublishedFees = { pricing: PricingSummary; schedule: FeeSchedule };

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
      .then((body: { pricing?: PricingSummary; schedule?: FeeScheduleWire } | null) => {
        if (!active || !body?.pricing || !body.schedule) return;
        try {
          setFees({ pricing: body.pricing, schedule: scheduleFromWire(body.schedule) });
        } catch {
          // A schedule that does not check out is no schedule.
        }
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

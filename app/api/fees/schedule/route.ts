import { NextResponse } from 'next/server';

import { pricingSummary, scheduleToWire } from '@/lib/fees/copy';
import { publishedFeeSchedule } from '@/lib/fees/fee-config';

export const dynamic = 'force-dynamic';

/**
 * Splash's published fee schedule, as data (Amendment A1 §2.7): the live
 * FeeConfig's when it can be read, else the launch schedule, and the pricing
 * phrases rendered from it. Public: it is the price list. A client component
 * that shows a price renders it from this, never from a typed-in rate; a
 * payment's own fee is its quote (/api/quotes).
 */
export async function GET() {
  const { schedule, source } = await publishedFeeSchedule();
  return NextResponse.json(
    { source, schedule: scheduleToWire(schedule), pricing: pricingSummary(schedule) },
    { headers: { 'Cache-Control': 'public, max-age=60' } },
  );
}

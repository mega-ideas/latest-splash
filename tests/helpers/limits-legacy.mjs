/**
 * A business that existed before limits started from the 50,000 / 100,000 figures
 * (migration 0086 gives every existing business a row for each limit, at the figures it already ran
 * on: 2,000, 5,000 and 20,000 USDC and 90 days). A test that wants such a business writes the same rows.
 */
import * as schema from '../../lib/db/schema.ts';

const U = (usdc) => BigInt(Math.round(usdc * 1_000_000));

export const LEGACY_LIMITS = Object.freeze({ per_payment: U(2_000), daily: U(5_000), monthly: U(20_000), days: 90n });

export async function pinLegacyLimits(db, orgIds) {
  for (const orgId of orgIds) {
    for (const [kind, value] of Object.entries(LEGACY_LIMITS)) {
      await db
        .insert(schema.businessLimits)
        .values({ orgId, kind, value, source: 'raised', changedBy: 'system:migration', requestId: null, heldMax: value, updatedAt: new Date('2026-10-01T00:00:00Z') })
        .onConflictDoNothing();
    }
  }
}

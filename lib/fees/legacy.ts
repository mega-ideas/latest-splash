/**
 * The one place that still names the flat rate A1 §2.8 retired.
 *
 * Until A1 a proposal's financial impact carried a flat per-corridor fee
 * rate, and the approval canon (lib/proposals/canonical-hash.ts) hashed it
 * under this field name. Proposals stored then still carry it, and their
 * approvals were given over a hash that includes it: to verify those
 * approvals, the canon of a stored proposal is computed exactly as it was,
 * which means naming the field. Nothing writes it any more; a new proposal
 * carries `splashFeeMinor`, Splash's fee from the schedule.
 *
 * It lives in lib/fees/, the directory A1 §2.8's grep exempts, so the rest of
 * the tree never names the retired rate.
 */
export const RETIRED_FLAT_RATE_FIELD = 'feeBps' as const;

/** The retired flat rate a stored proposal carries, if it does. */
export function retiredFlatRate(impact: object | undefined): number | undefined {
  const value = impact ? (impact as Record<string, unknown>)[RETIRED_FLAT_RATE_FIELD] : undefined;
  return typeof value === 'number' ? value : undefined;
}

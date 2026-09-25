/**
 * Minimum settlement size — one source of truth for the whole product.
 *
 * Every corridor payout carries fixed costs that do not scale down: an on-chain
 * settlement, an audit anchor, a Walrus/Seal evidence write, and a partner
 * payout leg. Below ~$100 that fixed cost outweighs the 0.70% corridor fee, and
 * on the settlement side a sub-minimum batch cannot even clear DeepBook's
 * minimum order size — it returns a zero quote and aborts (see S-11 in
 * docs/KEY-CEREMONY-RUNBOOK.md).
 *
 * Applies to a SINGLE transfer, and to a BATCH's TOTAL (not per row — payroll
 * batches legitimately contain small individual rows).
 *
 * Pure module: no I/O, no server-only imports, so the agent, the API routes,
 * the policy engine and the UI can all share exactly one rule.
 */

/** Minor units per USD (micro-USD), matching the ledger convention. */
export const USD_MICRO = 1_000_000;

/** Default floor in whole USD. Override with MIN_SETTLEMENT_USD. */
export const DEFAULT_MIN_SETTLEMENT_USD = 100;

export function minSettlementUsd(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseFloat((env.MIN_SETTLEMENT_USD ?? '').trim());
  // A malformed or non-positive override must not silently disable the floor.
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_SETTLEMENT_USD;
}

export function minSettlementMicro(env: NodeJS.ProcessEnv = process.env): number {
  return Math.round(minSettlementUsd(env) * USD_MICRO);
}

export type SettlementKind = 'transfer' | 'batch';

export type MinimumCheck =
  | { ok: true }
  | { ok: false; minimumUsd: number; amountUsd: number; message: string };

/**
 * Enforce the floor. `amountUsd` is the single transfer amount, or the batch
 * TOTAL. NaN / non-finite / non-positive all fail closed.
 */
export function checkMinimumSettlement(
  amountUsd: number,
  kind: SettlementKind = 'transfer',
  env: NodeJS.ProcessEnv = process.env,
): MinimumCheck {
  const minimumUsd = minSettlementUsd(env);

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return {
      ok: false,
      minimumUsd,
      amountUsd: Number.isFinite(amountUsd) ? amountUsd : 0,
      message: `Enter an amount. The minimum ${kind === 'batch' ? 'batch total' : 'transfer'} is ${formatUsd(minimumUsd)}.`,
    };
  }

  if (amountUsd + 1e-9 < minimumUsd) {
    return {
      ok: false,
      minimumUsd,
      amountUsd,
      message: kind === 'batch'
        ? `Batch total is ${formatUsd(amountUsd)}. The minimum batch total is ${formatUsd(minimumUsd)} — add rows or increase the amounts.`
        : `Transfer is ${formatUsd(amountUsd)}. The minimum transfer is ${formatUsd(minimumUsd)}.`,
    };
  }

  return { ok: true };
}

export function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

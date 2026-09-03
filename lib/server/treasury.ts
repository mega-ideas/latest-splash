/**
 * Smart Treasury — two-bucket model with OFF-CHAIN per-user accounting.
 *
 *   Available balance  → USDC, 0% yield, instant. Operating cash for payments.
 *   Smart Treasury     → Ondo USDY, floating ~net APY, T+1–T+3 withdrawal notice.
 *
 * On-chain we hold two omnibus `SmartTreasury<T>` pools (USDC + USDY); this
 * ledger is the source of truth for individual user claims. Reconcile daily and
 * anchor the snapshot to Walrus via audit_anchor.move.
 *
 * Invariants (checked daily):
 *   Σ(available)               == USDC pool value
 *   Σ(principal + yield)       == USDY pool units × redemption price
 *
 * Amounts are micro-USD (1 USD = 1_000_000), kept as JS numbers (safe to ~$9B).
 * No per-user on-chain objects — omnibus + this ledger only.
 */

import { deriveYieldMicros, spreadOnGain } from '@/lib/policy/yield-accrual';
import { getTreasuryRate, getUsdyRedemptionPrice, navIsDecidable, quoteSwap } from './usdy';

export type UserTreasuryLedger = {
  userId: string;
  availableMicro: number; // USDC, 0%, no notice period
  treasuryPrincipalMicro: number; // USDC-equivalent moved into USDY
  treasuryYieldMicro: number; // accrued, unredeemed yield
  updatedAt: string;
};

export type WithdrawalNoticeState = 'PENDING' | 'SWAPPING' | 'SETTLED' | 'CANCELLED';

export type WithdrawalNotice = {
  id: string;
  userId: string;
  amountMicro: number;
  requestedAt: string;
  /** When the funds land back in Available (T+1–T+3). */
  availableAt: string;
  state: WithdrawalNoticeState;
};

export type YieldSnapshot = {
  date: string;
  /** `null` when NAV was UNAVAILABLE — never a substituted default. */
  redemptionPriceUsd: number | null;
  /** Provenance for the price the accrual used, so a reader can age it. */
  navStatus: 'LIVE' | 'STALE' | 'UNAVAILABLE';
  navAsOf: string | null;
  navSource: string;
  totalTreasuryMicro: number;
  yieldDistributedMicro: number;
  spreadToOperatingMicro: number;
  /** Set when the run deliberately recorded nothing, with the reason. */
  skippedReason?: string;
};

// ─── In-memory store (demo). Swap for a DB + omnibus reconciliation in prod. ────

const ledgers = new Map<string, UserTreasuryLedger>();
const notices: WithdrawalNotice[] = [];
let noticeCounter = 0;

/**
 * Last NAV the accrual actually recorded against, in micro-USD.
 *
 * Yield is a price DELTA, so accrual needs the previous observation. `null`
 * means no baseline yet — the next reading establishes one and records nothing,
 * which is correct: there is no delta from a price we never saw.
 */
let lastAccruedPriceMicros: bigint | null = null;

const DEMO_USER = 'demo-business';
function seedDemo(): UserTreasuryLedger {
  const existing = ledgers.get(DEMO_USER);
  if (existing) return existing;
  const seeded: UserTreasuryLedger = {
    userId: DEMO_USER,
    availableMicro: 11_140_000_000, // $11,140 operating (matches Overview)
    treasuryPrincipalMicro: 24_500_000_000, // $24,500 in Smart Treasury
    treasuryYieldMicro: 98_720_000, // $98.72 accrued
    updatedAt: new Date().toISOString(),
  };
  ledgers.set(DEMO_USER, seeded);
  return seeded;
}

export function getLedger(userId: string = DEMO_USER): UserTreasuryLedger {
  return ledgers.get(userId) ?? seedDemo();
}

export function listLedgers(): UserTreasuryLedger[] {
  if (ledgers.size === 0) seedDemo();
  return [...ledgers.values()];
}

// Notice window in business days. USDY is short-dated-T-bill backed, so this is
// a fast, liquid window by design (working capital, not a lock-up). Bounded to
// [1, 10] business days: 1–2 is the realistic headline, up to 5 (one business
// week) is a defensible liquidity-management buffer; longer is discouraged.
const NOTICE_DAYS_MAX = 10;

export function noticeWindowDays(): number {
  const n = Number(process.env.USDY_WITHDRAWAL_DAYS ?? 2);
  return Math.min(NOTICE_DAYS_MAX, Math.max(1, Number.isFinite(n) ? Math.round(n) : 2));
}

/** Single source of truth for withdrawal-window copy — UI never hardcodes it. */
export function noticeWindowLabel(): string {
  const n = noticeWindowDays();
  return n === 1 ? 'next business day' : `1–${n} business days`;
}

/** Add N business days (skip Sat/Sun) — the T+1–T+3 settlement window. */
function addBusinessDays(from: Date, days: number): Date {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d;
}

// ─── Moves ──────────────────────────────────────────────────────────────────

/** Available (USDC) → Smart Treasury (USDY). Quotes a guarded USDC→USDY swap. */
export async function moveToTreasury(userId: string, amountMicro: number) {
  const ledger = getLedger(userId);
  if (amountMicro <= 0) throw new Error('amount must be positive');
  if (amountMicro > ledger.availableMicro) throw new Error('insufficient available balance');
  const swap = await quoteSwap('usdc->usdy', BigInt(amountMicro));
  ledger.availableMicro -= amountMicro;
  ledger.treasuryPrincipalMicro += amountMicro;
  ledger.updatedAt = new Date().toISOString();
  return { ledger, swap };
}

/**
 * Smart Treasury → Available requires a withdrawal NOTICE (T+1–T+3). Funds are
 * reserved now; the USDY→USDC swap + credit happen on settle.
 */
export function requestTreasuryWithdrawal(userId: string, amountMicro: number): WithdrawalNotice {
  const ledger = getLedger(userId);
  const redeemable = ledger.treasuryPrincipalMicro + ledger.treasuryYieldMicro;
  if (amountMicro <= 0) throw new Error('amount must be positive');
  if (amountMicro > redeemable) throw new Error('insufficient treasury balance');
  const now = new Date();
  const notice: WithdrawalNotice = {
    id: `wn_${Date.now()}_${++noticeCounter}`,
    userId,
    amountMicro,
    requestedAt: now.toISOString(),
    availableAt: addBusinessDays(now, noticeWindowDays()).toISOString(),
    state: 'PENDING',
  };
  // Reserve against principal first, then accrued yield.
  const fromPrincipal = Math.min(amountMicro, ledger.treasuryPrincipalMicro);
  ledger.treasuryPrincipalMicro -= fromPrincipal;
  ledger.treasuryYieldMicro -= amountMicro - fromPrincipal;
  ledger.updatedAt = now.toISOString();
  notices.push(notice);
  return notice;
}

/** On settlement: swap USDY→USDC (guarded) and credit Available. */
export async function settleWithdrawal(noticeId: string) {
  const notice = notices.find((n) => n.id === noticeId);
  if (!notice) throw new Error('notice not found');
  if (notice.state === 'SETTLED') return notice;
  if (notice.state === 'CANCELLED') throw new Error('withdrawal was cancelled');
  notice.state = 'SWAPPING';
  await quoteSwap('usdy->usdc', BigInt(notice.amountMicro));
  const ledger = getLedger(notice.userId);
  ledger.availableMicro += notice.amountMicro;
  ledger.updatedAt = new Date().toISOString();
  notice.state = 'SETTLED';
  return notice;
}

/**
 * Settle every PENDING notice whose window has elapsed (availableAt ≤ now). This
 * is what actually credits Available on schedule — call it from the
 * settle-withdrawals cron. `force` settles all PENDING regardless of date and is
 * demo-only (used to fast-forward the T+N window without waiting real days).
 */
export async function settleDueWithdrawals(opts: { force?: boolean } = {}): Promise<WithdrawalNotice[]> {
  const now = Date.now();
  const due = notices.filter(
    (n) => n.state === 'PENDING' && (opts.force === true || new Date(n.availableAt).getTime() <= now),
  );
  const settled: WithdrawalNotice[] = [];
  for (const n of due) settled.push(await settleWithdrawal(n.id));
  return settled;
}

/**
 * Cancel a still-pending withdrawal and return the reserved funds to Treasury.
 * Completes the notice state machine (PENDING → CANCELLED).
 */
/**
 * Cancel a pending withdrawal notice.
 *
 * `userId` is REQUIRED and checked against the notice's owner. It used to be
 * absent: any caller who had seen an id (they are handed out by the snapshot
 * endpoint) could cancel any other tenant's withdrawal. Harmless while every
 * caller resolves to the same demo ledger, and a cross-tenant write the moment
 * ledgers are keyed per user — which is exactly the kind of latent hole that
 * gets missed during the migration that introduces it.
 */
export function cancelTreasuryWithdrawal(noticeId: string, userId: string): WithdrawalNotice {
  const notice = notices.find((n) => n.id === noticeId);
  // Same error for "does not exist" and "belongs to someone else" — otherwise
  // the response distinguishes them and the endpoint becomes an id oracle.
  if (!notice || notice.userId !== userId) throw new Error('notice not found');
  if (notice.state !== 'PENDING') throw new Error(`cannot cancel a ${notice.state} withdrawal`);
  const ledger = getLedger(notice.userId);
  ledger.treasuryPrincipalMicro += notice.amountMicro; // un-reserve
  ledger.updatedAt = new Date().toISOString();
  notice.state = 'CANCELLED';
  return notice;
}

export function listNotices(userId?: string): WithdrawalNotice[] {
  return userId ? notices.filter((n) => n.userId === userId) : [...notices];
}

// ─── Daily yield accrual (called by the accrue-yield cron) ──────────────────────

/**
 * Derive the day's yield from the POSITION, never from a configured APY.
 *
 * This used to be:
 *
 *     const dailyFactor = rate.netApyPct / 100 / 365;
 *     ledger.treasuryYieldMicro += floor(principal * dailyFactor);
 *
 * — a configured APY writing a balance change. That inverts the only invariant
 * that matters here:
 *
 *     Positions create yield. The ledger RECORDS it. The ledger never CREATES it.
 *
 * The old form credited yield that no instrument had earned, on a schedule the
 * cron controlled, and it did so whether or not the position existed or the
 * price had moved. It also fetched the redemption price and then ignored it —
 * the number was displayed in the snapshot while the arithmetic came from the
 * APY constant.
 *
 * USDY accrues through price, so the day's yield IS the price delta on units
 * held. With no live NAV there is no yield to record, and we record none —
 * accruing against a stale or invented price is how a ledger drifts away from
 * the assets that are supposed to back it.
 */
export async function accrueDailyYield(): Promise<YieldSnapshot> {
  const nav = await getUsdyRedemptionPrice();

  // FAIL CLOSED. No decidable NAV, no accrual. A skipped day is recoverable
  // from the next reading (price deltas compose); a day accrued against a
  // fabricated $1.00 is silently wrong forever.
  if (!navIsDecidable(nav) || nav.priceMicros === null) {
    return {
      date: new Date().toISOString().slice(0, 10),
      redemptionPriceUsd: null,
      navStatus: nav.status,
      navAsOf: nav.asOf,
      navSource: nav.source,
      totalTreasuryMicro: listLedgers().reduce((sum, l) => sum + l.treasuryPrincipalMicro, 0),
      yieldDistributedMicro: 0,
      spreadToOperatingMicro: 0,
      skippedReason: `NAV ${nav.status} — no accrual recorded`,
    };
  }

  const previous = lastAccruedPriceMicros;
  lastAccruedPriceMicros = nav.priceMicros;

  // First observation establishes the baseline. There is no delta to record yet.
  if (previous === null) {
    return {
      date: new Date().toISOString().slice(0, 10),
      redemptionPriceUsd: Number(nav.priceMicros) / 1_000_000,
      navStatus: nav.status,
      navAsOf: nav.asOf,
      navSource: nav.source,
      totalTreasuryMicro: listLedgers().reduce((sum, l) => sum + l.treasuryPrincipalMicro, 0),
      yieldDistributedMicro: 0,
      spreadToOperatingMicro: 0,
      skippedReason: 'first NAV observation — baseline established, no delta to record',
    };
  }

  // Price can fall. `deriveYieldMicros` returns a negative figure in that case
  // — a redemption price that moved down is a real loss on the position, and
  // clamping it at zero would report a floor the instrument does not have.
  let distributed = 0;
  for (const ledger of listLedgers()) {
    const result = deriveYieldMicros({
      principalMicro: BigInt(ledger.treasuryPrincipalMicro),
      priceMicros: nav.priceMicros,
      previousPriceMicros: previous,
    });
    if (!result.accrued) continue;
    const dayYield = Number(result.yieldMicro);
    ledger.treasuryYieldMicro += dayYield;
    ledger.updatedAt = new Date().toISOString();
    distributed += dayYield;
  }

  const spread = Number(spreadOnGain(BigInt(Math.trunc(distributed))));
  const total = listLedgers().reduce((sum, l) => sum + l.treasuryPrincipalMicro, 0);
  return {
    date: new Date().toISOString().slice(0, 10),
    redemptionPriceUsd: Number(nav.priceMicros) / 1_000_000,
    navStatus: nav.status,
    navAsOf: nav.asOf,
    navSource: nav.source,
    totalTreasuryMicro: total,
    yieldDistributedMicro: distributed,
    spreadToOperatingMicro: spread,
  };
}

/** Test seam — the baseline is process-global and would leak across tests. */
export function resetAccrualBaselineForTesting() {
  lastAccruedPriceMicros = null;
}

// ─── Invariants (daily reconciliation) ──────────────────────────────────────────

export function checkInvariants(poolUsdcMicro: number, poolUsdyUnitsMicro: number, redemptionPriceUsd: number) {
  const sumAvailable = listLedgers().reduce((s, l) => s + l.availableMicro, 0);
  const sumTreasury = listLedgers().reduce((s, l) => s + l.treasuryPrincipalMicro + l.treasuryYieldMicro, 0);
  const usdyValueMicro = Math.round(poolUsdyUnitsMicro * redemptionPriceUsd);
  const availableOk = sumAvailable <= poolUsdcMicro; // pool must cover claims
  const treasuryOk = sumTreasury <= usdyValueMicro;
  return {
    ok: availableOk && treasuryOk,
    sumAvailable,
    poolUsdcMicro,
    sumTreasury,
    usdyValueMicro,
    availableOk,
    treasuryOk,
  };
}

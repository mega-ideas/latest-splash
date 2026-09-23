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
import * as repo from './repository/treasury.ts';
import { getUsdyRedemptionPrice, navIsDecidable, navPriceUsd, quoteSwap } from './usdy';

export type UserTreasuryLedger = {
  userId: string;
  availableMicro: number; // USDC, 0%, instant
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
  /** Exact decimal string, or null when the NAV is unavailable. */
  redemptionPriceUsd: string | null;
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

// ─── Two backends ──────────────────────────────────────────────────────────
//
// Postgres when `DATABASE_URL` is configured; the in-process maps only when it
// is not, because `npm run dev` has to work without a database.
//
// Everything below used to be process state alone, which meant a restart set
// every customer's treasury back to zero, dropped every pending withdrawal
// notice — a notice is a promise that funds land on a stated date — and reset
// the accrual baseline, which silently skipped a day of yield for everybody.

const ledgers = new Map<string, UserTreasuryLedger>();
const notices: WithdrawalNotice[] = [];
let noticeCounter = 0;

/**
 * Last NAV the accrual actually recorded against, in micro-USD.
 *
 * Yield is a price DELTA, so accrual needs the previous observation. `null`
 * means no baseline yet — the next reading establishes one and records nothing,
 * which is correct: there is no delta from a price we never saw. Persisted, so
 * that "no baseline" means the first run ever rather than the first run since
 * the last deploy.
 */
let lastAccruedPriceMicros: bigint | null = null;

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[treasury] DATABASE_URL is not set, so balances and withdrawal notices ' +
        'live in this process and disappear when it restarts. Local development only.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

/**
 * The bigint→number boundary, in one place and range-checked.
 *
 * Money is `bigint` in the column and `number` micro-USD in this module's
 * public API, which predates the move to Postgres. That conversion is exact
 * below 2^53 and silently lossy above it — `Number(9007199254740993n)` is
 * 9007199254740992, and a balance that quietly loses its last digit is the
 * exact failure `lib/money.ts` exists to prevent.
 *
 * So it throws instead. 2^53 micro-USD is about $9.007 billion in one org's
 * ledger: not a number this product reaches, and not one to discover by
 * rounding. A bare `Number(...)` here would have been a silent truncation with
 * no ceiling at all, which is why `scripts/check-copy.mjs` refuses it.
 */
function microToNumber(micro: bigint, field: string): number {
  if (micro > BigInt(Number.MAX_SAFE_INTEGER) || micro < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `treasury: ${field} = ${micro} micro-USD exceeds the safe integer range and cannot be ` +
        'represented exactly. The ledger must move to bigint end-to-end before a balance this large.',
    );
  }
  return Number(micro);
}

function ledgerFromRow(row: repo.LedgerRow): UserTreasuryLedger {
  return {
    userId: row.orgId,
    availableMicro: microToNumber(row.availableMicro, 'availableMicro'),
    treasuryPrincipalMicro: microToNumber(row.treasuryPrincipalMicro, 'treasuryPrincipalMicro'),
    treasuryYieldMicro: microToNumber(row.treasuryYieldMicro, 'treasuryYieldMicro'),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function noticeFromRow(row: repo.NoticeRow): WithdrawalNotice {
  return {
    id: row.id,
    userId: row.orgId,
    amountMicro: microToNumber(row.amountMicro, 'amountMicro'),
    requestedAt: row.requestedAt.toISOString(),
    availableAt: row.availableAt.toISOString(),
    state: row.state as WithdrawalNoticeState,
  };
}

/** Write a ledger back. The only place balances leave this module. */
async function saveLedger(ledger: UserTreasuryLedger): Promise<UserTreasuryLedger> {
  if (!usingPostgres()) {
    ledgers.set(ledger.userId, ledger);
    return ledger;
  }
  await repo.upsertLedger(await db(), {
    orgId: ledger.userId,
    availableMicro: BigInt(Math.trunc(ledger.availableMicro)),
    treasuryPrincipalMicro: BigInt(Math.trunc(ledger.treasuryPrincipalMicro)),
    treasuryYieldMicro: BigInt(Math.trunc(ledger.treasuryYieldMicro)),
    updatedAt: new Date(ledger.updatedAt),
  });
  return ledger;
}

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

/**
 * One org's treasury ledger.
 *
 * This used to be `ledgers.get(userId) ?? seedDemo()`, and `seedDemo()` only
 * ever writes the `demo-business` key. So EVERY org that was not the demo
 * one fell through to the demo ledger — and every mutation then ran against
 * `ledger.userId`, which was `'demo-business'`. One shared treasury: any
 * tenant could move or withdraw another tenant's principal, and the balance
 * on every dashboard was the same balance.
 *
 * An unknown org now gets a ledger OF ITS OWN, starting at zero. Zero is the
 * honest opening balance for a treasury nobody has funded; the alternative
 * was showing them somebody else's money.
 */
export async function getLedger(userId: string): Promise<UserTreasuryLedger> {
  if (!usingPostgres()) {
    const existing = ledgers.get(userId);
    if (existing) return existing;
    if (userId === DEMO_USER) return seedDemo();
    const fresh: UserTreasuryLedger = {
      userId,
      availableMicro: 0,
      treasuryPrincipalMicro: 0,
      treasuryYieldMicro: 0,
      updatedAt: new Date().toISOString(),
    };
    ledgers.set(userId, fresh);
    return fresh;
  }

  const row = await repo.findLedger(await db(), userId);
  if (row) return ledgerFromRow(row);

  // A treasury nobody has funded opens at zero. Note the demo seed is NOT
  // applied here: a fixture written to a real ledger is money that does not
  // exist, and every reconciliation after it would be wrong by that amount.
  return {
    userId,
    availableMicro: 0,
    treasuryPrincipalMicro: 0,
    treasuryYieldMicro: 0,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Every org's ledger.
 *
 * Cross-tenant on purpose and named for it: the accrual job pays yield to all
 * of them and the daily reconciliation sums all of them. Nothing a customer can
 * reach calls this.
 */
export async function listLedgersForStaff(): Promise<UserTreasuryLedger[]> {
  if (!usingPostgres()) {
    if (ledgers.size === 0) seedDemo();
    return [...ledgers.values()];
  }
  return (await repo.listLedgersForStaff(await db())).map(ledgerFromRow);
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
  const ledger = await getLedger(userId);
  if (amountMicro <= 0) throw new Error('amount must be positive');
  if (amountMicro > ledger.availableMicro) throw new Error('insufficient available balance');
  const swap = await quoteSwap('usdc->usdy', BigInt(amountMicro));
  ledger.availableMicro -= amountMicro;
  ledger.treasuryPrincipalMicro += amountMicro;
  ledger.updatedAt = new Date().toISOString();
  await saveLedger(ledger);
  return { ledger, swap };
}

/**
 * Smart Treasury → Available requires a withdrawal NOTICE (T+1–T+3). Funds are
 * reserved now; the USDY→USDC swap + credit happen on settle.
 */
export async function requestTreasuryWithdrawal(
  userId: string,
  amountMicro: number,
): Promise<WithdrawalNotice> {
  const ledger = await getLedger(userId);
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

  // The reservation and the notice are one fact. Written in this order so a
  // failure between them leaves funds reserved with no notice — recoverable by
  // support — rather than a notice promising money that was never reserved.
  await saveLedger(ledger);
  await saveNotice(notice);
  return notice;
}

/** Persist a notice, on whichever backend is in use. */
async function saveNotice(notice: WithdrawalNotice): Promise<void> {
  if (!usingPostgres()) {
    const index = notices.findIndex((n) => n.id === notice.id);
    if (index >= 0) notices[index] = notice;
    else notices.push(notice);
    return;
  }
  const existing = await repo.findNotice(await db(), notice.id);
  if (existing) {
    await repo.setNoticeState(await db(), notice.id, notice.state);
    return;
  }
  await repo.insertNotice(await db(), {
    id: notice.id,
    orgId: notice.userId,
    amountMicro: BigInt(Math.trunc(notice.amountMicro)),
    requestedAt: new Date(notice.requestedAt),
    availableAt: new Date(notice.availableAt),
    state: notice.state,
  });
}

async function findNotice(noticeId: string): Promise<WithdrawalNotice | null> {
  if (!usingPostgres()) return notices.find((n) => n.id === noticeId) ?? null;
  const row = await repo.findNotice(await db(), noticeId);
  return row ? noticeFromRow(row) : null;
}

/** On settlement: swap USDY→USDC (guarded) and credit Available. */
export async function settleWithdrawal(noticeId: string) {
  const notice = await findNotice(noticeId);
  if (!notice) throw new Error('notice not found');
  if (notice.state === 'SETTLED') return notice;
  if (notice.state === 'CANCELLED') throw new Error('withdrawal was cancelled');

  notice.state = 'SWAPPING';
  await saveNotice(notice);

  await quoteSwap('usdy->usdc', BigInt(notice.amountMicro));
  const ledger = await getLedger(notice.userId);
  ledger.availableMicro += notice.amountMicro;
  ledger.updatedAt = new Date().toISOString();
  await saveLedger(ledger);

  notice.state = 'SETTLED';
  await saveNotice(notice);
  return notice;
}

/**
 * Settle every PENDING notice whose window has elapsed (availableAt ≤ now). This
 * is what actually credits Available on schedule — call it from the
 * settle-withdrawals cron. `force` settles all PENDING regardless of date and is
 * demo-only (used to fast-forward the T+N window without waiting real days).
 */
export async function settleDueWithdrawals(opts: { force?: boolean } = {}): Promise<WithdrawalNotice[]> {
  const now = new Date();
  let due: WithdrawalNotice[];
  if (!usingPostgres()) {
    due = notices.filter(
      (n) => n.state === 'PENDING' && (opts.force === true || new Date(n.availableAt).getTime() <= now.getTime()),
    );
  } else if (opts.force === true) {
    due = (await repo.listAllNoticesForStaff(await db()))
      .map(noticeFromRow)
      .filter((n) => n.state === 'PENDING');
  } else {
    // Filtered in the database rather than by loading every notice: this sweep
    // runs across every tenant and the list only grows.
    due = (await repo.listDueNotices(await db(), now)).map(noticeFromRow);
  }

  const settled: WithdrawalNotice[] = [];
  for (const n of due) settled.push(await settleWithdrawal(n.id));
  return settled;
}

/**
 * Cancel a pending withdrawal notice.
 *
 * `userId` is REQUIRED and checked against the notice's owner. It used to be
 * absent: any caller who had seen an id (they are handed out by the snapshot
 * endpoint) could cancel any other tenant's withdrawal. Harmless while every
 * caller resolved to the same demo ledger, and a cross-tenant write the moment
 * ledgers are keyed per org — which is exactly the kind of latent hole that
 * gets missed during the migration that introduces it.
 */
export async function cancelTreasuryWithdrawal(
  noticeId: string,
  userId: string,
): Promise<WithdrawalNotice> {
  const notice = await findNotice(noticeId);
  // Same error for "does not exist" and "belongs to someone else" — otherwise
  // the response distinguishes them and the endpoint becomes an id oracle.
  if (!notice || notice.userId !== userId) throw new Error('notice not found');
  if (notice.state !== 'PENDING') throw new Error(`cannot cancel a ${notice.state} withdrawal`);

  const ledger = await getLedger(notice.userId);
  ledger.treasuryPrincipalMicro += notice.amountMicro; // un-reserve
  ledger.updatedAt = new Date().toISOString();
  await saveLedger(ledger);

  notice.state = 'CANCELLED';
  await saveNotice(notice);
  return notice;
}

export async function listNotices(userId: string): Promise<WithdrawalNotice[]> {
  if (!usingPostgres()) return notices.filter((n) => n.userId === userId);
  return (await repo.listNoticesForOrg(await db(), userId)).map(noticeFromRow);
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
/**
 * The accrual baseline, read from wherever it actually lives.
 *
 * It was a module-level `let`, so every deploy reset it to null. A null
 * baseline correctly records nothing — there is no delta from a price we never
 * saw — which meant a restart silently skipped a day of yield for every
 * customer, and nothing anywhere said so.
 */
async function readBaseline(): Promise<bigint | null> {
  if (!usingPostgres()) return lastAccruedPriceMicros;
  return repo.readAccrualBaseline(await db());
}

async function writeBaseline(price: bigint | null): Promise<void> {
  lastAccruedPriceMicros = price;
  if (!usingPostgres()) return;
  await repo.writeAccrualBaseline(await db(), price);
}

export async function accrueDailyYield(): Promise<YieldSnapshot> {
  const nav = await getUsdyRedemptionPrice();
  // Read once. Four separate reads could see four different totals if a
  // customer moved money mid-run, and the snapshot would not add up.
  const allLedgers = await listLedgersForStaff();

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
      totalTreasuryMicro: allLedgers.reduce((sum, l) => sum + l.treasuryPrincipalMicro, 0),
      yieldDistributedMicro: 0,
      spreadToOperatingMicro: 0,
      skippedReason: `NAV ${nav.status} — no accrual recorded`,
    };
  }

  const previous = await readBaseline();
  await writeBaseline(nav.priceMicros);

  // First observation establishes the baseline. There is no delta to record yet.
  if (previous === null) {
    return {
      date: new Date().toISOString().slice(0, 10),
      redemptionPriceUsd: navPriceUsd(nav.priceMicros),
      navStatus: nav.status,
      navAsOf: nav.asOf,
      navSource: nav.source,
      totalTreasuryMicro: allLedgers.reduce((sum, l) => sum + l.treasuryPrincipalMicro, 0),
      yieldDistributedMicro: 0,
      spreadToOperatingMicro: 0,
      skippedReason: 'first NAV observation — baseline established, no delta to record',
    };
  }

  // Price can fall. `deriveYieldMicros` returns a negative figure in that case
  // — a redemption price that moved down is a real loss on the position, and
  // clamping it at zero would report a floor the instrument does not have.
  let distributed = 0;
  for (const ledger of allLedgers) {
    const result = deriveYieldMicros({
      principalMicro: BigInt(ledger.treasuryPrincipalMicro),
      priceMicros: nav.priceMicros,
      previousPriceMicros: previous,
    });
    if (!result.accrued) continue;
    const dayYield = Number(result.yieldMicro);
    ledger.treasuryYieldMicro += dayYield;
    ledger.updatedAt = new Date().toISOString();
    await saveLedger(ledger);
    distributed += dayYield;
  }

  const spread = Number(spreadOnGain(BigInt(Math.trunc(distributed))));
  const total = allLedgers.reduce((sum, l) => sum + l.treasuryPrincipalMicro, 0);
  return {
    date: new Date().toISOString().slice(0, 10),
    redemptionPriceUsd: navPriceUsd(nav.priceMicros),
    navStatus: nav.status,
    navAsOf: nav.asOf,
    navSource: nav.source,
    totalTreasuryMicro: total,
    yieldDistributedMicro: distributed,
    spreadToOperatingMicro: spread,
  };
}

/** Test seam — the baseline is shared state and would leak across tests. */
export async function resetAccrualBaselineForTesting() {
  await writeBaseline(null);
}

// ─── Invariants (daily reconciliation) ──────────────────────────────────────────

export async function checkInvariants(
  poolUsdcMicro: number,
  poolUsdyUnitsMicro: number,
  redemptionPriceUsd: number,
) {
  // One read, so the two sums describe the same instant.
  const all = await listLedgersForStaff();
  const sumAvailable = all.reduce((s, l) => s + l.availableMicro, 0);
  const sumTreasury = all.reduce((s, l) => s + l.treasuryPrincipalMicro + l.treasuryYieldMicro, 0);
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

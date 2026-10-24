/**
 * Home (/dashboard), v2 brief 5.2: what the first screen after sign-in shows.
 *
 * Every figure here is computed from one org's own records, in one pass, so
 * the panels cannot disagree about the same payments:
 *
 *   Sent this month   settled USDC payments made this calendar month (UTC):
 *                     bank payouts (transfers) and wallet payments
 *                     (stablecoin outflows).
 *   Needs approval    proposals waiting for a decision that have not expired,
 *                     and the soonest expiry, so a rate about to lapse shows.
 *   Recent payments   both kinds merged, newest first, with type and status.
 *
 * The Splash Wallet balance is not here: it is read from the chain in the
 * browser (businessWalletFrom below picks where from), so a slow chain read
 * never holds up the rest of Home.
 *
 * Pure and isomorphic: GET /api/home builds the summary on the server, the
 * page formats it, and tests/dashboard-home.test.mjs tests both as behaviour.
 */

const SETTLED_TRANSFER_STATES = new Set(['SETTLED', 'DISBURSED', 'CREDITED']);
const FAILED_TRANSFER_STATES = new Set(['FAILED', 'REFUNDED', 'REFUNDING']);

/** Statuses the approval queue (app/queue) lists as waiting for a decision. */
const WAITING_PROPOSAL_STATUSES = new Set(['SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL']);

/** Within this, the soonest expiry is a warning, not a note. */
const EXPIRING_SOON_MS = 30 * 60 * 1000;

const RECENT_LIMIT = 6;
const USDC_DECIMALS = 6;

/** The payout country a bank payout's currency lands in. */
const PAYOUT_COUNTRY: Record<string, string> = {
  PHP: 'PH',
  IDR: 'ID',
  MYR: 'MY',
  VND: 'VN',
  THB: 'TH',
  SGD: 'SG',
};

export type HomeTransfer = {
  id: string;
  state: string;
  recipientName: string;
  targetCurrency: string;
  targetAmount: string;
  sourceAmountUsd: string;
  sourceStablecoin: string;
  stablecoinAmountMicro: number;
  createdAt: string;
  demo?: boolean;
};

export type HomeWalletPayment = {
  id: string;
  kind: string;
  status: string;
  recipientName: string | null;
  recipientAddress: string;
  principalMinor: bigint | string | number;
  createdAt: Date | string;
  confirmedAt: Date | string | null;
};

export type HomeProposal = {
  id: string;
  orgId: string;
  status: string;
  expiresAt: string;
  explain?: { financialImpact?: { fxRate?: unknown } };
};

export type PaymentStatus = 'settled' | 'on_the_way' | 'failed' | 'expired';

export type HomePaymentRow = {
  id: string;
  recipient: string;
  type: string;
  amount: string;
  status: PaymentStatus;
  /** A transfer recorded as sample data: shown, labelled, never counted. */
  sample: boolean;
  createdAt: string;
};

export type ApprovalSummary = {
  count: number;
  soonestExpiresAt: string | null;
  soonestHasRate: boolean;
  expiringSoon: boolean;
};

export type HomeSummary = {
  generatedAt: string;
  sentThisMonth: {
    /** USDC, 6-decimal minor units, as a decimal string. */
    usdcMinor: string;
    payments: number;
    /** Settled this month but not paid in USDC, so not in the total. */
    notCounted: number;
    /** Start of the month counted, UTC. */
    since: string;
  };
  needsApproval: ApprovalSummary;
  recent: HomePaymentRow[];
};

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A decimal string to minor units, truncating. Never rounds an amount up. */
function decimalToMinor(amount: string, decimals: number): bigint | null {
  const match = /^\s*(\d+)(?:\.(\d*))?\s*$/.exec(amount.replace(/,/g, ''));
  if (!match) return null;
  const frac = ((match[2] ?? '') + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(match[1]) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

function toBigInt(value: bigint | string | number): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  return BigInt(value);
}

function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "1,234.56" from USDC minor units: grouped, two places, truncated. */
export function formatUsdcMinor(minor: bigint | string | number): string {
  const value = toBigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const cents = ((abs % unit) / 10n ** BigInt(USDC_DECIMALS - 2)).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${groupDigits((abs / unit).toString())}.${cents}`;
}

/** "PHP 287,000.00" from the amount as recorded; verbatim if it is not a number. */
function formatLocal(currency: string, amount: string): string {
  const match = /^(\d+)(\.\d+)?$/.exec(amount.trim());
  return match ? `${currency} ${groupDigits(match[1])}${match[2] ?? ''}` : `${currency} ${amount}`;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function transferStatus(state: string): PaymentStatus {
  if (SETTLED_TRANSFER_STATES.has(state)) return 'settled';
  if (FAILED_TRANSFER_STATES.has(state)) return 'failed';
  return 'on_the_way';
}

function walletStatus(status: string): PaymentStatus {
  if (status === 'CONFIRMED') return 'settled';
  if (status === 'EXPIRED') return 'expired';
  if (status === 'FAILED' || status === 'MISMATCH') return 'failed';
  return 'on_the_way';
}

/** The USDC a settled transfer paid, or null when it was not paid in USDC. */
function transferUsdcMinor(t: HomeTransfer): bigint | null {
  if (t.sourceStablecoin !== 'USDC') return null;
  if (Number.isFinite(t.stablecoinAmountMicro) && t.stablecoinAmountMicro > 0) return BigInt(Math.trunc(t.stablecoinAmountMicro));
  // Recorded before the lane kept a micro amount: the USD it was authorized
  // for, which the USDC lane debits one for one.
  return decimalToMinor(t.sourceAmountUsd, USDC_DECIMALS);
}

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function buildHomeSummary(input: {
  orgId: string;
  now: Date;
  transfers: readonly HomeTransfer[];
  walletPayments: readonly HomeWalletPayment[];
  proposals: readonly HomeProposal[];
}): HomeSummary {
  const { orgId, now } = input;
  const nowMs = now.getTime();
  const since = startOfMonthUtc(now);
  const sinceMs = since.getTime();

  // ── Sent this month ──
  let sent = 0n;
  let payments = 0;
  let notCounted = 0;
  for (const t of input.transfers) {
    if (t.demo || !SETTLED_TRANSFER_STATES.has(t.state)) continue;
    const at = Date.parse(t.createdAt);
    if (!(at >= sinceMs && at <= nowMs)) continue;
    const minor = transferUsdcMinor(t);
    if (minor === null) {
      notCounted += 1;
      continue;
    }
    sent += minor;
    payments += 1;
  }
  for (const p of input.walletPayments) {
    if (p.status !== 'CONFIRMED') continue;
    const at = Date.parse(iso(p.confirmedAt) ?? iso(p.createdAt) ?? '');
    if (!(at >= sinceMs && at <= nowMs)) continue;
    sent += toBigInt(p.principalMinor);
    payments += 1;
  }

  // ── Needs approval ──
  const waiting = input.proposals
    .filter((p) => p.orgId === orgId && WAITING_PROPOSAL_STATUSES.has(p.status))
    .filter((p) => Date.parse(p.expiresAt) > nowMs)
    .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
  const soonest = waiting[0] ?? null;
  const needsApproval: ApprovalSummary = {
    count: waiting.length,
    soonestExpiresAt: soonest ? new Date(Date.parse(soonest.expiresAt)).toISOString() : null,
    soonestHasRate: Boolean(soonest?.explain?.financialImpact?.fxRate),
    expiringSoon: soonest ? Date.parse(soonest.expiresAt) - nowMs <= EXPIRING_SOON_MS : false,
  };

  // ── Recent payments ──
  const rows: HomePaymentRow[] = [
    ...input.transfers.map((t): HomePaymentRow => {
      const country = PAYOUT_COUNTRY[t.targetCurrency];
      return {
        id: t.id,
        recipient: t.recipientName,
        type: country ? `Bank · ${country}` : `Payout · ${t.targetCurrency}`,
        amount: formatLocal(t.targetCurrency, t.targetAmount),
        status: transferStatus(t.state),
        sample: Boolean(t.demo),
        createdAt: iso(t.createdAt) ?? t.createdAt,
      };
    }),
    ...input.walletPayments.map((p): HomePaymentRow => ({
      id: p.id,
      recipient: p.recipientName ?? shortAddress(p.recipientAddress),
      type: p.kind === 'X402' ? 'Paid API' : 'Wallet',
      amount: `${formatUsdcMinor(p.principalMinor)} USDC`,
      status: walletStatus(p.status),
      sample: false,
      createdAt: iso(p.createdAt) ?? String(p.createdAt),
    })),
  ]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RECENT_LIMIT);

  return {
    generatedAt: now.toISOString(),
    sentThisMonth: { usdcMinor: sent.toString(), payments, notCounted, since: since.toISOString() },
    needsApproval,
    recent: rows,
  };
}

function timeLeft(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The line under Needs approval. A warning when the soonest expiry is near. */
export function approvalNote(summary: ApprovalSummary, nowMs: number): { text: string; warn: boolean } {
  if (summary.count === 0 || !summary.soonestExpiresAt) return { text: 'Nothing is waiting for you', warn: false };
  const left = timeLeft(Date.parse(summary.soonestExpiresAt) - nowMs);
  if (summary.expiringSoon) {
    return { text: `One ${summary.soonestHasRate ? 'rate' : 'approval'} expires in ${left}`, warn: true };
  }
  return { text: `The next expires in ${left}`, warn: false };
}

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

/**
 * Where the Splash Wallet balance comes from, given GET /api/wallet/business.
 *
 * That route is the Phase 2 business wallet (v2 brief 4.1). Until it is
 * deployed it answers 404, which means no business wallet yet, the same as a
 * wallet the chain does not name. Anything else that is not an address is an
 * error: Home says the balance is unavailable rather than show a number.
 */
export function businessWalletFrom(
  status: number,
  body: { wallet?: unknown } | null,
): { kind: 'address'; address: string } | { kind: 'none' } | { kind: 'error' } {
  if (status === 404) return { kind: 'none' };
  if (status !== 200 || !body) return { kind: 'error' };
  if (body.wallet === null || body.wallet === undefined) return { kind: 'none' };
  if (typeof body.wallet === 'string' && SUI_ADDRESS.test(body.wallet)) return { kind: 'address', address: body.wallet };
  return { kind: 'error' };
}

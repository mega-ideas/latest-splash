/**
 * Home (/dashboard), v2 brief 5.2: what the first screen after sign-in shows.
 *
 * Every figure here is computed from one org's own records, in one pass, so
 * the panels cannot disagree about the same payments:
 *
 *   Sent this month   USDC payments that settled this calendar month (UTC):
 *                     bank payouts (transfers, by when they first reached a
 *                     settled state) and wallet payments (stablecoin
 *                     outflows, by when they were confirmed on chain).
 *   Needs approval    proposals waiting for a decision that have not expired
 *                     and that the person viewing can still approve, the
 *                     soonest of those expiries, and apart from them the
 *                     viewer's own requests waiting for someone else.
 *   Recent payments   both kinds merged, newest first, with type and status.
 *                     Sample transfers and wallet quotes that were never sent
 *                     are not payments, so they are not listed.
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

/** The states a transfer is settled in, for reading when it got there. */
export const SETTLED_STATES: readonly string[] = [...SETTLED_TRANSFER_STATES];

/** Statuses the approval queue (app/queue) lists as waiting for a decision. */
const WAITING_PROPOSAL_STATUSES = new Set(['SIMULATED', 'POLICY_EVALUATED', 'PENDING_APPROVAL']);

/** Within this, the soonest expiry is a warning, not a note. */
const EXPIRING_SOON_MS = 30 * 60 * 1000;

/**
 * Roles whose approval counts. The same set as canRoleApprove in
 * lib/queue/proposal-state.ts (a test holds them equal); repeated here so
 * this module stays free of the server-side state machine it would pull into
 * the page.
 */
export const APPROVER_ROLES: ReadonlySet<string> = new Set(['OWNER', 'FINANCE_ADMIN', 'APPROVER']);

export const RECENT_LIMIT = 6;
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
  /** The record's last write: at or after settlement, for a settled one. */
  updatedAt?: string;
  /** When it first reached a settled state (intent_transitions). */
  settledAt?: string | null;
  demo?: boolean;
};

export type HomeWalletPayment = {
  id: string;
  kind: string;
  status: string;
  recipientName: string | null;
  recipientAddress: string;
  principalMinor: bigint | string | number;
  /** Set once the payment was broadcast. A quote nobody sent has none. */
  txDigest: string | null;
  createdAt: Date | string;
  confirmedAt: Date | string | null;
};

export type HomeProposal = {
  id: string;
  orgId: string;
  status: string;
  /** The maker: a user id, or the agent's actor id. */
  createdBy: string;
  approvals: ReadonlyArray<{ userId: string }>;
  expiresAt: string;
  explain?: { financialImpact?: { fxRate?: unknown } };
};

/** Who is looking at Home, with the role they hold in its org. Null: unknown. */
export type HomeViewer = { userId: string; role: string } | null;

export type PaymentStatus = 'settled' | 'on_the_way' | 'failed' | 'expired';

export type HomePaymentRow = {
  id: string;
  recipient: string;
  type: string;
  amount: string;
  status: PaymentStatus;
  createdAt: string;
};

export type ApprovalSummary = {
  /** Waiting payments the viewer can still approve. */
  count: number;
  soonestExpiresAt: string | null;
  soonestHasRate: boolean;
  /** The viewer's own requests, waiting for someone else's approval. */
  yourRequests: number;
};

export type HomeSummary = {
  generatedAt: string;
  sentThisMonth: {
    /** USDC, 6-decimal minor units, as a decimal string. */
    usdcMinor: string;
    payments: number;
    /** Settled this month but not paid in USDC, so not in the total. */
    notCounted: number;
    /** Settled this month in USDC, but the amount could not be read. */
    unreadable: number;
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

/** Currencies paid out in whole units. Everything else shows two places. */
const ZERO_DECIMAL_CURRENCIES = new Set(['IDR', 'VND']);

/**
 * "PHP 287,000.00" from the amount as recorded, in the currency's own
 * decimals: Postgres hands "57400" back for 57,400.00, and the in-process
 * store keeps what was typed, grouping commas included. Extra places are
 * truncated, never rounded up. Verbatim if it is not a number.
 */
function formatLocal(currency: string, amount: string): string {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim().replace(/,/g, ''));
  if (!match) return `${currency} ${amount}`;
  const decimals = ZERO_DECIMAL_CURRENCIES.has(currency) ? 0 : 2;
  const frac = decimals === 0 ? '' : `.${((match[2] ?? '') + '00').slice(0, decimals)}`;
  return `${currency} ${groupDigits(match[1])}${frac}`;
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

/**
 * Whether a wallet outflow is a payment at all. Every quote is a row: it
 * starts PENDING with a reservation and only turns EXPIRED when a later send
 * closes it, and nothing sweeps it in between. One that was never broadcast
 * (no digest) and did not fail moved no money, so it is not listed; one that
 * failed is, so the person sees that the attempt did not go.
 */
export function isWalletPayment(p: Pick<HomeWalletPayment, 'status' | 'txDigest'>): boolean {
  if (p.txDigest) return true;
  return p.status === 'CONFIRMED' || p.status === 'FAILED' || p.status === 'MISMATCH';
}

type UsdcAmount = { kind: 'usdc'; minor: bigint } | { kind: 'other' } | { kind: 'unreadable' };

/** The USDC a settled transfer paid; 'other' when it was not paid in USDC. */
function transferUsdc(t: HomeTransfer): UsdcAmount {
  if (t.sourceStablecoin !== 'USDC') return { kind: 'other' };
  if (Number.isFinite(t.stablecoinAmountMicro) && t.stablecoinAmountMicro > 0) {
    return { kind: 'usdc', minor: BigInt(Math.trunc(t.stablecoinAmountMicro)) };
  }
  // Recorded before the lane kept a micro amount: the USD it was authorized
  // for, which the USDC lane debits one for one.
  const minor = decimalToMinor(t.sourceAmountUsd, USDC_DECIMALS);
  return minor === null ? { kind: 'unreadable' } : { kind: 'usdc', minor };
}

/** When a settled transfer settled: its first settled transition, else its last write. */
function settledAtMs(t: HomeTransfer): number {
  return Date.parse(t.settledAt ?? t.updatedAt ?? t.createdAt);
}

export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function buildHomeSummary(input: {
  orgId: string;
  now: Date;
  transfers: readonly HomeTransfer[];
  walletPayments: readonly HomeWalletPayment[];
  proposals: readonly HomeProposal[];
  viewer: HomeViewer;
}): HomeSummary {
  const { orgId, now, viewer } = input;
  const nowMs = now.getTime();
  const since = startOfMonthUtc(now);
  const sinceMs = since.getTime();

  // ── Sent this month ──
  let sent = 0n;
  let payments = 0;
  let notCounted = 0;
  let unreadable = 0;
  for (const t of input.transfers) {
    if (t.demo || !SETTLED_TRANSFER_STATES.has(t.state)) continue;
    const at = settledAtMs(t);
    if (!(at >= sinceMs && at <= nowMs)) continue;
    const amount = transferUsdc(t);
    if (amount.kind === 'other') {
      notCounted += 1;
      continue;
    }
    if (amount.kind === 'unreadable') {
      unreadable += 1;
      continue;
    }
    sent += amount.minor;
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
  // What the viewer can still act on: an approver role, not the maker (the
  // maker never checks their own payment), not already approved by them. An
  // unknown viewer gets nothing: authority is never assumed.
  const waiting = input.proposals
    .filter((p) => p.orgId === orgId && WAITING_PROPOSAL_STATUSES.has(p.status))
    .filter((p) => Date.parse(p.expiresAt) > nowMs);
  const forViewer =
    viewer !== null && APPROVER_ROLES.has(viewer.role)
      ? waiting
          .filter((p) => p.createdBy !== viewer.userId && !p.approvals.some((a) => a.userId === viewer.userId))
          .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))
      : [];
  const soonest = forViewer[0] ?? null;
  const needsApproval: ApprovalSummary = {
    count: forViewer.length,
    soonestExpiresAt: soonest ? new Date(Date.parse(soonest.expiresAt)).toISOString() : null,
    soonestHasRate: Boolean(soonest?.explain?.financialImpact?.fxRate),
    yourRequests: viewer === null ? 0 : waiting.filter((p) => p.createdBy === viewer.userId).length,
  };

  // ── Recent payments ──
  const rows: HomePaymentRow[] = [
    ...input.transfers
      .filter((t) => !t.demo)
      .map((t): HomePaymentRow => {
        const country = PAYOUT_COUNTRY[t.targetCurrency];
        return {
          id: t.id,
          recipient: t.recipientName,
          type: country ? `Bank · ${country}` : `Payout · ${t.targetCurrency}`,
          amount: formatLocal(t.targetCurrency, t.targetAmount),
          status: transferStatus(t.state),
          createdAt: iso(t.createdAt) ?? t.createdAt,
        };
      }),
    ...input.walletPayments.filter(isWalletPayment).map((p): HomePaymentRow => ({
      id: p.id,
      recipient: p.recipientName ?? shortAddress(p.recipientAddress),
      type: p.kind === 'X402' ? 'Paid API' : 'Wallet',
      amount: `${formatUsdcMinor(p.principalMinor)} USDC`,
      status: walletStatus(p.status),
      createdAt: iso(p.createdAt) ?? String(p.createdAt),
    })),
  ]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, RECENT_LIMIT);

  return {
    generatedAt: now.toISOString(),
    sentThisMonth: { usdcMinor: sent.toString(), payments, notCounted, unreadable, since: since.toISOString() },
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

/**
 * The line under Needs approval, from the page's own clock: a warning when
 * the soonest expiry is near, and `stale` once it has passed, so the page
 * fetches the count again instead of counting a payment nobody can approve.
 */
export function approvalNote(summary: ApprovalSummary, nowMs: number): { text: string; warn: boolean; stale: boolean } {
  if (summary.count === 0 || !summary.soonestExpiresAt) return { text: 'Nothing is waiting for you', warn: false, stale: false };
  const ms = Date.parse(summary.soonestExpiresAt) - nowMs;
  if (ms <= 0) return { text: 'An approval has expired. Updating…', warn: true, stale: true };
  const left = timeLeft(ms);
  if (ms <= EXPIRING_SOON_MS) {
    return { text: `One ${summary.soonestHasRate ? 'rate' : 'approval'} expires in ${left}`, warn: true, stale: false };
  }
  return { text: `The next expires in ${left}`, warn: false, stale: false };
}

/** The viewer's own requests waiting for an approver, or null when there are none. */
export function ownRequestsNote(summary: ApprovalSummary): string | null {
  const n = summary.yourRequests;
  if (!n) return null;
  return n === 1 ? 'Your 1 request is waiting for approval' : `Your ${n} requests are waiting for approval`;
}

const SUI_ADDRESS = /^0x[0-9a-fA-F]{64}$/;

export type BusinessWalletSource =
  | { kind: 'address'; address: string }
  | { kind: 'pending' }
  | { kind: 'none' }
  | { kind: 'off' }
  | { kind: 'no_access' }
  | { kind: 'error' };

/**
 * Where the Splash Wallet balance comes from, given GET /api/wallet/business:
 * the Phase 2 business wallet (v2 brief 4.1; app/api/wallet/business/route.ts,
 * lib/server/wallet-route.ts and lib/server/wallet-deps.ts on
 * v2/phase2-backend). Its answers:
 *
 *   200 wallet          the BusinessAccount names one: read its balance
 *   200 pendingWallet   nominated, not yet confirmed: being set up
 *   200 neither, 409    no wallet yet (409: no on-chain account either)
 *   503, 404            business wallets are off on this server (no database,
 *                       network gate or v2 ids; 404: the route is not in this
 *                       build). Retrying cannot change that.
 *   403                 no membership, or the session and authority disagree
 *   502, anything else  the chain or the server failed: try again
 *
 * Only the last is "unavailable". None of them is ever shown as a number.
 */
export function businessWalletFrom(
  status: number,
  body: { wallet?: unknown; pendingWallet?: unknown } | null,
): BusinessWalletSource {
  if (status === 409) return { kind: 'none' };
  if (status === 503 || status === 404) return { kind: 'off' };
  if (status === 403) return { kind: 'no_access' };
  if (status !== 200 || !body) return { kind: 'error' };
  if (typeof body.wallet === 'string') {
    return SUI_ADDRESS.test(body.wallet) ? { kind: 'address', address: body.wallet } : { kind: 'error' };
  }
  if (body.wallet !== null && body.wallet !== undefined) return { kind: 'error' };
  if (typeof body.pendingWallet === 'string' && SUI_ADDRESS.test(body.pendingWallet)) return { kind: 'pending' };
  return { kind: 'none' };
}

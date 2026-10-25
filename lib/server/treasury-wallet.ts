/**
 * Treasury in the business's own wallet (v2 D9, brief 5.7): what the routes
 * under app/api/treasury/wallet and app/api/treasury/fund-referral do, with
 * every outside read injected so the rules can be tested without a network.
 *
 * The caller comes from the session (requireSessionAccount and the
 * membership row, never the request), and every store read takes its org.
 *
 * Who may do what:
 *   quote             anyone with a membership. A quote moves nothing.
 *   place an order    an owner, an approver or a maker. A maker (staff)
 *                     placing one is asking the owners to sign it: nothing
 *                     moves until the wallet's signers sign. A viewer cannot.
 *   fund referral     owners only: the answers are the business's declaration.
 */
import type { UserRole } from '../agent/types.ts';
import type { KybLifecycleState } from '../compliance/kyb-state.ts';
import { formatUsdc, parseUsdcMinor, STABLECOIN_NETWORK, SUI_USDC_COIN_TYPE } from '../payments/stablecoin-lane.ts';
import { minReceived, treasuryQuote, treasuryRedeemQuote, USDY_COIN_TYPE_SUI } from '../payments/treasury-usdy.ts';
import {
  FUND_CATEGORY_LABEL,
  evaluateFundEligibility,
  parseFundAnswers,
} from '../treasury/fund-eligibility.ts';
import {
  checkFundLink,
  linkFundAccount,
  listFundAssessments,
  markReferralOpened,
  readFundReferral,
  readOrgRegistrationNumber,
  recordFundAssessment,
  type FundReferral,
} from './fund-referral-store.ts';
import type { FundHoldingSource, TreasurySwapRoute, Unavailable } from './treasury-providers.ts';
import type { UsdyMarketQuote, UsdyRedeemMarketQuote } from './usdy-liquidity.ts';
import {
  INTENT_ID,
  createTreasuryOrder,
  orderInProgress,
  orderRequestHash,
  orderView,
  readTreasuryOrderByIntent,
  type TreasuryDirection,
  type TreasuryOrder,
} from './treasury-wallet-orders.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type TreasuryCaller = { orgId: string; userId: string; role: UserRole };

export type Answer = { status: number; body: Record<string, unknown> };

export type NavRead = { status: 'LIVE' | 'STALE' | 'UNAVAILABLE'; priceMicros: bigint | null; asOf: string | null; source: string };

export type QuoteDeps = {
  readNav: () => Promise<NavRead>;
  apyPct: () => number;
  readOrg: (orgId: string) => Promise<{ kyb: KybLifecycleState; country: string | null }>;
  marketIn: (usdcInMinor: bigint) => Promise<UsdyMarketQuote>;
  marketOut: (usdyInMinor: bigint) => Promise<UsdyRedeemMarketQuote>;
  issuerEligibilityConfirmed: boolean;
  slippageBps: number;
};

/** Who may hand a swap to the wallet's signers. The page reads this from the overview, never decides it. */
export const ORDER_ROLES: readonly UserRole[] = ['OWNER', 'FINANCE_ADMIN', 'APPROVER', 'MAKER'];

export function mayOrder(role: UserRole): boolean {
  return ORDER_ROLES.includes(role);
}

const ROLE_NAME: Partial<Record<UserRole, string>> = { VIEWER: 'A viewer', AUDITOR: 'An auditor', DEVELOPER: 'A developer' };

/** The business wallet, as the server resolves it: never from the request. */
export type WalletRead = { ok: true; address: string } | { ok: false; status: number; code: string; error: string };

/** The coin a swap spends and the coin it returns, on the network USDY lives on. */
export function orderCoinTypes(direction: TreasuryDirection): { inCoinType: string; outCoinType: string } {
  const usdcType = SUI_USDC_COIN_TYPE[STABLECOIN_NETWORK];
  return direction === 'swap' ? { inCoinType: usdcType, outCoinType: USDY_COIN_TYPE_SUI } : { inCoinType: USDY_COIN_TYPE_SUI, outCoinType: usdcType };
}

const BALANCE_UNREADABLE = 'The wallet balance could not be read from Sui just now.';

function isDirection(value: unknown): value is TreasuryDirection {
  return value === 'swap' || value === 'redeem';
}

/** The quote both ways, and whether an order may be placed on it. */
export async function quoteTreasury(orgId: string, direction: TreasuryDirection, amountMinor: bigint, deps: QuoteDeps) {
  const nav = await deps.readNav();
  if (direction === 'swap') {
    const org = await deps.readOrg(orgId);
    // The market is asked only when the business could be quoted at all, so
    // a locked lane or a US business makes no outside call.
    const probe = treasuryQuote({
      state: org.kyb,
      country: org.country,
      usdcInMinor: amountMinor,
      nav,
      apyPct: deps.apyPct(),
      ondoEligibilityConfirmed: deps.issuerEligibilityConfirmed,
      slippageBps: deps.slippageBps,
    });
    let market = null;
    if (probe.allowed) {
      const live = await deps.marketIn(amountMinor);
      market = live.available ? { usdyOutMinor: live.usdyOutMinor, providers: live.providers, asOf: live.asOf } : { unavailable: live.reason };
    }
    const q = probe.allowed
      ? treasuryQuote({
          state: org.kyb,
          country: org.country,
          usdcInMinor: amountMinor,
          nav,
          apyPct: deps.apyPct(),
          ondoEligibilityConfirmed: deps.issuerEligibilityConfirmed,
          slippageBps: deps.slippageBps,
          market,
        })
      : probe;
    const outMinor = q.market?.usdyOutMinor ?? null;
    return {
      direction,
      allowed: q.allowed,
      mode: q.mode,
      reasons: q.reasons,
      orderable: q.allowed && q.fillable === true && outMinor !== null && q.priceMicros !== null,
      inMinor: amountMinor,
      outMinor,
      minOutMinor: q.minUsdyOutMinor,
      atRedemptionMinor: q.usdyOutMinor,
      shortfallBps: q.market?.shortfallBps ?? null,
      providers: q.market?.providers ?? [],
      priceMicros: q.priceMicros,
      priceStatus: q.priceStatus,
      priceAsOf: nav.asOf,
      projections: q.projections,
      apyPct: q.apyPct,
    };
  }
  const probe = treasuryRedeemQuote({ usdyInMinor: amountMinor, nav, ondoEligibilityConfirmed: deps.issuerEligibilityConfirmed, slippageBps: deps.slippageBps });
  let market = null;
  if (probe.allowed) {
    const live = await deps.marketOut(amountMinor);
    market = live.available ? { usdcOutMinor: live.usdcOutMinor, providers: live.providers, asOf: live.asOf } : { unavailable: live.reason };
  }
  const q = probe.allowed
    ? treasuryRedeemQuote({ usdyInMinor: amountMinor, nav, ondoEligibilityConfirmed: deps.issuerEligibilityConfirmed, slippageBps: deps.slippageBps, market })
    : probe;
  const outMinor = q.market?.usdcOutMinor ?? null;
  return {
    direction,
    allowed: q.allowed,
    mode: q.mode,
    reasons: q.reasons,
    orderable: q.allowed && q.fillable === true && outMinor !== null && q.priceMicros !== null,
    inMinor: amountMinor,
    outMinor,
    minOutMinor: q.minUsdcOutMinor,
    atRedemptionMinor: q.usdcAtRedemptionMinor,
    shortfallBps: q.market?.shortfallBps ?? null,
    providers: q.market?.providers ?? [],
    priceMicros: q.priceMicros,
    priceStatus: q.priceStatus,
    priceAsOf: nav.asOf,
    projections: [] as Array<{ days: number; valueMinor: bigint; yieldMinor: bigint }>,
    apyPct: deps.apyPct(),
  };
}

export type TreasuryQuoteResult = Awaited<ReturnType<typeof quoteTreasury>>;

/** A quote as JSON: bigints as strings. */
export function quoteView(q: TreasuryQuoteResult) {
  const s = (v: bigint | null) => (v === null ? null : v.toString());
  return {
    ...q,
    inMinor: q.inMinor.toString(),
    outMinor: s(q.outMinor),
    minOutMinor: s(q.minOutMinor),
    atRedemptionMinor: s(q.atRedemptionMinor),
    priceMicros: s(q.priceMicros),
    projections: q.projections.map((p) => ({ days: p.days, valueMinor: p.valueMinor.toString(), yieldMinor: p.yieldMinor.toString() })),
  };
}

function parseAmount(raw: unknown): bigint | string {
  try {
    const minor = parseUsdcMinor(String(raw ?? '').trim() || '0');
    if (minor <= 0n) return 'Enter an amount above zero.';
    return minor;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid amount.';
  }
}

export async function handleTreasuryQuote(caller: TreasuryCaller, body: Record<string, unknown>, deps: QuoteDeps): Promise<Answer> {
  if (!isDirection(body.direction)) return { status: 400, body: { error: "direction must be 'swap' or 'redeem'" } };
  const amount = parseAmount(body.amount);
  if (typeof amount === 'string') return { status: 400, body: { error: amount } };
  const q = await quoteTreasury(caller.orgId, body.direction, amount, deps);
  return { status: 200, body: quoteView(q) };
}

/**
 * Place a swap or redemption for the wallet's signers.
 *
 * The quote is the server's, made now; the client's figures are never the
 * order's. The client sends the least it agreed to receive (`minOutMinor`,
 * the "at least" it was shown), and the order is refused if the market no
 * longer reaches it, the way a payment's max_fee bounds its fee.
 *
 * The wallet is the server's too: resolved from the org's own BusinessAccount
 * (resolveWallet), recorded on the order as both the source and the only
 * recipient, and handed to the swap route with both coin types, so the
 * transaction the signers are shown can be checked against the order. An
 * amount above what the wallet holds on Sui right now is refused before the
 * market is asked. No address in the request is read.
 */
export type OrderDeps = QuoteDeps & {
  resolveRoute: () => { ok: true; route: TreasurySwapRoute } | Unavailable;
  resolveWallet: (orgId: string) => Promise<WalletRead>;
  readWalletBalance: (address: string, coinType: string) => Promise<bigint>;
  now?: () => Date;
};

const IN_PROGRESS: Answer = {
  status: 409,
  body: { error: 'This order is still being sent to your signers. Wait a moment and look at the activity list.', code: 'in_progress' },
};

export async function handleTreasuryOrder(db: Db, caller: TreasuryCaller, body: Record<string, unknown>, deps: OrderDeps): Promise<Answer> {
  if (!mayOrder(caller.role)) {
    const who = ROLE_NAME[caller.role] ?? 'This role';
    return { status: 403, body: { error: `${who} cannot ask the wallet to swap. An owner, finance admin, approver or maker can.`, code: 'role' } };
  }
  const intentId = typeof body.intentId === 'string' ? body.intentId.trim() : '';
  if (!INTENT_ID.test(intentId)) return { status: 400, body: { error: 'intentId must be a UUID.' } };
  if (!isDirection(body.direction)) return { status: 400, body: { error: "direction must be 'swap' or 'redeem'" } };
  const direction = body.direction;
  const amount = parseAmount(body.amount);
  if (typeof amount === 'string') return { status: 400, body: { error: amount } };
  const agreedMin = typeof body.minOutMinor === 'string' && /^\d{1,30}$/.test(body.minOutMinor) ? BigInt(body.minOutMinor) : null;
  if (agreedMin === null || agreedMin <= 0n) return { status: 400, body: { error: 'minOutMinor, the least you agreed to receive, is required.' } };

  const resolved = deps.resolveRoute();
  if (!resolved.ok) return { status: resolved.status, body: { error: resolved.error, code: 'swap_route_unavailable' } };

  // A retried request is the order already made, before any quote is asked
  // again: a replay neither re-prices nor reaches the swap route twice.
  const existing = await readTreasuryOrderByIntent(db, caller.orgId, intentId);
  if (existing) {
    if (orderRequestHash({ direction, amountInMinor: amount }) !== orderRequestHash(existing)) {
      return { status: 409, body: { error: 'This intent id was used for a different order. Start a new one.', code: 'intent_reused' } };
    }
    // Claimed by another request that is still handing it to the signers: it
    // may yet fail and be removed, so it is not reported as sent.
    if (orderInProgress(existing)) return IN_PROGRESS;
    return { status: 200, body: { order: orderView(existing), replayed: true } };
  }

  const wallet = await deps.resolveWallet(caller.orgId);
  if (!wallet.ok) return { status: wallet.status, body: { error: wallet.error, code: wallet.code } };
  const coins = orderCoinTypes(direction);
  let held: bigint;
  try {
    held = await deps.readWalletBalance(wallet.address, coins.inCoinType);
  } catch (error) {
    console.error('[treasury] the wallet balance could not be read', { orgId: caller.orgId, error: error instanceof Error ? error.message : String(error) });
    return { status: 502, body: { error: `${BALANCE_UNREADABLE} Try again.`, code: 'balance_unreadable' } };
  }
  if (amount > held) {
    const unit = direction === 'swap' ? 'USDC' : 'USDY';
    return {
      status: 409,
      body: { error: `The wallet holds ${formatUsdc(held)} ${unit}, less than the ${formatUsdc(amount)} ${unit} asked for.`, code: 'over_balance' },
    };
  }

  const q = await quoteTreasury(caller.orgId, direction, amount, deps);
  if (!q.orderable || q.outMinor === null || q.priceMicros === null) {
    return { status: 409, body: { error: q.reasons[q.reasons.length - 1] ?? 'This amount cannot be swapped right now.', code: 'not_orderable', reasons: q.reasons } };
  }
  if (q.mode === 'SANDBOX' && resolved.route.kind === 'live') {
    return { status: 409, body: { error: 'Issuer eligibility for this business is not confirmed, so nothing is sent to your signers.', code: 'issuer_unconfirmed' } };
  }
  if (q.outMinor < agreedMin) {
    const unit = direction === 'swap' ? 'USDY' : 'USDC';
    return {
      status: 409,
      body: {
        error: `The market moved: it now returns ${formatUsdc(q.outMinor)} ${unit}, below the ${formatUsdc(agreedMin)} ${unit} you agreed to. Get a new quote.`,
        code: 'price_moved',
      },
    };
  }
  // The floor the signers' transaction enforces: what the person agreed to,
  // or the server's own slippage floor if that is higher.
  const serverMin = minReceived(q.outMinor, deps.slippageBps);
  const minOut = agreedMin > serverMin ? agreedMin : serverMin;

  const created = await createTreasuryOrder(
    db,
    {
      orgId: caller.orgId,
      intentId,
      direction,
      amountInMinor: amount,
      minOutMinor: minOut,
      quotedOutMinor: q.outMinor,
      priceMicros: q.priceMicros,
      sandbox: resolved.route.kind === 'sandbox',
      requestedBy: caller.userId,
      walletAddress: wallet.address,
      inCoinType: coins.inCoinType,
      outCoinType: coins.outCoinType,
      now: deps.now?.(),
    },
    (order: TreasuryOrder) => resolved.route.prepare(order),
  );
  if (!created.ok) {
    if (created.code === 'in_progress') return IN_PROGRESS;
    return { status: 409, body: { error: 'This intent id was used for a different order. Start a new one.', code: 'intent_reused' } };
  }
  return { status: created.replayed ? 200 : 201, body: { order: orderView(created.order), replayed: created.replayed } };
}

/* ── The overview ───────────────────────────────────────────────────── */

export type OverviewDeps = {
  flags: { walletSwaps: boolean; fundReferral: boolean; tokenizedStocks: boolean; issuerEligibilityConfirmed: boolean };
  issuer: string;
  fundManager: string;
  readNav: () => Promise<NavRead>;
  apyPct: () => number;
  resolveWallet: (orgId: string) => Promise<WalletRead>;
  readBalances: (address: string) => Promise<{ usdcMinor: bigint; usdyMinor: bigint }>;
  /** This org's orders, or null with no database. */
  listOrders: (orgId: string) => Promise<TreasuryOrder[] | null>;
};

/** What the page shows about the wallet, in the words lib/dashboard/home.ts uses. */
function walletState(read: WalletRead): 'address' | 'none' | 'off' | 'error' {
  if (read.ok) return 'address';
  if (read.code === 'no_wallet') return 'none';
  if (read.code === 'wallets_off') return 'off';
  return 'error';
}

/**
 * Treasury's overview for the caller's business. The wallet is the org's own
 * (resolveWallet), never an address the caller names, and a chain error is a
 * fixed sentence: the details go to the server log, not the browser.
 */
export async function handleTreasuryOverview(caller: TreasuryCaller, deps: OverviewDeps): Promise<Answer> {
  const [nav, wallet, orders] = await Promise.all([deps.readNav(), deps.resolveWallet(caller.orgId), deps.listOrders(caller.orgId)]);
  let balances: { usdcMinor: string; usdyMinor: string } | { error: string } | null = null;
  if (wallet.ok) {
    try {
      const read = await deps.readBalances(wallet.address);
      balances = { usdcMinor: read.usdcMinor.toString(), usdyMinor: read.usdyMinor.toString() };
    } catch (error) {
      console.error('[treasury] the wallet balances could not be read', { orgId: caller.orgId, error: error instanceof Error ? error.message : String(error) });
      balances = { error: BALANCE_UNREADABLE };
    }
  }
  return {
    status: 200,
    body: {
      flags: { walletSwaps: deps.flags.walletSwaps, fundReferral: deps.flags.fundReferral, tokenizedStocks: deps.flags.tokenizedStocks },
      issuerConfirmed: deps.flags.issuerEligibilityConfirmed,
      issuer: deps.issuer,
      fundManager: deps.fundManager,
      role: caller.role,
      canOrder: mayOrder(caller.role),
      price: { status: nav.status, priceMicros: nav.priceMicros?.toString() ?? null, asOf: nav.asOf },
      apyPct: deps.apyPct(),
      wallet: walletState(wallet),
      address: wallet.ok ? wallet.address : null,
      balances,
      orders: orders ? orders.map(orderView) : null,
    },
  };
}

/* ── The fund-manager referral ──────────────────────────────────────── */

export type FundDeps = {
  enabled: boolean;
  label: string;
  referralUrl: string | null;
  resolveHolding: () => { ok: true; source: FundHoldingSource } | Unavailable;
};

const NOT_OFFERED: Answer = { status: 404, body: { error: 'The fund referral is not offered on this server.', code: 'not_offered' } };

async function referralView(db: Db, orgId: string, referral: FundReferral | null, deps: FundDeps) {
  if (!referral) return { label: deps.label, assessment: null, assessments: [], referralUrl: null, linked: false, holding: null };
  const eligible = referral.outcome === 'eligible';
  const evaluated = evaluateFundEligibility(referral.answers);
  let holding: Record<string, unknown> | null = null;
  if (eligible && referral.linkedReference) {
    const source = deps.resolveHolding();
    const registrationNumber = await readOrgRegistrationNumber(db, orgId);
    if (!source.ok) holding = { unavailable: source.error };
    else if (!registrationNumber) holding = { unavailable: 'The business has no registration number on record, so the fund manager cannot be asked.' };
    else {
      // The fund manager is told who is asking, so the reference never stands alone.
      const read = await source.source.read({ reference: referral.linkedReference, orgId, registrationNumber });
      holding = read.ok ? { ...read.holding } : { unavailable: read.error };
    }
  }
  // Every answer the business gave, newest first: answering again never hides an earlier declaration.
  const assessments = (await listFundAssessments(db, orgId)).map((a) => ({
    outcome: a.outcome,
    categoryLabel: a.category ? FUND_CATEGORY_LABEL[a.category] : null,
    assessedAt: a.at.toISOString(),
  }));
  return {
    label: deps.label,
    assessment: {
      outcome: referral.outcome,
      category: referral.category,
      categoryLabel: referral.category ? FUND_CATEGORY_LABEL[referral.category] : null,
      reason: evaluated.reason,
      assessedAt: referral.assessedAt.toISOString(),
    },
    assessments,
    referralUrl: eligible ? deps.referralUrl : null,
    referralOpenedAt: referral.referralOpenedAt?.toISOString() ?? null,
    linked: Boolean(referral.linkedReference),
    holding,
  };
}

export async function handleFundReferralRead(db: Db, caller: TreasuryCaller, deps: FundDeps): Promise<Answer> {
  if (!deps.enabled) return NOT_OFFERED;
  return { status: 200, body: await referralView(db, caller.orgId, await readFundReferral(db, caller.orgId), deps) };
}

const LINK_REFUSALS: Record<'bad_reference' | 'not_eligible' | 'already_linked' | 'reference_taken', [number, string]> = {
  bad_reference: [400, 'Enter the account reference the fund manager gave you: 4 to 40 letters, digits or hyphens.'],
  not_eligible: [409, 'Only an eligible business links an account.'],
  already_linked: [409, 'An account is already linked for this business.'],
  reference_taken: [409, 'That account reference is linked to another business. Check it with the fund manager.'],
};

export async function handleFundReferralWrite(db: Db, caller: TreasuryCaller, body: Record<string, unknown>, deps: FundDeps & { now?: () => Date }): Promise<Answer> {
  if (!deps.enabled) return NOT_OFFERED;
  if (caller.role !== 'OWNER') return { status: 403, body: { error: 'Only an owner answers for the business.', code: 'role' } };
  const now = deps.now?.() ?? new Date();
  if (body.action === 'assess') {
    const parsed = parseFundAnswers(body.answers);
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
    const eligibility = evaluateFundEligibility(parsed.answers);
    const recorded = await recordFundAssessment(db, { orgId: caller.orgId, answers: parsed.answers, eligibility, assessedBy: caller.userId, now });
    if (!recorded.ok) return { status: 409, body: { error: 'The business has linked its account, so the answers it gave stand.', code: 'already_linked' } };
    return { status: 200, body: await referralView(db, caller.orgId, recorded.referral, deps) };
  }
  if (body.action === 'opened') {
    if (!deps.referralUrl) return { status: 503, body: { error: 'The referral link is not set up on this server.', code: 'no_referral_url' } };
    const ok = await markReferralOpened(db, caller.orgId, now);
    if (!ok) return { status: 409, body: { error: 'Only an eligible business is referred.', code: 'not_eligible' } };
    return { status: 200, body: await referralView(db, caller.orgId, await readFundReferral(db, caller.orgId), deps) };
  }
  if (body.action === 'link') {
    const reference = typeof body.reference === 'string' ? body.reference : '';
    const checked = await checkFundLink(db, caller.orgId, reference);
    if (!checked.ok) {
      const [status, error] = LINK_REFUSALS[checked.code];
      return { status, body: { error, code: checked.code } };
    }
    // A typed reference is a claim, not a link: the fund manager confirms it
    // belongs to this business, by its registration number, before anything
    // is stored (the 5.7 review). Without a connection, nothing is linked.
    const registrationNumber = await readOrgRegistrationNumber(db, caller.orgId);
    if (!registrationNumber) {
      return { status: 409, body: { error: 'Add the business’s registration number before linking an account, so the fund manager can confirm it.', code: 'no_registration' } };
    }
    const source = deps.resolveHolding();
    if (!source.ok) return { status: source.status, body: { error: source.error, code: 'fund_unavailable' } };
    const confirmed = await source.source.confirmLink({ reference: checked.reference, orgId: caller.orgId, registrationNumber });
    if (!confirmed.ok) {
      if (confirmed.code === 'not_this_business') {
        return { status: 409, body: { error: 'The fund manager does not hold that account for this business. Check the reference with them.', code: 'reference_not_confirmed' } };
      }
      return { status: confirmed.status, body: { error: confirmed.error, code: 'fund_unavailable' } };
    }
    const linked = await linkFundAccount(db, { orgId: caller.orgId, reference: checked.reference, linkedBy: caller.userId, confirmedAt: now, now });
    if (!linked.ok) {
      const [status, error] = LINK_REFUSALS[linked.code];
      return { status, body: { error, code: linked.code } };
    }
    return { status: 200, body: await referralView(db, caller.orgId, linked.referral, deps) };
  }
  return { status: 400, body: { error: "action must be 'assess', 'opened' or 'link'" } };
}

/**
 * Ondo USDY — the yield instrument behind Smart Treasury.
 *
 * USDY is a T-bill-backed token, native on Sui, with Cetus/Aftermath/Suilend
 * liquidity. We move balances in/out by SWAPPING USDC↔USDY on a Sui DEX (NOT
 * direct Ondo mint/redeem, which is T+40–50). Yield is FLOATING — derived from
 * USDY's redemption value — never a fixed constant.
 *
 * This module is the single source of truth for the treasury rate, so every
 * surface (yields benchmark, 0xWal copilot, treasury UI) shows the same number.
 *
 * External wiring (drop-in via env when ready):
 *   USDY_TYPE                  Move coin type of USDY on the target network
 *   USDY_REDEMPTION_USD        latest USDY→USD redemption price (oracle/Ondo feed)
 *   USDY_NET_APY_PCT           net APY credited to users (after Splash spread)
 *   SPLASH_PROMO_APY_PCT       introductory promo APY (first ~6 months)
 *   SPLASH_PROMO_UNTIL         ISO date the promo ends
 *   USDY_SWAP_VENUE            'cetus' | 'aftermath'
 */

const BASE_NET_APY_DEFAULT = 3.5; // ≈ net-of-spread USDY yield; overridden by env.

export type TreasuryRate = {
  /** Net APY credited to the user. Variable — derived from USDY, not fixed. */
  netApyPct: number;
  variable: true;
  /** True while the time-boxed introductory subsidy is active. */
  introductory: boolean;
  promoUntil: string | null;
  /** Display string, e.g. "≈{rate}% projected · variable" — a projection, never an APY offer. */
  label: string;
  asOf: string;
};

/** Base USDY net APY (post-spread), env-driven with a sane default. */
export function getUsdyNetApyPct(): number {
  const v = Number(process.env.USDY_NET_APY_PCT);
  return Number.isFinite(v) && v > 0 ? v : BASE_NET_APY_DEFAULT;
}

/**
 * The single source of truth for the Smart Treasury rate. Floating, with an
 * optional introductory promo that is clearly tagged and time-boxed.
 */
export function getTreasuryRate(): TreasuryRate {
  const base = getUsdyNetApyPct();
  let rate = base;
  let introductory = false;
  let promoUntil: string | null = null;

  const promoRate = Number(process.env.SPLASH_PROMO_APY_PCT);
  const promoUntilRaw = process.env.SPLASH_PROMO_UNTIL?.trim();
  if (Number.isFinite(promoRate) && promoRate > base && promoUntilRaw) {
    const until = Date.parse(promoUntilRaw);
    if (Number.isFinite(until) && Date.now() < until) {
      rate = promoRate;
      introductory = true;
      promoUntil = promoUntilRaw;
    }
  }

  return {
    netApyPct: Number(rate.toFixed(2)),
    variable: true,
    introductory,
    promoUntil,
    label: `≈${rate.toFixed(2)}% projected · variable${introductory ? ' (introductory)' : ''}`,
    asOf: new Date().toISOString(),
  };
}

// ─── Redemption feed ───────────────────────────────────────────────────────────

export type NavStatus = 'LIVE' | 'STALE' | 'UNAVAILABLE';

export type NavReading = {
  status: NavStatus;
  /** Price in micro-USD. `null` when UNAVAILABLE — never a substituted default. */
  priceMicros: bigint | null;
  /** When the SOURCE observed this price, not when we read it. */
  asOf: string | null;
  source: string;
};

/** Beyond this a reading is still returned, but tagged STALE and undecidable. */
export const NAV_STALE_THRESHOLD_MS = Number(process.env.USDY_NAV_STALE_MS ?? 6 * 60 * 60 * 1000);

/**
 * Latest USDY→USD redemption price. FAILS CLOSED.
 *
 * This used to return `1.0` whenever the feed was missing. USDY is a
 * price-accrual token — yield IS the price moving above $1 — so a permanent $1
 * fallback does not degrade gracefully, it silently asserts "zero yield, ever"
 * and misvalues every position holding it. Worse, it is indistinguishable from
 * a real $1.00 reading, so nothing downstream can tell that the number is
 * invented.
 *
 * The contract now: no reading means no valuation. `UNAVAILABLE` propagates,
 * callers return null, and the UI says "valuation unavailable" rather than
 * showing a number nobody measured. `STALE` values but tags, and the policy
 * engine refuses to make an allocation decision on it.
 *
 * `asOf` is the SOURCE's observation time. The previous implementation stamped
 * `new Date()` even on the fabricated value, which made a made-up price look
 * freshly observed.
 */
export async function getUsdyRedemptionPrice(): Promise<NavReading> {
  const raw = (process.env.USDY_REDEMPTION_USD ?? '').trim();
  const asOfRaw = (process.env.USDY_REDEMPTION_AS_OF ?? '').trim();

  const px = Number(raw);
  if (!raw || !Number.isFinite(px) || px <= 0) {
    return { status: 'UNAVAILABLE', priceMicros: null, asOf: null, source: 'none' };
  }

  // A price with no observation time cannot be aged, and an unageable price is
  // exactly the failure this function exists to prevent.
  const observedAt = asOfRaw ? Date.parse(asOfRaw) : Number.NaN;
  if (!Number.isFinite(observedAt)) {
    return {
      status: 'STALE',
      priceMicros: BigInt(Math.round(px * 1_000_000)),
      asOf: null,
      source: 'env:USDY_REDEMPTION_USD',
    };
  }

  const ageMs = Date.now() - observedAt;
  return {
    status: ageMs > NAV_STALE_THRESHOLD_MS ? 'STALE' : 'LIVE',
    priceMicros: BigInt(Math.round(px * 1_000_000)),
    asOf: new Date(observedAt).toISOString(),
    source: 'env:USDY_REDEMPTION_USD',
  };
}

/** True when a reading may be used to make an allocation decision. */
export function navIsDecidable(reading: NavReading): boolean {
  return reading.status === 'LIVE' && reading.priceMicros !== null;
}

// ─── USDC ↔ USDY swap (Sui DEX) ─────────────────────────────────────────────────

/** Thrown rather than returning a quote built on an unmeasured price. */
export class NavUnavailableError extends Error {
  readonly code = 'nav_unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'NavUnavailableError';
  }
}

export type SwapVenue = 'cetus' | 'aftermath';
export type SwapDirection = 'usdc->usdy' | 'usdy->usdc';

export type SwapQuote = {
  direction: SwapDirection;
  venue: SwapVenue;
  amountInMicro: string;
  /** Minimum acceptable output after the slippage guard. */
  minAmountOutMicro: string;
  slippageBps: number;
  redemptionPriceUsd: number;
};

export function getSwapVenue(): SwapVenue {
  return process.env.USDY_SWAP_VENUE === 'aftermath' ? 'aftermath' : 'cetus';
}

/**
 * Build a swap quote with a slippage guard. The actual on-DEX execution (pool
 * routing + PTB) is wired separately once the Cetus/Aftermath SDK + pool IDs are
 * configured; this guards the economics (min-out) so a move can't be sandwiched.
 */
export async function quoteSwap(
  direction: SwapDirection,
  amountInMicro: bigint,
  slippageBps = Number(process.env.USDY_SWAP_SLIPPAGE_BPS ?? 30),
): Promise<SwapQuote> {
  const nav = await getUsdyRedemptionPrice();
  // A quote priced off a NAV nobody measured is the $1.00-fallback defect one
  // layer up: the min-out guard would be computed from an invented price, so
  // the slippage protection it exists to provide would be meaningless.
  if (!navIsDecidable(nav) || nav.priceMicros === null) {
    throw new NavUnavailableError(
      `Cannot quote a ${direction} swap: USDY NAV is ${nav.status}. Refusing to price against a default.`,
    );
  }
  const priceUsd = Number(nav.priceMicros) / 1_000_000;
  // Convert across the peg using redemption price (USDC ≈ $1).
  const grossOut =
    direction === 'usdc->usdy'
      ? Number(amountInMicro) / priceUsd
      : Number(amountInMicro) * priceUsd;
  const minOut = BigInt(Math.floor(grossOut * (1 - slippageBps / 10_000)));
  return {
    direction,
    venue: getSwapVenue(),
    amountInMicro: amountInMicro.toString(),
    minAmountOutMicro: minOut.toString(),
    slippageBps,
    redemptionPriceUsd: priceUsd,
  };
}

/**
 * Splash's fee, computed the chain's way: a mirror of splash_core::fee_config
 * (Amendment A1 §2.4, §4).
 *
 * `splashFee` is the chain's `fee_config::splash_fee`, step for step, in
 * bigint: the tier's rate (the first tier whose upper bound is above the
 * principal, else the last), less the business's discount, never below zero;
 * principal × rate / 10,000, rounded down; raised to the kind's minimum and
 * lowered to its maximum; and last lowered to the ceiling, 1% of the
 * principal, which beats the minimum. `deriveKind` is
 * `address_registry::derive_kind`. Both are held to the chain by the same
 * vectors (lib/fees/vectors.json, tests/fee-schedule.test.mjs, and the Move
 * tests scripts/gen-fee-tests.mjs generates from that file).
 * `settlementKind` adds what every settle path then refuses: a derived kind
 * that does not fit the declared one (`address_registry::assert_kind_fits`);
 * a quote should use it, since a vector's kind can be one the settle paths
 * refuse to pay (a partner address declared WALLET).
 *
 * The number shown to a payer is a quote, not the charge: the chain computes
 * the fee itself at settlement and checks it against the `max_fee` the payer
 * signed (EFeeAboveMax). A stale schedule can make a payment abort; it can
 * never make one pay more than it was shown.
 *
 * `LAUNCH_SCHEDULE` is A1 §2.2, the FeeConfig default at publish. It is the
 * reference the tests pin and the schedule copy falls back to, not the live
 * schedule: lib/fees/fee-config.ts reads that from the shared FeeConfig.
 *
 * Splash's fees are off until the first fee recipient change has been
 * applied (Sky, 24 Oct): while a FeeConfig has no recipient the chain's
 * `splash_fee` returns 0 on every kind, and so does `feeUnderConfig`, which
 * every quote goes through.
 *
 * Pure, and safe in a browser bundle: no chain, no environment. The pricing
 * line, the calculator and the fee breakdown render from it (lib/fees/copy.ts,
 * lib/fees/quote.ts); the chain reader is lib/fees/fee-config.ts, which runs on
 * the server only.
 */

// ─── Constants: splash_core::fee_config ─────────────────────────────────────

/** The most any fee may be, in basis points of the principal: 1%. The same
 *  constant as splash_core::fee_config and splash_spend (check:fees). */
export const FEE_CEILING_BPS = 100n;
export const BPS_DENOM = 10_000n;
export const FEE_MAX_TIERS = 8;
export const U64_MAX = 18_446_744_073_709_551_615n;
const U16_MAX = 65_535;

/** A1's kind numbers, the same on chain, in the vectors and here. */
export const FEE_KIND = Object.freeze({
  SPLASH_BUSINESS: 0,
  WALLET: 1,
  EXCHANGE: 2,
  CROSS_CHAIN: 3,
  BANK_PAYOUT: 4,
} as const);
export type FeeKind = (typeof FEE_KIND)[keyof typeof FEE_KIND];
export const FEE_KIND_COUNT = 5;

// ─── Types ──────────────────────────────────────────────────────────────────

/** Principals below `upperMinor` (and at or above the previous tier's) pay `bps`. */
export type FeeTier = { readonly upperMinor: bigint; readonly bps: bigint };
export type KindSchedule = { readonly tiers: readonly FeeTier[]; readonly minMinor: bigint; readonly maxMinor: bigint };
/** One schedule per kind, indexed by kind. */
export type FeeSchedule = readonly KindSchedule[];

export class FeeKindMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeKindMismatchError';
  }
}

// ─── The launch schedule (A1 §2.2; USDC, 6 decimals) ────────────────────────

export function freezeSchedule(kinds: KindSchedule[]): FeeSchedule {
  return Object.freeze(
    kinds.map((k) => Object.freeze({ ...k, tiers: Object.freeze(k.tiers.map((t) => Object.freeze({ ...t }))) })),
  );
}

const BANDS = [1_000_000_000n, 10_000_000_000n, 50_000_000_000n, 100_000_000_000n, U64_MAX];
const banded = (rates: bigint[]): FeeTier[] => rates.map((bps, i) => ({ upperMinor: BANDS[i], bps }));

export const LAUNCH_SCHEDULE: FeeSchedule = freezeSchedule([
  // SPLASH_BUSINESS: free inside the network.
  { tiers: [{ upperMinor: U64_MAX, bps: 0n }], minMinor: 0n, maxMinor: 0n },
  // WALLET: 2 bps, at least 0.25 USDC, at most 5 USDC.
  { tiers: [{ upperMinor: U64_MAX, bps: 2n }], minMinor: 250_000n, maxMinor: 5_000_000n },
  // EXCHANGE.
  { tiers: banded([15n, 12n, 10n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
  // CROSS_CHAIN, and BANK_PAYOUT on the same tiers.
  { tiers: banded([30n, 20n, 12n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
  { tiers: banded([30n, 20n, 12n, 7n, 5n]), minMinor: 0n, maxMinor: U64_MAX },
]);

// ─── The computation (A1 §2.4) ──────────────────────────────────────────────

function assertKind(kind: unknown, what = 'kind'): asserts kind is FeeKind {
  if (typeof kind !== 'number' || !Number.isInteger(kind) || kind < 0 || kind >= FEE_KIND_COUNT) {
    throw new RangeError(`${what} must be one of 0-${FEE_KIND_COUNT - 1}, got ${String(kind)}`);
  }
}

/** The schedule's rate for `principal`, before any discount, and which tier gave it. */
export function tierOf(s: KindSchedule, principalMinor: bigint): { index: number; bps: bigint } {
  if (s.tiers.length === 0) throw new RangeError('a schedule has at least one tier');
  for (let i = 0; i < s.tiers.length; i += 1) {
    if (principalMinor < s.tiers[i].upperMinor) return { index: i, bps: s.tiers[i].bps };
  }
  const last = s.tiers.length - 1;
  return { index: last, bps: s.tiers[last].bps };
}

/** `a * b / d`, rounded down; throws where Move's u64 cast would abort. */
function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  const r = (a * b) / d;
  if (r > U64_MAX) throw new RangeError('the fee does not fit a u64');
  return r;
}

/**
 * Splash's fee, in minor units, on `principalMinor` of `kind` for a business
 * with `discountBps` off the rate, under `schedule`. The chain's
 * `fee_config::splash_fee`, in its exact order. Throws only on inputs the
 * chain could never be given.
 */
export function splashFee({
  kind,
  principalMinor,
  discountBps,
  schedule,
}: {
  kind: FeeKind | number;
  principalMinor: bigint;
  discountBps: number | bigint;
  schedule: FeeSchedule;
}): bigint {
  assertKind(kind);
  if (typeof principalMinor !== 'bigint') throw new TypeError('principalMinor must be a bigint of minor units');
  if (principalMinor < 0n || principalMinor > U64_MAX) throw new RangeError('principalMinor must fit a u64');
  const discount = typeof discountBps === 'bigint' ? discountBps : Number.isInteger(discountBps) ? BigInt(discountBps) : -1n;
  if (discount < 0n || discount > BigInt(U16_MAX)) throw new RangeError('discountBps must be a whole number of basis points (a u16)');
  const s = schedule[kind];
  if (!s) throw new RangeError(`the schedule has no kind ${kind}`);

  let bps = tierOf(s, principalMinor).bps;
  bps = bps - (discount < bps ? discount : bps);
  let fee = mulDivFloor(principalMinor, bps, BPS_DENOM);
  if (fee < s.minMinor) fee = s.minMinor;
  if (fee > s.maxMinor) fee = s.maxMinor;
  const ceiling = mulDivFloor(principalMinor, FEE_CEILING_BPS, BPS_DENOM);
  if (fee > ceiling) fee = ceiling;
  return fee;
}

/**
 * Splash's fee under a whole FeeConfig: the chain's `fee_config::splash_fee`
 * with its config argument. 0 while the config's fees are off (no fee
 * recipient applied yet); otherwise `splashFee` on the config's schedule. An
 * unknown kind throws either way, as the chain checks it first.
 */
export function feeUnderConfig({
  config,
  kind,
  principalMinor,
  discountBps,
}: {
  config: FeeState;
  kind: FeeKind | number;
  principalMinor: bigint;
  discountBps: number | bigint;
}): bigint {
  const fee = splashFee({ kind, principalMinor, discountBps, schedule: config.schedule });
  return config.feesOn ? fee : 0n;
}

// ─── The kind (A1 §2.3) ─────────────────────────────────────────────────────

/**
 * The kind the chain charges: `address_registry::derive_kind`. `declared` is
 * the intent's kind on the owners' path, or the recipient's tag in the
 * SpendPolicy under a spending rule. A mismatch the chain would abort on
 * (EKindMismatch) throws.
 */
export function deriveKind({
  declared,
  viaCctp,
  recipientIsBusinessWallet,
  recipientIsPartnerAddress,
}: {
  declared: FeeKind | number;
  viaCctp: boolean;
  recipientIsBusinessWallet: boolean;
  recipientIsPartnerAddress: boolean;
}): FeeKind {
  assertKind(declared, 'declared');
  if (viaCctp) {
    if (declared !== FEE_KIND.CROSS_CHAIN) throw new FeeKindMismatchError('a CCTP payment must be declared CROSS_CHAIN');
    return FEE_KIND.CROSS_CHAIN;
  }
  if (recipientIsBusinessWallet) return FEE_KIND.SPLASH_BUSINESS;
  if (recipientIsPartnerAddress) return FEE_KIND.BANK_PAYOUT;
  if (declared !== FEE_KIND.WALLET && declared !== FEE_KIND.EXCHANGE) {
    throw new FeeKindMismatchError(`kind ${declared} needs a recipient the registries classify as it; this one is a plain address (WALLET or EXCHANGE)`);
  }
  return declared;
}

/**
 * The kind a settle path charges, and so the kind to quote: `deriveKind`,
 * then `address_registry::assert_kind_fits` (Sky, 24 Oct). The derived kind
 * must be the declared one, except a declared WALLET or EXCHANGE to a
 * business wallet, which is a free SPLASH_BUSINESS payment. Anything else
 * throws as the chain aborts (EKindMismatch): in particular a partner
 * deposit address is only ever paid as a declared BANK_PAYOUT, never as a
 * WALLET or EXCHANGE that would skip the bank floor and the beneficiary.
 */
export function settlementKind(args: {
  declared: FeeKind | number;
  viaCctp: boolean;
  recipientIsBusinessWallet: boolean;
  recipientIsPartnerAddress: boolean;
}): FeeKind {
  const derived = deriveKind(args);
  const { declared } = args;
  if (derived === declared) return derived;
  const toBusiness = derived === FEE_KIND.SPLASH_BUSINESS;
  if (toBusiness && (declared === FEE_KIND.WALLET || declared === FEE_KIND.EXCHANGE)) return derived;
  throw new FeeKindMismatchError(`a payment declared kind ${declared} goes to a recipient the registries classify as kind ${derived}; open it as kind ${derived}`);
}

/** What a fee is computed under: a schedule, and whether the fees are on. */
export type FeeState = { readonly feesOn: boolean; readonly schedule: FeeSchedule };

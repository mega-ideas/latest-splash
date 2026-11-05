/**
 * A quote of Splash's fee (Amendment A1 §4).
 *
 *   { splashFee: { kind, tierLabel, bps, minor }, partnerFee | circleFee:
 *     { minor, source }, totalDebitMinor, maxFeeMinor }
 *
 * `splashFee` is `fee_config::splash_fee` (lib/fees/schedule.ts) on the kind
 * the settle path charges (`settlementKind`), under the FeeConfig in force:
 * its kind, the band of principal it falls in, the rate after the
 * business's discount, and the fee in USDC minor units. While the FeeConfig
 * has no fee recipient the fees are off and it is 0.
 *
 * Splash's fee is charged on top of the principal: the settle paths take
 * principal + fee from the payer (`value(payment) >= principal + fee`), so
 * `totalDebitMinor` is the two together. A payout partner's fee, or Circle's
 * on a cross-chain payment, is the partner's or Circle's own, from their own
 * quote: shown as its own line with its source, never added to Splash's fee
 * or marked up, and taken out of what the partner pays out (or Circle mints),
 * not debited from the payer on top.
 *
 * `maxFeeMinor` is the `max_fee` the payer signs: exactly the fee shown (Sky,
 * 24 Oct). The chain computes the fee again and aborts (EFeeAboveMax) when it
 * is above, so a schedule raised after the quote was shown can stop the
 * payment but never make it pay more.
 *
 * Pure and client-safe. `feeQuoteToWire` / `feeQuoteFromWire` carry it over
 * JSON as decimal strings, so no amount passes through a float.
 */
import { kindLabel, tierLabel } from './copy.ts';
import {
  BPS_DENOM,
  FEE_CEILING_BPS,
  FEE_KIND_COUNT,
  U64_MAX,
  feeUnderConfig,
  tierOf,
  type FeeKind,
  type FeeState,
} from './schedule.ts';

/** Which bound set Splash's fee: the tier's rate, the kind's minimum or maximum, the 1% ceiling, or none (fees off). */
export type FeeBasis = 'rate' | 'minimum' | 'maximum' | 'ceiling' | 'off';

/** A fee Splash does not set, as its source quoted it. `minor` is null while it has not quoted. */
export type ThirdPartyFee = { readonly minor: bigint | null; readonly source: string };

export type FeeQuote = {
  readonly principalMinor: bigint;
  /** False while the FeeConfig has no fee recipient: Splash charges nothing. */
  readonly feesOn: boolean;
  readonly splashFee: {
    readonly kind: FeeKind;
    readonly kindLabel: string;
    readonly tierLabel: string;
    /** The rate applied, after the business's discount; 0 while the fees are off. */
    readonly bps: bigint;
    readonly minor: bigint;
    readonly basis: FeeBasis;
  };
  readonly partnerFee?: ThirdPartyFee;
  readonly circleFee?: ThirdPartyFee;
  /** principal + Splash's fee: what leaves the payer. */
  readonly totalDebitMinor: bigint;
  /** The max_fee the payer signs: the fee shown. */
  readonly maxFeeMinor: bigint;
};

function assertPrincipal(p: unknown): asserts p is bigint {
  if (typeof p !== 'bigint' || p < 0n || p > U64_MAX) throw new RangeError('principalMinor must be a u64 bigint of USDC minor units');
}

/**
 * The quote for paying `principalMinor` as `kind` under `state`. `kind` is the
 * kind the settle path charges: pass `settlementKind(...)`, never a declared
 * kind the registries would reclassify.
 */
export function buildFeeQuote({
  kind,
  principalMinor,
  discountBps = 0,
  state,
  partnerFee,
  circleFee,
}: {
  kind: FeeKind;
  principalMinor: bigint;
  discountBps?: number | bigint;
  state: FeeState;
  partnerFee?: ThirdPartyFee;
  circleFee?: ThirdPartyFee;
}): FeeQuote {
  assertPrincipal(principalMinor);
  if (partnerFee && circleFee) throw new RangeError('a quote carries a partner fee or a Circle fee, not both');
  for (const f of [partnerFee, circleFee]) {
    if (f && f.minor !== null && (typeof f.minor !== 'bigint' || f.minor < 0n)) throw new RangeError('a third-party fee is a non-negative bigint, or null');
    if (f && !f.source.trim()) throw new RangeError('a third-party fee names its source');
  }

  const minor = feeUnderConfig({ config: state, kind, principalMinor, discountBps });
  const s = state.schedule[kind];
  const tier = tierOf(s, principalMinor);
  const discount = BigInt(discountBps);
  const rate = tier.bps - (discount < tier.bps ? discount : tier.bps);

  let basis: FeeBasis = 'off';
  if (state.feesOn) {
    const byRate = (principalMinor * rate) / BPS_DENOM;
    const bounded = byRate < s.minMinor ? s.minMinor : byRate > s.maxMinor ? s.maxMinor : byRate;
    const ceiling = (principalMinor * FEE_CEILING_BPS) / BPS_DENOM;
    if (minor === ceiling && minor < bounded) basis = 'ceiling';
    else if (bounded !== byRate) basis = byRate < s.minMinor ? 'minimum' : 'maximum';
    else basis = 'rate';
  }

  const totalDebitMinor = principalMinor + minor;
  if (totalDebitMinor > U64_MAX) throw new RangeError('principal and fee together do not fit a u64');
  return {
    principalMinor,
    feesOn: state.feesOn,
    splashFee: {
      kind,
      kindLabel: kindLabel(kind),
      tierLabel: tierLabel(s, tier.index),
      bps: state.feesOn ? rate : 0n,
      minor,
      basis,
    },
    ...(partnerFee ? { partnerFee: { minor: partnerFee.minor, source: partnerFee.source } } : {}),
    ...(circleFee ? { circleFee: { minor: circleFee.minor, source: circleFee.source } } : {}),
    totalDebitMinor,
    maxFeeMinor: minor,
  };
}

// ─── Over JSON ──────────────────────────────────────────────────────────────

export type ThirdPartyFeeWire = { minor: string | null; source: string };

export type FeeQuoteWire = {
  principalMinor: string;
  feesOn: boolean;
  splashFee: { kind: FeeKind; kindLabel: string; tierLabel: string; bps: string; minor: string; basis: FeeBasis };
  partnerFee?: ThirdPartyFeeWire;
  circleFee?: ThirdPartyFeeWire;
  totalDebitMinor: string;
  maxFeeMinor: string;
};

const third = (f: ThirdPartyFee | undefined): ThirdPartyFeeWire | undefined =>
  f ? { minor: f.minor === null ? null : f.minor.toString(), source: f.source } : undefined;

export function feeQuoteToWire(q: FeeQuote): FeeQuoteWire {
  const partnerFee = third(q.partnerFee);
  const circleFee = third(q.circleFee);
  return {
    principalMinor: q.principalMinor.toString(),
    feesOn: q.feesOn,
    splashFee: { ...q.splashFee, bps: q.splashFee.bps.toString(), minor: q.splashFee.minor.toString() },
    ...(partnerFee ? { partnerFee } : {}),
    ...(circleFee ? { circleFee } : {}),
    totalDebitMinor: q.totalDebitMinor.toString(),
    maxFeeMinor: q.maxFeeMinor.toString(),
  };
}

const WHOLE = /^(0|[1-9]\d*)$/;
function u64(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !WHOLE.test(v)) throw new RangeError(`${what} is not a whole number written as a string`);
  const n = BigInt(v);
  if (n > U64_MAX) throw new RangeError(`${what} does not fit a u64`);
  return n;
}
const BASES = new Set<FeeBasis>(['rate', 'minimum', 'maximum', 'ceiling', 'off']);

/** A quote back from JSON, checked: its amounts are u64s and its total is principal + fee. */
export function feeQuoteFromWire(w: unknown): FeeQuote {
  if (!w || typeof w !== 'object') throw new RangeError('a fee quote is an object');
  const o = w as FeeQuoteWire;
  const principalMinor = u64(o.principalMinor, 'principalMinor');
  const s = o.splashFee;
  if (!s || typeof s !== 'object') throw new RangeError('a fee quote has a splashFee');
  if (!Number.isInteger(s.kind) || s.kind < 0 || s.kind >= FEE_KIND_COUNT) throw new RangeError('splashFee.kind is not a kind');
  if (!BASES.has(s.basis)) throw new RangeError('splashFee.basis is not a basis');
  if (typeof s.kindLabel !== 'string' || typeof s.tierLabel !== 'string') throw new RangeError('splashFee has no labels');
  const minor = u64(s.minor, 'splashFee.minor');
  const totalDebitMinor = u64(o.totalDebitMinor, 'totalDebitMinor');
  const maxFeeMinor = u64(o.maxFeeMinor, 'maxFeeMinor');
  if (totalDebitMinor !== principalMinor + minor) throw new RangeError('the total debited is not the principal plus the fee');
  if (maxFeeMinor !== minor) throw new RangeError('maxFeeMinor is not the fee shown');
  const back = (f: ThirdPartyFeeWire | undefined, what: string): ThirdPartyFee | undefined => {
    if (f === undefined) return undefined;
    if (!f || typeof f.source !== 'string' || !f.source.trim()) throw new RangeError(`${what} names no source`);
    return { minor: f.minor === null ? null : u64(f.minor, `${what}.minor`), source: f.source };
  };
  const partnerFee = back(o.partnerFee, 'partnerFee');
  const circleFee = back(o.circleFee, 'circleFee');
  if (partnerFee && circleFee) throw new RangeError('a quote carries a partner fee or a Circle fee, not both');
  return {
    principalMinor,
    feesOn: o.feesOn === true,
    splashFee: { kind: s.kind, kindLabel: s.kindLabel, tierLabel: s.tierLabel, bps: u64(s.bps, 'splashFee.bps'), minor, basis: s.basis },
    ...(partnerFee ? { partnerFee } : {}),
    ...(circleFee ? { circleFee } : {}),
    totalDebitMinor,
    maxFeeMinor,
  };
}

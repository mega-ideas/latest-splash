/**
 * Splash's fee in words, rendered from a schedule (Amendment A1 §2.7).
 *
 * Every rate, minimum and band a customer reads comes out of here, computed
 * from the schedule it is handed: the pricing line, the calculator, the fee
 * breakdown on the transfer review and on the receipt, and Zeke's answer.
 * Copy never types a rate in (check:fees rule (c) refuses one under app/,
 * components/ and content/), so a schedule changed through the 24-hour path
 * changes the copy with it and no sentence is left quoting the old price.
 *
 * Pure and client-safe, like lib/fees/schedule.ts. Amounts are USDC minor
 * units (6 decimals), formatted from bigint without floating point.
 */
import {
  FEE_CEILING_BPS,
  FEE_KIND,
  FEE_KIND_COUNT,
  FEE_MAX_TIERS,
  U64_MAX,
  freezeSchedule,
  type FeeKind,
  type FeeSchedule,
  type KindSchedule,
} from './schedule.ts';
import type { FeeQuoteWire } from './quote.ts';

const USDC_DECIMALS = 6n;
const USDC_UNIT = 10n ** USDC_DECIMALS;

// ─── Labels ─────────────────────────────────────────────────────────────────

const KIND_LABELS: Readonly<Record<FeeKind, string>> = Object.freeze({
  [FEE_KIND.SPLASH_BUSINESS]: 'Splash business',
  [FEE_KIND.WALLET]: 'Sui wallet',
  [FEE_KIND.EXCHANGE]: 'Exchange',
  [FEE_KIND.CROSS_CHAIN]: 'Another chain',
  [FEE_KIND.BANK_PAYOUT]: 'Bank payout',
});

/** What a customer calls a kind: "Bank payout", "Sui wallet". */
export function kindLabel(kind: FeeKind | number): string {
  const label = KIND_LABELS[kind as FeeKind];
  if (!label) throw new RangeError(`kind must be one of 0-${FEE_KIND_COUNT - 1}, got ${String(kind)}`);
  return label;
}

// ─── Numbers ────────────────────────────────────────────────────────────────

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Basis points as a percentage to two places: 2n → "0.02%", 30n → "0.30%". */
export function formatRate(bps: bigint): string {
  if (bps < 0n) throw new RangeError('a rate is never negative');
  return `${group((bps / 100n).toString())}.${(bps % 100n).toString().padStart(2, '0')}%`;
}

/** The number of a rate, without its "%": the low end of a range. */
function rateNumber(bps: bigint): string {
  return formatRate(bps).slice(0, -1);
}

/**
 * A USDC amount for a money column: grouped, at least two decimals, and
 * every further digit the amount has, so nothing is rounded away
 * (2_999_999n → "2.999999", 1_000_000_000n → "1,000.00").
 */
export function formatUsdc(minor: bigint): string {
  if (minor < 0n) throw new RangeError('an amount is never negative here');
  const whole = group((minor / USDC_UNIT).toString());
  const fraction = (minor % USDC_UNIT).toString().padStart(Number(USDC_DECIMALS), '0').replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${fraction}`;
}

/** A USDC amount for prose: a whole amount loses its ".00" ("1,000"), any other keeps formatUsdc's form ("0.25"). */
export function formatUsdcBound(minor: bigint): string {
  return minor % USDC_UNIT === 0n ? group((minor / USDC_UNIT).toString()) : formatUsdc(minor);
}

// ─── Tiers and ranges ───────────────────────────────────────────────────────

/**
 * Which band of principal a tier covers. Upper bounds are exclusive, as on
 * chain: "Under 1,000 USDC", "1,000 to under 10,000 USDC", "100,000 USDC and
 * above"; a schedule of one tier is "Any amount".
 */
export function tierLabel(s: KindSchedule, index: number): string {
  const n = s.tiers.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) throw new RangeError(`tier ${index} is not one of 0-${n - 1}`);
  if (n === 1) return 'Any amount';
  if (index === 0) return `Under ${formatUsdcBound(s.tiers[0].upperMinor)} USDC`;
  const from = formatUsdcBound(s.tiers[index - 1].upperMinor);
  if (index === n - 1) return `${from} USDC and above`;
  return `${from} to under ${formatUsdcBound(s.tiers[index].upperMinor)} USDC`;
}

function rates(s: KindSchedule): { low: bigint; high: bigint } {
  const all = s.tiers.map((t) => t.bps);
  return { low: all.reduce((a, b) => (b < a ? b : a)), high: all.reduce((a, b) => (b > a ? b : a)) };
}

/** The rates a kind charges: "0.02%", or "0.05–0.30%" across its tiers. */
export function rateRange(s: KindSchedule): string {
  const { low, high } = rates(s);
  return low === high ? formatRate(low) : `${rateNumber(low)}–${formatRate(high)}`;
}

/** Whether every tier charges no more than the one below it, and some charge less. */
function lowerForLarger(s: KindSchedule): boolean {
  const r = s.tiers.map((t) => t.bps);
  return r.length > 1 && r.every((bps, i) => i === 0 || bps <= r[i - 1]) && r[r.length - 1] < r[0];
}

function isFree(s: KindSchedule): boolean {
  return s.tiers.every((t) => t.bps === 0n) && s.minMinor === 0n;
}

function sameSchedule(a: KindSchedule, b: KindSchedule): boolean {
  return a.minMinor === b.minMinor
    && a.maxMinor === b.maxMinor
    && a.tiers.length === b.tiers.length
    && a.tiers.every((t, i) => t.upperMinor === b.tiers[i].upperMinor && t.bps === b.tiers[i].bps);
}

/** "0.02% to any Sui wallet (min 0.25 USDC)": one kind's price, as a phrase. */
function pricePhrase(s: KindSchedule, where: string, { tiered }: { tiered: boolean }): string {
  if (isFree(s)) return `Free ${where}`;
  const min = s.minMinor > 0n ? ` (min ${formatUsdcBound(s.minMinor)} USDC)` : '';
  const lower = tiered && lowerForLarger(s) ? ', lower for larger payments' : '';
  return `${rateRange(s)} ${where}${min}${lower}`;
}

/** The sentence after the prices: the fees Splash does not set are their own lines. */
export const PRICING_FOOTNOTE = 'Payout-partner or Circle fees are shown separately before you approve.';

/**
 * The prices, one phrase per kind, in A1 §2.7's order: between Splash
 * businesses, to a Sui wallet, to an exchange, to a bank or another chain
 * (one phrase while their schedules are the same, two once they differ).
 */
export function pricingParts(schedule: FeeSchedule): string[] {
  const k = (kind: FeeKind) => {
    const s = schedule[kind];
    if (!s) throw new RangeError(`the schedule has no kind ${kind}`);
    return s;
  };
  const business = k(FEE_KIND.SPLASH_BUSINESS);
  const parts = [
    isFree(business) ? 'Free between Splash businesses' : pricePhrase(business, 'between Splash businesses', { tiered: false }),
    pricePhrase(k(FEE_KIND.WALLET), 'to any Sui wallet', { tiered: false }),
    pricePhrase(k(FEE_KIND.EXCHANGE), 'to supported exchanges', { tiered: false }),
  ];
  const bank = k(FEE_KIND.BANK_PAYOUT);
  const chain = k(FEE_KIND.CROSS_CHAIN);
  if (sameSchedule(bank, chain)) parts.push(pricePhrase(bank, 'to a bank or another chain', { tiered: true }));
  else parts.push(pricePhrase(bank, 'to a bank', { tiered: true }), pricePhrase(chain, 'to another chain', { tiered: true }));
  return parts;
}

/**
 * What every surface says while FeeConfig's fees are off (no fee recipient
 * applied yet, Sky's FIXUP 1): the chain charges 0 on every kind. Fees start
 * only when a fee recipient is applied, and that change waits 24 hours after
 * it is proposed, in public.
 */
export const FEES_OFF_NOTICE = "No Splash fee is charged yet. Fees start only after 24 hours' public notice.";
const FEES_OFF_LEAD = "No Splash fee is charged yet. Once fees start, after 24 hours' public notice:";

/**
 * A1 §2.7's pricing line, from `schedule`. While the fees are off
 * (`feesOn: false`) it says no Splash fee is charged yet, then the schedule
 * that applies once they start.
 */
export function pricingLine(schedule: FeeSchedule, { feesOn = true }: { feesOn?: boolean } = {}): string {
  const prices = `${pricingParts(schedule).join(' · ')}. ${PRICING_FOOTNOTE}`;
  return feesOn ? prices : `${FEES_OFF_LEAD} ${prices}`;
}

/** One kind's price as a phrase on its own, for a table cell: "0.05–0.30%, lower for larger payments". */
export function kindPrice(schedule: FeeSchedule, kind: FeeKind): string {
  const s = schedule[kind];
  if (!s) throw new RangeError(`the schedule has no kind ${kind}`);
  if (isFree(s)) return 'Free';
  const min = s.minMinor > 0n ? ` (min ${formatUsdcBound(s.minMinor)} USDC)` : '';
  return `${rateRange(s)}${min}${lowerForLarger(s) ? ', lower for larger payments' : ''}`;
}

// ─── A schedule as data, for a client component ─────────────────────────────

export type KindScheduleWire = {
  tiers: Array<{ upperMinor: string; bps: string }>;
  minMinor: string;
  maxMinor: string;
};
export type FeeScheduleWire = KindScheduleWire[];

/** A schedule as JSON-safe strings, so a server parent can hand it to a client component. */
export function scheduleToWire(schedule: FeeSchedule): FeeScheduleWire {
  return schedule.map((s) => ({
    tiers: s.tiers.map((t) => ({ upperMinor: t.upperMinor.toString(), bps: t.bps.toString() })),
    minMinor: s.minMinor.toString(),
    maxMinor: s.maxMinor.toString(),
  }));
}

const WHOLE = /^(0|[1-9]\d*)$/;
function whole(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !WHOLE.test(v)) throw new RangeError(`${what} is not a whole number of minor units`);
  const n = BigInt(v);
  if (n > U64_MAX) throw new RangeError(`${what} does not fit a u64`);
  return n;
}

/** The schedule back from its wire form, checked as fee_config would check a proposal. */
export function scheduleFromWire(wire: unknown): FeeSchedule {
  if (!Array.isArray(wire) || wire.length !== FEE_KIND_COUNT) throw new RangeError(`a schedule has one entry per kind (${FEE_KIND_COUNT})`);
  return freezeSchedule(
    wire.map((k: KindScheduleWire, kind) => {
      if (!k || !Array.isArray(k.tiers) || k.tiers.length < 1 || k.tiers.length > FEE_MAX_TIERS) throw new RangeError(`kind ${kind} has no valid tiers`);
      const tiers = k.tiers.map((t, i) => {
        const tier = { upperMinor: whole(t?.upperMinor, `kind ${kind} tier ${i} upper`), bps: whole(t?.bps, `kind ${kind} tier ${i} bps`) };
        if (tier.bps > FEE_CEILING_BPS) throw new RangeError(`kind ${kind} tier ${i} is above the ${FEE_CEILING_BPS} bps ceiling`);
        return tier;
      });
      for (let i = 1; i < tiers.length; i += 1) if (!(tiers[i - 1].upperMinor < tiers[i].upperMinor)) throw new RangeError(`kind ${kind} upper bounds are not ascending`);
      if (tiers[tiers.length - 1].upperMinor !== U64_MAX) throw new RangeError(`kind ${kind}'s last upper bound is not u64::MAX`);
      const minMinor = whole(k.minMinor, `kind ${kind} min`);
      const maxMinor = whole(k.maxMinor, `kind ${kind} max`);
      if (minMinor > maxMinor) throw new RangeError(`kind ${kind}'s minimum is above its maximum`);
      return { tiers, minMinor, maxMinor };
    }),
  );
}

// ─── The fee breakdown (calculator, transfer review, receipt) ───────────────

export type FeeBreakdownRow = {
  key: 'splash' | 'partner' | 'circle' | 'total';
  label: string;
  /** What the line is: the kind, tier and rate, or who quoted it. */
  detail: string | null;
  /** "2.00 USDC", or "Not quoted yet" for a partner or Circle fee with no quote. */
  amount: string;
};

/** The ceiling as a reader says it: "1%". */
const CEILING_WORDS = `${formatRate(FEE_CEILING_BPS).replace(/\.00%$/, '%')}`;

/**
 * What set Splash's fee, in words (the A1 review). Only the bound that set it
 * is named: the tier's rate ("0.20%"), the kind's minimum or maximum, which
 * is then the fee itself ("minimum 0.25 USDC"), or the ceiling, which only
 * ever lowers a minimum above 1% of the amount ("1% ceiling, lower than the
 * minimum"). A rate the minimum or maximum overrode is not shown beside a
 * fee it did not set.
 */
function basisWords(s: FeeQuoteWire['splashFee']): string {
  switch (s.basis) {
    case 'minimum':
      return `minimum ${formatUsdcBound(BigInt(s.minor))} USDC`;
    case 'maximum':
      return `maximum ${formatUsdcBound(BigInt(s.minor))} USDC`;
    case 'ceiling':
      return `${CEILING_WORDS} ceiling, lower than the minimum`;
    default:
      return formatRate(BigInt(s.bps));
  }
}

/**
 * The lines a fee breakdown shows, the same on every surface: Splash's fee
 * with its kind, tier and the bound that set it; the payout partner's or
 * Circle's fee with its source; the total debited. While the fees are off
 * Splash's line says so and shows 0.
 */
export function feeBreakdownRows(q: FeeQuoteWire): FeeBreakdownRow[] {
  const s = q.splashFee;
  const detail = q.feesOn
    ? [s.kindLabel, s.tierLabel, basisWords(s)].join(' · ')
    : `${s.kindLabel} · Splash's fee is not charged yet`;
  const rows: FeeBreakdownRow[] = [{ key: 'splash', label: 'Splash fee', detail, amount: `${formatUsdc(BigInt(s.minor))} USDC` }];
  // A partner's or Circle's fee is theirs: it comes out of what they pay out
  // or mint, so the line says so, and the total below does not include it.
  const third = (key: 'partner' | 'circle', label: string, f: { minor: string | null; source: string } | undefined, where: string) => {
    if (f) rows.push({ key, label, detail: `${f.source}. ${where}`, amount: f.minor === null ? 'Not quoted yet' : `${formatUsdc(BigInt(f.minor))} USDC` });
  };
  third('partner', 'Payout-partner fee', q.partnerFee, 'Taken from the payout, not debited.');
  third('circle', 'Circle fee', q.circleFee, 'Taken from the amount minted, not debited.');
  rows.push({ key: 'total', label: 'Total debited', detail: null, amount: `${formatUsdc(BigInt(q.totalDebitMinor))} USDC` });
  return rows;
}

// ─── The landing's pricing, as data a client component can take ────────────

/**
 * Splash's prices in the phrases the landing uses, all from one schedule,
 * and whether they are charged yet. The per-kind prices and `bankRange` are
 * the schedule (the price list); a surface that shows what a payment pays
 * now uses `bankFee`, `bankFeePhrase` and `notice`, which say "none yet"
 * while the fees are off.
 */
export type PricingSummary = {
  /** False while FeeConfig has no fee recipient: Splash charges nothing. */
  feesOn: boolean;
  /** A1 §2.7's pricing line; while the fees are off it says none is charged yet. */
  line: string;
  /** Its phrases, one per kind (or bank and chain together). */
  parts: string[];
  /** Each kind's price alone, for a table cell: "Free", "0.02% (min 0.25 USDC)". */
  business: string;
  wallet: string;
  exchange: string;
  bank: string;
  chain: string;
  /** The bank schedule's range alone: "0.05–0.30%". */
  bankRange: string;
  /** Splash's fee to a bank now, as a value: the range, or "None yet". */
  bankFee: string;
  /** The same as a phrase: "0.05–0.30% Splash fee to a bank", or "No Splash fee charged yet". */
  bankFeePhrase: string;
  /** While the fees are off, a sentence saying so; null while they are on. */
  notice: string | null;
};

export function pricingSummary(schedule: FeeSchedule, { feesOn = true }: { feesOn?: boolean } = {}): PricingSummary {
  const bankRange = rateRange(schedule[FEE_KIND.BANK_PAYOUT]);
  return {
    feesOn,
    line: pricingLine(schedule, { feesOn }),
    parts: pricingParts(schedule),
    business: kindPrice(schedule, FEE_KIND.SPLASH_BUSINESS),
    wallet: kindPrice(schedule, FEE_KIND.WALLET),
    exchange: kindPrice(schedule, FEE_KIND.EXCHANGE),
    bank: kindPrice(schedule, FEE_KIND.BANK_PAYOUT),
    chain: kindPrice(schedule, FEE_KIND.CROSS_CHAIN),
    bankRange,
    bankFee: feesOn ? bankRange : 'None yet',
    bankFeePhrase: feesOn ? `${bankRange} Splash fee to a bank` : 'No Splash fee charged yet',
    notice: feesOn ? null : FEES_OFF_NOTICE,
  };
}

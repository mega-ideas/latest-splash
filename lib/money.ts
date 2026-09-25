/**
 * Exact money arithmetic. Integer minor units, no float anywhere.
 *
 * `check:copy` warned on seventeen sites doing float math on money and called
 * it "the debt mainnet cannot carry". This is what pays it down.
 *
 * The problem is not that floats are imprecise in the abstract. It is that
 * `parseFloat('0.1')` is already not 0.1 — it is 0.1000000000000000055511…,
 * the nearest double. Add a hundred of them and you get 9.99999999999998, so
 * a batch of a hundred ten-cent payouts reconciles one cent short against a
 * ledger that did the same sum in integers. Nothing warns you; the number is
 * simply wrong, and it is wrong differently depending on the order the rows
 * arrived in.
 *
 * So: a money amount is a `bigint` count of minor units, and its decimals are
 * carried alongside it. A rate is a scaled integer, so amount × rate is
 * integer arithmetic that happens to have a decimal point in the middle.
 *
 * Rounding is always an argument. There is no default, because there is no
 * safe one: rounding a payout down and a fee up are both defensible, and both
 * are wrong in the other direction. A caller that has not thought about it
 * should be made to.
 */

export type Rounding = 'trunc' | 'floor' | 'ceil' | 'half-up' | 'half-even';

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Decimal string, optional sign, optional fraction. No exponent: a value
 *  arriving as "1e-7" is a number that has already been through a float. */
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/**
 * Divide, applying an explicit rounding mode. `den` must be positive; the
 * sign travels with `num`, which is what makes 'floor' and 'trunc' differ on
 * negative amounts — the distinction that matters for refunds.
 */
export function divRound(num: bigint, den: bigint, rounding: Rounding): bigint {
  if (den === 0n) throw new MoneyError('division by zero');
  if (den < 0n) throw new MoneyError('denominator must be positive');

  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = abs / den;
  const r = abs % den;

  if (r === 0n) return negative ? -q : q;

  let up: boolean;
  switch (rounding) {
    case 'trunc':
      up = false;
      break;
    case 'floor':
      up = negative; // toward -infinity
      break;
    case 'ceil':
      up = !negative; // toward +infinity
      break;
    case 'half-up': {
      up = r * 2n >= den;
      break;
    }
    case 'half-even': {
      const twice = r * 2n;
      if (twice > den) up = true;
      else if (twice < den) up = false;
      else up = q % 2n === 1n; // exact half: round to even
      break;
    }
    default: {
      const never: never = rounding;
      throw new MoneyError(`unknown rounding mode: ${String(never)}`);
    }
  }

  const magnitude = up ? q + 1n : q;
  return negative ? -magnitude : magnitude;
}

/**
 * Parse a decimal amount into minor units, exactly.
 *
 * Accepts a string (the only form that can be exact), a bigint (already minor
 * units — returned unchanged), or a number, which is rejected unless it is a
 * safe integer: a fractional `number` has already lost the precision this
 * function exists to preserve, and silently accepting it would make the whole
 * module decorative.
 *
 * More fraction digits than `decimals` is an error rather than a silent trim,
 * unless a rounding mode is given. "0.005 USD" is either a rounding decision
 * or a bug, and the caller knows which.
 */
export function parseMinor(
  input: string | number | bigint,
  decimals: number,
  rounding?: Rounding,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new MoneyError(`decimals must be an integer 0..18, got ${decimals}`);
  }
  if (typeof input === 'bigint') return input;

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`amount is not finite: ${input}`);
    if (!Number.isInteger(input)) {
      throw new MoneyError(
        `refusing a fractional number (${input}) — it has already been through a float. ` +
          'Pass the decimal string it came from, or a bigint of minor units.',
      );
    }
    return BigInt(input) * pow10(decimals);
  }

  const raw = input.trim();
  if (raw === '') throw new MoneyError('amount is empty');
  if (!DECIMAL.test(raw)) throw new MoneyError(`not a decimal amount: "${input}"`);

  const negative = raw.startsWith('-');
  const unsigned = raw.replace(/^[+-]/, '');
  const [whole = '', frac = ''] = unsigned.split('.');

  let minor: bigint;
  if (frac.length <= decimals) {
    const padded = frac.padEnd(decimals, '0');
    minor = BigInt(whole || '0') * pow10(decimals) + BigInt(padded || '0');
  } else {
    if (!rounding) {
      throw new MoneyError(
        `"${input}" has ${frac.length} fraction digits but this currency has ${decimals}. ` +
          'Pass a rounding mode to state the decision explicitly.',
      );
    }
    const scaled = BigInt(whole || '0') * pow10(frac.length) + BigInt(frac);
    minor = divRound(scaled, pow10(frac.length - decimals), rounding);
  }

  return negative ? -minor : minor;
}

/** Minor units back to a decimal string, sign preserved, always `decimals`
 *  places so amounts line up in a column and compare as strings. */
export function formatMinor(minor: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new MoneyError(`decimals must be an integer 0..18, got ${decimals}`);
  }
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  if (decimals === 0) return `${negative ? '-' : ''}${abs}`;
  const unit = pow10(decimals);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * A rate — an FX quote, a NAV, a price — as a scaled integer.
 *
 * A rate is genuinely fractional, so forcing it into minor units would be
 * cargo cult. What matters is that multiplying an amount by one stays integer
 * arithmetic, which is what `applyRate` does.
 */
export type Rate = {
  /** rate × 10^scale */
  readonly scaled: bigint;
  readonly scale: number;
};

export const RATE_SCALE = 12;

export function parseRate(input: string | number | bigint, scale: number = RATE_SCALE): Rate {
  if (!Number.isInteger(scale) || scale < 0 || scale > 24) {
    throw new MoneyError(`rate scale must be an integer 0..24, got ${scale}`);
  }
  if (typeof input === 'bigint') return { scaled: input, scale };
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new MoneyError(`rate is not finite: ${input}`);
    // A rate that arrived as a float is already approximate; there is no
    // string to recover. Convert at full double precision and no further,
    // rather than pretending the extra digits mean anything.
    return { scaled: parseMinor(input.toFixed(Math.min(scale, 15)), scale, 'half-even'), scale };
  }
  return { scaled: parseMinor(input, scale, 'half-even'), scale };
}

export function formatRate(rate: Rate): string {
  return formatMinor(rate.scaled, rate.scale);
}

/**
 * A rate as a JavaScript number, for showing it or for a response field typed
 * as one: a price to four places on a status line.
 *
 * Never for arithmetic on money. An amount times a rate goes through
 * `applyRate`, which stays in integers; a rate is not an amount, and display
 * is the one job a double does well enough.
 */
export function rateToNumber(rate: Rate): number {
  return Number(formatRate(rate));
}

/**
 * amount × rate, exactly, with the rounding stated.
 *
 * `outDecimals` defaults to the amount's own decimals — a USD amount times an
 * FX rate is still expressed in whatever the target currency uses, so a
 * cross-currency conversion must pass it.
 */
export function applyRate(
  amountMinor: bigint,
  rate: Rate,
  rounding: Rounding,
  fromDecimals: number,
  toDecimals: number = fromDecimals,
): bigint {
  const scaledUp = amountMinor * rate.scaled * pow10(toDecimals);
  return divRound(scaledUp, pow10(rate.scale) * pow10(fromDecimals), rounding);
}

/** amount ÷ rate, exactly. The inverse direction of a quote. */
export function divideByRate(
  amountMinor: bigint,
  rate: Rate,
  rounding: Rounding,
  fromDecimals: number,
  toDecimals: number = fromDecimals,
): bigint {
  if (rate.scaled === 0n) throw new MoneyError('cannot divide by a zero rate');
  const negativeRate = rate.scaled < 0n;
  const num = amountMinor * pow10(rate.scale) * pow10(toDecimals);
  const den = (negativeRate ? -rate.scaled : rate.scaled) * pow10(fromDecimals);
  const q = divRound(negativeRate ? -num : num, den, rounding);
  return q;
}

/**
 * Basis points of an amount. Fees and slippage.
 *
 * Rounding is required for the same reason as everywhere else: a fee rounded
 * down is revenue lost, a fee rounded up is a customer overcharged by a unit,
 * and which one is correct is a policy decision rather than a maths one.
 */
export function applyBps(amountMinor: bigint, bps: number | bigint, rounding: Rounding): bigint {
  const b = typeof bps === 'bigint' ? bps : BigInt(Math.trunc(bps));
  if (typeof bps === 'number' && !Number.isInteger(bps)) {
    throw new MoneyError(`basis points must be a whole number, got ${bps}`);
  }
  return divRound(amountMinor * b, 10_000n, rounding);
}

/** Sum minor units. Exists so a reduce over money cannot start at `0`. */
export function sumMinor(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}

/** Common decimal places, so call sites stop writing 6 and 1_000_000. */
export const USD_DECIMALS = 2;
/** USDC, USDT and the Sui coin types this app settles in. */
export const MICRO_DECIMALS = 6;
/** SUI itself. */
export const MIST_DECIMALS = 9;

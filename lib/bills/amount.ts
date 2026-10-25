/**
 * Supplier invoice amounts: exact decimals, kept as micros (six decimals) in a
 * bigint, the same scale as USDC and the invoices table. Never a float.
 *
 * What a person types and what an invoice prints differ in separators:
 * "1,250.00" (US and most of SEA), "1.250.000" (rupiah, dots for thousands),
 * "1250,50" (comma decimal). `normalizeAmount` reads all three and refuses
 * anything else, rather than guessing.
 */

export const MICROS = 6;
const UNIT = 10n ** BigInt(MICROS);

/** Currencies printed with no minor unit. */
const ZERO_DECIMAL = new Set(['IDR', 'VND', 'JPY', 'KRW']);

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** A printed amount as a plain decimal string ("1250.5"), or null when it is not one. */
export function normalizeAmount(raw: string): string | null {
  const s = raw.replace(/[\s ]/g, '');
  if (!s) return null;
  let plain: string | null = null;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) plain = s.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) plain = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(\.\d+)?$/.test(s)) plain = s;
  else if (/^\d+,\d{1,2}$/.test(s)) plain = s.replace(',', '.');
  if (plain === null) return null;
  const [whole, frac = ''] = plain.split('.');
  if (frac.length > MICROS) return null;
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  const trimmedFrac = frac.replace(/0+$/, '');
  return trimmedFrac ? `${trimmedWhole}.${trimmedFrac}` : trimmedWhole;
}

/** A plain decimal string to micros. Throws on anything that is not one. */
export function toMicros(decimal: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(decimal)) throw new Error(`not an amount: ${decimal}`);
  const [whole, frac = ''] = decimal.split('.');
  return BigInt(whole) * UNIT + BigInt((frac + '000000').slice(0, MICROS));
}

export function fromMicros(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const frac = (abs % UNIT).toString().padStart(MICROS, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / UNIT}${frac ? `.${frac}` : ''}`;
}

/** For display: grouped, with the currency's own decimals (rounded half up). */
export function formatMicros(value: bigint, currency: string): string {
  const decimals = currencyDecimals(currency);
  const step = 10n ** BigInt(MICROS - decimals);
  const rounded = ((value + step / 2n) / step) * step;
  const whole = (rounded / UNIT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (decimals === 0) return whole;
  const frac = (rounded % UNIT).toString().padStart(MICROS, '0').slice(0, decimals);
  return `${whole}.${frac}`;
}

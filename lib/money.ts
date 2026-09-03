/**
 * Money formatting for the clearance system. Every amount carries its ISO
 * code and tabular numerals; the code leads ("USD 5,000.00") so a column of
 * mixed currencies reads unambiguously. Parsing happens on blur, never per
 * keystroke; settlement maths never uses floats (minor units upstream).
 */
const formatters = new Map<string, Intl.NumberFormat>();

const ZERO_DECIMAL = new Set(['IDR', 'VND', 'JPY', 'KRW']);

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

export function formatAmount(currency: string, value: number | string): string {
  const numeric = typeof value === 'string' ? Number.parseFloat(value.replace(/,/g, '')) : value;
  if (!Number.isFinite(numeric)) return '—';
  const code = currency.toUpperCase();
  const digits = currencyDecimals(code);
  const key = `${code}:${digits}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    formatters.set(key, formatter);
  }
  return formatter.format(numeric);
}

/** "USD 5,000.00" — code first, tabular digits, never a bare number. */
export function formatMoney(currency: string, value: number | string): string {
  const amount = formatAmount(currency, value);
  return amount === '—' ? amount : `${currency.toUpperCase()} ${amount}`;
}

/** Compact figure for summary strips: "USD 8.42m", "USD 1,260.00". */
export function formatCompact(currency: string, value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${currency.toUpperCase()} ${(value / 1_000_000).toFixed(2)}m`;
  if (abs >= 100_000) return `${currency.toUpperCase()} ${(value / 1_000).toFixed(1)}k`;
  return formatMoney(currency, value);
}

/** Effective FX line: "1 USD = 56.4200 PHP". */
export function formatRate(from: string, to: string, rate: number | string): string {
  const numeric = typeof rate === 'string' ? Number.parseFloat(rate) : rate;
  if (!Number.isFinite(numeric)) return '—';
  const digits = numeric >= 1000 ? 2 : 4;
  return `1 ${from.toUpperCase()} = ${numeric.toFixed(digits)} ${to.toUpperCase()}`;
}

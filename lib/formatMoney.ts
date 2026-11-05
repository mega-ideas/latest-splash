const moneyFormatters = new Map<string, Intl.NumberFormat>();

/** How many places the currency's minor unit has (formatMoney's own rule). */
export function currencyDecimals(currency: string) {
  return decimalsFor(currency);
}

function decimalsFor(currency: string) {
  const code = currency.toUpperCase();
  if (code === 'JPY' || code === 'KRW' || code === 'VND' || code === 'IDR') return 0;
  return 2;
}

function formatterFor(currency: string) {
  const code = currency.toUpperCase();
  const digits = decimalsFor(code);
  const key = `${code}:${digits}`;
  const existing = moneyFormatters.get(key);
  if (existing) return existing;

  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  moneyFormatters.set(key, formatter);
  return formatter;
}

export function formatMoney(minorUnits: bigint, currency: string) {
  const code = currency.toUpperCase();
  const digits = decimalsFor(code);
  const scale = BigInt(10) ** BigInt(digits);
  const negative = minorUnits < BigInt(0);
  const absolute = negative ? -minorUnits : minorUnits;
  const whole = absolute / scale;
  const fraction = absolute % scale;
  const value = Number(whole) + Number(fraction) / Number(scale);

  return formatterFor(code).format(negative ? -value : value);
}

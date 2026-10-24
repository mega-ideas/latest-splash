/**
 * The payout routes the landing calculator offers (v2 brief D4, D16).
 *
 * Quotable: the Philippines and Indonesia, where a payout partner turns USDC
 * into local currency and pays a bank. The calculator asks the server for
 * that partner's quote (app/api/quotes/preview).
 *
 * Pilot access: Malaysia, Vietnam, Thailand and Singapore. Not live, never
 * "coming soon": choosing one offers a request for access instead of a quote.
 *
 * Client-safe and pure. `decimals` is the currency's minor unit, so a rupiah
 * amount is whole rupiah.
 */

export type QuotableCurrency = 'PHP' | 'IDR';
export type PilotCurrency = 'MYR' | 'VND' | 'THB' | 'SGD';

export type QuotableRoute = {
  currency: QuotableCurrency;
  country: string;
  decimals: number;
  /** When the supplier sees the money, in words that are true today. */
  arrives: string;
  /** Who credits the bank account, by role (lib/partners/signed-partners.ts). */
  partner: 'pdax' | 'durianpay';
};

export type PilotRoute = { currency: PilotCurrency; country: string };

export const QUOTABLE_ROUTES: readonly QuotableRoute[] = Object.freeze([
  { currency: 'PHP', country: 'Philippines', decimals: 2, arrives: 'Minutes to a PH bank', partner: 'pdax' },
  { currency: 'IDR', country: 'Indonesia', decimals: 0, arrives: 'Tracked until the partner confirms', partner: 'durianpay' },
]);

export const PILOT_ROUTES: readonly PilotRoute[] = Object.freeze([
  { currency: 'MYR', country: 'Malaysia' },
  { currency: 'VND', country: 'Vietnam' },
  { currency: 'THB', country: 'Thailand' },
  { currency: 'SGD', country: 'Singapore' },
]);

export function isQuotable(currency: string): currency is QuotableCurrency {
  return QUOTABLE_ROUTES.some((r) => r.currency === currency);
}

export function isPilot(currency: string): currency is PilotCurrency {
  return PILOT_ROUTES.some((r) => r.currency === currency);
}

export function quotableRoute(currency: QuotableCurrency): QuotableRoute {
  const route = QUOTABLE_ROUTES.find((r) => r.currency === currency);
  if (!route) throw new RangeError(`${currency} is not a quotable route`);
  return route;
}

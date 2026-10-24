/**
 * The landing calculator's bank quote: the exchange rate and the payout
 * partner's fee for one amount, from the partner's own quote.
 *
 * Splash's fee is not here. The page renders it from the published schedule
 * (lib/fees/schedule.ts `splashFee`), the same function the chain applies, so
 * nothing about Splash's price depends on this call succeeding.
 *
 * Fails closed. A partner that is not configured answers nothing, and the
 * calculator says the partner fee and the rate are not quoted yet. A sandbox
 * partner's rate is shown only where the runtime is a sandbox
 * (lib/server/runtime-mode.ts `isDemoRuntime`), and labelled one; in
 * production a sandbox answer is treated as no answer, so a made-up rate can
 * never reach a customer.
 *
 * Amounts are USDC minor units (6 decimals) in and the target currency's
 * minor units out, all bigint (lib/money.ts). What the supplier receives is
 * the amount less the partner's fee, at the partner's rate, rounded down:
 * Splash's fee is on top and does not reduce it (lib/server/quote.ts).
 */
import { applyBps, applyRate, parseRate } from '@/lib/money';
import { isQuotable, quotableRoute, type QuotableCurrency } from '@/lib/landing/routes';
import type { PayoutPartnerAdapter } from '@/lib/server/pdax';

export class LandingQuoteRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LandingQuoteRouteError';
  }
}

export type LandingQuote = {
  currency: QuotableCurrency;
  amountMinor: string;
  /** Target currency per USDC, as the partner quoted it; null when not quoted. */
  rate: string | null;
  partnerFee: { minor: string | null; source: string };
  /** What the supplier receives, in the target currency's minor units; null without a rate. */
  receivedMinor: string | null;
  /** How long the rate holds once quoted. */
  ttlSeconds: number;
  /** True when the rate is a sandbox partner's. */
  sandbox: boolean;
};

const USDC_DECIMALS = 6;
export const LANDING_QUOTE_TTL_SECONDS = Number.parseInt(process.env.QUOTE_TTL_SECONDS ?? '30', 10);

export async function landingQuote(
  input: { currency: string; amountMinor: bigint },
  deps: { adapter: PayoutPartnerAdapter; sandbox: boolean; sandboxAllowed: boolean; partnerLabel: string },
): Promise<LandingQuote> {
  if (!isQuotable(input.currency)) {
    throw new LandingQuoteRouteError(`${input.currency} is not quoted on the landing: it is under pilot access, or not a route.`);
  }
  if (typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n) throw new RangeError('a quote needs a positive amount');
  const route = quotableRoute(input.currency);
  const who = deps.partnerLabel.charAt(0).toUpperCase() + deps.partnerLabel.slice(1);
  const none = (source: string): LandingQuote => ({
    currency: route.currency,
    amountMinor: input.amountMinor.toString(),
    rate: null,
    partnerFee: { minor: null, source },
    receivedMinor: null,
    ttlSeconds: LANDING_QUOTE_TTL_SECONDS,
    sandbox: false,
  });

  if (deps.sandbox && !deps.sandboxAllowed) return none('Not quoted yet');

  let quoted: { fxRate: string; partnerFeeBps: number };
  try {
    const usdcMicro = input.amountMinor;
    quoted = await deps.adapter.quote(route.currency, Number(usdcMicro));
  } catch {
    return none('Not quoted yet');
  }
  const bps = quoted.partnerFeeBps;
  let rate;
  try {
    rate = parseRate(quoted.fxRate);
  } catch {
    return none('Not quoted yet');
  }
  if (!Number.isInteger(bps) || bps < 0 || !/^\d+(\.\d+)?$/.test(quoted.fxRate) || !/[1-9]/.test(quoted.fxRate)) return none('Not quoted yet');

  const partnerMinor = applyBps(input.amountMinor, bps, 'floor');
  const converted = input.amountMinor - partnerMinor;
  const received = converted > 0n ? applyRate(converted, rate, 'floor', USDC_DECIMALS, route.decimals) : 0n;
  return {
    currency: route.currency,
    amountMinor: input.amountMinor.toString(),
    rate: quoted.fxRate,
    partnerFee: { minor: partnerMinor.toString(), source: `${who}, ${deps.sandbox ? 'sandbox quote' : 'live quote'}` },
    receivedMinor: received.toString(),
    ttlSeconds: LANDING_QUOTE_TTL_SECONDS,
    sandbox: deps.sandbox,
  };
}

/**
 * The landing calculator's bank quote: the exchange rate, the payout
 * partner's fee and what the bank receives, for one amount, from the
 * partner's own quote.
 *
 * It asks the ONE payout-partner interface (lib/payouts/partner.ts `quote`),
 * the same one a payment uses, so the landing never shows a number a payment
 * could not get. The partner arrives as a function: one that is switched off,
 * not built, or refused for want of credentials refuses inside the quote.
 *
 * Splash's fee is not here. The page renders it from the published schedule
 * (lib/fees/schedule.ts `splashFee`), the same function the chain applies, so
 * nothing about Splash's price depends on this call succeeding.
 *
 * Fails closed. A partner that cannot quote answers nothing, and the
 * calculator says the partner fee and the rate are not quoted yet. A sandbox
 * quote is shown only where the runtime is a sandbox
 * (lib/server/runtime-mode.ts `isDemoRuntime`), and labelled one. In
 * production the registry hands out the live adapter, which refuses, so no
 * sandbox rate can reach a customer however the flags are set.
 *
 * Amounts are USDC minor units (6 decimals) in and the target currency's
 * minor units out, all bigint (lib/money.ts). `receivedMinor` is the
 * partner's own figure for what the bank receives after its fees. The partner
 * fee is shown in USDC (the calculator's unit): the USDC the partner's fees
 * come to at its quoted rate, rounded up, so the lines add back to the amount
 * and the fee is never shown smaller than the partner's. It is the partner's
 * fee as quoted, never marked up.
 */
import { isQuotable, quotableRoute, type QuotableCurrency } from '@/lib/landing/routes';
import type { PayoutPartner } from '@/lib/payouts/partner';

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
  /** What the bank receives, in the target currency's minor units; null without a rate. */
  receivedMinor: string | null;
  /** How long the rate holds once quoted. */
  ttlSeconds: number;
  /** True when the rate is a sandbox partner's. */
  sandbox: boolean;
};

const USDC_DECIMALS = 6;
const RATE_SCALE = 1_000_000n;
export const LANDING_QUOTE_TTL_SECONDS = Number.parseInt(process.env.QUOTE_TTL_SECONDS ?? '30', 10);

/** A rate in millionths as a decimal string: 56_500_000 is "56.5", 16_250_000_000 is "16250". */
function rateString(rateMicro: bigint): string {
  const whole = rateMicro / RATE_SCALE;
  const fraction = (rateMicro % RATE_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function landingQuote(
  input: { currency: string; amountMinor: bigint },
  deps: {
    /** The payout partner for the route; may throw when the route is off or not built. */
    partner: () => Pick<PayoutPartner, 'quote'>;
    sandboxAllowed: boolean;
    partnerLabel: string;
    now?: Date;
  },
): Promise<LandingQuote> {
  if (!isQuotable(input.currency)) {
    throw new LandingQuoteRouteError(`${input.currency} is not quoted on the landing: it is under pilot access, or not a route.`);
  }
  if (typeof input.amountMinor !== 'bigint' || input.amountMinor <= 0n) throw new RangeError('a quote needs a positive amount');
  const route = quotableRoute(input.currency);
  const who = deps.partnerLabel.charAt(0).toUpperCase() + deps.partnerLabel.slice(1);
  const now = deps.now ?? new Date();
  const none = (source: string): LandingQuote => ({
    currency: route.currency,
    amountMinor: input.amountMinor.toString(),
    rate: null,
    partnerFee: { minor: null, source },
    receivedMinor: null,
    ttlSeconds: LANDING_QUOTE_TTL_SECONDS,
    sandbox: false,
  });

  let quoted;
  try {
    quoted = await deps.partner().quote({ currency: route.currency, sendMinor: input.amountMinor, now });
  } catch {
    return none('Not quoted yet');
  }
  if (quoted.sandbox && !deps.sandboxAllowed) return none('Not quoted yet');
  // A quote for another amount or currency, or without a usable rate, is no quote.
  if (
    quoted.currency !== route.currency ||
    quoted.sendMinor !== input.amountMinor ||
    typeof quoted.rateMicro !== 'bigint' ||
    quoted.rateMicro <= 0n ||
    typeof quoted.receiveMinor !== 'bigint' ||
    quoted.receiveMinor < 0n
  ) {
    return none('Not quoted yet');
  }
  const heldMs = quoted.expiresAt.getTime() - now.getTime();
  if (!Number.isFinite(heldMs) || heldMs < 1000) return none('Not quoted yet');

  // The USDC the bank's amount is worth at the quoted rate, rounded down; the partner fee is the rest.
  const convertedUsdc = (quoted.receiveMinor * 10n ** BigInt(USDC_DECIMALS - route.decimals) * RATE_SCALE) / quoted.rateMicro;
  const feeUsdc = input.amountMinor > convertedUsdc ? input.amountMinor - convertedUsdc : 0n;
  return {
    currency: route.currency,
    amountMinor: input.amountMinor.toString(),
    rate: rateString(quoted.rateMicro),
    partnerFee: { minor: feeUsdc.toString(), source: `${who}, ${quoted.sandbox ? 'sandbox quote' : 'live quote'}` },
    receivedMinor: quoted.receiveMinor.toString(),
    ttlSeconds: Math.min(LANDING_QUOTE_TTL_SECONDS, Math.floor(heldMs / 1000)),
    sandbox: quoted.sandbox,
  };
}

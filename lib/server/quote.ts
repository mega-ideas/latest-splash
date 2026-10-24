import { randomUUID } from 'crypto';

import { getUsdCorridorByCurrency } from '@/lib/fx/corridors';
import { applyBps, applyRate, formatMinor, parseRate } from '@/lib/money';
import { quoteDiscountBps, quoteFeeState, type FeeScheduleSource } from '@/lib/fees/fee-config';
import { buildFeeQuote, feeQuoteToWire, type FeeQuoteWire, type ThirdPartyFee } from '@/lib/fees/quote';
import { FEE_KIND } from '@/lib/fees/schedule';
import { getCachedJson, setCachedJson } from '@/lib/server/redis-cache';
import { evaluateTransferLimits, type LimitResult } from '@/lib/server/limits';
import { pdaxAdapter, mockPdaxAdapter } from '@/lib/server/pdax';
import { labelFor } from '@/lib/server/signed-partners';
import type { FundingFeeTier } from '@/lib/funding/registry';

/**
 * The quote for a local-currency payout (Amendment A1 §4).
 *
 * A payout to a supplier's bank in local currency goes to the payout
 * partner's deposit address, so on chain it is a BANK_PAYOUT: Splash's fee is
 * the bank schedule's, on the principal, from lib/fees/schedule.ts under the
 * FeeConfig in force (lib/fees/fee-config.ts `quoteFeeState`), and charged on
 * top. The partner's fee is the partner's, from its own quote, and comes out
 * of what it pays out; Splash neither collects nor marks it up. There is no
 * flat rate, no fixed fee and no funding-source discount any more: a
 * business's discount lives in FeeConfig.
 *
 * The principal is the amount entered, in USD cents, as USDC minor units
 * (one cent is 10,000 minor units; the funding rails deliver USDC one to one).
 *
 * The response is A1 §4's shape, at the top level: `splashFee`,
 * `partnerFee`, `totalDebitMinor` and `maxFeeMinor`, every amount a decimal
 * string of USDC minor units. The review screen shows it and sends
 * `maxFeeMinor` back with the payment, which bounds what the payment may be
 * charged.
 *
 * Throws FeeConfigUnavailableError when the fee cannot be read (the route
 * answers 503): no fee is shown and no payment is built on a guess.
 */

const QUOTE_TTL_SECONDS = Number.parseInt(process.env.QUOTE_TTL_SECONDS ?? '30', 10);
const CENT_IN_USDC_MINOR = 10_000n;

const fallbackRates: Record<string, number> = {
  USD: 1,
  PHP: 56.42,
  MYR: 4.71,
  IDR: 16284,
  VND: 25385,
  THB: 35.82,
  SGD: 1.345,
  EUR: 0.924,
  GBP: 0.789,
};

export type QuoteData = FeeQuoteWire & {
  quoteId: string;
  /** The amount entered, in USD cents: the principal. */
  fromAmount: number;
  /** What the supplier receives, in the target currency. */
  toAmount: number;
  exchangeRate: string;
  expiresAt: string;
  ttl: number;
  recipientId?: string;
  targetCurrency: string;
  /** Where the exchange rate came from. */
  source: 'corridor' | 'fallback';
  /** Where Splash's fee schedule came from: the live FeeConfig, or A1's launch schedule off mainnet. */
  scheduleSource: FeeScheduleSource;
  feeTier: FundingFeeTier;
  /** Rail + KYB-tier + AML evaluation (no MYR monthly cap). */
  limit: LimitResult;
};

export async function getLiveUsdToTargetRate(targetCurrency = 'PHP'): Promise<{ rate: number; source: 'corridor' | 'fallback' }> {
  const normalized = targetCurrency.toUpperCase();
  const cacheKey = `fx:usd:${normalized}`;

  if (normalized === 'USD') return { rate: 1, source: 'fallback' };

  const cached = await getCachedJson<{ rate: number; source: 'corridor' | 'fallback' }>(cacheKey);
  if (cached && Number.isFinite(cached.rate) && cached.rate > 0) return cached;

  try {
    const rate = getUsdCorridorByCurrency(normalized)?.rate ?? fallbackRates[normalized];

    if (Number.isFinite(rate) && rate > 0) {
      const live = { rate, source: 'corridor' as const };
      await setCachedJson(cacheKey, live, 20);

      return live;
    }
  } catch {
  }

  const fallback = { rate: fallbackRates[normalized] ?? fallbackRates.PHP, source: 'fallback' as const };
  await setCachedJson(cacheKey, fallback, 20);

  return fallback;
}

/**
 * The payout partner's fee on `principalMinor`, from the partner's own
 * quote. PHP is the only corridor with a partner adapter today; elsewhere
 * there is no quote, and the line says the partner quotes at payout.
 */
async function partnerFeeFor(targetCurrency: string, principalMinor: bigint): Promise<ThirdPartyFee> {
  if (targetCurrency !== 'PHP') {
    return { minor: null, source: 'Quoted by the payout partner when this corridor opens' };
  }
  const label = labelFor('pdax');
  const who = label.charAt(0).toUpperCase() + label.slice(1);
  try {
    const quote = await pdaxAdapter.quote(targetCurrency, Number(principalMinor));
    const bps = quote.partnerFeeBps;
    if (!Number.isInteger(bps) || bps < 0) throw new Error('the partner quoted no fee');
    const sandbox = pdaxAdapter === mockPdaxAdapter;
    return { minor: applyBps(principalMinor, bps, 'floor'), source: `${who}, ${sandbox ? 'sandbox quote' : 'live quote'}` };
  } catch {
    return { minor: null, source: `${who} quotes its fee at payout` };
  }
}

export async function calculateQuote(
  fromAmountCents: number,
  recipientId?: string,
  targetCurrency = 'PHP',
  feeTier: FundingFeeTier = 'STANDARD',
  options: { businessId?: string | null } = {},
): Promise<QuoteData> {
  if (!Number.isSafeInteger(fromAmountCents) || fromAmountCents <= 0) throw new RangeError('a quote needs a positive whole number of cents');
  const currency = targetCurrency.toUpperCase();
  const principalMinor = BigInt(fromAmountCents) * CENT_IN_USDC_MINOR;

  const state = await quoteFeeState();
  const discountBps = await quoteDiscountBps(state, options.businessId);
  const { rate, source } = await getLiveUsdToTargetRate(currency);
  const partnerFee = await partnerFeeFor(currency, principalMinor);

  const fees = buildFeeQuote({ kind: FEE_KIND.BANK_PAYOUT, principalMinor, discountBps, state, partnerFee });

  // What the supplier receives: the principal, less the partner's own fee,
  // at the corridor rate. Splash's fee is on top and does not reduce it.
  const convertedMinor = principalMinor - (partnerFee.minor ?? 0n);
  const targetMinor = convertedMinor > 0n ? applyRate(convertedMinor, parseRate(rate), 'floor', 6, 2) : 0n;
  const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();

  // Limits: rail max + KYB-tier cap + AML review threshold. No MYR monthly cap.
  const limit = evaluateTransferLimits({ amountUsd: fromAmountCents / 100 });

  return {
    ...feeQuoteToWire(fees),
    quoteId: randomUUID(),
    fromAmount: fromAmountCents,
    toAmount: Number(formatMinor(targetMinor, 2)),
    exchangeRate: rate.toFixed(4),
    expiresAt,
    ttl: QUOTE_TTL_SECONDS,
    recipientId,
    targetCurrency: currency,
    source,
    scheduleSource: state.source,
    feeTier,
    limit,
  };
}

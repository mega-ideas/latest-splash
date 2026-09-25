import { randomUUID } from 'crypto';

import {
  CONTRACT_MAX_FEE_BPS,
  FALLBACK_FEE_BPS,
  getCorridorFeeBps,
  getUsdCorridorByCurrency,
} from '@/lib/fx/corridors';
import { getCachedJson, setCachedJson } from '@/lib/server/redis-cache';
import { evaluateTransferLimits, type LimitResult } from '@/lib/server/limits';
import type { FundingFeeTier } from '@/lib/funding/registry';

/**
 * Default platform fee — used as a floor only when corridor-specific fee
 * isn't known. Per-corridor fees come from lib/fx/corridors.ts so the
 * quote engine and the smart contract agree on what the user is charged.
 * Clamped to CONTRACT_MAX_FEE_BPS so the contract will never reject.
 */
const DEFAULT_PLATFORM_FEE_BPS = Math.min(
  Number.parseInt(process.env.PLATFORM_FEE_BPS ?? String(FALLBACK_FEE_BPS), 10),
  CONTRACT_MAX_FEE_BPS,
);
// No fixed fee since 2026-09-26: local-currency payouts are 0.70% of the amount, nothing more.
const FIXED_FEE_CENTS = Number.parseInt(process.env.FIXED_FEE_CENTS ?? '0', 10);
const QUOTE_TTL_SECONDS = Number.parseInt(process.env.QUOTE_TTL_SECONDS ?? '30', 10);

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

export type QuoteData = {
  quoteId: string;
  fromAmount: number;
  toAmount: number;
  exchangeRate: string;
  platformFee: number;
  /** Effective fee in basis points actually applied to this quote. */
  feeBps: number;
  networkFee: number;
  fixedFee: number;
  expiresAt: string;
  ttl: number;
  recipientId?: string;
  targetCurrency: string;
  source: 'corridor' | 'fallback';
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

export async function calculateQuote(
  fromAmountCents: number,
  recipientId?: string,
  targetCurrency = 'PHP',
  feeTier: FundingFeeTier = 'STANDARD',
): Promise<QuoteData> {
  const { rate, source } = await getLiveUsdToTargetRate(targetCurrency);
  // Per-corridor fee from the single source of truth. Already clamped to
  // CONTRACT_MAX_FEE_BPS in getCorridorFeeBps, so it will pass the
  // settlement.move E_FEE_EXCEEDED assertion every time.
  const corridorFeeBps = source === 'corridor'
    ? getCorridorFeeBps(targetCurrency)
    : DEFAULT_PLATFORM_FEE_BPS;
  // The DISCOUNT tier (payouts funded from held USDC) is priced like every
  // other since 2026-09-26: 0.70% flat. The tier label stays — it is part of
  // the funding record and of approvals already given — and the discount is 0.
  const discountBps = feeTier === 'DISCOUNT'
    ? Math.max(0, Number.parseInt(process.env.FUNDING_DISCOUNT_BPS ?? '0', 10) || 0)
    : 0;
  const appliedFeeBps = Math.max(0, corridorFeeBps - discountBps);
  const percentageFee = Math.floor((fromAmountCents * appliedFeeBps) / 10_000);
  const platformFee = percentageFee + FIXED_FEE_CENTS;
  const netCents = Math.max(fromAmountCents - platformFee, 0);
  const toAmount = Math.floor((netCents / 100) * rate * 100) / 100;
  const expiresAt = new Date(Date.now() + QUOTE_TTL_SECONDS * 1000).toISOString();

  // Limits: rail max + KYB-tier cap + AML review threshold. No MYR monthly cap.
  const limit = evaluateTransferLimits({ amountUsd: fromAmountCents / 100 });

  return {
    quoteId: randomUUID(),
    fromAmount: fromAmountCents,
    toAmount,
    exchangeRate: rate.toFixed(4),
    platformFee,
    feeBps: appliedFeeBps,
    networkFee: 0,
    fixedFee: FIXED_FEE_CENTS,
    expiresAt,
    ttl: QUOTE_TTL_SECONDS,
    recipientId,
    targetCurrency: targetCurrency.toUpperCase(),
    source,
    feeTier,
    limit,
  };
}

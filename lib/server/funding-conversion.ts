/**
 * USDT (bridged) and USDsui that arrive in the business wallet become USDC,
 * the one payment asset (D6). The rate is shown first, as a quote, and the
 * peg guard refuses the swap while the coin is off its peg.
 *
 * The peg guard. A conversion sells the coin for USDC on its own DeepBook
 * pool (USDT_USDC, USDSUI_USDC), so the peg that matters is that pool's:
 * lib/server/deepbook.ts getDeepbookPairBook reads exactly that book. The
 * tolerance is splash_core::peg_monitor's own, MAX_DEVIATION_PPM = 3,000 ppm
 * (30 bps), mirrored here so the off-chain refusal is the on-chain one. Both
 * the mid and the bid the swap would actually take must be within it. No
 * reading, a book too wide to read, or a stale quote refuses. peg_monitor's
 * on-chain PegState is not consulted: no v2 path pushes it (there is no
 * dollar oracle, lib/server/peg-attestation.ts), so it is stale by design and
 * would refuse everything; the refusal it encodes is applied here instead.
 *
 * What it does not do yet: sign. The swap runs in the business's own wallet,
 * so its quorum signs it, and the signing request needs a DeepBook swap
 * command that the transaction reader (lib/wallet/wallet-tx-describe.ts)
 * does not understand yet. Until it does, `executeConversion` refuses, and a
 * USDT or USDsui deposit stays as it arrived: nothing moves, nothing is lost.
 */

import { createHash } from 'node:crypto';

import { formatRate, type Rate } from '../money.ts';
import { getDeepbookPairBook, type DeepbookPairBook } from './deepbook.ts';

export type ConvertibleAsset = 'USDT' | 'USDSUI';

export const CONVERSION_POOLS: Record<ConvertibleAsset, string> = { USDT: 'USDT_USDC', USDSUI: 'USDSUI_USDC' };

/** splash_core::peg_monitor::MAX_DEVIATION_PPM (3,000 ppm) in basis points. */
export const CONVERSION_PEG_TOLERANCE_BPS = 30n;
export const MAX_CONVERSION_SLIPPAGE_BPS = 50;
const QUOTE_TTL_MS = 5 * 60 * 1000;

export type ConversionQuote = {
  asset: ConvertibleAsset;
  pool: string;
  amountInMinor: bigint;
  /** The bid the swap sells into, as a decimal string. */
  rate: string;
  estimatedOutMinor: bigint;
  /** The swap reverts below this: nothing converts at a worse rate. */
  minOutMinor: bigint;
  slippageBps: number;
  pegDeviationBps: bigint;
  source: DeepbookPairBook['source'];
  quoteRef: string;
  expiresAt: Date;
};

export type ConversionRefusal = { ok: false; status: number; code: 'peg_unverified' | 'off_peg' | 'bad_conversion' | 'quote_expired' | 'conversion_not_built'; error: string };

export type BookReader = (pair: string) => Promise<DeepbookPairBook | null>;

function bpsFromOne(rate: Rate): bigint {
  const ONE = 10n ** BigInt(rate.scale);
  const drift = rate.scaled > ONE ? rate.scaled - ONE : ONE - rate.scaled;
  return (drift * 10_000n + ONE / 2n) / ONE;
}

/**
 * Quote converting `amountInMinor` (6 decimals, as USDT and USDsui on Sui
 * have) into USDC, or refuse. Never returns a quote on a peg it did not read.
 */
export async function quoteConversion(
  input: { asset: ConvertibleAsset; amountInMinor: bigint; slippageBps?: number; now?: Date },
  read: BookReader = (pair) => getDeepbookPairBook(pair),
): Promise<{ ok: true; quote: ConversionQuote } | ConversionRefusal> {
  const slippageBps = input.slippageBps ?? 10;
  if (!(input.asset in CONVERSION_POOLS)) return { ok: false, status: 400, code: 'bad_conversion', error: 'Only USDT and USDsui are converted to USDC.' };
  if (input.amountInMinor <= 0n) return { ok: false, status: 400, code: 'bad_conversion', error: 'The amount must be more than zero.' };
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_CONVERSION_SLIPPAGE_BPS) {
    return { ok: false, status: 400, code: 'bad_conversion', error: `Slippage must be 0 to ${MAX_CONVERSION_SLIPPAGE_BPS / 100}%.` };
  }
  const pool = CONVERSION_POOLS[input.asset];
  const book = await read(pool);
  if (!book) {
    return { ok: false, status: 503, code: 'peg_unverified', error: `No live price for ${input.asset} against USDC right now, so nothing is converted. Try again shortly.` };
  }
  const bidDeviation = bpsFromOne(book.bid);
  if (book.deviationBps > CONVERSION_PEG_TOLERANCE_BPS || bidDeviation > CONVERSION_PEG_TOLERANCE_BPS) {
    return {
      ok: false,
      status: 409,
      code: 'off_peg',
      error: `${input.asset} is off its peg (${book.deviationBps > bidDeviation ? book.deviationBps : bidDeviation} bps from USDC), so it is not converted. It stays in your wallet as it is.`,
    };
  }
  const now = input.now ?? new Date();
  const ONE = 10n ** BigInt(book.bid.scale);
  const estimatedOutMinor = (input.amountInMinor * book.bid.scaled) / ONE;
  const minOutMinor = (estimatedOutMinor * BigInt(10_000 - slippageBps)) / 10_000n;
  return {
    ok: true,
    quote: {
      asset: input.asset,
      pool,
      amountInMinor: input.amountInMinor,
      rate: formatRate(book.bid),
      estimatedOutMinor,
      minOutMinor,
      slippageBps,
      pegDeviationBps: book.deviationBps,
      source: book.source,
      quoteRef: `cq_${createHash('sha256').update(`${pool}:${input.amountInMinor}:${book.bid.scaled}:${now.getTime()}`).digest('hex').slice(0, 24)}`,
      expiresAt: new Date(now.getTime() + QUOTE_TTL_MS),
    },
  };
}

/**
 * Run an accepted conversion quote. Refuses a stale quote (never refreshed
 * silently at a worse rate) and then, today, refuses to build: see the
 * header.
 */
export async function executeConversion(quote: Pick<ConversionQuote, 'expiresAt'>, now: Date = new Date()): Promise<ConversionRefusal> {
  if (quote.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, status: 409, code: 'quote_expired', error: 'That rate has expired. Ask for a new quote.' };
  }
  return {
    ok: false,
    status: 501,
    code: 'conversion_not_built',
    error: 'Converting in your wallet needs your signers to approve a swap, and that request is not available yet. Nothing was converted.',
  };
}

import { rateToNumber } from '../money.ts';
import { getDeepbookStablePrice } from './deepbook.ts';

/**
 * Stablecoin peg health, from DeepBook V3 alone.
 *
 * DeepBook is Sui's on-chain order book, read through Mysten's public
 * indexer: free, no key, and the prices are ones the market would actually
 * trade at. It used to be the first of two sources, with Pyth second. Pyth's
 * Hermes has needed a paid data-plan key since 26 August 2026, and Splash
 * chose not to pay for one, so DeepBook decides on its own.
 *
 * What it measures: USDC against another dollar stablecoin, on the
 * most-traded listed book with a usable spread (lib/server/deepbook.ts). That
 * catches USDC drifting from the others. It cannot see every dollar
 * stablecoin drifting from the dollar together; nothing on Sui prices in
 * dollars without an oracle.
 *
 * No reading means not pegged. A peg nobody measured is not a peg anyone may
 * settle on.
 */

export interface DeepbookPeg {
  pair: string;
  midPrice: number;
  deviationBps: number;
  pegged: boolean;
  source: 'deepbook' | 'mock';
}

export interface PegStatus {
  pegged: boolean;
  /** 'deepbook' when DeepBook answered; 'none' when it did not, and then `pegged` is false. */
  primary: 'deepbook' | 'none';
  deepbook: DeepbookPeg | null;
}

/** Beyond this mid-price drift the peg counts as broken. DEEPBOOK_PEG_TOLERANCE_BPS, default 100. */
function toleranceBps(env: NodeJS.ProcessEnv): bigint {
  const raw = Number(env.DEEPBOOK_PEG_TOLERANCE_BPS ?? 100);
  return BigInt(Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 100);
}

export async function getPegStatus(env: NodeJS.ProcessEnv = process.env): Promise<PegStatus> {
  const book = await getDeepbookStablePrice(env);
  if (!book) return { pegged: false, primary: 'none', deepbook: null };
  const pegged = book.deviationBps <= toleranceBps(env);
  return {
    pegged,
    primary: 'deepbook',
    deepbook: {
      pair: book.pair,
      midPrice: rateToNumber(book.midPrice),
      deviationBps: Number(book.deviationBps),
      pegged,
      source: book.source,
    },
  };
}

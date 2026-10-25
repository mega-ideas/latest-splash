/**
 * The two outside connections Treasury needs (v2 D9, brief 5.7), each behind
 * an adapter with a sandbox implementation that is never reachable in
 * production (lib/server/runtime-mode.ts).
 *
 *   Swap route     hands a swap or redemption from the business wallet to
 *                  the wallet's signers. The live route needs the Phase 2
 *                  wallet signing service to accept a Sui DEX swap, which it
 *                  does not yet (lib/wallet/wallet-tx-describe.ts refuses
 *                  foreign packages and every asset but USDC). So in
 *                  production there is no live route in this build, and the
 *                  adapter says so instead of returning a stand-in.
 *
 *   Fund holding   reads the business's holding at the fund manager,
 *                  read-only, by the account reference it linked. There is
 *                  no contracted holdings API yet, so in production nothing
 *                  is read and no figure is shown.
 *
 * Sandbox results are marked `sandbox: true` all the way to the page, which
 * labels them, and they exist only outside production.
 */
import { isProductionRuntime } from './runtime-mode.ts';
import type { TreasuryOrder } from './treasury-wallet-orders.ts';

export type Unavailable = { ok: false; status: number; error: string };

export interface TreasurySwapRoute {
  kind: 'sandbox' | 'live';
  /** Ask the wallet's signers to sign this order. Returns the route's reference for it. */
  prepare(order: TreasuryOrder): Promise<{ providerRef: string }>;
}

const SANDBOX_SWAP_ROUTE: TreasurySwapRoute = {
  kind: 'sandbox',
  async prepare(order) {
    return { providerRef: `sandbox_${order.id}` };
  },
};

export function resolveTreasurySwapRoute(env: NodeJS.ProcessEnv = process.env): { ok: true; route: TreasurySwapRoute } | Unavailable {
  if (env.TREASURY_WALLET_SWAPS !== 'true') {
    return {
      ok: false,
      status: 503,
      error: 'Swaps from the business wallet are not switched on on this server. Quotes still work; nothing is sent to your signers.',
    };
  }
  if (isProductionRuntime(env)) {
    return {
      ok: false,
      status: 503,
      error: 'This server has no live swap route for the business wallet yet, so nothing is sent to your signers.',
    };
  }
  return { ok: true, route: SANDBOX_SWAP_ROUTE };
}

export type FundHolding = {
  reference: string;
  /** What the fund manager reports, in its currency. Strings: no float ever carries money. */
  units: string;
  value: string;
  currency: string;
  asOf: string;
  sandbox: boolean;
};

export interface FundHoldingSource {
  kind: 'sandbox' | 'live';
  read(reference: string): Promise<{ ok: true; holding: FundHolding } | Unavailable>;
}

const SANDBOX_FUND_SOURCE: FundHoldingSource = {
  kind: 'sandbox',
  async read(reference) {
    return {
      ok: true,
      holding: { reference, units: '1000.0000', value: '1032.40', currency: 'MYR', asOf: new Date().toISOString(), sandbox: true },
    };
  },
};

export function resolveFundHoldingSource(env: NodeJS.ProcessEnv = process.env): { ok: true; source: FundHoldingSource } | Unavailable {
  if (isProductionRuntime(env)) {
    return { ok: false, status: 503, error: 'Holdings from the fund manager are not connected on this server, so no holding is shown.' };
  }
  return { ok: true, source: SANDBOX_FUND_SOURCE };
}

/** The referral link, https only. Null when not set up: the page then shows no link. */
export function fundReferralUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.FUND_REFERRAL_URL ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function treasuryFlags(env: NodeJS.ProcessEnv = process.env) {
  return {
    walletSwaps: env.TREASURY_WALLET_SWAPS === 'true',
    fundReferral: env.FEATURE_FUND_REFERRAL === 'true',
    tokenizedStocks: env.FEATURE_ONDO_STOCKS === 'true',
    issuerEligibilityConfirmed: env.USDY_ONDO_ELIGIBILITY_CONFIRMED === 'true',
  };
}

/**
 * Non-USDC tokens on other chains, routed to USDC on Sui at the business
 * wallet by Li.Fi or deBridge (v2 §4.3, D7). The quote comes first: the
 * business sees what arrives, the least that may arrive and each route's own
 * fee before it sends anything.
 *
 * The route sends USDC to the wallet: `toAddress` is the wallet the
 * BusinessAccount names on chain, set by the server. A quote for any other
 * destination is never made.
 *
 * Sandbox outside production; in production, without a key the route
 * refuses (`route_not_configured`), and with one it still refuses
 * (`route_not_connected`): neither route's API is wired yet, and a guessed
 * integration would be a fabricated quote.
 *
 * USDT is a dollar stablecoin whose swap the peg guard watches
 * (lib/server/funding-conversion.ts): a USDT route is quoted only while
 * USDT is on its peg.
 */

import { createHash } from 'node:crypto';

import { isProductionRuntime } from '../server/runtime-mode.ts';
import type { FeeLine } from './providers.ts';

export const SWAP_ROUTE_IDS = ['lifi', 'debridge'] as const;
export type SwapRouteId = (typeof SWAP_ROUTE_IDS)[number];

export function isSwapRouteId(value: unknown): value is SwapRouteId {
  return typeof value === 'string' && (SWAP_ROUTE_IDS as readonly string[]).includes(value);
}

export type SwapQuote = {
  route: SwapRouteId;
  fromChain: string;
  fromToken: string;
  fromDecimals: number;
  amountIn: bigint;
  toChain: 'SUI';
  toAsset: 'USDC';
  toAddress: string;
  /** USDC (minor units) the route expects to deliver. */
  estimatedOutMinor: bigint;
  /** The least it may deliver: below this the route reverts and nothing moves. */
  minOutMinor: bigint;
  slippageBps: number;
  lines: FeeLine[];
  quoteRef: string;
  expiresAt: Date;
  sandbox: boolean;
};

export class SwapRouteUnavailable extends Error {
  readonly code: 'route_not_configured' | 'route_not_connected' | 'route_disabled' | 'bad_swap';
  readonly status: number;
  constructor(message: string, code: SwapRouteUnavailable['code'], status = 503) {
    super(message);
    this.name = 'SwapRouteUnavailable';
    this.code = code;
    this.status = status;
  }
}

export interface SwapRouteAdapter {
  id: SwapRouteId;
  mode: 'sandbox' | 'live';
  quote(input: { fromChain: string; fromToken: string; fromDecimals: number; amountIn: bigint; toAddress: string; slippageBps: number; now: Date }): Promise<SwapQuote>;
}

const ROUTES: Record<SwapRouteId, { label: string; credential: string; enabledFlag: string }> = {
  lifi: { label: 'Li.Fi', credential: 'LIFI_API_KEY', enabledFlag: 'FUNDING_SWAP_LIFI_ENABLED' },
  debridge: { label: 'deBridge', credential: 'DEBRIDGE_API_KEY', enabledFlag: 'FUNDING_SWAP_DEBRIDGE_ENABLED' },
};

export function swapRouteLabel(id: SwapRouteId): string {
  return ROUTES[id].label;
}

export function swapRouteEnabled(id: SwapRouteId, env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[ROUTES[id].enabledFlag] ?? '').trim().toLowerCase();
  return v === '' ? true : v === 'true';
}

/** Tokens that are themselves USDC are not swapped: they go by CCTP or straight to the wallet. */
export function isUsdcSymbol(token: string): boolean {
  return /^usdc(\.e)?$/i.test(token.trim());
}

export const MAX_SWAP_SLIPPAGE_BPS = 300;
const QUOTE_TTL_MS = 2 * 60 * 1000;
/** The sandbox's fixed route fee, 0.50 USDC. A sandbox number. */
const SANDBOX_ROUTE_FEE_MINOR = 500_000n;

function validate(input: { fromToken: string; fromDecimals: number; amountIn: bigint; slippageBps: number }) {
  if (isUsdcSymbol(input.fromToken)) throw new SwapRouteUnavailable('USDC needs no swap: send it by CCTP or straight to the wallet.', 'bad_swap', 400);
  if (!/^[A-Za-z0-9.]{2,12}$/.test(input.fromToken)) throw new SwapRouteUnavailable('That token symbol is not valid.', 'bad_swap', 400);
  if (!Number.isInteger(input.fromDecimals) || input.fromDecimals < 0 || input.fromDecimals > 24) throw new SwapRouteUnavailable('Token decimals must be 0 to 24.', 'bad_swap', 400);
  if (input.amountIn <= 0n) throw new SwapRouteUnavailable('The amount must be more than zero.', 'bad_swap', 400);
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps > MAX_SWAP_SLIPPAGE_BPS) {
    throw new SwapRouteUnavailable(`Slippage must be 0 to ${MAX_SWAP_SLIPPAGE_BPS / 100}%.`, 'bad_swap', 400);
  }
}

function sandboxRoute(id: SwapRouteId): SwapRouteAdapter {
  return {
    id,
    mode: 'sandbox',
    async quote(input) {
      validate(input);
      // The sandbox prices every token at one dollar, rescaled to USDC's 6 decimals.
      const scaled = input.fromDecimals >= 6 ? input.amountIn / 10n ** BigInt(input.fromDecimals - 6) : input.amountIn * 10n ** BigInt(6 - input.fromDecimals);
      const fee = SANDBOX_ROUTE_FEE_MINOR;
      if (scaled <= fee) throw new SwapRouteUnavailable('That amount does not cover the route’s fee.', 'bad_swap', 400);
      const estimatedOutMinor = scaled - fee;
      const minOutMinor = (estimatedOutMinor * BigInt(10_000 - input.slippageBps)) / 10_000n;
      return {
        route: id,
        fromChain: input.fromChain,
        fromToken: input.fromToken.toUpperCase(),
        fromDecimals: input.fromDecimals,
        amountIn: input.amountIn,
        toChain: 'SUI',
        toAsset: 'USDC',
        toAddress: input.toAddress,
        estimatedOutMinor,
        minOutMinor,
        slippageBps: input.slippageBps,
        lines: [{ payee: 'route', label: `${ROUTES[id].label} route fee (sandbox)`, amountMinor: fee }],
        quoteRef: `sbs_${createHash('sha256').update(`${id}:${input.fromChain}:${input.fromToken}:${input.amountIn}:${input.toAddress}:${input.now.getTime()}`).digest('hex').slice(0, 24)}`,
        expiresAt: new Date(input.now.getTime() + QUOTE_TTL_MS),
        sandbox: true,
      };
    },
  };
}

function liveRoute(id: SwapRouteId, env: NodeJS.ProcessEnv): SwapRouteAdapter {
  return {
    id,
    mode: 'live',
    async quote() {
      if (!(env[ROUTES[id].credential] ?? '').trim()) {
        throw new SwapRouteUnavailable(`${ROUTES[id].label} is not set up on this server. No quote was made.`, 'route_not_configured');
      }
      throw new SwapRouteUnavailable(`${ROUTES[id].label} is not connected yet. No quote was made.`, 'route_not_connected');
    },
  };
}

export function swapRoute(id: SwapRouteId, env: NodeJS.ProcessEnv = process.env): SwapRouteAdapter {
  if (!swapRouteEnabled(id, env)) throw new SwapRouteUnavailable(`${ROUTES[id].label} is switched off on this server.`, 'route_disabled');
  return isProductionRuntime(env) ? liveRoute(id, env) : sandboxRoute(id);
}

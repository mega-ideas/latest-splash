/**
 * The body of a funding quote or top-up request, read field by field. Only
 * what the business chooses is read: how, how much, from which chain and
 * source. Never a destination, an org or an amount that arrived.
 */
import type { FundingChannel } from '../funding/wallet-funding.ts';
import type { IntentInput, QuoteInput } from './wallet-funding.ts';

const CHANNELS: readonly FundingChannel[] = ['provider', 'wallet', 'cctp', 'swap'];

const text = (v: unknown, max = 80): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);

export function quoteInputFrom(body: Record<string, unknown>): QuoteInput | null {
  const channel = text(body.channel) as FundingChannel | undefined;
  if (!channel || !CHANNELS.includes(channel)) return null;
  const decimals = Number(body.fromDecimals);
  const slippage = Number(body.slippageBps);
  return {
    channel,
    amount: text(body.amount, 24),
    provider: text(body.provider),
    method: text(body.method),
    asset: text(body.asset),
    sourceChain: text(body.sourceChain),
    speed: text(body.speed),
    fromToken: text(body.fromToken, 12),
    fromDecimals: Number.isInteger(decimals) ? decimals : undefined,
    amountIn: text(body.amountIn, 42),
    route: text(body.route),
    slippageBps: body.slippageBps === undefined ? undefined : Number.isInteger(slippage) ? slippage : -1,
  };
}

export function intentInputFrom(body: Record<string, unknown>, input: { userId: string; idempotencyKey: string | null }): IntentInput | null {
  const quote = quoteInputFrom(body);
  if (!quote) return null;
  return {
    ...quote,
    userId: input.userId,
    clientKey: input.idempotencyKey ?? body.clientKey,
    purpose: body.purpose === 'transfer_top_up' ? 'transfer_top_up' : 'top_up',
    transferRef: text(body.transferRef),
    sourceId: text(body.sourceId),
    acceptedArrivesMinMinor: text(body.acceptedArrivesMinMinor, 32),
  };
}

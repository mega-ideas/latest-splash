import { NextResponse } from 'next/server';

import { FundingPlanError, planFunding, type FundingAsset, type FundingChain } from '@/lib/payments/cctp';
import { formatUsdc, StablecoinLaneError } from '@/lib/payments/stablecoin-lane';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const CHAINS: readonly FundingChain[] = ['SUI', 'ETHEREUM', 'ARBITRUM', 'BASE', 'SOLANA', 'APTOS'];
const ASSETS: readonly FundingAsset[] = ['USDC', 'USDT'];

/** How to get USDC from another chain into a Splash wallet. A plan; nothing moves. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const body = await readJsonBody(request);
  const source = String(body.source ?? '') as FundingChain;
  const asset = String(body.asset ?? '') as FundingAsset;
  if (!CHAINS.includes(source) || !ASSETS.includes(asset)) {
    return NextResponse.json({ error: 'Choose a source chain and asset.' }, { status: 400 });
  }
  try {
    const plan = planFunding({
      source,
      asset,
      amount: String(body.amount ?? ''),
      destination: String(body.destination ?? ''),
      swapSlippageBps: typeof body.slippageBps === 'number' ? body.slippageBps : undefined,
    });
    if (!plan.available) return NextResponse.json(plan);
    return NextResponse.json({
      ...plan,
      amountMinor: plan.amountMinor.toString(),
      arrivesMinor: plan.arrivesMinor.toString(),
      arrives: formatUsdc(plan.arrivesMinor),
      minUsdcAfterSwapMinor: plan.minUsdcAfterSwapMinor?.toString() ?? null,
    });
  } catch (error) {
    if (error instanceof FundingPlanError || error instanceof StablecoinLaneError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

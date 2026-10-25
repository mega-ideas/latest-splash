import { NextResponse } from 'next/server';

import {
  FUNDING_CHAINS,
  FundingPlanError,
  planFunding,
  type CctpTransfer,
  type FundingAsset,
  type FundingChain,
} from '@/lib/payments/cctp';
import { formatUsdc, StablecoinLaneError } from '@/lib/payments/stablecoin-lane';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Sui, plus every chain Circle lists for CCTP V2 with USDC (lib/payments/cctp.ts). */
const CHAINS: ReadonlySet<string> = new Set<string>(['SUI', ...Object.keys(FUNDING_CHAINS)]);
const ASSETS: readonly FundingAsset[] = ['USDC', 'USDT'];
const SPEEDS: readonly CctpTransfer[] = ['STANDARD', 'FAST'];

/** Minor units are bigints; JSON carries them as decimal strings. */
function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

/** How to get USDC from another chain into a Splash wallet. A plan; nothing moves. */
export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;
  const body = await readJsonBody(request);
  const source = String(body.source ?? '') as FundingChain;
  const asset = String(body.asset ?? '') as FundingAsset;
  if (!CHAINS.has(source) || !ASSETS.includes(asset)) {
    return NextResponse.json({ error: 'Choose a source chain and asset.' }, { status: 400 });
  }
  const speed = body.speed === undefined ? undefined : (String(body.speed) as CctpTransfer);
  if (speed !== undefined && !SPEEDS.includes(speed)) {
    return NextResponse.json({ error: 'Choose a standard or fast transfer.' }, { status: 400 });
  }
  try {
    const plan = planFunding({
      source,
      asset,
      amount: String(body.amount ?? ''),
      destination: String(body.destination ?? ''),
      swapSlippageBps: typeof body.slippageBps === 'number' ? body.slippageBps : undefined,
      speed,
    });
    if (!plan.available) return NextResponse.json(plan);
    return NextResponse.json(jsonSafe({ ...plan, arrives: formatUsdc(plan.arrivesMinor) }));
  } catch (error) {
    if (error instanceof FundingPlanError || error instanceof StablecoinLaneError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}

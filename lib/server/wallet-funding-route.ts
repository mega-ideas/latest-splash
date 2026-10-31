/**
 * The front of every /api/wallet/funding route (v2 §4.3): the wallet route's
 * gate (signed-in customer, org from the SESSION, own membership, the live
 * wallet context for that org only, lib/server/wallet-route.ts), then the
 * funding deps for that org. Nothing here reads an org, an account, a wallet
 * address or an amount that arrived from the request.
 */
import 'server-only';

import { NextResponse } from 'next/server';

import { fundingDepsFor } from '@/lib/server/wallet-funding-deps';
import type { FundingDeps } from '@/lib/server/wallet-funding';
import { limitWalletRequests, NO_STORE, walletRoute, type WalletRoute } from '@/lib/server/wallet-route';

export type FundingRoute = { route: WalletRoute; deps: FundingDeps };

export async function fundingRoute(request: Request): Promise<{ funding: FundingRoute; response: null } | { funding: null; response: Response }> {
  const gate = await walletRoute(request);
  if (gate.response) return { funding: null, response: gate.response };
  const route = gate.route;
  return { funding: { route, deps: fundingDepsFor({ orgId: route.orgId, ctx: route.ctx, db: route.db }) }, response: null };
}

/** A viewer reads; adding funds, recording a deposit or looking again needs any other role. */
export function refuseViewer(f: FundingRoute, what: string): Response | null {
  if (f.route.authority.role !== 'VIEWER') return null;
  return NextResponse.json({ error: `A viewer cannot ${what}.`, code: 'viewer' }, { status: 403, headers: NO_STORE });
}

/** Funding sources decide where the business's money may come from: owners only. */
export function requireFundingOwner(f: FundingRoute, what: string): Response | null {
  if (f.route.authority.role === 'OWNER') return null;
  return NextResponse.json({ error: `Only an owner can ${what}.`, code: 'owner_only' }, { status: 403, headers: NO_STORE });
}

export async function limitFunding(f: FundingRoute): Promise<Response | null> {
  return limitWalletRequests(f.route);
}

/** A service result as a response: a refusal keeps its extra fields (a changed quote, say). */
export function fundingResponse(result: { ok: boolean } & Record<string, unknown>, okStatus = 200): Response {
  const { ok, status, ...rest } = result as { ok: boolean; status?: number } & Record<string, unknown>;
  if (!ok) return NextResponse.json(rest, { status: typeof status === 'number' ? status : 400, headers: NO_STORE });
  return NextResponse.json(rest, { status: okStatus, headers: NO_STORE });
}

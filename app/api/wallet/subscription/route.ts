import { NextResponse } from 'next/server';

import { subscriptionBillingEnabled } from '@/lib/billing/subscription';
import { currentWalletMembers } from '@/lib/server/business-wallet';
import { readJsonBody } from '@/lib/server/http';
import { cancelSubscription, changePlan, readSubscription, subscribe } from '@/lib/server/subscription-billing';
import { liveBillingWallet } from '@/lib/server/subscription-billing-deps';
import { asResponse, limitWalletRequests, NO_STORE, requireOwner, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Settings → Billing (Amendment A1 §6), behind FEATURE_SUBSCRIPTION_BILLING,
 * which is OFF. While off this route answers 404 to everything, before it
 * reads a session, except a cancel, which the service refuses with 404 too
 * unless the business has a live plan to revoke.
 *
 * GET   the business's plan: the price it was signed at, "Splash can draw up
 *       to X USDC per calendar month (UTC) for your plan. Revoke any time.",
 *       its invoices and receipts. Owners only.
 * POST  { action: 'subscribe' | 'change', planId } or { action: 'cancel' }.
 *       Owners only; the business wallet's quorum signs. The org is the
 *       session's (walletRoute, requireSessionAccount), never the request's.
 */
const notFound = () => NextResponse.json({ error: 'Not found' }, { status: 404, headers: NO_STORE });

export async function GET(request: Request) {
  if (!subscriptionBillingEnabled()) return notFound();
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'see the plan');
  if (notOwner) return notOwner;
  const result = await readSubscription({ db: route.db }, route.orgId);
  return asResponse(result, result);
}

export async function POST(request: Request) {
  const body = await readJsonBody(request);
  const action = String(body.action ?? '');
  if (!subscriptionBillingEnabled() && action !== 'cancel') return notFound();
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'change the plan');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const members = await currentWalletMembers(route.ctx, route.db, route.orgId);
  if (!members.ok) return asResponse(members);
  const deps = { db: route.db };
  const bw = liveBillingWallet(route.ctx);
  const input = { orgId: route.orgId, requestedBy: route.authority.userId, wallet: members.members };
  const planId = String(body.planId ?? '');
  const result =
    action === 'subscribe'
      ? await subscribe(deps, bw, { ...input, planId })
      : action === 'change'
        ? await changePlan(deps, bw, { ...input, planId })
        : action === 'cancel'
          ? await cancelSubscription(deps, bw, input)
          : ({ ok: false, status: 400, code: 'bad_action', error: 'action is subscribe, change or cancel' } as const);
  return asResponse(result, result.ok ? { request: result.request, subscription: result.subscription } : undefined);
}

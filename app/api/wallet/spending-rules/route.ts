import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { deriveNearThresholdAlerts } from '@/lib/server/near-threshold';
import { issueSpendingRule, readSpendingRules } from '@/lib/server/spend-rules';
import { recipientsFromBody, ruleFromBody, spendRoute, staffSpender, walletMembersOr } from '@/lib/server/spend-rules-route';
import { orgMemberWalletAddresses } from '@/lib/server/wallet-deps';
import { asResponse, limitWalletRequests, NO_STORE, refusal, requireOwner } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * Settings → Team & rules (v2 §4.2).
 *
 * GET   every rule of this business, read from the chain: per staff member,
 *       their per-payment maximum, each allowance's live spend
 *       (`current_spend`), the current day or month window (rolled over as
 *       the next charge would), what is left, the expiry, and the running
 *       totals toward the second-approval threshold. Owners and approvers
 *       see every rule; anyone else only their own.
 * POST  an owner gives a staff member a rule: { staffUserId,
 *       perPaymentMaxMinor, cap: { period: 'day' | 'month', limitMinor },
 *       expiresAtMs, startsAtMs?, lifetimeCapMinor?, recipients? }. The
 *       wallet's quorum signs it.
 */
export async function GET(request: Request) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const result = await readSpendingRules(route.sc);
  if (!result.ok) return asResponse(result);
  const people = await orgMemberWalletAddresses(route.db, route.orgId);
  const userOf = new Map(people.map((p) => [p.address, p.userId]));
  const seesAll = route.authority.role === 'OWNER' || route.authority.role === 'APPROVER';
  const mine = new Set(people.filter((p) => p.userId === route.authority.userId).map((p) => p.address));
  const view = result.view;
  const rules = view.rules.filter((r) => seesAll || mine.has(r.spender)).map((r) => ({ ...r, userId: userOf.get(r.spender) ?? null }));
  // Near-threshold flags (detective only) are the owners' to see: they name
  // who paid whom across every rule.
  const owners = route.authority.role === 'OWNER' ? { nearThreshold: deriveNearThresholdAlerts(view) } : {};
  return NextResponse.json(
    seesAll ? { ...view, rules, ...owners } : { walletEpoch: view.walletEpoch, policy: view.policy, rules, unattached: [], stale: [], reissueNeeded: view.reissueNeeded },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const gate = await spendRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const notOwner = requireOwner(route, 'give a spending rule');
  if (notOwner) return notOwner;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const staff = await staffSpender(route, String(body.staffUserId ?? ''));
  if (staff.response) return staff.response;
  const rule = ruleFromBody(body, staff.address);
  if (typeof rule === 'string') return refusal(400, rule);
  const members = await walletMembersOr(route);
  if (members.response) return members.response;
  const result = await issueSpendingRule(route.sc, {
    orgId: route.orgId,
    requestedBy: route.authority.userId,
    wallet: members.wallet,
    rule,
    recipients: body.recipients && typeof body.recipients === 'object' ? recipientsFromBody(body.recipients as Record<string, unknown>) : undefined,
  });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}

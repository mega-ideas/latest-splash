import 'server-only';

import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import type { CustomerSession } from '@/lib/auth/customer-session';
import { kybGateEnabled, readOrgKybState } from '@/lib/compliance/org-kyb';
import { canMoveMoney, kybGateReason, type KybLifecycleState } from '@/lib/compliance/kyb-state';
import { isOnboarding, laneAccess, type Lane } from '@/lib/payments/stablecoin-lane';

/**
 * The money gate (wallet spec §3.2).
 *
 * ONE server-side check, applied in the money routes themselves rather than in
 * a layout — because `app/queue` (the maker-checker board that actually
 * releases funds) lives OUTSIDE `app/dashboard` and would not inherit a
 * dashboard-layout gate. Gating the routes closes the hole regardless of which
 * page reaches them.
 *
 * Shape mirrors `requireCustomerRequest` so route code reads identically:
 *
 *   const gate = await requireActiveOrg(auth.session);
 *   if (gate.response) return gate.response;
 */
export type KybGateResult =
  | { state: KybLifecycleState; response: null }
  | { state: KybLifecycleState; response: NextResponse };

export async function requireActiveOrg(
  session: CustomerSession,
  // Which lane the route moves money on. It changes only the WORDS of a
  // refusal — a business in onboarding is told what is locked and what is
  // still open to it — never whether the route refuses.
  opts: { lane?: Lane } = {},
): Promise<KybGateResult> {
  // Opt-in: with the flag off the gate observes but never blocks, so enabling
  // it is a deliberate config change rather than a surprise outage.
  if (!kybGateEnabled()) {
    return { state: 'ACTIVE', response: null };
  }

  // A session with no membership throws here. Unguarded, that surfaced as a
  // 500 — an unhandled error for the most ordinary state a new account is in,
  // and one that tells the caller nothing about what to do next.
  let ctx;
  try {
    ctx = await resolveAuthorityForSession(session);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return {
        state: 'REGISTERED',
        response: NextResponse.json(
          {
            error:
              'This account is not part of a verified workspace yet. Complete business ' +
              'verification before moving money.',
            code: 'kyb_required',
            state: 'REGISTERED',
          },
          { status: 403 },
        ),
      };
    }
    throw error;
  }

  return requireActiveOrgId(ctx.orgId, opts);
}

/**
 * The same gate for a caller with no session: an approved payment carried out
 * for its org (lib/server/payment-request.ts). The org comes from the proposal,
 * the one record that says whose money it is — so a replay meets exactly the
 * check, and the lane wording, a signed-in person would.
 */
export async function requireActiveOrgId(
  orgId: string,
  opts: { lane?: Lane } = {},
): Promise<KybGateResult> {
  if (!kybGateEnabled()) {
    return { state: 'ACTIVE', response: null };
  }

  const state = await readOrgKybState(orgId);

  if (canMoveMoney(state)) {
    return { state, response: null };
  }

  console.warn('[kyb-gate] blocked money route', { orgId, state, lane: opts.lane });
  const reason = opts.lane && isOnboarding(state) ? laneAccess(state, opts.lane).reason : kybGateReason(state);
  return {
    state,
    response: NextResponse.json(
      {
        error: reason || kybGateReason(state),
        code: 'kyb_not_active',
        kybState: state,
        ...(opts.lane ? { lane: opts.lane } : {}),
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    ),
  };
}

/**
 * Read-only variant for server components that need to render a banner rather
 * than return a response. Never throws — a failure to resolve is reported as
 * "not blocked" so a transient DB error cannot dark-screen the dashboard.
 */
export async function readKybGateState(session: CustomerSession): Promise<{
  state: KybLifecycleState;
  blocked: boolean;
  reason: string;
}> {
  if (!kybGateEnabled()) return { state: 'ACTIVE', blocked: false, reason: '' };

  try {
    const ctx = await resolveAuthorityForSession(session);
    const state = await readOrgKybState(ctx.orgId);
    return { state, blocked: !canMoveMoney(state), reason: kybGateReason(state) };
  } catch (error) {
    // Fails CLOSED, and this used to fail open — it caught, logged
    // "treating as unblocked", and returned ACTIVE.
    //
    // The throw it was catching is `UnauthorizedError` from
    // `resolveAuthorityForSession`, raised for a session with no membership
    // row. That is not an edge case: it is exactly what a brand-new sign-up
    // is, which is precisely the account this gate exists to stop. The one
    // user the control was written for was the one it waved through.
    //
    // A compliance gate that cannot determine state has not determined that
    // everything is fine.
    console.error('[kyb-gate] state could not be read; blocking', error);
    return {
      state: 'REGISTERED',
      blocked: true,
      reason: kybGateReason('REGISTERED'),
    };
  }
}

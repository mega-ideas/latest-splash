import 'server-only';

import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import type { CustomerSession } from '@/lib/auth/customer-session';
import { kybGateEnabled, readOrgKybState } from '@/lib/compliance/org-kyb';
import { canMoveMoney, kybGateReason, type KybLifecycleState } from '@/lib/compliance/kyb-state';

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

export async function requireActiveOrg(session: CustomerSession): Promise<KybGateResult> {
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

  const state = await readOrgKybState(ctx.orgId);

  if (canMoveMoney(state)) {
    return { state, response: null };
  }

  console.warn('[kyb-gate] blocked money route', { orgId: ctx.orgId, state });
  return {
    state,
    response: NextResponse.json(
      {
        error: kybGateReason(state),
        code: 'kyb_not_active',
        kybState: state,
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

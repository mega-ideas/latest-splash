/**
 * The front of every /api/limits route: a signed-in customer, their business
 * from the SESSION, and their own membership (teamRoute). A route never reads a
 * business or an actor from the request. Changes are limited per person.
 */
import 'server-only';

import { NextResponse } from 'next/server';

import type { LimitFailure } from '@/lib/server/business-limits';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { NO_STORE, teamRoute, type TeamRoute } from '@/lib/server/team-route';

export { teamRoute as limitsRoute, NO_STORE };
export type { TeamRoute };

export async function limitChanges(route: TeamRoute): Promise<Response | null> {
  return enforceRateLimit({ rule: RATE_LIMITS.limitChangeUser, key: route.authority.userId, message: 'Too many limit changes. Try again shortly.' });
}

/** A service result as a response. */
export function limitResponse<T extends { ok: true }>(result: T | LimitFailure, okStatus = 200): Response {
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status, headers: NO_STORE });
  const { ok: _ok, ...rest } = result;
  void _ok;
  return NextResponse.json({ ok: true, ...rest }, { status: okStatus, headers: NO_STORE });
}

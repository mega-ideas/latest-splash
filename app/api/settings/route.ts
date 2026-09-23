import { NextResponse } from 'next/server';

import { resolveAuthorityForSession, UnauthorizedError } from '@/lib/auth/authority';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { readOrgSettings, saveOrgSettings, SettingsInvariantError } from '@/lib/server/org-settings';

/**
 * The operating dials.
 *
 * These decide whether a payment needs a second approver, what the per-transfer
 * and daily ceilings are, and whether TOTP is required — so the route that
 * changes them is a money route, and it was not treated as one.
 *
 * Before: `requireCustomerRequest` and nothing else. No role check, no org
 * scoping, and one global JSON file underneath. Any authenticated user of any
 * tenant could set `requireDualApproval` to false for EVERY tenant, then send
 * whatever they liked. The whole maker-checker apparatus hung off a flag that
 * the person it constrains could turn off.
 *
 * Now: settings belong to an org, reads are scoped to the caller's, and only an
 * admin may write. `resolveAuthorityForSession` reads the membership row per
 * request — the session cookie's role field is display-only by contract and is
 * never consulted here.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  try {
    const ctx = await resolveAuthorityForSession(auth.session);
    return NextResponse.json(await readOrgSettings(ctx.orgId));
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json(
        { error: 'This account has no workspace membership yet.', code: 'no_membership' },
        { status: 403 },
      );
    }
    throw error;
  }
}

export async function PUT(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const body = await readJsonBody(request);
  try {
    // The body may carry dials and nothing else. An `orgId` or `role` in it
    // would be the caller naming their own authority.
    assertCleanBody(body, 'settings');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }

  let ctx;
  try {
    ctx = await resolveAuthorityForSession(auth.session);
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return NextResponse.json(
        { error: 'This account has no workspace membership yet.', code: 'no_membership' },
        { status: 403 },
      );
    }
    throw error;
  }

  // Changing a payment ceiling is an administrative act. A maker who can also
  // raise their own limit has no limit; a checker who can switch off dual
  // approval has no counterparty.
  if (ctx.role !== 'OWNER' && ctx.role !== 'FINANCE_ADMIN') {
    return NextResponse.json(
      {
        error:
          'Changing operating limits and approval settings requires an admin. ' +
          'Your role can operate within these limits but not move them.',
        code: 'requires_admin',
      },
      { status: 403 },
    );
  }

  try {
    // `ctx.userId` is the DB-derived identity, so "who moved this limit" has an
    // answer that does not depend on a cookie field the client can shape.
    return NextResponse.json(await saveOrgSettings(ctx.orgId, body, ctx.userId));
  } catch (error) {
    if (error instanceof SettingsInvariantError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to save operating settings.' },
      { status: 400 },
    );
  }
}

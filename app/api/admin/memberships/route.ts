import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getAdminSession } from '@/lib/server/admin-auth';
import {
  MEMBERSHIP_ROLES,
  MembershipAdminError,
  grantRole,
  listAccounts,
  listOrganizations,
  revokeRole,
} from '@/lib/server/memberships';
import { readJsonBody } from '@/lib/server/http';

/**
 * Staff console: read accounts, grant a membership, revoke one.
 *
 * Splash staff, not workspace admins. That is the narrower of the two possible
 * surfaces and the right one to build first: a customer promoting their own
 * colleague is a feature that needs an invitation flow and an audit trail the
 * customer can read, and neither exists yet. This is the operator tool that
 * closes the gap Phase 3 opened.
 *
 * Every route requires a staff session. `getAdminSession` returns null in
 * production unless ADMIN_EMAIL, ADMIN_PASSWORD and ADMIN_SESSION_SECRET are
 * all configured, so an unconfigured deployment cannot grant anything.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const grantSchema = z.object({
  email: z.string().trim().email().max(254),
  orgId: z.string().trim().min(1).max(120),
  // No default. The whole point of the schema change in Phase 3 is that a
  // role is always stated, so a request that omits it is rejected rather than
  // quietly made a viewer — or worse, something else.
  role: z.enum(MEMBERSHIP_ROLES as unknown as [string, ...string[]]),
});

const revokeSchema = z.object({ email: z.string().trim().email().max(254) });

async function db() {
  const { getDb } = await import('@/lib/db/client');
  return getDb() as never;
}

function storageUnavailable() {
  return NextResponse.json(
    { error: 'Account storage is not configured on this deployment' },
    { status: 503 },
  );
}

export async function GET() {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (!process.env.DATABASE_URL) return storageUnavailable();

  const database = await db();
  const [accounts, organizations] = await Promise.all([listAccounts(database), listOrganizations(database)]);

  return NextResponse.json({ accounts, organizations }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (!process.env.DATABASE_URL) return storageUnavailable();

  const parsed = grantSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) {
    return NextResponse.json(
      { error: `An email, an organisation and one of ${MEMBERSHIP_ROLES.join(', ')} are required` },
      { status: 400 },
    );
  }

  try {
    await grantRole(await db(), {
      email: parsed.data.email,
      orgId: parsed.data.orgId,
      role: parsed.data.role as never,
      // Who granted it, recorded on the row. An authority change with no
      // author is not auditable.
      grantedBy: session.email,
    });
  } catch (error) {
    if (error instanceof MembershipAdminError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }

  console.info('[memberships] granted', {
    by: session.email,
    to: parsed.data.email,
    org: parsed.data.orgId,
    role: parsed.data.role,
  });

  return NextResponse.json({ granted: true }, { status: 201 });
}

export async function DELETE(request: Request) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (!process.env.DATABASE_URL) return storageUnavailable();

  const parsed = revokeSchema.safeParse(await readJsonBody(request));
  if (!parsed.success) return NextResponse.json({ error: 'An email is required' }, { status: 400 });

  let offboarded: Array<{ orgId: string; addresses: string[] }>;
  try {
    // Offboarding goes with it: the person-in-charge appointment and usable
    // sign-offs end now, and any spending rule their addresses hold on chain
    // is shown to the owners as orphaned until their quorum takes it back.
    ({ offboarded } = await revokeRole(await db(), { email: parsed.data.email, by: `operator:${session.email}` }));
  } catch (error) {
    if (error instanceof MembershipAdminError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }

  console.info('[memberships] revoked', { by: session.email, from: parsed.data.email, orgs: offboarded.map((o) => o.orgId) });
  return NextResponse.json({ revoked: true, offboarded });
}

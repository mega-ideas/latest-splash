import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import {
  listFundReferralHistoryForStaff,
  listFundReferralsForStaff,
  releaseFundLinkForStaff,
} from '@/lib/server/fund-referral-store';
import { readJsonBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * The fund-manager referrals, for staff (v2 D9, brief 5.7; the 5.7 review).
 * Cross-tenant by design, behind a staff session, spelled `ForStaff`.
 *
 * GET               every business's current referral.
 * GET ?orgId=…      one business's full history, oldest first: every
 *                   assessment with its answers, every confirmed link, every
 *                   release. This is the referral's evidence record.
 * POST { orgId, reason }   support or compliance releases a business's linked
 *                   reference (for example one linked to the wrong account).
 *                   The reason and the staff member are kept in the history.
 */
async function getDbOrNull() {
  if (!process.env.DATABASE_URL) return null;
  const { getDb } = await import('@/lib/db/client');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getDb() as any;
}

export async function GET(request: Request) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  const db = await getDbOrNull();
  if (!db) return NextResponse.json({ error: 'Fund referrals need the database, and this server has none.' }, { status: 503, headers: NO_STORE });
  const orgId = new URL(request.url).searchParams.get('orgId')?.trim();
  if (orgId) {
    const history = await listFundReferralHistoryForStaff(db, orgId);
    return NextResponse.json(
      { orgId, history: history.map((h) => ({ ...h, at: h.at.toISOString() })) },
      { headers: NO_STORE },
    );
  }
  const referrals = await listFundReferralsForStaff(db);
  return NextResponse.json(
    {
      referrals: referrals.map((r) => ({
        orgId: r.orgId,
        outcome: r.outcome,
        category: r.category,
        assessedAt: r.assessedAt.toISOString(),
        linkedReference: r.linkedReference,
        linkConfirmedAt: r.linkConfirmedAt?.toISOString() ?? null,
      })),
    },
    { headers: NO_STORE },
  );
}

export async function POST(request: Request) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (session.role !== 'support' && session.role !== 'compliance') {
    return NextResponse.json({ error: 'Only support or compliance staff release a fund link.' }, { status: 403, headers: NO_STORE });
  }
  const db = await getDbOrNull();
  if (!db) return NextResponse.json({ error: 'Fund referrals need the database, and this server has none.' }, { status: 503, headers: NO_STORE });
  const body = await readJsonBody(request);
  const orgId = typeof body.orgId === 'string' ? body.orgId.trim() : '';
  if (!orgId) return NextResponse.json({ error: 'orgId is required.' }, { status: 400, headers: NO_STORE });
  const released = await releaseFundLinkForStaff(db, { orgId, releasedBy: session.email, reason: typeof body.reason === 'string' ? body.reason : '' });
  if (!released.ok) {
    const error = released.code === 'reason_required' ? 'Say why the link is released.' : 'That business has no linked account.';
    return NextResponse.json({ error, code: released.code }, { status: released.code === 'reason_required' ? 400 : 409, headers: NO_STORE });
  }
  return NextResponse.json({ released: true }, { headers: NO_STORE });
}

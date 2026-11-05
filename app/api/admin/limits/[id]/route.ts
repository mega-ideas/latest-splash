import { NextResponse } from 'next/server';

import { getAdminSession } from '@/lib/server/admin-auth';
import { decideLimitRequestForStaff, sendLimitNotices } from '@/lib/server/business-limits';
import { readJsonBody } from '@/lib/server/http';
import { tellOwners } from '@/lib/server/owners-notifier';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

/**
 * Decide an owner's request for a higher limit. Compliance and operations
 * staff only; support is refused.
 *
 * PATCH { action: 'approve' | 'approve_smaller' | 'decline', granted?, reason? }
 *   approve          the figure asked for, after the 24 hour notice
 *   approve_smaller  `granted`: a figure above the limit now and below the one
 *                    asked for
 *   decline          `reason`: in plain words, so the owner can act on it
 *
 * The decision is a line on the business's trail under the staff member's
 * address. The owners are told afterwards; if nobody could be reached the cron
 * tries again. Deciding twice the same way decides once.
 *
 * A grant above a large-grant line (lib/limits/rules.ts) takes two different
 * staff, one compliance and one operations: the first approval answers
 * `stage: 'first_approval'`, is recorded, starts nothing and tells nobody; the
 * second, from the other role and a different person, answers `stage: 'decided'`
 * and starts the 24 hour notice.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'DATABASE_URL is not set' }, { status: 503 });
  const { id } = await params;
  const body = await readJsonBody(request);
  const { getDb } = await import('@/lib/db/client');
  const db = getDb() as unknown as DrizzleDb;
  const result = await decideLimitRequestForStaff(db, { requestId: id, staff: { email: session.email, role: session.role }, action: body.action, granted: body.granted, reason: body.reason });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code, ...(result.details ? { details: result.details } : {}) }, { status: result.status });
  // The owners are told when a request is decided. The first of two approvals decides nothing, so nobody is told.
  if (!result.replayed && result.stage === 'decided') {
    await sendLimitNotices(db, {
      notify: (orgId, notice) => tellOwners(db, orgId, { subject: notice.subject, text: notice.text, path: notice.path, emailLead: 'Open Settings, Limits:', whatsappTail: 'Open Splash, Settings, Limits.' }),
    }).catch(() => undefined);
  }
  return NextResponse.json({ request: result.request, replayed: result.replayed, stage: result.stage });
}

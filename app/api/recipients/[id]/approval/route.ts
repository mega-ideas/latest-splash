import { NextResponse } from 'next/server';

import { approveWalletRecipient } from '@/lib/server/wallet-recipients';
import { NO_STORE, recipientRoute } from '@/lib/server/wallet-recipients-deps';

export const dynamic = 'force-dynamic';

/**
 * An owner approves a wallet recipient a staff member saved (v2 §4.7,
 * maker-checker): until then it is not paid and cannot be tagged on a
 * spending rule. The recipient is read within the business from the
 * session; another business's id reads as absent. Owners only; the one who
 * saved it does not approve it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const route = await recipientRoute(request);
  if (!route.ok) return route.response;
  const { id } = await params;
  const result = await approveWalletRecipient({ db: route.db, orgId: route.orgId, now: () => new Date() }, { recipientId: id, approvedBy: route.authority.userId, role: route.authority.role });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ approvedBy: result.approvedBy, approvedAt: result.approvedAt }, { headers: NO_STORE });
}

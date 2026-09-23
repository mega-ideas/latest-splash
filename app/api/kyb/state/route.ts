import { NextResponse } from 'next/server';

import { getCustomerSession } from '@/lib/server/customer-auth';
import { readKybGateState } from '@/lib/server/kyb-gate';

/**
 * This organisation's KYB standing, for surfaces that need to state it.
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * `app/dashboard/layout.tsx` already resolves the gate once and hands it to the
 * shell, but every page under it is a client component and cannot read a
 * session or the database. So the overview asserted compliance from a constant:
 *
 *   { label: 'KYB status', value: 'Approved · Sumsub verified' }
 *   { label: 'Risk tier',  value: 'Tier 1 · Low risk' }
 *
 * — rendered identically for an organisation sitting in REGISTERED that cannot
 * move a dollar. A dashboard panel is read as a reading. Telling a customer
 * their KYB is approved when nothing has been checked is a statement about our
 * own regulatory posture, and it is the sentence they would quote back.
 *
 * ─── What it does not do ────────────────────────────────────────────────────
 *
 * It does not gate anything. `readKybGateState` is the same call the layout
 * makes and the money routes enforce the gate themselves — a client that lies
 * about this response changes what a banner says and nothing else.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getCustomerSession();
  if (!session) {
    return NextResponse.json({ error: 'Sign in to continue.' }, { status: 401 });
  }

  // Fails closed on its own: a state that cannot be read comes back as
  // REGISTERED and blocked, which is the honest answer to "we do not know".
  const gate = await readKybGateState(session);
  return NextResponse.json(gate);
}

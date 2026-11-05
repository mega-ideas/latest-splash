/**
 * Send one billing pull with the finance multisig's signatures (A1 §6),
 * behind FEATURE_SUBSCRIPTION_BILLING, which is OFF: while off this answers
 * 404 before it reads a session or the database.
 *
 * POST { signatures: string[] }: the finance multisig's combined signature
 *      over the stored bytes, made on the signers' own devices. The server
 *      relays it with the exact bytes it built and stored, and never signs.
 *      A pull already sent or settled is not sent again (409 not_awaiting);
 *      one the network refused before running stays signable (502 not_sent).
 *
 * Operations staff only; cross-tenant, through submitPullForStaff.
 */
import { NextResponse } from 'next/server';

import { subscriptionBillingEnabled } from '@/lib/billing/subscription';
import { getAdminSession } from '@/lib/server/admin-auth';
import { readJsonBody } from '@/lib/server/http';
import { submitPullForStaff } from '@/lib/server/subscription-billing';
import type { DrizzleDb } from '@/lib/server/wallet-signing-store';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!subscriptionBillingEnabled()) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const session = await getAdminSession();
  if (!session) return NextResponse.json({ error: 'Staff authentication required' }, { status: 401 });
  if (session.role !== 'operations') return NextResponse.json({ error: 'Billing is for operations staff' }, { status: 403 });
  const { id } = await params;
  const body = await readJsonBody(request);
  const signatures = Array.isArray(body.signatures) ? body.signatures.filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length < 8192) : [];
  if (!/^pull_[0-9a-f-]{36}$/.test(id) || signatures.length === 0 || signatures.length !== (body.signatures as unknown[]).length) {
    return NextResponse.json({ error: 'a pull id and the finance multisig signature are required' }, { status: 400 });
  }
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'DATABASE_URL is not set' }, { status: 503 });
  const [{ getDb }, { liveCycleDeps }, { liveChain }] = await Promise.all([
    import('@/lib/db/client'),
    import('@/lib/server/subscription-billing-deps'),
    import('@/lib/server/wallet-deps'),
  ]);
  const deps = await liveCycleDeps(getDb() as unknown as DrizzleDb);
  const chain = liveChain();
  const result = await submitPullForStaff({ ...deps, execute: (bytes, sigs) => chain.execute(bytes, sigs) }, { pullId: id, signatures });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ status: result.status });
}

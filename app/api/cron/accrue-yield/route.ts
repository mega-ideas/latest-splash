/**
 * Daily Smart Treasury yield accrual.
 *
 * The snapshot is encrypted first, stored on Walrus second, and anchored on
 * Sui last. No audit anchor is emitted unless the backing blob exists.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { custodyPhaseEnabled, custodyPhaseResponse } from '@/lib/server/custody-phase';
import { sealAdapter } from '@/lib/server/seal';
import { anchorAuditHashOnSui } from '@/lib/server/sui-settlement';
import { accrueDailyYield } from '@/lib/server/treasury';
import { storeEncryptedInvoice } from '@/lib/server/walrus';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

function isAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const provided = Buffer.from(token);
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

async function handleAccrual(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ success: false, error: 'unauthorized' }, { status: 401 });
  }
  // Phase 0: there is no treasury to accrue against. Nothing is written and
  // nothing is anchored; the scheduler sees the same licence-named refusal
  // a customer would.
  if (!custodyPhaseEnabled()) return custodyPhaseResponse();

  try {
    const snapshot = await accrueDailyYield();
    const { ciphertext, policy } = await sealAdapter.encrypt(
      JSON.stringify(snapshot),
      ['splash-treasury', 'auditor'],
    );
    const blob = await storeEncryptedInvoice(ciphertext);
    const hash = createHash('sha256').update(ciphertext).digest('hex');
    const anchor = await anchorAuditHashOnSui({
      auditHash: hash,
      anchorId: `treasury-yield:${new Date().toISOString().slice(0, 10)}`,
      backingBlobId: blob.blobId,
    });

    return NextResponse.json({
      success: true,
      snapshot,
      audit: {
        hash,
        anchorObjectId: anchor.anchorObjectId,
        digest: anchor.digest,
        walrusBlobId: blob.blobId,
        walrusMode: blob.mode,
        sealPolicyId: policy.policyId,
        sealMode: policy.mode,
        confirmed: true,
      },
    });
  } catch (error) {
    console.error('[cron/accrue-yield] accrual failed:', error);
    return NextResponse.json({ success: false, error: 'yield accrual failed' }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return handleAccrual(request);
}

export async function POST(request: Request) {
  return handleAccrual(request);
}

import { NextResponse } from 'next/server';

import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, clientIp, enforceRateLimit } from '@/lib/server/rate-limit';
import { readOwnershipChallenge, submitOwnershipProof } from '@/lib/server/wallet-recipients';
import { NO_STORE, proofSubmitDeps, recipientsDb } from '@/lib/server/wallet-recipients-deps';

export const dynamic = 'force-dynamic';

/**
 * The supplier's side of the wallet ownership proof (v2 §4.7, D5b). Public:
 * the supplier has no Splash account. The token in the link is the
 * capability; it was handed to one supplier and is kept only as its SHA-256.
 *
 *   GET   the message to sign and the address it is for.
 *   POST  { signature }: the wallet's Sui personal-message signature of that
 *         message. The link is used up by this call, whatever the outcome.
 */
async function gate(request: Request) {
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.ownershipProofIp, key: clientIp(request) });
  if (limited) return { response: limited, db: null };
  const db = await recipientsDb();
  if (!db) return { response: NextResponse.json({ error: 'This link cannot be used right now.' }, { status: 503, headers: NO_STORE }), db: null };
  return { response: null, db };
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const g = await gate(request);
  if (!g.db) return g.response;
  const { token } = await params;
  const result = await readOwnershipChallenge(g.db, token, new Date());
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  const { ok: _ok, ...rest } = result;
  void _ok;
  return NextResponse.json(rest, { headers: NO_STORE });
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const g = await gate(request);
  if (!g.db) return g.response;
  const { token } = await params;
  const body = await readJsonBody(request);
  const result = await submitOwnershipProof(proofSubmitDeps(g.db), { token, signature: body.signature });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ verified: true, address: result.address }, { headers: NO_STORE });
}

import { setOrgKybState } from '@/lib/compliance/org-kyb';
import { isProductionRuntime } from '@/lib/server/runtime-mode';
import { handleSumsubWebhook } from '@/lib/server/sumsub-webhook';

/**
 * Sumsub's verdict on a business, and the status of a Travel Rule transfer.
 *
 * ─── The signature is the only defence ──────────────────────────────────────
 *
 * This endpoint is public, carries no session, and moves an organisation from
 * KYB_SUBMITTED to KYB_PROVIDER_APPROVED — the state that says an independent
 * provider has checked who these people are. Unverified, anyone who learns the
 * URL could assert that verdict for any org. So the raw body's HMAC is checked
 * before it is parsed for meaning (in the algorithm Sumsub names;
 * unconfigured verifies as false), its date must be inside the retry window,
 * and each delivery is applied once (lib/server/sumsub-webhook.ts).
 *
 * ─── A provider cannot make a business live ─────────────────────────────────
 *
 * The actor is PROVIDER and the state machine only permits PROVIDER to reach
 * KYB_PROVIDER_APPROVED or REJECTED. It cannot reach ACTIVE, which is the only
 * state that can move money. A webhook, however well authenticated, is a
 * message from a vendor, and a vendor does not decide that a Splash customer
 * may send money.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return Response.json({ error: 'body too large' }, { status: 413, headers: NO_STORE });
  let db = null;
  if (process.env.DATABASE_URL) {
    const { getDb } = await import('@/lib/db/client');
    db = getDb() as never;
  }
  const result = await handleSumsubWebhook(
    {
      db,
      secret: process.env.SUMSUB_WEBHOOK_SECRET,
      production: isProductionRuntime(),
      now: () => new Date(),
      applyKyb: (orgId, next) => setOrgKybState(orgId, next, 'PROVIDER'),
    },
    { raw, digest: request.headers.get('x-payload-digest'), alg: request.headers.get('x-payload-digest-alg') },
  );
  if (result.status === 403) console.warn('[sumsub] refused an unverified webhook');
  return Response.json(result.body, { status: result.status, headers: NO_STORE });
}

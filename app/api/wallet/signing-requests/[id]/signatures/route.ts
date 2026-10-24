import { readJsonBody } from '@/lib/server/http';
import { RATE_LIMITS, enforceRateLimit } from '@/lib/server/rate-limit';
import { asResponse, walletRoute } from '@/lib/server/wallet-route';
import { submitPartialSignature } from '@/lib/server/wallet-signing';

export const dynamic = 'force-dynamic';

/**
 * One signer's partial signature over the request's exact bytes, with the
 * digest they reviewed. Checked against the stored bytes and the signer's own
 * key; at the threshold the server combines, simulates, sponsors and submits.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const limited = await enforceRateLimit({ rule: RATE_LIMITS.stablecoinSubmitUser, key: gate.route.authority.userId });
  if (limited) return limited;
  const { id } = await params;
  const body = await readJsonBody(request);
  const result = await submitPartialSignature(gate.route.ctx.signing, {
    orgId: gate.route.orgId,
    userId: gate.route.authority.userId,
    id,
    signature: String(body.signature ?? ''),
    digest: String(body.digest ?? ''),
  });
  return asResponse(result, result.ok ? { request: result.request } : undefined);
}

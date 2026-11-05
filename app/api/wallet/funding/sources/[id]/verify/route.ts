import { readJsonBody } from '@/lib/server/http';
import { verifyWalletSource } from '@/lib/server/wallet-funding';
import { fundingResponse, fundingRoute, limitFunding, requireFundingOwner } from '@/lib/server/wallet-funding-route';
import { refusal } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * POST { challengeId, signature }  the wallet's signature over the
 *      challenge's exact message. The challenge is spent whether or not the
 *      signature is good. Deposits the wallet already sent, held as
 *      unverified, are looked at again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const f = gate.funding;
  const owner = requireFundingOwner(f, 'verify a funding wallet');
  if (owner) return owner;
  const limited = await limitFunding(f);
  if (limited) return limited;
  const { id } = await params;
  const body = await readJsonBody(request);
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';
  if (!challengeId || !signature) return refusal(400, 'Send the challenge and the wallet’s signature over it.', 'bad_proof');
  return fundingResponse(await verifyWalletSource(f.deps, { userId: f.route.authority.userId, sourceId: id, challengeId, signature }));
}

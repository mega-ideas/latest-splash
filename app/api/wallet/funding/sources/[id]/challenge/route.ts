import { walletSourceChallenge } from '@/lib/server/wallet-funding';
import { fundingResponse, fundingRoute, limitFunding, requireFundingOwner } from '@/lib/server/wallet-funding-route';

export const dynamic = 'force-dynamic';

/**
 * POST  the message an owner signs with a funding wallet to prove the
 *       business controls it: it names the business, chain and address, and
 *       carries a single-use nonce and a 15-minute expiry.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const owner = requireFundingOwner(gate.funding, 'verify a funding wallet');
  if (owner) return owner;
  const limited = await limitFunding(gate.funding);
  if (limited) return limited;
  const { id } = await params;
  return fundingResponse(await walletSourceChallenge(gate.funding.deps, id));
}

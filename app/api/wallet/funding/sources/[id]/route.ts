import { revokeFundingSource } from '@/lib/server/wallet-funding';
import { fundingResponse, fundingRoute, limitFunding, requireFundingOwner } from '@/lib/server/wallet-funding-route';

export const dynamic = 'force-dynamic';

/** DELETE  an owner removes a funding source. Later deposits from it are held. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const owner = requireFundingOwner(gate.funding, 'remove a funding source');
  if (owner) return owner;
  const limited = await limitFunding(gate.funding);
  if (limited) return limited;
  const { id } = await params;
  return fundingResponse(await revokeFundingSource(gate.funding.deps, id, gate.funding.route.authority.userId));
}

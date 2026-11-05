import { recheckDeposit } from '@/lib/server/wallet-funding';
import { fundingResponse, fundingRoute, limitFunding } from '@/lib/server/wallet-funding-route';
import { requireFundsAccess } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * POST  look at a held deposit again: its source may be verified now, or
 *       screening may answer. A blocked deposit stays blocked, and nothing
 *       clears without a screening provider's answer.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const noAccess = await requireFundsAccess(gate.funding.route, 'add_funds', 'recheck a deposit');
  if (noAccess) return noAccess;
  const limited = await limitFunding(gate.funding);
  if (limited) return limited;
  const { id } = await params;
  return fundingResponse(await recheckDeposit(gate.funding.deps, id));
}

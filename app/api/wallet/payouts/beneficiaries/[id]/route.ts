import { revokePayoutBeneficiary } from '@/lib/server/partner-payouts';
import { limitWalletRequests, requireOwner } from '@/lib/server/wallet-route';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/** DELETE: an owner removes a supplier's bank account; payouts to it not yet sent are cancelled. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const owner = requireOwner(gate.route, "remove a supplier's bank account");
  if (owner) return owner;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const { id } = await params;
  return withdrawalResponse(await revokePayoutBeneficiary(gate.deps, gate.route.authority.userId, id));
}

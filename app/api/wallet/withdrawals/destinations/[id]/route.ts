import { limitWalletRequests, requireOwner } from '@/lib/server/wallet-route';
import { revokeWithdrawalDestination } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/** DELETE: an owner removes one of the business's bank accounts. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const owner = requireOwner(gate.route, 'remove a bank account');
  if (owner) return owner;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const { id } = await params;
  return withdrawalResponse(await revokeWithdrawalDestination(gate.deps, gate.route.authority.userId, id));
}

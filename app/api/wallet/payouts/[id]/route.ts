import { getPartnerPayout } from '@/lib/server/partner-payouts';
import { requirePayoutReader } from '@/lib/server/wallet-route';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/** GET one supplier payout of this business (owners and staff): another business's id reads as absent. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  const { id } = await params;
  return withdrawalResponse(await getPartnerPayout(gate.deps, id));
}

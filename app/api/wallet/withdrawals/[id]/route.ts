import { getWithdrawal } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/** GET one withdrawal of this business: another business's id reads as absent. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const { id } = await params;
  return withdrawalResponse(await getWithdrawal(gate.deps, id));
}

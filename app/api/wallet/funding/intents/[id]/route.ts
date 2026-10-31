import { cancelFundingIntent, getFundingIntent } from '@/lib/server/wallet-funding';
import { fundingResponse, fundingRoute, refuseViewer } from '@/lib/server/wallet-funding-route';

export const dynamic = 'force-dynamic';

/**
 * GET     one top-up of this business (another business's reads as absent).
 * DELETE  cancel it while it still waits for funds. Money that arrives
 *         later is still recorded and screened.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const { id } = await params;
  return fundingResponse(await getFundingIntent(gate.funding.deps, id));
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const viewer = refuseViewer(gate.funding, 'cancel a top-up');
  if (viewer) return viewer;
  const { id } = await params;
  return fundingResponse(await cancelFundingIntent(gate.funding.deps, id));
}

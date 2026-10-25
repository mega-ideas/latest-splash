import { readJsonBody } from '@/lib/server/http';
import { listWalletDeposits, recordDeposit } from '@/lib/server/wallet-funding';
import { fundingResponse, fundingRoute, limitFunding, refuseViewer } from '@/lib/server/wallet-funding-route';
import { refusal } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * GET   money that arrived in this business's wallet: held, cleared or
 *       blocked, and why.
 * POST { digest, intentId? }  record what a Sui transaction delivered to the
 *       wallet. Only the digest is taken from the request: the amount, the
 *       coin and the sender are read from the chain. Recorded once per
 *       transaction and coin, however often it is sent; screened on arrival.
 */
export async function GET(request: Request) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  return fundingResponse({ ok: true, deposits: await listWalletDeposits(gate.funding.deps) });
}

export async function POST(request: Request) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const f = gate.funding;
  const viewer = refuseViewer(f, 'record a deposit');
  if (viewer) return viewer;
  const limited = await limitFunding(f);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const digest = typeof body.digest === 'string' ? body.digest.trim() : '';
  if (!digest) return refusal(400, 'Send the Sui transaction digest.', 'bad_digest');
  const intentId = typeof body.intentId === 'string' && body.intentId ? body.intentId : undefined;
  const result = await recordDeposit(f.deps, { digest, intentId });
  return fundingResponse(result, result.ok && result.deposits.some((d) => d.created) ? 201 : 200);
}

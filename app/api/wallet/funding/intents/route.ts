import { readJsonBody } from '@/lib/server/http';
import { createFundingIntent, listFundingIntents } from '@/lib/server/wallet-funding';
import { intentInputFrom } from '@/lib/server/wallet-funding-input';
import { fundingResponse, fundingRoute, limitFunding, refuseViewer } from '@/lib/server/wallet-funding-route';
import { refusal } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * GET   this business's top-ups, newest first.
 * POST  one top-up. Send an `Idempotency-Key` header (or `clientKey`): the
 *       same key returns the same top-up and never opens a second one, and a
 *       key reused for a different top-up is refused. Send
 *       `acceptedArrivesMinMinor`, the least the quote you accepted said
 *       would arrive: if the fresh quote is worse, nothing is made and the
 *       new quote comes back to look at. `purpose: 'transfer_top_up'` with
 *       `transferRef` is Transfer's step 3.
 */
export async function GET(request: Request) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  return fundingResponse({ ok: true, intents: await listFundingIntents(gate.funding.deps) });
}

export async function POST(request: Request) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const f = gate.funding;
  const viewer = refuseViewer(f, 'add funds');
  if (viewer) return viewer;
  const limited = await limitFunding(f);
  if (limited) return limited;
  const input = intentInputFrom(await readJsonBody(request), { userId: f.route.authority.userId, idempotencyKey: request.headers.get('idempotency-key') });
  if (!input) return refusal(400, 'Choose how to add funds.', 'bad_channel');
  const result = await createFundingIntent(f.deps, input);
  return fundingResponse(result, result.ok && result.created ? 201 : 200);
}

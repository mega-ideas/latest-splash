import { readJsonBody } from '@/lib/server/http';
import { addFundingSource, listFundingSources, type AddSourceInput } from '@/lib/server/wallet-funding';
import { fundingResponse, fundingRoute, limitFunding, requireFundingOwner } from '@/lib/server/wallet-funding-route';
import { refusal } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * GET   this business's funding sources.
 * POST  an owner adds one:
 *         { kind: 'bank_account', holderName, country, bankCode, accountNumber }
 *           must be in the company's name; only a fingerprint and the last
 *           four digits are kept. Checked once on its first deposit.
 *         { kind: 'card', provider, providerFingerprint, last4, holderName }
 *           the card as the funding partner identifies it; never its number.
 *         { kind: 'wallet', chain: 'SUI' | 'SOLANA' | 'EVM', address }
 *           pending until the business signs Splash's message with it
 *           (POST /sources/:id/challenge, then /sources/:id/verify).
 */
export async function GET(request: Request) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  return fundingResponse({ ok: true, sources: await listFundingSources(gate.funding.deps) });
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

export async function POST(request: Request) {
  const gate = await fundingRoute(request);
  if (gate.response) return gate.response;
  const f = gate.funding;
  const owner = requireFundingOwner(f, 'add a funding source');
  if (owner) return owner;
  const limited = await limitFunding(f);
  if (limited) return limited;
  const body = await readJsonBody(request);
  let input: AddSourceInput;
  if (body.kind === 'bank_account') input = { kind: 'bank_account', holderName: s(body.holderName), country: s(body.country), bankCode: s(body.bankCode), accountNumber: s(body.accountNumber), label: s(body.label) };
  else if (body.kind === 'card') input = { kind: 'card', provider: s(body.provider), providerFingerprint: s(body.providerFingerprint), last4: s(body.last4), holderName: s(body.holderName), label: s(body.label) };
  else if (body.kind === 'wallet') input = { kind: 'wallet', chain: s(body.chain), address: s(body.address), label: s(body.label) };
  else return refusal(400, 'A funding source is a bank account, a card or a wallet.', 'bad_kind');
  const result = await addFundingSource(f.deps, f.route.authority.userId, input);
  return fundingResponse(result, result.ok && result.created ? 201 : 200);
}

import { readJsonBody } from '@/lib/server/http';
import { limitWalletRequests, requireOwner } from '@/lib/server/wallet-route';
import { addWithdrawalDestination, listWithdrawalDestinations } from '@/lib/server/withdrawals';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/**
 * GET   the business's own bank accounts (last four digits only).
 * POST  an owner adds one: { holderName, country, bankCode, accountNumber,
 *       label? }. Kept only when the name given and the bank's own holder
 *       name both match the business's registered name; the number is sealed.
 */
export async function GET(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  return withdrawalResponse({ ok: true, destinations: await listWithdrawalDestinations(gate.deps) });
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

export async function POST(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const owner = requireOwner(gate.route, 'add a bank account to withdraw to');
  if (owner) return owner;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await addWithdrawalDestination(gate.deps, gate.route.authority.userId, {
    holderName: s(body.holderName),
    country: s(body.country),
    bankCode: s(body.bankCode),
    accountNumber: s(body.accountNumber),
    label: s(body.label),
  });
  return withdrawalResponse(result, result.ok && result.created ? 201 : 200);
}

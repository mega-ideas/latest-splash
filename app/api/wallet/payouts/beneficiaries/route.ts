import { readJsonBody } from '@/lib/server/http';
import { addPayoutBeneficiary, listPayoutBeneficiaries } from '@/lib/server/partner-payouts';
import { limitWalletRequests, requireOwner, requirePayoutReader } from '@/lib/server/wallet-route';
import { withdrawalResponse, withdrawalRoute } from '@/lib/server/withdrawals-deps';

export const dynamic = 'force-dynamic';

/**
 * GET   this business's suppliers' bank accounts (last four digits only).
 * POST  an owner adds one: { holderName, country, bankCode, accountNumber,
 *       address: { streetName?, buildingNumber?, postCode?, townName,
 *       countrySubDivision?, country }, registrationNumber?,
 *       registrationScheme?, relationship, partner?, label? }. Kept only when
 *       the bank's own holder name matches the name given; the number and the
 *       supplier's address are sealed.
 */
export async function GET(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const reader = requirePayoutReader(gate.route);
  if (reader) return reader;
  return withdrawalResponse({ ok: true, beneficiaries: await listPayoutBeneficiaries(gate.deps) });
}

const s = (v: unknown) => (typeof v === 'string' ? v : '');

export async function POST(request: Request) {
  const gate = await withdrawalRoute(request);
  if (gate.response) return gate.response;
  const owner = requireOwner(gate.route, "add a supplier's bank account");
  if (owner) return owner;
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const body = await readJsonBody(request);
  const result = await addPayoutBeneficiary(gate.deps, gate.route.authority.userId, {
    partner: s(body.partner),
    holderName: s(body.holderName),
    country: s(body.country),
    bankCode: s(body.bankCode),
    accountNumber: s(body.accountNumber),
    address: body.address,
    registrationNumber: s(body.registrationNumber),
    registrationScheme: s(body.registrationScheme),
    relationship: body.relationship,
    label: s(body.label),
  });
  return withdrawalResponse(result, result.ok && result.created ? 201 : 200);
}

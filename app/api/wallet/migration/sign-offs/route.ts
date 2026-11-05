import { readJsonBody } from '@/lib/server/http';
import { prepareMigrationSignOff } from '@/lib/server/wallet-authority';
import { orgMemberWalletAddresses } from '@/lib/server/wallet-deps';
import { asResponse, limitWalletRequests, refusal, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * A staff member's migration needs the highest authority's sign-off (Sky,
 * 25 Oct). POST { memberUserId, fromAddress }: an owner or the person in
 * charge starts one. The source must be one of that member's passkey
 * addresses in this business, and the destination is the business wallet the
 * BusinessAccount names on chain. Splash answers with the statement for the
 * approver's passkey to sign (POST /api/wallet/migration/sign-offs/:id).
 */
export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  // Each sign-off writes a row and an append-only event.
  const limited = await limitWalletRequests(gate.route);
  if (limited) return limited;
  const { orgId, authority, ctx, db } = gate.route;
  const body = await readJsonBody(request);
  const memberUserId = String(body.memberUserId ?? '').trim();
  const fromAddress = String(body.fromAddress ?? '').trim().toLowerCase();
  const theirs = (await orgMemberWalletAddresses(db, orgId)).find((a) => a.userId === memberUserId && a.address === fromAddress);
  if (!theirs) return refusal(404, 'That member has no passkey wallet at this address in this business.');
  let wallet: string | null;
  try {
    wallet = (await ctx.readAccount()).wallet;
  } catch {
    return refusal(502, 'The business account could not be read from the chain.');
  }
  if (!wallet) return refusal(409, 'Register the business wallet first.');
  const result = await prepareMigrationSignOff(db, { orgId, actorUserId: authority.userId, memberUserId, fromAddress: theirs.address, toWallet: wallet });
  return asResponse(result, result.ok ? { signOff: result.signOff } : undefined);
}

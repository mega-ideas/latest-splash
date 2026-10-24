import { readJsonBody } from '@/lib/server/http';
import { signMigrationSignOff } from '@/lib/server/wallet-authority';
import { orgMemberWalletAddresses } from '@/lib/server/wallet-deps';
import { asResponse, refusal, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * POST { signature }: the approver's passkey signature over the sign-off
 * statement. It must verify under the approver's own active passkey on this
 * site, read here, never taken from the request.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const { orgId, authority, db } = gate.route;
  const { id } = await params;
  const body = await readJsonBody(request);
  const me = (await orgMemberWalletAddresses(db, orgId)).find((a) => a.userId === authority.userId && a.canSign);
  if (!me) return refusal(403, 'Add a passkey on this site first: the sign-off is signed with it.');
  return asResponse(await signMigrationSignOff(db, { orgId, actorUserId: authority.userId, id, signature: String(body.signature ?? ''), signerAddress: me.address }));
}

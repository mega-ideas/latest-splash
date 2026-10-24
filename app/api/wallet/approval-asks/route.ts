import { askOwnersToApprove, listApprovalAsks } from '@/lib/server/payment-approval-asks';
import { readJsonBody } from '@/lib/server/http';
import { orgMemberWalletAddresses } from '@/lib/server/wallet-deps';
import { asResponse, limitWalletRequests, NO_STORE, walletRoute } from '@/lib/server/wallet-route';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Asking the owners to approve a payment (Sky, 25 Oct: staff can ask).
 *
 * GET   owners and approvers: every ask in this business; anyone else: their own.
 * POST  { intentId, contentHash, walrusBlobId, note? }: ask the owners about
 *       one open payment. A staff member asks only about a payment they
 *       opened (its on-chain maker is one of their passkey addresses). The
 *       payment is read from the chain; what owners are shown is that.
 *
 * The org is the session's; an id of another business reads as absent.
 */
export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const asks = await listApprovalAsks(gate.route.db, { orgId: gate.route.orgId, userId: gate.route.authority.userId });
  return NextResponse.json({ asks }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const { orgId, authority, ctx, db } = route;
  const body = await readJsonBody(request);
  const mine = (await orgMemberWalletAddresses(db, orgId)).filter((a) => a.userId === authority.userId).map((a) => a.address);
  const result = await askOwnersToApprove(
    { db, ctx },
    {
      orgId,
      userId: authority.userId,
      intentId: String(body.intentId ?? ''),
      contentHash: String(body.contentHash ?? ''),
      walrusBlobId: String(body.walrusBlobId ?? ''),
      note: typeof body.note === 'string' ? body.note : null,
      requesterAddresses: mine,
    },
  );
  return asResponse(result, result.ok ? { ask: result.ask } : undefined);
}

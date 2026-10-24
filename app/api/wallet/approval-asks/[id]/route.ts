import { currentWalletMembers } from '@/lib/server/business-wallet';
import { readJsonBody } from '@/lib/server/http';
import { acceptApprovalAsk, cancelApprovalAsk, declineApprovalAsk } from '@/lib/server/payment-approval-asks';
import { asResponse, bigintField, limitWalletRequests, refusal, walletRoute } from '@/lib/server/wallet-route';

export const dynamic = 'force-dynamic';

/**
 * One approval ask.
 *
 * POST { action: 'accept', mode, maxFeeMinor, settleByMs }   an owner opens the
 *      signing request that approves it: `wallet_pays` (the quorum pays it
 *      from the business wallet: the open intent, or for a draft a new intent
 *      opened and paid in one transaction) or `second_approval` (the owner's
 *      own second approval, for an intent within the asker's spending rule;
 *      not for a draft). The ask is claimed first, so two owners accepting
 *      at once open one request.
 * POST { action: 'decline', reason? }                        an owner declines it.
 * POST { action: 'withdraw' }                                the asker withdraws it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const route = gate.route;
  const { orgId, authority, ctx, db } = route;
  const { id } = await params;
  const body = await readJsonBody(request);
  const action = String(body.action ?? '');

  if (action === 'withdraw') return asResponse(await cancelApprovalAsk(db, { orgId, userId: authority.userId, askId: id }));
  if (action === 'decline') {
    return asResponse(await declineApprovalAsk(db, { orgId, userId: authority.userId, askId: id, reason: typeof body.reason === 'string' ? body.reason : null }));
  }
  if (action !== 'accept') return refusal(400, 'Say whether you accept, decline or withdraw this.');

  const limited = await limitWalletRequests(route);
  if (limited) return limited;
  const maxFeeMinor = bigintField(body.maxFeeMinor);
  const settleByMs = bigintField(body.settleByMs);
  if (maxFeeMinor === null || settleByMs === null) return refusal(400, 'The fee shown and the quote deadline are needed.');
  const mode = body.mode === 'second_approval' ? 'second_approval' : body.mode === 'wallet_pays' ? 'wallet_pays' : null;
  if (!mode) return refusal(400, 'Choose to pay it from the business wallet or to give a second approval.');

  let wallet;
  if (mode === 'wallet_pays') {
    const current = await currentWalletMembers(ctx, db, orgId);
    if (!current.ok) return asResponse(current);
    wallet = current.members;
  }
  const { spendSecondApprovalOpener } = await import('@/lib/server/spend-rules-deps');
  const result = await acceptApprovalAsk(
    { db, ctx, secondApproval: mode === 'second_approval' ? await spendSecondApprovalOpener(route) : undefined },
    { orgId, userId: authority.userId, askId: id, mode, wallet, maxFeeMinor, settleByMs },
  );
  return asResponse(result, result.ok ? { ask: result.ask, request: result.request } : undefined);
}

import { eq } from 'drizzle-orm';

import { organizations } from '@/lib/db/schema';
import { askOwnersToApprove, listApprovalAsks, type AskDraft, type AskNotifier } from '@/lib/server/payment-approval-asks';
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
 * POST  { draft: { paymentRef, recipient, beneficiaryRef?, amountMinor, kind,
 *       targetCurrency, fxRateUsdLocal, commitment, railCommitment,
 *       expiresAtMs }, contentHash, walrusBlobId, note? }: ask about a payment
 *       the spending rule cannot open (over the asker's maximum, or to a
 *       payee the policy does not list). Its shape is checked; the owners
 *       are shown, from the policy, why it came to them, and only the
 *       wallet's quorum can pay it.
 *
 * The org is the session's; an id of another business reads as absent.
 */
export async function GET(request: Request) {
  const gate = await walletRoute(request);
  if (gate.response) return gate.response;
  const asks = await listApprovalAsks(gate.route.db, { orgId: gate.route.orgId, userId: gate.route.authority.userId });
  return NextResponse.json({ asks }, { headers: NO_STORE });
}

function draftFromBody(value: unknown): AskDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const d = value as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  return {
    paymentRef: text(d.paymentRef),
    recipient: text(d.recipient),
    beneficiaryRef: text(d.beneficiaryRef),
    amountMinor: text(d.amountMinor),
    kind: Number(d.kind),
    targetCurrency: text(d.targetCurrency),
    fxRateUsdLocal: text(d.fxRateUsdLocal),
    commitment: text(d.commitment),
    railCommitment: text(d.railCommitment),
    expiresAtMs: text(d.expiresAtMs),
  };
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
  const draft = draftFromBody(body.draft);
  let policy;
  if (draft) {
    const { liveSpendContext } = await import('@/lib/server/spend-rules-deps');
    const { readCurrentPolicy } = await import('@/lib/server/spend-rules');
    const live = await liveSpendContext(route);
    if (live.ok) policy = () => readCurrentPolicy(live.sc);
  }
  // The owners hear of it on their approver channels; the ask stands either way.
  const notify: AskNotifier = async ({ ask, ownerUserIds }) => {
    const { notifyOwnersOfAsk } = await import('@/lib/server/approval-requests');
    const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
    await notifyOwnersOfAsk({ orgId, orgName: org?.name ?? 'Your business', ownerUserIds, amountMinor: ask.intent.amountMinor, recipient: ask.intent.recipient });
  };
  const result = await askOwnersToApprove(
    { db, ctx, policy, notify },
    {
      orgId,
      userId: authority.userId,
      intentId: draft ? undefined : String(body.intentId ?? ''),
      draft,
      contentHash: String(body.contentHash ?? ''),
      walrusBlobId: String(body.walrusBlobId ?? ''),
      note: typeof body.note === 'string' ? body.note : null,
      requesterAddresses: mine,
    },
  );
  return asResponse(result, result.ok ? { ask: result.ask } : undefined);
}

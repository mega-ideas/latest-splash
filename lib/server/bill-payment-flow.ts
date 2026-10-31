/**
 * The payment flow behind Pay invoices (v2 brief 5.8 into 5.4): what
 * `registerBillPaymentFlow` takes (lib/bills/payment-hook.ts).
 *
 * Approving a supplier's invoice is a payment like any other. `start` makes
 * it through the same service Transfer uses (lib/server/wallet-transfers.ts):
 * to the verified recipient on file, for exactly the amount in USDC, with
 * Splash's fee quoted from the schedule and sent back as its max_fee, the
 * invoice's key as the intent id, and screening, ownership proof and the
 * Splash-address checks made when the payment is built and again when it is
 * signed. An owner's payment goes to the owners to sign; staff ask them.
 *
 * `cancel` drops a payment nobody has signed: the owners' request is
 * withdrawn (only by the person who asked, and only while it is collecting),
 * or the staff member's ask is. A payment already signed or sent cannot be
 * cancelled: it answers 409 and the invoice stays waiting.
 *
 * `reportTransferSettled` runs when the owners' request executes: it
 * compares what the executed transaction paid (recipient and amount, as the
 * signing layer decoded them) with the payment this flow made, and only then
 * tells the invoice it was paid, with the digest and who signed.
 */
import { createHash } from 'node:crypto';

import { and, eq, inArray } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import type { BillPaymentFlow } from '@/lib/bills/payment-hook';
import { users, walletTransfers, walletSigningRequests } from '@/lib/db/schema';
import { recordBillSettlement } from '@/lib/server/bills';
import { cancelApprovalAsk } from '@/lib/server/payment-approval-asks';
import { createTransfer, quoteTransfer, type TransferDeps } from '@/lib/server/wallet-transfers';
import { cancelSigningRequest } from '@/lib/server/wallet-signing';
import type { DrizzleDb, StoredRequest } from '@/lib/server/wallet-signing-store';

type DepsFor = (orgId: string) => Promise<TransferDeps | { ok: false; status: number; error: string }>;

const roleOf = (role: string) => (role === 'FINANCE_ADMIN' ? 'APPROVER' : role);

/** One key per invoice attempt and payload: the bill's own key, in the shape the routes accept. */
export const transferKeyFor = (billKey: string) => `bill_${createHash('sha256').update(billKey).digest('hex').slice(0, 40)}`;

export function makeBillPaymentFlow(depsFor: DepsFor): BillPaymentFlow {
  return {
    wired: true,
    async start(request) {
      const deps = await depsFor(request.orgId);
      if ('ok' in deps) return { ok: false, code: 'REFUSED', status: deps.status, error: deps.error };
      const payee = { kind: 'recipient' as const, recipientId: request.recipientId };
      const quote = await quoteTransfer(deps, { payee, amountMinor: request.amountMicros.toString() });
      if (!quote.ok) return { ok: false, code: 'REFUSED', status: quote.status, error: quote.error };
      const made = await createTransfer(
        deps,
        { userId: request.requestedBy.userId, role: roleOf(request.requestedBy.role) },
        { clientKey: transferKeyFor(request.idempotencyKey), payee, amountMinor: request.amountMicros.toString(), maxFeeMinor: quote.quote.maxFeeMinor, reference: request.supplierInvoiceNumber },
      );
      if (!made.ok) return { ok: false, code: 'REFUSED', status: made.status, error: made.error };
      return { ok: true, paymentIntentId: made.transfer.id };
    },
    async cancel(request) {
      const deps = await depsFor(request.orgId);
      if ('ok' in deps) return { ok: false, status: deps.status, error: deps.error };
      const [row] = await deps.db.select().from(walletTransfers).where(and(eq(walletTransfers.orgId, request.orgId), eq(walletTransfers.id, request.paymentIntentId))).limit(1);
      if (!row) return { ok: true };
      if (row.signingRequestId) {
        const done = await cancelSigningRequest(deps.ctx.signing, { orgId: request.orgId, userId: request.requestedBy.userId, id: row.signingRequestId });
        if (done.ok) return { ok: true };
        // Closed already: cancelled, expired or failed means it can no longer be signed; signed or sent means it cannot be withdrawn.
        const [req] = await deps.db.select({ status: walletSigningRequests.status }).from(walletSigningRequests).where(and(eq(walletSigningRequests.orgId, request.orgId), eq(walletSigningRequests.id, row.signingRequestId))).limit(1);
        if (req && ['cancelled', 'expired', 'failed'].includes(req.status)) return { ok: true };
        if (done.code === 'closed') return { ok: false, status: 409, error: 'The payment has already been signed or sent, so it cannot be withdrawn.' };
        return { ok: false, status: done.status, error: done.error };
      }
      if (row.askId) {
        const done = await cancelApprovalAsk(deps.db, { orgId: request.orgId, userId: request.requestedBy.userId, askId: row.askId, now: deps.now });
        return done.ok ? { ok: true } : { ok: false, status: done.status, error: done.error };
      }
      return { ok: true };
    },
  };
}

/**
 * An executed wallet payment, told to the invoice that made it. Only when the
 * transaction paid what this flow asked: the recipient and the amount the
 * signing layer decoded from its bytes. Idempotent (the invoice's own record
 * is). Nothing happens for a payment no invoice made.
 */
export async function reportTransferSettled(db: DrizzleDb, request: Pick<StoredRequest, 'id' | 'orgId' | 'status' | 'executedDigest' | 'summary' | 'signers'>, now: Date = new Date(), record: typeof recordBillSettlement = recordBillSettlement): Promise<void> {
  if (request.status !== 'executed' || !request.executedDigest) return;
  const [row] = await db.select().from(walletTransfers).where(and(eq(walletTransfers.orgId, request.orgId), eq(walletTransfers.signingRequestId, request.id))).limit(1);
  if (!row) return;
  const actions = ((request.summary as { description?: { actions?: Array<{ type: string; recipient?: string; amountMinor?: string }> } } | null)?.description?.actions ?? []);
  const open = actions.find((a) => a.type === 'open_intent');
  if (!open || !open.recipient || normalizeSuiAddress(open.recipient) !== normalizeSuiAddress(row.address) || BigInt(open.amountMinor ?? '-1') !== row.amountMinor) return;
  const signed = request.signers.filter((s) => s.signedAt).map((s) => s.userId);
  const people = signed.length ? await db.select({ name: users.name }).from(users).where(inArray(users.id, signed)) : [];
  await record(db as unknown as Parameters<typeof recordBillSettlement>[0], {
    orgId: request.orgId,
    paymentIntentId: row.id,
    suiDigest: request.executedDigest,
    paidAt: now,
    approvers: people.map((p) => p.name || 'An owner'),
  });
}

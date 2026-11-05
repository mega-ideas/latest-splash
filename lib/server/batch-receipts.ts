/**
 * A batch's receipts (v2 Phase 3, brief 5.6, step "Receipts"): one receipt per
 * payment, each the same fintech receipt a single payment gets (receipt no.,
 * what the payee received, Splash's fee as the chain charged it, who signed,
 * the Sui transaction), and one summary for the batch.
 *
 * For ONE business: another business's batch reads as absent. Nothing is
 * written, and nothing is filled in:
 *   - a batch whose transaction cannot be read is not final, and shows the fee
 *     bound the owners signed, not a fee;
 *   - the fee of each payment is the one the chain charged (the executed
 *     transaction's `FeeCharged` events, one per payment, in the order of the
 *     rows). When the events cannot be matched to the rows (some payments
 *     charged nothing and so emitted none) the bound is shown and the receipt
 *     is not final, rather than a fee given to the wrong row;
 *   - all payments in a batch happen together or not at all, so every receipt
 *     of a batch shares one status and one digest.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';

import { organizations, users, walletBatches, walletBatchRows } from '../db/schema.ts';
import { buildReceipt, type PaymentReceipt, type ReceiptStatus } from '../transfer/receipt.ts';
import { suiScanTxUrlOn } from '../explorer.ts';
import { feesChargedFrom, type ReceiptDeps } from './payment-receipts.ts';
import { readSigningRequest } from './wallet-signing-store.ts';

type Refusal = { ok: false; status: number; code: string; error: string };

export type BatchReceipt = {
  schema: 'splash.batch-receipt.v1';
  batchId: string;
  label: string | null;
  status: ReceiptStatus;
  /** Settled, every fee read from the chain, and a transaction to check: the only final receipt. */
  final: boolean;
  paidFrom: string;
  paidAt: string | null;
  rowCount: number;
  totalSentMinor: string;
  totalFeeMinor: string;
  totalDebitMinor: string;
  approvers: Array<{ name: string; signedAt: string | null }>;
  suiDigest: string | null;
  verifyUrl: string | null;
  /** One per payment, in the order of the sheet. */
  receipts: PaymentReceipt[];
};

export async function batchReceiptsFor(deps: ReceiptDeps, batchId: string): Promise<{ ok: true; batch: BatchReceipt } | Refusal> {
  const [batch] = await deps.db.select().from(walletBatches).where(and(eq(walletBatches.orgId, deps.orgId), eq(walletBatches.id, batchId))).limit(1);
  if (!batch) return { ok: false, status: 404, code: 'batch_not_found', error: 'No such batch.' };
  const rows = await deps.db.select().from(walletBatchRows).where(and(eq(walletBatchRows.orgId, deps.orgId), eq(walletBatchRows.batchId, batchId))).orderBy(asc(walletBatchRows.position));
  const request = batch.signingRequestId ? await readSigningRequest(deps.db, deps.orgId, batch.signingRequestId) : null;

  const [org] = await deps.db.select({ name: organizations.name, legalName: organizations.legalName }).from(organizations).where(eq(organizations.id, deps.orgId)).limit(1);
  const payerName = org?.legalName || org?.name || deps.orgId;

  // A batch nobody has started has nothing to receipt: it is not "on the way".
  if (!request) return { ok: false, status: 409, code: 'batch_not_started', error: 'The signatures for this batch have not been started, so there are no receipts yet.' };
  // Explicit: executed is settled; a request that failed, lapsed or was cancelled did not go through; the rest (collecting, submitting, unknown) is not final.
  const status: ReceiptStatus = request.status === 'executed' ? 'settled' : ['failed', 'expired', 'cancelled'].includes(request.status) ? 'failed' : 'on_the_way';
  const signed = (request.signers ?? []).filter((s) => s.signedAt);
  const people = signed.length ? await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, signed.map((s) => s.userId))) : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name || 'An owner']));
  const approvers = signed.map((s) => ({ name: nameOf.get(s.userId) ?? 'An owner', signedAt: (s.signedAt as Date).toISOString() }));
  const paidAt = status === 'settled' && signed.length ? new Date(Math.max(...signed.map((s) => (s.signedAt as Date).getTime()))).toISOString() : null;

  // The fees the chain charged, one per payment.
  const digest = status === 'settled' ? request.executedDigest ?? null : null;
  let fees: Array<bigint> = rows.map((r) => r.maxFeeMinor);
  let feeRead = false;
  if (digest && deps.corePackageOriginalId) {
    try {
      const tx = await deps.readTransaction(digest);
      if (tx?.success) {
        const charged = feesChargedFrom(tx, deps.corePackageOriginalId);
        if (charged.length === rows.length) {
          fees = charged.map((c) => c.feeMinor);
          feeRead = true;
        } else if (charged.length === 0) {
          fees = rows.map(() => 0n);
          feeRead = true;
        }
      }
    } catch {
      /* the bounds stay, and the receipts are not final */
    }
  }

  const receipts = rows.map((r, i) =>
    buildReceipt({
      paymentRef: r.paymentRef,
      status: status === 'settled' && !feeRead && digest ? 'on_the_way' : status,
      createdAt: batch.createdAt.toISOString(),
      paidAt,
      payer: { name: payerName },
      payee: r.payeeKind === 'splash_business'
        ? { kind: 'splash_business', name: r.payeeName, masked: r.payeeMasked, country: r.payeeCountry }
        : { kind: 'wallet', wallet: r.payeeKind, name: r.payeeName, masked: r.payeeMasked, country: r.payeeCountry },
      sendMinor: r.amountMinor.toString(),
      splashFee: { minor: fees[i].toString(), kind: r.feeKind, feesOn: deps.feesOn !== false },
      schedule: deps.schedule,
      receive: null,
      partnerFees: [],
      approvers,
      suiDigest: digest,
      network: deps.network,
      signedPartners: deps.signedPartners,
      reference: r.reference,
    }),
  );
  const sent = rows.reduce((s, r) => s + r.amountMinor, 0n);
  const fee = receipts.reduce((s, r) => s + BigInt(r.fees.splash.minor), 0n);
  const final = receipts.length > 0 && receipts.every((r) => r.final);
  return {
    ok: true,
    batch: {
      schema: 'splash.batch-receipt.v1',
      batchId,
      label: batch.label,
      status: receipts[0]?.status ?? status,
      final,
      paidFrom: payerName,
      paidAt,
      rowCount: rows.length,
      totalSentMinor: sent.toString(),
      totalFeeMinor: fee.toString(),
      totalDebitMinor: (sent + fee).toString(),
      approvers,
      suiDigest: digest,
      verifyUrl: digest ? suiScanTxUrlOn(deps.network, digest) : null,
      receipts,
    },
  };
}

/** The batch's receipts as a CSV a business can hand to its accountant: one line per payment. */
export function batchReceiptsCsv(b: BatchReceipt): string {
  // A cell a spreadsheet would read as a formula is written as text.
  const q = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;
  const major = (minor: string) => {
    const n = BigInt(minor);
    return `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0')}`;
  };
  const lines = ['receipt_no,payee,address,amount_usdc,splash_fee_usdc,reference,status,sui_digest'];
  for (const r of b.receipts) {
    lines.push([r.receiptNo, q(r.payee.name), q(r.payee.masked ?? ''), major(r.sendMinor), major(r.fees.splash.minor), q(r.reference ?? ''), r.status, r.suiDigest ?? ''].join(','));
  }
  return lines.join('\n');
}

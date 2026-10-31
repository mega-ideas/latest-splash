/**
 * One payment's receipt, for ONE business (v2 brief 5.4 step 5).
 *
 * Built on the controls evidence (lib/server/controls-evidence.ts), which
 * already finds a payment by its signing request, payout or intent id for
 * this org only (another business's reads as absent) and reads the chain
 * without writing it. This adds what a receipt shows that the evidence does
 * not: who the payee is by name, who signed by name, the Splash fee the chain
 * actually charged (read from the executed transaction's `FeeCharged`
 * event, never taken from the bound the owners signed), and the paying
 * business's registered name.
 *
 * Nothing is filled in. A transaction that cannot be read leaves the fee at
 * the bound the owners signed and the receipt not final; a payment whose
 * agreement with its partner is not signed names no partner.
 */
import { eq, inArray } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { organizations, users } from '../db/schema.ts';
import type { FeeSchedule } from '../fees/schedule.ts';
import { FEE_KIND } from '../fees/schedule.ts';
import { buildReceipt, type PaymentReceipt, type ReceiptInput, type ReceiptStatus } from '../transfer/receipt.ts';
import { controlsEvidenceFor, type EvidenceDeps } from './controls-evidence.ts';
import { transferForRequest } from './transfer-lookup.ts';
import { getDestination, withdrawalBySigningRequest, getWithdrawalRow } from './withdrawals-store.ts';
import type { WithdrawalChainTx } from './withdrawals.ts';

export type ReceiptDeps = EvidenceDeps & {
  schedule: FeeSchedule | null;
  /** Whether Splash's fees are on (FeeConfig). Null when it could not be read. */
  feesOn: boolean | null;
  signedPartners: readonly string[];
  network: 'mainnet' | 'testnet';
};

type Refusal = { ok: false; status: number; code: string; error: string };

/** The fee the chain charged, from the executed transaction's FeeCharged event. Null when it carries none. */
export function feeChargedFrom(tx: Pick<WithdrawalChainTx, 'events'>, corePackageOriginalId: string): { feeMinor: bigint; kind: number } | null {
  for (const e of tx.events ?? []) {
    const [addr, ...rest] = e.eventType.split('::');
    let same = false;
    try {
      same = normalizeSuiAddress(addr) === normalizeSuiAddress(corePackageOriginalId);
    } catch {
      same = false;
    }
    if (!same || rest.join('::') !== 'fee_config::FeeCharged') continue;
    const j = (e.json ?? {}) as { fee?: unknown; derived_kind?: unknown };
    if ((typeof j.fee === 'string' || typeof j.fee === 'number') && /^\d+$/.test(String(j.fee))) {
      return { feeMinor: BigInt(j.fee), kind: Number(j.derived_kind ?? 0) };
    }
  }
  return null;
}

/** Every fee the chain charged in one executed transaction, in the order it charged them (a batch pays several). */
export function feesChargedFrom(tx: Pick<WithdrawalChainTx, 'events'>, corePackageOriginalId: string): Array<{ feeMinor: bigint; kind: number }> {
  const out: Array<{ feeMinor: bigint; kind: number }> = [];
  for (const e of tx.events ?? []) {
    const [addr, ...rest] = e.eventType.split('::');
    let same = false;
    try {
      same = normalizeSuiAddress(addr) === normalizeSuiAddress(corePackageOriginalId);
    } catch {
      same = false;
    }
    if (!same || rest.join('::') !== 'fee_config::FeeCharged') continue;
    const j = (e.json ?? {}) as { fee?: unknown; derived_kind?: unknown };
    if ((typeof j.fee === 'string' || typeof j.fee === 'number') && /^\d+$/.test(String(j.fee))) out.push({ feeMinor: BigInt(j.fee), kind: Number(j.derived_kind ?? 0) });
  }
  return out;
}

const SETTLED_WITHDRAWAL = new Set(['sent', 'partner_received', 'paid_out']);

function statusOf(requestStatus: string | null, withdrawalStatus: string | null): ReceiptStatus {
  if (withdrawalStatus) {
    if (SETTLED_WITHDRAWAL.has(withdrawalStatus)) return 'settled';
    if (['failed', 'returned', 'cancelled'].includes(withdrawalStatus)) return 'failed';
    return 'on_the_way';
  }
  if (requestStatus === 'executed') return 'settled';
  if (requestStatus === 'failed' || requestStatus === 'expired' || requestStatus === 'cancelled') return 'failed';
  return 'on_the_way';
}

export type ReceiptFor = {
  ok: true;
  receipt: PaymentReceipt;
  payerCountry: string | null;
  supplierCountry: string | null;
  payerName: string;
};

export async function paymentReceiptFor(deps: ReceiptDeps, ref: string, userId: string): Promise<ReceiptFor | Refusal> {
  const found = await controlsEvidenceFor(deps, ref, userId);
  if (!found.ok) return found;
  const ev = found.evidence;

  const [org] = await deps.db
    .select({ name: organizations.name, legalName: organizations.legalName, country: organizations.addressCountry })
    .from(organizations)
    .where(eq(organizations.id, deps.orgId))
    .limit(1);
  const payerName = org?.legalName || org?.name || deps.orgId;

  const requestId = ev.approval?.signingRequestId ?? null;
  const transfer = requestId ? await transferForRequest(deps.db, deps.orgId, requestId) : null;
  const withdrawal = ev.payment.ref.startsWith('wdr_')
    ? await getWithdrawalRow(deps.db, deps.orgId, ev.payment.ref)
    : requestId
      ? await withdrawalBySigningRequest(deps.db, deps.orgId, requestId)
      : null;

  let payee: ReceiptInput['payee'];
  let reference: string | null = null;
  let feeKind: number;
  if (transfer) {
    payee = transfer.payeeKind === 'splash_business'
      ? { kind: 'splash_business', name: transfer.payeeName, masked: transfer.payeeMasked, country: transfer.payeeCountry }
      : { kind: 'wallet', wallet: transfer.payeeKind, name: transfer.payeeName, masked: transfer.payeeMasked, country: transfer.payeeCountry };
    reference = transfer.reference;
    feeKind = transfer.feeKind;
  } else if (withdrawal) {
    const dest = await getDestination(deps.db, deps.orgId, withdrawal.destinationId);
    payee = { kind: 'bank', name: dest?.holderName ?? 'Bank account', masked: dest ? `••${dest.last4}` : null, country: dest?.country ?? null };
    feeKind = FEE_KIND.BANK_PAYOUT;
  } else {
    return { ok: false, status: 404, code: 'not_found', error: 'No receipt for that payment.' };
  }

  // Who signed, by name.
  const signed = (ev.approval?.signers ?? []).filter((s) => s.signedAt);
  const people = signed.length ? await deps.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, signed.map((s) => s.userId))) : [];
  const nameOf = new Map(people.map((p) => [p.id, p.name || 'An owner']));
  const approvers = signed.map((s) => ({ name: nameOf.get(s.userId) ?? 'An owner', signedAt: s.signedAt }));

  // The fee the chain charged.
  const digest = ev.chain.suiDigest;
  let feeMinor = BigInt(ev.payment.maxFeeMinor ?? '0');
  let feeRead = false;
  if (digest && deps.corePackageOriginalId) {
    try {
      const tx = await deps.readTransaction(digest);
      if (tx?.success) {
        const charged = feeChargedFrom(tx, deps.corePackageOriginalId);
        feeMinor = charged ? charged.feeMinor : 0n;
        feeRead = true;
      }
    } catch {
      /* the bound stays, and the receipt is not final */
    }
  }

  const status = statusOf(ev.approval?.status ?? null, withdrawal?.status ?? null);
  const quote = ev.quote;
  const receipt = buildReceipt({
    paymentRef: ev.payment.ref,
    status: status === 'settled' && !feeRead && digest ? 'on_the_way' : status,
    createdAt: ev.payment.createdAt,
    paidAt: status === 'settled' ? ev.approvedAt : null,
    payer: { name: payerName },
    payee,
    sendMinor: ev.payment.amountMinor,
    splashFee: { minor: feeMinor.toString(), kind: feeKind, feesOn: deps.feesOn !== false },
    schedule: deps.schedule,
    receive: quote ? { currency: quote.currency, minor: quote.receiveMinor, rateMicro: quote.rateMicro } : null,
    partnerFees: (quote?.partnerFees as Array<{ partner: string | null; label: string | null; currency: string | null; amountMinor: string | null }> | undefined)
      ?.filter((f) => f.amountMinor && f.currency)
      .map((f) => ({ partner: /^circle$/i.test(f.partner ?? '') ? 'circle' : 'partner', label: f.label ?? 'Fee', currency: f.currency as string, amountMinor: f.amountMinor as string })) ?? [],
    approvers,
    suiDigest: digest,
    network: deps.network,
    partnerReference: withdrawal && ev.partner?.reference ? { partner: withdrawal.partner, reference: ev.partner.reference } : null,
    signedPartners: deps.signedPartners,
    reference,
    bankCredit: withdrawal ? (withdrawal.status === 'paid_out' ? 'credited' : ['failed', 'returned'].includes(withdrawal.status) ? 'failed' : 'pending') : null,
  });
  return { ok: true, receipt, payerCountry: org?.country ?? null, supplierCountry: payee.country ?? null, payerName };
}

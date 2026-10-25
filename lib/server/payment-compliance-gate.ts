/**
 * The compliance check before each signature on a payment (v2 §4.6), run by
 * the signing layer's `beforeSign` (lib/server/wallet-deps.ts):
 *
 *   screening     the recipient's newest screening at this business must
 *                 still be a fresh CLEAR (lib/server/kyt-screenings.ts
 *                 recipientScreeningGate): a payment opened before a BLOCK
 *                 is not signed after it. Wallet payments and an owner's
 *                 second approval of a rule payment.
 *   Travel Rule   a wallet payment to an exchange recipient is not signed
 *                 until its Travel Rule message is with the provider: no
 *                 message (or one not yet accepted) refuses, `on_hold`
 *                 holds, `rejected` refuses. A recipient is an exchange's
 *                 when the payment says so (kind EXCHANGE), when this
 *                 business screened the address as an exchange recipient,
 *                 or when a message was already started for the payment,
 *                 so sending it as kind WALLET does not avoid the check.
 *   Recipient     the saved recipient's own rule (v2 §4.7,
 *                 lib/server/wallet-recipients.ts walletDeliveryGate): kind
 *                 WALLET only to a proven, owner-approved wallet the
 *                 supplier holds, kind EXCHANGE only to an owner-approved
 *                 exchange account the exchange confirmed (an approved
 *                 Travel Rule message; until then `submitted` and
 *                 `awaiting_counterparty` do not let the first payment be
 *                 signed). Never an address Splash controls or one of the
 *                 business's own. A proof withdrawn after the payment
 *                 opened stops it here.
 *
 * The signature that completes the quorum passes through here too, so the
 * check also holds at submission. Reads only; nothing is signed or sent.
 */
import { and, eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { kytScreenings } from '../db/schema.ts';
import type { KytProvider } from '../compliance/kyt.ts';
import type { WalletTxDescription } from '../wallet/wallet-tx-describe.ts';
import { paymentOfDescription } from './controls-evidence.ts';
import { recipientScreeningGate } from './kyt-screenings.ts';
import { walletDeliveryGate } from './wallet-recipients.ts';
import { readTravelRuleTransfer } from './travel-rule-transfers.ts';
import type { DrizzleDb, StoredRequest } from './wallet-signing-store.ts';

/** splash_core's payment kind for an exchange deposit address (V2_KIND.EXCHANGE). */
export const EXCHANGE_KIND = 2;

export type PaymentGateDeps = {
  db: DrizzleDb;
  now: () => Date;
  /** The server's screening provider: a stale CLEAR is screened again. */
  kyt?: KytProvider | null;
  maxAgeMs?: number;
};

type GateRefusal = { code: string; error: string };

type OpenIntentSummary = { intentId?: string; recipient?: string; kind?: number };

/** Where a payment request's USDC goes, its kind, and the reference its Travel Rule message is kept under. */
export function paymentOfRequest(request: StoredRequest): { recipient: string; kind: number | null; paymentRef: string } | null {
  const summary = (request.summary ?? null) as { description?: WalletTxDescription; openIntent?: OpenIntentSummary } | null;
  const described = paymentOfDescription(summary?.description);
  const open = summary?.description?.actions?.find((a) => a.type === 'open_intent');
  const pay = summary?.description?.actions?.find((a) => a.type === 'pay_intent');
  const bound = summary?.openIntent;
  const recipient = described?.recipient ?? bound?.recipient ?? null;
  if (!recipient) return null;
  let kind: number | null = null;
  if (open && open.type === 'open_intent') kind = open.kind;
  else if (pay && pay.type === 'pay_intent' && pay.intent) kind = pay.intent.kind;
  else if (typeof bound?.kind === 'number') kind = bound.kind;
  const intentId = described?.intentId ?? bound?.intentId ?? null;
  return { recipient: normalizeSuiAddress(recipient), kind, paymentRef: intentId ? normalizeSuiAddress(intentId) : request.id };
}

async function screenedAsExchange(db: DrizzleDb, orgId: string, address: string): Promise<boolean> {
  const [row] = await db
    .select({ id: kytScreenings.id })
    .from(kytScreenings)
    .where(and(eq(kytScreenings.orgId, orgId), eq(kytScreenings.chain, 'SUI'), eq(kytScreenings.address, address), eq(kytScreenings.subjectKind, 'exchange_recipient')))
    .limit(1);
  return Boolean(row);
}

/** Whether this payment goes to an exchange, by what the server holds. */
export async function paysAnExchange(db: DrizzleDb, request: StoredRequest, payment: { recipient: string; kind: number | null; paymentRef: string }): Promise<boolean> {
  if (payment.kind === EXCHANGE_KIND) return true;
  if (await screenedAsExchange(db, request.orgId, payment.recipient)) return true;
  return Boolean(await readTravelRuleTransfer(db, request.orgId, payment.paymentRef));
}

const ACCEPTED = new Set(['submitted', 'awaiting_counterparty', 'approved']);

/** The Travel Rule half: null when the payment may be signed. */
export async function travelRuleHold(db: DrizzleDb, request: StoredRequest, payment: { recipient: string; kind: number | null; paymentRef: string }): Promise<GateRefusal | null> {
  if (!(await paysAnExchange(db, request, payment))) return null;
  const row = await readTravelRuleTransfer(db, request.orgId, payment.paymentRef);
  if (row && row.providerRef && ACCEPTED.has(row.status)) return null;
  if (row?.status === 'rejected') return { code: 'travel_rule_rejected', error: "The exchange's Travel Rule check rejected this payment. It will not be signed." };
  if (row?.status === 'on_hold') return { code: 'travel_rule_on_hold', error: "The exchange's Travel Rule check has put this payment on hold. It can be signed once the hold is lifted." };
  return { code: 'travel_rule_missing', error: 'This payment goes to an exchange: send its Travel Rule message first, then sign.' };
}

/** Before each signature on a payment: null lets the signature through. */
export async function paymentBeforeSign(deps: PaymentGateDeps, request: StoredRequest): Promise<GateRefusal | null> {
  if (request.purpose !== 'wallet_payment' && request.purpose !== 'spend_approval') return null;
  const payment = paymentOfRequest(request);
  if (!payment) return { code: 'not_a_payment', error: 'The request does not describe a payment Splash can check, so it is not signed.' };
  const screened = await recipientScreeningGate(
    { db: deps.db, orgId: request.orgId, now: deps.now(), kyt: deps.kyt ?? null, ...(deps.maxAgeMs ? { maxAgeMs: deps.maxAgeMs } : {}), requestedBy: 'splash:before-sign' },
    payment.recipient,
  );
  if (screened) return { code: screened.code, error: screened.error };
  // The saved recipient's own rule (v2 §4.7): a proof withdrawn, or a
  // recipient removed, after the payment was opened stops its signature.
  if (payment.kind !== null || request.purpose === 'wallet_payment') {
    const delivery = await walletDeliveryGate(deps.db, request.orgId, payment.recipient, payment.kind, { stage: 'sign' });
    if (delivery) return { code: delivery.code, error: delivery.error };
  }
  // A rule payment's message is not a signing request of its own yet; only wallet payments carry one.
  if (request.purpose === 'wallet_payment') return travelRuleHold(deps.db, request, payment);
  return null;
}

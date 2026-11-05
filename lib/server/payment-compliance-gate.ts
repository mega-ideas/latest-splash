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
 *   Exchange alone  a staff member's payment to an exchange account under
 *                 their rule (kind EXCHANGE, purpose staff_rule_payment) is
 *                 signed only while an owner's switch "Can pay exchange
 *                 accounts alone" is still on for that person (read now, so
 *                 an owner who turns it off stops a payment already opened),
 *                 and only with the message the person confirmed still on
 *                 record and still matching the bytes: the account and the
 *                 amount the transaction pays, the payment reference it
 *                 carries and the commitment it carries, derived again from
 *                 the stored hash (lib/server/exchange-disclosure.ts). The
 *                 switch is asked first, so it is the reason a person reads.
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
import { exchangeAloneOf } from './exchange-alone.ts';
import { disclosureMismatch, readStoredDisclosure } from './exchange-disclosure.ts';
import { recipientScreeningGate } from './kyt-screenings.ts';
import { isProductionRuntime } from './runtime-mode.ts';
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
  /** The runtime: in production a sandbox screening or Travel Rule message on file is no answer. Default: this process. */
  env?: NodeJS.ProcessEnv;
  /** Splash's own addresses, read now: one added since a batch was opened stops its signatures. */
  splashAddresses?: () => Promise<string[]>;
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
export async function paysAnExchange(db: DrizzleDb, request: Pick<StoredRequest, 'orgId'>, payment: { recipient: string; kind: number | null; paymentRef: string }): Promise<boolean> {
  if (payment.kind === EXCHANGE_KIND) return true;
  if (await screenedAsExchange(db, request.orgId, payment.recipient)) return true;
  return Boolean(await readTravelRuleTransfer(db, request.orgId, payment.paymentRef));
}

const ACCEPTED = new Set(['submitted', 'awaiting_counterparty', 'approved']);

/**
 * The Travel Rule half: null when the payment may be signed. In production
 * a sandbox message is not the provider's, so it does not count as sent.
 */
export async function travelRuleHold(
  db: DrizzleDb,
  request: Pick<StoredRequest, 'orgId'>,
  payment: { recipient: string; kind: number | null; paymentRef: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<GateRefusal | null> {
  if (!(await paysAnExchange(db, request, payment))) return null;
  const row = await readTravelRuleTransfer(db, request.orgId, payment.paymentRef);
  if (row?.sandbox && isProductionRuntime(env)) {
    return { code: 'travel_rule_missing', error: "The Travel Rule message on file is the sandbox's, not the provider's. Send it through the provider, then sign." };
  }
  if (row && row.providerRef && ACCEPTED.has(row.status)) return null;
  if (row?.status === 'rejected') return { code: 'travel_rule_rejected', error: "The exchange's Travel Rule check rejected this payment. It will not be signed." };
  if (row?.status === 'on_hold') return { code: 'travel_rule_on_hold', error: "The exchange's Travel Rule check has put this payment on hold. It can be signed once the hold is lifted." };
  return { code: 'travel_rule_missing', error: 'This payment goes to an exchange: send its Travel Rule message first, then sign.' };
}

/**
 * A staff member's exchange payment under their rule: the owner's switch is still on, and the message the person
 * confirmed is still on record and still says what the bytes pay. Null lets the signature through.
 */
export async function staffExchangeHold(db: DrizzleDb, request: StoredRequest): Promise<GateRefusal | null> {
  const off = await exchangeAloneHold(db, request);
  if (off) return off;
  const row = await readStoredDisclosure(db, request.orgId, { signingRequestId: request.id });
  if (!row) return { code: 'disclosure_missing', error: 'This payment has no record of the message shared with the exchange, so it is not signed. Start the payment again and confirm the message.' };
  const summary = (request.summary ?? null) as { description?: WalletTxDescription } | null;
  const paid = paymentOfDescription(summary?.description);
  const open = summary?.description?.actions?.find((a) => a.type === 'open_intent');
  const bytes = open && open.type === 'open_intent' ? open : null;
  // The bytes must be this payment: the account and the amount, the payment reference the message is bound to, and the commitment that covers its hash.
  const wrong =
    !paid || !paid.recipient || !bytes
      ? 'the transaction does not say what it pays'
      : disclosureMismatch(row, { recipient: paid.recipient, amountMinor: paid.amountMinor, paymentRef: bytes.paymentRef ?? null, commitment: bytes.commitment ?? null, maxFeeMinor: paid.maxFeeMinor, kind: bytes.kind });
  if (wrong) return { code: 'disclosure_mismatch', error: 'The message shared with the exchange does not match this payment, so it is not signed. Nothing has left your wallet. Start the payment again.' };
  return null;
}

/** The owner's switch for the person who made the payment, read now. Null when it is on. */
async function exchangeAloneHold(db: DrizzleDb, request: StoredRequest): Promise<GateRefusal | null> {
  if (await exchangeAloneOf(db, request.orgId, request.requestedBy)) return null;
  return { code: 'exchange_alone_off', error: 'An owner has not allowed you to pay exchange accounts on your own, or has turned it off, so this payment is not signed. Ask an owner to turn it on in Settings, or to approve the payment.' };
}

/** Before each signature on a payment: null lets the signature through. */
export async function paymentBeforeSign(deps: PaymentGateDeps, request: StoredRequest): Promise<GateRefusal | null> {
  if (request.purpose !== 'wallet_payment' && request.purpose !== 'spend_approval' && request.purpose !== 'staff_rule_payment') return null;
  const payment = paymentOfRequest(request);
  if (!payment) return { code: 'not_a_payment', error: 'The request does not describe a payment Splash can check, so it is not signed.' };
  // The owner's switch is the first question for a staff member's exchange payment: it is the reason the person is told, whatever else is also missing.
  if (request.purpose === 'staff_rule_payment' && payment.kind === EXCHANGE_KIND) {
    const off = await exchangeAloneHold(deps.db, request);
    if (off) return off;
  }
  const screened = await recipientScreeningGate(
    { db: deps.db, orgId: request.orgId, now: deps.now(), kyt: deps.kyt ?? null, ...(deps.maxAgeMs ? { maxAgeMs: deps.maxAgeMs } : {}), requestedBy: 'splash:before-sign', ...(deps.env ? { env: deps.env } : {}) },
    payment.recipient,
  );
  if (screened) return { code: screened.code, error: screened.error };
  // The saved recipient's own rule (v2 §4.7): a proof withdrawn, or a
  // recipient removed, after the payment was opened stops its signature.
  if (payment.kind !== null || request.purpose === 'wallet_payment') {
    const delivery = await walletDeliveryGate(deps.db, request.orgId, payment.recipient, payment.kind, { stage: 'sign' });
    if (delivery) return { code: delivery.code, error: delivery.error };
  }
  if (request.purpose === 'staff_rule_payment' && payment.kind === EXCHANGE_KIND) {
    const exchange = await staffExchangeHold(deps.db, request);
    if (exchange) return exchange;
  }
  // A rule payment to an exchange is held the same way: its message is kept under the intent's id.
  return travelRuleHold(deps.db, request, payment, deps.env);
}

/**
 * Before each signature on a batch (v2 brief 5.6): every payee of the batch
 * must still be a fresh CLEAR and still be a recipient the business may pay
 * as that kind (a proof withdrawn, or a recipient removed, after the batch was
 * opened stops it), and none may be an exchange or a bank: those are paid one
 * at a time, so their own checks run. The payees are read from the commands
 * stored with the request, never from anything a client sent. Null lets the
 * signature through.
 */
export async function batchBeforeSign(deps: PaymentGateDeps, request: StoredRequest): Promise<GateRefusal | null> {
  if (request.purpose !== 'wallet_batch') return null;
  const summary = (request.summary ?? null) as { description?: WalletTxDescription } | null;
  const opens = (summary?.description?.actions ?? []).filter((a) => a.type === 'open_intent') as Array<Extract<WalletTxDescription['actions'][number], { type: 'open_intent' }>>;
  if (opens.length === 0) return { code: 'not_a_batch', error: 'The request does not describe a batch Splash can check, so it is not signed.' };
  const splash = deps.splashAddresses ? (await deps.splashAddresses()).map((a) => normalizeSuiAddress(a)) : [];
  const wallet = request.senderAddress ? normalizeSuiAddress(request.senderAddress) : null;
  for (const [i, open] of opens.entries()) {
    const recipient = normalizeSuiAddress(open.recipient);
    if (wallet && recipient === wallet) return { code: 'own_wallet', error: `Payment ${i + 1} of ${opens.length} pays this business's own wallet, so the batch is not signed.` };
    if (splash.includes(recipient)) return { code: 'splash_controlled_address', error: `Payment ${i + 1} of ${opens.length} pays an address that belongs to Splash, so the batch is not signed.` };
    if (open.kind === EXCHANGE_KIND || open.kind === 3 || open.kind === 4) {
      return { code: 'not_payable_in_a_batch', error: `Payment ${i + 1} of this batch is not one a batch may pay, so the batch is not signed.` };
    }
    const screened = await recipientScreeningGate(
      { db: deps.db, orgId: request.orgId, now: deps.now(), kyt: deps.kyt ?? null, ...(deps.maxAgeMs ? { maxAgeMs: deps.maxAgeMs } : {}), requestedBy: 'splash:before-sign', ...(deps.env ? { env: deps.env } : {}) },
      recipient,
    );
    if (screened) return { code: screened.code, error: `Payment ${i + 1} of ${opens.length}: ${screened.error}` };
    const delivery = await walletDeliveryGate(deps.db, request.orgId, recipient, open.kind, { stage: 'sign' });
    if (delivery) return { code: delivery.code, error: `Payment ${i + 1} of ${opens.length}: ${delivery.error}` };
  }
  return null;
}

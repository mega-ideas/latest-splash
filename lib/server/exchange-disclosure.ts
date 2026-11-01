/**
 * The message a staff member confirms before paying an exchange account alone
 * (v2 Phase 3), on the server: built from what Splash holds, compared with
 * what the person was shown, kept with the payment, read back before every
 * signature, and the source of the Travel Rule message sent for the payment.
 *
 *   build      the sender is the signed-in person, the business is the one the
 *              provider verified (its KYB case, not the editable profile), the
 *              beneficiary and its exchange are the saved recipient's own, the
 *              amount and the intent id are the payment's. Only the purpose is
 *              the person's, and only from the fixed list. If anything the
 *              message needs is missing, there is no message and no payment,
 *              and the reason is in plain words. In production without the
 *              Travel Rule provider configured nothing is built at all.
 *   store      one row per payment (migration 0077): the payload, the exact
 *              text it was hashed from, and its hash. Never rewritten.
 *   check      before each signature the stored text must still hash to its
 *              hash, and the payload must still name the recipient and the
 *              amount the bytes pay. A record that is gone or does not match
 *              stops the signature.
 *   send       the Travel Rule message (lib/server/travel-rule-transfers.ts)
 *              is made from the stored payload and nothing else, kept under
 *              the signing request id as every exchange payment's is.
 *
 * Every read and write names the business, taken from the session.
 */
import { createHash, randomUUID } from 'node:crypto';

import { and, desc, eq } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { kybCases, users, walletTransferDisclosures } from '../db/schema.ts';
import {
  alpha3,
  ComplianceProviderUnavailable,
  isTravelRuleExchange,
  travelRuleProviderFromEnv,
  type TravelRuleProvider,
  type TravelRuleTransferInput,
} from '../compliance/sumsub.ts';
import { canonicalDisclosure, exchangePurpose, purposeTextOf, type ExchangeDisclosure } from '../compliance/exchange-disclosure.ts';
import { KYB_VERIFIED, payerOf } from './exchange-payment-compliance.ts';
import { sendTravelRule } from './travel-rule-transfers.ts';
import type { DrizzleDb } from './wallet-signing-store.ts';

export type DisclosureRefusal = { ok: false; status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): DisclosureRefusal => ({ ok: false, status, code, error });

export type StoredDisclosure = typeof walletTransferDisclosures.$inferSelect & { payload: ExchangeDisclosure };

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex');

/** The payment reference of a Transfer payment: derived from the business and the intent id, as the chain and the stored records know it (hex, no 0x). */
export const paymentRefHex = (orgId: string, clientKey: string) => sha256Hex(`splash-transfer|${orgId}|${clientKey}`);

/** The Travel Rule provider, or the refusal that stops everything: in production without it configured there is no sandbox to fall back on. */
export function travelRuleProviderFor(deps: { env?: NodeJS.ProcessEnv; travelRule?: () => TravelRuleProvider }): { ok: true; provider: TravelRuleProvider } | DisclosureRefusal {
  try {
    return { ok: true, provider: deps.travelRule ? deps.travelRule() : travelRuleProviderFromEnv(deps.env ?? process.env) };
  } catch (error) {
    if (error instanceof ComplianceProviderUnavailable) return refuse(error.status, error.code, error.message);
    throw error;
  }
}

const supported = (country: string | null | undefined): string | null => {
  const c = (country ?? '').trim().toUpperCase();
  if (!c) return null;
  try {
    alpha3(c);
    return c;
  } catch {
    return null;
  }
};

const text = (v: string | null | undefined) => {
  const t = (v ?? '').trim();
  return t || null;
};

export type DisclosureFacts = {
  orgId: string;
  clientKey: string;
  actor: { userId: string };
  /** The saved recipient, as the server read it (never from the request). */
  recipient: {
    legalName: string;
    registrationNumber: string | null;
    country: string | null;
    town: string | null;
    street: string | null;
    postCode: string | null;
    exchangeId: string | null;
    address: string;
  };
  amountMinor: bigint;
  /** The business wallet the payment is paid from. */
  walletAddress: string;
  purpose: unknown;
};

/**
 * The message for one payment, or the reason there is none. `applicantId` is
 * the business's case with the provider, needed to send it.
 */
export async function buildExchangeDisclosure(
  db: DrizzleDb,
  facts: DisclosureFacts,
): Promise<{ ok: true; disclosure: ExchangeDisclosure; canonical: string; hash: string; applicantId: string } | DisclosureRefusal> {
  const purpose = exchangePurpose(facts.purpose);
  if (!purpose) return refuse(400, 'bad_purpose', 'Choose what this payment is for, from the list.');

  const payer = await payerOf(db, facts.orgId);
  if (!payer) return refuse(404, 'not_found', 'No such business.');
  const payerCountry = supported(payer.country);
  if (!payerCountry) return refuse(409, 'originator_incomplete', "Complete the business's registered address first.");
  const [kyb] = await db
    .select({ applicant: kybCases.sumsubApplicantId, businessName: kybCases.businessName, registrationNumber: kybCases.registrationNumber })
    .from(kybCases)
    .where(eq(kybCases.orgId, facts.orgId))
    .orderBy(desc(kybCases.updatedAt))
    .limit(1);
  if (!kyb?.applicant) return refuse(409, 'kyb_applicant_missing', 'The business has no verification on file with the provider yet.');
  if (!KYB_VERIFIED.has(payer.kybLifecycle ?? '')) return refuse(409, 'kyb_not_approved', "The business's verification is not approved, so no Travel Rule message is sent for it.");

  const r = facts.recipient;
  const beneficiaryCountry = supported(r.country);
  if (!text(r.legalName) || !beneficiaryCountry || !isTravelRuleExchange(r.exchangeId)) {
    return refuse(409, 'recipient_incomplete', "This recipient's details are incomplete: the exchange needs its registered name, its country and the exchange it is held at. Open it in Recipients and finish them.");
  }

  const [person] = await db.select({ name: users.name }).from(users).where(eq(users.id, facts.actor.userId)).limit(1);
  const senderName = text(person?.name);
  if (!senderName) return refuse(409, 'sender_unknown', 'Your name is not on file, so the exchange cannot be told who is sending this. Add your name to your profile first.');

  const disclosure: ExchangeDisclosure = {
    version: 1,
    intentId: facts.clientKey,
    paymentRef: normalizeSuiAddress(paymentRefHex(facts.orgId, facts.clientKey)),
    amountMinor: facts.amountMinor.toString(),
    asset: 'USDC',
    sender: { userId: facts.actor.userId, name: senderName },
    business: {
      // The business the provider verified, not the editable profile.
      legalName: kyb.businessName,
      registrationNumber: text(kyb.registrationNumber),
      country: payerCountry,
      town: text(payer.town),
      street: text(payer.street),
      postCode: text(payer.postCode),
      walletAddress: normalizeSuiAddress(facts.walletAddress),
    },
    beneficiary: {
      legalName: r.legalName.trim(),
      registrationNumber: text(r.registrationNumber),
      country: beneficiaryCountry,
      town: text(r.town),
      street: text(r.street),
      postCode: text(r.postCode),
      exchange: r.exchangeId,
      accountReference: normalizeSuiAddress(r.address),
    },
    purpose: { code: purpose.code, label: purpose.label },
  };
  const canonical = canonicalDisclosure(disclosure);
  return { ok: true, disclosure, canonical, hash: sha256Hex(canonical), applicantId: kyb.applicant };
}

/** Keep the message with the payment. Called in the same step as the payment's claim, so one never exists without the other. */
export async function storeExchangeDisclosure(
  db: DrizzleDb,
  input: { orgId: string; transferId: string; built: { disclosure: ExchangeDisclosure; canonical: string; hash: string }; confirmedBy: string; now: Date },
): Promise<void> {
  await db.insert(walletTransferDisclosures).values({
    id: `wtd_${randomUUID()}`,
    orgId: input.orgId,
    transferId: input.transferId,
    intentId: input.built.disclosure.intentId,
    paymentRef: input.built.disclosure.paymentRef,
    payload: input.built.disclosure,
    canonical: input.built.canonical,
    payloadHash: input.built.hash,
    confirmedBy: input.confirmedBy,
    confirmedAt: input.now,
  });
}

/** Say which signing request the stored message belongs to (set once, when the request is opened). */
export async function attachSigningRequest(db: DrizzleDb, input: { orgId: string; transferId: string; signingRequestId: string }): Promise<void> {
  await db
    .update(walletTransferDisclosures)
    .set({ signingRequestId: input.signingRequestId })
    .where(and(eq(walletTransferDisclosures.orgId, input.orgId), eq(walletTransferDisclosures.transferId, input.transferId)));
}

/** This business's stored message for a payment, by its signing request, its transfer or its intent id; null if there is none. */
export async function readStoredDisclosure(
  db: DrizzleDb,
  orgId: string,
  by: { signingRequestId?: string; transferId?: string; intentId?: string },
): Promise<StoredDisclosure | null> {
  const column = by.signingRequestId
    ? eq(walletTransferDisclosures.signingRequestId, by.signingRequestId)
    : by.transferId
      ? eq(walletTransferDisclosures.transferId, by.transferId)
      : by.intentId
        ? eq(walletTransferDisclosures.intentId, by.intentId)
        : null;
  if (!column) return null;
  const [row] = await db.select().from(walletTransferDisclosures).where(and(eq(walletTransferDisclosures.orgId, orgId), column)).limit(1);
  return (row as StoredDisclosure | undefined) ?? null;
}

/**
 * Does the record still match the bytes? The stored text must still hash to its
 * hash and be the payload it carries, and it must name the recipient and the
 * amount the transaction pays. Null when it does.
 */
export function disclosureMismatch(row: StoredDisclosure, paid: { recipient: string; amountMinor: string | bigint }): string | null {
  const payload = row.payload;
  if (!payload || typeof payload !== 'object') return 'the kept message cannot be read';
  if (sha256Hex(row.canonical) !== row.payloadHash) return 'the kept message does not match its hash';
  let canonical: string;
  try {
    canonical = canonicalDisclosure(payload);
  } catch {
    return 'the kept message cannot be read';
  }
  if (canonical !== row.canonical) return 'the kept message is not the payload it carries';
  if (payload.intentId !== row.intentId || payload.paymentRef !== row.paymentRef) return 'the kept message is not for this payment';
  if (normalizeSuiAddress(payload.beneficiary.accountReference) !== normalizeSuiAddress(paid.recipient)) return 'the kept message names another account than the one paid';
  if (payload.amountMinor !== paid.amountMinor.toString()) return 'the kept message names another amount than the one paid';
  return null;
}

/** The Travel Rule message, made from the stored payload and nothing else. `intentId` is the key it is kept under (the signing request's id). */
export function travelRuleInputFromDisclosure(
  d: ExchangeDisclosure,
  extra: { orgId: string; applicantId: string; intentId: string; at: Date },
): TravelRuleTransferInput {
  return {
    intentId: extra.intentId,
    orgId: extra.orgId,
    applicantId: extra.applicantId,
    at: extra.at,
    amountMinor: BigInt(d.amountMinor),
    originator: {
      legalName: d.business.legalName,
      registrationNumber: d.business.registrationNumber,
      country: d.business.country,
      town: d.business.town,
      street: d.business.street,
      postCode: d.business.postCode,
      walletAddress: d.business.walletAddress,
    },
    beneficiary: {
      legalName: d.beneficiary.legalName,
      registrationNumber: d.beneficiary.registrationNumber,
      country: d.beneficiary.country,
      town: d.beneficiary.town,
      street: d.beneficiary.street,
      postCode: d.beneficiary.postCode,
      exchange: d.beneficiary.exchange as TravelRuleTransferInput['beneficiary']['exchange'],
      depositAddress: d.beneficiary.accountReference,
    },
    purpose: purposeTextOf(d),
  };
}

export type ExchangeMessageState = { state: 'sent' | 'not_sent'; status?: string; text: string };

/**
 * Send the stored message to the provider, once. A repeat answers the message
 * already sent. A refusal or a failure leaves the payment unsignable (the gate
 * needs the message with the provider) and says so; sending can be asked for again.
 */
export async function sendStoredExchangeMessage(
  deps: { db: DrizzleDb; orgId: string; now: () => Date; provider: TravelRuleProvider },
  disclosure: ExchangeDisclosure,
  input: { signingRequestId: string; createdBy: string },
): Promise<ExchangeMessageState> {
  const [kyb] = await deps.db
    .select({ applicant: kybCases.sumsubApplicantId })
    .from(kybCases)
    .where(eq(kybCases.orgId, deps.orgId))
    .orderBy(desc(kybCases.updatedAt))
    .limit(1);
  if (!kyb?.applicant) return { state: 'not_sent', text: 'The Travel Rule message has not been sent: the business has no verification on file with the provider yet.' };
  let message: TravelRuleTransferInput;
  try {
    message = travelRuleInputFromDisclosure(disclosure, { orgId: deps.orgId, applicantId: kyb.applicant, intentId: input.signingRequestId, at: deps.now() });
  } catch {
    return { state: 'not_sent', text: 'The Travel Rule message could not be made from what was confirmed, so it has not been sent.' };
  }
  const sent = await sendTravelRule({ db: deps.db, provider: deps.provider, orgId: deps.orgId, now: deps.now }, { ...message, signingRequestId: input.signingRequestId, createdBy: input.createdBy });
  if (sent.ok) {
    return { state: 'sent', status: sent.transfer.status, text: 'The Travel Rule message is with the provider. You can sign once the exchange has what it needs.' };
  }
  return { state: 'not_sent', text: `The Travel Rule message has not been sent yet: ${sent.error} You cannot sign until it is. Nothing has left your wallet.` };
}

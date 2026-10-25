/**
 * The compliance steps of a wallet payment to an exchange recipient (v2
 * §4.6, D5a), for ONE business:
 *
 *   Travel Rule          the VASP-to-VASP message through Sumsub, once per
 *                        payment (lib/server/travel-rule-transfers.ts);
 *   sender declaration   the pack the supplier gives its exchange, for USDC
 *                        from the business's own self-hosted wallet
 *                        (lib/compliance/sender-declaration.ts).
 *
 * Everything is read on the server: the payment from this org's own signing
 * request (its bytes, as decoded when it was opened), the payer from the
 * business's verified profile, the supplier from this org's saved recipient
 * at that address, the applicant from the business's KYB case. The request
 * names only the payment, the exchange, and the invoice's number and date.
 *
 * The Travel Rule message goes only for a recipient whose newest screening
 * is CLEAR: a REVIEW waits for a person, an unscreened address is screened
 * first. Paying is held back elsewhere: a payment is opened and signed only
 * for a fresh CLEAR, and an exchange payment is signed only once its
 * message is with the provider (lib/server/payment-compliance-gate.ts).
 *
 * The originator is the business the provider verified: the KYB case's name
 * and registration number, not the editable profile, and only once the
 * business's KYB is approved. The beneficiary is the ONE saved recipient at
 * the address (two saved at one address is refused, not guessed). The
 * exchange is the saved exchange account's own (§4.7): a request naming
 * another is refused, and a request names it only for a recipient saved
 * before exchanges were kept on the recipient. A deposit address once named
 * at one exchange keeps it.
 */
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { kybCases, organizations, travelRuleTransfers } from '../db/schema.ts';
import { isTravelRuleExchange, type TravelRuleExchange, type TravelRuleProvider } from '../compliance/sumsub.ts';
import { senderDeclaration } from '../compliance/sender-declaration.ts';
import type { PartnerId } from '../partners/signed-partners.ts';
import type { WalletTxDescription } from '../wallet/wallet-tx-describe.ts';
import { paymentOfDescription } from './controls-evidence.ts';
import { latestScreening } from './kyt-screenings.ts';
import { sendTravelRule } from './travel-rule-transfers.ts';
import { readSigningRequest, type DrizzleDb } from './wallet-signing-store.ts';

type Refusal = { ok: false; status: number; code: string; error: string };
const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

/** The saved recipient at an address, as this org holds it. */
export type SavedRecipient = {
  name: string;
  country: string;
  legalName?: string | null;
  registrationNumber?: string | null;
  town?: string | null;
  street?: string | null;
  postCode?: string | null;
  /** How the recipient is paid (v2 §4.7). Absent on a recipient saved before. */
  deliveryKind?: string | null;
  /** The exchange the saved EXCHANGE recipient's deposit address is at. */
  exchange?: TravelRuleExchange | null;
};

/** More than one saved recipient at the address: which one is the beneficiary is not guessed. */
export type AmbiguousRecipient = { ambiguous: true };

export type ExchangePaymentDeps = {
  db: DrizzleDb;
  orgId: string;
  now: () => Date;
  recipientAt: (orgId: string, address: string) => Promise<SavedRecipient | AmbiguousRecipient | null>;
};

/**
 * The exchange of a payment: the saved recipient's own (v2 §4.7). A request
 * naming another is refused; a request may name it only for a recipient
 * saved before exchanges were kept on the recipient. A wallet the supplier
 * holds is not an exchange account.
 */
function exchangeOf(saved: SavedRecipient, requested: unknown): { ok: true; exchange: TravelRuleExchange } | Refusal {
  if (saved.deliveryKind === 'SELF_CUSTODY' || saved.deliveryKind === 'CROSS_CHAIN' || saved.deliveryKind === 'BANK') {
    return refuse(409, 'not_an_exchange_recipient', 'This recipient is not saved as an exchange account.');
  }
  const named = requested === undefined || requested === null || requested === '' ? null : requested;
  if (saved.exchange) {
    if (named !== null && named !== saved.exchange) return refuse(409, 'exchange_mismatch', 'The recipient is saved at another exchange. Check the recipient.');
    return { ok: true, exchange: saved.exchange };
  }
  if (!isTravelRuleExchange(named)) return refuse(400, 'bad_exchange', 'Choose the exchange the supplier holds this deposit address at.');
  return { ok: true, exchange: named };
}

async function oneRecipientAt(deps: ExchangePaymentDeps, address: string): Promise<{ ok: true; recipient: SavedRecipient } | Refusal> {
  const found = await deps.recipientAt(deps.orgId, address);
  if (!found) return refuse(409, 'recipient_not_saved', 'Save the supplier as a recipient at this address first.');
  if ('ambiguous' in found) return refuse(409, 'recipient_ambiguous', 'More than one saved recipient has this address. Keep one, then try again.');
  return { ok: true, recipient: found };
}

/** KYB states in which the provider has verified the business and it is not suspended or rejected. */
const KYB_VERIFIED = new Set(['KYB_PROVIDER_APPROVED', 'KYB_ADMIN_APPROVED', 'ACTIVE']);

const DEAD = new Set(['failed', 'expired', 'cancelled']);

/** This org's wallet payment, by its signing request. */
async function walletPayment(deps: ExchangePaymentDeps, requestId: unknown) {
  if (typeof requestId !== 'string' || !/^wsr_[0-9a-f-]{36}$/.test(requestId)) return refuse(400, 'bad_payment', 'Name the payment by its signing request.');
  const request = await readSigningRequest(deps.db, deps.orgId, requestId);
  if (!request || request.purpose !== 'wallet_payment') return refuse(404, 'not_found', 'No such payment.');
  if (DEAD.has(request.status)) return refuse(409, 'payment_closed', 'This payment was not sent and will not be.');
  const described = paymentOfDescription((request.summary as { description?: WalletTxDescription } | null)?.description);
  if (!described || !described.recipient) return refuse(409, 'not_a_payment', 'The signing request does not describe a payment.');
  const amountMinor = BigInt(described.amountMinor || '0');
  if (amountMinor <= 0n) return refuse(409, 'not_a_payment', 'The payment has no amount.');
  const recipient = normalizeSuiAddress(described.recipient);
  return { ok: true as const, request, recipient, amountMinor, paymentRef: described.intentId ? normalizeSuiAddress(described.intentId) : request.id };
}

async function payerOf(db: DrizzleDb, orgId: string) {
  const [org] = await db
    .select({
      name: organizations.name,
      legalName: organizations.legalName,
      registrationNumber: organizations.registrationNumber,
      line1: organizations.addressLine1,
      city: organizations.addressCity,
      postCode: organizations.addressPostalCode,
      country: organizations.addressCountry,
      kybLifecycle: organizations.kybLifecycle,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) return null;
  const legalName = (org.legalName ?? '').trim() || org.name;
  const country = (org.country ?? '').trim().toUpperCase() || null;
  const address = [org.line1, org.city, org.postCode, country].map((v) => (v ?? '').trim()).filter(Boolean).join(', ') || null;
  return { legalName, registrationNumber: (org.registrationNumber ?? '').trim() || null, country, address, street: org.line1, town: org.city, postCode: org.postCode, kybLifecycle: org.kybLifecycle as string | null };
}

/** The sender-declaration pack for one wallet payment to an exchange recipient. */
export async function senderDeclarationFor(
  deps: ExchangePaymentDeps & { signedPartners: ReadonlySet<PartnerId> },
  input: { requestId: unknown; exchange: unknown; invoiceNumber: unknown; invoiceDate: unknown },
): Promise<{ ok: true; pack: ReturnType<typeof senderDeclaration> } | Refusal> {
  const p = await walletPayment(deps, input.requestId);
  if (!p.ok) return p;
  const saved = await oneRecipientAt(deps, p.recipient);
  if (!saved.ok) return saved;
  const supplier = saved.recipient;
  const ex = exchangeOf(supplier, input.exchange);
  if (!ex.ok) return ex;
  const payer = await payerOf(deps.db, deps.orgId);
  if (!payer) return refuse(404, 'not_found', 'No such business.');
  const [kyb] = await deps.db
    .select({ businessName: kybCases.businessName, registrationNumber: kybCases.registrationNumber })
    .from(kybCases)
    .where(eq(kybCases.orgId, deps.orgId))
    .orderBy(desc(kybCases.updatedAt))
    .limit(1);
  // The payer declared is the business the provider verified.
  if (!kyb || !KYB_VERIFIED.has(payer.kybLifecycle ?? '')) return refuse(409, 'kyb_not_approved', "The business's verification is not approved, so no declaration is made for it.");
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const pack = senderDeclaration({
    payer: { legalName: kyb.businessName, registrationNumber: kyb.registrationNumber, country: payer.country, address: payer.address },
    walletAddress: p.request.senderAddress,
    supplier: { name: supplier.legalName?.trim() || supplier.name, exchange: ex.exchange, depositAddress: p.recipient },
    amountMinor: p.amountMinor,
    invoice: { number: text(input.invoiceNumber), date: text(input.invoiceDate) },
    paymentRef: p.paymentRef,
    suiDigest: p.request.executedDigest,
    generatedAt: deps.now(),
    signedPartners: deps.signedPartners,
  });
  return { ok: true, pack };
}

/** Send the Travel Rule message for one wallet payment to an exchange recipient. */
export async function travelRuleForPayment(
  deps: ExchangePaymentDeps & { provider: TravelRuleProvider },
  input: { requestId: unknown; exchange: unknown; purpose: unknown; createdBy: string },
) {
  if (input.exchange !== undefined && input.exchange !== null && input.exchange !== '' && !isTravelRuleExchange(input.exchange)) {
    return refuse(400, 'bad_exchange', 'Choose the exchange the supplier holds this deposit address at.');
  }
  const p = await walletPayment(deps, input.requestId);
  if (!p.ok) return p;
  const screening = await latestScreening(deps.db, deps.orgId, 'SUI', p.recipient);
  if (!screening || screening.verdict === null) return refuse(409, 'not_screened', 'Screen the recipient address first.');
  if (screening.verdict === 'BLOCK') return refuse(403, 'screening_blocked', 'This address was refused by screening. Splash will not pay it.');
  if (screening.verdict !== 'CLEAR') return refuse(409, 'screening_review', 'A person reviews this address before it is paid.');
  const saved = await oneRecipientAt(deps, p.recipient);
  if (!saved.ok) return saved;
  const supplier = saved.recipient;
  const ex = exchangeOf(supplier, input.exchange);
  if (!ex.ok) return ex;
  const exchange = ex.exchange;
  const payer = await payerOf(deps.db, deps.orgId);
  if (!payer?.country) return refuse(409, 'originator_incomplete', "Complete the business's registered address first.");
  const [kyb] = await deps.db
    .select({ applicant: kybCases.sumsubApplicantId, businessName: kybCases.businessName, registrationNumber: kybCases.registrationNumber })
    .from(kybCases)
    .where(eq(kybCases.orgId, deps.orgId))
    .orderBy(desc(kybCases.updatedAt))
    .limit(1);
  if (!kyb?.applicant) return refuse(409, 'kyb_applicant_missing', 'The business has no verification on file with the provider yet.');
  if (!KYB_VERIFIED.has(payer.kybLifecycle ?? '')) return refuse(409, 'kyb_not_approved', "The business's verification is not approved, so no Travel Rule message is sent for it.");
  // One deposit address, one exchange: a later payment may not name another.
  const [earlier] = await deps.db
    .select({ exchange: travelRuleTransfers.exchange })
    .from(travelRuleTransfers)
    .where(and(eq(travelRuleTransfers.orgId, deps.orgId), eq(travelRuleTransfers.depositAddress, p.recipient), ne(travelRuleTransfers.paymentRef, p.paymentRef), isNotNull(travelRuleTransfers.providerRef)))
    .limit(1);
  if (earlier && earlier.exchange !== exchange) {
    return refuse(409, 'exchange_mismatch', 'An earlier Travel Rule message named another exchange for this deposit address. Check the recipient.');
  }
  const purpose = typeof input.purpose === 'string' ? input.purpose.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140) || null : null;
  return sendTravelRule(
    { db: deps.db, provider: deps.provider, orgId: deps.orgId, now: deps.now },
    {
      intentId: p.paymentRef,
      orgId: deps.orgId,
      applicantId: kyb.applicant,
      at: deps.now(),
      amountMinor: p.amountMinor,
      // The business the provider verified, not the editable profile.
      originator: { legalName: kyb.businessName, registrationNumber: kyb.registrationNumber, country: payer.country, town: payer.town, street: payer.street, postCode: payer.postCode, walletAddress: p.request.senderAddress },
      beneficiary: {
        legalName: supplier.legalName?.trim() || supplier.name,
        registrationNumber: supplier.registrationNumber ?? null,
        country: supplier.country,
        town: supplier.town ?? null,
        street: supplier.street ?? null,
        postCode: supplier.postCode ?? null,
        exchange,
        depositAddress: p.recipient,
      },
      purpose,
      signingRequestId: p.request.id,
      createdBy: input.createdBy,
    },
  );
}

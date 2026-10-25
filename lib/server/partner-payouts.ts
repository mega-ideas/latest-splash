/**
 * Payouts to a SUPPLIER's bank through the payout partners (v2 §4.5, D3, D4,
 * D12): PH through the Philippines payout partner (`pdax`), ID through the
 * Indonesia payout partner and its exchange partner (`durianpay`).
 *
 * The rails are the withdrawals' (lib/server/withdrawals.ts, §4.4), so a
 * supplier payout is held to exactly the same money rules:
 *
 *   - the USDC goes from the business wallet straight to the business's
 *     fixed deposit address with the partner (one per business per partner,
 *     verified once by a test deposit the partner confirms and the chain
 *     shows), in the canonical composed PTB the owners' multisig signs
 *     (withdraw, open the intent, confirm from the business wallet with
 *     max_fee the fee shown, anchor, delete). No Splash address is on the
 *     path; the partner is the payer of record;
 *   - the payout instruction goes to the partner by API BEFORE the deposit,
 *     keyed by the intent id (the idempotency key) and the expected USDC
 *     amount, built only from the account the intent's beneficiary
 *     commitment names, with the ISO 20022 message (lib/payments/iso20022.ts)
 *     made from the same fields; the digest is posted after settlement, and
 *     only once the chain shows the intent the partner was told;
 *   - webhooks are signed, inside a replay window, counted once, statuses
 *     never go backwards, and a return is believed only from the chain.
 *
 * What differs from a withdrawal:
 *   - the account is a supplier's: the name the bank holds for it (the
 *     partner's name enquiry) must be the holder name given, and the
 *     business's own name is refused (that is a withdrawal);
 *   - the supplier's ISO 20022 party (structured address, registration
 *     number) is sealed with the account, and the payer's relationship to it
 *     is recorded;
 *   - each payout declares its purpose code and source of funds, and the
 *     paying business's own KYB profile must be complete (the travel rule's
 *     originator half), or nothing is instructed;
 *   - the owners sign under purpose `partner_payout`, shown the supplier.
 *
 * Every function runs within ONE org (`deps.orgId`, from the session): a
 * beneficiary or payout of another business reads as absent.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { bankAccountIdentity, fingerprintKeys, FundingSourceError, sameCompany, validClientKey } from '../funding/wallet-funding.ts';
import { Iso20022Error, isRelationship, normalizeDeclaration, normalizeParty, type Iso20022Party, type Relationship } from '../payments/iso20022.ts';
import type { PayoutPartnerId } from '../payouts/partner.ts';
import { accountKeys, beneficiaryRefOf, destinationAad, MAX_WITHDRAWAL_MINOR, normalizeBeneficiary, openWithAny, seal, WithdrawalRuleError } from '../payouts/withdrawal-rules.ts';
import type { RequestView } from './wallet-signing.ts';
import {
  depositReady,
  openBankPayout,
  parseBankPayoutAmounts,
  parseMinor,
  partnerOf,
  quoteReady,
  refuse,
  revokeOne,
  routeLabel,
  unavailable,
  withdrawalView,
  type QuoteWire,
  type Ready,
  type Refusal,
  type WithdrawalDeps,
  type WithdrawalView,
} from './withdrawals.ts';
import * as store from './withdrawals-store.ts';

export type PartnerPayoutDeps = WithdrawalDeps;

/** The supplier payout routes: a bank in the Philippines, a bank in Indonesia. */
export const SUPPLIER_PAYOUT_PARTNERS: readonly PayoutPartnerId[] = ['pdax', 'durianpay'];

const ROUTE_BY_COUNTRY: Record<string, PayoutPartnerId> = { PH: 'pdax', ID: 'durianpay' };

export type BeneficiaryView = {
  id: string;
  partner: string;
  route: string;
  country: string;
  currency: string;
  bankCode: string;
  holderName: string;
  last4: string;
  label: string;
  relationship: Relationship | null;
  status: string;
  /** The stable beneficiary commitment, for binding it to the deposit address in the spending rules. */
  beneficiaryRef: string;
  verifiedAt: string;
};

function beneficiaryView(deps: PartnerPayoutDeps, row: store.DestinationRow): BeneficiaryView {
  let route = row.partner;
  try {
    route = routeLabel(deps, deps.partner(row.partner as PayoutPartnerId));
  } catch {
    /* the route may be switched off; the row is still shown */
  }
  return {
    id: row.id,
    partner: row.partner,
    route,
    country: row.country,
    currency: row.currency,
    bankCode: row.bankCode,
    holderName: row.holderName,
    last4: row.last4,
    label: row.label,
    relationship: isRelationship(row.relationship) ? row.relationship : null,
    status: row.status,
    beneficiaryRef: row.beneficiaryRef,
    verifiedAt: row.verifiedAt.toISOString(),
  };
}

// ─── Beneficiaries: suppliers' bank accounts ────────────────────────────────

export type AddBeneficiaryInput = {
  /** pdax or durianpay; inferred from the bank's country when left out. */
  partner?: string;
  holderName: string;
  country: string;
  bankCode: string;
  accountNumber: string;
  /** The supplier as an ISO 20022 party: the structured address and, for a company, its registration number. */
  address: unknown;
  registrationNumber?: string;
  registrationScheme?: string;
  /** The payer's relationship to the supplier (not `self`). */
  relationship: unknown;
  label?: string;
};

export async function listPayoutBeneficiaries(deps: PartnerPayoutDeps): Promise<BeneficiaryView[]> {
  return (await store.listDestinations(deps.db, deps.orgId)).filter((r) => r.status === 'verified' && r.kind === 'supplier').map((r) => beneficiaryView(deps, r));
}

/**
 * Save a supplier's bank account. Owners only (the route checks). Stored
 * only once the bank's own holder name (the partner's name enquiry) is the
 * holder name given, and the supplier's structured address is complete.
 * Nothing about a refused account is kept beyond its last four digits.
 */
export async function addPayoutBeneficiary(deps: PartnerPayoutDeps, userId: string, input: AddBeneficiaryInput): Promise<({ ok: true; created: boolean; beneficiary: BeneficiaryView }) | Refusal> {
  const now = deps.now();
  let b;
  try {
    b = normalizeBeneficiary({ country: input.country, bankCode: input.bankCode, accountNumber: input.accountNumber, holderName: input.holderName });
  } catch (error) {
    if (error instanceof WithdrawalRuleError) return refuse(400, error.code, error.message);
    throw error;
  }
  const p = partnerOf(deps, input.partner || ROUTE_BY_COUNTRY[b.country] || '', SUPPLIER_PAYOUT_PARTNERS);
  if ('ok' in p) return p;
  const adapter = p.adapter;
  if (!adapter.countries.includes(b.country)) return refuse(400, 'country_not_offered', `This route pays bank accounts in ${adapter.countries.join(', ')} only.`);
  if (!isRelationship(input.relationship)) return refuse(400, 'iso20022_missing', 'Say how the business relates to this supplier.', { field: 'relationship' });
  if (input.relationship === 'self') return refuse(400, 'own_account', "A payment to the business's own account is a withdrawal.");
  let party: Iso20022Party;
  try {
    party = normalizeParty({ name: b.holderName, address: input.address, registrationNumber: input.registrationNumber, registrationScheme: input.registrationScheme }, { field: 'supplier', requireAddress: true });
  } catch (error) {
    if (error instanceof Iso20022Error) return refuse(400, error.code, error.message, { field: error.field });
    throw error;
  }
  // The business's own account is a withdrawal, checked against its registered name, never a supplier.
  const company = await deps.companyName();
  if (company && sameCompany(b.holderName, company)) return refuse(409, 'own_account', "That is the business's own name: add the account under withdrawals.");
  const key = accountKeys(deps.env).current;
  if (!key) return refuse(503, 'account_key_missing', 'This server has no key to keep bank account numbers sealed, so no bank account can be added.');
  const fpKeys = fingerprintKeys(deps.env);
  if (!fpKeys.current) return refuse(503, 'fingerprint_key_missing', 'No bank-account fingerprint key is configured on this server.');
  let identity: { fingerprint: string; last4: string };
  let known: string[];
  try {
    identity = bankAccountIdentity(b, fpKeys.current);
    known = fpKeys.all.map((k) => bankAccountIdentity(b, k).fingerprint);
  } catch (error) {
    if (error instanceof FundingSourceError) return refuse(400, error.code, error.message);
    throw error;
  }
  const existing = await store.liveDestinationByFingerprint(deps.db, deps.orgId, adapter.id, known);
  if (existing && existing.kind !== 'supplier') return refuse(409, 'own_account', "This account is saved as the business's own.");
  if (existing) return { ok: true, created: false, beneficiary: beneficiaryView(deps, existing) };

  let check;
  try {
    check = await adapter.checkAccount({ beneficiary: b, now });
  } catch (error) {
    const r = unavailable(error);
    if (r) return r;
    return refuse(502, 'name_check_failed', 'The bank could not confirm who holds this account, so it was not added.');
  }
  if (!sameCompany(check.holderName, b.holderName)) {
    await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'destination', subjectId: null, actor: userId, action: 'name_mismatch', detail: { stage: 'bank', kind: 'supplier', last4: identity.last4, checkRef: check.checkRef, sandbox: check.sandbox }, at: now });
    return refuse(409, 'bank_name_mismatch', 'The bank says this account is held in another name. Check the holder name with the supplier.');
  }

  const id = `wdd_${randomUUID()}`;
  const salt = randomBytes(32);
  const row = await store.insertDestination(deps.db, {
    id,
    orgId: deps.orgId,
    partner: adapter.id,
    country: b.country,
    currency: adapter.currencies[0],
    bankCode: b.bankCode,
    holderName: b.holderName,
    bankHolderName: check.holderName,
    nameCheckRef: check.checkRef,
    fingerprint: identity.fingerprint,
    last4: identity.last4,
    accountSealed: seal(b.accountNumber, key, destinationAad(deps.orgId, id, 'account')),
    beneficiarySaltSealed: seal(salt, key, destinationAad(deps.orgId, id, 'salt')),
    beneficiaryRef: beneficiaryRefOf(adapter.id, b, salt),
    kind: 'supplier',
    partySealed: seal(JSON.stringify(party), key, destinationAad(deps.orgId, id, 'party')),
    relationship: input.relationship,
    label: (input.label ?? '').trim().slice(0, 80) || `${b.holderName}, account ending ${identity.last4}`,
    status: 'verified',
    verifiedAt: now,
    verifiedBy: userId,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  if (row.created) {
    await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'destination', subjectId: row.row.id, actor: userId, action: 'added', detail: { kind: 'supplier', last4: identity.last4, checkRef: check.checkRef, sandbox: check.sandbox }, at: now });
  }
  return { ok: true, created: row.created, beneficiary: beneficiaryView(deps, row.row) };
}

/** An owner removes a supplier's account. Any payout to it not yet sent is cancelled with it. */
export async function revokePayoutBeneficiary(deps: PartnerPayoutDeps, userId: string, id: string): Promise<{ ok: true; cancelled: number } | Refusal> {
  const row = await store.getDestination(deps.db, deps.orgId, id);
  if (!row || row.kind !== 'supplier') return refuse(404, 'not_found', 'No such supplier account.');
  const r = await revokeOne(deps, id, userId, 'removed');
  if (!r.revoked) return refuse(404, 'not_found', 'No such supplier account.');
  return { ok: true, cancelled: r.cancelled };
}

// ─── Quote and create ───────────────────────────────────────────────────────

async function supplierReady(deps: PartnerPayoutDeps, beneficiaryId: string): Promise<Ready | Refusal> {
  if (!deps.fiatOutOpen()) return refuse(403, 'not_in_launch_scope', 'Local-currency payouts are not open yet. Nothing was sent.');
  const destination = await store.getDestination(deps.db, deps.orgId, beneficiaryId);
  // Another business's account, or the business's own, reads as absent here.
  if (!destination || destination.status !== 'verified' || destination.kind !== 'supplier') return refuse(404, 'not_found', 'No such supplier account.');
  const p = partnerOf(deps, destination.partner, SUPPLIER_PAYOUT_PARTNERS);
  if ('ok' in p) return p;
  const d = await depositReady(deps, p.adapter);
  if ('ok' in d) return d;
  return { adapter: p.adapter, destination, ...d };
}

export async function quotePartnerPayout(deps: PartnerPayoutDeps, input: { beneficiaryId: unknown; amountMinor: unknown }): Promise<{ ok: true; quote: QuoteWire } | Refusal> {
  const amount = parseMinor(input.amountMinor);
  if (amount === null || amount <= 0n || amount > MAX_WITHDRAWAL_MINOR) return refuse(400, 'bad_amount', 'Say how much USDC to pay.');
  const r = await supplierReady(deps, String(input.beneficiaryId ?? ''));
  if ('ok' in r) return r;
  return quoteReady(deps, r, amount);
}

export type CreatePartnerPayoutInput = {
  clientKey: unknown;
  beneficiaryId: unknown;
  amountMinor: unknown;
  /** The least the accepted quote said the supplier receives (local minor units). */
  acceptedReceiveMinor: unknown;
  /** The Splash fee shown: the chain charges at most this. */
  maxFeeMinor: unknown;
  /** ISO 20022 ExternalPurpose1Code (SUPP, GDDS, SCVE, …). */
  purposeCode: unknown;
  sourceOfFunds: unknown;
  /** An invoice number or reference for the supplier. */
  remittanceInfo?: unknown;
  contentHash: unknown;
  walrusBlobId: unknown;
};

function payoutRequestHash(input: { beneficiaryId: string; amount: bigint; accepted: bigint; fee: bigint; purposeCode: string; sourceOfFunds: string; remittanceInfo: string }): string {
  return createHash('sha256')
    .update(`supplier_payout|${input.beneficiaryId}|${input.amount}|${input.accepted}|${input.fee}|${input.purposeCode}|${input.sourceOfFunds}|${input.remittanceInfo}`)
    .digest('hex');
}

/**
 * One payout to a supplier. An owner, or a staff member asking the owners to
 * approve (the route checks); only the owners' quorum signs. Idempotent by
 * the client's key: the same key and request return the same payout; the
 * same key for another request is refused.
 */
export async function createPartnerPayout(deps: PartnerPayoutDeps, userId: string, input: CreatePartnerPayoutInput): Promise<({ ok: true; created: boolean; payout: WithdrawalView; request: RequestView | null }) | Refusal> {
  const clientKey = validClientKey(input.clientKey);
  if (!clientKey) return refuse(400, 'idempotency_key_required', 'An Idempotency-Key (8 to 80 letters, digits, - or _) is needed.');
  const beneficiaryId = String(input.beneficiaryId ?? '');
  const a = parseBankPayoutAmounts(input, 'pay');
  if ('ok' in a) return a;
  const destination = await store.getDestination(deps.db, deps.orgId, beneficiaryId);
  let declaration;
  try {
    declaration = normalizeDeclaration(
      { purposeCode: input.purposeCode, relationship: destination?.relationship ?? 'other', sourceOfFunds: input.sourceOfFunds, remittanceInfo: input.remittanceInfo },
      { thirdParty: true },
    );
  } catch (error) {
    if (error instanceof Iso20022Error) return refuse(400, error.code, error.message, { field: error.field });
    throw error;
  }
  const requestHash = payoutRequestHash({
    beneficiaryId,
    amount: a.amount,
    accepted: a.accepted,
    fee: a.shownFee,
    purposeCode: declaration.purposeCode,
    sourceOfFunds: declaration.sourceOfFunds ?? '',
    remittanceInfo: declaration.remittanceInfo ?? '',
  });
  const prior = await store.withdrawalByClientKey(deps.db, deps.orgId, clientKey);
  if (prior) {
    if (prior.requestHash !== requestHash || prior.kind !== 'supplier_payout') return refuse(409, 'idempotency_key_reused', 'That key was used for a different payout.');
    return { ok: true, created: false, payout: await withdrawalView(deps, prior), request: null };
  }

  const r = await supplierReady(deps, beneficiaryId);
  if ('ok' in r) return r;
  // The travel rule's originator half: the paying business as KYB recorded it.
  const profile = deps.debtorParty ? await deps.debtorParty() : { party: null, missing: ['profile'] };
  if (!profile.party) {
    return refuse(409, 'originator_incomplete', "The business's own profile is missing what a payout to another business carries (its registered name, registration number and address). Nothing was sent.", { missing: profile.missing });
  }
  const keys = accountKeys(deps.env);
  if (!keys.current) return refuse(503, 'account_key_missing', 'This server has no key to open the sealed bank account, so nothing was sent.');
  let creditor: Iso20022Party;
  try {
    const opened = openWithAny(r.destination.partySealed ?? '', keys.all, destinationAad(deps.orgId, r.destination.id, 'party'));
    creditor = normalizeParty(JSON.parse(opened.plain.toString('utf8')), { field: 'supplier', requireAddress: true });
  } catch (error) {
    if (error instanceof WithdrawalRuleError) return refuse(409, error.code, error.message);
    if (error instanceof Iso20022Error) return refuse(409, error.code, error.message, { field: error.field });
    throw error;
  }
  return openBankPayout(deps, userId, {
    kind: 'supplier_payout',
    clientKey,
    requestHash,
    ready: r,
    amounts: a,
    debtor: profile.party,
    creditor,
    declaration,
  });
}

export async function listPartnerPayouts(deps: PartnerPayoutDeps): Promise<WithdrawalView[]> {
  const rows = await store.listWithdrawalRows(deps.db, deps.orgId, 'supplier_payout');
  const out: WithdrawalView[] = [];
  for (const row of rows) out.push(await withdrawalView(deps, row));
  return out;
}

/** One payout, as stored. Read-only: the sweep, the signing hook and the partner's webhooks move it on. */
export async function getPartnerPayout(deps: PartnerPayoutDeps, id: string): Promise<{ ok: true; payout: WithdrawalView } | Refusal> {
  const row = await store.getWithdrawalRow(deps.db, deps.orgId, id);
  if (!row || row.kind !== 'supplier_payout') return refuse(404, 'not_found', 'No such payout.');
  return { ok: true, payout: await withdrawalView(deps, row) };
}

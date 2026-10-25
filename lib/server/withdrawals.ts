/**
 * Withdrawals to the business's OWN bank (v2 §4.4, D3, D4), over the
 * payout-partner interface (lib/payouts/partner.ts, §4.5).
 *
 * MYR: business wallet → Hata (exchange partner) → Fiuu (bank-transfer
 * partner) → the business's own bank account. Splash never receives the MYR,
 * and no Splash address is ever on the path: the USDC goes from the business
 * wallet straight to the business's own deposit address at the partner, in
 * the canonical composed PTB (open, pay, anchor, delete), signed by the
 * owners' multisig.
 *
 *   destinations     the business's own bank accounts. Stored only when the
 *                    holder name as given AND as the partner's name enquiry
 *                    returns it from the bank are both the business's
 *                    registered name. The account number is sealed at rest.
 *   deposit address  the business's fixed address with the partner, verified
 *                    once: the owners send it a 1 USDC test deposit, and only
 *                    the partner's signed confirmation of that exact deposit,
 *                    re-read on chain, verifies it.
 *   quote            the partner's rate and its own fee lines, and Splash's
 *                    bank-payout fee (kind 4) as the chain would charge it;
 *                    only once the wallet holds the money.
 *   create           idempotent by the client's key. A fresh quote below the
 *                    one accepted, or a fee above the one shown, is refused,
 *                    never taken. The payout instruction goes to the partner
 *                    BEFORE any money moves, keyed by the intent id (derived
 *                    from the payment reference) and the expected amount, and
 *                    built only from the destination whose commitment the
 *                    intent carries. Then the owners are asked to sign.
 *   settlement       when the owners' transaction executes, the chain is read:
 *                    only when its IntentCreated event names this intent id
 *                    is the digest posted to the partner. The sweep
 *                    (`reconcileWithdrawals`, a cron) retries what did not
 *                    post and closes what lapsed; reads never call the
 *                    partner.
 *   webhooks         signed, inside a replay window, counted once, statuses
 *                    never backwards; a return is believed only from the
 *                    chain: USDC from the deposit address back into the
 *                    business wallet, by a digest no other withdrawal used,
 *                    and only the whole amount closes it.
 *
 * Every function runs within ONE org (`deps.orgId`, from the session) and
 * builds only against that org's BusinessAccount and wallet.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { normalizeStructTag, normalizeSuiAddress } from '@mysten/sui/utils';

import { paymentCommitment, railCommitment, toHex } from '../evidence/commitment.ts';
import { bankAccountIdentity, fingerprintKeys, FundingSourceError, sameCompany, validClientKey } from '../funding/wallet-funding.ts';
import { partnerLabel, type PartnerId } from '../partners/signed-partners.ts';
import { Iso20022Error, pacs008Evidence, pacs008ForInstruction, type Iso20022Party, type Pacs008, type Pacs008Evidence, type PaymentDeclaration } from '../payments/iso20022.ts';
import {
  isPayoutPartnerId,
  PayoutPartnerUnavailable,
  WebhookRejected,
  type PartnerFeeLine,
  type PayoutEvent,
  type PayoutPartner,
  type PayoutPartnerId,
  type PayoutQuote,
} from '../payouts/partner.ts';
import { payoutPartner } from '../payouts/registry.ts';
import {
  accountKeys,
  assertBeneficiaryMatches,
  createdIntentIds,
  beneficiaryRefOf,
  canAdvanceWithdrawal,
  destinationAad,
  MAX_WITHDRAWAL_MINOR,
  normalizeBeneficiary,
  openWithAny,
  seal,
  TEST_DEPOSIT_MINOR,
  WITHDRAWAL_INTENT_TTL_MS,
  WITHDRAWAL_SIGNING_WINDOW_MS,
  withdrawalAad,
  withdrawalIntentId,
  withdrawalRequestHash,
  WithdrawalRuleError,
  type WithdrawalStatus,
} from '../payouts/withdrawal-rules.ts';
import type { WalletContext, WalletMembers } from './business-wallet.ts';
import { V2_KIND } from './sui-v2-builders.ts';
import type { RequestView } from './wallet-signing.ts';
import type { WithdrawalSigningDetails } from './wallet-signing.ts';
import { closeSigningRequest, readSigningRequest, type DrizzleDb, type StoredRequest } from './wallet-signing-store.ts';
import * as store from './withdrawals-store.ts';

// ─── Dependencies ───────────────────────────────────────────────────────────

/** A Sui transaction as a withdrawal needs it (the funding reader's shape). */
export type WithdrawalChainTx = {
  digest: string;
  success: boolean;
  sender: string | null;
  balanceChanges: Array<{ address: string; coinType: string; amount: string }>;
  /** The checkpoint that holds it; null or absent until it is checkpointed. A return must come after its payout's deposit. */
  checkpoint?: string | null;
  /** The transaction's events (an executed withdrawal's IntentCreated names its intent id). */
  events?: Array<{ packageId?: string; eventType: string; json: unknown }>;
};

export type WithdrawalDeps = {
  db: DrizzleDb;
  /** The session's org. Never from a request. */
  orgId: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** The org's wallet context: its BusinessAccount, signing, balances and holds. */
  ctx: WalletContext;
  /** The wallet's members as Splash set it up, or why there is none. */
  walletMembers: () => Promise<{ ok: true; address: string; members: WalletMembers } | Refusal>;
  /** The adapter for a route (throws PayoutPartnerUnavailable). */
  partner: (id: PayoutPartnerId) => PayoutPartner;
  /** The business's registered (legal) name as KYB verified it (`verifiedLegalName`), or null. */
  companyName: () => Promise<string | null>;
  /**
   * Addresses Splash controls (operator, sponsor, treasury, FeeConfig's fee
   * recipient and pending recipient, read live): never a deposit address.
   * Throws when they cannot be read; the caller then refuses.
   */
  splashAddresses: () => Promise<string[]>;
  /** Whether an address is another business's wallet. */
  isBusinessWallet: (address: string) => Promise<boolean>;
  /** Splash's bank-payout fee (kind 4) for a principal, as the chain would charge it now. Throws if it cannot be read. */
  bankPayoutFee: (principalMinor: bigint) => Promise<{ feeMinor: bigint; feesOn: boolean }>;
  readTransaction: (digest: string) => Promise<WithdrawalChainTx | null>;
  /** splash_core's original (defining) package id: the intent id's type tag. */
  corePackageOriginalId: string;
  /** Whether local-currency payouts are open in this launch scope. */
  fiatOutOpen: () => boolean;
  signedPartners: ReadonlySet<PartnerId>;
  /**
   * The paying business as an ISO 20022 party, from its KYB profile
   * (lib/payments/iso20022.ts `debtorFromProfile`), or what is missing. A
   * supplier payout needs it complete (the travel rule's originator half);
   * a withdrawal uses what there is, and at least the registered name.
   */
  debtorParty?: () => Promise<{ party: Iso20022Party | null; missing: string[]; transliterated?: string[] }>;
};

export type Refusal = { ok: false; status: number; code: string; error: string; [k: string]: unknown };
export const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Refusal => ({ ok: false, status, code, error, ...extra });

const WITHDRAWAL_PARTNERS: readonly PayoutPartnerId[] = ['hata_fiuu'];
/** The routes that pay a bank from a partner deposit address: each needs its own verified address (§4.4, §4.5). */
export const DEPOSIT_PARTNERS: readonly PayoutPartnerId[] = ['hata_fiuu', 'pdax', 'durianpay'];

/**
 * The name a bank account must be held in: the organisation's legal name,
 * but only once KYB has verified it (kyb_status basic or full). Before that
 * the name is only what someone typed (lib/server/onboarding.ts locks it once
 * KYB is under way and lets only an owner set it).
 */
export function verifiedLegalName(org: { legalName: string | null | undefined; kybStatus: string | null | undefined }): string | null {
  if (org.kybStatus !== 'basic' && org.kybStatus !== 'full') return null;
  const name = (org.legalName ?? '').trim();
  return name || null;
}

export async function splashAddressSet(deps: Pick<WithdrawalDeps, 'splashAddresses'>): Promise<Set<string> | Refusal> {
  try {
    return new Set((await deps.splashAddresses()).map((a) => normalizeSuiAddress(a)));
  } catch {
    return refuse(503, 'splash_addresses_unreadable', "Splash's own addresses (its fee recipient among them) could not be read, so no deposit address can be checked against them.");
  }
}

export function unavailable(error: unknown): Refusal | null {
  if (error instanceof PayoutPartnerUnavailable) return refuse(error.code === 'bad_instruction' ? 409 : error.status, error.code, error.message);
  return null;
}

export function routeLabel(deps: Pick<WithdrawalDeps, 'signedPartners'>, adapter: Pick<PayoutPartner, 'partners'>): string {
  return adapter.partners.map((p) => partnerLabel(p, deps.signedPartners)).join(', then ');
}

export const hexOf = (v: unknown) => String(v ?? '').trim().toLowerCase().replace(/^0x/, '');
export const isHexBytes = (v: string, min: number, max: number) => /^([0-9a-f]{2})+$/.test(v) && v.length / 2 >= min && v.length / 2 <= max;

export function parseMinor(value: unknown): bigint | null {
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,20}$/.test(s)) return null;
  const n = BigInt(s);
  return n <= 18_446_744_073_709_551_615n ? n : null;
}

export function partnerOf(deps: Pick<WithdrawalDeps, 'partner'>, id: unknown, allowed: readonly PayoutPartnerId[] = WITHDRAWAL_PARTNERS): { adapter: PayoutPartner } | Refusal {
  const pid = typeof id === 'string' && id ? id : allowed[0];
  if (!isPayoutPartnerId(pid) || !allowed.includes(pid)) {
    return refuse(400, 'bad_partner', allowed === WITHDRAWAL_PARTNERS ? 'Withdrawals go through the Malaysia route only.' : `That route is not one of ${allowed.join(', ')}.`);
  }
  try {
    return { adapter: deps.partner(pid) };
  } catch (error) {
    const r = unavailable(error);
    if (r) return r;
    throw error;
  }
}

// ─── Views ──────────────────────────────────────────────────────────────────

export type DestinationView = {
  id: string;
  partner: string;
  route: string;
  country: string;
  currency: string;
  bankCode: string;
  holderName: string;
  last4: string;
  label: string;
  status: string;
  /** The stable beneficiary commitment, for binding it to the deposit address in the spending rules. */
  beneficiaryRef: string;
  verifiedAt: string;
};

function destinationView(deps: WithdrawalDeps, row: store.DestinationRow): DestinationView {
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
    status: row.status,
    beneficiaryRef: row.beneficiaryRef,
    verifiedAt: row.verifiedAt.toISOString(),
  };
}

export type DepositAddressView = {
  id: string;
  partner: string;
  address: string;
  status: string;
  testAmountMinor: string;
  testRequestId: string | null;
  testDigest: string | null;
  verifiedAt: string | null;
};

function depositAddressView(row: store.DepositAddressRow): DepositAddressView {
  return {
    id: row.id,
    partner: row.partner,
    address: row.address,
    status: row.status,
    testAmountMinor: row.testAmountMinor.toString(),
    testRequestId: row.testRequestId,
    testDigest: row.testDigest,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
  };
}

export type QuoteWire = {
  partner: string;
  route: string;
  currency: string;
  sendMinor: string;
  rateMicro: string;
  receiveMinor: string;
  partnerFees: Array<{ partner: string; label: string; currency: string; amountMinor: string }>;
  splashFee: { kind: number; minor: string; feesOn: boolean };
  /** Exactly the Splash fee shown: send it back as `maxFeeMinor`. */
  maxFeeMinor: string;
  /** Principal plus Splash's fee: what leaves the wallet at most. */
  totalDebitMinor: string;
  expiresAt: string;
  sandbox: boolean;
};

export function linesWire(deps: WithdrawalDeps, lines: PartnerFeeLine[]) {
  // Circle's CCTP fee is Circle's own, set and taken by the protocol; every other line is a partner's, named only if signed.
  return lines.map((l) => ({ partner: l.partner === 'circle' ? 'Circle' : partnerLabel(l.partner, deps.signedPartners), label: l.label, currency: l.currency, amountMinor: l.amountMinor.toString() }));
}

export function quoteWire(deps: WithdrawalDeps, adapter: PayoutPartner, q: PayoutQuote, fee: { feeMinor: bigint; feesOn: boolean }): QuoteWire {
  return {
    partner: adapter.id,
    route: routeLabel(deps, adapter),
    currency: q.currency,
    sendMinor: q.sendMinor.toString(),
    rateMicro: q.rateMicro.toString(),
    receiveMinor: q.receiveMinor.toString(),
    partnerFees: linesWire(deps, q.lines),
    splashFee: { kind: V2_KIND.BANK_PAYOUT, minor: fee.feeMinor.toString(), feesOn: fee.feesOn },
    maxFeeMinor: fee.feeMinor.toString(),
    totalDebitMinor: (q.sendMinor + fee.feeMinor).toString(),
    expiresAt: q.expiresAt.toISOString(),
    sandbox: q.sandbox,
  };
}

export type WithdrawalView = {
  id: string;
  status: WithdrawalStatus;
  partner: string;
  destination: { id: string; bankCode: string; last4: string; label: string } | null;
  amountMinor: string;
  maxFeeMinor: string;
  currency: string;
  rateMicro: string;
  receiveMinor: string;
  partnerFees: QuoteWire['partnerFees'];
  intentId: string;
  depositAddress: string;
  partnerRef: string | null;
  signingRequestId: string | null;
  suiDigest: string | null;
  settlementPosted: boolean;
  bankRef: string | null;
  returnDigest: string | null;
  /** The USDC a return put back in the wallet, as the chain shows it. */
  returnedMinor: string | null;
  /** Why the digest is held back from the partner (`intent_id_mismatch`), or null. */
  settlementHold: string | null;
  failure: string | null;
  quoteExpiresAt: string;
  createdAt: string;
  sandbox: boolean;
  /** `withdrawal` (the business's own bank) or `supplier_payout`. */
  kind: store.PayoutRowKind;
  /** The ISO 20022 purpose code, on a supplier payout. */
  purposeCode: string | null;
  /** The masked pacs.008-style data the partner was sent, on a supplier payout (the evidence export's section). */
  iso20022: Pacs008Evidence | null;
};

export async function withdrawalView(deps: Pick<WithdrawalDeps, 'db' | 'orgId'>, row: store.WithdrawalRow): Promise<WithdrawalView> {
  const dest = await store.getDestination(deps.db, deps.orgId, row.destinationId);
  const quote = row.quote as { partnerFees?: QuoteWire['partnerFees']; sandbox?: boolean };
  return {
    id: row.id,
    status: row.status as WithdrawalStatus,
    kind: row.kind as store.PayoutRowKind,
    purposeCode: row.purposeCode,
    iso20022: (row.iso20022 as Pacs008Evidence | null) ?? null,
    partner: row.partner,
    destination: dest ? { id: dest.id, bankCode: dest.bankCode, last4: dest.last4, label: dest.label } : null,
    amountMinor: row.amountMinor.toString(),
    maxFeeMinor: row.maxFeeMinor.toString(),
    currency: row.currency,
    rateMicro: row.rateMicro.toString(),
    receiveMinor: row.receiveMinor.toString(),
    partnerFees: quote.partnerFees ?? [],
    intentId: row.intentId,
    depositAddress: row.depositAddress,
    partnerRef: row.partnerRef,
    signingRequestId: row.signingRequestId,
    suiDigest: row.suiDigest,
    settlementPosted: row.settlementPostedAt !== null,
    bankRef: row.bankRef,
    returnDigest: row.returnDigest,
    returnedMinor: row.returnedMinor?.toString() ?? null,
    settlementHold: row.settlementHold,
    failure: row.failure,
    quoteExpiresAt: row.quoteExpiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    sandbox: Boolean(quote.sandbox),
  };
}

// ─── Destinations: the business's own bank accounts ─────────────────────────

export type AddDestinationInput = { partner?: string; holderName: string; country: string; bankCode: string; accountNumber: string; label?: string };

export async function listWithdrawalDestinations(deps: WithdrawalDeps): Promise<DestinationView[]> {
  return (await store.listDestinations(deps.db, deps.orgId)).filter((r) => r.status === 'verified' && r.kind === 'own_account').map((r) => destinationView(deps, r));
}

/**
 * Add the business's own bank account. Owners only (the route checks). It is
 * stored only once BOTH the name given and the bank's own holder name (the
 * partner's name enquiry) are the business's registered name. Nothing about
 * the account is kept when either does not match; the attempt is recorded
 * with its last four digits only.
 */
export async function addWithdrawalDestination(deps: WithdrawalDeps, userId: string, input: AddDestinationInput): Promise<({ ok: true; created: boolean; destination: DestinationView }) | Refusal> {
  const now = deps.now();
  const p = partnerOf(deps, input.partner);
  if ('ok' in p) return p;
  const adapter = p.adapter;
  let b;
  try {
    b = normalizeBeneficiary({ country: input.country, bankCode: input.bankCode, accountNumber: input.accountNumber, holderName: input.holderName });
  } catch (error) {
    if (error instanceof WithdrawalRuleError) return refuse(400, error.code, error.message);
    throw error;
  }
  if (!adapter.countries.includes(b.country)) return refuse(400, 'country_not_offered', `This route pays bank accounts in ${adapter.countries.join(', ')} only.`);
  const company = await deps.companyName();
  if (!company) return refuse(409, 'no_company_name', "The business's registered name is not on record yet, so no bank account can be checked against it.");
  const last4 = b.accountNumber.slice(-4);
  if (!sameCompany(b.holderName, company)) {
    await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'destination', subjectId: null, actor: userId, action: 'name_mismatch', detail: { stage: 'given', last4 }, at: now });
    return refuse(409, 'not_company_name', "A withdrawal goes only to the business's own bank account, in its registered name.");
  }
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
  if (existing && existing.kind !== 'own_account') return refuse(409, 'destination_is_supplier', 'This account is saved as a supplier, not as the business’s own account.');
  if (existing) return { ok: true, created: false, destination: destinationView(deps, existing) };

  let check;
  try {
    check = await adapter.checkAccount({ beneficiary: b, now });
  } catch (error) {
    const r = unavailable(error);
    if (r) return r;
    return refuse(502, 'name_check_failed', 'The bank could not confirm who holds this account, so it was not added.');
  }
  if (!sameCompany(check.holderName, company)) {
    await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'destination', subjectId: null, actor: userId, action: 'name_mismatch', detail: { stage: 'bank', last4, checkRef: check.checkRef, sandbox: check.sandbox }, at: now });
    return refuse(409, 'bank_name_mismatch', "The bank says this account is held in another name. A withdrawal goes only to the business's own account.");
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
    label: (input.label ?? '').trim().slice(0, 80) || `Bank account ending ${identity.last4}`,
    status: 'verified',
    verifiedAt: now,
    verifiedBy: userId,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  if (row.created) {
    await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'destination', subjectId: row.row.id, actor: userId, action: 'added', detail: { last4: identity.last4, checkRef: check.checkRef, sandbox: check.sandbox }, at: now });
  }
  return { ok: true, created: row.created, destination: destinationView(deps, row.row) };
}

export type CloseDeps = { db: DrizzleDb; now: () => Date; orgId: string; partner?: (id: PayoutPartnerId) => PayoutPartner };

/**
 * Cancel every withdrawal of a destination that has not moved money: its
 * owners' request is closed (nobody can sign it any more), its instruction
 * reversed, and the withdrawal cancelled. A request already being submitted
 * is left alone: it is in the chain's hands, and the sweep settles it.
 */
async function cancelInFlightFor(deps: CloseDeps, destinationId: string, actor: string, reason: string): Promise<number> {
  let cancelled = 0;
  for (const row of await store.inFlightWithdrawalsFor(deps.db, deps.orgId, destinationId)) {
    if (row.signingRequestId) {
      const closed = await closeSigningRequest(deps.db, { orgId: deps.orgId, id: row.signingRequestId, status: 'cancelled', from: ['collecting'], now: deps.now() });
      if (!closed) {
        const request = await readSigningRequest(deps.db, deps.orgId, row.signingRequestId);
        if (!request || !['cancelled', 'expired', 'failed'].includes(request.status)) continue;
      }
    }
    if (row.partnerRef && deps.partner) {
      try {
        await reverseInstruction(deps, deps.partner(row.partner as PayoutPartnerId), { intentId: row.intentId, partnerRef: row.partnerRef, returnAddress: row.walletAddress }, reason);
      } catch {
        /* the route is off: no deposit was made, so nothing is owed */
      }
    }
    if (await cancel(deps, row.id, actor, reason, ['preparing', 'awaiting_signatures'])) cancelled += 1;
  }
  return cancelled;
}

export async function revokeOne(deps: CloseDeps, id: string, actor: string, reason: string): Promise<{ revoked: boolean; cancelled: number }> {
  const now = deps.now();
  const row = await store.revokeDestination(deps.db, deps.orgId, id, now);
  if (!row) return { revoked: false, cancelled: 0 };
  await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'destination', subjectId: id, actor, action: 'revoked', detail: { reason }, at: now });
  return { revoked: true, cancelled: await cancelInFlightFor(deps, id, actor, 'destination_revoked') };
}

/** An owner removes a bank account. Any withdrawal to it not yet sent is cancelled with it. */
export async function revokeWithdrawalDestination(deps: WithdrawalDeps, userId: string, id: string): Promise<{ ok: true; cancelled: number } | Refusal> {
  const row = await store.getDestination(deps.db, deps.orgId, id);
  if (!row || row.kind !== 'own_account') return refuse(404, 'not_found', 'No such bank account.');
  const r = await revokeOne(deps, id, userId, 'removed');
  if (!r.revoked) return refuse(404, 'not_found', 'No such bank account.');
  return { ok: true, cancelled: r.cancelled };
}

/**
 * The registered name changed: every bank account was checked against the
 * old one, so every one is revoked and every withdrawal to them not yet sent
 * is cancelled. The owners add their accounts again under the new name.
 */
export async function revokeDestinationsForNameChange(input: CloseDeps & { actor: string }): Promise<number> {
  let revoked = 0;
  for (const row of await store.listDestinations(input.db, input.orgId)) {
    // Only the business's own accounts were checked against its name; a supplier's was checked against the bank's.
    if (row.status !== 'verified' || row.kind !== 'own_account') continue;
    if ((await revokeOne(input, row.id, input.actor, 'legal_name_changed')).revoked) revoked += 1;
  }
  return revoked;
}

// ─── The partner deposit address ────────────────────────────────────────────

export async function refreshDepositAddress(deps: WithdrawalDeps, row: store.DepositAddressRow): Promise<store.DepositAddressRow> {
  return refreshDepositAddressIn(deps.db, deps.now, row);
}

export async function withdrawalDepositAddress(deps: WithdrawalDeps, partner?: string): Promise<DepositAddressView | null> {
  const p = partnerOf(deps, partner, DEPOSIT_PARTNERS);
  if ('ok' in p) return null;
  const row = await store.liveDepositAddress(deps.db, deps.orgId, p.adapter.id);
  return row ? depositAddressView(await refreshDepositAddress(deps, row)) : null;
}

/**
 * Ask the partner for the business's fixed deposit address and record it,
 * unverified. Owners only. Refused when it is an address Splash controls, the
 * business wallet itself, or an address another business already has.
 */
export async function requestPartnerDepositAddress(deps: WithdrawalDeps, userId: string, input: { partner?: string } = {}): Promise<{ ok: true; created: boolean; depositAddress: DepositAddressView } | Refusal> {
  const now = deps.now();
  const p = partnerOf(deps, input.partner, DEPOSIT_PARTNERS);
  if ('ok' in p) return p;
  const adapter = p.adapter;
  const live = await store.liveDepositAddress(deps.db, deps.orgId, adapter.id);
  if (live) return { ok: true, created: false, depositAddress: depositAddressView(await refreshDepositAddress(deps, live)) };
  let given;
  try {
    given = await adapter.depositAddress({ businessId: normalizeSuiAddress(deps.ctx.account.objectId), now });
  } catch (error) {
    const r = unavailable(error);
    if (r) return r;
    return refuse(502, 'partner_error', 'The partner did not give a deposit address. Nothing was recorded.');
  }
  let address: string;
  try {
    address = normalizeSuiAddress(given.address);
  } catch {
    return refuse(502, 'bad_deposit_address', 'The partner gave a deposit address that is not a Sui address. Nothing was recorded.');
  }
  if (!/^0x[0-9a-f]{64}$/.test(address) || /^0x0+$/.test(address)) return refuse(502, 'bad_deposit_address', 'The partner gave a deposit address that is not a Sui address. Nothing was recorded.');
  const splash = await splashAddressSet(deps);
  if (!(splash instanceof Set)) return splash;
  if (splash.has(address)) {
    return refuse(409, 'splash_address', 'That address is one Splash controls. Splash never receives client money, so it cannot be a deposit address.');
  }
  const wallet = (await deps.ctx.readAccount()).wallet;
  if (wallet && normalizeSuiAddress(wallet) === address) return refuse(409, 'own_wallet', 'The deposit address is the business wallet itself.');
  if (await deps.isBusinessWallet(address)) {
    return refuse(409, 'business_wallet', "The partner gave an address that is another business's wallet. Nothing was recorded; the partner must give this business its own deposit address.");
  }
  if (await store.depositAddressHeldElsewhere(deps.db, deps.orgId, adapter.id, address)) {
    return refuse(409, 'address_conflict', 'The partner gave an address another business already has. Nothing was recorded; the partner must give this business its own.');
  }
  const row = await store.insertDepositAddress(deps.db, {
    id: `pda_${randomUUID()}`,
    orgId: deps.orgId,
    partner: adapter.id,
    address,
    accountRef: given.accountRef,
    status: 'pending_test',
    testAmountMinor: TEST_DEPOSIT_MINOR,
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  if (row.created) {
    await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'deposit_address', subjectId: row.row.id, actor: userId, action: 'added', detail: { address, sandbox: given.sandbox }, at: now });
  }
  return { ok: true, created: row.created, depositAddress: depositAddressView(row.row) };
}

/** The owners send the 1 USDC test deposit. Owners only. */
export async function requestTestDeposit(deps: WithdrawalDeps, userId: string, input: { partner?: string } = {}): Promise<{ ok: true; depositAddress: DepositAddressView; request: RequestView } | Refusal> {
  const now = deps.now();
  const p = partnerOf(deps, input.partner, DEPOSIT_PARTNERS);
  if ('ok' in p) return p;
  const live = await store.liveDepositAddress(deps.db, deps.orgId, p.adapter.id);
  if (!live) return refuse(404, 'no_deposit_address', 'Get the deposit address from the partner first.');
  const row = await refreshDepositAddress(deps, live);
  if (row.status === 'verified') return refuse(409, 'already_verified', 'This deposit address is already verified.');
  if (row.status !== 'pending_test') return refuse(409, 'test_in_progress', 'A test deposit for this address is already waiting or sent.');
  const wallet = await deps.walletMembers();
  if (!wallet.ok) return wallet;
  const { requestPartnerTestDeposit } = await import('./business-wallet.ts');
  const opened = await requestPartnerTestDeposit(deps.ctx, {
    orgId: deps.orgId,
    requestedBy: userId,
    wallet: wallet.members,
    depositAddress: row.address,
    amountMinor: row.testAmountMinor,
    dedupeKey: `withdraw:test:${row.id}`,
  });
  if (!opened.ok) return refuse(opened.status, opened.code, opened.error);
  const moved = await store.moveDepositAddress(deps.db, deps.orgId, row.id, ['pending_test'], {
    status: 'test_requested',
    testRequestId: opened.request.id,
    testWallet: normalizeSuiAddress(wallet.address),
    updatedAt: now,
  });
  await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'deposit_address', subjectId: row.id, actor: userId, action: 'test_requested', detail: { signingRequestId: opened.request.id }, at: now });
  return { ok: true, depositAddress: depositAddressView(moved ?? row), request: opened.request };
}

// ─── Quote and create ───────────────────────────────────────────────────────

export type Ready = {
  adapter: PayoutPartner;
  destination: store.DestinationRow;
  deposit: store.DepositAddressRow;
  wallet: { address: string; members: WalletMembers };
};

/**
 * The business's verified deposit address with a bank route's partner, and
 * the wallet that pays it: never the wallet itself, never a Splash address.
 */
export async function depositReady(deps: WithdrawalDeps, adapter: PayoutPartner): Promise<Omit<Ready, 'adapter' | 'destination'> | Refusal> {
  const live = await store.liveDepositAddress(deps.db, deps.orgId, adapter.id);
  const deposit = live ? await refreshDepositAddress(deps, live) : null;
  if (!deposit || deposit.status !== 'verified') {
    return refuse(409, 'deposit_address_unverified', "The business's deposit address with the partner is not verified yet: send the test deposit first.");
  }
  const wallet = await deps.walletMembers();
  if (!wallet.ok) return wallet;
  if (normalizeSuiAddress(deposit.address) === normalizeSuiAddress(wallet.address)) return refuse(409, 'own_wallet', 'The deposit address is the business wallet itself.');
  const splash = await splashAddressSet(deps);
  if (!(splash instanceof Set)) return splash;
  if (splash.has(normalizeSuiAddress(deposit.address))) return refuse(409, 'splash_address', 'That address is one Splash controls.');
  return { deposit, wallet: { address: normalizeSuiAddress(wallet.address), members: wallet.members } };
}

async function ready(deps: WithdrawalDeps, destinationId: string): Promise<Ready | Refusal> {
  if (!deps.fiatOutOpen()) return refuse(403, 'not_in_launch_scope', 'Local-currency payouts are not open yet. Nothing was sent.');
  const destination = await store.getDestination(deps.db, deps.orgId, destinationId);
  // Another business's destination, or a supplier's, reads as absent.
  if (!destination || destination.status !== 'verified' || destination.kind !== 'own_account') return refuse(404, 'not_found', 'No such bank account.');
  // The account was checked against the registered name of the day. A name
  // that changed since (or was never verified) pays nothing to it.
  const company = await deps.companyName();
  if (!company) return refuse(409, 'no_company_name', "The business's registered name is not verified yet, so no bank account can be paid.");
  if (!sameCompany(destination.holderName, company)) {
    await revokeOne(deps, destination.id, 'system', 'legal_name_changed');
    return refuse(409, 'destination_name_changed', "This bank account was checked against an earlier registered name, so it was removed. Add the business's account again.");
  }
  const p = partnerOf(deps, destination.partner);
  if ('ok' in p) return p;
  const d = await depositReady(deps, p.adapter);
  if ('ok' in d) return d;
  return { adapter: p.adapter, destination, ...d };
}

/** The wallet holds principal plus fee, outside every hold. The quote comes only after this. */
export async function fundsAvailable(deps: WithdrawalDeps, wallet: string, needMinor: bigint): Promise<Refusal | null> {
  if (!deps.ctx.readUsdc) return refuse(503, 'balance_unreadable', 'The wallet balance cannot be read here.');
  let balance: bigint;
  try {
    const b = await deps.ctx.readUsdc(wallet);
    balance = b.coinMinor + b.addressBalanceMinor;
  } catch {
    return refuse(502, 'balance_unreadable', 'The wallet balance could not be read.');
  }
  if (balance < needMinor) return refuse(409, 'insufficient_funds', 'The business wallet does not hold enough USDC for this payout and its fee.', { balanceMinor: balance.toString() });
  const { fundsOnHold } = await import('./business-wallet.ts');
  const held = await fundsOnHold(deps.ctx, wallet, needMinor);
  return held ? refuse(held.status, held.code, held.error, held.details ?? {}) : null;
}

export async function feeFor(deps: WithdrawalDeps, principal: bigint): Promise<{ feeMinor: bigint; feesOn: boolean } | Refusal> {
  try {
    return await deps.bankPayoutFee(principal);
  } catch {
    return refuse(503, 'fee_unavailable', "Splash's fee could not be read from the chain, so nothing was quoted.");
  }
}

/** A quote whose partner fee lines take the whole amount pays the bank nothing: never shown, never instructed. */
function swallowedByFees(q: PayoutQuote): Refusal | null {
  if (q.receiveMinor > 0n) return null;
  return refuse(409, 'below_partner_fees', "The partner's fees are more than this amount would pay out, so the bank account would receive nothing. Nothing was sent; send a larger amount.");
}

/** The fee and the partner's quote for a ready route, only once the wallet holds principal plus fee. */
export async function quoteReady(deps: WithdrawalDeps, r: Pick<Ready, 'adapter' | 'destination' | 'wallet'>, amount: bigint): Promise<{ ok: true; quote: QuoteWire } | Refusal> {
  const fee = await feeFor(deps, amount);
  if ('ok' in fee) return fee;
  const funds = await fundsAvailable(deps, r.wallet.address, amount + fee.feeMinor);
  if (funds) return funds;
  let q: PayoutQuote;
  try {
    q = await r.adapter.quote({ currency: r.destination.currency, sendMinor: amount, now: deps.now() });
  } catch (error) {
    const u = unavailable(error);
    if (u) return u;
    return refuse(502, 'partner_error', 'The partner did not quote. Nothing was sent.');
  }
  const swallowed = swallowedByFees(q);
  if (swallowed) return swallowed;
  return { ok: true, quote: quoteWire(deps, r.adapter, q, fee) };
}

export async function quoteWithdrawal(deps: WithdrawalDeps, input: { destinationId: string; amountMinor: unknown }): Promise<{ ok: true; quote: QuoteWire } | Refusal> {
  const amount = parseMinor(input.amountMinor);
  if (amount === null || amount <= 0n || amount > MAX_WITHDRAWAL_MINOR) return refuse(400, 'bad_amount', 'Say how much USDC to withdraw.');
  const r = await ready(deps, String(input.destinationId ?? ''));
  if ('ok' in r) return r;
  return quoteReady(deps, r, amount);
}

export type CreateWithdrawalInput = {
  clientKey: unknown;
  destinationId: unknown;
  amountMinor: unknown;
  /** The least the accepted quote said the bank account receives (local minor units). */
  acceptedReceiveMinor: unknown;
  /** The Splash fee the owner was shown: the chain charges at most this. */
  maxFeeMinor: unknown;
  /** The audit bundle the receipt anchors (hex). */
  contentHash: unknown;
  walrusBlobId: unknown;
};

/** The amounts and audit bundle every bank payout request carries, checked. */
export type BankPayoutAmounts = { amount: bigint; accepted: bigint; shownFee: bigint; contentHash: string; walrusBlobId: string };

export function parseBankPayoutAmounts(input: { amountMinor: unknown; acceptedReceiveMinor: unknown; maxFeeMinor: unknown; contentHash: unknown; walrusBlobId: unknown }, what: string): BankPayoutAmounts | Refusal {
  const amount = parseMinor(input.amountMinor);
  const accepted = parseMinor(input.acceptedReceiveMinor);
  const shownFee = parseMinor(input.maxFeeMinor);
  if (amount === null || amount <= 0n || amount > MAX_WITHDRAWAL_MINOR) return refuse(400, 'bad_amount', `Say how much USDC to ${what}.`);
  if (accepted === null) return refuse(400, 'accepted_quote_required', 'Send the receive amount of the quote you accepted.');
  // "At least nothing" would let the partner keep the USDC and pay the bank nothing.
  if (accepted <= 0n) return refuse(400, 'nothing_received', 'The least the bank account receives must be more than nothing.');
  if (shownFee === null) return refuse(400, 'fee_shown_required', 'Send the Splash fee you were shown.');
  // No Splash fee is ever above 1% of the principal (the ceiling, A1).
  if (shownFee * 10_000n > amount * 100n) return refuse(400, 'bad_fee', 'The fee shown is above the 1% ceiling.');
  const contentHash = hexOf(input.contentHash);
  const walrusBlobId = hexOf(input.walrusBlobId);
  if (!isHexBytes(contentHash, 32, 32) || !isHexBytes(walrusBlobId, 1, 128)) return refuse(400, 'no_audit_bundle', `The ${what === 'withdraw' ? 'withdrawal' : 'payout'} needs its audit bundle (content hash and blob id).`);
  return { amount, accepted, shownFee, contentHash, walrusBlobId };
}

/**
 * One withdrawal. Owners only (the route checks). Idempotent by the client's
 * key: the same key and request return the same withdrawal; the same key
 * for another request is refused.
 */
export async function createWithdrawal(deps: WithdrawalDeps, userId: string, input: CreateWithdrawalInput): Promise<({ ok: true; created: boolean; withdrawal: WithdrawalView; request: RequestView | null }) | Refusal> {
  const clientKey = validClientKey(input.clientKey);
  if (!clientKey) return refuse(400, 'idempotency_key_required', 'An Idempotency-Key (8 to 80 letters, digits, - or _) is needed.');
  const destinationId = String(input.destinationId ?? '');
  const a = parseBankPayoutAmounts(input, 'withdraw');
  if ('ok' in a) return a;
  const requestHash = withdrawalRequestHash({ destinationId, amountMinor: a.amount, acceptedReceiveMinor: a.accepted, maxFeeMinor: a.shownFee });

  const prior = await store.withdrawalByClientKey(deps.db, deps.orgId, clientKey);
  if (prior) {
    if (prior.requestHash !== requestHash || prior.kind !== 'withdrawal') return refuse(409, 'idempotency_key_reused', 'That key was used for a different withdrawal.');
    return { ok: true, created: false, withdrawal: await withdrawalView(deps, prior), request: null };
  }

  const r = await ready(deps, destinationId);
  if ('ok' in r) return r;
  // The business moving its own money: the creditor is the business, at its own address when the profile has one.
  const company = (await deps.companyName()) as string;
  const profile = deps.debtorParty ? await deps.debtorParty() : { party: null, missing: [] as string[], transliterated: [] as string[] };
  // An incomplete profile never blocks a withdrawal: the debtor is then the
  // registered name alone, transliterated in the message if it must be.
  const debtor: Iso20022Party = profile.party ?? { name: company };
  const creditor: Iso20022Party = { name: r.destination.holderName, ...(profile.party?.address ? { address: profile.party.address } : {}), ...(profile.party?.registrationNumber ? { registrationNumber: profile.party.registrationNumber, registrationScheme: profile.party.registrationScheme } : {}) };
  const opened = await openBankPayout(deps, userId, {
    kind: 'withdrawal',
    clientKey,
    requestHash,
    ready: r,
    amounts: a,
    debtor,
    debtorTransliterated: profile.party ? profile.transliterated : undefined,
    creditor,
    declaration: { purposeCode: 'INTC', relationship: 'self' },
  });
  if (!opened.ok) return opened;
  return { ok: true, created: opened.created, withdrawal: opened.payout, request: opened.request };
}

/**
 * The shared core of a bank payout, once the route is ready and the request
 * checked: the fee no higher than shown, the funds there, a fresh quote no
 * worse than accepted, the sealed account opened and matched against its
 * commitment, the ISO 20022 message built from exactly that account, the
 * payout stored (idempotent by the client's key), then the instruction to
 * the partner BEFORE any money moves, then the owners' signing request.
 */
export async function openBankPayout(
  deps: WithdrawalDeps,
  userId: string,
  p: {
    kind: store.PayoutRowKind;
    clientKey: string;
    requestHash: string;
    ready: Ready;
    amounts: BankPayoutAmounts;
    debtor: Iso20022Party;
    /** Fields of the debtor's KYB text transliterated when it was read (debtorFromProfile). */
    debtorTransliterated?: string[];
    creditor: Iso20022Party;
    declaration: PaymentDeclaration;
  },
): Promise<({ ok: true; created: boolean; payout: WithdrawalView; request: RequestView | null }) | Refusal> {
  const now = deps.now();
  const { ready: r, amounts: a } = p;
  const { amount, accepted, shownFee } = a;
  const noun = p.kind === 'withdrawal' ? 'withdrawal' : 'payout';
  const fee = await feeFor(deps, amount);
  if ('ok' in fee) return fee;
  if (fee.feeMinor > shownFee) return refuse(409, 'fee_above_shown', "Splash's fee is now above the one you were shown. Nothing was sent.", { feeMinor: fee.feeMinor.toString() });
  const funds = await fundsAvailable(deps, r.wallet.address, amount + shownFee);
  if (funds) return funds;
  let q: PayoutQuote;
  try {
    q = await r.adapter.quote({ currency: r.destination.currency, sendMinor: amount, now });
  } catch (error) {
    const u = unavailable(error);
    if (u) return u;
    return refuse(502, 'partner_error', 'The partner did not quote. Nothing was sent.');
  }
  const swallowed = swallowedByFees(q);
  if (swallowed) return swallowed;
  if (q.receiveMinor < accepted) {
    return refuse(409, 'quote_changed', 'The rate moved below the one you accepted. Nothing was sent; look at the new quote.', { quote: quoteWire(deps, r.adapter, q, fee) });
  }
  if (q.expiresAt.getTime() <= now.getTime()) return refuse(409, 'quote_expired', 'The quote has expired. Nothing was sent.');

  // The instruction names exactly the account the intent commits to.
  const keys = accountKeys(deps.env);
  const key = keys.current;
  if (!key) return refuse(503, 'account_key_missing', 'This server has no key to open the sealed bank account, so nothing was sent.');
  let beneficiary;
  let beneficiaryRef: string;
  let beneficiarySalt: Buffer;
  try {
    const accountAad = destinationAad(deps.orgId, r.destination.id, 'account');
    const saltAad = destinationAad(deps.orgId, r.destination.id, 'salt');
    const account = openWithAny(r.destination.accountSealed, keys.all, accountAad);
    const salt = openWithAny(r.destination.beneficiarySaltSealed, keys.all, saltAad);
    const accountNumber = account.plain.toString('utf8');
    beneficiarySalt = salt.plain;
    beneficiaryRef = r.destination.beneficiaryRef;
    beneficiary = assertBeneficiaryMatches(r.adapter.id, { country: r.destination.country, bankCode: r.destination.bankCode, accountNumber, holderName: r.destination.holderName }, beneficiarySalt, beneficiaryRef);
    if (account.rotated || salt.rotated) {
      // Opened with a previous key: sealed again under the current one.
      await store.resealDestination(deps.db, deps.orgId, r.destination.id, { accountSealed: seal(accountNumber, key, accountAad), beneficiarySaltSealed: seal(beneficiarySalt, key, saltAad), updatedAt: now });
      await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'destination', subjectId: r.destination.id, actor: 'system', action: 'resealed', detail: { last4: r.destination.last4 }, at: now });
    }
  } catch (error) {
    if (error instanceof WithdrawalRuleError) return refuse(409, error.code, error.message);
    throw error;
  }
  // settle_by is the owners' signing deadline, not the five-minute quote:
  // the partner pays at least `accepted` at its rate when the deposit lands,
  // or returns the USDC (WITHDRAWAL_SIGNING_WINDOW_MS).
  const settleByMs = BigInt(now.getTime() + WITHDRAWAL_SIGNING_WINDOW_MS);
  const expiresAtMs = BigInt(now.getTime() + WITHDRAWAL_INTENT_TTL_MS);

  const id = `wdr_${randomUUID()}`;
  const paymentRef = randomBytes(32);
  const intentId = withdrawalIntentId({ accountId: deps.ctx.account.objectId, corePackageId: deps.corePackageOriginalId, paymentRef });
  const depositAddress = normalizeSuiAddress(r.deposit.address);
  // The ISO 20022 message, from the very account the intent commits to.
  let iso: Pacs008;
  try {
    iso = pacs008ForInstruction({
      intentId,
      quoteRef: q.quoteRef,
      expectedUsdcMinor: amount,
      currency: q.currency,
      receiveMinor: q.receiveMinor,
      rateMicro: q.rateMicro,
      beneficiary,
      beneficiaryRef,
      sourceWallet: r.wallet.address,
      depositAddress,
      debtor: p.debtor,
      creditor: p.creditor,
      declaration: p.declaration,
      charges: q.lines,
      transliterated: p.debtorTransliterated,
    });
  } catch (error) {
    if (error instanceof Iso20022Error) return refuse(400, error.code, error.message, { field: error.field });
    throw error;
  }
  const commitmentSalt = randomBytes(32);
  const quoteRecord = { partnerFees: linesWire(deps, q.lines), sandbox: q.sandbox, splashFeeMinor: fee.feeMinor.toString(), feesOn: fee.feesOn };
  const inserted = await store.insertWithdrawal(deps.db, {
    id,
    orgId: deps.orgId,
    clientKey: p.clientKey,
    requestHash: p.requestHash,
    kind: p.kind,
    partner: r.adapter.id,
    destinationId: r.destination.id,
    depositAddressId: r.deposit.id,
    depositAddress,
    walletAddress: r.wallet.address,
    paymentRef: toHex(paymentRef),
    intentId,
    beneficiaryRef,
    commitmentSaltSealed: seal(commitmentSalt, key, withdrawalAad(deps.orgId, id)),
    amountMinor: amount,
    maxFeeMinor: shownFee,
    currency: q.currency,
    rateMicro: q.rateMicro,
    receiveMinor: q.receiveMinor,
    quote: quoteRecord,
    quoteRef: q.quoteRef,
    quoteExpiresAt: q.expiresAt,
    ...(p.kind === 'supplier_payout' ? { purposeCode: p.declaration.purposeCode, iso20022: pacs008Evidence(iso) } : {}),
    status: 'preparing',
    createdBy: userId,
    createdAt: now,
    updatedAt: now,
  });
  if (!inserted) {
    // Another request with this key won the insert.
    const winner = await store.withdrawalByClientKey(deps.db, deps.orgId, p.clientKey);
    if (!winner || winner.requestHash !== p.requestHash || winner.kind !== p.kind) return refuse(409, 'idempotency_key_reused', `That key was used for a different ${noun}.`);
    return { ok: true, created: false, payout: await withdrawalView(deps, winner), request: null };
  }
  await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: id, actor: userId, action: 'created', detail: { kind: p.kind, intentId, amountMinor: amount.toString(), last4: r.destination.last4 }, at: now });
  const transliterated = iso.CdtTrfTxInf.SplmtryData.transliterated ?? [];
  if (transliterated.length) {
    // The business's own name or address had characters outside the CBPR+
    // set: the message carries a transliteration, and the trail says which fields.
    await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: id, actor: 'system', action: 'iso20022_transliterated', detail: { fields: transliterated }, at: now });
  }

  // 1. The instruction, before any money moves.
  let partnerRef: string;
  try {
    const order = await r.adapter.createPayout({
      route: 'bank',
      intentId,
      expectedUsdcMinor: amount,
      quoteRef: q.quoteRef,
      currency: q.currency,
      receiveMinor: q.receiveMinor,
      minReceiveMinor: accepted,
      settleByMs,
      beneficiary,
      beneficiaryRef,
      beneficiarySalt: toHex(beneficiarySalt),
      sourceWallet: r.wallet.address,
      depositAddress,
      returnAddress: r.wallet.address,
      purposeCode: p.declaration.purposeCode,
      rateMicro: q.rateMicro,
      debtor: p.debtor,
      charges: q.lines,
      iso20022: iso,
      now,
    });
    partnerRef = order.partnerRef;
  } catch (error) {
    const u = unavailable(error);
    if (!u) {
      // The partner may have taken it and the answer was lost: an instruction
      // keyed by this intent id must not stay live at the partner.
      const reversed = await reverseInstruction(deps, r.adapter, { intentId, partnerRef: '', returnAddress: r.wallet.address }, 'instruction_unconfirmed');
      await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: id, actor: 'system', action: 'instruction_reversed', detail: { reason: 'instruction_unconfirmed', accepted: reversed }, at: deps.now() });
    }
    await cancel(deps, id, 'system', u ? u.code : 'partner_error', ['preparing']);
    return u ?? refuse(502, 'partner_error', 'The partner did not take the instruction. Nothing was sent.');
  }
  await store.patchWithdrawal(deps.db, deps.orgId, id, { partnerRef, updatedAt: now });
  await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: id, actor: 'system', action: 'instructed', detail: { partnerRef }, at: now });

  // 2. The owners' signatures, on bytes bound to this deposit address, account and amount.
  const { requestWalletPayment } = await import('./business-wallet.ts');
  const opened = await requestWalletPayment(deps.ctx, {
    orgId: deps.orgId,
    requestedBy: userId,
    wallet: r.wallet.members,
    payment: {
      paymentRef,
      recipient: depositAddress,
      beneficiaryRef: Buffer.from(beneficiaryRef, 'hex'),
      amountMinor: amount,
      targetCurrency: q.currency,
      fxRateUsdLocal: q.rateMicro,
      commitment: paymentCommitment(
        {
          sender: r.wallet.address,
          recipient: depositAddress,
          beneficiaryRef,
          amount,
          currency: normalizeStructTag(deps.ctx.chain.usdcType),
          corridor: r.destination.country,
          targetCurrency: q.currency,
          fxRateUsdLocal: q.rateMicro,
        },
        commitmentSalt,
      ),
      kind: V2_KIND.BANK_PAYOUT,
      railCommitment: railCommitment({ rail: r.adapter.id, partnerReference: partnerRef }, commitmentSalt),
      expiresAtMs,
      maxFeeMinor: shownFee,
      settleByMs,
      contentHash: Buffer.from(a.contentHash, 'hex'),
      walrusBlobId: Buffer.from(a.walrusBlobId, 'hex'),
    },
    withdrawal: {
      purpose: p.kind === 'withdrawal' ? 'withdrawal' : 'partner_payout',
      depositAddress,
      beneficiaryRef,
      details: {
        destinationId: r.destination.id,
        bankCode: r.destination.bankCode,
        last4: r.destination.last4,
        holderName: r.destination.holderName,
        currency: q.currency,
        receiveMinor: q.receiveMinor.toString(),
        minReceiveMinor: accepted.toString(),
        rateMicro: q.rateMicro.toString(),
        settleByMs: settleByMs.toString(),
        purposeCode: p.declaration.purposeCode,
        relationship: p.declaration.relationship,
      } satisfies WithdrawalSigningDetails,
    },
  });
  if (!opened.ok) {
    await reverseInstruction(deps, r.adapter, { intentId, partnerRef, returnAddress: r.wallet.address }, 'not_sent');
    await cancel(deps, id, 'system', opened.code, ['preparing']);
    return refuse(opened.status, opened.code, opened.error);
  }
  const moved = await store.moveWithdrawal(deps.db, deps.orgId, id, ['preparing'], { status: 'awaiting_signatures', signingRequestId: opened.request.id, updatedAt: now });
  await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: id, actor: userId, action: 'awaiting_signatures', detail: { signingRequestId: opened.request.id }, at: now });
  return { ok: true, created: true, payout: await withdrawalView(deps, moved ?? (await store.getWithdrawalRow(deps.db, deps.orgId, id))!), request: opened.request };
}

export async function cancel(deps: Pick<WithdrawalDeps, 'db' | 'now' | 'orgId'>, id: string, actor: string, reason: string, from: WithdrawalStatus[]) {
  const now = deps.now();
  const row = await store.moveWithdrawal(deps.db, deps.orgId, id, from, { status: 'cancelled', failure: reason, updatedAt: now });
  if (row) await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: id, actor, action: 'cancelled', detail: { reason }, at: now });
  return row;
}

export async function reverseInstruction(deps: Pick<WithdrawalDeps, 'now'>, adapter: PayoutPartner, w: { intentId: string; partnerRef: string; returnAddress: string }, reason: string): Promise<boolean> {
  try {
    const r = await adapter.returnOrReverse({ ...w, reason, now: deps.now() });
    return r.accepted;
  } catch {
    // Nothing was deposited for it: an instruction no deposit follows pays nothing.
    return false;
  }
}

// ─── Reconciling with the signing request ───────────────────────────────────

/** What settling a withdrawal after its owners' request needs. Cross-tenant callers act within each row's own org. */
export type SettlementDeps = {
  db: DrizzleDb;
  now: () => Date;
  partner: (id: PayoutPartnerId) => PayoutPartner;
  readTransaction: (digest: string) => Promise<WithdrawalChainTx | null>;
  /** splash_core's original package id: the IntentCreated event's type. */
  corePackageOriginalId: string;
};

type OrgScoped = { db: DrizzleDb; now: () => Date; orgId: string };

async function markSent(deps: OrgScoped, row: store.WithdrawalRow, digest: string): Promise<store.WithdrawalRow> {
  const now = deps.now();
  const moved = await store.moveWithdrawal(deps.db, deps.orgId, row.id, ['awaiting_signatures'], { status: 'sent', suiDigest: digest, updatedAt: now });
  if (!moved) return (await store.getWithdrawalRow(deps.db, deps.orgId, row.id)) ?? row;
  await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: row.id, actor: 'system', action: 'sent', detail: { suiDigest: digest }, at: now });
  return moved;
}

/**
 * Read the executed transaction and check the intent it created is the one
 * the partner was instructed for (its IntentCreated event, under splash_core's
 * original package id). A mismatch holds the settlement for ops and is never
 * posted: the partner would be told a digest for an intent id it was never
 * given. An unreadable transaction is retried by the sweep.
 */
async function confirmIntent(deps: SettlementDeps & { orgId: string }, row: store.WithdrawalRow): Promise<store.WithdrawalRow | null> {
  if (row.intentConfirmedAt) return row;
  if (row.settlementHold || !row.suiDigest) return null;
  let tx: WithdrawalChainTx | null;
  try {
    tx = await deps.readTransaction(row.suiDigest);
  } catch {
    tx = null;
  }
  if (!tx) return null;
  const now = deps.now();
  const created = tx.success ? createdIntentIds(tx.events ?? [], deps.corePackageOriginalId) : [];
  if (!created.includes(normalizeSuiAddress(row.intentId))) {
    const patched = await store.patchWithdrawal(deps.db, deps.orgId, row.id, { settlementHold: 'intent_id_mismatch', updatedAt: now });
    await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: row.id, actor: 'system', action: 'intent_id_mismatch', detail: { intentId: row.intentId, created, suiDigest: row.suiDigest }, at: now });
    // An alert for ops: ids and a digest only, nothing about the bank account.
    console.error(`[withdrawals] ALERT intent id mismatch: withdrawal ${row.id} was instructed for ${row.intentId}, the transaction ${row.suiDigest} created ${created.join(', ') || 'no intent'}; settlement held`);
    void patched;
    return null;
  }
  return (await store.patchWithdrawal(deps.db, deps.orgId, row.id, { intentConfirmedAt: now, updatedAt: now })) ?? row;
}

async function postSettlement(deps: SettlementDeps & { orgId: string }, row: store.WithdrawalRow): Promise<store.WithdrawalRow> {
  if (!row.suiDigest || !row.partnerRef || row.settlementPostedAt || row.settlementHold) return row;
  const confirmed = await confirmIntent(deps, row);
  if (!confirmed) return (await store.getWithdrawalRow(deps.db, deps.orgId, row.id)) ?? row;
  try {
    await deps.partner(row.partner as PayoutPartnerId).postSettlement({ intentId: row.intentId, partnerRef: row.partnerRef, suiDigest: row.suiDigest, now: deps.now() });
  } catch {
    return confirmed; // Retried by the sweep.
  }
  const now = deps.now();
  const patched = await store.patchWithdrawal(deps.db, deps.orgId, row.id, { settlementPostedAt: now, updatedAt: now });
  await store.recordWithdrawalEvent(deps.db, { orgId: deps.orgId, subject: 'withdrawal', subjectId: row.id, actor: 'system', action: 'settlement_posted', detail: { suiDigest: row.suiDigest }, at: now });
  return patched ?? confirmed;
}

/** One withdrawal against its owners' request and the partner. Runs within the row's own org. */
async function settleRow(deps: SettlementDeps, row: store.WithdrawalRow): Promise<'sent' | 'cancelled' | 'posted' | 'unchanged'> {
  const scoped = { ...deps, orgId: row.orgId };
  let current = row;
  if (current.status === 'awaiting_signatures' && current.signingRequestId) {
    const request = await readSigningRequest(deps.db, row.orgId, current.signingRequestId);
    if (request?.status === 'executed' && request.executedDigest) {
      current = await markSent(scoped, current, request.executedDigest);
    } else if (request && (request.status === 'expired' || request.status === 'cancelled' || request.status === 'failed')) {
      if (current.partnerRef) {
        try {
          await reverseInstruction(deps, deps.partner(current.partner as PayoutPartnerId), { intentId: current.intentId, partnerRef: current.partnerRef, returnAddress: current.walletAddress }, 'not_sent');
        } catch {
          /* the route is off: no deposit was made, so nothing is owed */
        }
      }
      return (await cancel(scoped, current.id, 'system', `signing_${request.status}`, ['awaiting_signatures'])) ? 'cancelled' : 'unchanged';
    } else {
      return 'unchanged';
    }
  }
  if ((current.status === 'sent' || current.status === 'partner_received') && !current.settlementPostedAt) {
    const after = await postSettlement(scoped, current);
    if (after.settlementPostedAt) return 'posted';
  }
  return current.status === 'sent' && row.status === 'awaiting_signatures' ? 'sent' : 'unchanged';
}

/** A test deposit whose owners' request executed or lapsed (DB only; no partner call). */
async function refreshDepositAddressIn(db: DrizzleDb, now: () => Date, row: store.DepositAddressRow): Promise<store.DepositAddressRow> {
  if (row.status !== 'test_requested' || !row.testRequestId) return row;
  const request = await readSigningRequest(db, row.orgId, row.testRequestId);
  if (!request) return row;
  if (request.status === 'executed' && request.executedDigest) {
    return (await store.moveDepositAddress(db, row.orgId, row.id, ['test_requested'], { status: 'test_sent', testDigest: request.executedDigest, updatedAt: now() })) ?? row;
  }
  if (request.status === 'expired' || request.status === 'cancelled' || request.status === 'failed') {
    // The test deposit was never sent: the owners may ask again.
    return (await store.moveDepositAddress(db, row.orgId, row.id, ['test_requested'], { status: 'pending_test', testRequestId: null, testWallet: null, updatedAt: now() })) ?? row;
  }
  return row;
}

/**
 * The withdrawal sweep (app/api/cron/withdrawals), across every org, each
 * row within its own org: withdrawals whose owners' request executed are
 * marked sent; a request that lapsed reverses its instruction and cancels
 * the withdrawal; a digest not yet posted is checked against its intent and
 * posted; a test deposit whose request closed is recorded or freed. Reads of
 * the API never call the partner; this does, once per row per run.
 */
export async function reconcileWithdrawals(deps: SettlementDeps): Promise<{ sent: number; cancelled: number; posted: number; testDeposits: number; errors: number }> {
  const out = { sent: 0, cancelled: 0, posted: 0, testDeposits: 0, errors: 0 };
  for (const row of await store.withdrawalsToReconcileForStaff(deps.db)) {
    try {
      const r = await settleRow(deps, row);
      if (r !== 'unchanged') out[r] += 1;
    } catch {
      out.errors += 1;
    }
  }
  for (const row of await store.testRequestedDepositAddressesForStaff(deps.db)) {
    const after = await refreshDepositAddressIn(deps.db, deps.now, row);
    if (after.status !== row.status) out.testDeposits += 1;
  }
  return out;
}

export async function listWithdrawals(deps: WithdrawalDeps): Promise<WithdrawalView[]> {
  const rows = await store.listWithdrawalRows(deps.db, deps.orgId, 'withdrawal');
  const out: WithdrawalView[] = [];
  for (const row of rows) out.push(await withdrawalView(deps, row));
  return out;
}

/** One withdrawal, as stored. Read-only: the sweep and the signing hook move it on. */
export async function getWithdrawal(deps: WithdrawalDeps, id: string): Promise<{ ok: true; withdrawal: WithdrawalView } | Refusal> {
  const row = await store.getWithdrawalRow(deps.db, deps.orgId, id);
  if (!row || row.kind !== 'withdrawal') return refuse(404, 'not_found', 'No such withdrawal.');
  return { ok: true, withdrawal: await withdrawalView(deps, row) };
}

/**
 * When an owners' request executes (the signing layer's `onExecuted`): a
 * test deposit is marked sent; a withdrawal is marked sent, its intent
 * checked on chain and its digest posted to the partner. Runs within the
 * request's own org.
 */
export async function withdrawalSigningExecuted(input: SettlementDeps, request: StoredRequest): Promise<void> {
  if (request.status !== 'executed' || !request.executedDigest) return;
  const ctx = { db: input.db, now: input.now, orgId: request.orgId };
  if (request.purpose === 'partner_test_deposit') {
    const row = await store.depositAddressByTestRequest(input.db, request.orgId, request.id);
    if (!row) return;
    const moved = await store.moveDepositAddress(input.db, request.orgId, row.id, ['test_requested'], { status: 'test_sent', testDigest: request.executedDigest, updatedAt: input.now() });
    if (moved) await store.recordWithdrawalEvent(input.db, { orgId: request.orgId, subject: 'deposit_address', subjectId: row.id, actor: 'system', action: 'test_sent', detail: { suiDigest: request.executedDigest }, at: input.now() });
    return;
  }
  if (request.purpose !== 'withdrawal' && request.purpose !== 'partner_payout') return;
  const row = await store.withdrawalBySigningRequest(input.db, request.orgId, request.id);
  if (!row) return;
  const sent = await markSent(ctx, row, request.executedDigest);
  try {
    await postSettlement({ ...input, orgId: request.orgId }, sent);
  } catch {
    /* retried by the sweep */
  }
}

/**
 * Before each owner's signature on a withdrawal (the signing layer's
 * `beforeSign`): the bytes commit to a bank account only by a salted hash, so
 * the server checks the withdrawal is still waiting, its bank account is
 * still the business's verified one with that very commitment, and the
 * deposit address is still the verified one the bytes pay. Otherwise the
 * signature is refused.
 */
export async function withdrawalBeforeSign(input: { db: DrizzleDb }, request: StoredRequest): Promise<{ code: string; error: string } | null> {
  if (request.purpose !== 'withdrawal' && request.purpose !== 'partner_payout') return null;
  const changed = (why: string) => ({ code: 'withdrawal_changed', error: `This withdrawal can no longer be signed: ${why}. Nothing was signed.` });
  const row = await store.withdrawalBySigningRequest(input.db, request.orgId, request.id);
  if (!row || row.status !== 'awaiting_signatures') return changed('it is no longer waiting for signatures');
  if ((request.purpose === 'withdrawal') !== (row.kind === 'withdrawal')) return changed('it is not the kind of payment the request names');
  const destination = await store.getDestination(input.db, request.orgId, row.destinationId);
  if (!destination || destination.status !== 'verified') return changed('its bank account was removed');
  if (destination.beneficiaryRef !== row.beneficiaryRef) return changed('its bank account is not the one the transaction pays');
  const deposit = await store.getDepositAddress(input.db, request.orgId, row.depositAddressId);
  if (!deposit || deposit.status !== 'verified' || !sameAddress(deposit.address, row.depositAddress)) return changed("the partner deposit address is no longer the business's verified one");
  const description = (request.summary as { description?: { actions?: Array<{ type: string; recipient?: string; beneficiaryRef?: string }> } } | null)?.description;
  const openIntent = description?.actions?.find((a) => a.type === 'open_intent');
  if (!openIntent || openIntent.beneficiaryRef !== row.beneficiaryRef || !sameAddress(openIntent.recipient, row.depositAddress)) return changed('the transaction does not pay this withdrawal');
  const details = (request.summary as { withdrawal?: WithdrawalSigningDetails } | null)?.withdrawal;
  if (!details || details.destinationId !== destination.id || details.last4 !== destination.last4 || details.bankCode !== destination.bankCode) return changed('the bank account shown is not the one it pays');
  if (details.holderName !== destination.holderName) return changed('the account holder shown is not the one it pays');
  return null;
}

// ─── Partner webhooks ───────────────────────────────────────────────────────

const PARTNER_TO_WITHDRAWAL: Record<Extract<PayoutEvent, { kind: 'payout' }>['status'], WithdrawalStatus> = {
  funds_received: 'partner_received',
  paid_out: 'paid_out',
  failed: 'failed',
  returned: 'returned',
};

export type WebhookInput = {
  partner: string;
  rawBody: string;
  signature: string | null;
  env: NodeJS.ProcessEnv;
  now: Date;
  db: DrizzleDb;
  readTransaction: (digest: string) => Promise<WithdrawalChainTx | null>;
  usdcType: string;
  /** Overrides the adapter (tests). */
  adapter?: PayoutPartner;
};

type WebhookAnswer = { status: number; body: Record<string, unknown> };

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return normalizeSuiAddress(a) === normalizeSuiAddress(b);
  } catch {
    return false;
  }
}

/** The checkpoint a transaction sits in, or null when it is not checkpointed (or unreadable). */
function checkpointOf(tx: WithdrawalChainTx | null): bigint | null {
  if (!tx || tx.checkpoint === null || tx.checkpoint === undefined || !/^\d+$/.test(tx.checkpoint)) return null;
  return BigInt(tx.checkpoint);
}

function usdcChange(tx: WithdrawalChainTx, address: string, usdcType: string): bigint {
  const t = normalizeStructTag(usdcType);
  let total = 0n;
  for (const c of tx.balanceChanges) {
    let coin: string;
    try {
      coin = normalizeStructTag(c.coinType);
    } catch {
      continue;
    }
    if (coin === t && sameAddress(c.address, address)) total += BigInt(c.amount);
  }
  return total;
}

/**
 * A payout partner's signed webhook. The signature is checked first, inside
 * the replay window; nothing is read before that. Each event counts once.
 * A status never goes backwards. A test deposit or a return is believed only
 * from the chain, by the digest the partner names.
 */
export async function handlePayoutWebhook(input: WebhookInput): Promise<WebhookAnswer> {
  if (!isPayoutPartnerId(input.partner)) return { status: 404, body: { error: 'unknown partner' } };
  let adapter: PayoutPartner;
  try {
    adapter = input.adapter ?? payoutPartner(input.partner, input.env);
  } catch (error) {
    if (error instanceof PayoutPartnerUnavailable) return { status: 503, body: { error: error.message, code: error.code } };
    throw error;
  }
  let event: PayoutEvent;
  try {
    event = adapter.handleWebhook({ rawBody: input.rawBody, signature: input.signature, now: input.now });
  } catch (error) {
    if (error instanceof WebhookRejected) {
      const status = error.code === 'bad_body' || error.code === 'unknown_event' ? 400 : error.code === 'partner_not_configured' || error.code === 'partner_not_connected' ? 503 : 401;
      return { status, body: { error: error.message, code: error.code } };
    }
    throw error;
  }
  const at = input.now;
  if (event.kind === 'test_deposit') {
    const row = await store.depositAddressForWebhook(input.db, adapter.id, event.accountRef);
    if (!row) return { status: 200, body: { ignored: 'no such account' } };
    if (row.status === 'verified') return { status: 200, body: { duplicate: true } };
    if (row.status === 'test_requested') {
      // The owners' transaction may have landed before Splash recorded it:
      // the partner retries, and the retry counts.
      return { status: 503, body: { error: 'the test deposit is not recorded yet; retry' } };
    }
    if (row.status !== 'test_sent' || row.testDigest !== event.suiDigest) {
      await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'deposit_address', subjectId: row.id, actor: `partner:${adapter.id}`, action: 'test_confirmation_refused', detail: { reason: 'not the test deposit Splash sent', suiDigest: event.suiDigest }, at });
      return { status: 200, body: { ignored: 'not the test deposit sent' } };
    }
    const claimed = await store.claimPartnerEvent(input.db, { partner: adapter.id, eventId: event.eventId, orgId: row.orgId, subjectId: row.id, status: 'test_deposit', at });
    if (!claimed) return { status: 200, body: { duplicate: true } };
    let tx: WithdrawalChainTx | null;
    try {
      tx = await input.readTransaction(event.suiDigest);
    } catch {
      tx = null;
    }
    if (!tx) {
      await store.releasePartnerEvent(input.db, adapter.id, event.eventId);
      return { status: 503, body: { error: 'the chain has not shown that transaction yet; retry' } };
    }
    const received = usdcChange(tx, row.address, input.usdcType);
    if (!tx.success || !sameAddress(tx.sender, row.testWallet) || received !== row.testAmountMinor) {
      await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'deposit_address', subjectId: row.id, actor: `partner:${adapter.id}`, action: 'test_confirmation_refused', detail: { reason: 'the chain does not show this test deposit', suiDigest: event.suiDigest }, at });
      return { status: 200, body: { ignored: 'the chain does not show this test deposit' } };
    }
    const moved = await store.moveDepositAddress(input.db, row.orgId, row.id, ['test_sent'], { status: 'verified', verifiedAt: at, updatedAt: at });
    if (moved) await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'deposit_address', subjectId: row.id, actor: `partner:${adapter.id}`, action: 'verified', detail: { suiDigest: event.suiDigest, eventId: event.eventId }, at });
    return { status: 200, body: { ok: true } };
  }

  const row = await store.withdrawalForWebhook(input.db, adapter.id, event.intentId);
  // An event must name the intent AND the partner's own reference for it.
  if (!row || !row.partnerRef || row.partnerRef !== event.partnerRef) return { status: 200, body: { ignored: 'no such payout' } };
  const to = PARTNER_TO_WITHDRAWAL[event.status];
  const from = row.status as WithdrawalStatus;
  if (from === 'awaiting_signatures' || from === 'preparing') {
    // The deposit's digest is not recorded yet; the retry counts.
    return { status: 503, body: { error: 'the deposit is not recorded yet; retry' } };
  }
  if (!canAdvanceWithdrawal(from, to)) {
    return { status: 200, body: { ignored: `a withdrawal ${from.replace(/_/g, ' ')} does not move to ${to.replace(/_/g, ' ')}` } };
  }
  const claimed = await store.claimPartnerEvent(input.db, { partner: adapter.id, eventId: event.eventId, orgId: row.orgId, subjectId: row.id, status: event.status, at });
  if (!claimed) return { status: 200, body: { duplicate: true } };
  const set: Partial<store.WithdrawalInsert> & { status: WithdrawalStatus; updatedAt: Date } = { status: to, updatedAt: at };
  if (event.status === 'paid_out' && event.bankRef) set.bankRef = event.bankRef;
  if (event.status === 'failed') set.failure = event.failureReason ?? 'the partner could not pay it out';
  if (event.status === 'returned') {
    let tx: WithdrawalChainTx | null;
    try {
      tx = await input.readTransaction(event.returnDigest as string);
    } catch {
      tx = null;
    }
    if (!tx) {
      await store.releasePartnerEvent(input.db, adapter.id, event.eventId);
      return { status: 503, body: { error: 'the chain has not shown the return yet; retry' } };
    }
    // A return is USDC FROM the deposit address the withdrawal paid, back
    // INTO the business wallet, in a transaction that is neither the
    // withdrawal itself nor the address's test deposit.
    const credited = tx.success ? usdcChange(tx, row.walletAddress, input.usdcType) : 0n;
    const fromDeposit = sameAddress(tx.sender, row.depositAddress);
    const ownDigest = event.returnDigest === row.suiDigest;
    if (!fromDeposit || ownDigest || credited <= 0n) {
      await store.releasePartnerEvent(input.db, adapter.id, event.eventId);
      await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'withdrawal', subjectId: row.id, actor: `partner:${adapter.id}`, action: 'return_refused', detail: { reason: 'the chain does not show USDC from the deposit address back in the business wallet', returnDigest: event.returnDigest }, at });
      return { status: 200, body: { ignored: 'the chain does not show the return' } };
    }
    const returnDigest = event.returnDigest as string;
    const refuse = async (reason: string, ignored: string, action = 'return_refused', more: Record<string, unknown> = {}): Promise<WebhookAnswer> => {
      await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'withdrawal', subjectId: row.id, actor: `partner:${adapter.id}`, action, detail: { reason, returnDigest, ...more }, at });
      return { status: 200, body: { ignored } };
    };
    // A digest that closed a payout before every return was claimed (0043).
    const usedBy = await store.withdrawalByReturnDigest(input.db, returnDigest);
    if (usedBy && usedBy.id !== row.id) {
      await store.releasePartnerEvent(input.db, adapter.id, event.eventId);
      return refuse('that return digest already closed another withdrawal', 'that return was already counted');
    }
    // The deposit address is shared by every payout of this business to this
    // partner, so the chain cannot say which payout a transfer returns. It can
    // say the transfer came after this payout's own deposit: an older one (a
    // refund of the test deposit, a return of an earlier payout) is not it.
    let deposit: WithdrawalChainTx | null = null;
    try {
      deposit = row.suiDigest ? await input.readTransaction(row.suiDigest) : null;
    } catch {
      deposit = null;
    }
    const depositCheckpoint = checkpointOf(deposit);
    const returnCheckpoint = checkpointOf(tx);
    if (depositCheckpoint === null || returnCheckpoint === null) {
      await store.releasePartnerEvent(input.db, adapter.id, event.eventId);
      return { status: 503, body: { error: 'the chain has not checkpointed the deposit or the return yet; retry' } };
    }
    if (returnCheckpoint <= depositCheckpoint) {
      return refuse("that transfer came before this payout's deposit", 'that transfer came before the deposit', 'return_refused', { returnCheckpoint: returnCheckpoint.toString(), depositCheckpoint: depositCheckpoint.toString() });
    }
    // Every return digest, short or whole, counts for one payout only.
    const claim = await store.claimReturn(input.db, { digest: returnDigest, withdrawalId: row.id, orgId: row.orgId, creditedMinor: credited, checkpoint: returnCheckpoint, eventId: event.eventId, at });
    if (!claim.claimed) {
      if (claim.heldBy === row.id) return { status: 200, body: { duplicate: true } };
      await store.releasePartnerEvent(input.db, adapter.id, event.eventId);
      return refuse('that return digest is already counted for another payout', 'that return was already counted');
    }
    const total = await store.returnedTotal(input.db, row.orgId, row.id);
    if (total > row.amountMinor) {
      // Nothing above what the payout sent is taken for it: an over-return is
      // some other payout's money, or the partner's mistake, and ops look at
      // it. The claim is given back so the payout it belongs to can take it.
      await store.releaseReturn(input.db, row.orgId, row.id, returnDigest);
      return refuse('more came back than this payout sent', 'more came back than this payout sent; ops will look at it', 'return_over', { creditedMinor: credited.toString(), alreadyReturnedMinor: (total - credited).toString(), amountMinor: row.amountMinor.toString() });
    }
    if (total < row.amountMinor) {
      // Short: recorded, and left failed for ops; it closes as returned only when the returns add up.
      const shortSet = { returnedMinor: total, failure: `short return: ${total} of ${row.amountMinor} USDC minor units came back`, updatedAt: at };
      // Straight back with no failure first: it did not pay out, so it is failed (forward only).
      const movedToFailed = from === 'failed' ? null : await store.moveWithdrawal(input.db, row.orgId, row.id, [from], { ...shortSet, status: 'failed' });
      if (from === 'failed') await store.patchWithdrawal(input.db, row.orgId, row.id, shortSet);
      await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'withdrawal', subjectId: row.id, actor: `partner:${adapter.id}`, action: 'return_short', detail: { eventId: event.eventId, returnDigest, creditedMinor: credited.toString(), returnedMinor: total.toString(), amountMinor: row.amountMinor.toString() }, at });
      if (movedToFailed && row.partnerRef) {
        // The failed path asks for the USDC back; so does this one, for the rest.
        const accepted = await reverseInstruction({ now: () => at }, adapter, { intentId: row.intentId, partnerRef: row.partnerRef, returnAddress: row.walletAddress }, 'short_return');
        await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'withdrawal', subjectId: row.id, actor: 'system', action: 'return_requested', detail: { accepted, returnAddress: row.walletAddress, outstandingMinor: (row.amountMinor - total).toString() }, at });
      }
      return { status: 200, body: { ok: true, short: true } };
    }
    set.returnDigest = returnDigest;
    set.returnedMinor = total;
  }
  let moved: store.WithdrawalRow | null;
  try {
    moved = await store.moveWithdrawal(input.db, row.orgId, row.id, [from], set);
  } catch (error) {
    // The unique index on return_digest: another withdrawal took this return meanwhile.
    if (set.returnDigest) {
      await store.releaseReturn(input.db, row.orgId, row.id, set.returnDigest);
      await store.releasePartnerEvent(input.db, adapter.id, event.eventId);
      return { status: 200, body: { ignored: 'that return was already counted' } };
    }
    throw error;
  }
  if (!moved) return { status: 200, body: { ignored: 'the withdrawal moved meanwhile' } };
  await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'withdrawal', subjectId: row.id, actor: `partner:${adapter.id}`, action: to, detail: { eventId: event.eventId, ...(set.bankRef ? { bankRef: set.bankRef } : {}), ...(set.returnDigest ? { returnDigest: set.returnDigest } : {}) }, at });
  if (to === 'failed' && row.partnerRef) {
    // The USDC reached the partner and the bank payout failed: ask for it back, to the business wallet.
    const accepted = await reverseInstruction({ now: () => at }, adapter, { intentId: row.intentId, partnerRef: row.partnerRef, returnAddress: row.walletAddress }, 'payout_failed');
    await store.recordWithdrawalEvent(input.db, { orgId: row.orgId, subject: 'withdrawal', subjectId: row.id, actor: 'system', action: 'return_requested', detail: { accepted, returnAddress: row.walletAddress }, at });
  }
  return { status: 200, body: { ok: true } };
}

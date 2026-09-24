import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * W1 — persistence & state: the single relational source of truth.
 *
 * Rules (from the mainnet readiness prompt):
 * - Every money column is BIGINT MINOR UNITS plus a currency code — never
 *   numeric/float. Display formatting happens at the edge, never here.
 * - Every table carries created_at/updated_at.
 * - FX rates are `numeric` (exact decimal, surfaces as string in JS) — a
 *   rate is a ratio, not money.
 * - Redis stays cache/rate-limit only; nothing here ever lives only there.
 *
 * Host: DigitalOcean Managed PostgreSQL (0xSky decision 2026-07-18) —
 * daily backups + PITR come with the managed cluster; see docs/W1-BACKUPS.md.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const userRole = pgEnum('user_role', ['maker', 'checker', 'admin', 'viewer']);
export const kybStatus = pgEnum('kyb_status', ['none', 'pending', 'basic', 'full', 'rejected']);
export const intentState = pgEnum('intent_state', [
  'AUTHORIZED', 'DEPOSIT_CONFIRMED', 'EXCHANGING', 'EXCHANGED', 'QUEUED', 'SETTLING', 'SETTLED',
  'SWEEPING', 'DISBURSED', 'CREDITED', 'FAILED', 'REFUNDING', 'REFUNDED', 'OPS_HOLD', 'COMPLIANCE_HOLD',
]);
/** Individual or business. FATF R.16 requires different identifying data for each. */
export const beneficiaryType = pgEnum('beneficiary_type', ['INDIVIDUAL', 'BUSINESS']);

/**
 * The identifier a corridor's banking system actually routes on.
 *
 * Not cosmetic: PH clears on a bank code through PESONet/InstaPay, the EU and
 * UK on IBAN, GB domestic on sort code, and most of ASEAN on SWIFT plus a
 * local account number. A beneficiary row that stores only "account number"
 * cannot be paid in most of these corridors, which is the state this replaces.
 */
export const bankIdScheme = pgEnum('bank_id_scheme', [
  'SWIFT_BIC',
  'IBAN',
  'LOCAL_BANK_CODE',
  'GB_SORT_CODE',
  'US_ROUTING_ABA',
  'AU_BSB',
  'IN_IFSC',
  'PROXY_ID',
]);

export const screeningVerdict = pgEnum('screening_verdict', ['CLEAR', 'REVIEW', 'BLOCK', 'ERROR', 'ATTESTED']);
export const webhookStatus = pgEnum('webhook_status', ['RECEIVED', 'PROCESSED', 'FAILED', 'SKIPPED']);

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  legalName: text('legal_name'),

  // ── The payer's own half of FATF R.16 ─────────────────────────────────
  // Migration 0006 gave `suppliers` the whole beneficiary side and the
  // originator nothing, so a complete travel-rule record could not be
  // produced however carefully the beneficiary was filled in. Org-level
  // facts, established once at KYB and reused by every payment.
  /** SSM, UEN, ACRA, DTI, NPWP — the identifier a business normally has. */
  registrationNumber: text('registration_number'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  addressCity: text('address_city'),
  addressState: text('address_state'),
  addressPostalCode: text('address_postal_code'),
  /** ISO 3166-1 alpha-2. */
  addressCountry: text('address_country'),

  kybStatus: kybStatus('kyb_status').notNull().default('none'),
  kybTier: text('kyb_tier'),
  /** Wallet spec §3 — the accountable onboarding lifecycle:
   *  REGISTERED → KYB_SUBMITTED → KYB_PROVIDER_APPROVED → KYB_ADMIN_APPROVED →
   *  ACTIVE, plus REJECTED / SUSPENDED. Money movement unlocks only at ACTIVE.
   *
   *  Text, not a pgEnum, deliberately: lib/compliance/kyb-state.ts is the
   *  authority on legal transitions (same rationale as proposals.status), and a
   *  text column means adding a state is a code change, not an ALTER TYPE
   *  migration. The coarse `kyb_status` enum above is left untouched. */
  kybLifecycle: text('kyb_lifecycle').notNull().default('REGISTERED'),
  /** Onboarding — how this workspace said it will use Splash: 'pay',
   *  'collect' or 'treasury'. Null until chosen; presentation only. It
   *  tailors which setup steps are emphasised and NOTHING else — the KYB
   *  lifecycle above stays the single authority on what may move money. */
  intent: text('intent'),
  /** Wallet spec §2.3 — the org's on-chain BusinessAccount object id. Null
   *  until the AdminCap-gated business_account::verify_business has run. */
  suiBusinessAccountId: text('sui_business_account_id'),
  ...timestamps,
});

/**
 * A person. Identity only.
 *
 * This table used to carry `org_id` and `role` directly, which made every row
 * simultaneously an identity and a membership — so a user could not exist
 * without belonging to an organisation with a role. That is what made the auth
 * bypass structural rather than a slip: signup needed a row, a row needed a
 * role, and the role it got was one that can approve payments.
 *
 * Membership is its own table now. A user with no membership row is exactly
 * what signup produces: able to log in, able to see an empty workspace, and
 * able to authorise nothing.
 */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  /**
   * scrypt, formatted by lib/auth/password.ts. Nullable because an identity
   * can exist without one — an invited user before they set a password, or a
   * zkLogin identity that never has one at all.
   */
  passwordHash: text('password_hash'),
  /** Null until the address is proven. Not a boolean: when it happened is the
   *  auditable fact, and `true` cannot answer that. */
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  /**
   * Bumped whenever the credentials that mint a session change: a password
   * set through verification or reset, and the verification itself. A
   * session carries the version it was minted under, and a reader that finds
   * a different number treats the session as absent. That is how "the
   * mailbox owner verifies and every earlier session dies" is enforced
   * without a session table to sweep.
   */
  credentialVersion: integer('credential_version').notNull().default(1),
  ...timestamps,
}, (table) => [
  uniqueIndex('users_email_unique').on(table.email),
]);

/**
 * Single-use, hashed, expiring tokens that prove a mailbox.
 *
 * Only the SHA-256 of the token is stored; the token itself exists in the
 * link and nowhere else, so a copy of this table cannot be turned into
 * links. `purpose` says what opening the link earns — `verify_email` or
 * `reset_password` — and lib/auth/email-verification.ts is the authority on
 * the values; a token issued for one purpose is refused for the other.
 * `used_at` makes each row single use: consuming a token is one UPDATE that
 * both checks and sets it, so two requests racing on the same link cannot
 * both win.
 */
export const emailVerificationTokens = pgTable('email_verification_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  purpose: text('purpose').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('email_verification_tokens_hash_unique').on(table.tokenHash),
  index('email_verification_tokens_user_idx').on(table.userId),
]);

/**
 * Hits against a named rate-limit bucket, for lib/server/rate-limit.ts.
 *
 * The same shape as `login_attempts`, generalised: `bucket` names the rule
 * (`signup:ip`, `verify-resend:email`, …) and `key` is the thing being
 * limited within it. In Postgres, not Redis, for the reason login_attempts
 * gives — a limit that evaporates when a cache restarts is a pause, not a
 * limit. Rows are pruned by the limiter as it reads them.
 */
export const rateLimitHits = pgTable('rate_limit_hits', {
  id: text('id').primaryKey(),
  bucket: text('bucket').notNull(),
  key: text('key').notNull(),
  hitAt: timestamp('hit_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('rate_limit_hits_bucket_key_idx').on(table.bucket, table.key, table.hitAt),
]);

/**
 * Who belongs to which organisation, and as what.
 *
 * There is deliberately no default role. Drizzle would accept
 * `.default('viewer')` and the previous schema did exactly that, which means
 * an insert that forgets the role still produces a member. Every membership
 * here states its role, or the insert fails.
 *
 * A row in this table is a grant. Nothing creates one implicitly: not signup,
 * not login, and not a failed authority lookup.
 */
export const memberships = pgTable('memberships', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull().references(() => organizations.id),
  role: userRole('role').notNull(),
  /** Who granted it. Null for the first membership in a new organisation,
   *  which has no prior member to do the granting. */
  grantedBy: text('granted_by'),
  ...timestamps,
}, (table) => [
  uniqueIndex('memberships_user_org_unique').on(table.userId, table.orgId),
  index('memberships_org_idx').on(table.orgId),
  index('memberships_user_idx').on(table.userId),
]);

/**
 * LEGACY — no longer written. Failed login attempts used to live here; the
 * login limiter now rides `rate_limit_hits` like every other limit (WS7). The
 * table stays until a migration drops it, so an in-flight deploy that still
 * runs the old code does not fail on a missing relation.
 */
export const loginAttempts = pgTable('login_attempts', {
  id: text('id').primaryKey(),
  /** Lowercased email as submitted. Scopes the per-email limit; it is a login
   *  identifier, not proof anyone owns the address. */
  email: text('email').notNull(),
  ip: text('ip').notNull(),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('login_attempts_email_idx').on(table.email, table.attemptedAt),
  index('login_attempts_ip_idx').on(table.ip, table.attemptedAt),
]);

/**
 * Enrolled passkey credentials — SIP-9 secp256r1 signers.
 *
 * The public key column is the reason this table exists, and it is the single
 * most important detail in the passkey design.
 *
 * WebAuthn returns a credential's public key exactly once, in the attestation
 * at creation. A later assertion — an actual signature — returns the signature
 * and the credential id, and no key. So a server that did not store the key at
 * enrolment cannot identify which Sui address just signed. The SDK's own
 * workaround for that situation is `PasskeyKeypair.signAndRecover` plus
 * `findCommonPublicKey`: sign two different messages, recover the candidate
 * keys from each, and intersect them. That is two extra user gestures and a
 * guess, on the approval path, to recover something we were handed for free
 * once and threw away.
 *
 * So: persist it at enrolment, and never need recovery.
 *
 * `sui_address` is derived from the public key at enrolment and stored beside
 * it. It is not a cache — it is what an approval is checked against, and
 * recomputing it per request would mean the check depends on the derivation
 * being stable forever rather than on a value we committed to.
 *
 * One credential per origin per user. A person may hold a passkey for
 * localhost and another for the production host — those are different
 * credentials at the WebAuthn level and cannot be interchanged — but not two
 * for the same origin, because then "which key approved this" has more than
 * one answer.
 */
export const passkeyCredentials = pgTable('passkey_credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** WebAuthn credential id, base64url. Returned on every assertion, so it is
   *  how an incoming signature is matched to a stored key. */
  credentialId: text('credential_id').notNull(),
  /** 33-byte compressed secp256r1 point, base64. Captured at creation because
   *  the authenticator will never send it again. */
  publicKey: text('public_key').notNull(),
  /** Derived from the public key at enrolment, with the SIP-9 0x06 flag. The
   *  address an approval's sender must equal. */
  suiAddress: text('sui_address').notNull(),
  /**
   * The WebAuthn relying-party id this credential is bound to.
   *
   * A credential enrolled on `localhost` cannot be used on `v1.splashz.xyz`:
   * the browser scopes it to the rpId and simply will not offer it elsewhere.
   * Storing it makes that visible — a credential that cannot be used on the
   * current host is a row we can explain rather than a silent absence.
   */
  rpId: text('rp_id').notNull(),
  /** Set when the credential is retired. Revocation is a tombstone, not a
   *  delete: an approval already anchored on chain names this credential, and
   *  removing the row would orphan that evidence. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex('passkey_credentials_credential_unique').on(table.credentialId),
  /* One ACTIVE credential per origin, not one row ever. An unconditional
     unique index would let a revoked row occupy the origin permanently, so
     revoking would lock the user out of re-enrolling — the opposite of what a
     tombstone is for. Postgres partial index: the constraint applies only
     where revoked_at IS NULL. */
  uniqueIndex('passkey_credentials_active_user_rp_unique')
    .on(table.userId, table.rpId)
    .where(sql`${table.revokedAt} is null`),
  index('passkey_credentials_address_idx').on(table.suiAddress),
]);

/**
 * Wallet spec §2.3 — per-human zkLogin signer ↔ record mapping.
 *
 * One org has ONE on-chain BusinessAccount but MANY individual signers: a
 * zkLogin address is derived from (iss, sub, aud, salt), so `ceo@acme.com` and
 * `controller@acme.com` get different Sui addresses. That is what gives
 * maker-checker per-human signer attribution.
 *
 * `oauth_sub` is a provider user id — treat it as PII: never log it raw.
 */
export const walletIdentities = pgTable('wallet_identities', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  orgId: text('org_id').notNull().references(() => organizations.id),
  /** Derived from sub/iss/aud/salt — the address that signs this human's intents. */
  suiAddress: text('sui_address').notNull(),
  oauthIss: text('oauth_iss').notNull(),
  oauthSub: text('oauth_sub').notNull(),
  /** Our OAuth client id for THIS environment — a separate client per env is
   *  both a Mysten best practice and an IACR 2026/227 mitigation. */
  oauthAud: text('oauth_aud').notNull(),
  emailAtLogin: text('email_at_login'),
  ...timestamps,
}, (table) => [
  uniqueIndex('wallet_identities_sui_address_unique').on(table.suiAddress),
  // One address per identity per app — the cross-app impersonation guard.
  uniqueIndex('wallet_identities_oauth_subject_unique').on(table.oauthIss, table.oauthSub, table.oauthAud),
  index('wallet_identities_user_idx').on(table.userId),
  index('wallet_identities_org_idx').on(table.orgId),
]);

/** Suppliers — the relationship-first noun (today's "recipients"). */
/**
 * A beneficiary — the party who receives money.
 *
 * Until now this held a name, a country, a bank name, an optional SWIFT and an
 * account reference. That is enough to display a row and not enough to pay
 * anyone: a regulated cross-border payout needs the beneficiary's legal
 * identity and address, the bank's routing identifier for that specific
 * corridor, and — at the point of payment — a stated purpose and source of
 * funds. Partners ask for all of it during onboarding, and FATF
 * Recommendation 16 (the travel rule) requires the originator and beneficiary
 * data to travel WITH the transfer, not sit in a file somewhere.
 *
 * The split is deliberate: identity and bank routing are properties of the
 * BENEFICIARY and live here; purpose of payment, source of funds and the
 * relationship are properties of a PAYMENT and live on `payment_intents`,
 * because the same supplier can be paid for different reasons.
 *
 * Columns are nullable because an existing row predates them and because the
 * required set differs by corridor. What is required is enforced in
 * `lib/compliance/travel-rule.ts` per destination country, at the point the
 * payment is authorized — not by the column definition, which cannot know the
 * corridor.
 */
export const suppliers = pgTable('suppliers', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  country: text('country').notNull(),
  bankName: text('bank_name'),
  swift: text('swift'),
  accountRef: text('account_ref'),
  kybStatus: kybStatus('kyb_status').notNull().default('none'),
  /** Set when the counterparty claims a Splash account ("On Splash"). */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),

  // ── Legal identity (FATF R.16 beneficiary data) ──────────────────────────
  /** INDIVIDUAL or BUSINESS. Decides which identity fields are required. */
  beneficiaryType: beneficiaryType('beneficiary_type'),
  /** Registered legal name, when it differs from the trading name in `name`. */
  legalName: text('legal_name'),
  /** Company registration number (BUSINESS) — SSM, UEN, DTI, NPWP and so on. */
  registrationNumber: text('registration_number'),
  /** Date of birth, ISO date (INDIVIDUAL). One of the R.16 identifiers. */
  dateOfBirth: text('date_of_birth'),
  /** National identity document number (INDIVIDUAL), where the corridor asks. */
  nationalIdNumber: text('national_id_number'),

  // ── Address. R.16 accepts an address as the originator identifier and most
  //    SEA partners require the beneficiary's too. ISO 3166-1 alpha-2 country.
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  addressCity: text('address_city'),
  addressState: text('address_state'),
  addressPostalCode: text('address_postal_code'),
  addressCountry: text('address_country'),

  // ── Bank routing ─────────────────────────────────────────────────────────
  /** Which identifier the destination banking system routes on. */
  bankIdScheme: bankIdScheme('bank_id_scheme'),
  /** The value for `bankIdScheme` — a BIC, an IBAN, a local bank code, a sort code. */
  bankIdValue: text('bank_id_value'),
  /** Branch code, where the corridor separates it from the bank code (SG, TH). */
  bankBranchCode: text('bank_branch_code'),
  /** ISO 3166-1 alpha-2 of the BANK, which is not always the beneficiary's. */
  bankCountry: text('bank_country'),
  /** Local account number, when the scheme is not itself the account (IBAN is). */
  bankAccountNumber: text('bank_account_number'),
  /** Account holder name exactly as the bank has it, for name-matching checks. */
  bankAccountName: text('bank_account_name'),

  // ── KYT / screening, the last result for this beneficiary ────────────────
  screeningVerdict: screeningVerdict('screening_verdict'),
  screenedAt: timestamp('screened_at', { withTimezone: true }),
  /** Provider's reference, so a verdict can be re-fetched and audited. */
  screeningReference: text('screening_reference'),

  // ── Operational record ───────────────────────────────────────────────────
  /** PAYOUT_ONLY, SWEEP_ACCOUNT or STORED_BALANCE — read on the settlement path. */
  tier: text('tier'),
  /** Venue, destination bank and account, delay. One object, queried by nobody. */
  sweepConfig: jsonb('sweep_config'),
  demo: boolean('demo').notNull().default(false),
  /** Contact email for the KYB invite, whether one was sent, and whether this
   *  beneficiary was typed in or created by an invoice link. */
  recipientMetadata: jsonb('recipient_metadata'),

  /** How this recipient is paid. BANK: local currency through a partner rail
   *  (locked until the paying business is verified). WALLET: USDC on Sui to
   *  `walletAddress` — the only lane an unverified business may use. */
  payoutMethod: text('payout_method').notNull().default('BANK'),
  /** Sui address, lower-cased, validated by normaliseSuiAddress — never an
   *  Ethereum address padded to fit. Null for BANK recipients. */
  walletAddress: text('wallet_address'),
  /** 'SLUSH' | 'METAMASK_SUI_SNAP' — the wallet the recipient said they use. */
  walletProvider: text('wallet_provider'),

  ...timestamps,
}, (table) => [
  index('suppliers_org_idx').on(table.orgId),
  index('suppliers_org_created_idx').on(table.orgId, table.createdAt),
  index('suppliers_screening_idx').on(table.screeningVerdict),
]);

export const invoices = pgTable('invoices', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  supplierId: text('supplier_id').references(() => suppliers.id),
  issuerOrg: text('issuer_org').notNull(),
  payerName: text('payer_name'),
  payerEmail: text('payer_email'),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  targetCurrency: text('target_currency').notNull(),
  dueDate: text('due_date'),
  status: text('status').notNull().default('draft'),
  memo: text('memo'),
  walrusBlobId: text('walrus_blob_id'),
  sealPolicyId: text('seal_policy_id'),
  payLinkSlug: text('pay_link_slug'),
  /** The reference a payer quotes on the wire, so a bank credit can be matched
   *  back to the invoice it settles. */
  paymentReference: text('payment_reference'),
  /** Hash of the uploaded document. `walrusBlobId` says where it is; this says
   *  what it was, so tampering is detectable without fetching it. */
  documentSha256: text('document_sha256'),
  /** The transfer that settles this invoice. The reverse link already exists on
   *  `payment_intents.invoice_id`; without this one, "was this paid" is a scan. */
  transferIntentId: text('transfer_intent_id'),
  demo: boolean('demo').notNull().default(false),
  /** Paid in USDC on Sui to the issuer's own wallet (migration 0024): the
   *  transaction that proved it. One transaction pays one invoice. */
  usdcTxDigest: text('usdc_tx_digest'),
  usdcPaidAt: timestamp('usdc_paid_at', { withTimezone: true }),
  usdcPayerAddress: text('usdc_payer_address'),
  /** The wallet the payer was shown, pinned when first shown. */
  usdcReceiveAddress: text('usdc_receive_address'),
  ...timestamps,
}, (table) => [
  index('invoices_org_idx').on(table.orgId),
  index('invoices_org_created_idx').on(table.orgId, table.createdAt),
  index('invoices_supplier_idx').on(table.supplierId),
  uniqueIndex('invoices_pay_link_unique').on(table.payLinkSlug),
  uniqueIndex('invoices_usdc_tx_digest_unique').on(table.usdcTxDigest),
]);

export const paymentIntents = pgTable('payment_intents', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  supplierId: text('supplier_id').references(() => suppliers.id),
  invoiceId: text('invoice_id').references(() => invoices.id),
  state: intentState('state').notNull(),
  sourceAmountMinor: bigint('source_amount_minor', { mode: 'bigint' }).notNull(),
  sourceCurrency: text('source_currency').notNull(),
  targetAmountMinor: bigint('target_amount_minor', { mode: 'bigint' }).notNull(),
  targetCurrency: text('target_currency').notNull(),
  feeMinor: bigint('fee_minor', { mode: 'bigint' }),
  /** Exact decimal ratio (not money) — string in JS. */
  exchangeRate: numeric('exchange_rate'),
  quoteId: text('quote_id'),
  quoteExpiresAt: timestamp('quote_expires_at', { withTimezone: true }),
  fundingSessionId: text('funding_session_id'),
  fundingMethod: text('funding_method'),
  fundingProvider: text('funding_provider'),
  suiTxDigest: text('sui_tx_digest'),
  receiptObjectId: text('receipt_object_id'),
  walrusBlobId: text('walrus_blob_id'),
  auditAnchorId: text('audit_anchor_id'),
  failureReason: text('failure_reason'),
  failedAtState: text('failed_at_state'),
  demo: boolean('demo').notNull().default(false),
  idempotencyKey: text('idempotency_key'),

  // ── Travel-rule context that belongs to the PAYMENT, not the beneficiary ──
  /** Purpose-of-payment code. BNM, BSP and BI all require one on inbound wires. */
  purposeCode: text('purpose_code'),
  /** Free-text purpose, shown to the partner alongside the code. */
  purposeDescription: text('purpose_description'),
  /** Where the money came from — required above threshold in most corridors. */
  sourceOfFunds: text('source_of_funds'),
  /** Payer's relationship to the beneficiary (supplier, employee, intragroup). */
  beneficiaryRelationship: text('beneficiary_relationship'),
  /**
   * The originator and beneficiary data as transmitted, frozen at authorization.
   *
   * A snapshot, not a join: R.16 is about what travelled WITH the payment, and
   * a beneficiary edited next week must not change what this payment carried.
   */
  travelRuleSnapshot: jsonb('travel_rule_snapshot'),

  // ── Settlement detail ────────────────────────────────────────────────────
  /** The beneficiary as the operator typed it, before it resolves to a supplier. */
  recipientName: text('recipient_name'),
  /** PAYOUT_ONLY, SWEEP_ACCOUNT or STORED_BALANCE — read on the settlement path. */
  deliveryTier: text('delivery_tier'),
  /**
   * The rest of one settlement's own detail: stablecoin and rail chosen, DAX
   * tier, peg-check verdict, Seal policy id, the composed on-chain actions.
   *
   * One jsonb rather than twenty sparse columns because these are attributes of
   * a single settlement, not dimensions anyone queries across. Anything that
   * later needs an index earns a column of its own.
   */
  settlementMetadata: jsonb('settlement_metadata'),

  ...timestamps,
}, (table) => [
  index('intents_org_idx').on(table.orgId),
  index('intents_org_created_idx').on(table.orgId, table.createdAt),
  index('intents_supplier_idx').on(table.supplierId),
  index('intents_state_idx').on(table.state),
  /** Scoped to the org, like `proposals_open_idempotency_unique` already is.
   *  Unscoped, the first tenant to use "payroll-friday" would block every
   *  other tenant from that key forever — a cross-tenant denial of service
   *  through a field the client chooses. */
  uniqueIndex('intents_idempotency_unique').on(table.orgId, table.idempotencyKey),
]);

/** Lifecycle audit trail — one row per state transition (statusHistory). */
export const intentTransitions = pgTable('intent_transitions', {
  id: text('id').primaryKey(),
  intentId: text('intent_id').notNull().references(() => paymentIntents.id),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
  /** Why. FAILED without one sends an operator to a restarted process's logs. */
  reason: text('reason'),
  actor: text('actor'),
  ...timestamps,
}, (table) => [index('transitions_intent_idx').on(table.intentId)]);

/** Track A — server-owned policy record. Thresholds are BIGINT USD micro
 *  units; the client can never supply any of these. */
export const orgPolicies = pgTable('org_policies', {
  orgId: text('org_id').primaryKey().references(() => organizations.id),
  tier1ThresholdUsdMicro: bigint('tier1_threshold_usd_micro', { mode: 'bigint' }).notNull(),
  dualApprovalThresholdUsdMicro: bigint('dual_approval_threshold_usd_micro', { mode: 'bigint' }).notNull(),
  whitelistedAutoKinds: jsonb('whitelisted_auto_kinds').notNull(),
  operatingMinimumByCorridor: jsonb('operating_minimum_by_corridor').notNull(),
  perCorridorState: jsonb('per_corridor_state').notNull(),
  globalState: text('global_state').notNull().default('ARMED'),
  ...timestamps,
});

/**
 * Onboarding step 1 — a delivered fact, not a checkbox in flight.
 *
 * Signup validated `accepted: true` and stored nothing, so no money route
 * could ever prove the terms were agreed to. One row per user per terms
 * version; the money gate asks for any CURRENT-version row in the org
 * (lib/server/onboarding.ts), and re-acceptance after a version bump writes
 * a new row rather than updating the old one — the history is the point.
 */
export const termsAcceptances = pgTable('terms_acceptances', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  orgId: text('org_id').notNull().references(() => organizations.id),
  /** content/legal.ts TERMS_VERSION at the moment of acceptance. */
  version: text('version').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Every stablecoin payment Splash quoted or verified — wallet transfers AND
 * x402 payments, because they share one allowance.
 *
 * A row is written at QUOTE time as a RESERVATION (status PENDING, with an
 * expiry), inside a transaction that locks the organisation row. Without the
 * reservation two quotes read the same "remaining" and both pass, and the cap
 * is breached by concurrency rather than by anyone lying. The window counts
 * CONFIRMED rows and PENDING rows that have not expired; an abandoned quote
 * stops counting when it lapses.
 *
 * CONFIRMED only after the server has read the executed transaction from the
 * chain and matched it to the quote — the browser's word is never enough.
 */
export const stablecoinOutflows = pgTable('stablecoin_outflows', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  /** 'TRANSFER' | 'X402' */
  kind: text('kind').notNull(),
  supplierId: text('supplier_id').references(() => suppliers.id),
  /** Always 'mainnet': the stablecoin lane has no sandbox (migration 0021). */
  network: text('network').notNull(),
  coinType: text('coin_type').notNull(),
  principalMinor: bigint('principal_minor', { mode: 'bigint' }).notNull(),
  feeMinor: bigint('fee_minor', { mode: 'bigint' }).notNull(),
  senderAddress: text('sender_address').notNull(),
  recipientAddress: text('recipient_address').notNull(),
  feeAddress: text('fee_address'),
  /** 'PENDING' | 'CONFIRMED' | 'FAILED' | 'MISMATCH' | 'EXPIRED' */
  status: text('status').notNull().default('PENDING'),
  reservedUntil: timestamp('reserved_until', { withTimezone: true }).notNull(),
  txDigest: text('tx_digest').unique(),
  /** 'PENDING_MAINNET_PUBLISH' until Splash's contracts are on mainnet and the
   *  anchor is backfilled; 'NOT_REQUIRED' for sandbox rows. */
  anchorStatus: text('anchor_status').notNull(),
  auditAnchorId: text('audit_anchor_id'),
  /** sha256 of the canonical confirmed record (lib/payments/stablecoin-verify.ts). */
  auditHash: text('audit_hash'),
  /** For X402: the resource that was paid for. */
  resource: text('resource'),
  /** Who quoted it — maker-checker refuses them as the second approver. */
  requestedBy: text('requested_by').references(() => users.id),
  failureReason: text('failure_reason'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index('stablecoin_outflows_org_created_idx').on(table.orgId, table.createdAt),
]);


/**
 * The operating dials, PER ORG.
 *
 * These lived in one JSON file with no org id, and `PUT /api/settings` was
 * guarded by `requireCustomerRequest` alone — no role check. So any signed-in
 * user of any tenant could set `requireDualApproval` to false for everybody.
 * The maker-checker control, the per-transfer ceiling and the daily ceiling all
 * read that file. A control a payer can switch off is not a control.
 */
export const orgSettings = pgTable('org_settings', {
  orgId: text('org_id').primaryKey().references(() => organizations.id),
  /** Whole USD — policy dials a human types, not amounts that get multiplied. */
  perTransferLimitUsd: integer('per_transfer_limit_usd').notNull().default(50_000),
  dailyLimitUsd: integer('daily_limit_usd').notNull().default(250_000),
  approvalThresholdUsd: integer('approval_threshold_usd').notNull().default(10_000),
  autoAllocateTreasuryPct: integer('auto_allocate_treasury_pct').notNull().default(1),
  requireTotp: boolean('require_totp').notNull().default(true),
  requireDualApproval: boolean('require_dual_approval').notNull().default(true),
  blockHighRiskCorridors: boolean('block_high_risk_corridors').notNull().default(true),
  notifyOnSettlement: boolean('notify_on_settlement').notNull().default(true),
  /** 'code' — a one-time code typed back into Splash, so approving needs the
   *  phone AND a live authenticated session. 'reply' — APPROVE/REJECT in the
   *  chat, which authenticates a handset rather than a person. */
  approvalChannel: text('approval_channel').notNull().default('code'),
  whatsappEnabled: boolean('whatsapp_enabled').notNull().default(false),
  /** A limit that moved without a name attached is a limit nobody can ask about. */
  updatedBy: text('updated_by'),
  ...timestamps,
});

/**
 * An approver's WhatsApp number, bound to a user identity.
 *
 * A phone number is not an identity. WhatsApp authenticates a handset, and a
 * reply proves possession of a device rather than the intent of a person. So a
 * reply is accepted only when its number resolves to a row here, and the
 * approval is recorded against that USER — never against the number.
 */
/**
 * One approver, one proposal, one chance.
 *
 * A token is bound to one proposal AND one user, single-use and short-lived.
 * Per-approver rather than one code per proposal, because unanimous consent
 * means N distinct people must each act: a single shared code makes "three
 * approvers agreed" satisfiable by one person entering it three times, which
 * is exactly the control being claimed and exactly what it would not deliver.
 */
export const approvalTokens = pgTable('approval_tokens', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id').notNull().references(() => proposals.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull().references(() => organizations.id),
  /** Whose ballot this is. A token arriving from anyone else is refused. */
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** The digits typed back into Splash in `code` mode. Short enough to read off
   *  a phone, and single-use, which is what makes short safe. */
  code: text('code').notNull(),
  channel: text('channel').notNull().default('code'),
  sentTo: text('sent_to'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  /** An approval request is a claim about the world at a moment — this balance,
   *  this corridor, this beneficiary. A code that still works next week
   *  approves a payment nobody re-examined. */
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** APPROVE or REJECT. A rejection has no row in `approvals` and is the most
   *  important answer that can come back, so it is recorded here. */
  decision: text('decision'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex('approval_tokens_proposal_user_unique').on(table.proposalId, table.userId),
  index('approval_tokens_user_idx').on(table.userId, table.decidedAt),
  index('approval_tokens_code_idx').on(table.code),
]);

export const approverChannels = pgTable('approver_channels', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** E.164, normalised on write. */
  whatsappE164: text('whatsapp_e164'),
  /** Proven by a round trip before it may approve anything — an unverified
   *  number is a number somebody typed, and typos route approvals to strangers. */
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  uniqueIndex('approver_channels_user_org_unique').on(table.orgId, table.userId),
  /** One number, one person. Two approvers sharing a handset would make "two
   *  approvers agreed" mean one person pressed a button twice. */
  uniqueIndex('approver_channels_number_unique').on(table.whatsappE164),
]);

/**
 * Step-up codes (lib/server/step-up.ts): a 6-digit code WhatsApp'd to a
 * verified number, typed back into Splash by that person, bound by digest to
 * exactly what is being approved. Only an HMAC of the code is stored.
 */
export const stepUpCodes = pgTable('step_up_codes', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  /** 'WHATSAPP_PASSKEY' | 'CLICK' — the workspace's approval style at the time. */
  method: text('method').notNull(),
  /** Who approves: the person the code was sent to (WHATSAPP_PASSKEY), or the
   *  person who clicked (CLICK). */
  approverUserId: text('approver_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  requestedBy: text('requested_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose').notNull(),
  subjectId: text('subject_id').notNull(),
  /** sha256 of the canonical subject — what the approver was shown. */
  subjectDigest: text('subject_digest').notNull(),
  summary: text('summary').notNull(),
  /** HMAC of the code; null for CLICK approvals. */
  codeHash: text('code_hash'),
  sentTo: text('sent_to'),
  delivered: boolean('delivered').notNull().default(false),
  attempts: integer('attempts').notNull().default(0),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** WHATSAPP_PASSKEY: the right code was typed back. */
  codeVerifiedAt: timestamp('code_verified_at', { withTimezone: true }),
  /** WHATSAPP_PASSKEY: the passkey that then signed the approval. */
  passkeyCredentialId: text('passkey_credential_id').references(() => passkeyCredentials.id),
  /** The approval is given: code + passkey, or the click. */
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [index('step_up_codes_subject_idx').on(table.orgId, table.purpose, table.subjectId)]);

export const proposals = pgTable('proposals', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  idempotencyKey: text('idempotency_key').notNull(),
  kind: text('kind').notNull(),
  /** Text, not enum: the agent lifecycle (DRAFTED…ANCHORED/REVERSED) is the
   *  authority (lib/queue/proposal-state.ts); freeze to an enum post-W6. */
  status: text('status').notNull(),
  tier: text('tier').notNull(),
  corridor: text('corridor'),
  createdBy: text('created_by').notNull(),
  unsignedTxBytes: text('unsigned_tx_bytes'),
  explain: jsonb('explain').notNull(),
  simulation: jsonb('simulation'),
  settlement: jsonb('settlement'),
  requiredApprovers: bigint('required_approvers', { mode: 'number' }).notNull().default(1),
  /** Track A §1.4 — canon versioning: any mutation to a canon field bumps the
   *  version, recomputes approval_hash, and voids all prior approvals. */
  version: bigint('version', { mode: 'number' }).notNull().default(1),
  approvalHash: text('approval_hash'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** The payment this rebuilds into once approved. On the row, not in a
   *  process map: an approval that survives a restart must still be
   *  executable, and the thing approved and the thing executed must be one
   *  record rather than two that can drift. */
  executionPayload: jsonb('execution_payload'),
  /** The attempt, including a failure — so an approval that could not be
   *  carried out is visible rather than silent. Distinct from `settlement`,
   *  which holds the chain result. */
  executionState: text('execution_state'),
  executionError: text('execution_error'),
  executedAt: timestamp('executed_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  index('proposals_org_idx').on(table.orgId),
  index('proposals_status_idx').on(table.status),
  /** One proposal in flight per payment, not one proposal per payment ever
   *  (drizzle/0025). Finished — terminal, settled, or carried out — gives the
   *  key back. Mirrors `isProposalInFlight` in lib/queue/proposal-state.ts. */
  uniqueIndex('proposals_open_idempotency_unique')
    .on(table.orgId, table.idempotencyKey)
    .where(sql`${table.status} NOT IN ('ANCHORED', 'REJECTED', 'FAILED', 'EXPIRED', 'REVERSED', 'SETTLED') AND ${table.executionState} IS NULL`),
]);

export const approvals = pgTable('approvals', {
  id: text('id').primaryKey(),
  proposalId: text('proposal_id').notNull().references(() => proposals.id),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
  signatureRef: text('signature_ref'),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex('approvals_one_per_user').on(table.proposalId, table.userId),
]);

/**
 * An approval, spent (lib/server/approved-proposal.ts). The first money route
 * to act on a proposal's approved-proposal claim inserts the row — or the
 * approvers' replay does, when the route refused before reaching the claim.
 * The primary key is the control: a second insert conflicts, so one approval
 * carries out one payment, however many requests or processes race for it.
 *
 * No foreign key to `proposals`. The proposal store is in memory and its
 * write-through is best-effort, so the proposal row may not be there; the
 * spend must not depend on it.
 */
export const consumedApprovals = pgTable('consumed_approvals', {
  proposalId: text('proposal_id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  /** What spent it: the route that acted on the claim, 'execution' when the
   *  replay closed it, 'backfill' for approvals carried out before the table. */
  consumedBy: text('consumed_by').notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fundingEvents = pgTable('funding_events', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  sessionId: text('session_id').notNull(),
  provider: text('provider').notNull(),
  method: text('method').notNull(),
  status: text('status').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  providerReference: text('provider_reference'),
  kytStatus: text('kyt_status'),
  ...timestamps,
}, (table) => [
  index('funding_org_idx').on(table.orgId),
  uniqueIndex('funding_provider_ref_unique').on(table.provider, table.providerReference),
]);

/**
 * A payroll run: many recipients paid under one authorization, one settlement
 * digest, one replay key.
 *
 * The replay key is the reason this is a table and not a Map. It exists so a
 * dropped response leg plus a re-submit does not pay every recipient twice
 * out of the shared pool — and a Map-based guard forgot everything on
 * restart, which is exactly when an operator retries.
 */
export const batchRuns = pgTable('batch_runs', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  /** The on-chain BusinessAccount the run settles from. Recorded, not used
   *  for scoping — an account id falls back to a value shared across orgs. */
  accountId: text('account_id'),
  state: text('state').notNull(),
  rowCount: integer('row_count').notNull(),
  acceptedRows: integer('accepted_rows').notNull(),
  blockedRows: integer('blocked_rows').notNull(),
  totalAmountMinor: bigint('total_amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull().default('USD'),
  targetCurrency: text('target_currency'),
  idempotencyKey: text('idempotency_key').notNull(),
  digest: text('digest'),
  packageId: text('package_id'),
  /** Which proposal authorized this run, when it needed a second approver. */
  proposalId: text('proposal_id'),
  demo: boolean('demo').notNull().default(false),
  ...timestamps,
}, (table) => [
  /** The replay guard itself. A unique index rather than a read-then-write:
   *  two submissions of the same file arriving together would both find
   *  nothing and both insert. */
  uniqueIndex('batch_runs_idempotency_unique').on(table.orgId, table.idempotencyKey),
  index('batch_runs_org_created_idx').on(table.orgId, table.createdAt),
]);

export const payouts = pgTable('payouts', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  intentId: text('intent_id').references(() => paymentIntents.id),
  rail: text('rail').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  providerReference: text('provider_reference'),
  ...timestamps,
}, (table) => [index('payouts_intent_idx').on(table.intentId)]);

export const treasuryMoves = pgTable('treasury_moves', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  approvedBy: text('approved_by'),
  ...timestamps,
}, (table) => [index('treasury_org_idx').on(table.orgId)]);

export const complianceCases = pgTable('compliance_cases', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  subjectKind: text('subject_kind').notNull(),
  subjectId: text('subject_id').notNull(),
  status: text('status').notNull().default('OPEN'),
  reason: text('reason'),
  releasedBy: text('released_by'),
  releaseReason: text('release_reason'),
  ...timestamps,
}, (table) => [index('cases_subject_idx').on(table.subjectKind, table.subjectId)]);

export const screeningResults = pgTable('screening_results', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  subjectKind: text('subject_kind').notNull(),
  subjectId: text('subject_id').notNull(),
  provider: text('provider').notNull(),
  verdict: screeningVerdict('verdict').notNull(),
  riskScore: numeric('risk_score'),
  raw: jsonb('raw'),
  screenedAt: timestamp('screened_at', { withTimezone: true }).notNull(),
  ...timestamps,
}, (table) => [index('screening_subject_idx').on(table.subjectKind, table.subjectId)]);

export const auditAnchors = pgTable('audit_anchors', {
  id: text('id').primaryKey(),
  orgId: text('org_id').references(() => organizations.id),
  batchDate: text('batch_date').notNull(),
  walrusBlobId: text('walrus_blob_id'),
  auditHash: text('audit_hash'),
  suiDigest: text('sui_digest'),
  ...timestamps,
});

export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  payload: jsonb('payload').notNull(),
  status: webhookStatus('status').notNull().default('RECEIVED'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  ...timestamps,
}, (table) => [
  // Replay/dupe rejection: a provider event lands exactly once.
  uniqueIndex('webhook_event_unique').on(table.provider, table.eventId),
]);

/* ── Double-entry ledger ─────────────────────────────────────────────
   Every money movement writes a journal entry whose postings sum to
   zero per currency, in the SAME transaction as the state change. */

export const journalEntries = pgTable('journal_entries', {
  id: text('id').primaryKey(),
  orgId: text('org_id').references(() => organizations.id),
  kind: text('kind').notNull(),
  intentId: text('intent_id'),
  /** What this movement refers to — the sweep job, funding session, intent.
   *  `kind` says which. Without it these rode in `intent_id`, which means an
   *  intent and nothing else. */
  refId: text('ref_id'),
  /** Chain evidence for a ledger line, so reconciling the ledger against the
   *  chain is a join rather than parsing prose out of `description`. */
  suiTxDigest: text('sui_tx_digest'),
  description: text('description'),
  ...timestamps,
}, (table) => [index('journal_intent_idx').on(table.intentId)]);

export const ledgerPostings = pgTable('ledger_postings', {
  id: text('id').primaryKey(),
  journalId: text('journal_id').notNull().references(() => journalEntries.id),
  account: text('account').notNull(),
  currency: text('currency').notNull(),
  /** Signed minor units: debits positive, credits negative. */
  amountMinor: bigint('amount_minor', { mode: 'bigint' }).notNull(),
  ...timestamps,
}, (table) => [
  index('postings_journal_idx').on(table.journalId),
  index('postings_account_idx').on(table.account, table.currency),
  /** One account's movements newest-first: the ledger page and every balance
   *  check. Carries the ordering so the read is a scan, not a sort. */
  index('postings_account_created_idx').on(table.account, table.currency, table.createdAt),
]);

/**
 * A business's KYB review case.
 *
 * Held in a `globalThis` Map until now, seeded with two invented companies, and
 * read by routes that were authenticated but not scoped — any signed-in user
 * could fetch any company's case by id, or find one by passing a business name
 * in a query string. The row carries a registration number, the SHA-256 of
 * every uploaded document, the reviewer's notes and the rejection reason, so
 * that was a cross-tenant read of exactly the material KYB exists to protect.
 *
 * `orgId` is not nullable. A case with no owner cannot be filtered by owner,
 * and one such row would escape every scope in the system.
 */
export const kybCases = pgTable('kyb_cases', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  businessName: text('business_name').notNull(),
  registrationNumber: text('registration_number').notNull(),
  /** SUBMITTED | IN_REVIEW | NEEDS_INFORMATION | APPROVED | REJECTED.
   *  Text rather than an enum: this is the reviewer's workflow, distinct from
   *  the org lifecycle in lib/compliance/kyb-state.ts that gates money. */
  state: text('state').notNull().default('SUBMITTED'),
  riskTier: text('risk_tier').notNull().default('UNASSIGNED'),
  corridorAccess: text('corridor_access').notNull().default('LOCKED'),
  assignedTo: text('assigned_to'),
  sumsubApplicantId: text('sumsub_applicant_id'),
  /** Metadata only — name, type, size, hash, storage key. The files stay
   *  encrypted behind `storageKey`. */
  documents: jsonb('documents').notNull().default([]),
  reviewNotes: text('review_notes'),
  decisionReason: text('decision_reason'),
  auditTrail: jsonb('audit_trail').notNull().default([]),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('kyb_cases_org_idx').on(table.orgId),
  index('kyb_cases_updated_idx').on(table.updatedAt),
  /** One live case per registration number per org. Two rows for one company
   *  mean two review histories, and a decision recorded against whichever the
   *  reviewer happened to open. */
  uniqueIndex('kyb_cases_org_registration_unique').on(table.orgId, table.registrationNumber),
]);

/**
 * One organisation's treasury balances.
 *
 * Held in `new Map()` until now, so a restart set every balance to zero except
 * the demo org's, which was re-seeded. A deploy could tell a customer their
 * Smart Treasury was empty.
 *
 * Keyed by ORG and nothing narrower: keyed by account, tenants shared a
 * treasury — which is exactly the bug that made every dashboard show the same
 * balance.
 */
export const treasuryLedgers = pgTable('treasury_ledgers', {
  orgId: text('org_id').primaryKey().references(() => organizations.id),
  /** Micro-USD. Integers, never floats — see lib/server/json.ts for the wire
   *  boundary these cross. */
  availableMicro: bigint('available_micro', { mode: 'bigint' }).notNull().default(0n),
  treasuryPrincipalMicro: bigint('treasury_principal_micro', { mode: 'bigint' }).notNull().default(0n),
  /** MAY be negative. USDY accrues through price, so a falling redemption
   *  price is a real loss on the position — see migration 0017, which
   *  removed the floor 0016 wrongly put here. */
  treasuryYieldMicro: bigint('treasury_yield_micro', { mode: 'bigint' }).notNull().default(0n),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A promise that funds land back in Available on a stated date.
 *
 * These lived in a module-level array, and losing one loses an obligation: the
 * settlement cron reads this list, so a restart between request and settlement
 * dropped the withdrawal silently and the customer's money stayed in treasury
 * with nothing scheduled to release it.
 */
export const withdrawalNotices = pgTable('withdrawal_notices', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  amountMicro: bigint('amount_micro', { mode: 'bigint' }).notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  /** When the funds land back in Available (T+1..T+3). */
  availableAt: timestamp('available_at', { withTimezone: true }).notNull(),
  /** PENDING | SWAPPING | SETTLED | CANCELLED. */
  state: text('state').notNull().default('PENDING'),
}, (table) => [
  index('withdrawal_notices_org_idx').on(table.orgId),
  /** The settlement cron sweeps by due date and state, across every tenant. */
  index('withdrawal_notices_due_idx').on(table.state, table.availableAt),
]);

/**
 * The yield accrual baseline.
 *
 * Yield is a price DELTA, so accrual needs the previous observation. It was a
 * module-level `let`, so every deploy reset it to null — and a null baseline
 * correctly records nothing, which means a restart silently skipped a day of
 * yield for every customer. One row: there is one USDY price, not one per org.
 */
export const treasuryAccrualState = pgTable('treasury_accrual_state', {
  id: text('id').primaryKey(),
  lastAccruedPriceMicros: bigint('last_accrued_price_micros', { mode: 'bigint' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

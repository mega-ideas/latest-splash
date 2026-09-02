import {
  bigint,
  boolean,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
export const screeningVerdict = pgEnum('screening_verdict', ['CLEAR', 'REVIEW', 'BLOCK', 'ERROR']);
export const webhookStatus = pgEnum('webhook_status', ['RECEIVED', 'PROCESSED', 'FAILED', 'SKIPPED']);

export const organizations = pgTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
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
  /** Wallet spec §2.3 — the org's on-chain BusinessAccount object id. Null
   *  until the AdminCap-gated business_account::verify_business has run. */
  suiBusinessAccountId: text('sui_business_account_id'),
  ...timestamps,
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  name: text('name').notNull(),
  role: userRole('role').notNull().default('viewer'),
  ...timestamps,
}, (table) => [
  uniqueIndex('users_email_unique').on(table.email),
  index('users_org_idx').on(table.orgId),
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
  ...timestamps,
}, (table) => [index('suppliers_org_idx').on(table.orgId)]);

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
  ...timestamps,
}, (table) => [
  index('invoices_org_idx').on(table.orgId),
  index('invoices_supplier_idx').on(table.supplierId),
  uniqueIndex('invoices_pay_link_unique').on(table.payLinkSlug),
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
  ...timestamps,
}, (table) => [
  index('intents_org_idx').on(table.orgId),
  index('intents_supplier_idx').on(table.supplierId),
  index('intents_state_idx').on(table.state),
  uniqueIndex('intents_idempotency_unique').on(table.idempotencyKey),
]);

/** Lifecycle audit trail — one row per state transition (statusHistory). */
export const intentTransitions = pgTable('intent_transitions', {
  id: text('id').primaryKey(),
  intentId: text('intent_id').notNull().references(() => paymentIntents.id),
  fromState: text('from_state'),
  toState: text('to_state').notNull(),
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
  ...timestamps,
}, (table) => [
  index('proposals_org_idx').on(table.orgId),
  index('proposals_status_idx').on(table.status),
  uniqueIndex('proposals_idempotency_unique').on(table.orgId, table.idempotencyKey),
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
]);

/* ── D8 retention instrumentation ────────────────────────────────────────
   Product analytics events (activation funnel, NVR cohorts, five-lock
   adoption). Named `product_events` so it never collides with the money
   tables `funding_events` / `webhook_events`.

   Privacy contract (lib/server/events.ts is the only writer):
   - org_hash / actor_hash / subject_hash are sha256 of the ids — a raw
     orgId / userId / intent id never lands in this table.
   - props is a small, PII-free jsonb bag; keys that look like PII are
     stripped before the write.
   - amount_minor follows the repo money rule: BIGINT minor units + currency
     (USD_MICRO when the emitting code already holds micro-USD). */

export const productEvents = pgTable('product_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  orgHash: text('org_hash').notNull(),
  actorHash: text('actor_hash'),
  subjectHash: text('subject_hash'),
  corridor: text('corridor'),
  amountMinor: bigint('amount_minor', { mode: 'bigint' }),
  currency: text('currency'),
  props: jsonb('props').notNull().default({}),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (table) => [
  index('product_events_name_occurred_idx').on(table.name, table.occurredAt),
  index('product_events_org_occurred_idx').on(table.orgHash, table.occurredAt),
]);

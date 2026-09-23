import { suiScanTxUrl, suiVisionTxUrl } from '@/lib/explorer';
import { getContractConfig } from '@/lib/server/contract-config';
import { analyzeAndRemember } from '@/lib/server/memwal';
import type { StoredSettlementEvidence } from '@/lib/evidence/settlement';
import type {
  CctpSourceChain,
  FundingFeeTier,
  FundingSourceId,
  PaymentMethod,
  StablecoinAssetSymbol,
  StablecoinRail,
  UsdProviderId,
} from '@/lib/funding/registry';

export type RecipientTier = 'PAYOUT_ONLY' | 'SWEEP_ACCOUNT' | 'STORED_BALANCE';

export type TransferIntentState =
  | 'AUTHORIZED'
  | 'DEPOSIT_CONFIRMED'
  | 'EXCHANGING'
  | 'EXCHANGED'
  | 'QUEUED'
  | 'SETTLING'
  | 'SETTLED'
  | 'SWEEPING'
  | 'DISBURSED'
  | 'CREDITED'
  | 'FAILED'
  | 'REFUNDING'
  | 'REFUNDED';

export type TransferIntentRecord = {
  id: string;
  /** The org this transfer belongs to.
   *
   *  Absent until now, which is why one process-global map served every tenant
   *  with no scoping on read. Required, not optional: an optional owner is an
   *  owner somebody forgets to set. */
  orgId: string;
  state: TransferIntentState;
  recipientName: string;
  targetCurrency: string;
  targetAmount: string;
  sourceAmountUsd: string;
  quoteId: string | null;
  exchangeRate: string | null;
  sourceStablecoin: 'USDC' | 'USDT';
  stablecoinAmountMicro: number;
  daxProvider: 'LABUAN' | 'STRIPE' | 'AIRWALLEX';
  daxTier: string | null;
  pegChecked: boolean;
  fundingSessionId?: string;
  fundingSource?: FundingSourceId;
  fundingMethod: PaymentMethod;
  fundingProvider?: UsdProviderId;
  fundingAsset?: StablecoinAssetSymbol;
  fundingRail?: StablecoinRail;
  fundingSourceChain?: CctpSourceChain;
  fundingFeeTier: FundingFeeTier;
  fundingKytStatus?: string;
  fundingNormalizeVenue?: string;
  fundingEffectiveSlippageBps?: number;
  verificationReference: string | null;
  receiptObjectId: string | null;
  suiTxDigest: string | null;
  paymentIntentId?: string;
  intentCreateDigest?: string;
  walrusBlobId?: string;
  sealPolicyId?: string;
  auditHash?: string;
  auditAnchorId?: string;
  smartTreasuryId?: string;
  composedActions?: Array<{
    kind: 'paid' | 'allocated' | 'anchored';
    label: string;
    eventType: string;
    data: Record<string, unknown>;
  }>;
  failureReason: string | null;
  failedAtState: string | null;
  deliveryTier: RecipientTier;
  recipientId?: string;
  invoiceId?: string;
  sweepJobId?: string;
  demo?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BatchRecord = {
  id: string;
  /** The org this run belongs to. Required — `accountId` below is an
   *  on-chain object id that falls back to a value shared across orgs, so it
   *  cannot serve as the ownership boundary. */
  orgId: string;
  state: TransferIntentState;
  rowCount: number;
  acceptedRows: number;
  blockedRows: number;
  totalAmount: string;
  digest: string | null;
  packageId: string | null;
  explorer: { suiVisionTxUrl: string | null; suiScanTxUrl: string | null };
  demo?: boolean;
  /** The on-chain BusinessAccount this run settles from. Recorded, not the
   *  scoping key — see `orgId` above. */
  accountId?: string;
  /** The proposal that authorized this run, when it needed a second
   *  approver. */
  proposalId?: string;
  /** Replay key. A repeat authorization with the same key returns this record
   *  instead of paying every recipient a second time. */
  idempotencyKey?: string;
  createdAt: string;
};

export type RecipientRecord = {
  id: string;
  /** The org this beneficiary belongs to.
   *
   *  Absent until now, which is why `listRecipients()` returned every tenant's
   *  and `deleteRecipient(id)` deleted any of them. Required, not optional. */
  orgId: string;
  name: string;
  country: string;
  bank: string;
  swift: string;
  account: string;
  tier: RecipientTier;
  kybStatus: 'none' | 'lite' | 'full';
  orgEmail?: string;
  createdVia: 'manual' | 'invoice_link';
  sweepConfig?: {
    targetCurrency: string;
    /**
     * Sweep venue for this recipient. A free string, not a union of firm
     * names: the set is configured per deployment, and enumerating unsigned
     * venues in a shipped type states a roster Splash has not agreed.
     */
    partner: string;
    destinationBank: string;
    destinationAccount: string;
    sweepDelaySeconds: number;
  };
  kybInviteSent?: boolean;
  /**
   * The FATF R.16 beneficiary half.
   *
   * `suppliers` has had these columns since migration 0006 and nothing wrote
   * them: the product collected a name, an account number and a SWIFT code,
   * which is not enough for a partner who has to file a travel-rule record.
   *
   * Kept as its own object rather than flattened, because it is one thing —
   * what accompanies the payment — and because `travelRuleSnapshot` freezes
   * exactly this shape at authorization.
   */
  travelRule?: TravelRuleBeneficiary;
  demo?: boolean;
  createdAt: string;
};

/** Mirrors `BeneficiaryRecord` in lib/compliance/travel-rule.ts, which is the
 *  authority on what each corridor requires. */
export type TravelRuleBeneficiary = {
  beneficiaryType?: 'INDIVIDUAL' | 'BUSINESS';
  /** Named on the payment instruction, and used to confirm the routing
   *  identifier resolves to the same bank. */
  bankName?: string;
  legalName?: string;
  registrationNumber?: string;
  dateOfBirth?: string;
  nationalIdNumber?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressCity?: string;
  addressState?: string;
  addressPostalCode?: string;
  addressCountry?: string;
  bankIdScheme?: string;
  bankIdValue?: string;
  bankBranchCode?: string;
  bankCountry?: string;
  bankAccountNumber?: string;
  bankAccountName?: string;
};

export type InvoiceStatusV2 = 'draft' | 'sent' | 'viewed' | 'paid' | 'settled' | 'overdue';
export type InvoiceRecord = {
  id: string;
  /** The org this invoice belongs to.
   *
   *  Absent until now, which is why `listInvoices()` returned every tenant's
   *  and `updateInvoice(id, …)` could MODIFY any of them. Required. */
  orgId: string;
  issuerOrg: string;
  payerOrgName?: string;
  payerOrgEmail?: string;
  amountUsd: string;
  targetCurrency: string;
  dueDate: string;
  memo?: string;
  status: InvoiceStatusV2;
  payLinkSlug: string;
  paymentReference?: string;
  walrusBlobId?: string;
  sealPolicyId?: string;
  documentSha256?: string;
  transferIntentId?: string;
  demo?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type LedgerEntry = {
  id: string;
  accountId: string;
  direction: 'CREDIT' | 'DEBIT';
  /** Minor units as bigint, like the `ledger_postings` column this mirrors.
   *  A JS number is exact only below 2^53 — about nine billion dollars at six
   *  decimals — and the failure above it is silent rounding in a balance. */
  amountUsdcMicro: bigint;
  balanceAfterMicro: bigint;
  refType: 'TRANSFER' | 'SWEEP' | 'FEE' | 'FUNDING' | 'YIELD_SIM' | 'SEED';
  refId: string;
  suiTxDigest?: string;
  demo?: boolean;
  createdAt: string;
};

export type SweepJob = {
  id: string;
  transferIntentId: string;
  recipientId: string;
  partner: 'PDAX';
  amountUsdcMicro: number;
  targetCurrency: string;
  fxRate: string;
  state: 'PENDING' | 'EXECUTING' | 'COMPLETED' | 'FAILED';
  heldDurationMs?: number;
  partnerPayoutRef?: string;
  createdAt: string;
  completedAt?: string;
  demo?: boolean;
};

export type RateHold = {
  id: string;
  /** The org that took this hold. A rate lock is a commitment made to one
   *  customer; without an owner, `listRateHolds()` handed every tenant's
   *  corridor positions to anyone signed in.
   *
   *  The ORG, not the on-chain account id: that id falls back to a value
   *  shared by every org without a provisioned account, so scoping by it
   *  would have merged two tenants' holds back together. */
  orgId?: string;
  corridorCurrency: string;
  rate: string;
  feeBps: number;
  holdUntil: string;
  scheduledExecuteAt?: string;
  alertRule?: { direction: 'STRENGTHENS_PAST' | 'WEAKENS_PAST'; threshold: string };
  state: 'ACTIVE' | 'EXECUTED' | 'EXPIRED' | 'CANCELLED';
  transferIntentId?: string;
  demo?: boolean;
  createdAt: string;
};

export type AuditReceipt = {
  transferIntentId: string;
  invoiceId?: string;
  walrusBlobId?: string;
  sealPolicyId?: string;
  memwalRecordId?: string;
  extractionSnapshot?: unknown;
  approvedBy?: string;
  approvedAt?: string;
  suiTxDigest?: string;
  sweepJobId?: string;
  auditHash?: string;
  auditAnchorId?: string;
  auditAnchorDigest?: string;
  evidence?: StoredSettlementEvidence;
  paymentIntentId?: string;
  intentCreateDigest?: string;
  smartTreasuryId?: string;
  composedActions?: TransferIntentRecord['composedActions'];
  funding?: {
    sessionId?: string;
    source?: FundingSourceId;
    method: PaymentMethod;
    provider?: UsdProviderId;
    asset?: StablecoinAssetSymbol;
    rail?: StablecoinRail;
    sourceChain?: CctpSourceChain;
    feeTier: FundingFeeTier;
    kytStatus?: string;
    normalizeVenue?: string;
    effectiveSlippageBps?: number;
  };
  demo?: boolean;
  statusHistory: Array<{ state: string; at: string }>;
};

export type TransactionRecord = {
  id: string;
  kind: 'transfer' | 'batch';
  state: TransferIntentState;
  module: string;
  functionName: string;
  amount: string;
  digest: string | null;
  packageId: string | null;
  explorer: { suiVisionTxUrl: string | null; suiScanTxUrl: string | null };
  createdAt: string;
};

type OperationStore = {
  transfers: Map<string, TransferIntentRecord>;
  batches: Map<string, BatchRecord>;
  recipients: Map<string, RecipientRecord>;
  invoices: Map<string, InvoiceRecord>;
  ledgerEntries: Map<string, LedgerEntry>;
  sweepJobs: Map<string, SweepJob>;
  rateHolds: Map<string, RateHold>;
  auditReceipts: Map<string, AuditReceipt>;
  analytics: Map<string, number>;
  demoSeeded: boolean;
};

const globalStore = globalThis as typeof globalThis & { splashOperations?: OperationStore };

export const operations = globalStore.splashOperations ?? {
  transfers: new Map<string, TransferIntentRecord>(),
  batches: new Map<string, BatchRecord>(),
  recipients: new Map<string, RecipientRecord>(),
  invoices: new Map<string, InvoiceRecord>(),
  ledgerEntries: new Map<string, LedgerEntry>(),
  sweepJobs: new Map<string, SweepJob>(),
  rateHolds: new Map<string, RateHold>(),
  auditReceipts: new Map<string, AuditReceipt>(),
  analytics: new Map<string, number>(),
  demoSeeded: false,
};

globalStore.splashOperations = operations;

/** The org that owns seeded demo rows. Never a real tenant. */
export const DEMO_ORG_ID = 'demo-workspace';

export function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createPayLinkSlug() {
  return `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-5)}`;
}

function explorerLinks(digest: string | null) {
  return {
    suiVisionTxUrl: digest ? suiVisionTxUrl(digest) : null,
    suiScanTxUrl: digest ? suiScanTxUrl(digest) : null,
  };
}

export function createTransferIntent(input: {
  /** The org this transfer belongs to. Resolved from the SESSION by the caller,
   *  never from the request — see lib/server/session-account.ts. */
  orgId: string;
  recipientName: string;
  targetCurrency: string;
  targetAmount: string;
  sourceAmountUsd?: string;
  quoteId?: string | null;
  exchangeRate?: string | null;
  sourceStablecoin?: 'USDC' | 'USDT';
  stablecoinAmountMicro?: number;
  daxTier?: string | null;
  pegChecked?: boolean;
  deliveryTier?: RecipientTier;
  recipientId?: string;
  invoiceId?: string;
  fundingSessionId?: string;
  fundingSource?: FundingSourceId;
  fundingMethod?: PaymentMethod;
  fundingProvider?: UsdProviderId;
  fundingAsset?: StablecoinAssetSymbol;
  fundingRail?: StablecoinRail;
  fundingSourceChain?: CctpSourceChain;
  fundingFeeTier?: FundingFeeTier;
  fundingKytStatus?: string;
  fundingNormalizeVenue?: string;
  fundingEffectiveSlippageBps?: number;
  demo?: boolean;
}) {
  const now = new Date().toISOString();
  const record: TransferIntentRecord = {
    id: createId('ti'),
    orgId: input.orgId,
    state: 'AUTHORIZED',
    recipientName: input.recipientName,
    targetCurrency: input.targetCurrency,
    targetAmount: input.targetAmount,
    sourceAmountUsd: input.sourceAmountUsd ?? '0.00',
    quoteId: input.quoteId ?? null,
    exchangeRate: input.exchangeRate ?? null,
    sourceStablecoin: input.sourceStablecoin ?? 'USDC',
    stablecoinAmountMicro: input.stablecoinAmountMicro ?? 0,
    daxProvider: 'LABUAN',
    daxTier: input.daxTier ?? null,
    pegChecked: input.pegChecked ?? false,
    fundingSessionId: input.fundingSessionId,
    fundingSource: input.fundingSource ?? 'BANK_USD',
    fundingMethod: input.fundingMethod ?? 'BANK_USD',
    fundingProvider: input.fundingProvider,
    fundingAsset: input.fundingAsset,
    fundingRail: input.fundingRail,
    fundingSourceChain: input.fundingSourceChain,
    fundingFeeTier: input.fundingFeeTier ?? 'STANDARD',
    fundingKytStatus: input.fundingKytStatus,
    fundingNormalizeVenue: input.fundingNormalizeVenue,
    fundingEffectiveSlippageBps: input.fundingEffectiveSlippageBps,
    verificationReference: null,
    receiptObjectId: null,
    suiTxDigest: null,
    failureReason: null,
    failedAtState: null,
    deliveryTier: input.deliveryTier ?? 'PAYOUT_ONLY',
    recipientId: input.recipientId,
    invoiceId: input.invoiceId,
    demo: input.demo,
    createdAt: now,
    updatedAt: now,
  };
  // Builds the record; does NOT decide where it lives. The caller persists it
  // through lib/server/transfers-store.ts, which writes to Postgres when one is
  // configured and to this map only when there is not.
  operations.auditReceipts.set(record.id, {
    transferIntentId: record.id,
    invoiceId: input.invoiceId,
    demo: input.demo,
    funding: {
      sessionId: record.fundingSessionId,
      source: record.fundingSource,
      method: record.fundingMethod,
      provider: record.fundingProvider,
      asset: record.fundingAsset,
      rail: record.fundingRail,
      sourceChain: record.fundingSourceChain,
      feeTier: record.fundingFeeTier,
      kytStatus: record.fundingKytStatus,
      normalizeVenue: record.fundingNormalizeVenue,
      effectiveSlippageBps: record.fundingEffectiveSlippageBps,
    },
    statusHistory: [{ state: record.state, at: now }],
  });
  return record;
}

// `readTransferIntent`, `updateTransferIntent` and `listTransfers` used to live
// here, reading a process-global map by id with no org scoping at all. They are
// gone rather than deprecated: a scoped replacement beside an unscoped original
// is a choice somebody makes wrongly at 2am. Use `lib/server/transfers-store.ts`,
// where every read takes an orgId and cross-tenant reach is spelled `*ForStaff`.

/**
 * Build a payout-run record. Does NOT decide where it lives — the caller
 * claims it through `lib/server/batches-store.ts`, where the replay key is
 * enforced by a unique index rather than a lookup that a restart empties.
 */
export function buildBatch(input: {
  orgId: string;
  rowCount: number;
  acceptedRows: number;
  blockedRows: number;
  totalAmount: string;
  accountId?: string;
  idempotencyKey?: string;
}) {
  const record: BatchRecord = {
    id: createId('batch'),
    orgId: input.orgId,
    state: 'QUEUED',
    rowCount: input.rowCount,
    acceptedRows: input.acceptedRows,
    blockedRows: input.blockedRows,
    totalAmount: input.totalAmount,
    digest: null,
    packageId: null,
    explorer: explorerLinks(null),
    accountId: input.accountId,
    idempotencyKey: input.idempotencyKey,
    createdAt: new Date().toISOString(),
  };
  operations.batches.set(record.id, record);
  return record;
}

/**
 * Find a batch already created for this (account, idempotency key) pair.
 *
 * A batch pays every recipient out of the SHARED SettlementPool, so a replayed
 * authorization — a dropped response, a double-click, a proxy retry — pays
 * everyone twice. Returning the existing record makes the second call a no-op
 * rather than a second payroll run.
 */
// `readBatch`, `readBatchFor`, `updateBatch`, `listBatches` and
// `findBatchByIdempotencyKey` used to live here over a process-global map.
//
// `readBatch(id)` and `listBatches()` were unscoped — any tenant's payout run,
// row counts, totals and settlement digest, to anyone signed in. And the
// idempotency lookup, the guard that stops a re-submitted file paying every
// recipient twice, was a read of that same map: a restart between the two
// submissions emptied it, and restarts are exactly when an operator retries.
//
// They are gone rather than deprecated. Use `lib/server/batches-store.ts`,
// where every read takes an orgId, cross-tenant reach is spelled
// `listBatchesForStaff`, and the replay key is claimed by a unique index rather
// than consulted by a lookup.

/**
 * Build a beneficiary record. Does NOT decide where it lives — the caller
 * persists it through `lib/server/recipients-store.ts`.
 */
export function buildRecipient(input: {
  /** Resolved from the SESSION by the caller, never from the request. */
  orgId: string;
  travelRule?: TravelRuleBeneficiary;
  name: string;
  country: string;
  bank?: string;
  swift?: string;
  account?: string;
  tier?: RecipientTier;
  kybStatus?: RecipientRecord['kybStatus'];
  orgEmail?: string;
  createdVia?: RecipientRecord['createdVia'];
  sweepConfig?: RecipientRecord['sweepConfig'];
  kybInviteSent?: boolean;
  demo?: boolean;
}): RecipientRecord {
  const record: RecipientRecord = {
    id: createId('rcpt'),
    orgId: input.orgId,
    name: input.name,
    country: input.country,
    bank: input.bank ?? '',
    swift: input.swift ?? '',
    account: input.account ?? '',
    tier: input.tier ?? 'PAYOUT_ONLY',
    kybStatus: input.kybStatus ?? 'none',
    orgEmail: input.orgEmail,
    createdVia: input.createdVia ?? 'manual',
    sweepConfig: input.sweepConfig,
    kybInviteSent: input.kybInviteSent,
    travelRule: input.travelRule,
    demo: input.demo,
    createdAt: new Date().toISOString(),
  };
  return record;
}

// `listRecipients`, `findRecipient`, `deleteRecipient` and
// `upsertRecipientFromInvoice` used to live here, over a process-global map
// with no org id on the record. `listRecipients()` returned every tenant's
// beneficiaries — names, banks, SWIFT codes, account numbers — and
// `deleteRecipient(id)` deleted any of them by id alone.
//
// They are gone rather than deprecated. Use `lib/server/recipients-store.ts`,
// where every read takes an orgId, the delete is scoped, and cross-tenant reach
// is spelled `readRecipientForStaff`.

/**
 * Build an invoice record. Does NOT decide where it lives — the caller persists
 * it through `lib/server/invoices-store.ts`.
 */
export function buildInvoice(input: Omit<InvoiceRecord, 'id' | 'payLinkSlug' | 'createdAt' | 'updatedAt'> & { id?: string; payLinkSlug?: string }) {
  const now = new Date().toISOString();
  const record: InvoiceRecord = {
    ...input,
    id: input.id ?? createId('inv'),
    payLinkSlug: input.payLinkSlug ?? createPayLinkSlug(),
    createdAt: now,
    updatedAt: now,
  };
  return record;
}

// `listInvoices`, `readInvoice`, `findInvoiceBySlug` and `updateInvoice` used to
// live here over a process-global map with no org id on the record.
// `listInvoices()` returned every tenant's, `readInvoice(id)` read any of them,
// and `updateInvoice(id, patch)` MODIFIED any of them — a write across the
// tenant boundary, not merely a read.
//
// They are gone rather than deprecated. Use `lib/server/invoices-store.ts`,
// where every read takes an orgId, the patch is scoped, and the two deliberate
// exceptions — the pay-link slug and the audit view — are named for what they
// are.

export function createLedgerEntry(input: Omit<LedgerEntry, 'id' | 'balanceAfterMicro' | 'createdAt'>) {
  const balanceBefore = getLedgerBalance(input.accountId);
  const balanceAfterMicro = balanceBefore + (input.direction === 'CREDIT' ? input.amountUsdcMicro : -input.amountUsdcMicro);
  const entry: LedgerEntry = {
    ...input,
    id: createId('ledger'),
    balanceAfterMicro,
    createdAt: new Date().toISOString(),
  };
  operations.ledgerEntries.set(entry.id, entry);
  return entry;
}

/**
 * In-process ledger, for the no-database path in `lib/server/ledger-store.ts`
 * and the demo seed. Every deployed environment goes through `postJournal`.
 *
 * `accountId` is REQUIRED. It used to be optional, and omitting it returned
 * every account's entries — the enumeration primitive that turns a guessed
 * account id into a targeted debit, documented at `app/api/ledger/route.ts`.
 * Required means the unscoped call is a type error rather than a habit.
 */
export function listLedgerEntries(accountId: string) {
  return [...operations.ledgerEntries.values()]
    .filter((entry) => entry.accountId === accountId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getLedgerBalance(accountId: string): bigint {
  return listLedgerEntries(accountId).reduce(
    (balance, entry) => balance + (entry.direction === 'CREDIT' ? entry.amountUsdcMicro : -entry.amountUsdcMicro),
    0n,
  );
}

export function createSweepJob(input: Omit<SweepJob, 'id' | 'state' | 'createdAt'> & { state?: SweepJob['state'] }) {
  const job: SweepJob = {
    ...input,
    id: createId('sweep'),
    state: input.state ?? 'PENDING',
    createdAt: new Date().toISOString(),
  };
  operations.sweepJobs.set(job.id, job);
  return job;
}

export function updateSweepJob(jobId: string, patch: Partial<SweepJob>) {
  const job = operations.sweepJobs.get(jobId);
  if (!job) return null;
  Object.assign(job, patch);
  return job;
}

export function readSweepJob(jobId: string) {
  return operations.sweepJobs.get(jobId) ?? null;
}

export function listSweepJobs() {
  return [...operations.sweepJobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createRateHold(input: Omit<RateHold, 'id' | 'state' | 'createdAt' | 'holdUntil'> & { holdUntil?: string; state?: RateHold['state'] }) {
  const createdAt = new Date();
  const hours = Math.max(24, Math.min(72, Number(process.env.RATE_HOLD_HOURS ?? 48)));
  const hold: RateHold = {
    ...input,
    id: createId('hold'),
    state: input.state ?? 'ACTIVE',
    holdUntil: input.holdUntil ?? new Date(createdAt.getTime() + hours * 60 * 60 * 1000).toISOString(),
    createdAt: createdAt.toISOString(),
  };
  operations.rateHolds.set(hold.id, hold);
  return hold;
}

/** Expire what has run out, then return every hold. Staff console only —
 *  the customer-facing reads below are scoped. */
export function listRateHolds() {
  const now = Date.now();
  for (const hold of operations.rateHolds.values()) {
    if (hold.state === 'ACTIVE' && new Date(hold.holdUntil).getTime() <= now) hold.state = 'EXPIRED';
  }
  return [...operations.rateHolds.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * One org's rate holds.
 *
 * A hold is a commitment made to one customer, and a list of them reveals
 * that customer's corridor positions and timing. The unscoped list went to
 * anyone signed in.
 *
 * A hold with no `orgId` is a demo seed row and belongs to nobody, so it
 * matches no org rather than every one.
 */
export function listRateHoldsFor(orgId: string) {
  return listRateHolds().filter((hold) => hold.orgId === orgId);
}

export function readRateHoldFor(orgId: string, holdId: string) {
  listRateHolds();
  const hold = operations.rateHolds.get(holdId) ?? null;
  return hold && hold.orgId === orgId ? hold : null;
}

// `readAuditReceipt` and `updateAuditReceipt` are gone from here for the same
// reason the transfer reads are: they took an intent id and no owner, so an
// audit trail — which is as sensitive as the payment it describes — came back
// to anyone who could name one. `lib/server/transfers-store.ts` composes the
// receipt from the transfer's own row and its `intent_transitions`, scoped, and
// spells cross-tenant reach `readAuditReceiptForStaff`.
//
// `findAuditReceiptByHash` went with them, unmourned: it scanned every tenant's
// receipts for a hash and nothing had ever called it.

/** Demo seed only — the in-process map, never a real tenant's receipt. */
function updateAuditReceipt(intentId: string, patch: Partial<AuditReceipt>) {
  const receipt = operations.auditReceipts.get(intentId) ?? { transferIntentId: intentId, statusHistory: [] };
  Object.assign(receipt, patch);
  operations.auditReceipts.set(intentId, receipt);
  return receipt;
}

export function recordAnalyticsEvent(name: string) {
  const next = (operations.analytics.get(name) ?? 0) + 1;
  operations.analytics.set(name, next);
  console.info(`[analytics] ${name}`, { count: next });
  return next;
}

export function analyticsSummary() {
  return Object.fromEntries(operations.analytics.entries());
}

/** Staff-console aggregate across every tenant. Async because transfers now
 *  live in Postgres; cross-tenant on purpose, which is why it is only reachable
 *  from the admin console. */
export async function listTransactions(): Promise<TransactionRecord[]> {
  const { listTransfersForStaff } = await import('./transfers-store.ts');
  const fromTransfers: TransactionRecord[] = (await listTransfersForStaff()).map((transfer) => ({
    id: transfer.id,
    kind: 'transfer',
    state: transfer.state,
    module: 'settlement',
    functionName: 'settle_payment',
    amount: `$${transfer.sourceAmountUsd}`,
    digest: transfer.suiTxDigest,
    packageId: getContractConfig().packageId || null,
    explorer: explorerLinks(transfer.suiTxDigest),
    createdAt: transfer.createdAt,
  }));
  const { listBatchesForStaff } = await import('./batches-store.ts');
  const fromBatches: TransactionRecord[] = (await listBatchesForStaff()).map((batch) => ({
    id: batch.id,
    kind: 'batch',
    state: batch.state,
    module: 'settlement',
    functionName: 'settle_batch',
    amount: `$${batch.totalAmount}`,
    digest: batch.digest,
    packageId: batch.packageId,
    explorer: batch.explorer,
    createdAt: batch.createdAt,
  }));
  return [...fromTransfers, ...fromBatches].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function seedDemoData() {
  if (operations.demoSeeded || process.env.NEXT_PUBLIC_DEMO_MODE !== 'true') return;
  operations.demoSeeded = true;
  void analyzeAndRemember('Pays PH suppliers weekly');
  void analyzeAndRemember('Batches on Friday');
  void analyzeAndRemember('Prefers USD settlement');

  // Demo seed lives in this process only, owned by DEMO_ORG_ID so it can never
  // be read alongside a real tenant's beneficiaries.
  const seedRecipient = (input: Parameters<typeof buildRecipient>[0]) => {
    const record = buildRecipient(input);
    operations.recipients.set(record.id, record);
    return record;
  };

  const acme = seedRecipient({
    orgId: DEMO_ORG_ID,
    name: 'Acme PH',
    country: 'PH',
    bank: 'BDO',
    account: 'DEMO-ACME-PH',
    tier: 'SWEEP_ACCOUNT',
    kybStatus: 'lite',
    demo: true,
    sweepConfig: {
      targetCurrency: 'PHP',
      partner: 'PDAX',
      destinationBank: 'BDO',
      destinationAccount: 'DEMO-ACME-PH',
      sweepDelaySeconds: 4,
    },
  });
  seedRecipient({ orgId: DEMO_ORG_ID, name: 'Manila Textiles', country: 'PH', bank: 'BPI', account: 'DEMO-MANILA', tier: 'PAYOUT_ONLY', demo: true });
  const cebu = seedRecipient({ orgId: DEMO_ORG_ID, name: 'Cebu Components', country: 'PH', tier: 'STORED_BALANCE', demo: true });

  const due = new Date(Date.now() + 16 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const oldDue = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // Same as the beneficiaries above: built here, kept in this process, owned
  // by DEMO_ORG_ID so it can never be listed alongside a real tenant's.
  const seedInvoice = (input: Parameters<typeof buildInvoice>[0]) => {
    const record = buildInvoice(input);
    operations.invoices.set(record.id, record);
    return record;
  };

  const invoice = seedInvoice({
    orgId: DEMO_ORG_ID,
    id: 'inv_demo_acme_5000',
    payLinkSlug: 'acme-ph-5000',
    issuerOrg: 'Splash Workspace',
    payerOrgName: 'Acme Manufacturing PH',
    payerOrgEmail: 'finance@acme-ph.example',
    amountUsd: '5000.00',
    targetCurrency: 'PHP',
    dueDate: due,
    memo: 'Component supply invoice',
    status: 'settled',
    walrusBlobId: 'DEMO_WALRUS_acme_invoice',
    sealPolicyId: 'DEMO_SEAL_acme_auditor',
    documentSha256: 'demo'.padEnd(64, '0'),
    demo: true,
  });
  seedInvoice({ orgId: DEMO_ORG_ID, issuerOrg: 'Splash Workspace', payerOrgName: 'Acme Manufacturing PH', amountUsd: '3200.00', targetCurrency: 'PHP', dueDate: due, memo: 'Freight invoice', status: 'sent', demo: true });
  seedInvoice({ orgId: DEMO_ORG_ID, issuerOrg: 'Splash Workspace', payerOrgName: 'Manila Textiles', amountUsd: '1800.00', targetCurrency: 'PHP', dueDate: oldDue, memo: 'Overdue textile invoice', status: 'overdue', demo: true });

  const transfer = createTransferIntent({
    // The seeded demo data belongs to a named demo org, so it can never be
    // mistaken for — or read alongside — a real tenant's transfers.
    orgId: DEMO_ORG_ID,
    recipientName: acme.name,
    recipientId: acme.id,
    invoiceId: invoice.id,
    targetCurrency: 'PHP',
    targetAmount: '282500.00',
    sourceAmountUsd: '5000.00',
    stablecoinAmountMicro: 5_000_000_000,
    exchangeRate: '56.5',
    deliveryTier: 'SWEEP_ACCOUNT',
    pegChecked: true,
    demo: true,
  });
  // Demo seed data, in this process only — never persisted, and owned by
  // DEMO_ORG_ID so it can never be read alongside a real tenant's transfers.
  Object.assign(transfer, { state: 'SETTLED' });
  const job = createSweepJob({
    transferIntentId: transfer.id,
    recipientId: acme.id,
    partner: 'PDAX',
    amountUsdcMicro: 5_000_000_000,
    targetCurrency: 'PHP',
    fxRate: '56.5',
    state: 'COMPLETED',
    heldDurationMs: 4200,
    partnerPayoutRef: 'DEMO_PDAX_4200',
    completedAt: new Date().toISOString(),
    demo: true,
  });
  Object.assign(transfer, { state: 'DISBURSED', sweepJobId: job.id });
  operations.transfers.set(transfer.id, transfer);
  updateAuditReceipt(transfer.id, {
    invoiceId: invoice.id,
    walrusBlobId: invoice.walrusBlobId,
    sealPolicyId: invoice.sealPolicyId,
    approvedBy: 'demo-operator@splash.finance',
    approvedAt: new Date().toISOString(),
    suiTxDigest: transfer.suiTxDigest ?? undefined,
    sweepJobId: job.id,
    demo: true,
  });
  Object.assign(invoice, { transferIntentId: transfer.id });
  createLedgerEntry({ accountId: cebu.id, direction: 'CREDIT', amountUsdcMicro: 5_000_000_000n, refType: 'SEED', refId: 'demo_seed', demo: true });
  createRateHold({ corridorCurrency: 'PHP', rate: '56.5', feeBps: 80, demo: true });
}

// Sample rows exist so a fresh local instance has something to render. They
// are never seeded in production: a live workspace that arrives pre-populated
// with another company's invoices is both wrong and, because every row is
// flagged `demo: true`, covered in DEMO badges it should never have shown.
if (process.env.NODE_ENV !== 'production') {
  seedDemoData();
}

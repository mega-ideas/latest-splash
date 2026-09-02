import { getContractConfig } from '@/lib/server/contract-config';
import { analyzeAndRemember } from '@/lib/server/memwal';
import { explorerLinksFor } from '@/lib/network';
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
  state: TransferIntentState;
  rowCount: number;
  acceptedRows: number;
  blockedRows: number;
  totalAmount: string;
  digest: string | null;
  packageId: string | null;
  explorer: { suiVisionTxUrl: string | null; suiScanTxUrl: string | null };
  demo?: boolean;
  /** Owning account — batches are per-org and must not be readable across orgs. */
  accountId?: string;
  /** Replay key. A repeat authorization with the same key returns this record
   *  instead of paying every recipient a second time. */
  idempotencyKey?: string;
  createdAt: string;
};

export type RecipientRecord = {
  id: string;
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
    partner: 'PDAX' | 'HATA' | 'TOKOCRYPTO' | 'BITKUB';
    destinationBank: string;
    destinationAccount: string;
    sweepDelaySeconds: number;
  };
  kybInviteSent?: boolean;
  demo?: boolean;
  createdAt: string;
};

export type InvoiceStatusV2 = 'draft' | 'sent' | 'viewed' | 'paid' | 'settled' | 'overdue';
export type InvoiceRecord = {
  id: string;
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
  amountUsdcMicro: number;
  balanceAfterMicro: number;
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

export function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createPayLinkSlug() {
  return `${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-5)}`;
}

function explorerLinks(digest: string | null) {
  return explorerLinksFor(digest);
}

export function createTransferIntent(input: {
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
  operations.transfers.set(record.id, record);
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

export function readTransferIntent(intentId: string) {
  return operations.transfers.get(intentId) ?? null;
}

export function updateTransferIntent(intentId: string, patch: Partial<TransferIntentRecord>): void {
  const record = operations.transfers.get(intentId);
  if (!record) return;
  const stateChanged = patch.state && patch.state !== record.state;
  const now = new Date().toISOString();
  Object.assign(record, patch, { updatedAt: now });
  operations.transfers.set(intentId, record);
  const audit = operations.auditReceipts.get(intentId) ?? { transferIntentId: intentId, statusHistory: [] };
  if (stateChanged) audit.statusHistory.push({ state: patch.state as string, at: now });
  if (patch.suiTxDigest) audit.suiTxDigest = patch.suiTxDigest;
  if (patch.sweepJobId) audit.sweepJobId = patch.sweepJobId;
  operations.auditReceipts.set(intentId, audit);
}

export function listTransfers(): TransferIntentRecord[] {
  return [...operations.transfers.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createBatch(input: {
  rowCount: number;
  acceptedRows: number;
  blockedRows: number;
  totalAmount: string;
  accountId?: string;
  idempotencyKey?: string;
}) {
  const record: BatchRecord = {
    id: createId('batch'),
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
export function findBatchByIdempotencyKey(accountId: string, idempotencyKey: string): BatchRecord | null {
  if (!idempotencyKey) return null;
  for (const record of operations.batches.values()) {
    if (record.idempotencyKey === idempotencyKey && (record.accountId ?? '') === accountId) return record;
  }
  return null;
}

export function readBatch(batchId: string) {
  return operations.batches.get(batchId) ?? null;
}

export function updateBatch(batchId: string, patch: Partial<BatchRecord>): void {
  const record = operations.batches.get(batchId);
  if (!record) return;
  Object.assign(record, patch);
}

export function listBatches() {
  return [...operations.batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function createRecipient(input: {
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
    demo: input.demo,
    createdAt: new Date().toISOString(),
  };
  operations.recipients.set(record.id, record);
  return record;
}

export function upsertRecipientFromInvoice(input: { name: string; orgEmail?: string }) {
  const email = input.orgEmail?.trim().toLowerCase();
  const existing = listRecipients().find((recipient) =>
    email ? recipient.orgEmail?.toLowerCase() === email : recipient.name.toLowerCase() === input.name.toLowerCase(),
  );
  if (existing) return existing;
  return createRecipient({
    name: input.name,
    orgEmail: input.orgEmail,
    country: 'XX',
    tier: 'PAYOUT_ONLY',
    kybStatus: 'none',
    createdVia: 'invoice_link',
    kybInviteSent: true,
  });
}

export function listRecipients() {
  return [...operations.recipients.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findRecipient(recipientId: string) {
  return operations.recipients.get(recipientId) ?? null;
}

export function deleteRecipient(recipientId: string): void {
  operations.recipients.delete(recipientId);
}

export function createInvoice(input: Omit<InvoiceRecord, 'id' | 'payLinkSlug' | 'createdAt' | 'updatedAt'> & { id?: string; payLinkSlug?: string }) {
  const now = new Date().toISOString();
  const record: InvoiceRecord = {
    ...input,
    id: input.id ?? createId('inv'),
    payLinkSlug: input.payLinkSlug ?? createPayLinkSlug(),
    createdAt: now,
    updatedAt: now,
  };
  operations.invoices.set(record.id, record);
  return record;
}

export function listInvoices() {
  return [...operations.invoices.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readInvoice(invoiceId: string) {
  return operations.invoices.get(invoiceId) ?? null;
}

export function findInvoiceBySlug(slug: string) {
  return listInvoices().find((invoice) => invoice.payLinkSlug === slug) ?? null;
}

export function updateInvoice(invoiceId: string, patch: Partial<InvoiceRecord>) {
  const record = operations.invoices.get(invoiceId);
  if (!record) return null;
  Object.assign(record, patch, { updatedAt: new Date().toISOString() });
  return record;
}

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

export function listLedgerEntries(accountId?: string) {
  return [...operations.ledgerEntries.values()]
    .filter((entry) => !accountId || entry.accountId === accountId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getLedgerBalance(accountId: string) {
  return listLedgerEntries(accountId).reduce(
    (balance, entry) => balance + (entry.direction === 'CREDIT' ? entry.amountUsdcMicro : -entry.amountUsdcMicro),
    0,
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

export function listRateHolds() {
  const now = Date.now();
  for (const hold of operations.rateHolds.values()) {
    if (hold.state === 'ACTIVE' && new Date(hold.holdUntil).getTime() <= now) hold.state = 'EXPIRED';
  }
  return [...operations.rateHolds.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readRateHold(holdId: string) {
  listRateHolds();
  return operations.rateHolds.get(holdId) ?? null;
}

export function readAuditReceipt(intentId: string) {
  return operations.auditReceipts.get(intentId) ?? null;
}

export function updateAuditReceipt(intentId: string, patch: Partial<AuditReceipt>) {
  const receipt = operations.auditReceipts.get(intentId) ?? { transferIntentId: intentId, statusHistory: [] };
  Object.assign(receipt, patch);
  operations.auditReceipts.set(intentId, receipt);
  return receipt;
}

export function findAuditReceiptByHash(auditHash: string) {
  return [...operations.auditReceipts.values()].find((receipt) => receipt.auditHash === auditHash) ?? null;
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

export function listTransactions(): TransactionRecord[] {
  const fromTransfers: TransactionRecord[] = listTransfers().map((transfer) => ({
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
  const fromBatches: TransactionRecord[] = listBatches().map((batch) => ({
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

  const acme = createRecipient({
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
  createRecipient({ name: 'Manila Textiles', country: 'PH', bank: 'BPI', account: 'DEMO-MANILA', tier: 'PAYOUT_ONLY', demo: true });
  const cebu = createRecipient({ name: 'Cebu Components', country: 'PH', tier: 'STORED_BALANCE', demo: true });

  const due = new Date(Date.now() + 16 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const oldDue = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const invoice = createInvoice({
    id: 'inv_demo_acme_5000',
    payLinkSlug: 'acme-ph-5000',
    issuerOrg: 'Splash Demo Ltd',
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
  createInvoice({ issuerOrg: 'Splash Demo Ltd', payerOrgName: 'Acme Manufacturing PH', amountUsd: '3200.00', targetCurrency: 'PHP', dueDate: due, memo: 'Freight invoice', status: 'sent', demo: true });
  createInvoice({ issuerOrg: 'Splash Demo Ltd', payerOrgName: 'Manila Textiles', amountUsd: '1800.00', targetCurrency: 'PHP', dueDate: oldDue, memo: 'Overdue textile invoice', status: 'overdue', demo: true });

  const transfer = createTransferIntent({
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
  updateTransferIntent(transfer.id, { state: 'SETTLED' });
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
  updateTransferIntent(transfer.id, { state: 'DISBURSED', sweepJobId: job.id });
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
  updateInvoice(invoice.id, { transferIntentId: transfer.id });
  createLedgerEntry({ accountId: cebu.id, direction: 'CREDIT', amountUsdcMicro: 5_000_000_000, refType: 'SEED', refId: 'demo_seed', demo: true });
  createRateHold({ corridorCurrency: 'PHP', rate: '56.5', feeBps: 80, demo: true });
}

seedDemoData();

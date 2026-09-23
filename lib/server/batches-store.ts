/**
 * The one way to read or write a payout run.
 *
 * Same two-backend shape as the transfer, ledger, beneficiary and invoice
 * stores: Postgres when `DATABASE_URL` is configured, the in-process map only
 * when it is not.
 *
 * Every read takes an `orgId`. Cross-tenant reach is spelled `*ForStaff`.
 */
import { suiScanTxUrl, suiVisionTxUrl } from '../explorer.ts';
import { operations, type BatchRecord } from './operations.ts';
import * as repo from './repository/batches.ts';

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[batches] DATABASE_URL is not set, so payout runs live in this process ' +
        'and disappear when it restarts — taking the replay guard with them. ' +
        'Local development only.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

function explorerFor(digest: string | null, demo?: boolean) {
  // A simulated run's SIM_ digest has no on-chain transaction, so linking to an
  // explorer would send an operator to a 404 that looks like a lost payment.
  if (!digest || demo) return { suiVisionTxUrl: null, suiScanTxUrl: null };
  return { suiVisionTxUrl: suiVisionTxUrl(digest), suiScanTxUrl: suiScanTxUrl(digest) };
}

function toRecord(row: repo.BatchRunRow): BatchRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    state: row.state as BatchRecord['state'],
    rowCount: row.rowCount,
    acceptedRows: row.acceptedRows,
    blockedRows: row.blockedRows,
    totalAmount: row.totalAmount,
    digest: row.digest,
    packageId: row.packageId,
    explorer: explorerFor(row.digest, row.demo),
    accountId: row.accountId,
    idempotencyKey: row.idempotencyKey,
    proposalId: row.proposalId,
    demo: row.demo,
    createdAt: row.createdAt,
  };
}

/**
 * Claim this run's replay key, or hand back the run that already holds it.
 *
 * `{ claimed: false }` means this exact file was already submitted by this org.
 * The caller returns that run instead of paying every recipient again.
 */
export async function claimBatch(
  record: BatchRecord,
  targetCurrency?: string,
): Promise<{ claimed: boolean; batch: BatchRecord }> {
  if (!usingPostgres()) {
    const existing = [...operations.batches.values()].find(
      (b) => b.orgId === record.orgId && b.idempotencyKey === record.idempotencyKey,
    );
    if (existing) return { claimed: false, batch: existing };
    operations.batches.set(record.id, record);
    return { claimed: true, batch: record };
  }
  const result = await repo.claimBatchRun(await db(), {
    id: record.id,
    orgId: record.orgId,
    accountId: record.accountId,
    state: record.state,
    rowCount: record.rowCount,
    acceptedRows: record.acceptedRows,
    blockedRows: record.blockedRows,
    totalAmount: record.totalAmount,
    targetCurrency,
    idempotencyKey: record.idempotencyKey ?? record.id,
    proposalId: record.proposalId,
    demo: record.demo,
  });
  return { claimed: result.claimed, batch: toRecord(result.run) };
}

/** One run belonging to `orgId`. A foreign id reads as missing. */
export async function readBatch(orgId: string, batchId: string): Promise<BatchRecord | null> {
  if (!usingPostgres()) {
    const record = operations.batches.get(batchId) ?? null;
    return record && record.orgId === orgId ? record : null;
  }
  const row = await repo.getBatchRun(await db(), orgId, batchId);
  return row ? toRecord(row) : null;
}

/** Cross-tenant. The settlement callback, holding a run it just created. */
export async function readBatchForStaff(batchId: string): Promise<BatchRecord | null> {
  if (!usingPostgres()) return operations.batches.get(batchId) ?? null;
  const row = await repo.getBatchRunForStaff(await db(), batchId);
  return row ? toRecord(row) : null;
}

export async function listBatchesFor(orgId: string, limit = 100): Promise<BatchRecord[]> {
  if (!usingPostgres()) {
    return [...operations.batches.values()]
      .filter((b) => b.orgId === orgId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const rows = await repo.listBatchRuns(await db(), orgId, limit);
  return rows.map(toRecord);
}

/** Every tenant's runs, for the staff console. */
export async function listBatchesForStaff(limit = 200): Promise<BatchRecord[]> {
  if (!usingPostgres()) {
    return [...operations.batches.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const rows = await repo.listAllBatchRuns(await db(), limit);
  return rows.map(toRecord);
}

export async function patchBatch(batchId: string, patch: Partial<BatchRecord>): Promise<void> {
  if (!usingPostgres()) {
    const record = operations.batches.get(batchId);
    if (!record) return;
    Object.assign(record, patch);
    operations.batches.set(batchId, record);
    return;
  }
  await repo.patchBatchRun(await db(), batchId, {
    state: patch.state,
    digest: patch.digest,
    packageId: patch.packageId,
    proposalId: patch.proposalId,
    demo: patch.demo,
  });
}

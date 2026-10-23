import { createHash } from 'node:crypto';

import { listTransfersForStaff } from '@/lib/server/transfers-store';
import { sealAdapter } from '@/lib/server/seal';
import { anchorAuditHashOnSui } from '@/lib/server/sui-settlement';
import { retrieveBlob, storeEncryptedInvoice } from '@/lib/server/walrus';
import { suiClient } from '@/lib/sui';

export type MerkleProofStep = {
  side: 'left' | 'right';
  hash: string;
};

export type AuditBatchLeaf = {
  transferId: string;
  leafHash: string;
  proof: MerkleProofStep[];
};

export type DailyAuditBatch = {
  id: string;
  date: string;
  merkleRoot: string;
  settlementCount: number;
  leaves: AuditBatchLeaf[];
  walrusBlobId: string;
  walrusMode: 'demo' | 'live';
  sealPolicyId: string;
  sealMode: 'demo' | 'live';
  ciphertextHash: string;
  anchorObjectId: string | null;
  anchorDigest: string;
  createdAt: string;
};

const globalAuditBatches = globalThis as typeof globalThis & {
  splashAuditBatches?: Map<string, DailyAuditBatch>;
};
/**
 * The in-process fallback, keyed by business date, used only when
 * `DATABASE_URL` is not set so that `npm run dev` works without a database.
 * Every deployed environment reads and writes `daily_audit_batches`
 * (migration 0031). This map was the only store until WS8: the batch existed
 * only on the instance the cron hit, and a cold start forgot a root that was
 * already on chain, so the next run anchored the same day again.
 */
const batches = globalAuditBatches.splashAuditBatches ?? new Map<string, DailyAuditBatch>();
globalAuditBatches.splashAuditBatches = batches;

let announced = false;

function usingPostgres(): boolean {
  if (process.env.DATABASE_URL) return true;
  if (!announced) {
    announced = true;
    console.warn(
      '[audit-batches] DATABASE_URL is not set, so daily audit batches live in this ' +
        'process and disappear when it restarts. Local development only.',
    );
  }
  return false;
}

async function db() {
  const { getDb } = await import('../db/client.ts');
  return getDb() as never;
}

async function repo() {
  return import('./repository/audit-batches.ts');
}

/** The batch already recorded for a business date, from any instance. */
async function recordedBatch(date: string): Promise<DailyAuditBatch | null> {
  if (usingPostgres()) return (await repo()).readBatchByDate(await db(), date);
  return batches.get(date) ?? null;
}

/**
 * Record the day's batch and return the one that was kept. With Postgres the
 * unique business date decides, so two cron runs for one day — two instances,
 * or a retry — agree on a single batch.
 */
async function recordBatch(batch: DailyAuditBatch): Promise<DailyAuditBatch> {
  if (usingPostgres()) return (await repo()).recordDailyAuditBatch(await db(), batch);
  const existing = batches.get(batch.date);
  if (existing) return existing;
  batches.set(batch.date, batch);
  return batch;
}

function businessDate(isoDate = new Date().toISOString()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.SPLASH_BUSINESS_TIMEZONE ?? 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoDate));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function parentHash(left: string, right: string) {
  return hash(`${left}${right}`);
}

function buildMerkleTree(leaves: string[]) {
  if (leaves.length === 0) throw new Error('Cannot build a daily audit batch without settlements.');
  const levels: string[][] = [leaves];
  while (levels.at(-1)!.length > 1) {
    const current = levels.at(-1)!;
    const next: string[] = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(parentHash(current[index], current[index + 1] ?? current[index]));
    }
    levels.push(next);
  }
  return levels;
}

function proofForIndex(levels: string[][], leafIndex: number): MerkleProofStep[] {
  const proof: MerkleProofStep[] = [];
  let index = leafIndex;
  for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
    const level = levels[levelIndex];
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    proof.push({
      side: isRight ? 'left' : 'right',
      hash: level[siblingIndex] ?? level[index],
    });
    index = Math.floor(index / 2);
  }
  return proof;
}

export function verifyMerkleProof(leafHash: string, proof: MerkleProofStep[], root: string) {
  const calculated = proof.reduce(
    (current, step) => step.side === 'left' ? parentHash(step.hash, current) : parentHash(current, step.hash),
    leafHash,
  );
  return calculated === root;
}

export async function buildDailyAuditBatch(date = businessDate()): Promise<DailyAuditBatch> {
  // Already built, on this instance or any other: return it rather than seal,
  // store and anchor the same day a second time.
  const existing = await recordedBatch(date);
  if (existing) return existing;

  // A system job anchoring the day across every tenant — the one place a
  // cross-tenant read is the intent rather than an oversight.
  const settlements = (await listTransfersForStaff(1000)).filter((transfer) =>
    !transfer.demo &&
    businessDate(transfer.createdAt) === date &&
    ['SETTLED', 'DISBURSED', 'CREDITED'].includes(transfer.state) &&
    Boolean(transfer.suiTxDigest && transfer.auditHash),
  );
  if (settlements.length === 0) {
    throw new Error(`No real completed settlements with audit proofs found for ${date}.`);
  }

  const leafHashes = settlements.map((transfer) => hash(JSON.stringify({
    transferId: transfer.id,
    suiTxDigest: transfer.suiTxDigest,
    auditHash: transfer.auditHash,
  })));
  const levels = buildMerkleTree(leafHashes);
  const merkleRoot = levels.at(-1)![0];
  const leaves = settlements.map((transfer, index) => ({
    transferId: transfer.id,
    leafHash: leafHashes[index],
    proof: proofForIndex(levels, index),
  }));

  const payload = JSON.stringify({
    schema: 'splash.daily-audit-batch.v1',
    date,
    merkleRoot,
    settlements: settlements.map((transfer, index) => ({
      transferId: transfer.id,
      suiTxDigest: transfer.suiTxDigest,
      auditHash: transfer.auditHash,
      leafHash: leafHashes[index],
    })),
  });
  const { ciphertext, policy } = await sealAdapter.encrypt(payload, ['splash-operator', 'auditor']);
  const blob = await storeEncryptedInvoice(ciphertext);
  const ciphertextHash = hash(ciphertext);
  const anchor = await anchorAuditHashOnSui({
    auditHash: ciphertextHash,
    anchorId: `daily-audit:${date}:${merkleRoot}`,
    backingBlobId: blob.blobId,
  });

  const batch: DailyAuditBatch = {
    id: `daily-audit:${date}`,
    date,
    merkleRoot,
    settlementCount: settlements.length,
    leaves,
    walrusBlobId: blob.blobId,
    walrusMode: blob.mode,
    sealPolicyId: policy.policyId,
    sealMode: policy.mode,
    ciphertextHash,
    anchorObjectId: anchor.anchorObjectId,
    anchorDigest: anchor.digest,
    createdAt: new Date().toISOString(),
  };
  // Two runs that both passed the check above both reach here. The database
  // keeps the first and both return it, so the day has one recorded root; the
  // later run's Walrus blob and anchor are left unreferenced. Holding a lock
  // across the Seal, Walrus and Sui calls would trade that for a connection
  // held for up to a minute, and the cron runs once a day.
  return recordBatch(batch);
}

/*
 * Staff-only, roots and contents (Sky's decision, WS2). A daily batch spans
 * every tenant: its leaves are other workspaces' transfer ids and the proofs
 * that place them, so even the Merkle root and the count say how much the
 * platform settled that day. The readers say so in their names, and the two
 * routes in front of them require a staff session (`getAdminSession`).
 */

export async function listDailyAuditBatchesForStaff(): Promise<DailyAuditBatch[]> {
  if (usingPostgres()) return (await repo()).listBatches(await db());
  return [...batches.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export async function readDailyAuditBatchForStaff(batchId: string): Promise<DailyAuditBatch | null> {
  if (usingPostgres()) return (await repo()).readBatchById(await db(), batchId);
  return [...batches.values()].find((batch) => batch.id === batchId) ?? null;
}

export async function verifyDailyAuditBatchForStaff(batchId: string, transferId: string) {
  const batch = await readDailyAuditBatchForStaff(batchId);
  if (!batch) throw new Error('Daily audit batch not found.');
  const leaf = batch.leaves.find((entry) => entry.transferId === transferId);
  if (!leaf) throw new Error('Transfer is not included in this daily audit batch.');

  const blob = await retrieveBlob(batch.walrusBlobId);
  if (!blob) throw new Error('Walrus batch blob could not be retrieved.');
  const ciphertextHash = hash(blob.encryptedData);
  const inclusionVerified = verifyMerkleProof(leaf.leafHash, leaf.proof, batch.merkleRoot);

  let anchorVerified = false;
  if (batch.anchorObjectId) {
    const { object } = await suiClient.getObject({
      objectId: batch.anchorObjectId,
      include: { json: true },
    });
    const content = JSON.stringify(object.json ?? {});
    anchorVerified = content.includes(batch.ciphertextHash) && content.includes(batch.walrusBlobId);
  }

  return {
    batchId,
    transferId,
    inclusionVerified,
    walrusHashVerified: ciphertextHash === batch.ciphertextHash,
    anchorVerified,
    verified: inclusionVerified && ciphertextHash === batch.ciphertextHash && anchorVerified,
  };
}

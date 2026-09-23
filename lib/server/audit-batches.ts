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
const batches = globalAuditBatches.splashAuditBatches ?? new Map<string, DailyAuditBatch>();
globalAuditBatches.splashAuditBatches = batches;

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

export async function buildDailyAuditBatch(date = businessDate()) {
  const existing = batches.get(date);
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
  batches.set(date, batch);
  return batch;
}

export function listDailyAuditBatches() {
  return [...batches.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export function readDailyAuditBatch(batchId: string) {
  return [...batches.values()].find((batch) => batch.id === batchId) ?? null;
}

export async function verifyDailyAuditBatch(batchId: string, transferId: string) {
  const batch = readDailyAuditBatch(batchId);
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

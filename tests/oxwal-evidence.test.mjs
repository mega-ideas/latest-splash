import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('settlement evidence module defines encrypted Walrus-backed evidence bundles', async () => {
  const evidence = await source('lib/evidence/settlement.ts');

  assert.match(evidence, /splash\.settlement-evidence\.v2/);
  assert.match(evidence, /sealAndStoreSettlementEvidence/);
  assert.match(evidence, /sealAdapter\.encrypt/);
  assert.match(evidence, /storeEncryptedInvoice/);
  assert.match(evidence, /ciphertextHash: sha256\(ciphertext\)/);
});

test('composed payment anchors the stored evidence hash and Walrus blob', async () => {
  const composedPayment = await source('lib/server/composed-payment.ts');

  assert.match(composedPayment, /createTransferSettlementEvidence/);
  assert.match(composedPayment, /sealAndStoreSettlementEvidence/);
  assert.match(composedPayment, /shouldUseMockSeal/);
  assert.match(composedPayment, /if \(!shouldUseMockSeal\(\)\) await assertSealWritable\(\)/);
  assert.match(composedPayment, /const auditHash = evidence\.record\.ciphertextHash/);
  assert.match(composedPayment, /backingBlobId: evidence\.walrus\.blobId/);
  assert.match(composedPayment, /evidence: evidence\.record/);
});

test('Seal demo crypto is unavailable in production transfer runtime', async () => {
  const seal = await source('lib/server/seal.ts');
  const runtimeMode = await source('lib/server/runtime-mode.ts');

  assert.match(seal, /canUseDemoCrypto/);
  assert.match(runtimeMode, /env\.NODE_ENV === 'production'/);
  // Behavioural, not source-text: what matters is that a production deployment
  // which has NOT declared a demo posture never reaches for stand-in crypto.
  // That still holds, and is asserted here rather than by matching source.
  const { canUseDemoCrypto } = await import('../lib/server/runtime-mode.ts');
  assert.equal(canUseDemoCrypto({ NODE_ENV: 'production' }), false);

  // A deployment that HAS declared one gets stand-in crypto, matching how the
  // vendor keys are already optional under the same flags.
  assert.equal(canUseDemoCrypto({ NODE_ENV: 'production', USE_MOCK_APIS: 'true' }), true);
  assert.equal(canUseDemoCrypto({ NODE_ENV: 'production', NEXT_PUBLIC_DEMO_MODE: 'true' }), true);
});

test('audit receipt persists evidence and audit route verifies it', async () => {
  const operations = await source('lib/server/operations.ts');
  const authorizeRoute = await source('app/api/transfers/authorize/route.ts');
  const auditRoute = await source('app/api/audit/[intentId]/route.ts');

  assert.match(operations, /evidence\?: StoredSettlementEvidence/);
  assert.match(authorizeRoute, /evidence: result\.evidence/);
  assert.match(auditRoute, /verifyStoredSettlementEvidence/);
  assert.match(auditRoute, /proof: await settlementProof/);
});

test('receipt exposes a collapsed independent settlement proof drawer', async () => {
  const drawer = await source('components/SettlementProofDrawer.tsx');
  const receiptStep = await source('components/transfer/StepReceipt.tsx');

  assert.match(drawer, /View independent settlement proof/);
  assert.match(drawer, /\/api\/audit\/\$\{transferIntentId\}/);
  assert.match(drawer, /Walrus blob/);
  assert.match(drawer, /Seal policy/);
  assert.match(drawer, /Hash match/);
  assert.match(receiptStep, /<SettlementProofDrawer/);
});

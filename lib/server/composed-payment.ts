import {
  DOMAIN_TAGS,
  newSalt,
  paymentCommitment,
  toHex,
  type PaymentCommitmentPayload,
} from '@/lib/evidence/commitment';
import {
  createTransferSettlementEvidence,
  sealAndStoreSettlementEvidence,
} from '@/lib/evidence/settlement';
import { shouldUseMockSeal } from '@/lib/server/seal';
import { assertSealWritable } from '@/lib/server/seal-health';
import {
  confirmComposedPaymentOnSui,
  createPaymentIntentOnSui,
  getOperatorKeypair,
  settlementCoinType,
} from '@/lib/server/sui-settlement';
import type { AuditReceipt } from '@/lib/server/operations';

function scaleFxRate(rate: string | number | null | undefined) {
  const parsed = Number(rate);
  return Math.max(1, Math.round((Number.isFinite(parsed) ? parsed : 1) * 1_000_000));
}

function treasuryAllocation(paymentMist: number) {
  const bps = Math.max(
    0,
    Math.min(10_000, Number.parseInt(process.env.COMPOSED_TREASURY_ALLOCATION_BPS ?? '100', 10) || 0),
  );
  return Math.floor(paymentMist * bps / 10_000);
}

export async function executeComposedPayment(input: {
  transferId: string;
  recipientAddress: string;
  recipientLabel: string;
  amountMist: number;
  targetCurrency: string;
  fxRate: string | number | null | undefined;
  funding?: AuditReceipt['funding'];
}) {
  // Fail before creating an on-chain intent if the audit encryption boundary
  // cannot accept the receipt payload.
  if (!shouldUseMockSeal()) await assertSealWritable();
  const paymentMist = Math.max(1, Math.floor(input.amountMist));
  const fxRateScaled = scaleFxRate(input.fxRate);

  // WS5. The salt is drawn here, once per payment, and travels only into the
  // Seal bundle below. The chain gets the 32-byte commitment and nothing else
  // about this payment; a party on the Seal allowlist recomputes it from the
  // bundle with scripts/verify-commitment.mjs. Nothing here logs the salt.
  const operator = getOperatorKeypair();
  if (!operator) {
    throw new Error('OPERATOR_SUI_PRIVATE_KEY is required: the commitment binds the operator address that opens the intent.');
  }
  const salt = newSalt();
  const payload: PaymentCommitmentPayload = {
    sender: operator.toSuiAddress(),
    recipient: input.recipientAddress,
    beneficiaryRef: '',
    amount: paymentMist,
    currency: settlementCoinType(),
    corridor: '',
    targetCurrency: input.targetCurrency.toUpperCase(),
    fxRateUsdLocal: fxRateScaled,
  };
  const commitment = paymentCommitment(payload, salt);

  const intent = await createPaymentIntentOnSui({
    recipient: input.recipientAddress,
    amountMist: paymentMist,
    targetCurrency: input.targetCurrency,
    fxRateScaled,
    commitment,
  });

  const createdAt = new Date().toISOString();
  const expectedAnchorId = `transfer:${input.transferId}`;
  const evidenceBundle = createTransferSettlementEvidence({
    transferId: input.transferId,
    recipient: input.recipientLabel,
    targetCurrency: input.targetCurrency,
    paymentMist,
    paymentIntentId: intent.intentId,
    intentCreateDigest: intent.digest,
    expectedAnchorId,
    commitment: {
      tag: DOMAIN_TAGS.payment,
      commitmentHex: toHex(commitment),
      saltHex: toHex(salt),
      payload,
    },
    funding: input.funding,
    createdAt,
  });
  const evidence = await sealAndStoreSettlementEvidence(evidenceBundle, [
    'dashboard-operator',
    input.recipientLabel,
    'auditor',
  ]);
  const auditHash = evidence.record.ciphertextHash;
  const composed = await confirmComposedPaymentOnSui({
    intentId: intent.intentId,
    intentCreateDigest: intent.digest,
    paymentMist,
    treasuryAmountMist: treasuryAllocation(paymentMist),
    auditHash,
    anchorId: expectedAnchorId,
    backingBlobId: evidence.walrus.blobId,
  });

  return {
    ...composed,
    auditHash,
    walrus: evidence.walrus,
    sealPolicy: evidence.policy,
    evidence: evidence.record,
  };
}

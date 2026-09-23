import { createSweepJob, updateSweepJob } from '@/lib/server/operations';
import { readRecipientForStaff } from '@/lib/server/recipients-store';
import { recordMovement } from '@/lib/server/ledger-store';
import { patchTransfer, readTransferForStaff } from '@/lib/server/transfers-store';
import { pdaxAdapter } from '@/lib/server/pdax';

export async function completeDeliveryForTransfer(intentId: string) {
  const intent = await readTransferForStaff(intentId);
  if (!intent) throw new Error('Transfer intent not found');
  const accountId = intent.recipientId ?? intent.recipientName;

  if (intent.deliveryTier === 'PAYOUT_ONLY') {
    await patchTransfer(intent.id, { state: 'DISBURSED' });
    return { state: 'DISBURSED' as const };
  }

  // The RECIPIENT's stored balance, held inside the paying org's book — the
  // payer's own balance was debited at authorization. `subject` is what
  // separates the two inside one tenant.
  await recordMovement({
    orgId: intent.orgId,
    subject: accountId,
    direction: 'CREDIT',
    amountMinor: BigInt(intent.stablecoinAmountMicro),
    refType: 'TRANSFER',
    refId: intent.id,
    suiTxDigest: intent.suiTxDigest ?? undefined,
  });
  if (intent.deliveryTier === 'STORED_BALANCE') {
    await patchTransfer(intent.id, { state: 'CREDITED' });
    return { state: 'CREDITED' as const };
  }

  if (process.env.SWEEP_ACCOUNT_ENABLED === 'false') throw new Error('Sweep accounts are disabled');
  // Staff read: the transfer in hand already established who owns this.
  const recipient = intent.recipientId ? await readRecipientForStaff(intent.recipientId) : null;
  const quote = await pdaxAdapter.quote(intent.targetCurrency, intent.stablecoinAmountMicro);
  const job = createSweepJob({
    transferIntentId: intent.id,
    recipientId: recipient?.id ?? accountId,
    partner: 'PDAX',
    amountUsdcMicro: intent.stablecoinAmountMicro,
    targetCurrency: intent.targetCurrency,
    fxRate: quote.fxRate,
  });
  await patchTransfer(intent.id, { state: 'SWEEPING', sweepJobId: job.id });
  updateSweepJob(job.id, { state: 'EXECUTING' });

  try {
    const result = await pdaxAdapter.payout(job);
    const completedAt = new Date();
    const heldDurationMs = completedAt.getTime() - new Date(job.createdAt).getTime();
    await recordMovement({
      orgId: intent.orgId,
      subject: accountId,
      direction: 'DEBIT',
      amountMinor: BigInt(intent.stablecoinAmountMicro),
      refType: 'SWEEP',
      refId: job.id,
      suiTxDigest: intent.suiTxDigest ?? undefined,
    });
    updateSweepJob(job.id, { state: 'COMPLETED', partnerPayoutRef: result.partnerPayoutRef, heldDurationMs, completedAt: completedAt.toISOString() });
    await patchTransfer(intent.id, { state: 'DISBURSED' });
    return { state: 'DISBURSED' as const, heldDurationMs, partnerPayoutRef: result.partnerPayoutRef };
  } catch (error) {
    updateSweepJob(job.id, { state: 'FAILED' });
    await patchTransfer(intent.id, { state: 'FAILED', failedAtState: 'SWEEPING', failureReason: error instanceof Error ? error.message : 'Sweep failed' });
    throw error;
  }
}

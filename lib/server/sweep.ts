import {
  CUSTODY_PHASE_REASON,
  SWEEP_ACCOUNT_DISABLED_AT_DELIVERY,
  deliveryTierAllowed,
  sweepAccountEnabled,
} from '@/lib/server/custody-phase';
import { createSweepJob, updateSweepJob } from '@/lib/server/operations';
import { readRecipientForStaff } from '@/lib/server/recipients-store';
import { recordMovement } from '@/lib/server/ledger-store';
import { patchTransfer, readTransferForStaff } from '@/lib/server/transfers-store';
import { formatMinor } from '@/lib/money';
import { legacySweepPayout } from '@/lib/server/pdax';
import { bankPartnerForCurrency, payoutPartner } from '@/lib/payouts/registry';

export async function completeDeliveryForTransfer(intentId: string) {
  const intent = await readTransferForStaff(intentId);
  if (!intent) throw new Error('Transfer intent not found');
  // The custody gate, enforced here as well. The authorize route refuses a
  // fund-holding tier before this runs, but this is the code that credits a
  // stored balance and opens a sweep, so it does not rely on its caller: any
  // intent carrying such a tier (an old row, a new caller) stops before a
  // ledger line is written. Unknown tiers stop too, rather than falling
  // through to the sweep. The caller records this as the failure reason.
  if (!deliveryTierAllowed(intent.deliveryTier)) throw new Error(CUSTODY_PHASE_REASON);
  // The sweep switch, checked here before anything is credited. It used to be
  // read only after the recipient's stored-balance credit below, so a sweep
  // refused by the switch left that credit behind. The authorize route
  // refuses a sweep while the switch is off, so this is a backstop, like the
  // custody check above; its reason never says "choose again".
  if (intent.deliveryTier === 'SWEEP_ACCOUNT' && !sweepAccountEnabled()) throw new Error(SWEEP_ACCOUNT_DISABLED_AT_DELIVERY);
  const accountId = intent.recipientId ?? intent.recipientName;

  if (intent.deliveryTier === 'PAYOUT_ONLY') {
    await patchTransfer(intent.id, { state: 'DISBURSED' });
    return { state: 'DISBURSED' as const };
  }

  // A sweep's rate comes from the payout partner's own quote, taken BEFORE
  // anything is credited: in production the partner refuses (no sandbox
  // rate, no made-up reference), and nothing must be left behind when it does.
  let fxRate = '';
  if (intent.deliveryTier === 'SWEEP_ACCOUNT') {
    // The route that pays this currency quotes it; a currency no route pays
    // stops here, with nothing credited.
    const route = bankPartnerForCurrency(intent.targetCurrency);
    if (!route) throw new Error(`No payout route pays ${intent.targetCurrency}; nothing was credited.`);
    const quote = await payoutPartner(route).quote({ currency: intent.targetCurrency, sendMinor: BigInt(intent.stablecoinAmountMicro), now: new Date() });
    fxRate = formatMinor(quote.rateMicro, 6);
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

  // Staff read: the transfer in hand already established who owns this.
  const recipient = intent.recipientId ? await readRecipientForStaff(intent.recipientId) : null;
  const job = await createSweepJob({
    orgId: intent.orgId,
    transferIntentId: intent.id,
    recipientId: recipient?.id ?? accountId,
    partner: 'PDAX',
    amountUsdcMicro: intent.stablecoinAmountMicro,
    targetCurrency: intent.targetCurrency,
    fxRate,
  });
  await patchTransfer(intent.id, { state: 'SWEEPING', sweepJobId: job.id });
  await updateSweepJob(job.id, { state: 'EXECUTING' });

  try {
    const result = await legacySweepPayout(job);
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
    await updateSweepJob(job.id, { state: 'COMPLETED', partnerPayoutRef: result.partnerPayoutRef, heldDurationMs, completedAt: completedAt.toISOString() });
    await patchTransfer(intent.id, { state: 'DISBURSED' });
    return { state: 'DISBURSED' as const, heldDurationMs, partnerPayoutRef: result.partnerPayoutRef };
  } catch (error) {
    await updateSweepJob(job.id, { state: 'FAILED' });
    await patchTransfer(intent.id, { state: 'FAILED', failedAtState: 'SWEEPING', failureReason: error instanceof Error ? error.message : 'Sweep failed' });
    throw error;
  }
}

import { after, NextResponse } from 'next/server';
import { z } from 'zod';

import { createIntercompanyTransfer } from '@/lib/server/intercompany';
import { convertUsdToUsdc, usdCentsToUsdcMicro } from '@/lib/server/labuan-settlement';
import { executeComposedPayment } from '@/lib/server/composed-payment';
import {
  createLedgerEntry,
  createRecipient,
  createTransferIntent,
  getLedgerBalance,
  updateAuditReceipt,
  updateInvoice,
  updateTransferIntent,
} from '@/lib/server/operations';
import { pythAdapter } from '@/lib/server/pyth';
import { calculateQuote } from '@/lib/server/quote';
import { completeDeliveryForTransfer } from '@/lib/server/sweep';
import { confirmUsdFunding } from '@/lib/server/funding-intake';
import { readFundingSession, recordLastUsedFundingSource, updateFundingSession } from '@/lib/server/funding-sessions';
import {
  FundingRegistryError,
  fundingMethodForSelection,
  resolveFundingSelection,
  type FundingSelection,
} from '@/lib/funding/registry';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { requireActiveOrg } from '@/lib/server/kyb-gate';
import { custodyPhaseResponse, deliveryTierAllowed } from '@/lib/server/custody-phase';
import { checkMinimumSettlement } from '@/lib/policy/limits';
import { checkAuthorizationLimits } from '@/lib/policy/authorization-limits';
import { verifyPayoutTotp } from '@/lib/auth/totp';
import { readOperatingSettings } from '@/lib/server/operating-settings';
import { readComplianceControls } from '@/lib/server/sui-settlement';
import { isForeignAccountId, resolveSessionAccount } from '@/lib/server/session-account';
import { listLedgerEntries } from '@/lib/server/operations';
import { readJsonBody } from '@/lib/server/http';

export const maxDuration = 60;

const authorizeSchema = z.object({
  recipient: z.object({
    name: z.string().trim().min(2),
    country: z.string().trim().min(2),
    bank: z.object({ swift: z.string().optional(), account: z.string().trim().min(1) }).optional(),
  }),
  amount: z.object({ value: z.string(), targetCurrency: z.string().length(3) }),
  quote: z.object({ netReceived: z.string() }).optional(),
  deliveryTier: z.enum(['PAYOUT_ONLY', 'SWEEP_ACCOUNT', 'STORED_BALANCE']).default('PAYOUT_ONLY'),
  invoiceId: z.string().optional(),
  paymentRail: z.string().optional(),
  fundingSessionId: z.string().optional(),
  businessAccountId: z.string().trim().min(1).optional(),
  fundingSelection: z.discriminatedUnion('type', [
    z.object({
      source: z.literal('SPLASH_BALANCE'),
      type: z.literal('held'),
      feeTier: z.literal('DISCOUNT'),
    }),
    z.object({
      source: z.literal('BANK_USD'),
      type: z.literal('fiat'),
      provider: z.enum(['STRIPE', 'AIRWALLEX']),
      feeTier: z.literal('STANDARD'),
    }),
    z.object({
      source: z.enum(['USDC', 'USDSUI', 'USDT']),
      type: z.literal('stablecoin'),
      asset: z.enum(['USDC', 'USDSUI', 'USDT']),
      rail: z.enum(['SUI_NATIVE', 'CCTP']),
      sourceChain: z.enum(['ETHEREUM', 'SOLANA', 'BASE', 'ARBITRUM']).optional(),
      feeTier: z.literal('DISCOUNT'),
    }),
  ]).optional(),
  totp: z.string().optional(),
  kycTier: z.union([z.number(), z.string()]).optional(),
});

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const rawBody = await readJsonBody(request);
  try {
    assertCleanBody(rawBody, 'transfers/authorize');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }
  const gate = await requireActiveOrg(auth.session);
  if (gate.response) return gate.response;

  const parsed = authorizeSchema.safeParse(rawBody);
  if (!parsed.success) return NextResponse.json({ error: 'Invalid transfer authorization' }, { status: 400 });
  const body = parsed.data;

  // Phase 0 pays out. A STORED_BALANCE or SWEEP_ACCOUNT delivery holds the
  // recipient's funds, which needs the custody package — and the licence
  // behind it. Refused here, before a recipient or an intent exists.
  if (!deliveryTierAllowed(body.deliveryTier)) return custodyPhaseResponse();

  const totp = String(body.totp ?? '');
  const paymentRail = String(body.paymentRail ?? 'STRIPE_CHECKOUT');

  // The paying account is resolved from the SESSION. It used to come from
  // `body.businessAccountId`, which let any session holder name another org's
  // funded account and spend it.
  const { accountId: businessAccountId } = await resolveSessionAccount(auth.session);
  if (isForeignAccountId(body.businessAccountId, businessAccountId)) {
    return NextResponse.json({ error: 'businessAccountId does not belong to this organization' }, { status: 403 });
  }

  const settings = readOperatingSettings();

  // Second factor. This used to be `/^\d{6}$/` and nothing else — any six
  // digits authorized a payout. `requireTotp` is now load-bearing: when it is
  // on and no secret is enrolled, we refuse rather than fall back to the shape
  // check.
  const totpRequiredForThisRail =
    !body.fundingSessionId &&
    body.fundingSelection?.type !== 'held' &&
    paymentRail !== 'STRIPE_CHECKOUT' &&
    paymentRail !== 'AIRWALLEX_WIRE';
  if (totpRequiredForThisRail) {
    const verdict = verifyPayoutTotp({ code: totp, accountId: businessAccountId, requireTotp: settings.requireTotp });
    if (!verdict.ok) {
      return NextResponse.json({ error: verdict.message, code: `totp_${verdict.code}` }, { status: 400 });
    }
  }

  const sourceAmount = Number.parseFloat(body.amount.value);
  // Minimum settlement size. Checked server-side before any funding session,
  // quote or ledger write, so a client that skips the form validation cannot
  // open a sub-minimum transfer.
  const minimum = checkMinimumSettlement(sourceAmount, 'transfer');
  if (!minimum.ok) {
    return NextResponse.json(
      { error: minimum.message, code: 'below_minimum', minimumUsd: minimum.minimumUsd },
      { status: 400 },
    );
  }
  // Ceilings the operator configured in Settings. Until now the only amount
  // rule on this route was the $100 floor, so a $1,000 per-transfer limit
  // bounded nothing.
  const limits = checkAuthorizationLimits({
    amountUsd: sourceAmount,
    settings,
    ledger: listLedgerEntries(businessAccountId),
  });
  if (!limits.ok) {
    return NextResponse.json({ error: limits.message, code: limits.code, limitUsd: limits.limitUsd }, { status: 400 });
  }
  if (limits.requiresSecondApproval) {
    return NextResponse.json(
      {
        error:
          `${body.amount.value} USD is at or above the ${settings.approvalThresholdUsd} approval threshold and ` +
          'dual approval is enabled, so this payment needs a second approver. Submit it through the approval queue.',
        code: 'requires_second_approval',
        approvalThresholdUsd: settings.approvalThresholdUsd,
      },
      { status: 409 },
    );
  }

  // The on-chain pause switch does not gate this path: the live transfer PTB is
  // payment_intent::confirm_payment_intent, which imports neither
  // compliance_config nor peg_monitor, so `assert_active` never runs. Until the
  // republished contract carries those guards, refuse here — otherwise ticking
  // "Pause settlement" halts batches while customer transfers keep executing.
  const controls = await readComplianceControls();
  if (controls.paused) {
    return NextResponse.json(
      { error: 'Settlement is paused by the compliance operator.', code: 'settlement_paused' },
      { status: 503 },
    );
  }

  const sourceAmountCents = Math.round(sourceAmount * 100);
  const sourceAmountMicro = Math.round(sourceAmount * 1_000_000);
  let fundingSession = body.fundingSessionId ? readFundingSession(body.fundingSessionId) : null;
  if (body.fundingSessionId && !fundingSession) {
    return NextResponse.json({ error: 'Funding session not found' }, { status: 404 });
  }
  // A funding session carries a CREDITed deposit. Binding another org's session
  // to this transfer would spend their deposit, so ownership is checked rather
  // than assumed from possession of the (guessable-length) session id.
  if (fundingSession && fundingSession.businessAccountId !== businessAccountId) {
    return NextResponse.json({ error: 'Funding session does not belong to this organization' }, { status: 403 });
  }
  if (fundingSession?.transferIntentId) {
    return NextResponse.json({ error: 'Funding session is already bound to a transfer' }, { status: 409 });
  }
  if (fundingSession && Math.abs(fundingSession.amountExpectedMicro - Math.round(sourceAmount * 1_000_000)) > 1) {
    return NextResponse.json({ error: 'Funding session amount does not match the transfer' }, { status: 409 });
  }
  let fundingSelection: FundingSelection | null = fundingSession?.selection ?? (body.fundingSelection as FundingSelection | undefined) ?? null;
  if (!fundingSelection) {
    return NextResponse.json({ error: 'Payment source is required' }, { status: 400 });
  }
  try {
    resolveFundingSelection(fundingSelection);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Payment source is unavailable' },
      { status: error instanceof FundingRegistryError ? 400 : 503 },
    );
  }
  if (!Number.isSafeInteger(sourceAmountMicro) || sourceAmountMicro <= 0) {
    return NextResponse.json({ error: 'A positive source amount is required' }, { status: 400 });
  }
  if (!fundingSession && fundingSelection.type !== 'held') {
    return NextResponse.json({ error: 'Bank and coin sources require a funding session before settlement' }, { status: 409 });
  }
  if (fundingSelection.type === 'held' && getLedgerBalance(businessAccountId) < sourceAmountMicro) {
    return NextResponse.json({ error: 'Splash balance is insufficient for this payment source' }, { status: 409 });
  }
  if (fundingSelection.type === 'fiat' && fundingSession) {
    try {
      fundingSession = confirmUsdFunding(fundingSession.id);
      fundingSelection = fundingSession.selection;
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'USD provider confirmation is pending' },
        { status: 409 },
      );
    }
  }
  if (fundingSelection.type === 'stablecoin' && fundingSession?.status !== 'CREDITED') {
    return NextResponse.json({ error: `Coin source is ${fundingSession?.status ?? 'not ready'}; settlement cannot start` }, { status: 409 });
  }
  const feeTier = fundingSelection.feeTier;
  const serverQuote = sourceAmountCents > 0
    ? await calculateQuote(sourceAmountCents, undefined, body.amount.targetCurrency, feeTier)
    : null;
  const pegStatus = await pythAdapter.getPegStatus();
  if (!pegStatus.pegged) {
    return NextResponse.json({ error: `Settlement blocked: stablecoin peg deviation too high (${pegStatus.deviationPpm} ppm).` }, { status: 409 });
  }

  const stablecoinAmountMicro = fundingSelection.type === 'stablecoin'
    ? fundingSession!.normalizedAmountUsdcMicro ?? 0
    : fundingSelection.type === 'held'
      ? sourceAmountMicro
    : sourceAmountCents > 0 ? await usdCentsToUsdcMicro(sourceAmountCents) : 0;
  const conversion = fundingSelection.type === 'stablecoin' || fundingSelection.type === 'held'
    ? null
    : sourceAmount > 0 ? await convertUsdToUsdc(sourceAmount) : null;
  const sourceStablecoin = 'USDC' as const;
  const recipient = createRecipient({
    name: body.recipient.name,
    country: body.recipient.country,
    swift: body.recipient.bank?.swift,
    account: body.recipient.bank?.account,
    tier: body.deliveryTier,
  });
  const intent = createTransferIntent({
    recipientName: recipient.name,
    recipientId: recipient.id,
    invoiceId: body.invoiceId,
    deliveryTier: body.deliveryTier,
    targetCurrency: serverQuote?.targetCurrency ?? body.amount.targetCurrency,
    targetAmount: serverQuote ? serverQuote.toAmount.toFixed(2) : body.quote?.netReceived ?? '0.00',
    sourceAmountUsd: Number.isFinite(sourceAmount) ? sourceAmount.toFixed(2) : '0.00',
    quoteId: serverQuote?.quoteId ?? null,
    exchangeRate: serverQuote?.exchangeRate ?? null,
    sourceStablecoin,
    stablecoinAmountMicro,
    daxTier: conversion?.tier ?? null,
    pegChecked: true,
    fundingSessionId: fundingSession?.id,
    fundingSource: fundingSelection.source,
    fundingMethod: fundingMethodForSelection(fundingSelection),
    fundingProvider: fundingSelection.type === 'fiat' ? fundingSelection.provider : undefined,
    fundingAsset: fundingSelection.type === 'stablecoin' ? fundingSelection.asset : undefined,
    fundingRail: fundingSelection.type === 'stablecoin' ? fundingSelection.rail : undefined,
    fundingSourceChain: fundingSelection.type === 'stablecoin' ? fundingSelection.sourceChain : undefined,
    fundingFeeTier: feeTier,
    fundingKytStatus: fundingSelection.type === 'stablecoin' ? fundingSession?.status : undefined,
    fundingNormalizeVenue: fundingSession?.normalizeVenue,
    fundingEffectiveSlippageBps: fundingSession?.effectiveSlippageBps,
  });
  if (fundingSession) updateFundingSession(fundingSession.id, { transferIntentId: intent.id });

  // Debit the PAYER for every funding source, not only `held`.
  //
  // `ingestStablecoinDeposit` writes a CREDIT against the funding session's
  // account when a deposit lands, and that same account is what
  // `getLedgerBalance` reports as spendable "Splash Balance". Debiting only on
  // the `held` branch meant a stablecoin-funded transfer settled without ever
  // consuming its credit — so one 5,000 deposit funded a 5,000 stablecoin
  // transfer AND a second 5,000 transfer from the balance it left behind.
  // (`completeDeliveryForTransfer` does write a DEBIT, but against the
  // RECIPIENT's account, so it never offsets the payer's credit.)
  const debitedAmountMicro = fundingSelection.type === 'stablecoin'
    ? fundingSession?.normalizedAmountUsdcMicro ?? sourceAmountMicro
    : sourceAmountMicro;
  const payerDebit = createLedgerEntry({
    accountId: businessAccountId,
    direction: 'DEBIT',
    amountUsdcMicro: debitedAmountMicro,
    refType: 'TRANSFER',
    refId: intent.id,
    demo: process.env.NODE_ENV !== 'production' || process.env.USE_MOCK_APIS === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
  });
  // Fiat rails fund the payout externally, so their balance legitimately dips
  // negative until the provider's credit posts; a coin or held source going
  // negative means we just spent money the ledger says is not there.
  if (payerDebit.balanceAfterMicro < 0 && fundingSelection.type !== 'fiat') {
    updateTransferIntent(intent.id, {
      state: 'FAILED',
      failureReason: 'Ledger balance would go negative for this funding source',
      failedAtState: 'QUEUED',
    });
    return NextResponse.json(
      { error: 'Splash balance is insufficient for this payment source', code: 'insufficient_ledger_balance' },
      { status: 409 },
    );
  }
  recordLastUsedFundingSource(businessAccountId, fundingSelection.source);
  updateAuditReceipt(intent.id, {
    approvedBy: 'dashboard-operator',
    approvedAt: new Date().toISOString(),
  });
  if (body.invoiceId) updateInvoice(body.invoiceId, { transferIntentId: intent.id });

  if (conversion?.success && conversion.labuanSettlementId) {
    createIntercompanyTransfer({ transferIntentId: intent.id, amountUsd: conversion.usdAmount, usdToUsdcRate: conversion.usdToUsdcRate });
  }

  after(async () => {
    updateTransferIntent(intent.id, { state: 'QUEUED' });
    try {
      updateTransferIntent(intent.id, { state: 'SETTLING' });
      const result = await executeComposedPayment({
        transferId: intent.id,
        recipientAddress: '',
        recipientLabel: intent.recipientName,
        amountMist: Math.max(1_000_000, stablecoinAmountMicro),
        targetCurrency: serverQuote?.targetCurrency ?? body.amount.targetCurrency,
        fxRate: serverQuote?.exchangeRate ?? intent.exchangeRate,
        funding: {
          sessionId: intent.fundingSessionId,
          source: intent.fundingSource,
          method: intent.fundingMethod,
          provider: intent.fundingProvider,
          asset: intent.fundingAsset,
          rail: intent.fundingRail,
          sourceChain: intent.fundingSourceChain,
          feeTier: intent.fundingFeeTier,
          kytStatus: intent.fundingKytStatus,
          normalizeVenue: intent.fundingNormalizeVenue,
          effectiveSlippageBps: intent.fundingEffectiveSlippageBps,
        },
      });
      updateTransferIntent(intent.id, {
        state: 'SETTLED',
        suiTxDigest: result.digest,
        verificationReference: result.digest,
        receiptObjectId: result.auditAnchorObjectId ?? undefined,
        paymentIntentId: result.intentId,
        intentCreateDigest: result.intentCreateDigest,
        walrusBlobId: result.walrus.blobId,
        sealPolicyId: result.sealPolicy.policyId,
        auditHash: result.auditHash,
        auditAnchorId: result.auditAnchorObjectId ?? undefined,
        smartTreasuryId: result.smartTreasuryId ?? undefined,
        composedActions: result.composedActions,
      });
      updateAuditReceipt(intent.id, {
        suiTxDigest: result.digest,
        paymentIntentId: result.intentId,
        intentCreateDigest: result.intentCreateDigest,
        walrusBlobId: result.walrus.blobId,
        sealPolicyId: result.sealPolicy.policyId,
        auditHash: result.auditHash,
        auditAnchorId: result.auditAnchorObjectId ?? undefined,
        auditAnchorDigest: result.digest,
        evidence: result.evidence,
        smartTreasuryId: result.smartTreasuryId ?? undefined,
        composedActions: result.composedActions,
      });
      await completeDeliveryForTransfer(intent.id);
    } catch (error) {
      updateTransferIntent(intent.id, {
        state: 'FAILED',
        failureReason: error instanceof Error ? error.message : 'Unknown settlement error',
        failedAtState: 'SETTLING',
      });
    }
  });

  return NextResponse.json({
    transferIntentId: intent.id,
    state: intent.state,
    quote: serverQuote,
    stablecoinUsed: sourceStablecoin,
    daxProvider: intent.daxProvider,
    daxTier: intent.daxTier,
    deliveryTier: intent.deliveryTier,
    funding: {
      source: intent.fundingSource,
      method: intent.fundingMethod,
      feeTier: intent.fundingFeeTier,
      sessionId: intent.fundingSessionId,
    },
  });
}

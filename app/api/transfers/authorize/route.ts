import { after, NextResponse } from 'next/server';
import { z } from 'zod';

import { createIntercompanyTransfer } from '@/lib/server/intercompany';
import { convertUsdToUsdc, usdCentsToUsdcMicro } from '@/lib/server/labuan-settlement';
import { executeComposedPayment } from '@/lib/server/composed-payment';
import {
  buildRecipient,
  createTransferIntent,
} from '@/lib/server/operations';
import { accountBalance, listMovementsSince, recordMovement } from '@/lib/server/ledger-store';
import { persistRecipient } from '@/lib/server/recipients-store';
import { missingTravelRuleFields, travelRuleSnapshot } from '@/lib/compliance/travel-rule';
import { readOriginator } from '@/lib/server/originator';
import { patchInvoice } from '@/lib/server/invoices-store';
import { patchAuditReceipt, patchTransfer, persistTransfer } from '@/lib/server/transfers-store';
import { proposeForApproval } from '@/lib/server/dual-approval';
import { resolveApprovalClaim } from '@/lib/server/approved-proposal';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
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
import { checkAuthorizationLimits, startOfUtcDay } from '@/lib/policy/authorization-limits';
import { verifyPayoutTotp } from '@/lib/auth/totp';
import { approvalRequiredResponse, consumeActionApproval, releaseActionApproval } from '@/lib/server/step-up-gate';
import { fiatPaymentSubstance } from '@/lib/server/step-up-subjects';
import { readOrgSettings } from '@/lib/server/org-settings';
import { readComplianceControls } from '@/lib/server/sui-settlement';
import { isForeignAccountId, requireSessionAccount } from '@/lib/server/session-account';
import { readJsonBody } from '@/lib/server/http';
import { requireTermsAccepted } from '@/lib/server/onboarding';

export const maxDuration = 60;

const authorizeSchema = z.object({
  recipient: z.object({
    name: z.string().trim().min(2),
    country: z.string().trim().min(2),
    bank: z.object({ swift: z.string().optional(), account: z.string().trim().min(1) }).optional(),
    /** The FATF R.16 beneficiary half. Optional in the schema and REQUIRED
     *  by `missingTravelRuleFields` below — so an incomplete record is
     *  refused with the specific fields named, not with "invalid body". */
    travelRule: z.record(z.string(), z.unknown()).optional(),
  }),
  travelRulePayment: z.record(z.string(), z.unknown()).optional(),
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

/**
 * A WhatsApp approval spent by this request, and whether the payment it was
 * spent on went ahead. Anything else — a refusal after the approval was used,
 * or a throw — gives it back, so a travel-rule gap or a ceiling does not cost
 * the approver another round of code and passkey.
 */
type SpentApproval = { release: (() => Promise<void>) | null; kept: boolean };

export async function POST(request: Request) {
  const spent: SpentApproval = { release: null, kept: false };
  try {
    return await authorize(request, spent);
  } finally {
    if (spent.release && !spent.kept) await spent.release().catch(() => {});
  }
}

async function authorize(request: Request, spent: SpentApproval) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const rawBody = await readJsonBody(request);
  try {
    assertCleanBody(rawBody, 'transfers/authorize');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }
  const gate = await requireActiveOrg(auth.session, { lane: 'FIAT_OUT_LOCAL' });
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
  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { accountId: businessAccountId, orgId } = accountCheck.account;

  // Onboarding: the terms are a fact on file before anything spends or a
  // record is created (lib/server/onboarding.ts). Sits BESIDE the KYB gate,
  // never instead of it.
  const termsGate = await requireTermsAccepted(orgId);
  if (termsGate) return termsGate;
  if (isForeignAccountId(body.businessAccountId, businessAccountId)) {
    return NextResponse.json({ error: 'businessAccountId does not belong to this organization' }, { status: 403 });
  }

  // This org's dials, not a global file. The file version had no org id and
  // its route had no role check, so any signed-in user could switch dual
  // approval off for every tenant and then send whatever they liked.
  const settings = await readOrgSettings(orgId);

  // An approval collected through the queue, verified against the proposal
  // store and against THIS payment, and spent here. The claim used to be
  // checked for existence, org and status only, so an approved proposal's id
  // could ride on a different payment and skip the second approver — and the
  // same approved payment could be sent again after it executed.
  const approvalClaim = await resolveApprovalClaim(request, orgId, {
    kind: 'PAYMENT',
    substance: fiatPaymentSubstance,
    body: rawBody as Record<string, unknown>,
    consumer: 'transfers/authorize',
  });

  // WhatsApp style (Settings → Approvals): every payout needs a WhatsApp code
  // and passkey approval for exactly this payment — recipient, account,
  // amount, currency, source. Spent here, given back below if the payment is
  // refused. A payment carried out from the approval queue was approved there.
  let whatsappApproved = false;
  if (settings.whatsappEnabled && !approvalClaim.approved) {
    const approval = {
      session: auth.session,
      orgId,
      purpose: 'FIAT_TRANSFER' as const,
      payload: rawBody as Record<string, unknown>,
    };
    whatsappApproved = await consumeActionApproval(approval);
    if (!whatsappApproved) return approvalRequiredResponse('FIAT_TRANSFER');
    spent.release = () => releaseActionApproval(approval);
  }

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
    // A WhatsApp code + passkey approval for exactly this payment stands in
    // for the authenticator code.
    if (!whatsappApproved) {
      const verdict = verifyPayoutTotp({ code: totp, accountId: businessAccountId, requireTotp: settings.requireTotp });
      if (!verdict.ok) {
        return NextResponse.json(
          {
            error: settings.whatsappEnabled
              ? `${verdict.message} Or approve this payout with a WhatsApp code and your passkey.`
              : verdict.message,
            code: `totp_${verdict.code}`,
          },
          { status: 400 },
        );
      }
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
  // The beneficiary is resolved BEFORE the ceilings, because a payment that
  // trips the dual-approval threshold becomes a proposal, and that proposal
  // must name a beneficiary id the compliance screening store can resolve.
  // Named in prose instead, the approval gate can never open — and a control
  // nobody can pass is the dead end this change exists to close, wearing a
  // different hat.
  //
  // The cost is that a refused payment leaves a beneficiary record. That is
  // the operator's own input for a counterparty that exists either way, and
  // it is scoped to their org.
  const recipient = await persistRecipient(buildRecipient({
    orgId,
    name: body.recipient.name,
    country: body.recipient.country,
    swift: body.recipient.bank?.swift,
    account: body.recipient.bank?.account,
    tier: body.deliveryTier,
    travelRule: body.recipient.travelRule as Parameters<typeof buildRecipient>[0]['travelRule'],
  }));

  // The travel rule, checked HERE and not only in the form.
  //
  // The same module the form asks — a client that skips the UI, or an
  // integration posting straight to this route, meets the identical rule.
  // The ORIGINATOR half is read from the org's own KYB record and never
  // from the body: it is the payer's identity, and a request that could
  // supply it is a request that could misstate who sent the money.
  const { originator } = await readOriginator(orgId);
  const travelRuleBeneficiary = {
    name: recipient.name,
    bankName: recipient.bank,
    ...(body.recipient.travelRule ?? {}),
  };
  const travelRuleMissing = missingTravelRuleFields({
    destinationCountry: body.recipient.country,
    beneficiary: travelRuleBeneficiary,
    originator,
    payment: body.travelRulePayment ?? {},
  });
  if (travelRuleMissing.length > 0) {
    return NextResponse.json(
      {
        error:
          'This payment cannot be sent yet: the record that has to travel with it is incomplete.',
        code: 'travel_rule_incomplete',
        // Each one names the field AND why the corridor asks, so a caller
        // can fix it without reading a regulation.
        missing: travelRuleMissing,
      },
      { status: 400 },
    );
  }

  // Ceilings the operator configured in Settings. Until now the only amount
  // rule on this route was the $100 floor, so a $1,000 per-transfer limit
  // bounded nothing.
  // The daily ceiling is computed from the ledger rather than a counter, which
  // is right — but the ledger it read was the in-process map, so a restart
  // reset every account's daily spend to zero and the cap stopped binding.
  // Today's movements only, unpaged: a page limit here would hand a busy
  // account its budget back once the early debits fell off the end.
  const todaysMovements = await listMovementsSince(orgId, startOfUtcDay(Date.now()));
  const limits = checkAuthorizationLimits({
    amountUsd: sourceAmount,
    settings,
    ledger: todaysMovements.map((line) => ({
      direction: line.direction,
      amountUsdcMicro: Number(line.amountMinor),
      createdAt: line.createdAt,
    })),
  });
  if (!limits.ok) {
    return NextResponse.json({ error: limits.message, code: limits.code, limitUsd: limits.limitUsd }, { status: 400 });
  }
  // An approval already collected for THIS payment (resolved above) lifts
  // the second-approver requirement and nothing else. Verified against the
  // proposal store, never taken from the header: a client that could assert
  // its own approval would be a considerably worse hole than the one dual
  // approval closes.
  if (limits.requiresSecondApproval && !approvalClaim.approved) {
    // This used to answer 409 telling the operator to "submit it through the
    // approval queue", and put nothing in the approval queue. A control that
    // stops work without offering the sanctioned path is one people route
    // around — by splitting the payment under the threshold, which is worse
    // than having no threshold.
    const maker = await resolveAuthorityForSession(auth.session);
    const proposal = await proposeForApproval({
      orgId,
      // The MAKER, from the session. The submit route compares this against
      // the approver to refuse self-approval, so it is the whole substance
      // of maker-checker.
      createdBy: maker.userId,
      kind: 'PAYMENT',
      amountUsd: body.amount.value,
      targetCurrency: body.amount.targetCurrency.toUpperCase(),
      recommendation:
        `Pay ${body.amount.value} USD to ${body.recipient.name} in ` +
        `${body.amount.targetCurrency.toUpperCase()}. Above the ` +
        `${settings.approvalThresholdUsd} USD dual-approval threshold.`,
      passedChecks: [
        { source: 'COMPLIANCE', ref: 'KYB org state is ACTIVE' },
        { source: 'BALANCE', ref: `Per-transfer and daily ceilings, ${limits.spentTodayUsd} USD spent today` },
        // The beneficiary ID, not its name. `resolveComplianceForProposal`
        // reads COUNTERPARTY refs as ids and looks up the screening record;
        // an unresolvable ref blocks forever rather than failing closed once.
        { source: 'COUNTERPARTY', ref: recipient.id },
      ],
      payload: { ...body, businessAccountId: undefined },
      idempotencyKey: `transfer:${orgId}:${body.amount.value}:${body.recipient.name}:${body.amount.targetCurrency}`,
      approvalThresholdUsd: settings.approvalThresholdUsd,
    });
    // The WhatsApp approval went into the proposal: the queue carries it now.
    if (proposal) spent.kept = true;
    return NextResponse.json(
      {
        error:
          `${body.amount.value} USD is at or above the ${settings.approvalThresholdUsd} approval threshold and ` +
          (proposal
            ? 'dual approval is enabled. It is now in the approval queue and needs a second approver.'
            : 'dual approval is enabled, so this payment needs a second approver. The approval queue could not be reached — try again.'),
        code: 'requires_second_approval',
        approvalThresholdUsd: settings.approvalThresholdUsd,
        // Where it went, so the client can link straight to it rather than
        // telling the operator to go looking.
        proposalId: proposal?.id ?? null,
        queueUrl: proposal ? '/queue' : null,
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
  // The balance this gate reads is now a SUM over ledger_postings rather than
  // over a map that emptied on restart. Compared as bigint on both sides —
  // mixing a bigint balance with a number amount is how a check passes on a
  // figure the ledger does not hold.
  if (
    fundingSelection.type === 'held'
    && (await accountBalance(orgId)) < BigInt(sourceAmountMicro)
  ) {
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
    // No live price at all is its own answer, not a "deviation": this used to
    // pass on Pyth's mock $1.00 whenever DeepBook was unreachable.
    if (pegStatus.primary === 'none') {
      return NextResponse.json(
        {
          error: 'Settlement paused: no live stablecoin price is available to check the USDC peg right now. Nothing was sent; try again shortly.',
          code: 'peg_unverified',
        },
        { status: 409 },
      );
    }
    const measured = pegStatus.primary === 'deepbook'
      ? `${pegStatus.deepbook?.deviationBps} bps on DeepBook`
      : `${pegStatus.deviationPpm} ppm on Pyth`;
    return NextResponse.json({ error: `Settlement blocked: stablecoin peg deviation too high (${measured}).`, code: 'peg_deviation' }, { status: 409 });
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
  const intent = createTransferIntent({
    // From the SESSION, never the request. This is the field that decides
    // whose transfer it is and therefore who can read it back.
    orgId,
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

  // Freeze what travelled with THIS payment.
  //
  // A snapshot rather than a join to the beneficiary: R.16 is about what
  // accompanied this transfer, and a beneficiary edited next week must not
  // silently rewrite the record of a payment already sent. It rides in the
  // settlement metadata, which is where `travel_rule_snapshot` lands.
  Object.assign(intent, {
    travelRuleSnapshot: travelRuleSnapshot({
      destinationCountry: body.recipient.country,
      beneficiary: travelRuleBeneficiary,
      originator,
      payment: body.travelRulePayment ?? {},
    }),
  });

  // Postgres when configured, this process only when not — one place decides,
  // and every read of this transfer goes back through the same store.
  await persistTransfer(intent);
  // From here the transfer exists and the approval is spent on it, whatever
  // settlement does next.
  spent.kept = true;
  if (fundingSession) updateFundingSession(fundingSession.id, { transferIntentId: intent.id });

  // Debit the PAYER for every funding source, not only `held`.
  //
  // `ingestStablecoinDeposit` writes a CREDIT against the funding session's
  // account when a deposit lands, and that same account is what
  // `accountBalance` reports as spendable "Splash Balance". Debiting only on
  // the `held` branch meant a stablecoin-funded transfer settled without ever
  // consuming its credit — so one 5,000 deposit funded a 5,000 stablecoin
  // transfer AND a second 5,000 transfer from the balance it left behind.
  // (`completeDeliveryForTransfer` does write a DEBIT, but against the
  // RECIPIENT's account, so it never offsets the payer's credit.)
  const debitedAmountMicro = fundingSelection.type === 'stablecoin'
    ? fundingSession?.normalizedAmountUsdcMicro ?? sourceAmountMicro
    : sourceAmountMicro;
  const payerDebit = await recordMovement({
    orgId,
    direction: 'DEBIT',
    amountMinor: BigInt(debitedAmountMicro),
    refType: 'TRANSFER',
    refId: intent.id,
    demo: process.env.NODE_ENV !== 'production' || process.env.USE_MOCK_APIS === 'true' || process.env.NEXT_PUBLIC_DEMO_MODE === 'true',
  });
  // Fiat rails fund the payout externally, so their balance legitimately dips
  // negative until the provider's credit posts; a coin or held source going
  // negative means we just spent money the ledger says is not there.
  if (payerDebit.balanceAfterMinor < 0n && fundingSelection.type !== 'fiat') {
    await patchTransfer(intent.id, {
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
  await patchAuditReceipt(intent.id, {
    approvedBy: 'dashboard-operator',
    approvedAt: new Date().toISOString(),
  });
  // Scoped: binding an invoice to a transfer is a write, and it used to accept
  // any invoice id from the request body regardless of who owned it.
  if (body.invoiceId) await patchInvoice(orgId, body.invoiceId, { transferIntentId: intent.id });

  if (conversion?.success && conversion.labuanSettlementId) {
    createIntercompanyTransfer({ transferIntentId: intent.id, amountUsd: conversion.usdAmount, usdToUsdcRate: conversion.usdToUsdcRate });
  }

  after(async () => {
    await patchTransfer(intent.id, { state: 'QUEUED' });
    try {
      await patchTransfer(intent.id, { state: 'SETTLING' });
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
      // This was two writes into two stores — the settlement fields into the
      // transfer, then eleven of the same fields again into the audit receipt.
      // Two records holding one fact, free to disagree the moment one write
      // landed and the other did not. The receipt is now composed from this
      // row, so there is one write and nothing to reconcile.
      await patchTransfer(intent.id, {
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
        auditAnchorDigest: result.digest,
        evidence: result.evidence,
        smartTreasuryId: result.smartTreasuryId ?? undefined,
        composedActions: result.composedActions,
      });
      await completeDeliveryForTransfer(intent.id);
    } catch (error) {
      await patchTransfer(intent.id, {
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

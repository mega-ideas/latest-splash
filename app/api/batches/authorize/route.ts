import { createHash } from 'node:crypto';

import { after, NextResponse } from 'next/server';

import { assertCleanBody, ProvenanceViolationError, provenanceViolationResponse } from '@/lib/auth/provenance-guard';
import { requireActiveOrg } from '@/lib/server/kyb-gate';
import { checkMinimumSettlement } from '@/lib/policy/limits';
import { MAX_BATCH_ROWS } from '@/lib/policy/batch-limits';
import { checkAuthorizationLimits, startOfUtcDay } from '@/lib/policy/authorization-limits';
import { verifyPayoutTotp } from '@/lib/auth/totp';
import { consumeActionApproval } from '@/lib/server/step-up-gate';
import { readOrgSettings } from '@/lib/server/org-settings';
import { requireCustomerRequest } from '@/lib/server/customer-auth';
import { readJsonBody } from '@/lib/server/http';
import { buildBatch } from '@/lib/server/operations';
import { claimBatch, patchBatch } from '@/lib/server/batches-store';
import { proposeForApproval } from '@/lib/server/dual-approval';
import { resolveApprovalClaim } from '@/lib/server/approved-proposal';
import { batchRunKey, batchSecondFactor } from '@/lib/server/batch-approval';
import { batchPayoutSubstance, batchTargetCurrency, payableBatchRows } from '@/lib/server/step-up-subjects';
import { resolveAuthorityForSession } from '@/lib/auth/authority';
import { listMovementsSince } from '@/lib/server/ledger-store';
import { readComplianceControls, recordBatchSettlementOnSui } from '@/lib/server/sui-settlement';
import { requireSessionAccount } from '@/lib/server/session-account';
import { requireTermsAccepted } from '@/lib/server/onboarding';

export const maxDuration = 60;

type BatchRow = {
  name?: string;
  address?: string;
  amount?: string;
};

/**
 * Replay key for a payroll run.
 *
 * A caller-supplied `Idempotency-Key` wins. When absent we derive one from the
 * account and the exact row set, so the common accident — the response leg
 * drops, the dashboard shows "Batch failed", the operator re-submits the same
 * file — is caught even though the client sent no key. Two genuinely different
 * payrolls hash differently; the same payroll twice in a row is refused, and
 * `deriveIdempotencyKey` is deliberately NOT time-bucketed, so a real repeat
 * payment of an identical row set needs an explicit new key. A run the
 * approval queue releases is keyed by its approval instead
 * (lib/server/batch-approval.ts).
 */
function deriveIdempotencyKey(orgId: string, rows: BatchRow[], targetCurrency: string): string {
  const canonical = rows
    .map((row) => `${row.name ?? ''}|${row.address ?? ''}|${row.amount ?? ''}`)
    .join('\n');
  // NUL separators, written as escapes rather than literal bytes. As raw
  // NULs this file counted as binary: it never appeared in a diff, never in
  // a grep, never in a review — for the function that decides whether a
  // payroll run has already been paid.
  return createHash('sha256')
    .update(`${orgId}\u0000${targetCurrency}\u0000${canonical}`)
    .digest('hex');
}

export async function POST(request: Request) {
  const auth = await requireCustomerRequest(request);
  if (auth.response) return auth.response;

  const body = await readJsonBody(request);
  try {
    assertCleanBody(body, 'batches/authorize');
  } catch (error) {
    if (error instanceof ProvenanceViolationError) return provenanceViolationResponse(error);
    throw error;
  }
  const gate = await requireActiveOrg(auth.session, { lane: 'FIAT_OUT_LOCAL' });
  if (gate.response) return gate.response;

  const rows = Array.isArray(body.rows) ? (body.rows as BatchRow[]) : [];
  const totp = String(body.totp ?? '');
  const targetCurrency = batchTargetCurrency(body);

  const accountCheck = await requireSessionAccount(auth.session);
  if (accountCheck.response) return accountCheck.response;
  const { accountId, orgId } = accountCheck.account;

  // Onboarding: the terms are a fact on file before anything spends or a
  // record is created (lib/server/onboarding.ts). Sits BESIDE the KYB gate,
  // never instead of it.
  const termsGate = await requireTermsAccepted(orgId);
  if (termsGate) return termsGate;
  const settings = await readOrgSettings(orgId);

  // The same rule the approval binding uses, so an approval covers exactly
  // the rows this run pays.
  const acceptedRows = payableBatchRows(rows);
  const total = acceptedRows.reduce((sum, row) => sum + Number.parseFloat(String(row.amount ?? '0')), 0);
  const rowsKey = deriveIdempotencyKey(orgId, acceptedRows, targetCurrency);

  // An approval already collected for THIS run lifts the second-approver
  // requirement and the second factor, and nothing else. Verified against the
  // proposal store, never taken from the header: a client that could assert
  // its own approval would be a considerably worse hole than the one dual
  // approval closes.
  //
  // It must be a batch approval for these payable rows in this currency, and
  // it is spent here. The claim used to be checked for existence, org and
  // status only: any approved proposal's id could ride on a different run,
  // and an approval that had already paid could pay again under a fresh
  // Idempotency-Key.
  //
  // Read before the second factor, because for an approved run it stands in
  // for one (lib/server/batch-approval.ts).
  const approvalClaim = await resolveApprovalClaim(request, orgId, {
    kind: 'BATCH_PAYOUT',
    substance: batchPayoutSubstance,
    body,
    consumer: 'batches/authorize',
  });

  // Settled before a second factor is spent on a request that could not use it.
  const runKey = batchRunKey({ claim: approvalClaim, headerKey: request.headers.get('idempotency-key'), rowsKey });
  if (!runKey.ok) return NextResponse.json({ error: runKey.error, code: runKey.code }, { status: 400 });

  // Real second factor. This was `/^\d{6}$/` — `000000` authorized a payroll run
  // out of the shared SettlementPool.
  //
  // An approved run is replayed with no code, and none could be valid: its
  // maker's was single-use and spent making the proposal. Asked for anyway, it
  // failed every approved run here. The approval of these rows stands in.
  const secondFactor = batchSecondFactor(approvalClaim, settings);
  if (secondFactor.by === 'request') {
    // In WhatsApp style, a WhatsApp code + passkey approval for exactly these
    // rows stands in for the authenticator code. Consumed only when a second
    // factor is actually required.
    const whatsappApproved = secondFactor.whatsapp
      && await consumeActionApproval({
        session: auth.session,
        orgId,
        purpose: 'BATCH_PAYOUT',
        payload: { rows: body.rows, targetCurrency: body.targetCurrency },
      });
    if (!whatsappApproved) {
      const totpVerdict = verifyPayoutTotp({ code: totp, accountId, requireTotp: settings.requireTotp });
      if (!totpVerdict.ok) {
        return NextResponse.json(
          {
            error: settings.whatsappEnabled
              ? `${totpVerdict.message} Or approve this batch with a WhatsApp code and your passkey.`
              : totpVerdict.message,
            code: `totp_${totpVerdict.code}`,
          },
          { status: 400 },
        );
      }
    }
  }

  // Minimum applies to the batch TOTAL, not per row — a payroll run legitimately
  // contains small individual rows. Checked before the batch record is created
  // so a sub-minimum run never enters the operations store.
  const minimum = checkMinimumSettlement(total, 'batch');
  if (!minimum.ok) {
    return NextResponse.json(
      { error: minimum.message, code: 'below_minimum', minimumUsd: minimum.minimumUsd },
      { status: 400 },
    );
  }
  if (acceptedRows.length > MAX_BATCH_ROWS) {
    return NextResponse.json(
      {
        error:
          `This run has ${acceptedRows.length} payable rows; a single settlement carries at most ${MAX_BATCH_ROWS}. ` +
          'Split it into smaller runs.',
        code: 'batch_too_large',
        maxRows: MAX_BATCH_ROWS,
      },
      { status: 400 },
    );
  }
  // The same daily ceiling as the single-transfer path, from the same durable
  // ledger. It read the in-process map, so a restart handed every account its
  // daily budget back — and a batch is the shape of payment where that matters
  // most, because it is many payouts under one authorization.
  const todaysMovements = await listMovementsSince(orgId, startOfUtcDay(Date.now()));
  const limits = checkAuthorizationLimits({
    amountUsd: total,
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
  // The approval resolved above lifts the second approver here. The minimum,
  // the row cap and the ceilings above, and the pause below, apply to an
  // approved run exactly as to any other.
  if (limits.requiresSecondApproval && !approvalClaim.approved) {
    // Same dead end as the single-transfer path, and it matters more here:
    // a batch is many payouts under one authorization, so an operator with
    // nowhere to submit it splits the file instead.
    const maker = await resolveAuthorityForSession(auth.session);
    const proposal = await proposeForApproval({
      orgId,
      createdBy: maker.userId,
      kind: 'BATCH_PAYOUT',
      amountUsd: total.toFixed(2),
      targetCurrency,
      recommendation:
        `Pay ${acceptedRows.length} recipients ${total.toFixed(2)} USD in ${targetCurrency}. ` +
        `Above the ${settings.approvalThresholdUsd} USD dual-approval threshold.`,
      passedChecks: [
        { source: 'COMPLIANCE', ref: 'KYB org state is ACTIVE, settlement not paused' },
        { source: 'BALANCE', ref: `Daily ceiling, ${limits.spentTodayUsd} USD spent today` },
        { source: 'COUNTERPARTY', ref: `${acceptedRows.length} payable rows, ${rows.length - acceptedRows.length} blocked` },
      ],
      payload: { rows: acceptedRows, targetCurrency },
      // Named by the same rows the run's own replay key is, so a re-submitted
      // file finds the pending proposal rather than queueing a second one.
      idempotencyKey: `batch:${rowsKey}`,
      approvalThresholdUsd: settings.approvalThresholdUsd,
    });
    return NextResponse.json(
      {
        error:
          `This run totals ${total.toFixed(2)} USD, at or above the ${settings.approvalThresholdUsd} approval ` +
          (proposal
            ? 'threshold with dual approval enabled. It is now in the approval queue and needs a second approver.'
            : 'threshold with dual approval enabled. The approval queue could not be reached — try again.'),
        code: 'requires_second_approval',
        approvalThresholdUsd: settings.approvalThresholdUsd,
        proposalId: proposal?.id ?? null,
        queueUrl: proposal ? '/queue' : null,
      },
      { status: 409 },
    );
  }

  // The compliance pause is a chain-side control on settle_batch (abort 352),
  // but checking it here avoids burning gas and, more importantly, avoids the
  // batch record showing SETTLING for a transaction that was always going to
  // abort.
  const controls = await readComplianceControls();
  if (controls.paused) {
    return NextResponse.json(
      { error: 'Settlement is paused by the compliance operator.', code: 'settlement_paused' },
      { status: 503 },
    );
  }

  // Replay guard. This route used to mint a fresh batch on every call, so a
  // dropped response leg plus a re-submit paid every recipient twice out of the
  // shared pool — and the still-valid TOTP sailed through the format check.
  //
  // Under `runKey` from above: the caller's key, else the rows' — and for a
  // run the approval queue released, the approval's, so that one approval
  // releases one run and next month's identical payroll, approved on its own,
  // is not taken for this one.
  //
  // Claim the key by INSERTING it, and let the unique index decide. The
  // read-then-write this replaces had two holes: a restart between the two
  // submissions emptied the map it consulted, and two copies of the same
  // file arriving together both found nothing and both proceeded.
  const claim = await claimBatch(
    buildBatch({
      orgId,
      rowCount: rows.length,
      acceptedRows: acceptedRows.length,
      blockedRows: rows.length - acceptedRows.length,
      totalAmount: total.toFixed(2),
      accountId,
      idempotencyKey: runKey.key,
      proposalId: runKey.proposalId ?? undefined,
    }),
    targetCurrency,
  );
  if (!claim.claimed) {
    return NextResponse.json({ ...claim.batch, idempotentReplay: true }, { status: 200 });
  }
  const batch = claim.batch;

  // Fire Sui settlement after responding so the HTTP round-trip is instant.
  after(async () => {
    await patchBatch(batch.id, { state: 'SETTLING' });
    try {
      const result = await recordBatchSettlementOnSui({
        batchId: batch.id,
        rows: acceptedRows,
        totalUsd: total,
        // Per-corridor fee — contract enforces fee_bps ≤ MAX_FEE_BPS (200).
        targetCurrency,
      });
      // Batch may run in labelled-simulate mode (SUI_BATCH_SETTLEMENT_MODE=simulate):
      // its SIM_ digest has no on-chain tx, so don't emit explorer links that 404.
      const simulated = (result as { simulated?: boolean }).simulated === true;
      // The explorer links are derived on read from the digest and the demo
      // flag, so a simulated run's SIM_ digest cannot produce a link that
      // 404s — see `explorerFor` in the store.
      await patchBatch(batch.id, {
        state: 'SETTLED',
        digest: result.digest,
        packageId: result.packageId,
        demo: simulated,
      });
    } catch (error) {
      await patchBatch(batch.id, { state: 'FAILED' });
      console.error('[Batch Settlement] Failed:', error instanceof Error ? error.message : error);
    }
  });

  return NextResponse.json(batch);
}

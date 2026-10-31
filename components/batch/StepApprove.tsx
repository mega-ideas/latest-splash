'use client';

import { useState } from 'react';
import { CalendarClock, Fingerprint, UsersRound } from 'lucide-react';

import { FEES_OFF_NOTICE, formatUsdc } from '@/lib/fees/copy';
import type { SheetRow } from '@/lib/batch/sheet';
import SignPanel, { type SignLabels } from '../transfer/SignPanel';
import { PrimaryButton, QuietButton } from '../transfer/ui';
import { call, errorText, type ApprovedRow, type BatchReview, type BatchView, type Context, type SigningView } from './api';

const BATCH_LABELS: SignLabels = {
  working: 'Sending the batch',
  done: 'Paid',
  doneNote: 'Every payment, its record and its receipt happened together.',
  deadNote: 'Nothing was sent. You can start the batch again.',
  restart: 'Start a new batch',
};

export type MadeBatch = { batch: BatchView; signing: SigningView | null; approved: ApprovedRow[] | null };

const usdc = (minor: string | bigint) => `${formatUsdc(BigInt(minor))} USDC`;

/** Who approved what the person was shown, from the batch as the server stored it (for a batch opened again later). */
export function approvedFromBatch(batch: BatchView): ApprovedRow[] {
  return batch.rows.map((r) => ({ recipient: r.address, amountMinor: r.amountMinor, maxFeeMinor: r.feeMinor, payeeName: r.payeeName }));
}

/**
 * Step 3 of a batch (v2 brief 5.6): approve, once. Owners sign the whole batch
 * with their passkeys, each on their own device, each seeing every payment
 * decoded from the transaction's own bytes. A team member prepares the batch
 * and an owner starts the signatures. A batch to run later under a rule is
 * not switched on, and the page says so plainly.
 */
export default function StepApprove({
  ctx,
  rows,
  review,
  intentKey,
  made,
  onMade,
  onExecuted,
  onRestart,
  back,
}: {
  ctx: Context | null;
  rows: SheetRow[];
  review: BatchReview | null;
  intentKey: string;
  made: MadeBatch | null;
  onMade: (made: MadeBatch) => void;
  onExecuted: () => void;
  onRestart: () => void;
  back: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = ctx?.role === 'OWNER';
  const mayPrepare = isOwner || ctx?.role === 'MAKER' || ctx?.role === 'APPROVER';

  async function create() {
    if (!review || !review.ready) return;
    setBusy(true);
    setError(null);
    const approved: ApprovedRow[] = review.rows.map((r) => ({ recipient: r.payee?.address ?? '', amountMinor: r.amountMinor ?? '0', maxFeeMinor: r.feeMinor ?? '0', payeeName: r.payee?.name ?? '' }));
    const answer = await call<{ batch?: BatchView; signingRequest?: SigningView | null; feeMinor?: string }>('/api/wallet/batches', {
      body: { rows: rows.map((r) => ({ recipient: r.recipient, amount: r.amount, reference: r.reference })), maxFeeMinor: review.maxFeeMinor },
      key: intentKey,
    });
    setBusy(false);
    if (!answer.ok || !answer.body?.batch) {
      setError(
        answer.status === 409 && answer.body?.feeMinor
          ? `The fee changed to ${usdc(answer.body.feeMinor)} in all since it was shown. Go back, check the rows again and approve the new fee.`
          : errorText(answer, 'The batch could not be made. Nothing was sent.'),
      );
      return;
    }
    onMade({ batch: answer.body.batch, signing: answer.body.signingRequest ?? null, approved });
  }

  async function start() {
    if (!made) return;
    setBusy(true);
    setError(null);
    const answer = await call<{ batch?: BatchView; signingRequest?: SigningView | null }>(`/api/wallet/batches/${encodeURIComponent(made.batch.id)}/start`, { body: {} });
    setBusy(false);
    if (!answer.ok || !answer.body?.batch) {
      setError(errorText(answer, 'The signatures could not be started. Nothing was sent.'));
      return;
    }
    onMade({ batch: answer.body.batch, signing: answer.body.signingRequest ?? null, approved: made.approved ?? approvedFromBatch(answer.body.batch) });
  }

  const batch = made?.batch ?? null;
  const count = batch?.rowCount ?? review?.okCount ?? 0;
  const sent = batch?.totalMinor ?? review?.totalMinor ?? '0';
  const fees = batch?.feeMinor ?? review?.feeMinor ?? '0';
  const feesOn = review?.feesOn ?? BigInt(fees) > 0n;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-extrabold text-[#0c3e48]">Approve the batch</h2>
        <p className="mt-1 text-sm leading-6 text-[#326273]">One approval covers every payment. The batch is one Sui transaction: all the payments are made, or none.</p>
      </div>

      <dl className="grid gap-3 rounded-2xl border border-[#326273]/15 bg-white p-4 text-sm sm:grid-cols-2">
        <Line label="Payments" value={String(count)} />
        <Line label="Sent to recipients" value={usdc(sent)} />
        <Line label="Splash fees, at most" value={feesOn ? usdc(fees) : 'None charged yet'} />
        <Line label="Most that leaves your wallet" value={usdc(BigInt(sent) + BigInt(feesOn ? fees : '0'))} strong />
      </dl>
      {!feesOn ? <p className="text-[13px] text-[#326273]">{FEES_OFF_NOTICE}</p> : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-[#0d6370]/30 bg-[#f4f8fa] p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-[#0c3e48]"><Fingerprint className="h-4 w-4" aria-hidden="true" />Sign once, as owners</p>
          <p className="mt-1.5 text-sm leading-6 text-[#1F4452]">Your owners sign the whole batch with their passkeys, each on their own device. Each sees every payment, decoded from the transaction itself, before signing. Splash holds no key to your wallet.</p>
        </div>
        <div className="rounded-2xl border border-[#326273]/15 bg-white p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-[#0c3e48]"><CalendarClock className="h-4 w-4" aria-hidden="true" />Run later</p>
          <p className="mt-1.5 text-sm leading-6 text-[#1F4452]">Scheduled batches under a spending rule are not switched on for your business yet. Today a batch is signed and sent when your owners approve it.</p>
        </div>
      </div>

      {!batch ? (
        <>
          {!mayPrepare ? <p role="alert" className="text-sm font-medium text-[var(--error)]">Viewers can look at batches but cannot make them.</p> : null}
          {mayPrepare && !isOwner ? (
            <p className="flex items-start gap-2 rounded-xl bg-[#F6F0ED] p-3 text-sm text-[#1F4452]"><UsersRound className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />You can prepare this batch. An owner then starts the signatures, and nothing is paid until the owners sign.</p>
          ) : null}
          {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}
          <div className="flex flex-wrap justify-between gap-2 border-t border-[#326273]/10 pt-4">
            <QuietButton type="button" onClick={back}>Back to the rows</QuietButton>
            <PrimaryButton type="button" disabled={busy || !mayPrepare || !review?.ready} onClick={() => void create()}>
              {busy ? 'Working…' : isOwner ? 'Start the signatures' : 'Prepare for the owners'}
            </PrimaryButton>
          </div>
        </>
      ) : batch.status === 'prepared' ? (
        <div className="space-y-3">
          <p role="status" className="rounded-xl border border-[var(--ok)] bg-[var(--ok-bg)] p-3 text-sm font-semibold text-[#1F4452]">
            {isOwner ? 'This batch is ready. Start the signatures when you are ready to pay it.' : 'The batch is prepared. The owners have been told, and nothing is paid until an owner starts the signatures and the owners sign.'}
          </p>
          {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            {isOwner ? <PrimaryButton type="button" disabled={busy} onClick={() => void start()}>{busy ? 'Working…' : 'Start the signatures'}</PrimaryButton> : null}
            <QuietButton type="button" onClick={onRestart}>Make another batch</QuietButton>
          </div>
        </div>
      ) : made?.signing ? (
        <SignPanel initial={made.signing} expectedBatch={made.approved ?? approvedFromBatch(batch)} labels={BATCH_LABELS} onExecuted={onExecuted} onRestart={onRestart} />
      ) : (
        <p role="status" className="text-sm text-[#1F4452]">Loading the batch…</p>
      )}
    </div>
  );
}

function Line({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[#326273]">{label}</dt>
      <dd className={`tabular-nums text-[#0c3e48] ${strong ? 'text-base font-extrabold' : 'font-bold'}`}>{value}</dd>
    </div>
  );
}

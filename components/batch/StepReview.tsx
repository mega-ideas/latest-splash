'use client';

import { cloneElement, type ReactElement } from 'react';
import { Check, CircleAlert, Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';

import { BATCH_MAX_PAYMENTS, type SheetRow } from '@/lib/batch/sheet';
import { FEES_OFF_NOTICE, formatUsdc } from '@/lib/fees/copy';
import { PrimaryButton, QuietButton } from '../transfer/ui';
import type { BatchReview, RowReview } from './api';

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;

/** What a cleared row says about its recipient, in words: where it is paid, and why it may be. */
function verification(row: RowReview): string {
  if (!row.payee) return '';
  return row.payee.kind === 'splash_business'
    ? 'A business on Splash, screened clear'
    : 'A wallet you saved and approved, screened clear';
}

/**
 * Step 2 of a batch (v2 brief 5.6): every row on its own. The server has
 * matched each to a recipient the business saved, screened it and priced it
 * from the published schedule; a row that cannot be paid says why, in words,
 * and can be fixed or removed here. Nothing goes on until every row is cleared:
 * the batch is signed once.
 */
export default function StepReview({
  rows,
  review,
  stale,
  checking,
  error,
  onEdit,
  onRemove,
  onAdd,
  onCheck,
  onRemoveProblems,
  confirmed,
  onConfirm,
  back,
  next,
}: {
  rows: SheetRow[];
  review: BatchReview | null;
  stale: boolean;
  checking: boolean;
  error: string | null;
  onEdit: (index: number, change: Partial<Pick<SheetRow, 'recipient' | 'amount' | 'reference'>>) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  onCheck: () => void;
  onRemoveProblems: () => void;
  /** What the person has confirmed for THESE rows; any edit clears it. */
  confirmed: { duplicates: boolean; newPayees: boolean };
  onConfirm: (change: Partial<{ duplicates: boolean; newPayees: boolean }>) => void;
  back: () => void;
  next: () => void;
}) {
  const byLine = new Map((review?.rows ?? []).map((r) => [r.line, r]));
  const duplicates = review?.duplicateCount ?? 0;
  const newPayees = review?.newPayeeCount ?? 0;
  const ready = Boolean(review?.ready) && !stale && !checking && (duplicates === 0 || confirmed.duplicates) && (newPayees === 0 || confirmed.newPayees);
  const shortBy = review?.balance.state === 'ok' ? BigInt(review.balance.shortByMinor) : 0n;
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-extrabold text-[#0c3e48]">Review the rows</h2>
        <p className="mt-1 text-sm leading-6 text-[#326273]">Each row is checked on its own: the recipient you saved, the screening, and the fee. Fix or remove any row marked as needing attention. A batch is approved once, so every row must be cleared.</p>
      </div>

      {review ? (
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Rows cleared" value={`${review.okCount} of ${rows.length}`} tone={review.errorCount === 0 ? 'ok' : 'plain'} />
          <Stat label="Need attention" value={String(review.errorCount)} tone={review.errorCount > 0 ? 'warn' : 'plain'} />
          <Stat label="Sent to recipients" value={usdc(review.totalMinor)} tone="plain" />
          <Stat label="Splash fees" value={review.feesOn ? usdc(review.feeMinor) : 'None yet'} tone="plain" />
        </dl>
      ) : null}
      {review && !review.feesOn ? <p className="text-[13px] text-[#326273]">{FEES_OFF_NOTICE}</p> : null}
      {review?.balance.state === 'ok' && shortBy > 0n ? (
        <p role="alert" className="rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] px-3 py-2.5 text-sm font-semibold text-[var(--warn-ink)]">
          Your Splash Wallet holds {usdc(review.balance.usdcMinor)}, which is {usdc(shortBy.toString())} short of the batch and its fees{review.balance.heldMinor !== '0' ? `, with ${usdc(review.balance.heldMinor)} already held for batches out for signatures` : ''}. Add funds, or remove rows.
        </p>
      ) : null}
      {review?.balance.state === 'unknown' ? <p className="text-[13px] text-[#326273]">Your wallet balance could not be read just now, so a shortfall is not shown here.</p> : null}
      {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}

      <div aria-hidden="true" className="hidden gap-3 px-[15px] font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#1F4452] md:grid md:grid-cols-[2rem_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto]">
        <span />
        <span>Recipient</span>
        <span className="text-right">Amount (USDC)</span>
        <span>Reference</span>
        <span className="w-11" />
      </div>
      <ol className="space-y-3" aria-label="Rows of the batch">
        {rows.map((row, i) => {
          const result = byLine.get(row.line);
          const bad = result && !result.ok;
          return (
            <li key={row.line} className={`rounded-2xl border bg-white p-3.5 ${bad ? 'border-[var(--error)]' : 'border-[#326273]/15'}`}>
              <div className="grid gap-3 md:grid-cols-[2rem_minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_auto] md:items-end">
                <span className="hidden h-11 w-8 items-center font-mono text-sm font-bold text-[#326273] md:flex" aria-hidden="true">{i + 1}</span>
                <Cell label={`Recipient, row ${i + 1}`} visibleLabel="Recipient">
                  <input value={row.recipient} onChange={(e) => onEdit(i, { recipient: e.target.value })} className={CELL} autoComplete="off" spellCheck={false} />
                </Cell>
                <Cell label={`Amount in USDC, row ${i + 1}`} visibleLabel="Amount (USDC)">
                  <input value={row.amount} onChange={(e) => onEdit(i, { amount: e.target.value })} inputMode="decimal" className={`${CELL} text-right font-mono`} autoComplete="off" />
                </Cell>
                <Cell label={`Reference, row ${i + 1}`} visibleLabel="Reference">
                  <input value={row.reference} onChange={(e) => onEdit(i, { reference: e.target.value })} className={CELL} autoComplete="off" />
                </Cell>
                <QuietButton type="button" onClick={() => onRemove(i)} aria-label={`Remove row ${i + 1}`} className="w-full md:w-11 md:px-0">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span className="md:sr-only">Remove</span>
                </QuietButton>
              </div>
              {result ? (
                result.ok && result.payee ? (
                  <>
                    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-[var(--ok-bg)] px-3 py-2 text-[13px] text-[#1F4452]">
                      <span className="inline-flex items-center gap-1.5 font-bold text-[#145d6a]"><Check className="h-3.5 w-3.5" aria-hidden="true" />Cleared</span>
                      <span className="font-semibold">{result.payee.name}</span>
                      <span className="font-mono">{result.payee.masked}</span>
                      <span className="inline-flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />{verification(result)}</span>
                      <span className="font-mono">{result.feeMinor && review?.feesOn ? `Splash fee ${usdc(result.feeMinor)}` : ''}</span>
                    </div>
                    {result.newPayee ? (
                      <p className="mt-2 rounded-lg border border-[var(--warn)] bg-[var(--warn-bg)] px-3 py-2 text-[13px] leading-5 text-[var(--warn-ink)]">
                        <span className="font-bold">A new payee, found by name.</span> Nobody on your team has saved {result.payee.name}. Check it is the business you mean: <span className="break-all font-mono">{result.payee.address}</span>
                        {result.payee.country ? `, ${result.payee.country}` : ''}.
                      </p>
                    ) : null}
                    {result.duplicateOf ? (
                      <p className="mt-2 rounded-lg border border-[var(--warn)] bg-[var(--warn-bg)] px-3 py-2 text-[13px] leading-5 text-[var(--warn-ink)]">
                        <span className="font-bold">Already in another batch.</span> The same recipient, amount and reference are in a batch you made in the last 30 days that has not failed or lapsed.
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p role="alert" className="mt-2.5 flex items-start gap-2 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-[13px] font-medium text-[var(--error)]">
                    <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>{result.error}</span>
                  </p>
                )
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap gap-2">
        <QuietButton type="button" onClick={onAdd} disabled={rows.length >= BATCH_MAX_PAYMENTS}><Plus className="h-4 w-4" aria-hidden="true" />Add a row</QuietButton>
        <QuietButton type="button" onClick={onCheck} disabled={checking || rows.length === 0}><RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />{checking ? 'Checking…' : stale ? 'Check the rows' : 'Check again'}</QuietButton>
        {review && review.errorCount > 0 ? <QuietButton type="button" onClick={onRemoveProblems}>Remove the rows that need attention</QuietButton> : null}
      </div>
      {rows.length >= BATCH_MAX_PAYMENTS ? <p className="text-[13px] text-[#326273]">A batch holds at most {BATCH_MAX_PAYMENTS} payments. Split a longer sheet into smaller batches.</p> : null}
      {stale && review ? <p role="status" className="text-[13px] font-semibold text-[var(--warn-ink)]">You changed the rows. Check them again before you go on.</p> : null}

      {review && !stale && !checking && (duplicates > 0 || newPayees > 0) ? (
        <fieldset className="space-y-3 rounded-2xl border border-[var(--warn)] bg-[var(--warn-bg)] p-4">
          <legend className="px-1 text-sm font-bold text-[var(--warn-ink)]">Check before you continue</legend>
          {duplicates > 0 ? (
            <label className="flex min-h-11 items-start gap-3 text-sm leading-6 text-[#0c3e48]">
              <input type="checkbox" checked={confirmed.duplicates} onChange={(e) => onConfirm({ duplicates: e.target.checked })} className="mt-1 h-5 w-5 shrink-0 accent-[#0d6370]" />
              <span>{duplicates === 1 ? 'One payment here is already in' : `${duplicates} payments here are already in`} a batch you made. I mean to pay {duplicates === 1 ? 'it' : 'them'} again.</span>
            </label>
          ) : null}
          {newPayees > 0 ? (
            <label className="flex min-h-11 items-start gap-3 text-sm leading-6 text-[#0c3e48]">
              <input type="checkbox" checked={confirmed.newPayees} onChange={(e) => onConfirm({ newPayees: e.target.checked })} className="mt-1 h-5 w-5 shrink-0 accent-[#0d6370]" />
              <span>I have checked the name, address and country of {newPayees === 1 ? 'the business' : `the ${newPayees} businesses`} found by name, and {newPayees === 1 ? 'it is' : 'they are'} the ones I mean to pay.</span>
            </label>
          ) : null}
        </fieldset>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2 border-t border-[#326273]/10 pt-4">
        <QuietButton type="button" onClick={back}>Back</QuietButton>
        <PrimaryButton type="button" onClick={next} disabled={!ready || shortBy > 0n}>Continue to approval</PrimaryButton>
      </div>
    </div>
  );
}

const CELL = 'h-11 w-full rounded-xl border border-[#326273]/25 bg-white px-3 text-sm text-[#0c3e48] outline-none transition-colors placeholder:text-[#326273] focus:border-[#0d6370] focus:ring-2 focus:ring-[#0d6370]/20';

function Cell({ label, visibleLabel, children }: { label: string; visibleLabel: string; children: ReactElement<{ 'aria-label'?: string }> }) {
  return (
    <div className="min-w-0">
      <span className="text-[13px] font-semibold text-[#1F4452] md:hidden" aria-hidden="true">{visibleLabel}</span>
      <span className="mt-1 block md:mt-0">{cloneElement(children, { 'aria-label': label })}</span>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'warn' | 'plain' }) {
  return (
    <div className={`rounded-xl border p-3 ${tone === 'ok' ? 'border-[var(--ok)] bg-[var(--ok-bg)]' : tone === 'warn' ? 'border-[var(--warn)] bg-[var(--warn-bg)]' : 'border-[#326273]/15 bg-white'}`}>
      <dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#1F4452]">{label}</dt>
      <dd className="mt-1 text-lg font-extrabold tabular-nums text-[#0c3e48]">{value}</dd>
    </div>
  );
}

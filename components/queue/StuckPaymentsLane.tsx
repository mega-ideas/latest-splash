'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, CheckCircle2, CircleHelp, Loader2, XCircle } from 'lucide-react';

import { kindLabel } from '@/lib/queue/queue-decision';
import {
  findingText,
  interpretReconcileResponse,
  leavesLane,
  reconcilePath,
  reconcileRequestBody,
  recordsShowNotSent,
  type ReconcileOutcome,
  type ReconcileResult,
  type StuckPaymentItem,
} from '@/lib/queue/stuck-payment-view';

/**
 * Approved payments whose outcome nobody recorded (lib/queue/stuck-payments.ts).
 *
 * Each went to the payment route and no result came back: the process that
 * sent it stopped first. Until someone records what happened, the payment can
 * be neither requested again nor counted as paid. Each row says what the
 * records show. Where they settle it, one button closes it as not sent. Where
 * they cannot, the approver checks the payment itself and records which it was.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14:02 UTC on 25 Sep". The same on the server and in the browser, so the
 *  rendered page does not change under the reader's timezone. */
function utcTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'an unrecorded time';
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC on ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}

type Settled = { item: StuckPaymentItem; result: ReconcileResult };

function confirmation(item: StuckPaymentItem, outcome: ReconcileOutcome): string {
  if (outcome === 'SENT') {
    return `Record ${item.amountLabel} as sent?\n\n${item.recommendation}\n\nIt closes as carried out, and nothing more is sent.`;
  }
  if (recordsShowNotSent(item.evidence)) {
    return (
      `Close ${item.amountLabel} as not sent?\n\n${item.recommendation}\n\n` +
      'The records show nothing was sent. It can then be requested again, with new approvals.'
    );
  }
  return (
    `Record ${item.amountLabel} as not sent?\n\n${item.recommendation}\n\n` +
    'Only confirm after checking the payment itself. If it did go, requesting it again would pay it twice.'
  );
}

export default function StuckPaymentsLane({ items }: { items: StuckPaymentItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [references, setReferences] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, Settled>>({});

  // Recorded rows stay visible after the refresh drops them from `items`, so
  // the approver who answered sees what was recorded.
  const settled = Object.values(results).filter(
    ({ item, result }) => leavesLane(result) && !items.some((live) => live.id === item.id),
  );
  if (items.length === 0 && settled.length === 0) return null;

  async function record(item: StuckPaymentItem, outcome: ReconcileOutcome) {
    if (!window.confirm(confirmation(item, outcome))) return;

    setBusy(item.id);
    let result: ReconcileResult;
    try {
      const response = await fetch(reconcilePath(item.id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reconcileRequestBody(outcome, references[item.id])),
      });
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      result = interpretReconcileResponse(response.status, body, outcome);
    } catch {
      result = interpretReconcileResponse(0, null, outcome);
    } finally {
      setBusy(null);
    }
    setResults((current) => ({ ...current, [item.id]: { item, result } }));
    if (leavesLane(result)) router.refresh();
  }

  const count = items.length;

  return (
    <section aria-labelledby="stuck-payments-title" className="overflow-hidden rounded-lg border border-[var(--warn)]/45 bg-white/85">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#326273]/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <CircleHelp className="h-4 w-4 text-[var(--warn)]" aria-hidden="true" />
          <h2 id="stuck-payments-title" className="text-sm font-bold text-[#1F4452]">
            Outcome unknown
          </h2>
          {count > 0 && (
            <span className="rounded-md border border-[var(--warn)]/50 bg-[var(--warn-bg)] px-2 py-0.5 text-[12px] font-bold tabular-nums text-[#1F4452]">
              {count} {count === 1 ? 'payment' : 'payments'}
            </span>
          )}
        </div>
        <p className="text-[13px] font-medium text-[#326273]/90">
          Approved and sent for payment, but no result came back. Record what happened.
        </p>
      </div>

      <div aria-live="polite" className="divide-y divide-[#326273]/10">
        {items.map((item) => {
          const outcome = results[item.id]?.result;
          const working = busy === item.id;
          const locked = item.blockedReason !== null || busy !== null;
          const settledByRecords = recordsShowNotSent(item.evidence);
          const noteId = `${item.id}-finding`;
          return (
            <div key={item.id} className="flex flex-col gap-3 px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1">
                <div className="min-w-0">
                  <strong className="block text-sm text-[#1F4452]">{item.recommendation}</strong>
                  <p className="mt-1 text-[13px] font-medium text-[#326273]/90">
                    {item.id} · {kindLabel(item.kind)} · {item.waitingLabel}
                  </p>
                </div>
                <span className="money text-sm font-medium text-[#1F4452]">{item.amountLabel}</span>
              </div>

              <div id={noteId} className="rounded-md border-l-4 border-[var(--warn)] bg-[var(--warn-bg)] px-3 py-2">
                <p className="text-[12px] font-bold text-[#1F4452]">What the records show</p>
                <p className="mt-0.5 text-[13px] font-medium leading-relaxed text-[#1F4452]">
                  {findingText(item.evidence, utcTime)}
                  {item.checkHint && (
                    <>
                      {' '}
                      <Link
                        href={item.checkHint.href}
                        className="inline-flex items-center gap-0.5 font-bold text-[#1F4452] underline underline-offset-2 hover:text-[#326273] focus-ring"
                      >
                        {item.checkHint.label}
                        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                      </Link>
                    </>
                  )}
                </p>
              </div>

              <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-end">
                {item.outcomes.includes('SENT') && (
                  <label className="flex flex-col gap-1 text-[12px] font-bold text-[#326273]/90 md:mr-auto">
                    Reference, if it was sent (optional)
                    <input
                      type="text"
                      inputMode="text"
                      autoComplete="off"
                      maxLength={120}
                      value={references[item.id] ?? ''}
                      onChange={(event) => {
                        const value = event.target.value;
                        setReferences((current) => ({ ...current, [item.id]: value }));
                      }}
                      disabled={locked}
                      placeholder="Transfer or run ID"
                      className="h-11 w-full rounded-md border border-[#326273]/70 bg-white px-3 text-[13px] font-medium text-[#1F4452] placeholder:text-[#326273]/90 focus-ring disabled:opacity-45 md:w-60"
                    />
                  </label>
                )}

                {settledByRecords ? (
                  <button
                    type="button"
                    onClick={() => void record(item, 'NOT_SENT')}
                    disabled={locked}
                    aria-describedby={[noteId, item.blockedReason ? `${item.id}-blocked` : null].filter(Boolean).join(' ')}
                    className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md bg-[#1F4452] px-4 text-[13px] font-bold text-white transition hover:bg-[#326273] focus-ring disabled:cursor-not-allowed disabled:opacity-45 md:w-auto"
                  >
                    {working && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                    Close as not sent
                  </button>
                ) : (
                  item.outcomes.map((choice) => (
                    <button
                      key={choice}
                      type="button"
                      onClick={() => void record(item, choice)}
                      disabled={locked}
                      aria-describedby={[noteId, item.blockedReason ? `${item.id}-blocked` : null].filter(Boolean).join(' ')}
                      className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md border border-[#326273]/30 bg-white px-4 text-[13px] font-bold text-[#1F4452] transition hover:border-[#326273]/60 hover:bg-[#326273]/[0.04] focus-ring disabled:cursor-not-allowed disabled:opacity-45 md:w-auto"
                    >
                      {working && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                      {choice === 'SENT' ? 'It was sent' : "It wasn't sent"}
                    </button>
                  ))
                )}
              </div>

              {item.blockedReason && (
                <p id={`${item.id}-blocked`} className="text-[12px] font-semibold text-[#326273]/90 md:text-right">
                  {item.blockedReason}
                </p>
              )}
              {outcome && !leavesLane(outcome) && (
                <p role="alert" className="text-[12px] font-semibold text-[var(--error)] md:text-right">
                  {outcome.message}
                </p>
              )}
            </div>
          );
        })}

        {settled.map(({ item, result }) => (
          <div key={`recorded-${item.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <strong className="block truncate text-sm text-[#1F4452]">{item.recommendation}</strong>
              <p className="mt-0.5 truncate text-[13px] font-medium text-[#326273]/90">
                {item.id} · {item.amountLabel}
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] font-medium ${
                result.kind === 'recorded' && result.outcome === 'SENT'
                  ? 'border-[var(--ok)] bg-[var(--ok-bg)] text-[#1F4452]'
                  : 'border-[#326273]/25 bg-white text-[#1F4452]'
              }`}
            >
              {/* Ink, not --ok, for the words: --ok on --ok-bg is 4.25:1, under
                  4.5:1 at this size. The icon keeps the colour (3:1 is enough
                  for it), and the words say what was recorded. */}
              {result.kind === 'recorded' && result.outcome === 'SENT' ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-[var(--ok)]" aria-hidden="true" />
              ) : (
                <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              {result.message}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

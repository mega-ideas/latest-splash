'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Loader2, Send, XCircle } from 'lucide-react';

/**
 * Payments every approver has agreed to that nobody has sent yet.
 *
 * A WhatsApp reply records a vote and never sends money, so a vote that
 * finishes on WhatsApp waits here for a signed-in approver
 * (lib/queue/ready-to-send.ts). Before this lane the queue listed only
 * proposals still collecting approvals, and a fully approved payment
 * disappeared.
 *
 * Send posts to the submit route, which evaluates policy, expiry and
 * compliance again, refuses the maker and anyone without an approving role,
 * and replays the real payment route with every guard. The approval hash sent
 * with it ties the click to the payment as shown here: if the proposal
 * changed since this page rendered, the server refuses it.
 */

export type ReadyToSendItem = {
  id: string;
  recommendation: string;
  kind: string;
  amountLabel: string;
  approvalsLabel: string;
  expiryLabel: string;
  approvalHash: string | null;
  /** Why this viewer cannot send it, or null when they can. The server decides either way. */
  blockedReason: string | null;
};

type Execution = { state?: 'EXECUTED' | 'FAILED' | 'SKIPPED'; detail?: string };
type SubmitAnswer = { error?: string; execution?: Execution };
type Outcome = { item: ReadyToSendItem; sent: boolean; message: string };

function describe(status: number, body: SubmitAnswer | null): { sent: boolean; message: string } {
  if (status >= 200 && status < 300 && body?.execution) {
    const { state, detail } = body.execution;
    if (state === 'EXECUTED') return { sent: true, message: detail ?? 'Payment sent.' };
    return { sent: false, message: detail ? `Not sent: ${detail}` : 'Not sent.' };
  }
  if (status === 401) return { sent: false, message: 'Your session has ended. Sign in again to send it.' };
  return { sent: false, message: body?.error ?? `Splash refused to send it (HTTP ${status}). Nothing moved.` };
}

export default function ReadyToSendLane({ items }: { items: ReadyToSendItem[] }) {
  const router = useRouter();
  const [sending, setSending] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});

  // Sent (or refused) rows stay visible here after the refresh drops them
  // from `items`, so the person who pressed Send sees what happened.
  const settled = Object.values(outcomes).filter((outcome) => !items.some((item) => item.id === outcome.item.id));
  if (items.length === 0 && settled.length === 0) return null;

  async function send(item: ReadyToSendItem) {
    const go = window.confirm(
      `Send ${item.amountLabel} now?\n\n${item.recommendation}\n\nEvery check runs again before any money moves.`,
    );
    if (!go) return;

    setSending(item.id);
    try {
      const response = await fetch(`/api/proposals/${encodeURIComponent(item.id)}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signatureRef: `sig_queue_${item.id}`,
          ...(item.approvalHash ? { approvalHash: item.approvalHash } : {}),
        }),
      });
      const body = (await response.json().catch(() => null)) as SubmitAnswer | null;
      setOutcomes((current) => ({ ...current, [item.id]: { item, ...describe(response.status, body) } }));
      router.refresh();
    } catch {
      setOutcomes((current) => ({
        ...current,
        [item.id]: {
          item,
          sent: false,
          message: 'The connection dropped before Splash answered. Check this payment before trying again.',
        },
      }));
    } finally {
      setSending(null);
    }
  }

  return (
    <section aria-labelledby="ready-to-send-title" className="overflow-hidden rounded-lg border border-[var(--ok)]/45 bg-white/85">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#326273]/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4 text-[var(--ok)]" aria-hidden="true" />
          <h2 id="ready-to-send-title" className="text-sm font-bold text-[#1F4452]">
            Approved, ready to send
          </h2>
        </div>
        <p className="text-[13px] font-medium text-[#326273]/60">
          Every approver agreed. A signed-in approver sends it; a WhatsApp reply cannot.
        </p>
      </div>

      <div aria-live="polite" className="divide-y divide-[#326273]/10">
        {items.map((item) => {
          const outcome = outcomes[item.id];
          const busy = sending === item.id;
          return (
            <div key={item.id} className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-[1.4fr_0.7fr_0.7fr_1fr] md:items-center">
              <div className="min-w-0">
                <strong className="block truncate text-sm text-[#1F4452]">{item.recommendation}</strong>
                <p className="mt-1 truncate text-[13px] font-medium text-[#326273]/65">
                  {item.id} · {item.kind} · {item.approvalsLabel}
                </p>
              </div>
              <span className="money text-sm font-medium text-[#1F4452]">{item.amountLabel}</span>
              <span className="text-[13px] font-bold tabular-nums text-[#326273]/65">{item.expiryLabel}</span>
              <div className="flex flex-col gap-1.5 md:items-end">
                <button
                  type="button"
                  onClick={() => void send(item)}
                  disabled={item.blockedReason !== null || sending !== null}
                  aria-describedby={item.blockedReason ? `${item.id}-blocked` : undefined}
                  className="inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-md bg-[#1F4452] px-4 text-[13px] font-bold text-white transition hover:bg-[#326273] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/30 disabled:cursor-not-allowed disabled:opacity-45 md:w-auto"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                  Send payment
                </button>
                {item.blockedReason && (
                  <p id={`${item.id}-blocked`} className="text-[12px] font-semibold text-[#326273]/60 md:text-right">
                    {item.blockedReason}
                  </p>
                )}
                {outcome && !outcome.sent && (
                  <p className="text-[12px] font-semibold text-[var(--error)] md:text-right">{outcome.message}</p>
                )}
              </div>
            </div>
          );
        })}

        {settled.map((outcome) => (
          <div key={`sent-${outcome.item.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="min-w-0">
              <strong className="block truncate text-sm text-[#1F4452]">{outcome.item.recommendation}</strong>
              <p className="mt-0.5 truncate text-[13px] font-medium text-[#326273]/60">
                {outcome.item.id} · {outcome.item.amountLabel}
              </p>
            </div>
            <span
              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] font-medium ${
                outcome.sent
                  ? 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok)]'
                  : 'border-[var(--error)] bg-[var(--error-bg)] text-[var(--error)]'
              }`}
            >
              {outcome.sent ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <XCircle className="h-3.5 w-3.5" aria-hidden="true" />}
              {outcome.message}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

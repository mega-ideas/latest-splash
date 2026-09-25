'use client';

import { useId, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, KeyRound, Loader2, XCircle } from 'lucide-react';

/**
 * Where an approver types the code WhatsApp sent them.
 *
 * `code` is the default approval channel, and its message says "Enter it in
 * Splash to approve". Nothing in the product posted to /api/approvals/code, so
 * there was nowhere to enter it, and the default channel could not approve
 * anything.
 *
 * The code travels in the request body and never in a URL: a URL lands in
 * history, logs and referrers, and this is a secret for thirty minutes.
 *
 * Every decision is the server's: whose code it is, whether their role may
 * approve in the payment's workspace, whether the vote is complete, whether
 * the payment goes. This card shows what the server said.
 */

type Tally = { total: number; approved: number; rejected: number; unanimous: boolean; refused: boolean };

type CodeAnswer = {
  ok?: boolean;
  settled?: boolean;
  /** Present when this answer completed the vote (lib/server/approval-settle.ts). */
  stage?: string;
  message?: string;
  error?: string;
  tally?: Tally;
};

/** A completed vote that did not send the payment: someone has to look. */
const NEEDS_ATTENTION = new Set(['BLOCKED', 'NOT_SENT', 'AWAITING_RELEASE', 'CLOSED', 'ERROR']);

type Result = { tone: 'sent' | 'recorded' | 'stopped' | 'refused'; message: string; tally?: Tally };

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const capital = trimmed[0].toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

function refusal(status: number, body: CodeAnswer | null): string {
  if (status === 401) return 'Your session has ended. Sign in again, then enter the code.';
  if (body?.error) return sentence(body.error);
  return 'Splash could not record that answer. Nothing was approved.';
}

/** Every approver must agree, so the vote is drawn as one mark per ballot. */
function TallyMarks({ tally }: { tally: Tally }) {
  const label = tally.refused
    ? 'Stopped: an approver rejected it.'
    : `${tally.approved} of ${tally.total} ${tally.total === 1 ? 'approver has' : 'approvers have'} approved.`;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span aria-hidden="true" className="flex gap-1">
        {Array.from({ length: tally.total }, (_, index) => {
          const tone = tally.refused
            ? index < tally.approved
              ? 'bg-[#326273]/35'
              : index < tally.approved + tally.rejected
                ? 'bg-[var(--error)]'
                : 'bg-[#326273]/12'
            : index < tally.approved
              ? 'bg-[var(--ok)]'
              : 'bg-[#326273]/15';
          return <span key={index} className={`h-2 w-6 rounded-full ${tone}`} />;
        })}
      </span>
      <span className="text-[13px] font-semibold text-[#326273]">{label}</span>
    </div>
  );
}

export default function ApprovalCodeCard() {
  const router = useRouter();
  const inputId = useId();
  const helpId = useId();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'APPROVE' | 'REJECT' | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const digits = code.replace(/\s+/g, '');
  const canAnswer = digits.length >= 4 && busy === null;

  async function answer(decision: 'APPROVE' | 'REJECT') {
    if (!canAnswer) return;
    if (
      decision === 'REJECT' &&
      !window.confirm('Reject this payment? One rejection stops it for every approver, and it cannot be undone.')
    ) {
      return;
    }

    setBusy(decision);
    setResult(null);
    try {
      const response = await fetch('/api/approvals/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: digits, decision }),
      });
      const body = (await response.json().catch(() => null)) as CodeAnswer | null;
      if (!response.ok || !body?.ok) {
        setResult({ tone: 'refused', message: refusal(response.status, body) });
        return;
      }

      // A used code is spent; leaving it in the field invites a second try.
      setCode('');
      setResult({
        tone: body.settled
          ? 'sent'
          : body.tally?.refused || (body.stage && NEEDS_ATTENTION.has(body.stage))
            ? 'stopped'
            : 'recorded',
        message: body.message ?? 'Recorded.',
        tally: body.tally,
      });
      // The vote may have moved a payment into "Ready to send", or out of it.
      router.refresh();
    } catch {
      setResult({
        tone: 'refused',
        message: 'The connection dropped before Splash answered. Check the queue before trying again.',
      });
    } finally {
      setBusy(null);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void answer('APPROVE');
  }

  // Ink words on every tone, as `recorded` and `stopped` already were; the
  // border and tint carry the state. --ok on --ok-bg is 4.25:1, under 4.5:1.
  const resultTone: Record<Result['tone'], string> = {
    sent: 'border-[var(--ok)] bg-[var(--ok-bg)] text-[#1F4452]',
    recorded: 'border-[#326273]/16 bg-[#F6F0ED] text-[#1F4452]',
    stopped: 'border-[var(--warn)] bg-[var(--warn-bg)] text-[#1F4452]',
    refused: 'border-[var(--error)] bg-[var(--error-bg)] text-[#1F4452]',
  };

  return (
    <section aria-labelledby={`${inputId}-title`} className="rounded-lg border border-[#326273]/16 bg-white/80 p-4 md:p-5">
      <form onSubmit={onSubmit} className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 md:max-w-md">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-[var(--info)]" aria-hidden="true" />
            <h2 id={`${inputId}-title`} className="text-sm font-bold text-[#1F4452]">
              Approve with a code
            </h2>
          </div>
          <p id={helpId} className="mt-1 text-[13px] font-medium leading-5 text-[#326273]/90">
            For a payment someone asked you to approve: enter the code from that WhatsApp message. It works once,
            only for you, for 30 minutes.
          </p>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label htmlFor={inputId} className="flex flex-col gap-1">
            <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-[#326273]/90">
              Approval code
            </span>
            <input
              id={inputId}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-describedby={helpId}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={12}
              placeholder="000000"
              disabled={busy !== null}
              className="h-11 w-full rounded-md border border-[#326273]/70 bg-white px-3 font-mono text-lg tracking-[0.3em] text-[#1F4452] tabular-nums outline-none transition placeholder:text-[#326273]/90 focus:border-[#5C9EAD] focus-ring disabled:opacity-60 sm:w-44"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={!canAnswer}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md bg-[#1F4452] px-4 text-[13px] font-bold text-white transition hover:bg-[#326273] focus-ring disabled:cursor-not-allowed disabled:opacity-45 sm:flex-none"
            >
              {busy === 'APPROVE' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              )}
              Approve
            </button>
            <button
              type="button"
              onClick={() => void answer('REJECT')}
              disabled={!canAnswer}
              className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-md border border-[var(--error)] px-4 text-[13px] font-bold text-[var(--error)] transition hover:bg-[var(--error-bg)] focus-ring disabled:cursor-not-allowed disabled:opacity-45 sm:flex-none"
            >
              {busy === 'REJECT' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <XCircle className="h-4 w-4" aria-hidden="true" />
              )}
              Reject
            </button>
          </div>
        </div>
      </form>

      <div aria-live="polite">
        {result && (
          <div className={`mt-4 rounded-md border px-3 py-2.5 ${resultTone[result.tone]}`}>
            <p className="text-[13px] font-bold leading-5">{result.message}</p>
            {result.tally && result.tally.total > 0 && <TallyMarks tally={result.tally} />}
          </div>
        )}
      </div>
    </section>
  );
}

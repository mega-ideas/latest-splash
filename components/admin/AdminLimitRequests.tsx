'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, CircleAlert, Clock3, Inbox, Loader2, RefreshCcw, XCircle } from 'lucide-react';

import { DECLINE_REASON_MIN, REASON_MAX } from '@/lib/limits/rules';
import { stampWords } from '@/lib/schedule/rules';
import type { StaffRequestWire } from '@/lib/server/business-limits';

type Queue = { open: StaffRequestWire[]; recent: StaffRequestWire[] };
type Choice = 'approve' | 'approve_smaller' | 'decline';

/**
 * Owners' requests for higher limits on automatic payments, for compliance and
 * operations staff. An approval does not change the limit: it starts a 24 hour
 * notice, the owners are told, and any owner can cancel before it starts. The
 * page says that where the decision is made, and names the ceiling in code that
 * no approval can pass. Every decision is written to the business's trail under
 * the staff member's address.
 */
export default function AdminLimitRequests({ initial, allowed, problem }: { initial: Queue; allowed: boolean; problem: string | null }) {
  const [queue, setQueue] = useState(initial);
  const [error, setError] = useState<string | null>(problem);

  // A refresh that fails is said, never swallowed: the queue on screen would otherwise look current when it is not.
  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/limits', { cache: 'no-store' });
      if (!response.ok) throw new Error('refresh failed');
      setQueue((await response.json()) as Queue);
      setError(null);
    } catch {
      setError('The list could not be refreshed, so what is on screen may be out of date. Choose Refresh to try again.');
    }
  }, []);

  useEffect(() => {
    if (!allowed) return;
    const interval = window.setInterval(() => { void refresh(); }, 30_000);
    return () => window.clearInterval(interval);
  }, [allowed, refresh]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-black tracking-tight text-[#1F4452]">Limit requests</h1>
          <p className="mt-1 text-sm leading-6 text-[#1F4452]">
            Owners asking for a higher limit on automatic payments. An approval starts a 24 hour notice: the owners are told, any owner can cancel, and the limit changes only when the notice has passed.
          </p>
        </div>
        {allowed ? (
          <button
            type="button"
            onClick={() => void refresh()}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-[#326273]/25 bg-white px-3 text-xs font-bold text-[#1F4452] hover:bg-[#F6F0ED] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
          >
            <RefreshCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </button>
        ) : null}
      </header>

      {error ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] px-4 py-3 text-sm font-semibold text-[var(--error)]">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {!allowed ? (
        <div className="rounded-2xl border border-[#326273]/20 bg-white px-6 py-8">
          <p className="text-sm font-bold text-[#1F4452]">This page is for compliance and operations staff.</p>
          <p className="mt-1 text-sm text-[#1F4452]">Limit requests are a risk decision, so support staff do not see them or decide them.</p>
        </div>
      ) : queue.open.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#326273]/30 bg-white px-6 py-10 text-center">
          <Inbox className="mx-auto h-8 w-8 text-[#237284]" aria-hidden="true" />
          <p className="mt-3 text-sm font-bold text-[#1F4452]">No requests waiting</p>
          <p className="mt-1 text-sm text-[#1F4452]">When an owner asks for a higher limit it appears here, oldest first.</p>
        </div>
      ) : (
        <ul className="space-y-4" aria-label="Requests waiting for a decision">
          {queue.open.map((request) => (
            <li key={request.id}>
              <RequestCard request={request} onDecided={refresh} onError={setError} />
            </li>
          ))}
        </ul>
      )}

      {allowed && queue.recent.length > 0 ? (
        <section aria-labelledby="recent-limits">
          <h2 id="recent-limits" className="text-sm font-black text-[#1F4452]">Decided lately</h2>
          <ul className="mt-2 space-y-2">
            {queue.recent.map((request) => (
              <li key={request.id} className="space-y-1 rounded-lg bg-white px-4 py-3 text-[13px] text-[#1F4452]">
                <div className="flex flex-wrap items-center gap-2">
                  <Outcome request={request} />
                  <span className="font-bold">{request.org.name}</span>
                </div>
                <p>{request.label}: {request.requestedWords} asked{request.grantedWords ? `, ${request.grantedWords} approved` : ''}</p>
                <p className="text-[#326273]">{request.decidedBy ? `Decided by ${request.decidedBy.replace('operator:', '')}` : 'Cancelled by the owner'}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function Outcome({ request }: { request: StaffRequestWire }) {
  const map: Record<StaffRequestWire['phase'], [string, string, typeof BadgeCheck]> = {
    asked: ['bg-[var(--gold-tint)] text-[var(--gold-ink)]', 'Waiting', Clock3],
    waiting: ['bg-[var(--info-bg)] text-[var(--ink)]', 'Approved, notice running', BadgeCheck],
    in_force: ['bg-[var(--info-bg)] text-[var(--ink)]', 'In force', BadgeCheck],
    declined: ['bg-[var(--error-bg)] text-[var(--error)]', 'Declined', XCircle],
    cancelled: ['bg-[var(--pending-bg)] text-[var(--ink)]', 'Cancelled by the owner', XCircle],
  };
  const [cls, label, Icon] = map[request.phase];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-bold ${cls}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

function RequestCard({ request, onDecided, onError }: { request: StaffRequestWire; onDecided: () => Promise<void>; onError: (message: string | null) => void }) {
  const [choice, setChoice] = useState<Choice>('approve');
  const [smaller, setSmaller] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [here, setHere] = useState<string | null>(null);
  // Once the decision is saved the card is closed: a second click on a card that is still on screen would only replay it.
  const [saved, setSaved] = useState<Choice | null>(null);
  const days = request.kind === 'days';
  const declineShort = choice === 'decline' && reason.replace(/\s+/g, ' ').trim().length < DECLINE_REASON_MIN;
  const smallerMissing = choice === 'approve_smaller' && smaller.trim() === '';

  async function send() {
    setBusy(true);
    setHere(null);
    onError(null);
    try {
      const response = await fetch(`/api/admin/limits/${request.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: choice, ...(choice === 'approve_smaller' ? { granted: smaller } : {}), ...(choice === 'decline' ? { reason } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setHere(body.error ?? 'The decision was not saved. Nothing was changed.');
        return;
      }
      setSaved(choice);
      await onDecided();
    } catch {
      setHere('Could not reach Splash. Nothing was changed.');
    } finally {
      setBusy(false);
    }
  }

  const options: Array<[Choice, string]> = [
    ['approve', 'Approve as asked'],
    ['approve_smaller', 'Approve a smaller figure'],
    ['decline', 'Decline'],
  ];

  return (
    <article className="overflow-hidden rounded-2xl border border-[#326273]/20 bg-white shadow-sm" aria-labelledby={`limit-${request.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#326273]/12 bg-[#F6F0ED] px-5 py-3">
        <div>
          <h3 id={`limit-${request.id}`} className="text-base font-black text-[#1F4452]">{request.org.name}</h3>
          <p className="text-[13px] text-[#1F4452]">Asked by {request.requestedBy}, {stampWords(Date.parse(request.requestedAt))}</p>
          <p className="text-[13px] text-[#326273]">{request.earlierRequests === 0 ? 'The first request from this business.' : `${request.earlierRequests} earlier ${request.earlierRequests === 1 ? 'request' : 'requests'} from this business.`}</p>
        </div>
        <Outcome request={request} />
      </div>

      <div className="space-y-4 px-5 py-4">
        <div>
          <p className="text-[13px] font-bold text-[#326273]">{request.label}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[#1F4452]">
            <span className="text-base tabular-nums">{request.currentWords}</span>
            <span aria-hidden="true">to</span>
            <span className="sr-only">is asked to be raised to</span>
            <span className="text-2xl font-black tabular-nums">{request.requestedWords}</span>
          </p>
          <p className="mt-1 text-[13px] text-[#326273]">The most Splash will ever grant for this is {request.ceilingWords}. A figure above it is refused.</p>
        </div>
        <blockquote className="border-l-4 border-[#5C9EAD] pl-4 text-sm leading-6 text-[#1F4452]">{request.reason}</blockquote>
      </div>

      {saved ? (
        <div role="status" className="flex items-start gap-2 border-t border-[#326273]/12 bg-[var(--info-bg)] px-5 py-4 text-[13px] font-semibold text-[#1F4452]">
          <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Decision saved. {saved === 'decline' ? 'The owners have been told it was declined and why.' : 'The owners will be told it is approved and when it starts.'} It leaves this list when it refreshes.</span>
        </div>
      ) : (
      <div className="space-y-3 border-t border-[#326273]/12 px-5 py-4">
        <div role="group" aria-label="Decision" className="flex flex-wrap gap-2">
          {options.map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={choice === value}
              onClick={() => setChoice(value)}
              className={`min-h-11 rounded-lg border px-3 text-[13px] font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${choice === value ? 'border-[#0d6370] bg-[#0d6370] text-white' : 'border-[#326273]/30 bg-white text-[#1F4452] hover:bg-[#F6F0ED]'}`}
            >
              {label}
            </button>
          ))}
        </div>

        {choice === 'approve' ? (
          <p className="text-[13px] leading-5 text-[#1F4452]">The limit stays {request.currentWords} for 24 hours. The owners are told it is approved and when it starts, and any of them can cancel it before then.</p>
        ) : null}

        {choice === 'approve_smaller' ? (
          <div>
            <label htmlFor={`smaller-${request.id}`} className="text-[13px] font-bold text-[#1F4452]">Figure to approve ({days ? 'days' : 'USDC'}), above {request.currentWords} and below {request.requestedWords}</label>
            <input
              id={`smaller-${request.id}`}
              value={smaller}
              onChange={(e) => setSmaller(e.target.value)}
              inputMode={days ? 'numeric' : 'decimal'}
              autoComplete="off"
              className="mt-1.5 h-11 w-full max-w-xs rounded-lg border border-[#326273]/40 bg-white px-3 text-sm tabular-nums text-[#1F4452] focus:border-[#0d6370] focus:outline-none focus:ring-2 focus:ring-[#0d6370]/25"
            />
          </div>
        ) : null}

        {choice === 'decline' ? (
          <div>
            <label htmlFor={`reason-${request.id}`} className="text-[13px] font-bold text-[#1F4452]">Why, in plain words (the owner reads this)</label>
            <textarea
              id={`reason-${request.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX}
              className="mt-1.5 min-h-24 w-full rounded-lg border border-[#326273]/40 bg-white px-3 py-2 text-sm leading-6 text-[#1F4452] focus:border-[#0d6370] focus:outline-none focus:ring-2 focus:ring-[#0d6370]/25"
            />
            <p className="mt-1 text-[13px] text-[#326273]">At least {DECLINE_REASON_MIN} characters. Say what would change the answer.</p>
          </div>
        ) : null}

        {here ? (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-[var(--error-bg)] px-3 py-2 text-[13px] font-semibold text-[var(--error)]">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{here}</span>
          </p>
        ) : null}

        <div className="flex justify-end">
          <button
            type="button"
            disabled={busy || declineShort || smallerMissing}
            onClick={() => void send()}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#0d6370] px-4 text-[13px] font-black text-white transition-colors hover:bg-[#1F4452] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {choice === 'decline' ? 'Decline and tell the owners' : choice === 'approve_smaller' ? 'Approve the smaller figure' : `Approve ${request.requestedWords}`}
          </button>
        </div>
      </div>
      )}
    </article>
  );
}

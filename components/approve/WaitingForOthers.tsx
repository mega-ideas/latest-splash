'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { BellRing, Clock3, TriangleAlert } from 'lucide-react';

import { call, errorText } from '@/components/transfer/api';
import { QuietButton } from '@/components/transfer/ui';
import { listOf, utcWhen } from '@/lib/approve/wait';
import type { NoticeView, WaitingView } from '@/lib/server/approval-wait';

type Loaded = { waiting: WaitingView[]; notices: NoticeView[] };

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Updates" show this many at first; the rest are one tap away. */
const NOTICES_SHOWN = 4;

/**
 * Requests that wait for other people, and what Splash has told about them (v2 Phase 3, when nobody who can approve
 * answers). The person who asked sees each of their requests that still waits for approval, who was asked, and that
 * nobody has answered yet; an owner sees every open one in the business. Two choices, nothing else: "Remind them now"
 * (once per 10 minutes, and the page says when it can be pressed again) and "Cancel this request" (only the person who
 * asked, after one confirmation). Beside them, the updates this person was sent: the reminders, and "Nobody approved in
 * time. Nothing was paid. Ask again." for a request that ran out. Nothing here approves anything.
 */
export default function WaitingForOthers() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    const answer = await call<Loaded>('/api/approvals/waiting');
    if (answer.ok && answer.body) {
      setData(answer.body);
      setNow(Date.now());
      setError(null);
    } else {
      setError(errorText(answer, 'What is waiting on others could not be loaded.'));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set when it answers
    void load();
  }, [load]);

  if (error && !data) return <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-[13px] font-medium text-[var(--error)]"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{error}</p>;
  if (!data || (data.waiting.length === 0 && data.notices.length === 0)) return null;
  const shown = all ? data.notices : data.notices.slice(0, NOTICES_SHOWN);

  return (
    <>
      {data.waiting.length > 0 ? (
        <section aria-labelledby="approve-others" className="space-y-3">
          <h2 id="approve-others" className="text-sm font-extrabold text-[#0c3e48]">Waiting for others <span className="ml-1 font-semibold text-[#326273]">{data.waiting.length}</span></h2>
          <ul className="space-y-3">
            {data.waiting.map((w) => (
              <li key={`${w.kind}-${w.id}`}><WaitingCard item={w} now={now} onChanged={load} /></li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.notices.length > 0 ? (
        <section aria-labelledby="approve-updates" className="space-y-3">
          <h2 id="approve-updates" className="text-sm font-extrabold text-[#0c3e48]">Updates</h2>
          <ul className="space-y-2">
            {shown.map((n) => (
              <li key={n.id} className="dash-surface p-4">
                <p className="text-sm font-bold text-[#0c3e48]">{n.title}</p>
                <p className="mt-1 whitespace-pre-line text-[13px] leading-5 text-[#1F4452]">{n.body}</p>
                <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[#326273]">
                  <span>{utcWhen(new Date(n.createdAt))}</span>
                  <Link href={n.linkPath} className="font-semibold text-[#0d6370] underline decoration-1 underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">Open</Link>
                </p>
              </li>
            ))}
          </ul>
          {data.notices.length > NOTICES_SHOWN && !all ? (
            <QuietButton type="button" onClick={() => setAll(true)}>Show earlier updates</QuietButton>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

function WaitingCard({ item, now, onChanged }: { item: WaitingView; now: number; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState<'remind' | 'cancel' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const waitingOn = listOf(item.waitingOn);
  // The button is off until the page knows it may be pressed; the time it opens again is said in words.
  const waitUntil = item.remindAt && Date.parse(item.remindAt) > now ? item.remindAt : null;

  async function remind() {
    setBusy('remind');
    setMessage(null);
    const answer = await call<{ reminded?: number; error?: string }>(`/api/approvals/waiting/${item.kind}/${encodeURIComponent(item.id)}/remind`, { method: 'POST', body: {} });
    setBusy(null);
    // Said only when someone was reminded; with nobody to remind the server answers in plain words and nothing is counted.
    if (answer.ok && (answer.body?.reminded ?? 0) > 0) setMessage({ tone: 'ok', text: 'They were reminded just now. You can remind them again in 10 minutes.' });
    else if (answer.ok) setMessage({ tone: 'error', text: 'There was nobody to remind.' });
    else setMessage({ tone: 'error', text: errorText(answer, 'They were not reminded. Nothing was changed.') });
    await onChanged();
  }

  async function cancel() {
    setBusy('cancel');
    setMessage(null);
    const answer =
      item.kind === 'signing'
        ? await call(`/api/wallet/signing-requests/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
        : await call(`/api/wallet/approval-asks/${encodeURIComponent(item.id)}`, { method: 'POST', body: { action: 'withdraw' } });
    setBusy(null);
    setConfirming(false);
    if (answer.ok) setMessage({ tone: 'ok', text: 'Cancelled. Nothing was paid.' });
    else setMessage({ tone: 'error', text: errorText(answer, 'The request was not cancelled. Nothing was changed.') });
    await onChanged();
  }

  return (
    <div className="dash-surface space-y-3 p-4">
      <div>
        <p className="text-sm font-bold text-[#0c3e48]">{sentence(item.what)}</p>
        <p className="mt-0.5 text-[13px] text-[#326273]">Asked by {item.askedBy}</p>
      </div>
      <p className="text-[13px] leading-5 text-[#1F4452]">
        {waitingOn ? <>Waiting on {waitingOn}. </> : null}
        {item.nobodyAnswered ? <strong className="font-semibold">Nobody has answered yet.</strong> : 'Some have answered; the rest have not yet.'}
      </p>
      <p className="flex items-center gap-1.5 text-[13px] text-[#326273]">
        <Clock3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        If nobody approves it by {utcWhen(new Date(item.expiresAt))}, it ends and nothing is paid.
      </p>

      {confirming ? (
        <div role="group" aria-label="Cancel this request" className="space-y-2 rounded-xl bg-[#F6F0ED] p-3">
          <p className="text-[13px] font-medium leading-5 text-[#1F4452]">Cancel this request? Nothing has been paid. You can ask again later.</p>
          <div className="flex flex-wrap gap-2">
            <QuietButton type="button" onClick={() => void cancel()} disabled={busy !== null}>Yes, cancel it</QuietButton>
            <QuietButton type="button" onClick={() => setConfirming(false)} disabled={busy !== null}>Keep waiting</QuietButton>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {item.canRemind ? (
            <QuietButton type="button" onClick={() => void remind()} disabled={busy !== null || waitUntil !== null}>
              <BellRing className="h-4 w-4" aria-hidden="true" />
              Remind them now
            </QuietButton>
          ) : null}
          {item.canCancel ? (
            <QuietButton type="button" onClick={() => setConfirming(true)} disabled={busy !== null}>Cancel this request</QuietButton>
          ) : null}
          {item.kind === 'signing' ? (
            <Link href={item.linkPath} className="inline-flex h-11 items-center px-2 text-sm font-semibold text-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">Open it</Link>
          ) : null}
        </div>
      )}
      {waitUntil && !message ? <p className="text-[13px] text-[#326273]">They were reminded lately. You can remind them again at {utcWhen(new Date(waitUntil))}.</p> : null}
      <p role="status" aria-live="polite" className={`text-[13px] font-medium ${message?.tone === 'error' ? 'text-[var(--error)]' : 'text-[#1F4452]'}`}>{message?.text ?? ''}</p>
    </div>
  );
}

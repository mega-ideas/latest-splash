'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, Clock3, Fingerprint, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';

import type { SigningView } from '@/components/transfer/api';
import { call, errorText } from '@/components/transfer/api';
import { reviewRequest } from '@/lib/approve/facts';
import { requestTitle } from '@/lib/wallet-page/labels';

type Waiting = SigningView & { purpose: string };

const hours = (iso: string, now: number) => {
  const left = new Date(iso).getTime() - now;
  if (!Number.isFinite(left) || left <= 0) return 'expires now';
  const h = Math.floor(left / 3_600_000);
  return h >= 1 ? `expires in ${h} ${h === 1 ? 'hour' : 'hours'}` : `expires in ${Math.max(1, Math.round(left / 60_000))} minutes`;
};

/**
 * Approve (v2 brief 5.10): the wallet requests that wait for this person's
 * signature, each decoded on this device so the card says what it pays. The
 * list is their own inbox in their own business (the server takes both from
 * the session). A request whose bytes cannot be checked is listed too, with
 * that said, so it is never silently missing; opening it explains why it must
 * not be signed.
 */
export default function ApproveInbox() {
  const [state, setState] = useState<{ loading: boolean; requests: Waiting[] | null; error: string | null }>({ loading: true, requests: null, error: null });
  const [now, setNow] = useState(0);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const answer = await call<{ requests?: Waiting[] }>('/api/wallet/signing-requests');
    setNow(Date.now());
    if (!answer.ok || !answer.body) setState({ loading: false, requests: null, error: errorText(answer, 'Your requests could not be loaded. Nothing was signed.') });
    else setState({ loading: false, requests: answer.body.requests ?? [], error: null });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set when it answers
    void load();
  }, [load]);

  const waiting = (state.requests ?? []).filter((r) => r.status === 'collecting' && r.you.mustSign && !r.you.signed && !r.you.declined);
  const signed = (state.requests ?? []).filter((r) => r.status === 'collecting' && r.you.signed);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header>
        <p className="dash-kicker">Your passkey</p>
        <h1 className="dash-title mt-2 text-3xl">Approve</h1>
        <p className="mt-2 text-sm font-medium leading-6 text-[#326273]">
          Payments and changes your owners sign together. Each is checked on this device before you sign, and Splash has no key to your wallet.
        </p>
      </header>

      {state.loading && !state.requests ? (
        <p role="status" className="flex items-center gap-2 text-sm text-[#326273]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Looking for requests…</p>
      ) : state.error ? (
        <div className="space-y-3">
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-sm font-medium text-[var(--error)]"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{state.error}</p>
          <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] hover:border-[#0d6370]">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />Try again
          </button>
        </div>
      ) : (
        <>
          <section aria-labelledby="approve-waiting" className="space-y-3">
            <h2 id="approve-waiting" className="text-sm font-extrabold text-[#0c3e48]">Needs your signature <span className="ml-1 font-semibold text-[#326273]">{waiting.length}</span></h2>
            {waiting.length === 0 ? (
              <div className="dash-surface p-5 text-center">
                <Fingerprint className="mx-auto h-8 w-8 text-[#145d6a]" aria-hidden="true" />
                <p className="mt-2 text-base font-bold text-[#0c3e48]">Nothing is waiting for your signature</p>
                <p className="mt-1 text-sm text-[#326273]">When your owners ask for a payment or a change, it shows here and you are told on WhatsApp.</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {waiting.map((r) => (
                  <li key={r.id}><RequestCard request={r} now={now} /></li>
                ))}
              </ul>
            )}
          </section>

          {signed.length > 0 ? (
            <section aria-labelledby="approve-signed" className="space-y-3">
              <h2 id="approve-signed" className="text-sm font-extrabold text-[#0c3e48]">You have signed <span className="ml-1 font-semibold text-[#326273]">{signed.length}</span></h2>
              <ul className="space-y-3">
                {signed.map((r) => (
                  <li key={r.id}><RequestCard request={r} now={now} signed /></li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function RequestCard({ request, now, signed = false }: { request: Waiting; now: number; signed?: boolean }) {
  // Decoded on this device: what the card says it pays is what the bytes say.
  const reviewed = reviewRequest(request);
  const first = reviewed.ok ? reviewed.facts.payments[0] : null;
  return (
    <Link
      href={`/dashboard/approve/${encodeURIComponent(request.id)}`}
      className="dash-surface flex min-h-[72px] items-center gap-3 p-4 transition-colors hover:border-[#0d6370]/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-[#0c3e48]">{requestTitle(request.purpose)}</span>
        {reviewed.ok ? (
          <span className="mt-0.5 block text-[15px] font-semibold text-[#0c3e48]">
            {reviewed.facts.kind === 'change' ? reviewed.facts.steps[0]?.line ?? reviewed.facts.headline : reviewed.facts.kind === 'batch' ? reviewed.facts.headline : `${first?.amount} USDC${first?.kindLabel ? ` · ${first.kindLabel}` : ''}`}
          </span>
        ) : (
          <span className="mt-0.5 flex items-start gap-1.5 text-[13px] font-semibold text-[var(--error)]"><TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />This request could not be checked on your device. Do not sign it.</span>
        )}
        <span className="mt-1 flex items-center gap-1.5 text-[13px] text-[#326273]"><Clock3 className="h-3.5 w-3.5" aria-hidden="true" />{request.signedWeight} of {request.threshold} signed, {hours(request.expiresAt, now)}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1 text-sm font-bold text-[#0d6370]">
        {signed ? 'View' : 'Review'}
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </span>
    </Link>
  );
}

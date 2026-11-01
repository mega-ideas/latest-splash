'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';

import RequestSummary from '@/components/approve/RequestSummary';
import { usePhone } from '@/components/dashboard/Device';
import { call, errorText, type SigningView } from '@/components/transfer/api';
import SignPanel, { type SignLabels } from '@/components/transfer/SignPanel';
import { closeOutcomeText } from '@/lib/approve/facts';
import { SIGNING_CHANGED_EVENT } from '@/lib/dashboard/phone';
import { requestTitle } from '@/lib/wallet-page/labels';

type Request = SigningView & { purpose: string };

/** Payments are worded as payments; every other request is a change to the wallet. */
const PAYMENT_PURPOSES = new Set(['wallet_payment', 'wallet_batch', 'partner_payout', 'withdrawal', 'staff_rule_payment']);
const CHANGE_LABELS: SignLabels = {
  working: 'Sending your change',
  done: 'Signed and sent',
  doneNote: 'The change is on your business account. The next step, if there is one, appears under Approve.',
  deadNote: 'Nothing was changed. An owner can ask again.',
  restart: 'Back to Approve',
};
const PAYMENT_LABELS: SignLabels = {
  working: 'Sending the payment',
  done: 'Paid',
  doneNote: 'The payment, its record and its receipt happened together.',
  deadNote: 'Nothing was sent. The payment can be started again.',
  restart: 'Back to Approve',
};

/**
 * One request to sign (v2 brief 5.10), opened from a link or from the list.
 * The review opens at once, because the person came to sign: the bytes are
 * decoded on this device and shown (payee, amount, asset, fee bound, rate),
 * then the passkey signs those bytes. A request that is not in the person's
 * own business reads as absent, the same as one that does not exist. Anyone
 * but the person who asked can decline it; the person who asked can withdraw
 * it. Either is one tap and a confirmation.
 */
export default function ApproveDetail({ id }: { id: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ loading: boolean; request: Request | null; error: string | null; absent: boolean }>({ loading: true, request: null, error: null, absent: false });
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const answer = await call<{ request?: Request }>(`/api/wallet/signing-requests/${encodeURIComponent(id)}`);
    if (answer.status === 404) setState({ loading: false, request: null, error: null, absent: true });
    else if (!answer.ok || !answer.body?.request) setState({ loading: false, request: null, error: errorText(answer, 'This request could not be loaded. Nothing was signed.'), absent: false });
    else setState({ loading: false, request: answer.body.request, error: null, absent: false });
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set when it answers
    void load();
  }, [load]);

  async function close() {
    setClosing(true);
    setCloseError(null);
    const answer = await call<{ outcome?: string }>(`/api/wallet/signing-requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setClosing(false);
    if (!answer.ok) {
      setCloseError(errorText(answer, 'That did not go through. Nothing was changed.'));
      return;
    }
    window.dispatchEvent(new Event(SIGNING_CHANGED_EVENT));
    setConfirming(false);
    setOutcome(closeOutcomeText(answer.body?.outcome));
  }

  const request = state.request;
  const requester = request?.you.requested === true;
  // On a phone the sign bar is fixed to the foot of the window for a signer who has not signed; the page keeps room under the last card for it.
  const phone = usePhone();
  const barShown = phone && request !== null && request.you.mustSign && !request.you.signed && request.status === 'collecting';

  return (
    <div className={`mx-auto w-full max-w-3xl space-y-4 ${barShown ? 'pb-36' : ''}`}>
      <Link href="/dashboard/approve" className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Approve
      </Link>

      {state.loading && !request ? (
        <p role="status" className="flex items-center gap-2 text-sm text-[#326273]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Opening the request…</p>
      ) : state.absent ? (
        <div className="dash-surface p-5">
          <h1 className="text-lg font-extrabold text-[#0c3e48]">This request is not here</h1>
          <p className="mt-1 text-sm leading-6 text-[#326273]">It may have been signed, have expired or been withdrawn, or it is not one of your business&rsquo;s. Nothing was signed.</p>
        </div>
      ) : state.error || !request ? (
        <div className="space-y-3">
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-sm font-medium text-[var(--error)]"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{state.error}</p>
          <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] hover:border-[#0d6370]">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />Try again
          </button>
        </div>
      ) : (
        <>
          <h1 className="text-xl font-extrabold leading-snug text-[#0c3e48]">{requestTitle(request.purpose)}</h1>
          {outcome ? (
            <p role="status" className="rounded-xl border border-[#326273]/15 bg-white p-4 text-sm font-semibold text-[#1F4452]">{outcome}</p>
          ) : (
            <>
              {request.summaryText ? <RequestSummary text={request.summaryText} /> : null}
              <SignPanel
                initial={request}
                labels={PAYMENT_PURPOSES.has(request.purpose) ? PAYMENT_LABELS : CHANGE_LABELS}
                autoReview
                onExecuted={() => window.dispatchEvent(new Event(SIGNING_CHANGED_EVENT))}
                onRestart={() => router.push('/dashboard/approve')}
                onCancelReview={() => router.push('/dashboard/approve')}
              />
              {/* The person who asked can withdraw it even after they signed it; anyone else can decline only until they have signed. */}
              {request.status === 'collecting' && (requester || !request.you.signed) ? (
                <section aria-label={requester ? 'Withdraw the request' : 'Decline the request'} className="rounded-2xl border border-[#326273]/15 bg-white p-4">
                  {confirming ? (
                    <div className="space-y-3">
                      <p className="text-sm leading-6 text-[#1F4452]">
                        {requester ? 'Withdraw this request? Every signature on it is cleared and nothing is sent.' : 'Decline this request? It stays open for the other owners, and nothing is sent unless enough of them sign.'}
                      </p>
                      {closeError ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{closeError}</p> : null}
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={closing} onClick={() => void close()} className="inline-flex min-h-11 items-center justify-center rounded-xl bg-[var(--error)] px-5 text-sm font-bold text-white disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--error)]">
                          {closing ? 'Working…' : requester ? 'Withdraw it' : 'Decline it'}
                        </button>
                        <button type="button" onClick={() => setConfirming(false)} className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] hover:border-[#0d6370]">Keep it</button>
                      </div>
                    </div>
                  ) : (
                    <button type="button" onClick={() => setConfirming(true)} className="inline-flex min-h-11 items-center text-sm font-bold text-[var(--error)] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--error)]">
                      {requester ? 'Withdraw the request' : 'Decline this request'}
                    </button>
                  )}
                </section>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}

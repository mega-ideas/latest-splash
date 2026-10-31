'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Clock3, Fingerprint, ShieldCheck } from 'lucide-react';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import { describeSignError, signWithPasskey } from '@/lib/wallet/sui-signers';
import { reviewOnDevice, type DeviceReview } from '@/lib/wallet/review-on-device';
import { formatUsdc } from '@/lib/fees/copy';
import { groupAddress } from '@/lib/transfer/addresses';
import { plainActions } from '@/lib/wallet-page/actions';
import { differsFromApproved } from '@/lib/transfer/approved';
import { call, errorText, type SigningView } from './api';
import type { Made } from './flow';
import { PrimaryButton, QuietButton } from './ui';

/** What was reviewed, kept apart from the live request: the bytes and digest the owner looked at are the ones signed. */
type Reviewed = { transactionBytes: string; digest: string; review: DeviceReview };

/**
 * Collecting the owners' signatures (v2 brief 4.1 and 5.4 step 4). Each owner
 * signs on their own device: the device decodes the exact bytes itself
 * (reviewOnDevice, never the server's reading), shows who is paid and how
 * much, and signs those bytes with the owner's own passkey. Splash combines
 * the signatures and submits at the threshold. This panel shows who has
 * signed, lets this person sign if they are one of the signers, and goes on
 * only when the payment has executed.
 */
/** What the panel says about the request it is collecting for: a payment by default; the Wallet page passes its own for a wallet change. */
export type SignLabels = { working: string; done: string; doneNote: string; deadNote: string; restart: string };
const PAYMENT_LABELS: SignLabels = { working: 'Sending the payment', done: 'Paid', doneNote: 'The payment, its record and its receipt happened together.', deadNote: 'Nothing was sent. You can start the payment again.', restart: 'Start a new payment' };

export default function SignPanel({ initial, expected = null, labels = PAYMENT_LABELS, onExecuted, onRestart }: { initial: SigningView; expected?: Made['expected']; labels?: SignLabels; onExecuted: (digest: string | null) => void; onRestart: () => void }) {
  const [view, setView] = useState<SigningView>(initial);
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const reviewedDigest = useRef<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  const refresh = useCallback(async () => {
    const answer = await call<{ request?: SigningView }>(`/api/wallet/signing-requests/${encodeURIComponent(initial.id)}`);
    const next = answer.body?.request;
    if (!next) return;
    // The request changed under an open review: what was reviewed is no longer what is waiting, so the review closes.
    if (reviewedDigest.current && next.digest !== reviewedDigest.current) {
      reviewedDigest.current = null;
      setReviewed(null);
      setReviewError('The request changed while you were reviewing it. Review it again before you sign.');
    }
    setView(next);
    if (next.status === 'executed' && !done.current) {
      done.current = true;
      onExecuted(next.executedDigest);
    }
  }, [initial.id, onExecuted]);

  useEffect(() => {
    if (['executed', 'failed', 'expired', 'cancelled'].includes(view.status)) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [view.status, refresh]);

  function openReview() {
    setReviewError(null);
    try {
      const snapshot = { transactionBytes: view.transactionBytes, digest: view.digest };
      const review = reviewOnDevice({ ...snapshot, bytesHash: view.bytesHash, expect: view.expect as Parameters<typeof reviewOnDevice>[0]['expect'] });
      const wrong = expected ? differsFromApproved(review, expected) : null;
      if (wrong) throw new Error(`${wrong} Do not sign it.`);
      reviewedDigest.current = snapshot.digest;
      setReviewed({ ...snapshot, review });
    } catch (e) {
      reviewedDigest.current = null;
      setReviewed(null);
      setReviewError(e instanceof Error ? e.message : 'This request could not be checked on your device, so do not sign it.');
    }
  }

  async function sign() {
    if (!reviewed) return;
    setBusy(true);
    setError(null);
    try {
      const key = await call<{ passkey?: { publicKey: string; rpId: string } | null }>('/api/stablecoin/wallet');
      const passkey = key.body?.passkey;
      if (!passkey) throw new Error('Your passkey is not set up on this device yet. Set it up in Settings, then sign.');
      const signed = await signWithPasskey(passkey, reviewed.transactionBytes);
      const answer = await call<{ request?: SigningView }>(`/api/wallet/signing-requests/${encodeURIComponent(view.id)}/signatures`, { body: { signature: signed.signature, digest: reviewed.digest } });
      if (!answer.ok || !answer.body?.request) throw new Error(errorText(answer, 'The signature was not accepted.'));
      setView(answer.body.request);
      reviewedDigest.current = null;
      setReviewed(null);
      if (answer.body.request.status === 'executed' && !done.current) {
        done.current = true;
        onExecuted(answer.body.request.executedDigest);
      }
    } catch (e) {
      setError(describeSignError(e));
    } finally {
      setBusy(false);
    }
  }

  const finished = view.status === 'executed';
  const dead = ['failed', 'expired', 'cancelled'].includes(view.status);
  const review = reviewed?.review ?? null;
  const open = review?.actions.find((a) => a.type === 'open_intent');
  const pay = review?.actions.find((a) => a.type === 'pay_intent');
  const withdraw = review?.actions.find((a) => a.type === 'withdraw');
  const steps = review ? plainActions(review.actions as Parameters<typeof plainActions>[0]) : [];

  return (
    <section aria-labelledby="sig-h" className="space-y-4 rounded-2xl border border-[#326273]/15 bg-white p-4 sm:p-5" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${finished ? 'bg-[var(--ok-bg)] text-[#145d6a]' : dead ? 'bg-[var(--error-bg)] text-[var(--error)]' : 'bg-[var(--warn-bg)] text-[var(--warn-ink)]'}`}>
          {finished ? <Check className="h-5 w-5" aria-hidden="true" /> : dead ? <CircleAlert className="h-5 w-5" aria-hidden="true" /> : <Clock3 className="h-5 w-5" aria-hidden="true" />}
        </span>
        <div>
          <h3 id="sig-h" className="text-base font-extrabold text-[#0c3e48]">
            {finished ? labels.done : dead ? (view.status === 'expired' ? 'The request expired' : 'This did not go through') : view.status === 'submitting' || view.status === 'unknown' ? labels.working : 'Waiting for signatures'}
          </h3>
          <p className="text-[13px] text-[#326273]">
            {finished ? labels.doneNote : dead ? labels.deadNote : `${view.signedWeight} of ${view.threshold} needed. Each owner signs on their own device.`}
          </p>
        </div>
      </div>

      <ul className="grid gap-2 sm:grid-cols-2">
        {view.signers.map((s, i) => (
          <li key={s.userId} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#F6F0ED] px-3 text-sm text-[#1F4452]">
            {s.signed ? <Check className="h-4 w-4 text-[#145d6a]" aria-hidden="true" /> : <Clock3 className="h-4 w-4 text-[#326273]" aria-hidden="true" />}
            <span className="font-semibold">{`Owner ${i + 1}`}</span>
            <span className="text-[13px] text-[#326273]">{s.signed ? 'signed' : s.declined ? 'declined' : 'not yet'}</span>
          </li>
        ))}
      </ul>

      {!finished && !dead && view.you.mustSign && !view.you.signed ? (
        review ? (
          <div className="space-y-3 rounded-xl border border-[#0d6370]/30 bg-[#f4f8fa] p-4">
            <p className="flex items-center gap-2 text-sm font-bold text-[#0c3e48]"><ShieldCheck className="h-4 w-4" aria-hidden="true" />Checked on this device</p>
            <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[auto_1fr]">
              {open && open.type === 'open_intent' ? (
                <>
                  <dt className="text-[#326273]">Pays</dt>
                  <dd className="font-mono text-[13px] text-[#0c3e48]">{formatUsdc(BigInt(open.amountMinor))} USDC</dd>
                  <dt className="text-[#326273]">To</dt>
                  <dd className="min-w-0 text-[#0c3e48]">
                    {expected?.payeeName ? <span className="block font-semibold">{expected.payeeName}</span> : null}
                    <span className="block break-all font-mono text-[13px] leading-5">{groupAddress(normalizeSuiAddress(open.recipient))}</span>
                  </dd>
                </>
              ) : null}
              {pay && pay.type === 'pay_intent' ? (
                <>
                  <dt className="text-[#326273]">Splash fee at most</dt>
                  <dd className="font-mono text-[13px] text-[#0c3e48]">{formatUsdc(BigInt(pay.maxFeeMinor))} USDC</dd>
                </>
              ) : null}
              {withdraw && withdraw.type === 'withdraw' ? (
                <>
                  <dt className="text-[#326273]">Leaves your wallet at most</dt>
                  <dd className="font-mono text-[13px] text-[#0c3e48]">{formatUsdc(BigInt(withdraw.amountMinor))} USDC</dd>
                </>
              ) : null}
              {steps.length > 0 && !open && !pay ? (
                <>
                  <dt className="text-[#326273]">This will</dt>
                  <dd className="text-[#0c3e48]">
                    <ul className="list-disc space-y-1 pl-4">
                      {steps.map((line) => <li key={line}>{line}</li>)}
                    </ul>
                  </dd>
                </>
              ) : null}
              <dt className="text-[#326273]">Transaction code</dt>
              <dd className="font-mono text-[13px] font-bold text-[#0c3e48]">{review.code}</dd>
            </dl>
            <p className="text-[13px] leading-5 text-[#326273]">If your WhatsApp message shows a different code, do not sign.</p>
            {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <PrimaryButton type="button" disabled={busy} onClick={() => void sign()}>
                <Fingerprint className="h-4 w-4" aria-hidden="true" />
                {busy ? 'Waiting for your passkey…' : 'Sign with your passkey'}
              </PrimaryButton>
              <QuietButton type="button" onClick={() => { reviewedDigest.current = null; setReviewed(null); }}>Cancel</QuietButton>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <PrimaryButton type="button" onClick={openReview}>
              <Fingerprint className="h-4 w-4" aria-hidden="true" />
              Review and sign
            </PrimaryButton>
            {reviewError ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{reviewError}</p> : null}
          </div>
        )
      ) : null}
      {!finished && !dead && !view.you.mustSign ? <p className="text-sm text-[#1F4452]">The owners have been told on WhatsApp and in their Splash inbox. This page updates when they sign.</p> : null}
      {!finished && !dead && view.you.signed ? <p className="text-sm font-semibold text-[#145d6a]">You have signed. Waiting for the others.</p> : null}
      {dead ? <QuietButton type="button" onClick={onRestart}>{labels.restart}</QuietButton> : null}
    </section>
  );
}

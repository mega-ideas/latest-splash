'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, Clock3, Fingerprint, ShieldCheck } from 'lucide-react';
import { normalizeSuiAddress } from '@mysten/sui/utils';

import ApproveScreen from '@/components/approve/ApproveScreen';
import { usePhone } from '@/components/dashboard/Device';
import { approveFacts } from '@/lib/approve/facts';
import { SIGNING_CHANGED_EVENT } from '@/lib/dashboard/phone';
import { describeSignError, signWithPasskey } from '@/lib/wallet/sui-signers';
import { reviewOnDevice, type DeviceReview } from '@/lib/wallet/review-on-device';
import { formatUsdc } from '@/lib/fees/copy';
import { groupAddress } from '@/lib/transfer/addresses';
import { signingItems } from '@/lib/wallet-page/actions';
import { differsFromApproved, differsFromApprovedBatch, type ApprovedPayment } from '@/lib/transfer/approved';
import { call, errorText, type SigningView } from './api';
import type { Made } from './flow';
import { PrimaryButton, QuietButton } from './ui';

/** "5 hours" or "12 minutes" until a request ends, or null when it has no end or has ended. */
function expiresIn(iso: string): string | null {
  const left = Date.parse(iso) - Date.now();
  if (!Number.isFinite(left) || left <= 0) return null;
  const hours = Math.floor(left / 3_600_000);
  if (hours >= 1) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  const minutes = Math.max(1, Math.round(left / 60_000));
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

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

/** A batch's signers see every payment, each checked on their own device against the batch they approved (v2 brief 5.6). */
export type ExpectedBatch = Array<ApprovedPayment & { payeeName: string }>;

export default function SignPanel({ initial, expected = null, expectedBatch = null, labels = PAYMENT_LABELS, autoReview = false, onExecuted, onRestart, onCancelReview }: { initial: SigningView; expected?: Made['expected']; expectedBatch?: ExpectedBatch | null; labels?: SignLabels; /** Open the review as soon as the request is in front of a signer who must sign: the Approve screen is for nothing else. */ autoReview?: boolean; onExecuted: (digest: string | null) => void; onRestart: () => void; /** What "Not now" does on the phone's Approve screen. */ onCancelReview?: () => void }) {
  const [view, setView] = useState<SigningView>(initial);
  const [reviewed, setReviewed] = useState<Reviewed | null>(null);
  const reviewedDigest = useRef<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  const headingId = useId();
  const phone = usePhone();
  const autoOpened = useRef(false);

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
      const wrong = expectedBatch ? differsFromApprovedBatch(review, expectedBatch) : expected ? differsFromApproved(review, expected) : null;
      if (wrong) throw new Error(`${wrong} Do not sign it.`);
      reviewedDigest.current = snapshot.digest;
      setReviewed({ ...snapshot, review });
    } catch (e) {
      reviewedDigest.current = null;
      setReviewed(null);
      setReviewError(e instanceof Error ? e.message : 'This request could not be checked on your device, so do not sign it.');
    }
  }

  // The Approve screen opens a request to review it: the person came to sign.
  useEffect(() => {
    if (!autoReview || autoOpened.current || !view.you.mustSign || view.you.signed || view.status !== 'collecting') return;
    autoOpened.current = true;
    openReview();
    // openReview reads the request in view; it is run once for the first one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoReview, view.you.mustSign, view.you.signed, view.status]);

  async function sign() {
    if (!reviewed) return;
    // The button is off for a blocked request; this is the same rule where the signing is, in case it is reached another way.
    if (approveFacts(reviewed.review).blocked) {
      setError('This request is not to be signed from here. Do not sign it.');
      return;
    }
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
      // The tab bar's count of what waits for this person is looked at again at once.
      window.dispatchEvent(new Event(SIGNING_CHANGED_EVENT));
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
  const opens = review?.actions.filter((a) => a.type === 'open_intent') ?? [];
  const pays = review?.actions.filter((a) => a.type === 'pay_intent') ?? [];
  const isBatch = opens.length > 1;
  const open = review?.actions.find((a) => a.type === 'open_intent');
  const pay = review?.actions.find((a) => a.type === 'pay_intent');
  const withdraw = review?.actions.find((a) => a.type === 'withdraw');
  const withdrawn = (review?.actions.filter((a) => a.type === 'withdraw') ?? []).reduce((sum, a) => sum + (a.type === 'withdraw' ? BigInt(a.amountMinor) : 0n), 0n);
  const items = review ? signingItems(review.actions as Parameters<typeof signingItems>[0]) : [];
  // A batch repeats the same few commands once per payment: each is said once, with how many times.
  const counted = new Map<string, { item: (typeof items)[number]; times: number }>();
  for (const item of items.filter((i) => !i.covered)) {
    const key = `${item.line}|${item.fields.map((f) => `${f.label}=${f.value}`).join(';')}`;
    const seen = counted.get(key);
    if (seen) seen.times += 1;
    else counted.set(key, { item, times: 1 });
  }
  const steps = [...counted.values()].map(({ item, times }) => (times > 1 ? { ...item, line: `${item.line.replace(/\.$/, '')}, ${times} times, once for each payment.` } : item));
  // One reading of the bytes for the whole panel (it never throws). A command the page cannot word, a payment that does more than it says, an amount that does not add up and a rate that cannot be shown are never signed: the owner would be signing something that is not on the screen.
  const facts = review ? approveFacts(review) : null;
  const blocked = facts ? facts.blocked : items.some((i) => i.unknown);
  const blockedReason = facts?.blockedReason ?? 'Part of this request cannot be shown here, so it cannot be signed from this screen.';
  // The rate the intent in the bytes carries, for a payment that is not in USDC.
  const rate = facts && !isBatch ? facts.payments[0]?.rate ?? null : null;

  // On a phone an open review is the whole screen (v2 brief 5.10): who is paid comes first, and where the signatures stand is one line of it.
  if (phone && review && !finished && !dead && view.you.mustSign && !view.you.signed) {
    return (
      <section aria-label="Approve" aria-live="polite">
        <ApproveScreen
          review={review}
          names={isBatch ? (expectedBatch ?? []).map((e) => e.payeeName) : [expected?.payeeName]}
          busy={busy}
          error={error}
          onSign={() => void sign()}
          onCancel={() => {
            reviewedDigest.current = null;
            setReviewed(null);
            onCancelReview?.();
          }}
          expiresIn={expiresIn(view.expiresAt)}
          signed={view.signedWeight}
          needed={view.threshold}
        />
      </section>
    );
  }

  return (
    <section aria-labelledby={headingId} className="space-y-4 rounded-2xl border border-[#326273]/15 bg-white p-4 sm:p-5" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${finished ? 'bg-[var(--ok-bg)] text-[#145d6a]' : dead ? 'bg-[var(--error-bg)] text-[var(--error)]' : 'bg-[var(--warn-bg)] text-[var(--warn-ink)]'}`}>
          {finished ? <Check className="h-5 w-5" aria-hidden="true" /> : dead ? <CircleAlert className="h-5 w-5" aria-hidden="true" /> : <Clock3 className="h-5 w-5" aria-hidden="true" />}
        </span>
        <div>
          <h3 id={headingId} className="text-base font-extrabold text-[#0c3e48]">
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
              {isBatch ? (
                <>
                  <dt className="text-[#326273]">Pays</dt>
                  <dd className="min-w-0 text-[#0c3e48]">
                    <span className="block font-mono text-[13px]">{opens.length} payments in one transaction</span>
                    <ol className="mt-2 space-y-2">
                      {opens.map((o, i) => (
                        <li key={`${i}-${o.type === 'open_intent' ? o.recipient : ''}`} className="rounded-lg bg-white p-2.5">
                          {o.type === 'open_intent' ? (
                            <>
                              <span className="flex flex-wrap items-baseline justify-between gap-2">
                                <span className="font-semibold">{expectedBatch?.[i]?.payeeName ? `${i + 1}. ${expectedBatch[i].payeeName}` : `Payment ${i + 1}`}</span>
                                <span className="font-mono text-[13px]">{formatUsdc(BigInt(o.amountMinor))} USDC</span>
                              </span>
                              <span className="mt-0.5 block break-all font-mono text-[13px] leading-5 text-[#1F4452]">{groupAddress(normalizeSuiAddress(o.recipient))}</span>
                              {pays[i] && pays[i].type === 'pay_intent' ? <span className="block text-[13px] text-[#326273]">{`Splash fee at most ${formatUsdc(BigInt(pays[i].maxFeeMinor ?? '0'))} USDC`}</span> : null}
                            </>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  </dd>
                  <dt className="text-[#326273]">Leaves your wallet at most</dt>
                  <dd className="font-mono text-[13px] text-[#0c3e48]">{formatUsdc(withdrawn)} USDC</dd>
                </>
              ) : null}
              {!isBatch && open && open.type === 'open_intent' ? (
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
              {!isBatch && pay && pay.type === 'pay_intent' ? (
                <>
                  <dt className="text-[#326273]">Splash fee at most</dt>
                  <dd className="font-mono text-[13px] text-[#0c3e48]">{formatUsdc(BigInt(pay.maxFeeMinor))} USDC</dd>
                </>
              ) : null}
              {!isBatch && rate ? (
                <>
                  <dt className="text-[#326273]">Rate</dt>
                  <dd className="text-[#0c3e48]">
                    <span className="block font-mono text-[13px]">{rate.text}</span>
                    <span className="block text-[13px] text-[#326273]">About {rate.receiveApprox} before the payout partner&rsquo;s fee</span>
                  </dd>
                </>
              ) : null}
              {!isBatch && withdraw && withdraw.type === 'withdraw' ? (
                <>
                  <dt className="text-[#326273]">Leaves your wallet at most</dt>
                  <dd className="font-mono text-[13px] text-[#0c3e48]">{formatUsdc(BigInt(withdraw.amountMinor))} USDC</dd>
                </>
              ) : null}
              {steps.length > 0 ? (
                <>
                  <dt className="text-[#326273]">This will</dt>
                  <dd className="min-w-0 text-[#0c3e48]">
                    <ul className="space-y-3">
                      {steps.map((item, n) => (
                        <li key={`${n}-${item.line}`} className={item.unknown || facts?.unexpected.some((u) => u.line === item.line) ? 'font-semibold text-[var(--error)]' : undefined}>
                          <span className="block">{item.line}</span>
                          {item.fields.length > 0 ? (
                            <dl className="mt-1 grid gap-x-3 gap-y-1 text-[13px] sm:grid-cols-[auto_1fr]">
                              {item.fields.map((f) => (
                                <div key={`${f.label}-${f.value}`} className="contents">
                                  <dt className="text-[#326273]">{f.label}</dt>
                                  <dd className={`min-w-0 break-all font-mono leading-5 text-[#0c3e48]`}>{f.address ? groupAddress(normalizeSuiAddress(f.value)) : f.value}</dd>
                                </div>
                              ))}
                            </dl>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </dd>
                </>
              ) : null}
              <dt className="text-[#326273]">Transaction code</dt>
              <dd className="font-mono text-[13px] font-bold text-[#0c3e48]">{review.code}</dd>
            </dl>
            <p className="text-[13px] leading-5 text-[#326273]">If your WhatsApp message shows a different code, do not sign.</p>
            {blocked ? <p role="alert" className="text-sm font-semibold text-[var(--error)]">{blockedReason} Do not sign it.</p> : null}
            {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}
            <div className="flex flex-wrap gap-2">
              <PrimaryButton type="button" disabled={busy || blocked} onClick={() => void sign()}>
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

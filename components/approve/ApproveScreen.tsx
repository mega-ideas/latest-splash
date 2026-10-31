'use client';

import { ChevronDown, Fingerprint, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react';

import PhoneBar from '@/components/dashboard/PhoneBar';
import { approveFacts, type ApprovePayment } from '@/lib/approve/facts';
import type { DeviceReview } from '@/lib/wallet/review-on-device';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { groupAddress } from '@/lib/transfer/addresses';

/**
 * The approver's passkey sign screen, on a phone (v2 brief 5.10): the most
 * important phone screen. It shows who is paid, how much, in what asset, the
 * fee bound and the rate, every one of them read from the exact bytes on this
 * device (reviewOnDevice, via approveFacts), then one 56px button for the
 * passkey. The sign panel that renders this keeps the bytes that were
 * reviewed and signs those and no others; this component only shows them.
 *
 * The button sits in a bar at the foot, clear of the home indicator, and the
 * tab bar steps aside for it.
 */
export default function ApproveScreen({
  review,
  names = [],
  busy,
  error,
  onSign,
  onCancel,
  expiresIn,
  signed,
  needed,
}: {
  review: DeviceReview;
  /** The payees' names as the page knew them, in the order of the payments. Shown beside the address from the bytes, never instead of it. */
  names?: Array<string | null | undefined>;
  busy: boolean;
  error: string | null;
  onSign: () => void;
  onCancel: () => void;
  /** "5 hours" or "12 minutes", when the request has an end. */
  expiresIn?: string | null;
  /** Where the signatures stand: how many are in, and how many are needed. */
  signed?: number;
  needed?: number;
}) {
  const facts = approveFacts(review, { names });
  const blocked = facts.blocked;
  const first = facts.payments[0] ?? null;

  return (
    <div className="space-y-4 pb-32" data-testid="approve-screen">
      {/* First, above the amount: a request that is not to be signed says so before it says what it pays. */}
      {blocked ? (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-sm font-semibold text-[var(--error)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {facts.blockedReason} Do not sign it.
        </p>
      ) : null}
      <section aria-labelledby="approve-heading" className="overflow-hidden rounded-2xl bg-[#0c3e48] p-5 text-white">
        <p id="approve-heading" className="flex items-center gap-2 text-[13px] font-semibold text-white/85">
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Checked on this device
        </p>
        {facts.kind === 'payment' && first ? (
          <>
            <p className="mt-3 text-[13px] font-semibold text-white/85">You are approving</p>
            <p className="mt-1 font-mono text-[34px] font-bold leading-none tabular-nums">
              {first.amount}
              <span className="ml-2 text-base font-semibold text-[#bfe6ee]">USDC</span>
            </p>
            <p className="mt-3 break-words text-base font-semibold">{first.payeeName ? `to ${first.payeeName}` : 'to the address below'}</p>
            {first.kindLabel ? <p className="mt-1 text-[13px] font-medium text-[#bfe6ee]">{first.kindLabel} · USDC on Sui</p> : null}
          </>
        ) : facts.kind === 'batch' ? (
          <>
            <p className="mt-3 text-[13px] font-semibold text-white/85">You are approving</p>
            <p className="mt-1 text-[26px] font-bold leading-tight">{facts.headline}</p>
          </>
        ) : (
          <>
            <p className="mt-3 text-[13px] font-semibold text-white/85">You are approving</p>
            <p className="mt-1 text-[22px] font-bold leading-tight">{facts.headline}</p>
          </>
        )}
        {facts.leavesAtMost || (signed !== undefined && needed !== undefined) ? (
          <div className="mt-4 space-y-1 border-t border-white/20 pt-3 text-[13px] text-white/85">
            {facts.leavesAtMost ? (
              <p>
                At most <span className="font-mono font-bold text-white">{facts.leavesAtMost} USDC</span> leaves your wallet.
              </p>
            ) : null}
            {/* The fee bound and the rate are in the first screenful, not below it: they are what the amount is not. */}
            {facts.kind === 'payment' && first?.maxFee ? (
              <p>
                Splash fee at most <span className="font-mono font-bold text-white">{first.maxFee} USDC</span>.
              </p>
            ) : null}
            {facts.kind === 'payment' && first?.rate ? (
              <p>
                <span className="font-mono font-bold text-white">{first.rate.text}</span>, about {first.rate.receiveApprox} before the payout partner&rsquo;s fee.
              </p>
            ) : null}
            {signed !== undefined && needed !== undefined ? <p>{signed} of {needed} signatures so far. Each owner signs on their own device.{expiresIn ? ` Expires in ${expiresIn}.` : ''}</p> : null}
          </div>
        ) : null}
      </section>

      {facts.kind === 'payment' && first ? (
        <dl className="divide-y divide-[#326273]/10 rounded-2xl border border-[#326273]/15 bg-white text-sm">
          <Row label="Pays">
            {first.payeeName ? <span className="block text-base font-bold text-[#0c3e48]">{first.payeeName}</span> : null}
            {first.recipient ? <span className="mt-0.5 block break-words font-mono text-[13px] leading-5 text-[#0c3e48]">{first.recipient}</span> : <span className="text-[#326273]">A bank account, through the payout partner</span>}
            {first.kindLabel ? <span className="mt-0.5 block text-[13px] text-[#326273]">{first.kindLabel}</span> : null}
          </Row>
          <Row label="Amount"><Num>{first.amount} USDC</Num></Row>
          <Row label="Asset"><span className="block font-bold text-[#0c3e48]">USDC</span><span className="block text-[13px] text-[#326273]">A US dollar stablecoin on Sui</span></Row>
          <Row label="Splash fee at most">{first.maxFee ? <Num>{first.maxFee} USDC</Num> : <span className="text-[#326273]">Not shown</span>}</Row>
          {first.rate ? (
            <Row label="Rate">
              <Num>{first.rate.text}</Num>
              <span className="block text-[13px] text-[#326273]">About {first.rate.receiveApprox} before the payout partner&rsquo;s fee</span>
            </Row>
          ) : null}
        </dl>
      ) : null}

      {facts.kind === 'batch' ? (
        <ol className="space-y-3">
          {facts.payments.map((p, i) => (
            <li key={`${i}-${p.recipient}`} className="rounded-2xl border border-[#326273]/15 bg-white p-4">
              <PaymentCard n={i + 1} p={p} />
            </li>
          ))}
        </ol>
      ) : null}

      {facts.steps.length > 0 ? (
        // A change to the wallet is the whole point, so it is open. A payment's own bookkeeping is every command the transaction has, one tap away.
        // ...and so is a payment's step that is not known bookkeeping: a send to another address is never one tap away.
        <details open={facts.kind === 'change' || facts.unexpected.length > 0} className="group rounded-2xl border border-[#326273]/15 bg-white">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[#0d6370] [&::-webkit-details-marker]:hidden">
            <span className="text-sm font-extrabold text-[#0c3e48]">{facts.kind === 'change' ? 'This will' : facts.unexpected.length > 0 ? `Also in this transaction (${facts.steps.length})` : `Everything else in this transaction (${facts.steps.length})`}</span>
            <ChevronDown className="h-5 w-5 shrink-0 text-[#326273] transition-transform group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
          </summary>
          <ul className="space-y-3 border-t border-[#326273]/10 px-4 py-3">
            {facts.steps.map((item, n) => (
              <li key={`${n}-${item.line}`} className={item.unknown || facts.unexpected.some((u) => u.line === item.line) ? 'font-semibold text-[var(--error)]' : 'text-[#0c3e48]'}>
                <span className="block text-sm leading-6">{item.line}</span>
                {item.fields.length > 0 ? (
                  <dl className="mt-1 space-y-1 text-[13px]">
                    {item.fields.map((f) => (
                      <div key={`${f.label}-${f.value}`}>
                        <dt className="text-[#326273]">{f.label}</dt>
                        <dd className="break-all font-mono leading-5 text-[#0c3e48]">{f.address ? groupAddress(normalizeSuiAddress(f.value)) : f.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <section aria-labelledby="approve-code" className="rounded-2xl border border-[#0d6370]/30 bg-[#f4f8fa] p-4">
        <h2 id="approve-code" className="text-[13px] font-bold text-[#0c3e48]">Transaction code</h2>
        <p className="mt-1 font-mono text-xl font-bold tracking-wide text-[#0c3e48]">{facts.code}</p>
        <p className="mt-1 text-[13px] leading-5 text-[#326273]">If your WhatsApp message shows a different code, do not sign.</p>
      </section>

      {error ? (
        <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-sm font-medium text-[var(--error)]">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : null}

      <PhoneBar>
        <div className="space-y-1">
          <button
            type="button"
            disabled={busy || blocked}
            onClick={onSign}
            className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#0d6370] px-5 text-base font-bold text-white transition-colors hover:bg-[#073d49] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Fingerprint className="h-5 w-5" aria-hidden="true" />}
            {busy ? 'Waiting for your passkey…' : 'Sign with your passkey'}
          </button>
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={onCancel} className="min-h-11 bg-transparent px-1 text-sm font-semibold text-[#0d6370] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
              Not now
            </button>
            {/* The code to compare with the WhatsApp message sits beside the button that signs. */}
            <span className="text-[13px] text-[#326273]">Code <span className="font-mono font-bold text-[#0c3e48]">{facts.code}</span></span>
          </div>
        </div>
      </PhoneBar>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-[13px] font-semibold text-[#326273]">{label}</dt>
      <dd className="mt-0.5 min-w-0">{children}</dd>
    </div>
  );
}

function Num({ children }: { children: React.ReactNode }) {
  return <span className="block font-mono text-base font-bold tabular-nums text-[#0c3e48]">{children}</span>;
}

function PaymentCard({ n, p }: { n: number; p: ApprovePayment }) {
  return (
    <>
      <p className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-bold text-[#0c3e48]">{p.payeeName ? `${n}. ${p.payeeName}` : `Payment ${n}`}</span>
        <span className="font-mono text-sm font-bold tabular-nums text-[#0c3e48]">{p.amount} USDC</span>
      </p>
      {p.recipient ? <p className="mt-1 break-words font-mono text-[13px] leading-5 text-[#0c3e48]">{p.recipient}</p> : null}
      <p className="mt-1 text-[13px] text-[#326273]">{p.maxFee ? `Splash fee at most ${p.maxFee} USDC` : 'Fee not shown'}{p.rate ? `. ${p.rate.text}` : ''}</p>
    </>
  );
}

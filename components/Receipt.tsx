"use client";

import { forwardRef } from "react";
import { ShieldCheck, Check, ArrowRight, Landmark, Clock, ChevronDown } from "lucide-react";

/**
 * W9.2 — settlement receipt with a business face and a proof layer.
 *
 * The face speaks operator language only: who got paid, how much, when,
 * at what rate, approved by whom. Raw chain vocabulary (digest, blob ids)
 * lives exclusively inside the collapsed "Verify independently" section,
 * renamed to business terms: "Settlement record" and "Tamper-evident
 * archive". The network line comes from the runtime profile so it flips to
 * "Sui mainnet" at launch without a code change.
 */

export type ReceiptProps = {
  txDigest: string;
  sender: string;
  recipient: string;
  amount: string;
  currency: string;
  fee: string;
  feeTier?: 'STANDARD' | 'DISCOUNT';
  fundingSource?: string;
  timestamp: string;
  reference?: string;
  explorerUrl?: string | null;
  /** Optional enrichments — the receipt degrades gracefully without them. */
  recipientName?: string;
  network?: string;
  status?: 'Settled' | 'Pending';
  targetCurrency?: string;
  fxRate?: string | number;
  /** W9.2 business-face fields. */
  amountToPayee?: string;
  invoiceRef?: string;
  invoiceClosedOnDelivery?: boolean;
  approvedBy?: string;
  sentAt?: string;
  deliveredAt?: string;
  /** W9.2 proof-layer fields (render inside "Verify independently" only). */
  walrusBlobId?: string;
  sealedState?: string;
  networkLine?: string;
};

const INK = '#1F4452';
const SLATE = '#326273';
const TEAL = '#5C9EAD';
const OK = '#2E7D6B';
const OK_BG = '#E4F1ED';
const LINE = '#E5DCD6';
const MUTE = '#6B7C85';
const MUTE_BG = '#EDEFF0';

function toNumber(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = Number.parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function money(value: string | number | undefined): string {
  const n = toNumber(value);
  if (n === null) return String(value ?? '—');
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
    timeZoneName: 'short',
  });
}

const SettlementReceipt = forwardRef<HTMLDivElement, ReceiptProps>(function SettlementReceipt(props, ref) {
  const {
    amount, fee, currency, status = 'Settled',
    feeTier = 'STANDARD', recipientName, txDigest, explorerUrl, fxRate, targetCurrency,
    amountToPayee, invoiceRef, invoiceClosedOnDelivery, approvedBy, sentAt, deliveredAt,
    walrusBlobId, sealedState, networkLine,
  } = props;

  const amountNum = toNumber(amount);
  const feeNum = toNumber(fee) ?? 0;
  const totalCost = amountNum !== null ? amountNum + 0 : null; // total cost = amount sent (fee is inside)
  const net = amountNum !== null ? amountNum - feeNum : null;
  const delivered = status === 'Settled';
  const isPendingDigest = !txDigest || txDigest === 'Pending';
  const payeeLine = amountToPayee ?? (net !== null ? `${money(net)} ${targetCurrency ?? currency}` : '—');

  return (
    <div
      ref={ref}
      className="relative mx-auto max-w-xl overflow-hidden rounded-2xl bg-white font-sans text-[#1F4452] shadow-[0_12px_32px_rgb(31_68_82_/.12)] [print-color-adjust:exact] [-webkit-print-color-adjust:exact]"
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      <div className="h-1.5 w-full" style={{ background: `linear-gradient(90deg, ${SLATE} 0%, ${TEAL} 100%)` }} />

      <div className="px-8 pt-7 pb-6 sm:px-10">
        {/* Header: brand, receipt id, Delivered status */}
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="text-2xl font-semibold tracking-[-0.01em]">
              SPLASH<span style={{ color: TEAL }}>.</span>
            </div>
            <div className="mt-1 text-[11px] font-medium uppercase tracking-[0.16em]" style={{ color: MUTE }}>
              Payment receipt{props.reference ? ` · ${props.reference}` : ''}
            </div>
          </div>
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[13px] font-semibold"
            style={delivered ? { color: OK, background: OK_BG } : { color: MUTE, background: MUTE_BG }}
          >
            {delivered ? <Check className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
            {delivered ? 'Delivered' : 'In progress'}
          </span>
        </header>

        {/* Amount to payee */}
        <section className="mt-7">
          <div className="text-[11px] font-medium uppercase tracking-[0.14em]" style={{ color: MUTE }}>
            Amount to payee
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-4xl font-semibold tracking-[-0.02em]">{payeeLine}</span>
          </div>
          <div className="mt-1 text-sm font-medium" style={{ color: SLATE }}>
            to {recipientName ?? props.recipient}
          </div>
        </section>

        {/* Perforation */}
        <div className="relative my-6" aria-hidden>
          <div className="border-t border-dashed" style={{ borderColor: LINE }} />
          <span className="absolute -left-10 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-[#F6F0ED]" />
          <span className="absolute -right-10 top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-[#F6F0ED]" />
        </div>

        {/* Business detail grid */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm">
          <Field label="Paid by"><span className="font-medium">{props.sender}</span></Field>
          <Field label="Payment source">
            <span className="inline-flex items-center gap-1.5 font-medium">
              <Landmark className="h-3.5 w-3.5" style={{ color: TEAL }} />
              {props.fundingSource ?? 'Bank USD'}
            </span>
          </Field>
          {invoiceRef ? (
            <Field label="Invoice">
              <span className="font-medium">{invoiceRef}</span>
              {invoiceClosedOnDelivery ? (
                <span className="mt-0.5 block text-[13px] font-medium" style={{ color: OK }}>Closed on delivery</span>
              ) : null}
            </Field>
          ) : null}
          <Field label="Sent">
            <span className="font-medium">{formatTimestamp(sentAt ?? props.timestamp)}</span>
          </Field>
          <Field label="Delivered">
            <span className="font-medium">{delivered ? formatTimestamp(deliveredAt ?? props.timestamp) : 'In progress'}</span>
          </Field>
          {fxRate !== undefined && (
            <Field label={`Rate applied${targetCurrency ? ` (${currency}→${targetCurrency})` : ''}`}>
              <span className="font-medium">{money(fxRate)}</span>
            </Field>
          )}
          <Field label={`Total cost${feeTier === 'DISCOUNT' ? ' · discount tier' : ''}`}>
            <span className="font-medium">
              {totalCost !== null ? `${money(totalCost)} ${currency}` : '—'}
              <span className="ml-1 text-[13px]" style={{ color: MUTE }}>incl. {money(fee)} fee</span>
            </span>
          </Field>
          <Field label="Approved by">
            <span className="font-medium">{approvedBy ?? 'Operator'}</span>
            <span className="mt-0.5 block text-[13px] font-medium" style={{ color: MUTE }}>maker-checker</span>
          </Field>
        </dl>

        {/* Delivery strip */}
        <div className="mt-6 flex items-center justify-between rounded-xl px-4 py-3" style={{ background: '#E7EEF1' }}>
          <TimelineStep label="Approved" done />
          <TimelineArrow />
          <TimelineStep label="Sent" done={delivered} />
          <TimelineArrow />
          <TimelineStep label="Delivered" done={delivered} />
        </div>

        {/* Proof layer — the ONLY place raw chain vocabulary may appear. */}
        <details className="group mt-5 rounded-xl" style={{ border: `1px solid ${LINE}` }}>
          <summary className="flex cursor-pointer items-center justify-between gap-2 px-4 py-3 text-xs font-semibold uppercase tracking-[0.1em]" style={{ color: SLATE }}>
            <span className="inline-flex items-center gap-2">
              <ShieldCheck className="h-4 w-4" style={{ color: OK }} />
              Verify independently
            </span>
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" style={{ color: MUTE }} />
          </summary>
          <div className="space-y-3 border-t px-4 py-3" style={{ borderColor: LINE }}>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.12em]" style={{ color: MUTE }}>Settlement record</div>
              <div className="mt-0.5 break-all font-mono text-[13px] font-medium" style={{ color: INK }}>
                {isPendingDigest ? 'Awaiting settlement record' : txDigest}
              </div>
              {explorerUrl && !isPendingDigest ? (
                <a href={explorerUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block break-all font-mono text-[13px] underline-offset-2 hover:underline" style={{ color: TEAL }}>
                  {explorerUrl}
                </a>
              ) : null}
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-[0.12em]" style={{ color: MUTE }}>Tamper-evident archive</div>
              <div className="mt-0.5 break-all font-mono text-[13px] font-medium" style={{ color: INK }}>
                {walrusBlobId ?? 'Archived with the daily audit batch'}
              </div>
              {sealedState ? (
                <div className="mt-0.5 text-[13px] font-medium" style={{ color: OK }}>{sealedState}</div>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.12em]" style={{ color: MUTE }}>Network</div>
                <div className="mt-0.5 text-[13px] font-medium" style={{ color: INK }}>{networkLine ?? 'Sui · sandbox, no customer funds'}</div>
              </div>
              <a href="/trust" className="text-[13px] font-medium underline-offset-2 hover:underline" style={{ color: TEAL }}>
                Where your money sits
              </a>
            </div>
          </div>
        </details>

        {/* Footer */}
        <footer className="mt-5 flex items-center justify-between gap-4 text-[13px]" style={{ color: MUTE }}>
          <span>Issued {formatTimestamp(props.timestamp)}</span>
          <span className="text-right">This record is tamper-evident. Verify it independently at any time.</span>
        </footer>
      </div>
    </div>
  );
});

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-medium uppercase tracking-[0.12em]" style={{ color: MUTE }}>{label}</dt>
      <dd className="mt-0.5 break-words">{children}</dd>
    </div>
  );
}

function TimelineStep({ label, done }: { label: string; done?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 text-center">
      <span
        className="flex h-6 w-6 items-center justify-center rounded-full"
        style={done ? { background: OK, color: '#FFFFFF' } : { background: MUTE_BG, color: MUTE }}
      >
        {done ? <Check className="h-3.5 w-3.5" /> : <Clock className="h-3 w-3" />}
      </span>
      <span className="text-[13px] font-medium leading-tight" style={{ color: done ? SLATE : MUTE }}>{label}</span>
    </div>
  );
}

function TimelineArrow() {
  return <ArrowRight className="mx-1 h-3.5 w-3.5 shrink-0" style={{ color: TEAL }} aria-hidden />;
}

export default SettlementReceipt;

import { BadgeCheck, ExternalLink } from 'lucide-react';

import { receiptRows, type PaymentReceipt } from '@/lib/transfer/receipt';

/** A settled payment's receipt, read-only, for a person who was sent the link. The same rows the business sees. */
export default function SharedReceiptCard({ receipt }: { receipt: PaymentReceipt }) {
  return (
    <article aria-label="Payment receipt" className="overflow-hidden rounded-2xl border border-[#326273]/15 bg-white">
      <header className="flex items-center justify-between gap-3 bg-[#0c3e48] px-4 py-3 text-white">
        <span className="text-sm font-bold">Payment receipt</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ok-bg)] px-2.5 py-1 text-[12px] font-bold text-[#145d6a]">
          <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Verified on Sui
        </span>
      </header>
      <dl className="divide-y divide-[#326273]/10 text-sm">
        {receiptRows(receipt).map((row) => (
          <div key={row.label} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
            <dt className="text-[#326273]">{row.label}</dt>
            <dd className="min-w-0 break-words font-mono font-bold tabular-nums text-[#0c3e48] sm:text-right">{row.value}</dd>
          </div>
        ))}
      </dl>
      {receipt.verifyUrl ? (
        <a href={receipt.verifyUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center justify-between gap-3 border-t border-[#326273]/10 px-4 py-3 text-sm font-bold text-[#0d6370] hover:bg-[#f4f8fa] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0d6370]">
          Check this payment on Sui
          <ExternalLink className="h-4 w-4" aria-hidden="true" />
        </a>
      ) : null}
    </article>
  );
}

import { FileText } from 'lucide-react';

export type SummaryText = { headline: string; lines: string[] };

/**
 * What the owner who asked said this request is for, in plain words: for the
 * allowance that lets a schedule pay automatically, the exact payments, how often
 * they run, the limits, the end date and how to stop. Every owner who signs reads
 * the same text the requester confirmed. It sits beside the review of the
 * transaction itself, never in place of it: the bytes are decoded on this device
 * and that is what the passkey signs.
 */
export default function RequestSummary({ text }: { text: SummaryText }) {
  const rest = text.lines.slice(1);
  return (
    <section aria-label="What the owner who asked said this is for" className="rounded-2xl border border-[#326273]/15 bg-white p-4">
      <h2 className="flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">
        <FileText className="h-4 w-4" aria-hidden="true" />
        What was asked for
      </h2>
      <p className="mt-2 text-sm font-bold leading-6 text-[#0c3e48]">{text.headline}</p>
      {rest.length > 0 ? (
        <ul className="mt-2 space-y-1.5 text-[13px] leading-5 text-[#1F4452]">
          {rest.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 text-[13px] leading-5 text-[#326273]">This is the summary the owner who asked confirmed. The review below is read from the transaction on this device. Sign only if the two agree.</p>
    </section>
  );
}

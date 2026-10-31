'use client';

import { useEffect, useState } from 'react';
import { BadgeCheck, Download, ExternalLink } from 'lucide-react';

import { formatUsdc } from '@/lib/fees/copy';
import { receiptRows } from '@/lib/transfer/receipt';
import { PrimaryButton, QuietButton } from '../transfer/ui';
import { call, errorText, type BatchReceipt } from './api';

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;

/**
 * Step 5 of a batch (v2 brief 5.6): one receipt for each payment, the batch
 * total, who approved it, and the Sui transaction to check. A fee is shown as
 * the network charged it; a batch whose transaction cannot be read yet says it
 * is not final rather than showing a fee that was not read.
 */
export default function StepReceipts({ batchId, onNew }: { batchId: string; onNew: () => void }) {
  const [batch, setBatch] = useState<BatchReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const answer = await call<{ batch?: BatchReceipt }>(`/api/wallet/batches/${encodeURIComponent(batchId)}/receipts`);
      if (!alive) return;
      if (answer.ok && answer.body?.batch) setBatch(answer.body.batch);
      else setError(errorText(answer, 'The receipts could not be loaded just now.'));
    })();
    return () => {
      alive = false;
    };
  }, [batchId]);

  if (error) return <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p>;
  if (!batch) return <p role="status" className="text-sm text-[#326273]">Loading the receipts…</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--ok-bg)] text-[#145d6a]"><BadgeCheck className="h-5 w-5" aria-hidden="true" /></span>
        <div>
          <h2 className="text-xl font-extrabold text-[#0c3e48]">{batch.final ? 'Paid. Your receipts are ready' : 'Sent. The receipts are not final yet'}</h2>
          <p className="text-sm text-[#326273]">{batch.final ? `${batch.rowCount} payments in one transaction, approved by ${batch.approvers.map((a) => a.name).join(' and ') || 'your owners'}.` : 'The transaction has not been read back from the network yet, so the fees shown are the most each could be. Open this page again in a moment.'}</p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['Payments', String(batch.rowCount)],
          ['Sent to recipients', usdc(batch.totalSentMinor)],
          ['Splash fees', usdc(batch.totalFeeMinor)],
          ['Left your wallet', usdc(batch.totalDebitMinor)],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-[#326273]/15 bg-white p-3">
            <dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#1F4452]">{label}</dt>
            <dd className="mt-1 text-lg font-extrabold tabular-nums text-[#0c3e48]">{value}</dd>
          </div>
        ))}
      </dl>

      <ol className="space-y-2" aria-label="Receipts">
        {batch.receipts.map((r) => (
          <li key={r.receiptNo} className="rounded-2xl border border-[#326273]/15 bg-white">
            <details className="group">
              <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-2xl px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
                <span className="min-w-0">
                  <span className="block truncate text-sm font-bold text-[#0c3e48]">{r.payee.name}</span>
                  <span className="block font-mono text-[13px] text-[#326273]">{r.receiptNo}{r.reference ? ` · ${r.reference}` : ''}</span>
                </span>
                <span className="font-mono text-sm font-bold tabular-nums text-[#0c3e48]">{usdc(r.sendMinor)}</span>
              </summary>
              <dl className="grid gap-x-4 gap-y-1.5 border-t border-[#326273]/10 px-4 py-3 text-sm sm:grid-cols-[auto_1fr]">
                {receiptRows(r).map((row) => (
                  <div key={row.label} className="contents">
                    <dt className="text-[#326273]">{row.label}</dt>
                    <dd className="min-w-0 break-words font-medium text-[#0c3e48]">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap gap-2 border-t border-[#326273]/10 pt-4">
        <a href={`/api/wallet/batches/${encodeURIComponent(batchId)}/receipts?format=csv`} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
          <Download className="h-4 w-4" aria-hidden="true" />Download for your accountant
        </a>
        {batch.verifyUrl ? (
          <a href={batch.verifyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
            <ExternalLink className="h-4 w-4" aria-hidden="true" />Check the transaction on Sui
          </a>
        ) : null}
        <PrimaryButton type="button" onClick={onNew}>Make another batch</PrimaryButton>
        <QuietButton type="button" onClick={() => window.print()}>Print</QuietButton>
      </div>
    </div>
  );
}

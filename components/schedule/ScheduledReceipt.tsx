'use client';

import Link from 'next/link';
import { ArrowLeft, ExternalLink } from 'lucide-react';

import DashPageHeader from '@/components/dashboard/DashPageHeader';
import LocalTime from '@/components/LocalTime';
import { Loading, Note, Pill, useLoad } from '@/components/wallet/parts';
import { suiVisionTxUrl } from '@/lib/explorer';
import { formatUsdc } from '@/lib/fees/copy';
import { RUN_STATE } from '@/lib/schedule/rules';
import type { RunView } from '@/lib/schedule/views';

/** Declared once: useLoad asks again whenever this function changes. */
const explain = (status: number, text: string) => (status === 404 ? 'There is no such scheduled payment in your business.' : text || 'The receipt could not be loaded.');
const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;

/**
 * The receipt of a scheduled run that was paid automatically: each payment, its
 * amount, the fee the network charged for it up to the bound shown, and the
 * transaction. (A run the owners approved is a batch, and its receipt is the
 * batch's.) Another business's run reads as absent.
 */
export default function ScheduledReceipt({ runId }: { runId: string }) {
  const { data, error, loading } = useLoad<{ run: RunView }>(`/api/wallet/schedules/runs/${encodeURIComponent(runId)}`, 'The receipt could not be loaded.', explain);
  const run = data?.run ?? null;
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <Link href="/dashboard/history" className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-[#1F4452] hover:underline">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        All history
      </Link>
      <DashPageHeader kicker="Receipt" title="Scheduled payment" />
      <section className="dash-surface p-4 sm:p-6">
        {loading ? (
          <Loading label="Reading the receipt…" />
        ) : error || !run ? (
          <Note tone="error">{error ?? 'There is no such scheduled payment in your business.'}</Note>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-extrabold text-[#0c3e48]">{run.scheduleName}</h2>
                <p className="mt-1 text-sm text-[#326273]">Due <LocalTime value={run.dueAt} /> · {run.ranAs === 'auto' ? 'Paid automatically, inside your owners’ allowance' : 'Approved by your owners'}</p>
              </div>
              <Pill tone={run.tone}>{RUN_STATE[run.status].label}</Pill>
            </div>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <div>
                <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Payments</dt>
                <dd className="mt-0.5 text-sm font-bold tabular-nums text-[#0c3e48]">{run.itemCount}</dd>
              </div>
              <div>
                <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Paid</dt>
                <dd className="mt-0.5 text-sm font-bold tabular-nums text-[#0c3e48]">{usdc(run.totalMinor)}</dd>
              </div>
              <div>
                <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Splash fee, at most</dt>
                <dd className="mt-0.5 text-sm font-bold tabular-nums text-[#0c3e48]">{usdc(run.feeMinor)}</dd>
              </div>
            </dl>
            {run.payments && run.payments.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-[#326273]/12 bg-white">
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <caption className="sr-only">The payments of this run</caption>
                  <thead>
                    <tr className="border-b border-[#326273]/12 text-[13px] text-[#326273]">
                      <th scope="col" className="px-3 py-2 font-semibold">Payee</th>
                      <th scope="col" className="px-3 py-2 text-right font-semibold">Amount</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Status</th>
                      <th scope="col" className="px-3 py-2 font-semibold">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.payments.map((p) => (
                      <tr key={p.position} className="border-b border-[#326273]/8 last:border-0">
                        <th scope="row" className="px-3 py-2.5 font-semibold text-[#0c3e48]">{p.payeeName}<span className="ml-2 font-mono text-[12px] font-normal text-[#326273]">{p.masked}</span></th>
                        <td className="px-3 py-2.5 text-right font-bold tabular-nums text-[#0c3e48]">{usdc(p.amountMinor)}</td>
                        <td className="px-3 py-2.5 text-[#1F4452]">{p.status === 'paid' ? 'Paid' : p.status === 'failed' ? 'Not paid' : p.status === 'submitting' ? 'On its way' : 'Waiting'}{p.error ? <span className="block text-[13px] text-[var(--error)]">{p.error}</span> : null}</td>
                        <td className="px-3 py-2.5">
                          {p.digest ? (
                            <a href={suiVisionTxUrl(p.digest)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 font-mono text-[12px] font-semibold text-[#0d6370] hover:underline">
                              {p.digest.slice(0, 8)}…
                              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                              <span className="sr-only">Open the transaction in the explorer</span>
                            </a>
                          ) : (
                            <span className="text-[#326273]">None</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            {run.reason ? <Note tone="warn">{run.reason}</Note> : null}
          </div>
        )}
      </section>
    </div>
  );
}

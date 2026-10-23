'use client';

import { useState } from 'react';
import { BadgeCheck, Database, Loader2 } from 'lucide-react';

import { suiVisionTxUrl } from '@/lib/explorer';
import type { DailyAuditBatch } from '@/lib/server/audit-batches';

type Props = {
  initialBatches: DailyAuditBatch[];
};

type Check = { state: 'checking' } | { state: 'verified' } | { state: 'failed'; message: string };

/**
 * Staff view of the daily audit batches: each day's Merkle root, where it is
 * stored and anchored, and a per-settlement inclusion check. The check runs
 * the same proof the batch job wrote: Merkle inclusion, the Walrus copy, and
 * the Sui anchor.
 */
export default function AdminAuditBatches({ initialBatches }: Props) {
  const [checks, setChecks] = useState<Record<string, Check>>({});

  async function verify(batchId: string, transferId: string) {
    const key = `${batchId}:${transferId}`;
    setChecks((current) => ({ ...current, [key]: { state: 'checking' } }));
    try {
      const response = await fetch('/api/audit-batches/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batchId, transferId }),
      });
      const body = (await response.json()) as { verified?: boolean; error?: string };
      setChecks((current) => ({
        ...current,
        [key]: body.verified
          ? { state: 'verified' }
          : { state: 'failed', message: body.error ?? 'The proof did not verify.' },
      }));
    } catch {
      setChecks((current) => ({
        ...current,
        [key]: { state: 'failed', message: 'Could not reach the server. Try again.' },
      }));
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-3xl font-black tracking-[-0.03em] text-[#1f4350]">Audit batches</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#326273]">
          One batch per business day, covering every workspace&apos;s settlements. Check that a settlement is in
          its day&apos;s batch, that the batch is stored on Walrus, and that its root is anchored on Sui.
        </p>
      </header>

      {initialBatches.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-[#326273]/25 bg-white p-6 text-sm text-[#326273]">
          No batch yet. The audit-batch cron job writes one after a day with completed settlements.
        </div>
      ) : (
        <ul className="space-y-4">
          {initialBatches.map((batch) => (
            <li key={batch.id} className="rounded-2xl border border-[#326273]/10 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-bold text-[#1f4350]">
                    <Database className="h-4 w-4 text-[#237284]" aria-hidden="true" />
                    {batch.date}, {batch.settlementCount} settlement{batch.settlementCount === 1 ? '' : 's'}
                  </div>
                  <div className="mt-1 break-all font-mono text-[13px] text-[#326273]">Merkle root {batch.merkleRoot}</div>
                  <div className="mt-1 text-[13px] text-[#326273]">
                    Walrus {batch.walrusMode === 'live' ? 'live' : 'demo'}, Seal {batch.sealMode === 'live' ? 'live' : 'demo'}
                  </div>
                </div>
                <a
                  href={suiVisionTxUrl(batch.anchorDigest)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-lg border border-[#5C9EAD]/40 px-3 py-2 text-[13px] font-bold text-[#326273] hover:border-[#5C9EAD]"
                >
                  Open anchor transaction
                </a>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {batch.leaves.map((leaf) => {
                  const check = checks[`${batch.id}:${leaf.transferId}`];
                  return (
                    <div key={leaf.transferId} className="flex flex-col gap-1">
                      <button
                        type="button"
                        disabled={check?.state === 'checking'}
                        onClick={() => void verify(batch.id, leaf.transferId)}
                        className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-[#326273] px-3 py-2 text-[13px] font-bold text-white disabled:opacity-60"
                      >
                        {check?.state === 'checking' ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        Check {leaf.transferId.slice(0, 14)}
                      </button>
                      <span className="text-[12px] text-[#326273]" aria-live="polite">
                        {check?.state === 'verified' && 'In the batch, on Walrus, and anchored'}
                        {check?.state === 'failed' && check.message}
                      </span>
                    </div>
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

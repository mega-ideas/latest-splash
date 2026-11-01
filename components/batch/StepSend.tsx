'use client';

import { useEffect, useRef } from 'react';
import { CircleAlert, Loader2 } from 'lucide-react';

import { declinedByLabel } from '@/lib/team/declined-by';
import { QuietButton } from '../transfer/ui';
import { call, type BatchView } from './api';

const DEAD_TITLE: Record<string, string> = { failed: 'The batch did not go through', expired: 'The batch expired', withdrawn: 'The batch was withdrawn' };

/**
 * Step 4 of a batch (v2 brief 5.6): the signed transaction is on its way. The
 * owners have signed; Splash sends the transaction and waits for the network
 * to confirm it. This page asks again every few seconds and goes on to the
 * receipts the moment the batch is paid. A batch that did not go through says
 * so, and nothing was paid: every payment of a batch is made together or not at all.
 */
export default function StepSend({ batch, onBatch, onSettled, onRestart }: { batch: BatchView; onBatch: (batch: BatchView) => void; onSettled: () => void; onRestart: () => void }) {
  const done = useRef(false);

  useEffect(() => {
    if (batch.status === 'settled' && !done.current) {
      done.current = true;
      onSettled();
      return;
    }
    if (['settled', 'failed', 'expired', 'declined', 'withdrawn'].includes(batch.status)) return;
    const timer = window.setInterval(async () => {
      const answer = await call<{ batch?: BatchView }>(`/api/wallet/batches/${encodeURIComponent(batch.id)}`);
      if (answer.body?.batch) onBatch(answer.body.batch);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [batch.id, batch.status, onBatch, onSettled]);

  const dead = ['failed', 'expired', 'declined', 'withdrawn'].includes(batch.status);
  return (
    <div className="space-y-4" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${dead ? 'bg-[var(--error-bg)] text-[var(--error)]' : 'bg-[var(--warn-bg)] text-[var(--warn-ink)]'}`}>
          {dead ? <CircleAlert className="h-5 w-5" aria-hidden="true" /> : <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
        </span>
        <div>
          <h2 className="text-xl font-extrabold text-[#0c3e48]">{dead ? (batch.status === 'declined' ? declinedByLabel(batch.declinedBy) : DEAD_TITLE[batch.status] ?? 'The batch did not go through') : 'Sending the batch'}</h2>
          <p className="text-sm text-[#326273]">
            {dead
              ? 'Nothing was paid: every payment in a batch is made together or not at all. You can start the batch again.'
              : `The owners have signed. Splash is sending all ${batch.rowCount} payments in one transaction and waiting for the network to confirm it.`}
          </p>
        </div>
      </div>
      {dead ? <QuietButton type="button" onClick={onRestart}>Start a new batch</QuietButton> : null}
    </div>
  );
}

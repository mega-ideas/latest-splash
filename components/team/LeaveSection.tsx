'use client';

import { useState } from 'react';

import { call, errorText } from '@/components/transfer/api';
import { QuietButton } from '@/components/transfer/ui';
import { Note } from '@/components/wallet/parts';
import type { LeaveStatusWire } from '@/lib/team/view';

/**
 * Leaving the business, from the person's own settings. They ask; an owner
 * decides. Nothing changes when they ask: they keep their access, and any
 * spending rule they hold, until an owner approves. A declined request is said
 * in words and they can ask again. The only owner is told why they cannot.
 */
export default function LeaveSection({ leave, onChanged }: { leave: LeaveStatusWire; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(request: () => ReturnType<typeof call>, failure: string) {
    setBusy(true);
    setError(null);
    const answer = await request();
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, failure));
      return;
    }
    onChanged();
  }

  return (
    <section aria-labelledby="team-leave" className="space-y-2 border-t border-[#326273]/12 pt-4">
      <h3 id="team-leave" className="text-[13px] font-extrabold text-[#0c3e48]">Leave this business</h3>
      {leave.state === 'pending' ? (
        <>
          <Note>{leave.message}</Note>
          <QuietButton type="button" disabled={busy} onClick={() => void run(() => call('/api/team/leave', { method: 'DELETE' }), 'Your request was not withdrawn. Nothing was changed.')}>
            {busy ? 'Working…' : 'Withdraw my request'}
          </QuietButton>
        </>
      ) : (
        <>
          {leave.state === 'declined' ? <Note tone="warn">{leave.message}</Note> : null}
          {leave.canRequest ? (
            <>
              <Note>
                You can ask the owners to let you leave. Nothing changes when you ask: you keep your access, and any spending rule you hold, until an owner approves. If they do, you lose access at once.
              </Note>
              <QuietButton type="button" disabled={busy} onClick={() => void run(() => call('/api/team/leave', { body: {} }), 'Your request was not sent. Nothing was changed.')}>
                {busy ? 'Sending…' : leave.state === 'declined' ? 'Ask again' : 'Ask to leave'}
              </QuietButton>
            </>
          ) : leave.message && leave.state === 'none' ? (
            <Note>{leave.message}</Note>
          ) : null}
        </>
      )}
      {error ? <Note tone="error">{error}</Note> : null}
    </section>
  );
}

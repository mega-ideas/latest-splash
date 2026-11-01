'use client';

import { useState } from 'react';

import LocalTime from '@/components/LocalTime';
import { call, errorText } from '@/components/transfer/api';
import { PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Note, Pill } from '@/components/wallet/parts';
import { ROLE_NAME, type LeaveRequestWire } from '@/lib/team/view';

/**
 * Requests to leave, for the owners and the Finance lead. Nothing has changed
 * for the person yet: they keep their access until a request is approved. The
 * buttons are offered only where the server would accept them (canDecide comes
 * from the same rule), and approving asks first because it ends their access at once.
 */
export default function LeaveRequests({ requests, onChanged }: { requests: LeaveRequestWire[]; onChanged: () => void }) {
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (requests.length === 0 && !done) return null;

  async function decide(r: LeaveRequestWire, decision: 'approve' | 'decline') {
    setBusy(`${decision}:${r.id}`);
    setError(null);
    setDone(null);
    const answer = await call<{ note?: string | null }>(`/api/team/leave-requests/${encodeURIComponent(r.id)}/${decision}`, { method: 'POST', body: {} });
    setBusy(null);
    if (!answer.ok) {
      setError(errorText(answer, 'That did not work. Nothing was changed.'));
      return;
    }
    setAsking(null);
    setDone(
      decision === 'approve'
        ? `${r.name} left the team and no longer has access. ${answer.body?.note ?? ''}`.trim()
        : `You declined ${r.name}’s request. ${r.name} is still on the team and was told so.`,
    );
    onChanged();
  }

  return (
    <section aria-labelledby="team-leave-requests" className="space-y-2">
      <h3 id="team-leave-requests" className="text-[13px] font-extrabold text-[#0c3e48]">Requests to leave{requests.length > 0 ? ` (${requests.length})` : ''}</h3>
      {requests.length > 0 ? <p className="text-[13px] leading-5 text-[#326273]">These people have asked to leave. Until you approve, they keep their access and any spending rule they hold.</p> : null}
      <ul className="space-y-2" aria-label="Requests to leave">
        {requests.map((r) => (
          <li key={r.id} className="space-y-2 rounded-xl bg-[#F6F0ED] px-3 py-2.5 text-sm text-[#1F4452]">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 basis-48">
                <span className="block truncate font-semibold">{r.name}</span>
                <span className="block break-all text-[13px] text-[#326273]">{r.email}. Asked <LocalTime value={r.createdAt} format="datetime" />.</span>
              </span>
              <Pill tone="ok">{ROLE_NAME[r.role]}</Pill>
            </div>
            {r.canDecide ? (
              asking === r.id ? (
                <div role="group" aria-label={`Approve ${r.name}’s request`} className="space-y-2">
                  <p className="text-[13px] leading-5 text-[#1F4452]">
                    Approve? {r.name} loses access to this business at once. Their place in charge, the Finance lead role and any Add funds or Withdraw access end, and a spending rule they hold is taken back (the wallet’s owners sign that).
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <PrimaryButton type="button" autoFocus disabled={busy !== null} onClick={() => void decide(r, 'approve')}>
                      {busy === `approve:${r.id}` ? 'Approving…' : `Approve and remove ${r.name}`}
                    </PrimaryButton>
                    <QuietButton type="button" disabled={busy !== null} onClick={() => setAsking(null)}>Not now</QuietButton>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <PrimaryButton type="button" disabled={busy !== null} onClick={() => setAsking(r.id)} aria-label={`Approve ${r.name}’s request to leave`}>Approve</PrimaryButton>
                  <QuietButton type="button" disabled={busy !== null} onClick={() => void decide(r, 'decline')} aria-label={`Decline ${r.name}’s request to leave`}>
                    {busy === `decline:${r.id}` ? 'Declining…' : 'Decline'}
                  </QuietButton>
                </div>
              )
            ) : (
              <p className="text-[13px] leading-5 text-[#326273]">{r.whyNot}</p>
            )}
          </li>
        ))}
      </ul>
      {error ? <Note tone="error">{error}</Note> : null}
      <div aria-live="polite">{done ? <Note>{done}</Note> : null}</div>
    </section>
  );
}

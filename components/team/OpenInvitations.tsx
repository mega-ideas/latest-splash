'use client';

import { useState } from 'react';

import LocalTime from '@/components/LocalTime';
import { call, errorText } from '@/components/transfer/api';
import { QuietButton } from '@/components/transfer/ui';
import { Note, Pill } from '@/components/wallet/parts';
import { ROLE_NAME, type InvitationWire } from '@/lib/team/view';

/**
 * The invitations that are still open: who they went to, the role, who sent
 * them and when they end. The sender (or an owner) can withdraw one; after that
 * it can no longer be accepted. Past-end ones are closed by the server and do
 * not appear.
 */
export default function OpenInvitations({ invitations, onChanged }: { invitations: InvitationWire[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (invitations.length === 0) return null;

  async function withdraw(i: InvitationWire) {
    setBusy(i.id);
    setError(null);
    const answer = await call(`/api/team/invitations/${encodeURIComponent(i.id)}`, { method: 'DELETE' });
    setBusy(null);
    if (!answer.ok) {
      setError(errorText(answer, 'The invitation was not withdrawn. Nothing was changed.'));
      return;
    }
    onChanged();
  }

  return (
    <section aria-labelledby="team-invitations" className="space-y-2">
      <h3 id="team-invitations" className="text-[13px] font-extrabold text-[#0c3e48]">Open invitations ({invitations.length})</h3>
      <ul className="space-y-2" aria-label="Open invitations">
        {invitations.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-[#F6F0ED] px-3 py-2.5 text-sm text-[#1F4452]">
            <span className="min-w-0 flex-1 basis-48">
              <span className="block break-all font-semibold">{i.email}</span>
              <span className="block text-[13px] text-[#326273]">
                Invited by {i.invitedByName}. Ends <LocalTime value={i.expiresAt} format="date" />.
              </span>
            </span>
            <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Pill tone="wait">Waiting</Pill>
              <Pill tone="ok">{ROLE_NAME[i.role]}</Pill>
              {i.canWithdraw ? (
                <QuietButton type="button" disabled={busy !== null} onClick={() => void withdraw(i)} aria-label={`Withdraw the invitation to ${i.email}`}>
                  {busy === i.id ? 'Withdrawing…' : 'Withdraw'}
                </QuietButton>
              ) : (
                <span className="text-[13px] text-[#326273]">An owner withdraws this one.</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      {error ? <Note tone="error">{error}</Note> : null}
    </section>
  );
}

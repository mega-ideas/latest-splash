'use client';

import { useState } from 'react';

import LocalTime from '@/components/LocalTime';
import { call, errorText } from '@/components/transfer/api';
import { QuietButton } from '@/components/transfer/ui';
import { Note, Pill } from '@/components/wallet/parts';
import { INVITE_EMAIL_WORDS } from '@/lib/team/invitation-email';
import { PLAIN_DATE, ROLE_NAME, type InvitationWire } from '@/lib/team/view';

/**
 * The invitations that are still open: who they went to, the role, who sent
 * them and when they end. The sender (or an owner) can withdraw one; after that
 * it can no longer be accepted. Past-end ones are closed by the server and do
 * not appear.
 */
export default function OpenInvitations({ invitations, onChanged }: { invitations: InvitationWire[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  if (invitations.length === 0) return null;

  async function sendEmailAgain(i: InvitationWire) {
    setSending(i.id);
    setError(null);
    const answer = await call(`/api/team/invitations/${encodeURIComponent(i.id)}/email`, { method: 'POST', body: {} });
    setSending(null);
    if (!answer.ok) setError(errorText(answer, 'The email was not sent. Nothing was changed.'));
    // Whatever happened, the list says how the email stands now.
    onChanged();
  }

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
                Invited by {i.invitedByName}. Ends <LocalTime value={i.expiresAt} format="date" options={PLAIN_DATE} />.
              </span>
            </span>
            <span className="basis-full">
              <EmailState i={i} sending={sending === i.id} anyBusy={busy !== null || sending !== null} onSend={() => void sendEmailAgain(i)} />
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

/**
 * How the invitation's email stands, in words. A failed send and a missing email
 * set-up are shown loudly (an alert, not a hint) because the owner would
 * otherwise assume the person was told. Only an owner sees the button.
 */
function EmailState({ i, sending, anyBusy, onSend }: { i: InvitationWire; sending: boolean; anyBusy: boolean; onSend: () => void }) {
  const d = i.delivery;
  if (d.state === 'sent') {
    return (
      <span className="block text-[13px] text-[#326273]">
        {d.message}
        {d.sentAt ? <> on <LocalTime value={d.sentAt} format="date" options={PLAIN_DATE} /></> : null}.
      </span>
    );
  }
  if (d.state === 'sending') return <span className="block text-[13px] text-[#326273]">{d.message}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {d.state === 'not_sent' ? (
        <span className="text-[13px] text-[#326273]">{d.message}</span>
      ) : (
        <span role="alert" className="min-w-0 flex-1 basis-64 rounded-lg border border-[var(--error)]/30 bg-[var(--error-bg)] px-3 py-2 text-[13px] font-medium leading-5 text-[var(--error)]">{d.message}</span>
      )}
      {d.canResend ? (
        <QuietButton type="button" disabled={anyBusy} onClick={onSend} aria-label={`${INVITE_EMAIL_WORDS.resend} to ${i.email}`}>
          {sending ? 'Sending…' : INVITE_EMAIL_WORDS.resend}
        </QuietButton>
      ) : (
        <span className="text-[13px] text-[#326273]">An owner can send the email.</span>
      )}
    </span>
  );
}

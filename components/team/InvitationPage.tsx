'use client';

import { MailOpen } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import LocalTime from '@/components/LocalTime';
import { call, errorText } from '@/components/transfer/api';
import { PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Loading, Note } from '@/components/wallet/parts';
import { PLAIN_DATE, ROLE_SENTENCE, roleWithArticle, type MyInvitationWire } from '@/lib/team/view';

type Shown =
  | { kind: 'loading' }
  | { kind: 'open'; invitation: MyInvitationWire }
  | { kind: 'closed'; message: string }
  | { kind: 'refused'; message: string; verify: boolean };

/**
 * The page behind the link in an invitation email. The person is already signed
 * in (the dashboard sends anyone else to sign in and back here). It shows the
 * invitation only if it was sent to their verified email; for any other
 * account, or an id that does not exist, it says the same thing. A withdrawn,
 * declined or ended invitation says so in plain words. Opening it accepts
 * nothing: Accept is a button the person presses.
 */
export default function InvitationPage({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call<{ state?: string; invitation?: MyInvitationWire; message?: string; code?: string; error?: string }>(`/api/team/invitations/${encodeURIComponent(invitationId)}/status`).then((answer) => {
      if (!live) return;
      const body = answer.body;
      if (answer.ok && body?.state === 'open' && body.invitation) setShown({ kind: 'open', invitation: body.invitation });
      else if (answer.ok && typeof body?.message === 'string') setShown({ kind: 'closed', message: body.message });
      else if (body?.code === 'verify_email') setShown({ kind: 'refused', message: errorText(answer, 'Verify your email address first.'), verify: true });
      else if (answer.status === 0) setShown({ kind: 'refused', message: errorText(answer, ''), verify: false });
      else setShown({ kind: 'refused', message: 'We could not find this invitation for the account you are signed in with. Sign in with the email address the invitation was sent to.', verify: false });
    });
    return () => {
      live = false;
    };
  }, [invitationId]);

  async function answer(decision: 'accept' | 'decline') {
    setBusy(decision);
    setError(null);
    const result = await call(`/api/team/invitations/${encodeURIComponent(invitationId)}/${decision}`, { method: 'POST', body: {} });
    setBusy(null);
    if (!result.ok) {
      setError(errorText(result, 'That did not work. Nothing was changed.'));
      return;
    }
    if (decision === 'accept') {
      router.push('/dashboard');
      router.refresh();
      return;
    }
    setShown({ kind: 'closed', message: 'You declined this invitation. If you change your mind, ask the person who sent it to send a new one.' });
  }

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-6 sm:py-10">
      <section aria-labelledby="invitation-page-title" className="dash-surface space-y-4 p-4 sm:p-6">
        <div className="flex items-center gap-2">
          <MailOpen aria-hidden="true" className="h-5 w-5 shrink-0 text-[#0d6370]" />
          <h1 id="invitation-page-title" className="text-lg font-extrabold text-[#0c3e48]">Your invitation</h1>
        </div>

        {shown.kind === 'loading' ? <Loading label="Opening your invitation" /> : null}

        {shown.kind === 'open' ? (
          <div className="space-y-4">
            <p className="text-[15px] leading-6 text-[#1F4452]">
              <span className="font-semibold">{shown.invitation.invitedByName}</span> ({shown.invitation.invitedByEmailMask}) invited you to join{' '}
              <span className="font-semibold">{shown.invitation.businessName}</span> as {roleWithArticle(shown.invitation.role)}.
            </p>
            <p className="text-[13px] leading-5 text-[#326273]">
              {ROLE_SENTENCE[shown.invitation.role]} It ends <LocalTime value={shown.invitation.expiresAt} format="date" options={PLAIN_DATE} />. Opening this page did not accept it: you choose below.
            </p>
            {shown.invitation.blockedReason ? <Note>{shown.invitation.blockedReason}</Note> : null}
            <div className="flex flex-wrap gap-2">
              {shown.invitation.canAccept ? (
                <PrimaryButton type="button" disabled={busy !== null} onClick={() => void answer('accept')}>
                  {busy === 'accept' ? 'Joining…' : 'Accept the invitation'}
                </PrimaryButton>
              ) : null}
              <QuietButton type="button" disabled={busy !== null} onClick={() => void answer('decline')}>
                {busy === 'decline' ? 'Declining…' : 'Decline'}
              </QuietButton>
            </div>
            {error ? <Note tone="error">{error}</Note> : null}
          </div>
        ) : null}

        {shown.kind === 'closed' ? (
          <div className="space-y-3">
            <p role="status" className="text-[15px] leading-6 text-[#1F4452]">{shown.message}</p>
            <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm font-semibold text-[#0d6370] underline underline-offset-2">Go to Home</Link>
          </div>
        ) : null}

        {shown.kind === 'refused' ? (
          <div className="space-y-3">
            <p role="alert" className="text-[15px] leading-6 text-[#1F4452]">{shown.message}</p>
            <div className="flex flex-wrap items-center gap-x-5">
              {shown.verify ? (
                <Link href="/verify-email" className="inline-flex min-h-11 items-center text-sm font-semibold text-[#0d6370] underline underline-offset-2">Get a new confirmation email</Link>
              ) : null}
              <Link href="/dashboard" className="inline-flex min-h-11 items-center text-sm font-semibold text-[#0d6370] underline underline-offset-2">Go to Home</Link>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

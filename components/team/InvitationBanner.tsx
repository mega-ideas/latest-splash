'use client';

import { MailOpen } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import LocalTime from '@/components/LocalTime';
import { call, errorText } from '@/components/transfer/api';
import { PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Note } from '@/components/wallet/parts';
import { PLAIN_DATE, roleWithArticle, type MyInvitationWire } from '@/lib/team/view';

/**
 * Invitations to join a business, shown to the person they were sent to after
 * they sign in (the server finds them by the signed-in person's verified email;
 * nothing in the page chooses whose they are). Accepting joins the business and
 * reloads the workspace. A person who already belongs to a business is told so
 * plainly, without naming it, and can only decline. Reading fails quietly: no
 * answer means no banner, never a wrong one.
 */
export default function InvitationBanner() {
  const router = useRouter();
  const pathname = usePathname();
  const [invitations, setInvitations] = useState<MyInvitationWire[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call<{ invitations: MyInvitationWire[] }>('/api/team/invitations/mine').then((answer) => {
      if (live && answer.ok && Array.isArray(answer.body?.invitations)) setInvitations(answer.body.invitations);
    });
    return () => {
      live = false;
    };
  }, []);

  // The page behind the link in the invitation email shows its own invitation with the same two buttons; two sets would only confuse.
  if (invitations.length === 0 || pathname?.startsWith('/dashboard/invitation/')) return null;

  async function answer(i: MyInvitationWire, decision: 'accept' | 'decline') {
    setBusy(`${decision}:${i.id}`);
    setError(null);
    const result = await call(`/api/team/invitations/${encodeURIComponent(i.id)}/${decision}`, { method: 'POST', body: {} });
    setBusy(null);
    if (!result.ok) {
      setError(errorText(result, 'That did not work. Nothing was changed.'));
      return;
    }
    if (decision === 'accept') {
      // A new business, a new role: start the workspace afresh.
      router.push('/dashboard');
      router.refresh();
      return;
    }
    setInvitations((current) => current.filter((x) => x.id !== i.id));
  }

  return (
    <section aria-labelledby="invitation-heading" className="mb-5 space-y-3 rounded-lg border border-[#0d6370]/40 bg-white px-4 py-3">
      <div className="flex items-center gap-2">
        <MailOpen aria-hidden="true" className="h-4 w-4 shrink-0 text-[#0d6370]" />
        <h2 id="invitation-heading" className="text-[13px] font-bold text-[#0c3e48]">{invitations.length === 1 ? 'You have been invited to join a business' : `You have ${invitations.length} invitations`}</h2>
      </div>
      <ul className="space-y-3">
        {invitations.map((i) => (
          <li key={i.id} className="space-y-2">
            <p className="text-[13px] leading-5 text-[#1F4452]">
              <span className="font-semibold">{i.invitedByName}</span> ({i.invitedByEmailMask}) invited you to join <span className="font-semibold">{i.businessName}</span> as {roleWithArticle(i.role)}. Ends <LocalTime value={i.expiresAt} format="date" options={PLAIN_DATE} />.
            </p>
            {i.blockedReason ? <p className="text-[13px] leading-5 text-[#326273]">{i.blockedReason}</p> : null}
            <div className="flex flex-wrap gap-2">
              {i.canAccept ? (
                <PrimaryButton type="button" disabled={busy !== null} onClick={() => void answer(i, 'accept')} aria-label={`Accept the invitation to join ${i.businessName}`}>
                  {busy === `accept:${i.id}` ? 'Joining…' : 'Accept'}
                </PrimaryButton>
              ) : null}
              <QuietButton type="button" disabled={busy !== null} onClick={() => void answer(i, 'decline')} aria-label={`Decline the invitation to join ${i.businessName}`}>
                {busy === `decline:${i.id}` ? 'Declining…' : 'Decline'}
              </QuietButton>
            </div>
          </li>
        ))}
      </ul>
      {error ? <Note tone="error">{error}</Note> : null}
    </section>
  );
}

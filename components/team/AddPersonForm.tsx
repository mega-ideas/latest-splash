'use client';

import { useState } from 'react';

import { call, errorText } from '@/components/transfer/api';
import { Field, PrimaryButton, SelectInput, TextInput } from '@/components/transfer/ui';
import { Note } from '@/components/wallet/parts';
import type { MembershipRole } from '@/lib/membership-roles';
import { INVITE_EMAIL_WORDS } from '@/lib/team/invitation-email';
import { ADD_CHOICES, INVITATION_DAYS, ROLE_NAME, ROLE_SENTENCE, roleChoicesFor, roleWithArticle, type Manager } from '@/lib/team/view';

type Mode = 'invite' | 'direct';

/**
 * Add a person (Sky's decision of 1 Nov): the owner chooses between asking and
 * adding. An invitation waits for the person to accept; adding directly has no
 * step on their side, so the owner confirms they have the right person first.
 * The server refuses a direct add without that confirmation as well.
 *
 * Invitation is the first choice and the one preselected: it grants nothing
 * until the person says yes. The answer to sending is the same whether or not
 * the address has an account, and the page says so rather than guess.
 */
export default function AddPersonForm({ manager, onChanged }: { manager: Manager; onChanged: () => void }) {
  const choices = roleChoicesFor(manager);
  const [mode, setMode] = useState<Mode>('invite');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MembershipRole>('viewer');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [mailProblem, setMailProblem] = useState<string | null>(null);
  if (choices.length === 0) return null;

  const address = email.trim();
  const ready = address.length > 0 && !busy && (mode === 'invite' || confirmed);

  async function submit() {
    setBusy(true);
    setError(null);
    setDone(null);
    setMailProblem(null);
    const answer =
      mode === 'invite'
        ? await call<{ created?: boolean; delivery?: { state?: string; sent?: boolean } }>('/api/team/invitations', { body: { email: address, role } })
        : await call('/api/team', { body: { email: address, role, confirmed: true } });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, mode === 'invite' ? 'The invitation was not sent. Nothing was changed.' : 'That person was not added. Nothing was changed.'));
      return;
    }
    if (mode === 'invite') {
      const body = answer.body as { created?: boolean; delivery?: { state?: string } } | null;
      const created = body?.created !== false;
      const state = body?.delivery?.state;
      // The invitation stands whatever happened to the email, and the owner is told which it was.
      setDone(
        created
          ? `Invitation sent to ${address} as ${roleWithArticle(role)}. ${state === 'sent' ? 'We emailed them, and they' : 'They'} see it after they sign in with that email, and it ends in ${INVITATION_DAYS} days.`
          : `${address} already has an open invitation as ${roleWithArticle(role)}. It is unchanged.`,
      );
      setMailProblem(created && state !== undefined && state !== 'sent' && state !== 'sending' ? (state === 'not_configured' ? INVITE_EMAIL_WORDS.not_configured : INVITE_EMAIL_WORDS.failed) : null);
    } else {
      setDone(`${address} was added as ${roleWithArticle(role)}.`);
    }
    setEmail('');
    setConfirmed(false);
    onChanged();
  }

  return (
    <form
      className="space-y-4 rounded-xl border border-[#326273]/15 p-3 sm:p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) void submit();
      }}
    >
      <h3 className="text-[13px] font-extrabold text-[#0c3e48]">Add a person</h3>

      <fieldset className="space-y-2">
        <legend className="text-[13px] font-semibold text-[#1F4452]">How do you want to add them?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['invite', 'direct'] as const).map((m) => {
            const text = ADD_CHOICES[m];
            const chosen = mode === m;
            return (
              <label
                key={m}
                className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[#0d6370] ${
                  chosen ? 'border-[#0d6370] bg-[#f4f8fa]' : 'border-[#326273]/20 bg-white hover:border-[#0d6370]/60'
                }`}
              >
                <input type="radio" name="team-add-mode" value={m} checked={chosen} onChange={() => setMode(m)} className="mt-1 h-4 w-4 shrink-0 accent-[#0d6370]" />
                <span className="min-w-0">
                  <span className="block text-sm font-bold text-[#0c3e48]">{text.title}</span>
                  <span className="mt-0.5 block text-[13px] leading-5 text-[#326273]">{text.body}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <Field label="Email" htmlFor="team-add-email" hint={mode === 'direct' ? 'Needs a verified Splash account' : undefined}>
          <TextInput id="team-add-email" type="email" autoComplete="off" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Role" htmlFor="team-add-role">
          <SelectInput id="team-add-role" value={role} onChange={(e) => setRole(e.target.value as MembershipRole)}>
            {choices.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
          </SelectInput>
        </Field>
      </div>
      <p className="text-[13px] leading-5 text-[#326273]">{ROLE_SENTENCE[role]}</p>

      {mode === 'direct' ? (
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl bg-[#F6F0ED] px-3 py-2.5 text-[13px] font-semibold leading-5 text-[#1F4452]">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5 h-5 w-5 shrink-0 accent-[#0d6370]" />
          {ADD_CHOICES.direct.confirm}
        </label>
      ) : (
        <p className="text-[13px] leading-5 text-[#326273]">
          This works for any email, even one that has no Splash account yet. The invitation waits until that email has signed up and verified, and you see the same answer either way.
        </p>
      )}

      {error ? <Note tone="error">{error}</Note> : null}
      <div aria-live="polite">{done ? <Note>{done}</Note> : null}</div>
      {mailProblem ? <Note tone="error">{mailProblem}</Note> : null}
      <PrimaryButton type="submit" disabled={!ready}>{busy ? (mode === 'invite' ? 'Sending…' : 'Adding…') : ADD_CHOICES[mode].action}</PrimaryButton>
    </form>
  );
}

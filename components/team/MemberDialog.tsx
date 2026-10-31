'use client';

import { useState } from 'react';

import { call, errorText } from '@/components/transfer/api';
import { Field, Modal, PrimaryButton, QuietButton, SelectInput } from '@/components/transfer/ui';
import { Note } from '@/components/wallet/parts';
import type { MembershipRole } from '@/lib/membership-roles';
import { FINANCE_LEAD_NAME, ROLE_NAME, ROLE_SENTENCE, rowControls, type FundsAccessKind, type Manager, type TeamMemberWire } from '@/lib/team/view';

/**
 * One person on the team: their role, what they may do with Add funds and
 * Withdraw, whether they are the Finance lead, and removing them. It offers
 * only what the server would accept from the signed-in person (rowControls);
 * the routes check the same rule again, so a stale page can only be refused.
 *
 * Nothing here is saved by a keystroke: a role is saved by its button, an
 * access switch saves when it is switched and says so, and a removal asks first.
 */
export default function MemberDialog({
  member,
  manager,
  youUserId,
  onClose,
  onChanged,
}: {
  member: TeamMemberWire | null;
  manager: Manager;
  youUserId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [role, setRole] = useState<MembershipRole | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (!member) return null;
  const controls = rowControls({ manager, youUserId }, member);
  const chosen = role ?? member.role;
  const base = `/api/team/members/${encodeURIComponent(member.userId)}`;

  async function run(label: string, request: () => ReturnType<typeof call>, success: string, after?: () => void) {
    setBusy(label);
    setError(null);
    setDone(null);
    const answer = await request();
    setBusy(null);
    if (!answer.ok) {
      setError(errorText(answer, 'That did not work. Nothing was changed.'));
      return;
    }
    setDone(success);
    after?.();
    onChanged();
  }

  const saveRole = () => run('role', () => call(base, { method: 'PATCH', body: { role: chosen } }), `${member!.name} is now ${ROLE_NAME[chosen]}.`, () => setRole(null));
  const setAccess = (access: FundsAccessKind, allowed: boolean) =>
    run(access, () => call(`${base}/access`, { method: 'PUT', body: { access, allowed } }), `${allowed ? 'Allowed' : 'Stopped'}: ${access === 'add_funds' ? 'Add funds' : 'Withdraw'} for ${member!.name}.`);
  const lead = (appoint: boolean) =>
    run('lead', () => call('/api/team/finance-lead', appoint ? { body: { userId: member!.userId } } : { method: 'DELETE' }), appoint ? `${member!.name} is the ${FINANCE_LEAD_NAME}.` : `${member!.name} is no longer the ${FINANCE_LEAD_NAME}.`);
  const remove = () => run('remove', () => call(base, { method: 'DELETE' }), `${member!.name} was removed.`, () => { setConfirmRemove(false); onClose(); });

  const nothing = controls.roles.length === 0 && !controls.remove && !controls.access && controls.financeLead === null;

  return (
    <Modal open onClose={onClose} title={member.name} eyebrow={ROLE_NAME[member.role]}>
      <div className="space-y-5 px-5 pb-5 pt-4 sm:px-6">
        <p className="break-all text-[13px] text-[#326273]">{member.email}</p>
        {nothing ? (
          <Note>{member.userId === youUserId ? 'You cannot change or remove yourself. Another owner can.' : 'Only an owner can change this person.'}</Note>
        ) : null}

        {controls.roles.length > 0 ? (
          <section className="space-y-2" aria-label="Role">
            <Field label="Role" htmlFor="md-role-pick">
              <SelectInput id="md-role-pick" value={chosen} onChange={(e) => setRole(e.target.value as MembershipRole)} disabled={busy !== null}>
                {controls.roles.map((r) => <option key={r} value={r}>{ROLE_NAME[r]}</option>)}
              </SelectInput>
            </Field>
            <p className="text-[13px] leading-5 text-[#326273]">{ROLE_SENTENCE[chosen]}</p>
            {chosen === 'viewer' || chosen === 'admin' ? (
              <p className="text-[13px] leading-5 text-[#1F4452]">Moving someone to {ROLE_NAME[chosen].toLowerCase()} ends their place in charge, the {FINANCE_LEAD_NAME} role and any Add funds or Withdraw access they hold.</p>
            ) : null}
            <PrimaryButton type="button" disabled={busy !== null || chosen === member.role} onClick={() => void saveRole()}>
              {busy === 'role' ? 'Saving…' : 'Save role'}
            </PrimaryButton>
          </section>
        ) : null}

        {controls.access ? (
          <section className="space-y-2" aria-labelledby="md-access">
            <h3 id="md-access" className="text-[13px] font-extrabold text-[#0c3e48]">Add funds and Withdraw</h3>
            <p className="text-[13px] leading-5 text-[#326273]">Only you decide who sees these in the dashboard. Money still moves only when the owners sign.</p>
            {([['add_funds', 'Can add funds', member.addFunds], ['withdraw', 'Can withdraw to the business bank account', member.withdraw]] as const).map(([kind, label, on]) => (
              <label key={kind} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl bg-[#F6F0ED] px-3 text-sm font-semibold text-[#1F4452]">
                <input
                  type="checkbox"
                  className="h-5 w-5 shrink-0 accent-[#0d6370]"
                  checked={on}
                  disabled={busy !== null}
                  onChange={(e) => void setAccess(kind, e.target.checked)}
                />
                {label}
              </label>
            ))}
          </section>
        ) : null}

        {controls.financeLead ? (
          <section className="space-y-2" aria-labelledby="md-lead">
            <h3 id="md-lead" className="text-[13px] font-extrabold text-[#0c3e48]">{FINANCE_LEAD_NAME}</h3>
            <p className="text-[13px] leading-5 text-[#326273]">
              {controls.financeLead === 'appoint'
                ? `One person can be the ${FINANCE_LEAD_NAME}. They add and remove viewers, staff and approvers for you, and nothing else that is an owner’s.`
                : `${member.name} is the ${FINANCE_LEAD_NAME}. Taking the role back ends it at once.`}
            </p>
            <QuietButton type="button" disabled={busy !== null} onClick={() => void lead(controls.financeLead === 'appoint')}>
              {busy === 'lead' ? 'Working…' : controls.financeLead === 'appoint' ? `Make ${FINANCE_LEAD_NAME}` : `Take back ${FINANCE_LEAD_NAME}`}
            </QuietButton>
          </section>
        ) : null}

        {controls.remove ? (
          <section className="space-y-2 border-t border-[#326273]/12 pt-4" aria-labelledby="md-remove">
            <h3 id="md-remove" className="text-[13px] font-extrabold text-[#0c3e48]">Remove from the team</h3>
            {confirmRemove ? (
              <>
                <p className="text-[13px] leading-5 text-[#1F4452]">
                  Remove {member.name}? They lose access to this business at once. Their place in charge, the {FINANCE_LEAD_NAME} role and any Add funds or Withdraw access end, and a spending rule they hold shows as orphaned until the owners take it back.
                </p>
                {member.role === 'admin' ? (
                  <p className="text-[13px] leading-5 text-[#1F4452]">If {member.name} signs for the business wallet, removing them here does not remove them as a signer. A change of signers does, and the owners sign that on their own devices.</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void remove()}
                    className="inline-flex h-11 items-center justify-center rounded-xl bg-[var(--error)] px-5 text-sm font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--error)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {busy === 'remove' ? 'Removing…' : `Remove ${member.name}`}
                  </button>
                  <QuietButton type="button" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Keep them</QuietButton>
                </div>
              </>
            ) : (
              <QuietButton type="button" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>Remove {member.name}</QuietButton>
            )}
          </section>
        ) : null}

        <div aria-live="polite">{done ? <Note>{done}</Note> : null}</div>
        {error ? <Note tone="error">{error}</Note> : null}
      </div>
    </Modal>
  );
}

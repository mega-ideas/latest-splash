'use client';

import { useState } from 'react';
import { Fingerprint, Landmark, UserRound } from 'lucide-react';

import AddPersonForm from '@/components/team/AddPersonForm';
import FinanceLeadNote from '@/components/team/FinanceLeadNote';
import LeaveRequests from '@/components/team/LeaveRequests';
import LeaveSection from '@/components/team/LeaveSection';
import MemberDialog from '@/components/team/MemberDialog';
import OpenInvitations from '@/components/team/OpenInvitations';
import TeamActivity from '@/components/team/TeamActivity';
import { QuietButton } from '@/components/transfer/ui';
import { PersonInCharge, type InCharge } from '@/components/wallet/Migration';
import { Card, Loading, Note, Pill } from '@/components/wallet/parts';
import { teamRows, type SpendWire } from '@/lib/team-rules/view';
import { EXISTING_MEMBERS_FUNDS_NOTE, FINANCE_LEAD_NAME, ROLE_NAME, rowControls, type TeamMemberWire, type TeamWire } from '@/lib/team/view';

type Load<T> = { data: T | null; loading: boolean; error: string | null };

/**
 * The team (v2 brief 5.9, Sky's decision of 31 Oct): the business's owners run
 * it here. An owner adds a person, changes their role, takes it away, chooses
 * who may use Add funds and Withdraw, and may name one Finance lead who can do
 * the adding and changing for viewers, staff and approvers. It is not a Splash
 * support request any more.
 *
 * What each person is offered is lib/team/view.ts's rowControls, which mirrors
 * the server's rules (lib/server/team-admin.ts); the server decides.
 * Someone who manages nothing sees who they are, what they may do with Add
 * funds and Withdraw, and who to ask. The page reads the team once and gives it
 * here, so a change refreshes the whole page.
 */
export default function TeamCard({
  people,
  charge,
  spend,
  walletReady,
  onChanged,
}: {
  people: Load<TeamWire> & { reload: () => void };
  charge: Load<InCharge>;
  spend: SpendWire | null;
  walletReady: boolean;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  // Waiting is not failing: with neither an answer nor an error yet, the card says it is reading, never an empty alert.
  if (people.loading || (!people.data && !people.error)) return <Card id="team" title="Team"><Loading label="Reading your team…" /></Card>;
  if (!people.data) return <Card id="team" title="Team"><Note tone="error">{people.error}</Note></Card>;
  const { you, members, activity, invitations, leaveRequests, leave } = people.data;
  const manager = you.manager;
  const refresh = () => {
    people.reload();
    onChanged();
  };

  if (!manager) {
    return (
      <Card id="team" title="Team">
        <div className="space-y-3">
          <Note>Your owners manage the team. Your own rule, if you have one, is under Spending rules.</Note>
          <p className="flex items-start gap-2 text-[13px] leading-5 text-[#1F4452]">
            <Landmark className="mt-0.5 h-4 w-4 shrink-0 text-[#145d6a]" aria-hidden="true" />
            <span>
              {you.addFunds && you.withdraw
                ? 'You can add funds and withdraw to the business bank account.'
                : you.addFunds
                  ? 'You can add funds. You cannot withdraw. Ask an owner if you need to.'
                  : you.withdraw
                    ? 'You can withdraw to the business bank account. You cannot add funds. Ask an owner if you need to.'
                    : 'You cannot add funds or withdraw. An owner can turn either on for you.'}
            </span>
          </p>
          {charge.data && charge.data.personsInCharge.length > 0 ? <p className="text-[13px] text-[#326273]">In charge: {charge.data.personsInCharge.map((p) => p.name).join(', ')}.</p> : null}
          <LeaveSection leave={leave} onChanged={refresh} />
        </div>
      </Card>
    );
  }

  const rows = teamRows(
    { members: members.map((m) => ({ userId: m.userId, name: m.name, role: m.role })), personsInCharge: charge.data?.personsInCharge ?? [], rules: spend?.rules ?? [] },
    new Date(),
  );
  const ruleOf = new Map(rows.map((r) => [r.userId, r]));
  const lead = members.find((m) => m.financeLead) ?? null;
  const picked = members.find((m) => m.userId === selected) ?? null;

  const access = (m: TeamMemberWire) =>
    m.role === 'viewer' ? null : m.addFunds && m.withdraw ? 'Can add funds and withdraw.' : m.addFunds ? 'Can add funds.' : m.withdraw ? 'Can withdraw.' : 'Cannot add funds or withdraw.';

  return (
    <Card id="team" title="Team">
      <div className="space-y-5">
        <p className="text-[13px] leading-5 text-[#326273]">
          {manager === 'owner'
            ? 'You run the team. Invite people or add them directly, choose their role, decide who can add funds and withdraw, and answer requests to leave. Owners sign for the business wallet; staff pay within the rule they hold, approvers approve, and viewers read.'
            : `You are the ${FINANCE_LEAD_NAME}. You can invite or add people, and change or remove viewers, staff and approvers. Owners, the wallet’s signers, bank accounts and Add funds or Withdraw access stay with the owners, and so do the people an owner put in charge or gave that access.`}
        </p>
        {manager === 'owner' ? <p className="text-[13px] leading-5 text-[#326273]">{EXISTING_MEMBERS_FUNDS_NOTE}</p> : null}

        <ul className="space-y-2" aria-label="Team">
          {members.map((m) => {
            const row = ruleOf.get(m.userId);
            const controls = rowControls({ manager, youUserId: you.userId }, m);
            const can = controls.roles.length > 0 || controls.remove || controls.access || controls.financeLead !== null;
            return (
              <li key={m.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-[#F6F0ED] px-3 py-2.5 text-sm text-[#1F4452]">
                <UserRound className="h-4 w-4 shrink-0 text-[#145d6a]" aria-hidden="true" />
                <span className="min-w-0 flex-1 basis-40">
                  <span className="block truncate font-semibold">{m.name}{m.userId === you.userId ? ' (you)' : ''}</span>
                  <span className="block truncate text-[13px] text-[#326273]">{m.email}</span>
                </span>
                <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
                  <Pill tone="ok">{ROLE_NAME[m.role]}</Pill>
                  {m.financeLead ? <Pill tone="wait">{FINANCE_LEAD_NAME}</Pill> : null}
                  {m.inCharge ? <Pill tone="wait"><Fingerprint className="mr-1 h-3 w-3" aria-hidden="true" />In charge</Pill> : null}
                  {can ? (
                    <QuietButton type="button" className="!h-11" onClick={() => setSelected(m.userId)} aria-label={`Manage ${m.name}`}>Manage</QuietButton>
                  ) : null}
                </span>
                <span className="basis-full text-[13px] leading-5 text-[#326273]">
                  {access(m)}{' '}
                  {walletReady && row?.rule ? `Up to ${row.rule.perPayment} a payment. ${row.rule.state.label}.` : walletReady && row?.canHaveRule ? 'No rule: each payment goes to the owners.' : m.role === 'admin' ? 'Signs for the business wallet once added as a signer.' : m.role === 'viewer' ? 'Reads only.' : ''}
                  {manager === 'finance_lead' && !can && m.userId !== you.userId && m.role !== 'admin' ? ' An owner changes or removes this person.' : ''}
                </span>
              </li>
            );
          })}
        </ul>

        <AddPersonForm manager={manager} onChanged={refresh} />

        <OpenInvitations invitations={invitations} onChanged={refresh} />

        <LeaveRequests requests={leaveRequests} manager={manager} onChanged={refresh} />

        <FinanceLeadNote leadName={lead?.name ?? null} />

        {manager === 'owner' && walletReady && charge.data ? <PersonInCharge given={charge.data} onChanged={refresh} /> : null}

        <section aria-labelledby="team-activity" className="space-y-1">
          <h3 id="team-activity" className="text-[13px] font-extrabold text-[#0c3e48]">Recent changes</h3>
          <TeamActivity activity={activity} />
        </section>

        <LeaveSection leave={leave} onChanged={refresh} />
      </div>

      <MemberDialog key={picked?.userId ?? 'none'} member={picked} manager={manager} youUserId={you.userId} onClose={() => setSelected(null)} onChanged={refresh} />
    </Card>
  );
}

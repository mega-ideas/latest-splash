'use client';

import { Fingerprint, UserRound } from 'lucide-react';

import { Card, Loading, Note, Pill, useLoad } from '@/components/wallet/parts';
import { PersonInCharge } from '@/components/wallet/Migration';
import { teamRows, type MemberLike, type SpendWire } from '@/lib/team-rules/view';

type InCharge = { personsInCharge: Array<{ userId: string; name: string }>; members: MemberLike[] };

/**
 * The team (v2 brief 5.9): who is in the business, what each person is, who is
 * in charge, and the rule each staff member holds. An owner sees everyone; the
 * list of people to choose from goes to an owner only, because who holds which
 * role is theirs to decide. Roles are set by Splash support, not here: a role
 * decides what a person can do, and changing one is a decision for the
 * business's owners and Splash together.
 */
export default function TeamCard({ owner, spend }: { owner: boolean; spend: SpendWire | null }) {
  const data = useLoad<InCharge>('/api/wallet/persons-in-charge', 'The team could not be loaded.');
  if (data.loading) return <Card id="team" title="Team"><Loading label="Reading your team…" /></Card>;
  if (!data.data) return <Card id="team" title="Team"><Note tone="error">{data.error}</Note></Card>;
  const rows = teamRows({ members: data.data.members, personsInCharge: data.data.personsInCharge, rules: spend?.rules ?? [] }, new Date());

  return (
    <Card id="team" title="Team">
      <div className="space-y-4">
        <p className="text-[13px] leading-5 text-[#326273]">
          Owners sign for the business wallet. Staff pay within the rule they hold, approvers approve, and viewers read. To add someone or change a role, ask Splash support.
        </p>
        {owner ? (
          rows.length === 0 ? (
            <Note>No one else is on the team yet.</Note>
          ) : (
            <ul className="space-y-2" aria-label="Team">
              {rows.map((m) => (
                <li key={m.userId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-[#F6F0ED] px-3 py-2.5 text-sm text-[#1F4452]">
                  <UserRound className="h-4 w-4 shrink-0 text-[#145d6a]" aria-hidden="true" />
                  <span className="min-w-0 flex-1 basis-40 truncate font-semibold">{m.name}</span>
                  <Pill tone="ok">{m.role}</Pill>
                  {m.inCharge ? <Pill tone="wait"><Fingerprint className="mr-1 h-3 w-3" aria-hidden="true" />In charge</Pill> : null}
                  <span className="basis-full text-[13px] text-[#326273] sm:basis-auto">
                    {m.rule ? `Up to ${m.rule.perPayment} a payment. ${m.rule.state.label}.` : m.canHaveRule ? 'No rule: each payment goes to the owners.' : m.role === 'Owner' ? 'Signs for the business wallet.' : 'Reads only.'}
                  </span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <Note>Your owners manage the team. Your own rule, if you have one, is under Spending rules.</Note>
        )}
        {owner ? <PersonInCharge /> : data.data.personsInCharge.length > 0 ? (
          <p className="text-[13px] text-[#326273]">In charge: {data.data.personsInCharge.map((p) => p.name).join(', ')}.</p>
        ) : null}
      </div>
    </Card>
  );
}

'use client';

import Link from 'next/link';

import { rulesSummary, type SpendViewFacts } from '@/lib/wallet-page/rules';
import { Card, Loading, Note, Pill, useLoad } from './parts';

/**
 * Spending rules summary (v2 brief 4.2, 5.5): what each staff member may pay
 * alone, and what is left of it, read from the chain. Inside a rule a staff
 * member pays alone; outside it, the payment goes to the owners. This card
 * shows the rules; Settings (Team & rules) gives, changes and takes them back.
 */
export default function RulesCard({ owner }: { owner: boolean }) {
  const data = useLoad<SpendViewFacts>('/api/wallet/spending-rules', 'The spending rules could not be read.');
  return (
    <Card
      id="spending-rules"
      title="Spending rules"
    >
      {data.loading ? <Loading label="Reading the rules from the chain…" /> : !data.data ? <Note>{data.error}</Note> : <Body view={data.data} owner={owner} />}
    </Card>
  );
}

function Body({ view, owner }: { view: SpendViewFacts; owner: boolean }) {
  const s = rulesSummary(view, { owner });
  return (
    <div className="space-y-3">
      <p className="text-[13px] leading-5 text-[#326273]">
        {s.threshold ? `A payment of ${s.threshold} or more needs an owner’s approval, whoever makes it.` : 'No spending policy is set yet, so staff payments go to your owners.'}
      </p>
      {s.reissueNeeded ? <Note tone="warn">The wallet&rsquo;s signers changed and some rules were not reissued under the new wallet. Until they are reissued they cannot pay. {owner ? 'Reissue them in Settings.' : 'An owner reissues them in Settings.'}</Note> : null}
      {s.orphaned > 0 ? <Note tone="warn">{s.orphaned === 1 ? 'A rule belongs to someone who is no longer on the team.' : `${s.orphaned} rules belong to people who are no longer on the team.`} {owner ? `Take ${s.orphaned === 1 ? 'it' : 'them'} back in Settings.` : `An owner takes ${s.orphaned === 1 ? 'it' : 'them'} back in Settings.`}</Note> : null}
      {s.nearThreshold > 0 ? <Note tone="warn">{s.nearThreshold === 1 ? 'One recipient is' : `${s.nearThreshold} recipients are`} near the amount that needs an owner&rsquo;s approval. Review {s.nearThreshold === 1 ? 'it' : 'them'} with your owners.</Note> : null}
      {s.rules.length === 0 ? (
        <Note>No staff member has a rule yet. Until one is given, staff ask the owners for each payment.</Note>
      ) : (
        <ul className="space-y-2">
          {s.rules.map((r, i) => (
            <li key={`${r.name}-${i}`} className="rounded-xl border border-[#326273]/12 bg-white p-3 text-[13px]">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-bold text-[#0c3e48]">{r.name}</span>
                <Pill tone={r.tone}>{r.state}</Pill>
              </div>
              <p className="mt-0.5 text-[#326273]">Up to {r.perPayment} a payment{r.window ? `. ${r.window}.` : '.'}</p>
            </li>
          ))}
        </ul>
      )}
      <Link href="/dashboard/settings#rules" className="inline-flex min-h-11 items-center text-[13px] font-semibold text-[#0d6370] hover:underline">
        {owner ? 'Give, change or take back a rule in Settings' : 'See your rule in Settings'}
      </Link>
    </div>
  );
}

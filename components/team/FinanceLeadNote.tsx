import { FINANCE_LEAD_NAME, financeLeadWords } from '@/lib/team/view';

/**
 * Who the Finance lead is and, in plain words, what the role can and cannot
 * do, including on the chain. The words are lib/team/view.ts's, which the
 * tests hold to the server's rules.
 */
export default function FinanceLeadNote({ leadName }: { leadName: string | null }) {
  const words = financeLeadWords();
  return (
    <div className="space-y-2 rounded-xl bg-[#f4f8fa] p-3">
      <h3 className="text-[13px] font-extrabold text-[#0c3e48]">{FINANCE_LEAD_NAME}</h3>
      <p className="text-[13px] leading-5 text-[#1F4452]">
        {leadName ? <>{leadName} is the {FINANCE_LEAD_NAME}.</> : <>No one is the {FINANCE_LEAD_NAME} yet.</>} One approver can run the team day to day, so an owner does not have to. It is not a second owner.
      </p>
      <details className="group">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[#0d6370] underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
          What the {FINANCE_LEAD_NAME} can and cannot do
        </summary>
        <div className="space-y-3 pb-1 pt-1 text-[13px] leading-5 text-[#1F4452]">
          <div>
            <p className="font-semibold">Can</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">{words.can.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
          <div>
            <p className="font-semibold">Cannot</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">{words.cannot.map((t) => <li key={t}>{t}</li>)}</ul>
          </div>
          <div>
            <p className="font-semibold">On the chain</p>
            <p className="mt-1">{words.chain}</p>
          </div>
        </div>
      </details>
    </div>
  );
}

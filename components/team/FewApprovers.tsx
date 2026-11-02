'use client';

import { useEffect, useState } from 'react';
import { TriangleAlert, UserRoundPlus } from 'lucide-react';

import { call } from '@/components/transfer/api';
import { ADD_APPROVER_PATH } from '@/lib/approve/wait';

/**
 * The warning an owner sees on Limits and on Team when fewer than three people can approve payments (v2 Phase 3, when
 * nobody who can approve answers): "Only 2 people can approve payments. If they are all away, payments wait. Add another
 * approver." It counts people who can really sign (an owner with a working passkey on this site), not members, and it
 * blocks nothing. The server decides who sees it: anyone but an owner is sent no warning, so this renders nothing for
 * them, and while it is still reading, and if it cannot read, it says nothing rather than guess.
 */
export default function FewApprovers() {
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void call<{ warning?: string | null }>('/api/team/approvers').then((answer) => {
      if (live && answer.ok && typeof answer.body?.warning === 'string') setWarning(answer.body.warning);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!warning) return null;
  return (
    <div role="status" data-testid="few-approvers" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-3 text-[#1F4452]">
      <p className="flex min-w-0 flex-1 basis-64 items-start gap-2 text-[13px] font-medium leading-5">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-[#1F4452]" aria-hidden="true" />
        <span>
          {warning}
          <span className="mt-1 block font-normal text-[#326273]">Owners sign for the business wallet, so add the new person as an owner.</span>
        </span>
      </p>
      <a
        href={ADD_APPROVER_PATH}
        className="inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
      >
        <UserRoundPlus className="h-4 w-4" aria-hidden="true" />
        Add another approver
      </a>
    </div>
  );
}

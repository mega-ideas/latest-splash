'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

import ScheduledPayments from '@/components/schedule/ScheduledPayments';
import TransferFlow from './TransferFlow';

const TABS = [
  { id: 'new', label: 'New payment', href: '/dashboard/transfer' },
  { id: 'scheduled', label: 'Scheduled', href: '/dashboard/transfer?view=scheduled' },
] as const;

/**
 * Transfer has two tabs: a new payment (the five-step flow) and Scheduled (the
 * batches that fall due once, weekly or monthly, and the runs they have made).
 * The tab is in the address, so a notice can open the Scheduled tab on the run
 * it is about, and the back button works.
 */
export default function TransferHome() {
  return (
    <Suspense fallback={null}>
      <Tabs />
    </Suspense>
  );
}

function Tabs() {
  const view = useSearchParams().get('view') === 'scheduled' ? 'scheduled' : 'new';
  return (
    <div className="space-y-4">
      <nav aria-label="Transfer" className="mx-auto w-full max-w-7xl">
        <ul className="inline-grid auto-cols-fr grid-flow-col rounded-xl border border-[#326273]/20 bg-[#F6F0ED] p-1">
          {TABS.map((tab) => {
            const on = tab.id === view;
            return (
              <li key={tab.id}>
                <Link
                  href={tab.href}
                  aria-current={on ? 'page' : undefined}
                  className={`inline-flex h-11 items-center justify-center rounded-lg px-5 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'bg-[#0c3e48] text-white' : 'text-[#1F4452] hover:bg-white'}`}
                >
                  {tab.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      {view === 'scheduled' ? <ScheduledPayments /> : <TransferFlow />}
    </div>
  );
}

'use client';

import { Check } from 'lucide-react';

import { requirementsFor } from '@/lib/transfer/payee';
import { Modal } from './ui';

/** "What's needed for PH" (or ID): one list, each thing once, each with why it is asked. Opens from a button, so the form stays short. */
export default function RequirementsSheet({ country, open, onClose }: { country: string; open: boolean; onClose: () => void }) {
  const sheet = requirementsFor(country);
  if (!sheet) return null;
  return (
    <Modal open={open} onClose={onClose} title={sheet.title} eyebrow="Bank payout" side>
      <p className="text-sm leading-6 text-[#1F4452]">{sheet.intro}</p>
      <div className="mt-5 space-y-6">
        {sheet.groups.map((group) => (
          <section key={group.heading} aria-labelledby={`req-${group.heading.replace(/\W+/g, '-')}`}>
            <h3 id={`req-${group.heading.replace(/\W+/g, '-')}`} className="text-[13px] font-bold uppercase tracking-[0.1em] text-[#145d6a]">{group.heading}</h3>
            <ul className="mt-2 divide-y divide-[#326273]/10 rounded-xl border border-[#326273]/12 bg-white">
              {group.items.map((item) => (
                <li key={item.label} className="flex gap-3 p-3.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--ok-bg)] text-[#145d6a]">
                    <Check className="h-3 w-3" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-[#0c3e48]">{item.label}</span>
                    <span className="mt-0.5 block text-[13px] leading-5 text-[#326273]">{item.because}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}

'use client';

import { ArrowRight, Landmark, Wallet } from 'lucide-react';
import Image from 'next/image';

import { PAYEE_CARDS, type PayeeKind } from '@/lib/transfer/payee';
import { kindPrice } from '@/lib/fees/copy';
import { FEE_KIND } from '@/lib/fees/schedule';
import { usePublishedFees } from '@/lib/fees/use-published-pricing';
import { PrimaryButton } from './ui';
import type { StepProps } from './flow';

/** Step 1, "Who you're paying": three cards, one chosen. Only what applies to the choice is asked next. */
export default function StepWho({ flow, patch, next }: StepProps) {
  const fees = usePublishedFees();
  const price = (kind: PayeeKind): string | null => {
    if (!fees) return null;
    if (kind === 'bank') return kindPrice(fees.schedule, FEE_KIND.BANK_PAYOUT);
    if (kind === 'splash_business') return kindPrice(fees.schedule, FEE_KIND.SPLASH_BUSINESS);
    return kindPrice(fees.schedule, FEE_KIND.WALLET);
  };
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[22px] font-extrabold text-[#0c3e48]">Who are you paying?</h2>
        <p className="mt-1 text-sm text-[#326273]">This decides the rest of the form, so only what applies is asked.</p>
      </div>
      <div role="radiogroup" aria-label="Payment type" className="grid gap-3 md:grid-cols-3">
        {PAYEE_CARDS.map((card) => {
          const on = flow.payeeType === card.kind;
          const cost = price(card.kind);
          return (
            <button
              key={card.kind}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => patch({ payeeType: card.kind, chosen: null })}
              className={`flex min-h-[176px] flex-col gap-3 rounded-2xl border-[1.5px] bg-white p-5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0d6370] shadow-[0_0_0_4px_rgba(13,99,112,0.1)]' : 'border-[#326273]/20 hover:border-[#0d6370]/60'}`}
            >
              <span className="flex items-center justify-between">
                <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${on ? 'bg-[#0c3e48] text-white' : 'bg-[#eef4f5]'}`}>
                  {card.kind === 'bank' ? <Landmark className={`h-5 w-5 ${on ? 'text-white' : 'text-[#0d6370]'}`} aria-hidden="true" /> : null}
                  {card.kind === 'splash_business' ? <Image src="/splash-main-icon.png" alt="" width={24} height={24} className="h-6 w-6 object-contain" /> : null}
                  {card.kind === 'wallet' ? <Wallet className={`h-5 w-5 ${on ? 'text-white' : 'text-[#0d6370]'}`} aria-hidden="true" /> : null}
                </span>
                <span className={`h-5 w-5 rounded-full border-2 ${on ? 'border-[6px] border-[#0d6370] bg-white' : 'border-[#326273]/40 bg-white'}`} aria-hidden="true" />
              </span>
              <span className="text-[17px] font-extrabold text-[#0c3e48]">{card.title}</span>
              <span className="text-[14px] leading-6 text-[#326273]">{card.body}</span>
              <span className="mt-auto flex flex-wrap gap-1.5">
                {card.tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-[#eef4f5] px-2.5 py-1 text-[12px] font-semibold text-[#145d6a]">{tag}</span>
                ))}
                {cost ? <span className="rounded-full bg-[var(--ok-bg)] px-2.5 py-1 text-[12px] font-semibold text-[#145d6a]">{cost}</span> : null}
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-[13px] text-[#326273]">Paying many suppliers from a sheet? Use Batch payouts.</p>
      <div className="flex justify-end border-t border-[#326273]/10 pt-4">
        <PrimaryButton type="button" disabled={!flow.payeeType} onClick={next}>
          Continue to recipient
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </PrimaryButton>
      </div>
    </div>
  );
}

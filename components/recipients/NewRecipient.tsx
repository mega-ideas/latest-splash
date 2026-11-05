'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

import { QuietButton } from '@/components/transfer/ui';
import { RECIPIENT_KINDS, type RecipientKind } from '@/lib/recipients-page/view';
import WalletRecipientForm, { type WalletKind } from './WalletRecipientForm';

const WALLET_KINDS: Partial<Record<RecipientKind, WalletKind>> = { exchange: 'EXCHANGE', self_custody: 'SELF_CUSTODY', cross_chain: 'CROSS_CHAIN' };

/**
 * Add a recipient. The three wallet kinds are saved here with the same form
 * Transfer uses. A bank account is added in Transfer, where the bank confirms
 * the holder's name before it is kept; a business on Splash is found there by
 * its registered name and needs no saving.
 */
export default function NewRecipient({ bankOpen, onSaved, onClose }: { bankOpen: boolean; onSaved: (name: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<RecipientKind>('self_custody');
  const walletKind = WALLET_KINDS[kind];
  const chosen = RECIPIENT_KINDS.find((k) => k.id === kind);

  return (
    <section className="dash-surface space-y-4 p-4 sm:p-5" aria-labelledby="new-recipient-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="new-recipient-title" className="text-lg font-extrabold text-[#0c3e48]">Add a recipient</h2>
        <QuietButton type="button" onClick={onClose} className="!text-[13px]">Close</QuietButton>
      </div>
      <div role="group" aria-label="What are you adding?" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
        {RECIPIENT_KINDS.map((k) => {
          const on = kind === k.id;
          return (
            <button
              key={k.id}
              type="button"
              aria-pressed={on}
              onClick={() => setKind(k.id)}
              className={`flex min-h-12 items-center rounded-xl border px-3 py-2 text-left text-[13px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0c3e48] bg-[#0c3e48] text-white' : 'border-[#326273]/20 bg-white text-[#1F4452] hover:border-[#0d6370]/60'}`}
            >
              {k.label}
            </button>
          );
        })}
      </div>
      <p className="text-[13px] leading-5 text-[#326273]">{chosen?.blurb}</p>

      {walletKind ? (
        <WalletRecipientForm key={walletKind} kind={walletKind} onCancel={onClose} onSaved={(record) => onSaved(record.name)} />
      ) : kind === 'bank' ? (
        bankOpen ? (
          <div className="space-y-3 rounded-xl border border-[#326273]/15 bg-white p-4 text-[13px] leading-5 text-[#1F4452]">
            <p>A bank account is added in Transfer, under &ldquo;A business bank account&rdquo;. The bank confirms the holder&rsquo;s name before the account is kept, and only an owner adds one.</p>
            <Link href="/dashboard/transfer" className="inline-flex min-h-11 items-center gap-1 font-semibold text-[#0d6370] hover:underline">Open Transfer <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>
          </div>
        ) : (
          <p className="rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-3 text-[13px] leading-5 text-[#1F4452]">Bank payouts are not open for your business yet. Recipients are wallets for now.</p>
        )
      ) : (
        <div className="space-y-3 rounded-xl border border-[#326273]/15 bg-white p-4 text-[13px] leading-5 text-[#1F4452]">
          <p>A business on Splash is not saved. Search for it by registered name in Transfer; paying it costs nothing, and it appears in this list once you have.</p>
          <Link href="/dashboard/transfer" className="inline-flex min-h-11 items-center gap-1 font-semibold text-[#0d6370] hover:underline">Open Transfer <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" /></Link>
        </div>
      )}
    </section>
  );
}

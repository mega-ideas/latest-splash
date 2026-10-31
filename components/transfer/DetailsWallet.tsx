'use client';

import { useState } from 'react';
import { Check, Wallet } from 'lucide-react';

import WalletRecipientForm, { type WalletKind } from '@/components/recipients/WalletRecipientForm';
import { blockedReason } from '@/lib/transfer/recipient-state';
import type { SavedRecipient } from './api';
import { QuietButton } from './ui';
import type { Chosen, StepProps } from './flow';

type Kind = WalletKind;

const KINDS: Array<{ kind: Kind; title: string; body: string }> = [
  { kind: 'EXCHANGE', title: 'An exchange account', body: 'A deposit address at an exchange, on Sui.' },
  { kind: 'SELF_CUSTODY', title: 'A wallet they hold', body: 'Paid once the supplier proves it is theirs.' },
  { kind: 'CROSS_CHAIN', title: 'USDC on another chain', body: 'Ethereum, Base, Arbitrum, Solana and others.' },
];

function toChosen(r: SavedRecipient): Chosen | null {
  const kind = r.delivery?.deliveryKind;
  if (kind !== 'EXCHANGE' && kind !== 'SELF_CUSTODY' && kind !== 'CROSS_CHAIN') return null;
  return {
    kind: 'recipient',
    recipientId: r.id,
    name: r.name,
    deliveryKind: kind,
    address: r.walletAddress ?? r.delivery?.destinationAddress ?? null,
    blocked: blockedReason({ deliveryKind: kind, ownershipStatus: r.delivery?.ownershipStatus, screeningVerdict: r.screeningVerdict }),
  };
}

const mask = (a: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');

/** Step 2 for a Sui wallet address: an exchange account, a wallet the supplier holds, or USDC on another chain; saved recipients first. */
export default function DetailsWallet({ flow, patch, recipients, reload }: Pick<StepProps, 'flow' | 'patch' | 'recipients' | 'reload'>) {
  const [kind, setKind] = useState<Kind>('SELF_CUSTODY');
  const [adding, setAdding] = useState(false);
  const saved = recipients.filter((r) => r.delivery?.deliveryKind === kind);
  const chosen = flow.chosen?.kind === 'recipient' ? flow.chosen : null;

  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="What the address belongs to" className="grid gap-2 md:grid-cols-3">
        {KINDS.map((k) => {
          const on = kind === k.kind;
          return (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => {
                setKind(k.kind);
                setAdding(false);
                patch({ chosen: null });
              }}
              className={`flex min-h-[88px] flex-col gap-1 rounded-xl border p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0c3e48] bg-[#0c3e48] text-white' : 'border-[#326273]/20 bg-white text-[#1F4452] hover:border-[#0d6370]/60'}`}
            >
              <span className="text-sm font-bold">{k.title}</span>
              <span className={`text-[13px] leading-5 ${on ? 'text-[#bfe6ee]' : 'text-[#326273]'}`}>{k.body}</span>
            </button>
          );
        })}
      </div>

      {saved.length > 0 ? (
        <fieldset>
          <legend className="text-[13px] font-semibold text-[#1F4452]">Saved recipients</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {saved.map((r) => {
              const c = toChosen(r);
              const on = chosen?.recipientId === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => c && patch({ chosen: c })}
                  className={`flex min-h-[64px] items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0d6370] bg-[#f4f8fa] shadow-[inset_3px_0_0_#0d6370]' : 'border-[#326273]/20 bg-white hover:border-[#0d6370]/60'}`}
                >
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${on ? 'bg-[#0d6370] text-white' : 'bg-[#eef4f5] text-[#145d6a]'}`}>
                    {on ? <Check className="h-4 w-4" aria-hidden="true" /> : <Wallet className="h-4 w-4" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-[#0c3e48]">{r.name}</span>
                    <span className="block truncate font-mono text-[13px] text-[#326273]">{mask(r.walletAddress ?? r.delivery?.destinationAddress ?? null)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {chosen?.blocked ? <p role="status" className="rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-3.5 text-sm leading-6 text-[#1F4452]">{chosen.blocked}</p> : null}

      {!adding ? (
        <QuietButton type="button" onClick={() => setAdding(true)}>
          {saved.length > 0 ? 'Add another' : 'Add'} {kind === 'EXCHANGE' ? 'exchange account' : kind === 'SELF_CUSTODY' ? 'wallet' : 'address on another chain'}
        </QuietButton>
      ) : (
        <WalletRecipientForm
          key={kind}
          kind={kind}
          onCancel={() => setAdding(false)}
          onSaved={(record) => {
            const made = toChosen(record);
            if (made) patch({ chosen: made });
            setAdding(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

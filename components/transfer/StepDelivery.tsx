'use client';

import { Building2, Check, Landmark, Lock, Zap } from 'lucide-react';

import type { TransferState } from '@/app/dashboard/transfer/page';
import { getCorridorFeeBps } from '@/lib/fx/corridors';
import type { RecipientTier } from '@/lib/server/operations';

const options: Array<{ tier: RecipientTier; icon: typeof Building2; title: string; body: (currency: string) => string; eta: string }> = [
  { tier: 'PAYOUT_ONLY', icon: Building2, title: 'Bank payout', body: (currency) => `Recipient gets ${currency} in their own bank. No account needed.`, eta: '3–20 min' },
  { tier: 'SWEEP_ACCOUNT', icon: Zap, title: 'Splash receive account (auto-sweep)', body: () => 'Account experience; funds sweep to their bank in seconds.', eta: '≈5 s receive + sweep' },
  { tier: 'STORED_BALANCE', icon: Landmark, title: 'Splash balance', body: () => 'Funds stay as USD. Instant. Re-spendable in-network.', eta: 'Instant' },
];

export default function StepDelivery({ state, set, prev, next }: { state: TransferState; set: (patch: Partial<TransferState>) => void; prev: () => void; next: () => void }) {
  const storedCurrencies = (process.env.NEXT_PUBLIC_STORED_BALANCE_CORRIDORS ?? '').split(',').map((value) => value.trim().toUpperCase());
  const storedEnabled = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || storedCurrencies.includes(state.amount.targetCurrency);
  const feeBps = getCorridorFeeBps(state.amount.targetCurrency);

  return (
    <div className="space-y-5">
      <div><h2 className="text-xl font-bold">How should they receive it?</h2><p className="mt-1 text-sm text-foreground/60">Same payment, three delivery depths. You remain in control of the final route.</p></div>
      <div className="grid gap-3">
        {options.map((option) => {
          const selected = state.deliveryTier === option.tier;
          const locked = option.tier === 'STORED_BALANCE' && !storedEnabled;
          const Icon = option.icon;
          return (
            <button key={option.tier} type="button" disabled={locked} title={locked ? 'Available when in-country custody partner is live — pilot via PDAX.' : undefined} onClick={() => set({ deliveryTier: option.tier })} className={`grid grid-cols-[auto_1fr_auto] items-start gap-4 rounded-2xl border p-5 text-left transition ${selected ? 'border-primary bg-primary/10 shadow-lg shadow-primary/10' : 'border-foreground/10 bg-card hover:border-primary/40'} ${locked ? 'cursor-not-allowed opacity-45' : ''}`}>
              <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${selected ? 'bg-primary text-card' : 'bg-muted text-foreground/55'}`}><Icon className="h-5 w-5" /></span>
              <span><strong className="block">{option.title}</strong><small className="mt-1 block leading-5 text-foreground/60">{option.body(state.amount.targetCurrency)}</small><small className="mt-2 block font-semibold text-primary">ETA {option.eta} · {option.tier === 'STORED_BALANCE' ? '0.00% transfer' : `${(feeBps / 100).toFixed(2)}% corridor fee`}</small>{option.tier === 'SWEEP_ACCOUNT' && <small className="mt-1 block text-foreground/45">Pass-through account; funds rest for seconds.</small>}{option.tier === 'STORED_BALANCE' && <small className="mt-1 block text-foreground/45">Off-ramp fees apply when leaving the network.</small>}</span>
              {locked ? <Lock className="h-5 w-5 text-foreground/40" /> : selected ? <Check className="h-5 w-5 text-primary" /> : null}
            </button>
          );
        })}
      </div>
      <div className="flex gap-3"><button onClick={prev} className="flex-1 rounded-xl border border-foreground/15 py-3 font-bold">Back</button><button onClick={next} className="flex-1 rounded-xl bg-accent py-3 font-bold text-card">Review quote</button></div>
    </div>
  );
}

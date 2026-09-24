'use client';

import { Building2, Check, Landmark, Lock, Zap } from 'lucide-react';

import type { TransferState } from '@/app/dashboard/transfer/page';
import { useCustodyPhaseOn, useSweepSwitchOn } from '@/components/dashboard/CustodyPhaseContext';
import { CUSTODY_PHASE_WHY, deliveryTierOpen } from '@/lib/custody-phase-rules';
import { getCorridorFeeBps } from '@/lib/fx/corridors';
import type { RecipientTier } from '@/lib/server/operations';

const options: Array<{ tier: RecipientTier; icon: typeof Building2; title: string; body: (currency: string) => string; eta: string }> = [
  { tier: 'PAYOUT_ONLY', icon: Building2, title: 'Direct to business bank account / crypto wallet', body: (currency) => `Bank: they receive ${currency} in their business account. Wallet: USDC on Sui lands in their Slush or MetaMask (Sui Snap) wallet.`, eta: '3–20 min' },
  { tier: 'SWEEP_ACCOUNT', icon: Zap, title: 'Splash receive account (auto-sweep)', body: () => 'Account experience; funds sweep to their bank in seconds.', eta: '≈5 s receive + sweep' },
  { tier: 'STORED_BALANCE', icon: Landmark, title: 'Splash balance', body: () => 'Funds stay as USD. Instant. Re-spendable in-network.', eta: 'Instant' },
];

const CUSTODY_NOTE_ID = 'delivery-custody-phase-note';

type TierLock = 'custody_phase' | 'sweep_switch' | 'corridor';

/**
 * Why a tier cannot be chosen, if it cannot. The custody phase comes first,
 * through the same `deliveryTierOpen()` the authorize and recipients routes
 * enforce. The operator's sweep switch comes next, as those routes check it
 * next, so this step never offers a tier the next one refuses. The
 * stored-balance corridor switch is a further, narrower lock on top (an
 * in-country partner per currency, still needed in Phase 2). The switches can
 * close a tier the phase has opened, and never open one the phase has closed.
 */
function lockFor(tier: RecipientTier, custodyOn: boolean, storedOpen: boolean, sweepOn: boolean): TierLock | null {
  if (!deliveryTierOpen(tier, custodyOn)) return 'custody_phase';
  if (tier === 'SWEEP_ACCOUNT' && !sweepOn) return 'sweep_switch';
  if (tier === 'STORED_BALANCE' && !storedOpen) return 'corridor';
  return null;
}

export default function StepDelivery({ state, set, prev, next }: { state: TransferState; set: (patch: Partial<TransferState>) => void; prev: () => void; next: () => void }) {
  const custodyOn = useCustodyPhaseOn();
  const sweepOn = useSweepSwitchOn();
  const storedCurrencies = (process.env.NEXT_PUBLIC_STORED_BALANCE_CORRIDORS ?? '').split(',').map((value) => value.trim().toUpperCase());
  const storedOpen = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || storedCurrencies.includes(state.amount.targetCurrency);
  const feeBps = getCorridorFeeBps(state.amount.targetCurrency);
  // A tier already in state that is locked here (chosen before the target
  // currency changed, or prefilled under a different phase) is not one the
  // operator can keep: show and continue with PAYOUT_ONLY, always open.
  const chosen: RecipientTier = lockFor(state.deliveryTier, custodyOn, storedOpen, sweepOn) ? 'PAYOUT_ONLY' : state.deliveryTier;
  const custodyLocked = options.some((option) => lockFor(option.tier, custodyOn, storedOpen, sweepOn) === 'custody_phase');

  return (
    <div className="space-y-5">
      <div><h2 className="text-xl font-bold">How should they receive it?</h2><p className="mt-1 text-sm text-foreground/60">Same payment, three delivery depths. You remain in control of the final route.</p></div>
      <div className="grid gap-3">
        {options.map((option) => {
          const selected = chosen === option.tier;
          const lock = lockFor(option.tier, custodyOn, storedOpen, sweepOn);
          const Icon = option.icon;
          return (
            <button
              key={option.tier}
              type="button"
              disabled={lock !== null}
              aria-pressed={selected}
              aria-describedby={lock === 'custody_phase' ? CUSTODY_NOTE_ID : undefined}
              onClick={() => set({ deliveryTier: option.tier })}
              className={`grid grid-cols-[auto_1fr_auto] items-start gap-4 rounded-2xl border p-5 text-left transition ${lock ? 'cursor-not-allowed border-dashed border-foreground/20 bg-card' : selected ? 'border-primary bg-primary/10 shadow-lg shadow-primary/10' : 'border-foreground/10 bg-card hover:border-primary/40'}`}
            >
              <span className={`flex h-11 w-11 items-center justify-center rounded-xl ${selected ? 'bg-primary text-card' : 'bg-muted text-foreground/55'} ${lock ? 'opacity-50' : ''}`}><Icon className="h-5 w-5" /></span>
              <span>
                {/* Only the offer dims; the reason below stays at full contrast. */}
                <span className={`block ${lock ? 'opacity-55' : ''}`}><strong className="block">{option.title}</strong><small className="mt-1 block leading-5 text-foreground/60">{option.body(state.amount.targetCurrency)}</small><small className="mt-2 block font-semibold text-primary">ETA {option.eta} · {option.tier === 'STORED_BALANCE' ? '0.00% transfer' : `${(feeBps / 100).toFixed(2)}% corridor fee`}</small>{option.tier === 'SWEEP_ACCOUNT' && <small className="mt-1 block text-foreground/45">Pass-through account; funds rest for seconds.</small>}{option.tier === 'STORED_BALANCE' && <small className="mt-1 block text-foreground/45">Off-ramp fees apply when leaving the network.</small>}</span>
                {lock && (
                  <small className="mt-3 flex items-start gap-1.5 text-[13px] font-semibold leading-5 text-foreground">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {lock === 'custody_phase'
                      ? 'Locked until Phase 2'
                      : lock === 'sweep_switch'
                        ? 'Switched off right now. Choose a direct payout instead.'
                        : 'Available when in-country custody partner is live — pilot via PDAX.'}
                  </small>
                )}
              </span>
              {selected ? <Check className="h-5 w-5 text-primary" /> : null}
            </button>
          );
        })}
      </div>
      {custodyLocked && (
        <div id={CUSTODY_NOTE_ID} className="flex items-start gap-2.5 rounded-xl border border-[var(--info)]/20 bg-[var(--info-bg)] px-4 py-3.5">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info)]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-[var(--ink)]">Phase 0 pays out only</p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--info)]">{CUSTODY_PHASE_WHY}</p>
          </div>
        </div>
      )}
      <div className="flex gap-3"><button onClick={prev} className="flex-1 rounded-xl border border-foreground/15 py-3 font-bold">Back</button><button onClick={() => { set({ deliveryTier: chosen }); next(); }} className="flex-1 rounded-xl bg-accent py-3 font-bold text-card">Review quote</button></div>
    </div>
  );
}

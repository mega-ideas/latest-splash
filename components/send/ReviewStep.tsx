'use client';

import { Building2, Landmark, ShieldCheck, Zap } from 'lucide-react';
import Image from 'next/image';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import MoneyPathPanel from '@/components/compliance/MoneyPathPanel';
import FundingSelector from '@/components/funding/FundingSelector';
import { Button, Card, Chip, ProofRow } from '@/components/system';
import { getCorridorFeeBps } from '@/lib/fx/corridors';
import { getNetworkProfile } from '@/lib/network';
import { fundingLabel, usd, type TransferState } from '@/lib/send/state';
import type { RecipientTier } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

const DELIVERY: Array<{ tier: RecipientTier; icon: typeof Building2; title: string; body: string; eta: string }> = [
  { tier: 'PAYOUT_ONLY', icon: Building2, title: 'Bank payout', body: 'The licensed payout partner delivers local currency to the supplier bank.', eta: 'minutes*' },
  { tier: 'SWEEP_ACCOUNT', icon: Zap, title: 'Splash receive account', body: 'Account experience; funds sweep to their bank shortly after.', eta: 'seconds + sweep*' },
  { tier: 'STORED_BALANCE', icon: Landmark, title: 'Splash balance', body: 'Funds stay as USD, available on settlement, re-spendable in-network.', eta: 'on settlement' },
];

/**
 * One screen to check everything before money moves: delivery, funding
 * source, the locked quote, the approval policy that applies, and where the
 * money sits at each hop. Send creates the intent; a human approves the PTB
 * when policy requires it.
 */
export default function ReviewStep({ state, set, prev, next }: { state: TransferState; set: (patch: Partial<TransferState>) => void; prev: () => void; next: () => void }) {
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState<'idle' | 'session' | 'sending' | 'checking'>('idle');
  const [policy, setPolicy] = useState<{ thresholdUsd: number; dual: boolean } | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);

  const storedCurrencies = (process.env.NEXT_PUBLIC_STORED_BALANCE_CORRIDORS ?? '').split(',').map((value) => value.trim().toUpperCase());
  const storedEnabled = process.env.NEXT_PUBLIC_DEMO_MODE === 'true' || storedCurrencies.includes(state.amount.targetCurrency);
  const corridor = getNetworkProfile().corridors.find((entry) => entry.currency === state.amount.targetCurrency);
  const amountUsd = Number.parseFloat(state.amount.value || '0');
  const feeBps = getCorridorFeeBps(state.amount.targetCurrency);

  useEffect(() => {
    let active = true;
    fetch('/api/settings')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { approvalThresholdUsd?: number; requireDualApproval?: boolean } | null) => {
        if (active && body && typeof body.approvalThresholdUsd === 'number') setPolicy({ thresholdUsd: body.approvalThresholdUsd, dual: body.requireDualApproval ?? true });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const createIntent = useCallback(async () => {
    setBusy('sending');
    try {
      const selection = state.funding.selection;
      const response = await fetch('/api/transfers/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...state,
          fundingSessionId: state.funding.sessionId,
          fundingSelection: selection,
          paymentRail: selection.type === 'fiat' && selection.provider === 'AIRWALLEX' ? 'AIRWALLEX_WIRE' : selection.type === 'held' ? 'SPLASH_BALANCE' : 'SOURCE_DEPOSIT',
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'Send request failed');
      }
      const body = (await response.json()) as { transferIntentId: string };
      set({ transferIntentId: body.transferIntentId, txStatus: 'pending' });
      setDepositOpen(false);
      next();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Send request failed');
      setBusy('idle');
    }
  }, [next, set, state]);

  async function send() {
    if (!agree || !state.quote) return;
    if (state.funding.selection.type === 'held') {
      await createIntent();
      return;
    }
    setBusy('session');
    try {
      const response = await fetch('/api/funding/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountUsd, selection: state.funding.selection }),
      });
      const body = (await response.json()) as { error?: string; session?: { id: string; status: string; depositAddress?: string }; qrDataUrl?: string | null; demoMode?: boolean };
      if (!response.ok || !body.session) throw new Error(body.error ?? 'Funding session could not be created');
      set({ funding: { ...state.funding, sessionId: body.session.id, sessionStatus: body.session.status, depositAddress: body.session.depositAddress, qrDataUrl: body.qrDataUrl, demoMode: body.demoMode } });
      setDepositOpen(true);
      setBusy('idle');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Funding session could not be created');
      setBusy('idle');
    }
  }

  async function checkDeposit(simulate: boolean) {
    if (!state.funding.sessionId) return;
    setBusy('checking');
    try {
      const response = await fetch(`/api/funding/sessions/${encodeURIComponent(state.funding.sessionId)}`, simulate ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'SIMULATE_DEPOSIT' }) } : undefined);
      const body = (await response.json()) as { error?: string; session?: { status: string } };
      if (!response.ok || !body.session) throw new Error(body.error ?? 'Deposit status could not be refreshed');
      set({ funding: { ...state.funding, sessionStatus: body.session.status } });
      if (body.session.status === 'CREDITED') toast.success('Deposit cleared KYT and normalised to USDC');
      if (body.session.status === 'QUARANTINED') toast.error('Deposit quarantined for operator review');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Deposit status could not be refreshed');
    } finally {
      setBusy('idle');
    }
  }

  const selection = state.funding.selection;
  const overThreshold = policy ? policy.dual && amountUsd > policy.thresholdUsd : false;

  return (
    <div className="grid gap-6">
      <div>
        <h2 className="text-[var(--text-h2)] font-semibold leading-[1.15] tracking-[-0.02em]">Review and send</h2>
        <p className="mt-1 text-[14px] text-[var(--text-2)]">Check every line. Nothing moves until you confirm, and policy may ask a second approver to sign.</p>
      </div>

      <Card padding="sm" className="grid gap-1">
        <dl>
          <ProofRow label="Recipient" value={<span className="font-semibold">{state.recipient.name}</span>} />
          <ProofRow label="Account" value={state.recipient.bank?.account ?? '—'} mono />
          <ProofRow label="You send" value={<span className="font-mono tabular-nums">{usd.format(amountUsd)} USD</span>} />
          <ProofRow label="Rate" value={state.quote ? `1 USD = ${state.quote.fxRate} ${state.amount.targetCurrency}${state.rateHold?.state === 'ACTIVE' ? ' · held' : ''}` : '—'} mono />
          <ProofRow label="Fee" value={state.quote ? `${usd.format(Number.parseFloat(state.quote.fee))} USD (${(feeBps / 100).toFixed(2)}% · illustrative)` : '—'} mono />
          <ProofRow label="Supplier receives" value={<span className="font-mono text-[16px] font-semibold tabular-nums">{state.quote?.netReceived ?? '—'} {state.amount.targetCurrency}</span>} />
          <ProofRow label="Payout partner" value={corridor?.partnerLabel ?? 'Licensed payout partner'} />
        </dl>
      </Card>

      <fieldset className="grid gap-2">
        <legend className="text-[14px] font-semibold">Delivery</legend>
        <div className="grid gap-2 md:grid-cols-3">
          {DELIVERY.map((option) => {
            const active = state.deliveryTier === option.tier;
            const locked = option.tier === 'STORED_BALANCE' && !storedEnabled;
            const Icon = option.icon;
            return (
              <button
                key={option.tier}
                type="button"
                disabled={locked}
                aria-pressed={active}
                onClick={() => set({ deliveryTier: option.tier })}
                className={cn(
                  'grid gap-2 rounded-[var(--r-md)] border p-4 text-left transition-colors outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]',
                  active ? 'border-[var(--teal-600)] bg-[var(--teal-100)]' : 'border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-2)]',
                  locked && 'cursor-not-allowed opacity-50',
                )}
              >
                <span className="flex items-center gap-2 text-[14px] font-semibold">
                  <Icon className="size-4 text-[var(--teal-600)]" aria-hidden="true" /> {option.title}
                </span>
                <span className="text-[13px] text-[var(--text-2)]">{option.body}</span>
                <span className="font-mono text-[12px] text-[var(--text-muted)]">
                  {option.eta} · {option.tier === 'STORED_BALANCE' ? '0.00% transfer' : `${(feeBps / 100).toFixed(2)}% fee`}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-[12px] text-[var(--text-muted)]">*Delivery times are illustrative; local rails vary.</p>
      </fieldset>

      <div className="grid gap-2">
        <span className="text-[14px] font-semibold">Fund from</span>
        <FundingSelector
          selection={selection}
          amountUsd={amountUsd}
          disabled={busy !== 'idle'}
          onChange={(nextSelection) => set({ funding: { selection: nextSelection, sessionId: undefined, sessionStatus: undefined, depositAddress: undefined, qrDataUrl: null, demoMode: undefined } })}
        />
      </div>

      <MoneyPathPanel compact />

      <Card tone="tint" padding="sm" className="grid gap-2 text-[13px] text-[var(--text-2)]">
        <span className="inline-flex items-center gap-2 font-semibold text-[var(--text)]">
          <ShieldCheck className="size-4 text-[var(--teal-600)]" aria-hidden="true" /> What happens when you send
        </span>
        <span>
          Splash creates a payment intent and prepares one atomic Sui transaction (pay · allocate · prove).{' '}
          {policy
            ? overThreshold
              ? `This is over your ${usd.format(policy.thresholdUsd)} USD threshold, so a second approver signs before settlement.`
              : `This is under your ${usd.format(policy.thresholdUsd)} USD threshold, so one approver signs before settlement.`
            : 'Your approval policy decides who signs.'}
        </span>
        <span className="flex flex-wrap gap-1.5 pt-1">
          <Chip>payment_intent</Chip>
          <Chip>audit_anchor + receipt_v2</Chip>
          <Chip>spend_meter</Chip>
        </span>
      </Card>

      <label className="flex items-start gap-3 text-[14px] text-[var(--text-2)]">
        <input type="checkbox" checked={agree} onChange={(event) => setAgree(event.target.checked)} className="mt-1 size-4 accent-[var(--teal-600)]" />
        <span>
          I confirm the recipient details are correct and I want to send {usd.format(amountUsd)} USD from {fundingLabel(selection)}.
        </span>
      </label>

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="ghost" onClick={prev} disabled={busy !== 'idle'}>
          Back
        </Button>
        <Button size="lg" onClick={() => void send()} disabled={!agree || !state.quote || busy !== 'idle'}>
          {busy === 'session' ? 'Preparing funding…' : busy === 'sending' ? 'Creating intent…' : `Send ${usd.format(amountUsd)} USD`}
        </Button>
      </div>

      {depositOpen ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(11,42,51,.5)] p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-labelledby="deposit-title">
          <div className="w-full max-w-xl rounded-t-[var(--r-lg)] bg-[var(--surface)] p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-[var(--shadow-elevated)] sm:rounded-[var(--r-lg)]">
            <h3 id="deposit-title" className="text-[var(--text-h3)] font-semibold">
              {selection.type === 'fiat' ? `Continue with ${selection.provider}` : `Deposit ${selection.type === 'stablecoin' ? selection.asset : 'USDC'}`}
            </h3>
            <p className="mt-1 text-[13px] text-[var(--text-2)]">{selection.type === 'fiat' ? 'The provider confirms your deposit before settlement.' : 'Send over the selected rail to the push-only deposit address.'}</p>
            {selection.type === 'stablecoin' ? (
              <div className="mt-4 grid gap-4 sm:grid-cols-[200px_1fr] sm:items-center">
                {state.funding.qrDataUrl ? <Image unoptimized src={state.funding.qrDataUrl} alt={`QR code for ${selection.asset} deposit`} width={200} height={200} className="mx-auto rounded-[var(--r-md)] border border-[var(--line)] p-2" /> : null}
                <div className="min-w-0 break-all rounded-[var(--r-sm)] bg-[var(--surface-2)] p-3 font-mono text-[13px]">{state.funding.depositAddress}</div>
              </div>
            ) : null}
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {selection.type === 'fiat' || state.funding.sessionStatus === 'CREDITED' ? (
                <Button onClick={() => void createIntent()} disabled={busy !== 'idle'} fullWidth>
                  {busy === 'sending' ? 'Confirming…' : selection.type === 'fiat' ? `Continue with ${selection.provider}` : 'Continue to settlement'}
                </Button>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => void checkDeposit(false)} disabled={busy !== 'idle'} fullWidth>
                    Check deposit status
                  </Button>
                  {state.funding.demoMode ? (
                    <Button onClick={() => void checkDeposit(true)} disabled={busy !== 'idle'} fullWidth>
                      Simulate test deposit
                    </Button>
                  ) : null}
                </>
              )}
              <Button variant="ghost" onClick={() => setDepositOpen(false)} disabled={busy === 'sending'} fullWidth>
                Close
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

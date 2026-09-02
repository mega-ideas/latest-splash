'use client';

import { Clock3, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { AmountInput, Badge, Button, Card, Chip } from '@/components/system';
import { baselineCostUsd, getComparisonBaseline } from '@/lib/fx/comparison-baselines';
import { getCorridorFeeBps } from '@/lib/fx/corridors';
import { checkMinimumSettlement } from '@/lib/policy/limits';
import { usd, type TransferState } from '@/lib/send/state';

const QUOTE_TTL_MS = 30_000;

/**
 * How much. The quote is live (Pyth-fed /api/quotes), valid for 30 seconds,
 * refreshed when the amount settles, and lockable for 48 hours. Every fee
 * and speed figure on this screen is illustrative and says so.
 */
export default function AmountStep({ state, set, prev, next }: { state: TransferState; set: (patch: Partial<TransferState>) => void; prev: () => void; next: () => void }) {
  const [loading, setLoading] = useState(false);
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [holdBusy, setHoldBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const amountUsd = Number.parseFloat(state.amount.value || '0');
  const minimum = checkMinimumSettlement(Number.isFinite(amountUsd) ? amountUsd : 0, 'transfer');
  const currency = state.amount.targetCurrency;
  const feeBps = getCorridorFeeBps(currency);
  const holdActive = state.rateHold?.state === 'ACTIVE' && state.rateHold.corridorCurrency === currency;
  const heldRate = holdActive && state.rateHold ? state.rateHold.rate : null;
  const feeTier = state.funding.selection.feeTier;
  const recipientRef = state.recipient.bank?.account;

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      set({ quote: undefined });
      return;
    }
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount: amountUsd, targetCurrency: currency, recipientId: recipientRef, fundingFeeTier: feeTier }),
        });
        if (!response.ok) throw new Error('Quote unavailable right now');
        const body = (await response.json()) as { exchangeRate: string; platformFee: number; toAmount: number };
        if (cancelled) return;
        const quotedFx = Number.parseFloat(body.exchangeRate);
        const heldFx = heldRate ? Number.parseFloat(heldRate) : null;
        const fx = heldFx ?? quotedFx;
        const netReceived = heldFx && quotedFx > 0 ? (body.toAmount / quotedFx) * heldFx : body.toAmount;
        set({ quote: { fxRate: fx, fee: (body.platformFee / 100).toFixed(2), netReceived: netReceived.toFixed(2) } });
        setQuotedAt(Date.now());
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Quote unavailable right now');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [amountUsd, currency, feeTier, heldRate, recipientRef, refreshKey, set]);

  const quoteAgeMs = quotedAt ? now - quotedAt : 0;
  const quoteFresh = quotedAt !== null && quoteAgeMs < QUOTE_TTL_MS;
  const secondsLeft = quotedAt ? Math.max(0, Math.ceil((QUOTE_TTL_MS - quoteAgeMs) / 1000)) : 0;
  const stale = quotedAt !== null && !quoteFresh && !holdActive;

  async function holdRate() {
    if (!state.quote) return;
    setHoldBusy(true);
    try {
      const response = await fetch('/api/rate-holds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corridorCurrency: currency, rate: state.quote.fxRate }),
      });
      if (!response.ok) throw new Error('Rate hold could not be created');
      set({ rateHold: (await response.json()) as NonNullable<TransferState['rateHold']> });
      toast.success('Rate held for 48 hours');
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Rate hold could not be created');
    } finally {
      setHoldBusy(false);
    }
  }

  const canContinue = minimum.ok && Boolean(state.quote) && !loading && !error;
  // Everything below derives from the live quote object — no duplicated fee math.
  const sendAmountUsd = Number.isFinite(amountUsd) ? amountUsd : 0;
  const quoteFeeUsd = Number.parseFloat(state.quote?.fee || '0');
  const allInFeePct = sendAmountUsd > 0 && Number.isFinite(quoteFeeUsd) ? (quoteFeeUsd / sendAmountUsd) * 100 : 0;
  const baseline = getComparisonBaseline(currency);
  const rateDecimals = currency === 'IDR' || currency === 'VND' ? 0 : 3;

  return (
    <div className="grid gap-6">
      <div>
        <h2 className="text-[var(--text-h2)] font-semibold leading-[1.15] tracking-[-0.02em]">How much?</h2>
        <p className="mt-1 text-[14px] text-[var(--text-2)]">
          To <span className="font-semibold text-[var(--text)]">{state.recipient.name}</span> · USD → {currency}
        </p>
      </div>

      <AmountInput
        label="Amount to send"
        value={state.amount.value}
        onChange={(value) => set({ amount: { ...state.amount, value } })}
        currency="USD"
        autoFocus
        error={state.amount.value && !minimum.ok ? minimum.message : undefined}
        helper={!state.amount.value ? 'Enter the USD amount; the local amount and fee update live.' : undefined}
      />

      <Card tone="tint" padding="sm" className="grid gap-3" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-[var(--text-2)]">Live rate</span>
          {holdActive && state.rateHold ? (
            <Badge tone="green">
              <Clock3 className="size-3.5" aria-hidden="true" /> Rate held until {new Date(state.rateHold.holdUntil).toLocaleDateString('en-GB')}
            </Badge>
          ) : quotedAt ? (
            <Badge tone={quoteFresh ? 'teal' : 'amber'}>
              <Clock3 className="size-3.5" aria-hidden="true" /> {quoteFresh ? `Quote valid ${secondsLeft}s` : 'Quote expired'}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-mono text-[14px] text-[var(--text)]">
            {state.quote ? `1 USD = ${state.quote.fxRate.toLocaleString('en-US', { maximumFractionDigits: rateDecimals })} ${currency}` : '—'}
          </span>
          {loading ? <Loader2 className="size-4 animate-spin text-[var(--teal-600)]" aria-label="Refreshing quote" /> : <Chip tone="teal">Live FX via Pyth</Chip>}
        </div>
        <div className="grid gap-1 border-t border-[var(--divider)] pt-3 text-[14px]">
          <div className="flex justify-between gap-3 text-[var(--text-2)]">
            <span>Fee ({(feeBps / 100).toFixed(2)}% corridor · illustrative)</span>
            <span className="font-mono tabular-nums text-[var(--text)]">{state.quote ? `${usd.format(quoteFeeUsd)} USD (${allInFeePct.toFixed(2)}%)` : '—'}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="font-semibold text-[var(--text)]">Supplier receives</span>
            <span className="font-mono text-[18px] font-semibold tabular-nums text-[var(--text)]">{state.quote ? `${state.quote.netReceived} ${currency}` : '—'}</span>
          </div>
        </div>
        {error ? <p className="text-[13px] text-[var(--error)]">{error}</p> : null}
        {stale ? (
          <Button size="sm" variant="ghost" onClick={() => setRefreshKey((key) => key + 1)} className="justify-self-start">
            Refresh quote
          </Button>
        ) : null}
        <p className="text-[12px] text-[var(--text-muted)]">*Fee and delivery time are illustrative; the rate you see is the rate written on-chain when you approve. Local delivery depends on the payout partner&apos;s rail.</p>
      </Card>

      {baseline && sendAmountUsd > 0 && state.quote ? (
        <Card padding="none" className="overflow-hidden">
          <table className="w-full text-[13px]">
            <caption className="sr-only">Cost comparison against generic categories</caption>
            <thead className="bg-[var(--surface-2)] text-[11px] uppercase tracking-[0.06em] text-[var(--text-muted)]">
              <tr>
                <th scope="col" className="px-4 py-2 text-left font-semibold">Route</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Cost</th>
                <th scope="col" className="px-4 py-2 text-right font-semibold">Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--divider)]">
              <tr className="bg-[var(--ok-bg)]/60">
                <td className="px-4 py-2 font-semibold">Splash</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums">{usd.format(quoteFeeUsd)} USD</td>
                <td className="px-4 py-2 text-right text-[var(--text-2)]">minutes, end to end*</td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-[var(--text-2)]">Fintech transfer</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-[var(--text-2)]">{usd.format(baselineCostUsd(baseline.fintech, sendAmountUsd))} USD</td>
                <td className="px-4 py-2 text-right text-[var(--text-2)]">{baseline.fintech.delivery}</td>
              </tr>
              <tr>
                <td className="px-4 py-2 text-[var(--text-2)]">Bank wire</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-[var(--text-2)]">{usd.format(baselineCostUsd(baseline.bankWire, sendAmountUsd))} USD</td>
                <td className="px-4 py-2 text-right text-[var(--text-2)]">{baseline.bankWire.delivery}</td>
              </tr>
            </tbody>
          </table>
          <p className="border-t border-[var(--divider)] px-4 py-2 text-[11px] text-[var(--text-muted)]">Illustrative, mid-market baseline · reviewed {baseline.lastReviewed} · generic categories only</p>
        </Card>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={() => void holdRate()} disabled={holdBusy || !state.quote || holdActive}>
          <Clock3 aria-hidden="true" /> {holdActive ? 'Rate held' : 'Hold this rate 48h'}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={prev}>
            Back
          </Button>
          <Button size="lg" onClick={next} disabled={!canContinue || stale}>
            Review payment
          </Button>
        </div>
      </div>
    </div>
  );
}

'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2, Clock3, Copy, Info, Loader2, RefreshCw, Send, ShieldCheck, TrendingUp, X } from 'lucide-react';
import { toast } from 'sonner';

import type { TransferState } from '@/app/dashboard/transfer/page';
import FundingSelector from '@/components/funding/FundingSelector';
import HoverPopup from '@/components/HoverPopup';
import { SourceBadge } from '@/components/SourceBadge';
import MoneyPathPanel from '@/components/compliance/MoneyPathPanel';
import { baselineCostUsd, getComparisonBaseline } from '@/lib/fx/comparison-baselines';
import { lockedCopy } from '@/content/claims';

const BASE_RATES: Record<TransferState['amount']['targetCurrency'], number> = {
  MYR: 4.71,
  PHP: 56.42,
  IDR: 16284,
  SGD: 1.345,
  VND: 25385,
  THB: 35.82,
  EUR: 0.924,
  GBP: 0.789,
};

const primaryActionClass = 'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[#0C3E48] px-5 py-3 text-sm font-semibold text-white shadow-[0_14px_30px_rgba(12,62,72,0.22)] transition-all hover:-translate-y-0.5 hover:bg-[#145D6A] hover:shadow-[0_18px_34px_rgba(12,62,72,0.26)] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/28 disabled:cursor-not-allowed disabled:bg-[#326273]/45 disabled:text-white/70 disabled:shadow-none disabled:hover:translate-y-0';
const secondaryActionClass = 'inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-[#326273]/18 bg-white px-5 py-3 text-sm font-semibold text-[#0C3E48] shadow-[0_10px_22px_rgba(12,62,72,0.06)] transition-all hover:-translate-y-0.5 hover:border-[#5C9EAD]/70 hover:bg-[#EAF7F8] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20 disabled:cursor-not-allowed disabled:bg-[#F6F0ED] disabled:text-[#326273]/45 disabled:shadow-none disabled:hover:translate-y-0';

export default function StepQuote({
  state,
  set,
  prev,
  next,
}: {
  state: TransferState;
  set: (patch: Partial<TransferState>) => void;
  prev: () => void;
  next: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const quoteRequestKey = [
    state.amount.value,
    state.amount.targetCurrency,
    state.funding.selection.feeTier,
    state.rateHold?.corridorCurrency ?? '',
    state.rateHold?.rate ?? '',
    state.rateHold?.state ?? '',
    state.recipient.bank?.account ?? '',
  ].join('|');
  const [settledQuoteKey, setSettledQuoteKey] = useState<string | null>(null);
  const [agree, setAgree] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [checkingDeposit, setCheckingDeposit] = useState(false);
  const [progress, setProgress] = useState(18);
  const [liveRate, setLiveRate] = useState(BASE_RATES[state.amount.targetCurrency]);
  const [rateDirection] = useState<'up' | 'down' | 'neutral'>('neutral');
  const [holdBusy, setHoldBusy] = useState(false);
  // Maker-checker note beside the CTA reads the REAL threshold from operating
  // settings — never a hardcoded figure (W9.1).
  const [approvalPolicy, setApprovalPolicy] = useState<{ thresholdUsd: number; dual: boolean } | null>(null);
  // Live countdown for the rate-lock chip while a hold is active.
  const [lockNowMs, setLockNowMs] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    void fetch('/api/settings')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { approvalThresholdUsd?: number; requireDualApproval?: boolean } | null) => {
        if (!active || !body || typeof body.approvalThresholdUsd !== 'number') return;
        setApprovalPolicy({ thresholdUsd: body.approvalThresholdUsd, dual: body.requireDualApproval ?? true });
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const holdActive = state.rateHold?.state === 'ACTIVE' && state.rateHold.corridorCurrency === state.amount.targetCurrency;
  useEffect(() => {
    if (!holdActive) return;
    const interval = window.setInterval(() => setLockNowMs(Date.now()), 30_000);
    return () => window.clearInterval(interval);
  }, [holdActive]);

  useEffect(() => {
    let cancelled = false;

    async function fetchQuote() {
      const source = Number.parseFloat(state.amount.value || '0');
      if (!Number.isFinite(source) || source <= 0) {
        set({ quote: { fxRate: 0, fee: '0.00', netReceived: '0.00' } });
        setSettledQuoteKey(quoteRequestKey);
        setLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: source,
            targetCurrency: state.amount.targetCurrency,
            recipientId: state.recipient.bank?.account,
            fundingFeeTier: state.funding.selection.feeTier,
          }),
        });
        if (!response.ok) throw new Error('Quote unavailable');
        const body = (await response.json()) as { exchangeRate: string; platformFee: number; toAmount: number };
        if (cancelled) return;

        const quotedFx = Number.parseFloat(body.exchangeRate);
        const heldFx = state.rateHold?.state === 'ACTIVE' && state.rateHold.corridorCurrency === state.amount.targetCurrency
          ? Number.parseFloat(state.rateHold.rate)
          : null;
        const fx = heldFx ?? quotedFx;
        const netReceived = heldFx && quotedFx > 0 ? (body.toAmount / quotedFx) * heldFx : body.toAmount;
        setLiveRate(fx);
        set({ quote: { fxRate: fx, fee: (body.platformFee / 100).toFixed(2), netReceived: netReceived.toFixed(2) } });
        setSettledQuoteKey(quoteRequestKey);
      } catch {
        if (cancelled) return;
        const discount = state.funding.selection.feeTier === 'DISCOUNT' ? 0.002 : 0;
        const fee = source * Math.max(0, 0.014 - discount) + 4.5;
        const net = source - fee;
        const fx = BASE_RATES[state.amount.targetCurrency];
        set({ quote: { fxRate: fx, fee: fee.toFixed(2), netReceived: (net * fx).toFixed(2) } });
        setSettledQuoteKey(quoteRequestKey);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    const timer = window.setTimeout(() => {
      setLoading(true);
      void fetchQuote();
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    state.amount.targetCurrency,
    state.amount.value,
    state.funding.selection.feeTier,
    state.rateHold?.corridorCurrency,
    state.rateHold?.rate,
    state.rateHold?.state,
    state.recipient.bank?.account,
    quoteRequestKey,
    set,
  ]);

  const createTransferIntent = useCallback(async () => {
    try {
      const selection = state.funding.selection;
      const response = await fetch('/api/transfers/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...state,
          fundingSessionId: state.funding.sessionId,
          fundingSelection: selection,
          paymentRail: selection.type === 'fiat' && selection.provider === 'AIRWALLEX'
            ? 'AIRWALLEX_WIRE'
            : selection.type === 'held'
              ? 'SPLASH_BALANCE'
              : 'SOURCE_DEPOSIT',
        }),
      });
      if (!response.ok) {
        const body = (await response.json()) as { error?: string };
        throw new Error(body.error ?? 'Send request failed');
      }

      const body = (await response.json()) as { transferIntentId: string };
      set({ transferIntentId: body.transferIntentId, txStatus: 'pending' });
      toast.success(selection.type === 'held' ? 'Splash balance debited' : selection.type === 'fiat' ? 'Provider deposit confirmed' : 'Coin source normalized to USDC');
      setDepositOpen(false);
      setIsSending(false);
      next();
    } catch (error) {
      setIsSending(false);
      toast.error(error instanceof Error ? error.message : 'Send request failed');
    }
  }, [next, set, state]);

  useEffect(() => {
    if (!isSending) return;
    const progressTimer = window.setInterval(() => setProgress((value) => Math.min(value + 18, 100)), 420);
    const authorizationTimer = window.setTimeout(() => void createTransferIntent(), 2200);
    return () => {
      window.clearInterval(progressTimer);
      window.clearTimeout(authorizationTimer);
    };
  }, [isSending, createTransferIntent]);

  async function startDeposit() {
    if (!agree || !state.quote) return;
    if (state.funding.selection.type === 'held') {
      setProgress(18);
      setIsSending(true);
      return;
    }
    setCreatingSession(true);
    setProgress(18);
    try {
      const response = await fetch('/api/funding/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amountUsd: Number.parseFloat(state.amount.value),
          selection: state.funding.selection,
        }),
      });
      const body = (await response.json()) as {
        error?: string;
        session?: { id: string; status: string; depositAddress?: string };
        qrDataUrl?: string | null;
        demoMode?: boolean;
      };
      if (!response.ok || !body.session) throw new Error(body.error ?? 'Funding session could not be created');
      set({
        funding: {
          ...state.funding,
          sessionId: body.session.id,
          sessionStatus: body.session.status,
          depositAddress: body.session.depositAddress,
          qrDataUrl: body.qrDataUrl,
          demoMode: body.demoMode,
        },
      });
      setDepositOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Funding session could not be created');
    } finally {
      setCreatingSession(false);
    }
  }

  async function checkStablecoinDeposit(simulate: boolean) {
    if (!state.funding.sessionId) return;
    setCheckingDeposit(true);
    try {
      const response = await fetch(
        `/api/funding/sessions/${encodeURIComponent(state.funding.sessionId)}`,
        simulate ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'SIMULATE_DEPOSIT' }),
        } : undefined,
      );
      const body = (await response.json()) as { error?: string; session?: { status: string } };
      if (!response.ok || !body.session) throw new Error(body.error ?? 'Deposit status could not be refreshed');
      set({ funding: { ...state.funding, sessionStatus: body.session.status } });
      if (body.session.status === 'CREDITED') toast.success('Deposit cleared KYT and normalized to USDC');
      if (body.session.status === 'QUARANTINED') toast.error('Deposit quarantined for operator review');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Deposit status could not be refreshed');
    } finally {
      setCheckingDeposit(false);
    }
  }

  async function holdRate() {
    setHoldBusy(true);
    try {
      const response = await fetch('/api/rate-holds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ corridorCurrency: state.amount.targetCurrency, rate: liveRate }),
      });
      if (!response.ok) throw new Error('Rate hold could not be created');
      const hold = (await response.json()) as NonNullable<TransferState['rateHold']>;
      set({ rateHold: hold });
      toast.success('Rate hold active for 48 hours');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Rate hold could not be created');
    } finally {
      setHoldBusy(false);
    }
  }

  if (!state.quote) return <div className="py-10 text-center text-[#326273]/60">Fetching live FX and fee quote...</div>;

  const selection = state.funding.selection;
  const isQuoteRefreshing = loading || settledQuoteKey !== quoteRequestKey;
  const selectedFundingLabel = selectionLabel(selection);
  const feeValue = state.deliveryTier === 'STORED_BALANCE' ? '$0.00 transfer fee' : `$${state.quote.fee}`;

  // Everything below derives from the live quote object — no duplicated math.
  const sendAmountUsd = Number.parseFloat(state.amount.value || '0');
  const quoteFeeUsd = Number.parseFloat(state.quote.fee || '0');
  const allInFeePct = sendAmountUsd > 0 && Number.isFinite(quoteFeeUsd)
    ? (quoteFeeUsd / sendAmountUsd) * 100
    : 0;
  const lockRemainingLabel = holdActive && state.rateHold
    ? formatLockRemaining(new Date(state.rateHold.holdUntil).getTime() - lockNowMs)
    : null;
  const baseline = getComparisonBaseline(state.amount.targetCurrency);
  const rateDecimals = state.amount.targetCurrency === 'IDR' || state.amount.targetCurrency === 'VND' ? 0 : 3;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold text-[#326273]">Quote, review and send</h2>
        <p className="mt-1 text-sm text-[#326273]/60">Choose USD or USDC for this transfer. Provider and rail details stay below the selected option.</p>
      </div>

      <FundingSelector
        selection={selection}
        amountUsd={Number.parseFloat(state.amount.value || '0')}
        disabled={creatingSession || isSending}
        onChange={(nextSelection) => {
          set({
            funding: {
              selection: nextSelection,
              sessionId: undefined,
              sessionStatus: undefined,
              depositAddress: undefined,
              qrDataUrl: null,
              demoMode: undefined,
            },
          });
        }}
      />

      {/* Comparison card (W9.1 mockup 1): recipient → display amount → rate
          lock → all-in fee → supplier receives. All figures derive from the
          live quote object. */}
      <div className="rounded-xl bg-[#F6F0ED] p-5 text-sm">
        <HoverPopup title="Recipient" content="The business receiving this payment. Verify the name matches your records.">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-semibold text-[#1F4452]">{state.recipient.name || 'Supplier pending'}</span>
            <span className="text-[13px] font-medium text-[#326273]/60">
              {state.recipient.country}
              {state.recipient.bank?.account ? <span className="money"> · {state.recipient.bank.account}</span> : null}
            </span>
          </div>
        </HoverPopup>

        <div className="money mt-3 text-3xl font-semibold tracking-tight text-[#1F4452]">
          ${state.amount.value || '0'}
          <span className="ml-2 text-sm font-medium text-[#326273]/55">USD</span>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <HoverPopup title="Live FX rate" content="Rate may change when you refresh or authorize unless a rate hold is active.">
            <span className="money text-sm font-medium text-[#326273]">
              1 USD = {liveRate.toLocaleString(undefined, { maximumFractionDigits: rateDecimals })} {state.amount.targetCurrency}
            </span>
          </HoverPopup>
          {holdActive && lockRemainingLabel ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ok-bg)] px-2.5 py-1 text-[13px] font-medium text-[var(--ok)]">
              <Clock3 className="size-3.5" aria-hidden="true" />
              Rate locked · {lockRemainingLabel}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-2.5 py-1 text-[13px] font-medium text-[#326273]/60">
              <Clock3 className="size-3.5" aria-hidden="true" />
              Quote valid for 30 seconds
            </span>
          )}
          {rateDirection !== 'neutral' ? <TrendingUp className={rateDirection === 'up' ? 'text-[var(--info)]' : 'rotate-180 text-[var(--warn)]'} /> : null}
        </div>

        <div className="mt-4 h-px bg-[#326273]/10" />

        <div className="mt-3 flex items-center justify-between gap-4">
          <span className="text-[#326273]/60">All-in fee ({selection.feeTier})</span>
          <span className="money inline-flex items-center gap-2 font-medium text-[#326273]">
            {feeValue}
            {sendAmountUsd > 0 ? <span className="text-[13px] text-[#326273]/55">({allInFeePct.toFixed(2)}%)</span> : null}
            {isQuoteRefreshing ? <Loader2 className="size-3.5 animate-spin text-[var(--info)]" aria-label="Refreshing quote" /> : null}
          </span>
        </div>

        <div className="mt-3 flex items-baseline justify-between gap-4">
          <span className="font-medium text-[#326273]">Supplier receives</span>
          <span className="money text-xl font-semibold text-[#1F4452]">
            {state.quote.netReceived} {state.amount.targetCurrency}
          </span>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[13px] text-[#326273]/60">
          {isQuoteRefreshing ? <Loader2 className="size-3.5 animate-spin text-[var(--info)]" aria-hidden="true" /> : <Info className="size-3.5" aria-hidden="true" />}
          {isQuoteRefreshing
            ? `Updating quote for ${selectedFundingLabel}.`
            : holdActive && state.rateHold ? `Rate hold active until ${new Date(state.rateHold.holdUntil).toLocaleString()}.` : `Funding from ${selectedFundingLabel}.`}
        </div>
      </div>

      {/* Comparison strip — generic categories only; hidden when the corridor
          has no reviewed baseline. Named competitors stay off until sourced
          numbers are approved into the claims register. */}
      {baseline && sendAmountUsd > 0 ? (
        <div className="overflow-hidden rounded-xl border border-[#326273]/12 bg-white">
          <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-0 border-b border-[#326273]/10 bg-[#F6F0ED]/70 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#326273]/55">
            <span>Route</span>
            <span className="text-right">Cost</span>
            <span className="text-right">Delivery</span>
          </div>
          <div className="divide-y divide-[#326273]/8 text-sm">
            <div className="grid grid-cols-[1.2fr_1fr_1fr] items-center px-4 py-2.5 bg-[var(--ok-bg)]/50">
              <span className="font-semibold text-[#1F4452]">Splash</span>
              <span className="money text-right font-semibold text-[#1F4452]">{feeValue}</span>
              <span className="text-right text-[13px] font-medium text-[#326273]/70">{lockedCopy.speed}</span>
            </div>
            <div className="grid grid-cols-[1.2fr_1fr_1fr] items-center px-4 py-2.5">
              <span className="font-medium text-[#326273]/75">Fintech transfer</span>
              <span className="money text-right font-medium text-[#326273]/75">${baselineCostUsd(baseline.fintech, sendAmountUsd).toFixed(2)}</span>
              <span className="text-right text-[13px] font-medium text-[#326273]/60">{baseline.fintech.delivery}</span>
            </div>
            <div className="grid grid-cols-[1.2fr_1fr_1fr] items-center px-4 py-2.5">
              <span className="font-medium text-[#326273]/75">Bank wire</span>
              <span className="money text-right font-medium text-[#326273]/75">${baselineCostUsd(baseline.bankWire, sendAmountUsd).toFixed(2)}</span>
              <span className="text-right text-[13px] font-medium text-[#326273]/60">{baseline.bankWire.delivery}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-[#326273]/10 bg-[#F6F0ED]/50 px-4 py-2 text-[11px] font-medium text-[#326273]/55">
            <SourceBadge state="modeled" />
            Illustrative, mid-market baseline · reviewed {baseline.lastReviewed}
          </div>
        </div>
      ) : null}

      <button type="button" disabled={holdBusy || isQuoteRefreshing || state.rateHold?.state === 'ACTIVE'} onClick={() => void holdRate()} className="group flex min-h-12 w-full items-center justify-between gap-3 rounded-xl border border-[#5C9EAD]/35 bg-white px-4 py-3 text-left font-semibold text-[#0C3E48] shadow-[0_10px_24px_rgba(12,62,72,0.06)] transition-all hover:-translate-y-0.5 hover:border-[#5C9EAD]/80 hover:bg-[#EAF7F8] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20 disabled:cursor-not-allowed disabled:border-[#326273]/10 disabled:bg-[#F6F0ED] disabled:text-[#326273]/50 disabled:shadow-none disabled:hover:translate-y-0">
        <span className="flex items-center gap-3"><Clock3 className="size-4 text-[var(--info)]" aria-hidden="true" />{state.rateHold?.state === 'ACTIVE' ? 'Rate hold active' : 'Hold this rate 48h'}</span>
        <span className="font-mono text-[13px] text-[#326273]/55">{liveRate.toLocaleString()}</span>
      </button>

      <div className="rounded-xl border border-[#5C9EAD]/20 bg-[#5C9EAD]/10 p-4 text-sm text-[#326273]/75">
        <div className="flex gap-3">
          <ShieldCheck />
          <span>{selection.type === 'held'
            ? 'Splash balance is ready to settle, so no additional funding sub-flow is required.'
            : selection.type === 'fiat'
              ? 'USD bank funding uses Stripe or Airwallex. Cards remain disabled, and funds settle on the Splash network.'
              : 'USDC deposits use a deposit address and QR. KYT clears before credit, and only native Sui USDC reaches settlement.'}</span>
        </div>
      </div>

      {/* W9.4 — where the money sits on this payment's path (config-driven). */}
      <MoneyPathPanel compact />


      <label className="flex items-start gap-3 text-sm text-[#326273]/80">
        <input type="checkbox" checked={agree} onChange={(event) => setAgree(event.target.checked)} className="mt-1 size-4 cursor-pointer rounded border-[#326273]/30 bg-white accent-[#5C9EAD]" />
        I confirm the recipient details are correct and I want to continue from {selectedFundingLabel}.
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <button type="button" onClick={prev} className={secondaryActionClass}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </button>
        <button type="button" disabled={!agree || isQuoteRefreshing || creatingSession || isSending} onClick={() => void startDeposit()} className={primaryActionClass}>
          {creatingSession || isSending || isQuoteRefreshing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
          {isQuoteRefreshing ? 'Updating quote...' : creatingSession || isSending ? 'Preparing...' : 'Send'}
        </button>
      </div>

      {/* Maker-checker note — reads the REAL threshold from operating settings. */}
      {approvalPolicy ? (
        <div className="flex items-center gap-2 text-[13px] font-medium text-[#326273]/65">
          <ShieldCheck className="size-4 shrink-0 text-[var(--info)]" aria-hidden="true" />
          {approvalPolicy.dual && sendAmountUsd > approvalPolicy.thresholdUsd
            ? <span>Over the <span className="money">${approvalPolicy.thresholdUsd.toLocaleString()}</span> approval threshold — a second approver signs before settlement.</span>
            : <span>Under the <span className="money">${approvalPolicy.thresholdUsd.toLocaleString()}</span> approval threshold — one approver signs before settlement.</span>}
        </div>
      ) : null}

      {isSending && !depositOpen ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-[#5C9EAD]/25 bg-[#5C9EAD]/10 p-4">
          <div className="h-3 overflow-hidden rounded-full bg-white"><div className="h-full rounded-full bg-[#5C9EAD] transition-all" style={{ width: `${progress}%` }} /></div>
          <div className="flex items-center gap-2 text-sm font-medium text-[#326273]/70"><Loader2 className="animate-spin" /> Debiting source and preparing settlement...</div>
        </div>
      ) : null}

      {depositOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#326273]/50 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-6 text-[#326273] shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="mb-2 inline-flex rounded-full bg-[#E39774]/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[#E39774]">{selection.type === 'fiat' ? 'Provider deposit' : 'USDC deposit'}</div>
                <h3 className="text-2xl font-semibold">{selection.type === 'fiat' ? `Continue with ${selection.provider}` : selection.type === 'stablecoin' ? `Deposit ${selection.asset}` : 'Settle from Splash balance'}</h3>
                <p className="mt-1 text-sm text-[#326273]/60">{selection.type === 'fiat' ? 'Provider funding is confirmed before settlement.' : 'Send USDC over the selected rail using the push-only deposit address.'}</p>
              </div>
              <button type="button" aria-label="Close funding dialog" onClick={() => !isSending && setDepositOpen(false)} className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-[#326273]/55 transition hover:bg-[#F6F0ED] hover:text-[#0C3E48] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20 disabled:cursor-not-allowed disabled:opacity-45" disabled={isSending}>
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-5 rounded-2xl bg-[#326273] p-5 text-white">
              <div className="flex items-center justify-between"><span className="text-sm text-white/65">Transfer amount</span><span className="text-2xl font-semibold">${state.amount.value}</span></div>
              <div className="mt-3 flex items-center justify-between text-sm"><span className="text-white/65">Fee tier</span><span className="font-medium">{selection.feeTier}</span></div>
            </div>

            {selection.type === 'stablecoin' ? (
              <div className="mt-5 grid gap-4 sm:grid-cols-[224px_1fr] sm:items-center">
                {state.funding.qrDataUrl ? <Image unoptimized src={state.funding.qrDataUrl} alt={`QR code for ${selection.asset} deposit`} width={224} height={224} className="mx-auto size-56 rounded-2xl border border-[#326273]/10 bg-[#F6F0ED] p-2" /> : null}
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[#326273]/55">Deposit address</div>
                  <div className="mt-2 break-all rounded-xl bg-[#F6F0ED] p-3 font-['DejaVu_Sans_Mono',monospace] text-[13px] text-[#326273]">{state.funding.depositAddress}</div>
                  <button type="button" onClick={() => { void navigator.clipboard.writeText(state.funding.depositAddress ?? ''); toast.success('Deposit address copied'); }} className="mt-2 inline-flex items-center gap-2 rounded-lg px-1 py-1 text-[13px] font-semibold text-[#237284] transition hover:bg-[#5C9EAD]/10 hover:text-[#0C3E48] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#5C9EAD]/20"><Copy className="size-3.5" aria-hidden="true" /> Copy address</button>
                  <div className="mt-4 flex flex-wrap gap-2 text-[13px] font-semibold">
                    <span className="rounded-full bg-[#5C9EAD]/10 px-3 py-1">{selection.rail}{selection.sourceChain ? ` / ${selection.sourceChain}` : ''}</span>
                    <span className="rounded-full bg-[#F6F0ED] px-3 py-1">{state.funding.sessionStatus}</span>
                  </div>
                </div>
              </div>
            ) : null}

            {isSending ? (
              <div className="mt-5 flex flex-col gap-3">
                <div className="h-3 overflow-hidden rounded-full bg-[#F6F0ED]"><div className="h-full rounded-full bg-[#5C9EAD] transition-all" style={{ width: `${progress}%` }} /></div>
                <div className="flex items-center gap-2 text-sm font-medium text-[#326273]/70">{progress >= 100 ? <CheckCircle2 /> : <Loader2 className="animate-spin" />} Confirming funding...</div>
              </div>
            ) : null}

            {selection.type === 'fiat' ? (
              <button type="button" disabled={isSending} onClick={() => { setProgress(18); setIsSending(true); }} className={`mt-5 w-full ${primaryActionClass}`}>
                {isSending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                {isSending ? 'Confirming deposit...' : `Continue with ${selection.provider}`}
              </button>
            ) : state.funding.sessionStatus === 'CREDITED' ? (
              <button type="button" disabled={isSending} onClick={() => { setProgress(18); setIsSending(true); }} className={`mt-5 w-full ${primaryActionClass}`}>
                {isSending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Send className="size-4" aria-hidden="true" />}
                {isSending ? 'Starting settlement...' : 'Continue to settlement'}
              </button>
            ) : (
              <div className={state.funding.demoMode ? 'mt-5 grid gap-2 sm:grid-cols-2' : 'mt-5'}>
                <button type="button" disabled={checkingDeposit} onClick={() => void checkStablecoinDeposit(false)} className={`w-full ${secondaryActionClass}`}>
                  <RefreshCw className={checkingDeposit ? 'size-4 animate-spin' : 'size-4'} aria-hidden="true" />
                  Check deposit status
                </button>
                {state.funding.demoMode ? (
                  <button type="button" disabled={checkingDeposit} onClick={() => void checkStablecoinDeposit(true)} className={`w-full ${primaryActionClass}`}>
                    {checkingDeposit ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="size-4" aria-hidden="true" />}
                    {checkingDeposit ? 'Processing...' : 'Simulate test deposit'}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Human remaining-time for the rate-lock chip, from the REAL hold expiry. */
function formatLockRemaining(remainingMs: number) {
  if (remainingMs <= 0) return null;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  return `${Math.max(1, minutes)}m left`;
}

function selectionLabel(selection: TransferState['funding']['selection']) {
  if (selection.type === 'held') return 'Splash balance';
  if (selection.type === 'fiat') return `Bank USD via ${selection.provider}`;
  return `${selection.asset} via ${selection.rail}${selection.sourceChain ? ` / ${selection.sourceChain}` : ''}`;
}

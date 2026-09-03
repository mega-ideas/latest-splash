'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowRightLeft,
  BadgeCheck,
  Check,
  CircleDollarSign,
  Clock3,
  Landmark,
  ShieldCheck,
  Sparkles,
  Timer,
  WalletCards,
  type LucideIcon,
} from 'lucide-react';
import SettlementEngineFlow from '@/components/dashboard/SettlementEngineFlow';

import StepBeneficiary from '@/components/transfer/StepBeneficiary';
import StepQuote from '@/components/transfer/StepQuote';
import StepReceipt from '@/components/transfer/StepReceipt';
import StepStatus from '@/components/transfer/StepStatus';
import StepDelivery from '@/components/transfer/StepDelivery';
import type { RecipientTier } from '@/lib/server/operations';
import type { FundingSelection } from '@/lib/funding/registry';

// Target-currency display metadata for the settlement-flow corridor node.
const CURRENCY_META: Record<string, { flag: string; country: string }> = {
  PHP: { flag: 'PH', country: 'Philippines' },
  MYR: { flag: 'MY', country: 'Malaysia' },
  IDR: { flag: 'ID', country: 'Indonesia' },
  SGD: { flag: 'SG', country: 'Singapore' },
  VND: { flag: 'VN', country: 'Vietnam' },
  THB: { flag: 'TH', country: 'Thailand' },
  EUR: { flag: 'EU', country: 'Eurozone' },
  GBP: { flag: 'GB', country: 'United Kingdom' },
};

export type TransferState = {
  step: 1 | 2 | 3 | 4 | 5;
  invoiceId?: string;
  recipient: {
    name: string;
    country: 'MY' | 'PH' | 'ID' | 'SG' | 'VN' | 'TH' | 'EU' | 'GB';
    rail: 'bank';
    bank?: { swift: string; account: string };
  };
  amount: { value: string; sourceCurrency: 'USD'; targetCurrency: 'MYR' | 'PHP' | 'IDR' | 'SGD' | 'VND' | 'THB' | 'EUR' | 'GBP' };
  quote?: { fxRate: number; netReceived: string; fee: string };
  funding: {
    selection: FundingSelection;
    sessionId?: string;
    sessionStatus?: string;
    depositAddress?: string;
    qrDataUrl?: string | null;
    demoMode?: boolean;
  };
  txDigest?: string;
  txStatus?: 'pending' | 'success' | 'failed';
  transferIntentId?: string;
  receiptObjectId?: string;
  paymentIntentId?: string;
  intentCreateDigest?: string;
  walrusBlobId?: string;
  auditAnchorId?: string;
  composedActions?: Array<{
    kind: 'paid' | 'allocated' | 'anchored';
    label: string;
    eventType: string;
    data: Record<string, unknown>;
  }>;
  deliveryTier: RecipientTier;
  rateHold?: {
    id: string;
    corridorCurrency: string;
    rate: string;
    feeBps: number;
    holdUntil: string;
    state: 'ACTIVE' | 'EXECUTED' | 'EXPIRED' | 'CANCELLED';
  };
};

const initial: TransferState = {
  step: 1,
  recipient: { name: '', country: 'PH', rail: 'bank' },
  amount: { value: '', sourceCurrency: 'USD', targetCurrency: 'PHP' },
  deliveryTier: 'PAYOUT_ONLY',
  funding: {
    selection: { source: 'BANK_USD', type: 'fiat', provider: 'STRIPE', feeTier: 'STANDARD' },
  },
};

const stepLabels = ['Beneficiary', 'Delivery', 'Quote & Send', 'Status', 'Receipt'] as const;

const sidePanels = [
  {
    icon: ShieldCheck,
    title: 'Credentials',
    metric: 'Vaultless',
    body: 'Provider deposits confirm externally, so bank logins stay out of the Splash flow.',
  },
  {
    icon: Timer,
    title: 'Rate control',
    metric: '30s hold',
    body: 'Live FX is locked at authorization and refreshed before signing if the hold expires.',
  },
  {
    icon: Sparkles,
    title: 'Settlement',
    metric: '~400ms',
    body: 'Sui finality anchors the payment trail with receipts ready for audit review.',
  },
];

export default function TransferPage() {
  const [state, setState] = useState<TransferState>(initial);
  const set = useCallback((patch: Partial<TransferState>) => {
    setState((previous) => ({ ...previous, ...patch }));
  }, []);
  const go = useCallback((step: TransferState['step']) => {
    set({ step });
  }, [set]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invoiceId = params.get('invoiceId');
    const holdId = params.get('holdId');
    if (invoiceId) {
      void fetch(`/api/invoices/${invoiceId}`).then((response) => response.json()).then((invoice: { payerOrgName?: string; amountUsd?: string; targetCurrency?: TransferState['amount']['targetCurrency']; id?: string }) => {
        if (!invoice.id) return;
        setState((current) => ({
          ...current,
          step: 2,
          invoiceId: invoice.id,
          recipient: { ...current.recipient, name: invoice.payerOrgName ?? current.recipient.name, country: 'PH' },
          amount: { ...current.amount, value: invoice.amountUsd ?? current.amount.value, targetCurrency: invoice.targetCurrency ?? current.amount.targetCurrency },
          deliveryTier: invoice.targetCurrency === 'PHP' ? 'SWEEP_ACCOUNT' : 'PAYOUT_ONLY',
        }));
      });
    }
    if (holdId) {
      void fetch(`/api/rate-holds?id=${encodeURIComponent(holdId)}`).then((response) => response.json()).then((hold: TransferState['rateHold']) => {
        if (!hold?.id || hold.state !== 'ACTIVE') return;
        setState((current) => ({
          ...current,
          rateHold: hold,
          amount: { ...current.amount, targetCurrency: hold.corridorCurrency as TransferState['amount']['targetCurrency'] },
        }));
      });
    }
  }, []);

  const selectedCurrency = CURRENCY_META[state.amount.targetCurrency];
  const destinationLabel = selectedCurrency?.country ?? state.recipient.country;
  const currentStepLabel = stepLabels[state.step - 1];
  const amountLabel = state.amount.value ? `${formatUsd(state.amount.value)} USD` : 'Amount pending';
  const payoutLabel = state.quote?.netReceived
    ? `${state.quote.netReceived} ${state.amount.targetCurrency}`
    : `${state.amount.targetCurrency} pending`;
  const recipientLabel = state.recipient.name || 'Beneficiary pending';
  const quoteLabel = state.rateHold?.state === 'ACTIVE'
    ? 'Rate hold active'
    : state.quote
    ? 'Quote ready'
    : 'Quote pending';
  const transferStatus = state.txStatus === 'success'
    ? 'Settled'
    : state.txStatus === 'failed'
    ? 'Action needed'
    : state.txDigest
    ? 'Broadcast'
    : 'Draft';

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <header className="dash-reveal overflow-hidden rounded-2xl border border-[#0c3e48]/30 bg-[#0c3e48] text-white shadow-[8px_8px_0_rgba(12,62,72,0.14)]">
        <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_300px] md:p-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/75">
                Payment intent
              </span>
              <span className="inline-flex items-center gap-2 rounded-md border border-[#8FD7C7]/30 bg-[#8FD7C7]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#D9FFF6]">
                <BadgeCheck className="h-3.5 w-3.5" />
                {transferStatus}
              </span>
            </div>
            <h1 className="mt-4 text-3xl font-bold tracking-tight text-white md:text-4xl">
              Send a payout
            </h1>
            <p className="mt-2 max-w-2xl text-sm font-medium leading-6 text-white/70">
              Capture the beneficiary, choose delivery, lock the USD quote, and finish with an audit-ready receipt.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2 text-[13px] font-semibold text-white/70">
              <span className="rounded-md border border-white/20 bg-white/10 px-3 py-2 font-mono text-white">
                USD -&gt; {state.amount.targetCurrency}
              </span>
              <span className="rounded-md border border-white/20 bg-white/10 px-3 py-2">
                {destinationLabel}
              </span>
              <span className="rounded-md border border-white/20 bg-white/10 px-3 py-2">
                {quoteLabel}
              </span>
            </div>
          </div>

          <div className="grid content-between gap-4 border-t border-white/20 pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/50">Current step</div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-xl font-bold text-white">{currentStepLabel}</div>
                  <div className="mt-1 text-[13px] font-medium text-white/55">Step {state.step} of 5</div>
                </div>
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-[#E39774] text-sm font-bold text-white">
                  {state.step}/5
                </div>
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-[#8FD7C7] transition-all"
                style={{ width: `${(state.step / stepLabels.length) * 100}%` }}
              />
            </div>
          </div>
        </div>
        <div className="grid border-t border-white/20 md:grid-cols-4">
          <SummaryMetric icon={CircleDollarSign} label="Send amount" value={amountLabel} />
          <SummaryMetric icon={ArrowRightLeft} label="Payout" value={payoutLabel} />
          <SummaryMetric icon={Landmark} label="Rail" value={state.recipient.rail.toUpperCase()} />
          <SummaryMetric icon={Clock3} label="Quote" value={quoteLabel} />
        </div>
      </header>

      <SettlementEngineFlow
        variant="settlement"
        className="dash-reveal"
        corridors={[{
          flag: selectedCurrency?.flag,
          label: state.amount.targetCurrency,
          sublabel: destinationLabel,
        }]}
        captions={['400ms Sui finality', 'Quote locked at signing', 'On-chain receipt']}
      />

      <Stepper current={state.step} />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_360px]">
        <div className="dash-surface p-4 md:p-6">
          {state.step === 1 && <StepBeneficiary state={state} set={set} next={() => go(2)} />}
          {state.step === 2 && <StepDelivery state={state} set={set} prev={() => go(1)} next={() => go(3)} />}
          {state.step === 3 && <StepQuote state={state} set={set} prev={() => go(2)} next={() => go(4)} />}
          {state.step === 4 && <StepStatus state={state} set={set} next={() => go(5)} />}
          {state.step === 5 && <StepReceipt state={state} reset={() => setState(initial)} />}
        </div>

        <aside className="space-y-3 dash-reveal-stagger">
          <div className="overflow-hidden rounded-2xl border border-[#0c3e48] bg-[#0c3e48] text-white shadow-[6px_7px_0_rgba(12,62,72,0.18)]">
            <div className="border-b border-white/10 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/50">Live transfer</div>
                  <div className="mt-2 text-xl font-bold">{amountLabel}</div>
                </div>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/10 text-[#8FD7C7]">
                  <WalletCards className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-3 min-w-0 text-[13px] font-medium text-white/60">
                <span className="block truncate">To {recipientLabel}</span>
                <span className="mt-1 block font-mono text-white/80">USD -&gt; {state.amount.targetCurrency}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 border-b border-white/10 text-[13px]">
              <Pill label="Target" value={state.amount.targetCurrency} />
              <Pill label="Country" value={destinationLabel} />
            </div>
            <RouteLine source="USD" target={state.amount.targetCurrency} />
          </div>

          {sidePanels.map((panel) => (
            <SignalRow key={panel.title} {...panel} />
          ))}
        </aside>
      </section>
    </div>
  );
}

function formatUsd(value: string) {
  const parsed = Number.parseFloat(value.replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return `$${value}`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(parsed);
}

function SummaryMetric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 border-b border-white/20 px-4 py-3 last:border-b-0 last:border-r-0 md:border-b-0 md:border-r">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 text-[#8FD7C7]">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-white/45">{label}</span>
        <span className="mt-1 block truncate text-sm font-bold text-white">{value}</span>
      </span>
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-r border-white/10 px-4 py-3 last:border-r-0">
      <div className="text-[10px] uppercase tracking-wide text-white/55">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm font-medium text-white">{value}</div>
    </div>
  );
}

function RouteLine({ source, target }: { source: string; target: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 p-4">
      <RouteNode label="Source" value={source} />
      <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-white/20 bg-white/10 text-[#8FD7C7]">
        <ArrowRightLeft className="h-4 w-4" />
      </div>
      <RouteNode label="Destination" value={target} alignRight />
    </div>
  );
}

function RouteNode({ label, value, alignRight = false }: { label: string; value: string; alignRight?: boolean }) {
  return (
    <div className={alignRight ? 'min-w-0 text-right' : 'min-w-0'}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.15em] text-white/45">{label}</div>
      <div className="mt-1 truncate font-mono text-sm font-bold text-white">{value}</div>
    </div>
  );
}

function SignalRow({ icon: Icon, title, metric, body }: { icon: LucideIcon; title: string; metric: string; body: string }) {
  return (
    <div className="dash-block p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#5C9EAD]/10 text-[#326273]">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="text-sm font-bold text-[#326273]">{title}</div>
            <div className="shrink-0 rounded-md bg-[#326273]/10 px-2 py-1 font-mono text-[13px] font-bold text-[#326273]">
              {metric}
            </div>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-[#326273]/65">{body}</p>
        </div>
      </div>
    </div>
  );
}

function Stepper({ current }: { current: number }) {
  return (
    <ol className="dash-surface grid overflow-hidden sm:grid-cols-5">
      {stepLabels.map((label, index) => {
        const step = index + 1;
        const active = step === current;
        const done = step < current;
        const last = step === stepLabels.length;

        return (
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className={`relative flex min-h-[74px] items-center gap-3 px-4 py-3 transition-colors ${active ? 'bg-[#0c3e48]/[0.06]' : 'bg-transparent'} ${last ? '' : 'border-b border-[#326273]/10 sm:border-b-0 sm:border-r'}`}
          >
            <span
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold transition-all ${done
                ? 'bg-[#5C9EAD] text-white shadow-md shadow-[#5C9EAD]/30'
                : active
                ? 'bg-[#E39774] text-white shadow-md shadow-[#E39774]/30'
                : 'bg-[#326273]/10 text-[#326273]/55'}`}
            >
              {done ? <Check className="h-4 w-4" /> : step}
            </span>
            <div className="min-w-0 flex-1">
              <div className={`text-[10px] font-semibold uppercase tracking-[0.18em] ${active ? 'text-[#E39774]' : done ? 'text-[var(--info)]' : 'text-[#326273]/45'}`}>
                Step {step}
              </div>
              <div className={`mt-0.5 truncate text-sm font-bold leading-tight ${active || done ? 'text-[#326273]' : 'text-[#326273]/55'}`}>
                {label}
              </div>
            </div>
            {active && (
              <span className="absolute inset-y-0 left-0 w-[3px] bg-[#E39774] sm:inset-x-0 sm:inset-y-auto sm:bottom-0 sm:h-[3px] sm:w-auto" aria-hidden="true" />
            )}
            {done && (
              <span className="absolute inset-y-0 left-0 w-[3px] bg-[#5C9EAD] sm:inset-x-0 sm:inset-y-auto sm:bottom-0 sm:h-[3px] sm:w-auto" aria-hidden="true" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

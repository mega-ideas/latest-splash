'use client';

import { useEffect, useMemo, useState } from 'react';
import { Banknote, CheckCircle2, Globe2, Loader2, Network, XCircle } from 'lucide-react';

import type { TransferState } from '@/app/dashboard/transfer/page';

/** Destination country names for the "Sent to …" stage (human language). */
const COUNTRY_NAMES: Record<string, string> = {
  PH: 'the Philippines', MY: 'Malaysia', ID: 'Indonesia', SG: 'Singapore',
  VN: 'Vietnam', TH: 'Thailand', EU: 'the Eurozone', GB: 'the United Kingdom',
};

/** Real stage timestamp from the lifecycle audit trail (W9.5 — never faked). */
function stageTimestamp(history: Array<{ state: string; at: string }>, states: string[]): string | null {
  const hit = history.find((entry) => states.includes(entry.state));
  if (!hit) return null;
  const date = new Date(hit.at);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function StepStatus({ state, set, next }: { state: TransferState; set: (patch: Partial<TransferState>) => void; next: () => void }) {
  const [chainState, setChainState] = useState<'AUTHORIZED' | 'QUEUED' | 'SETTLING' | 'SETTLED' | 'SWEEPING' | 'DISBURSED' | 'CREDITED' | 'FAILED'>('AUTHORIZED');
  const [heldDurationMs, setHeldDurationMs] = useState<number | null>(null);
  const [failureReason, setFailureReason] = useState<string | null>(null);
  const [statusHistory, setStatusHistory] = useState<Array<{ state: string; at: string }>>([]);

  useEffect(() => {
    if (!state.transferIntentId) return;

    let cancelled = false;
    let timeout: number;

    async function pollStatus() {
      try {
        const response = await fetch(`/api/transfers/${state.transferIntentId}`);

        if (!response.ok) {
          throw new Error('Status unavailable');
        }

        const result = (await response.json()) as {
          state: 'AUTHORIZED' | 'QUEUED' | 'SETTLING' | 'SETTLED' | 'SWEEPING' | 'DISBURSED' | 'CREDITED' | 'FAILED';
          verificationReference: string | null;
          receiptObjectId: string | null;
          paymentIntentId?: string;
          intentCreateDigest?: string;
          walrusBlobId?: string;
          auditAnchorId?: string;
          composedActions?: TransferState['composedActions'];
          failureReason: string | null;
          failedAtState: string | null;
          sweepJob: { heldDurationMs?: number } | null;
          statusHistory?: Array<{ state: string; at: string }>;
        };

        if (cancelled) return;

        setChainState(result.state);
        setStatusHistory(result.statusHistory ?? []);

        if (result.state === 'DISBURSED' || result.state === 'CREDITED') {
          setHeldDurationMs(result.sweepJob?.heldDurationMs ?? null);
          set({
            txStatus: 'success',
            txDigest: result.verificationReference ?? undefined,
            receiptObjectId: result.receiptObjectId ?? undefined,
            paymentIntentId: result.paymentIntentId,
            intentCreateDigest: result.intentCreateDigest,
            walrusBlobId: result.walrusBlobId,
            auditAnchorId: result.auditAnchorId,
            composedActions: result.composedActions,
          });
          window.setTimeout(next, 1800);
          return;
        }

        if (result.state === 'FAILED') {
          setFailureReason(result.failureReason ?? null);
          set({ txStatus: 'failed' });
          return;
        }

        set({ txStatus: 'pending' });
        timeout = window.setTimeout(pollStatus, 900);
      } catch {
        if (!cancelled) {
          set({ txStatus: 'failed' });
        }
      }
    }

    void pollStatus();

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [next, set, state.transferIntentId]);

  const status = state.txStatus ?? 'pending';
  const activeIndex = useMemo(() => {
    if (status === 'failed' || chainState === 'FAILED') return -1;
    if (chainState === 'DISBURSED' || chainState === 'CREDITED') return 3;
    if (chainState === 'SETTLED' || chainState === 'SWEEPING') return 2;
    if (chainState === 'SETTLING') return 1;
    if (chainState === 'QUEUED') return 1;
    return 0;
  }, [chainState, status]);
  // W9.5 — four human stages; each carries the REAL timestamp of its
  // lifecycle transition from the audit trail (null until it happens).
  const destination = COUNTRY_NAMES[state.recipient.country] ?? state.recipient.country;
  const stages = [
    {
      label: 'Payment approved',
      detail: state.funding.selection.type === 'held'
        ? `Splash balance debited $${state.amount.value || '0.00'}`
        : state.funding.selection.type === 'fiat'
          ? `${state.funding.selection.provider} deposit confirmed $${state.amount.value || '0.00'}`
          : `${state.funding.selection.asset} passed KYT and normalized to native USDC`,
      icon: Banknote,
      at: stageTimestamp(statusHistory, ['AUTHORIZED', 'DEPOSIT_CONFIRMED']),
    },
    {
      label: 'Funds converted',
      detail: `USD converted at the quoted rate for ${state.amount.targetCurrency}`,
      icon: Network,
      at: stageTimestamp(statusHistory, ['EXCHANGED', 'QUEUED', 'SETTLING']),
    },
    {
      label: `Sent to ${destination}`,
      detail: state.deliveryTier === 'SWEEP_ACCOUNT' ? `Local partner converts and pays ${state.amount.targetCurrency}` : state.deliveryTier === 'STORED_BALANCE' ? 'Crediting reusable Splash balance' : `${state.amount.targetCurrency} payout moving on the local partner rail`,
      icon: Globe2,
      at: stageTimestamp(statusHistory, ['SETTLED', 'SWEEPING']),
    },
    {
      label: 'Delivered',
      detail: 'Supplier money received and the receipt is being prepared',
      icon: CheckCircle2,
      at: stageTimestamp(statusHistory, ['DISBURSED', 'CREDITED']),
    },
  ];

  return (
    <div className="space-y-6 py-2">
      <div className="rounded-3xl bg-[#326273] p-6 text-white">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-[var(--info)]">
              {status === 'success' ? <CheckCircle2 className="h-3.5 w-3.5" /> : status === 'failed' ? <XCircle className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Live settlement
            </div>
            <h2 className="mt-3 text-2xl font-semibold">{status === 'success' ? 'Recipient payment confirmed' : status === 'failed' ? 'Settlement failed' : 'Moving money now'}</h2>
            <p className="mt-1 text-sm text-white/65">
              {status === 'success' ? 'Payment is confirmed. Redirecting to receipt...' : status === 'failed' ? 'No funds were released. Please retry this transfer.' : 'The selected source is being finalized through Splash on Sui.'}
            </p>
          </div>
          <div className="rounded-2xl bg-white/10 px-4 py-3 text-sm">
            <div className="text-white/55">Recipient receives</div>
            <div className="mt-1 text-xl font-semibold">{state.quote?.netReceived ?? '0.00'} {state.amount.targetCurrency}</div>
          </div>
        </div>
      </div>

      <div className="grid gap-3">
        {stages.map((stage, index) => {
          const Icon = stage.icon;
          const complete = activeIndex > index;
          const active = activeIndex === index && status !== 'failed';
          const deliveredNow = index === 3 && activeIndex === 3 && status === 'success';

          return (
            <div key={stage.label} className={`grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-2xl border p-4 transition-all ${deliveredNow ? 'motion-safe:animate-[dash-rise_.6s_var(--ease-decel)] border-[var(--ok)] bg-[var(--ok-bg)]' : complete ? 'border-[var(--ok)] bg-[var(--ok-bg)]' : active ? 'border-[var(--info)] bg-[var(--info-bg)] shadow-lg shadow-[#326273]/10' : status === 'failed' ? 'border-[var(--error)] bg-[var(--error-bg)]' : 'border-[#326273]/10 bg-[#F6F0ED]'}`}>
              <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ${complete || deliveredNow ? 'bg-[var(--ok)] text-white' : active ? 'bg-[var(--info)] text-white' : 'bg-white text-[#326273]/50'}`}>
                {complete || deliveredNow ? <CheckCircle2 className="h-5 w-5" /> : active ? <Loader2 className="h-5 w-5 animate-spin" /> : <Icon className="h-5 w-5" />}
              </div>
              <div>
                <div className="font-semibold text-[#326273]">{stage.label}</div>
                <div className="mt-1 text-[13px] text-[#326273]/60">{stage.detail}</div>
              </div>
              <div className="flex flex-col items-end gap-1">
                <div className={`rounded-full px-3 py-1 text-[13px] font-semibold ${complete || deliveredNow ? 'bg-[var(--ok-bg)] text-[var(--ok)]' : active ? 'bg-[var(--info-bg)] text-[var(--info)]' : 'bg-white text-[#326273]/45'}`}>
                  {complete || deliveredNow ? 'Done' : active ? 'Live' : 'Waiting'}
                </div>
                {stage.at ? <div className="money text-[13px] font-medium text-[#326273]/55">{stage.at}</div> : null}
              </div>
            </div>
          );
        })}
      </div>

      {failureReason && (
        <div className="rounded-2xl border border-[var(--error)] bg-[var(--error-bg)] p-4 text-sm text-[var(--error)]">
          <div className="mb-1 font-semibold">Error detail</div>
          <div className="font-mono text-[13px] leading-5 break-all">{failureReason}</div>
        </div>
      )}

      {heldDurationMs !== null && (
        <div className="rounded-2xl border border-primary/25 bg-primary/10 p-4 text-sm font-bold text-foreground">
          Pass-through held duration: {(heldDurationMs / 1000).toFixed(1)}s
        </div>
      )}

      {state.composedActions?.length ? (
        <section className="rounded-3xl border-2 border-[#5C9EAD]/35 bg-[#5C9EAD]/10 p-5">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#326273]/55">One composed Sui transaction</div>
          <h3 className="mt-1 text-lg font-semibold text-[#0c3e48]">Pay, allocate, and prove</h3>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {state.composedActions.map((action, index) => (
              <div key={`${action.kind}-${action.eventType}`} className="rounded-2xl border border-[#326273]/10 bg-white p-4">
                <div className="text-[13px] font-bold text-[#E39774]">0{index + 1}</div>
                <div className="mt-1 text-sm font-semibold text-[#326273]">{action.label}</div>
                <div className="mt-2 break-all font-mono text-[13px] text-[#326273]/50">{action.eventType}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {state.transferIntentId && <div className="break-all rounded-2xl bg-[#F6F0ED] p-4 font-mono text-[13px] text-[#326273]/55">Transfer intent: {state.transferIntentId}</div>}
    </div>
  );
}

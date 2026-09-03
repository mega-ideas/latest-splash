'use client';

import { useEffect, useState } from 'react';

import { SuiSettlementStack } from '@/components/illustrations/iso';
import { Badge, Button, Card, Chip } from '@/components/system';
import type { TransferState } from '@/lib/send/state';
import { cn } from '@/lib/utils';

type ChainState = 'AUTHORIZED' | 'DEPOSIT_CONFIRMED' | 'EXCHANGING' | 'EXCHANGED' | 'QUEUED' | 'SETTLING' | 'SETTLED' | 'SWEEPING' | 'DISBURSED' | 'CREDITED' | 'FAILED';

const STAGES = [
  { key: 'preparing', label: 'Preparing', detail: 'Funding confirmed, payment intent created.', states: ['AUTHORIZED', 'DEPOSIT_CONFIRMED'] },
  { key: 'settling', label: 'Settling on Sui', detail: 'One atomic transaction: pay · allocate · prove.', states: ['SETTLED'] },
  { key: 'sent', label: 'Sent to partner', detail: 'The licensed payout partner delivers the local currency.', states: ['DISBURSED', 'CREDITED'] },
] as const;

function stageFor(state: ChainState): number {
  if (state === 'DISBURSED' || state === 'CREDITED') return 3;
  if (state === 'SETTLED' || state === 'SWEEPING') return 2;
  if (state === 'QUEUED' || state === 'SETTLING' || state === 'EXCHANGING' || state === 'EXCHANGED') return 1;
  return 0;
}

/**
 * Non-dismissible processing screen: calm stroke animation, three stages,
 * real timestamps from the lifecycle history, no confetti. A failure shows
 * the reason and a retry; nothing leaves the balance on a failed run.
 */
export default function ProcessingStep({ state, set, next, retry }: { state: TransferState; set: (patch: Partial<TransferState>) => void; next: () => void; retry: () => void }) {
  const [chain, setChain] = useState<ChainState>('AUTHORIZED');
  const [failure, setFailure] = useState<string | null>(null);
  const [history, setHistory] = useState<Array<{ state: string; at: string }>>([]);

  useEffect(() => {
    if (!state.transferIntentId) return;
    let cancelled = false;
    let timer: number | undefined;
    async function poll() {
      try {
        const response = await fetch(`/api/transfers/${state.transferIntentId}`, { cache: 'no-store' });
        if (!response.ok) throw new Error('Status unavailable');
        const result = (await response.json()) as {
          state: ChainState;
          verificationReference: string | null;
          receiptObjectId: string | null;
          paymentIntentId?: string;
          intentCreateDigest?: string;
          walrusBlobId?: string;
          auditAnchorId?: string;
          composedActions?: TransferState['composedActions'];
          failureReason: string | null;
          statusHistory?: Array<{ state: string; at: string }>;
        };
        if (cancelled) return;
        setChain(result.state);
        setHistory(result.statusHistory ?? []);
        if (result.state === 'DISBURSED' || result.state === 'CREDITED') {
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
          window.setTimeout(next, 1400);
          return;
        }
        if (result.state === 'FAILED') {
          setFailure(result.failureReason ?? 'The settlement did not complete.');
          set({ txStatus: 'failed' });
          return;
        }
        set({ txStatus: 'pending' });
        timer = window.setTimeout(poll, 900);
      } catch {
        if (!cancelled) timer = window.setTimeout(poll, 2500);
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [next, set, state.transferIntentId]);

  const stage = failure ? -1 : stageFor(chain);
  const settled = stage >= 2;

  return (
    <div className="grid gap-6" aria-live="polite" aria-busy={!failure && stage < 3}>
      <div>
        <h2 className="text-[var(--text-h2)] font-semibold leading-[1.15] tracking-[-0.02em]">{failure ? 'Settlement did not complete' : settled ? 'Settled on Sui' : 'Moving your money'}</h2>
        <p className="mt-1 text-[14px] text-[var(--text-2)]">
          {failure ? 'No funds left your balance. You can retry once the reason below is resolved.' : `${state.quote?.netReceived ?? '—'} ${state.amount.targetCurrency} to ${state.recipient.name}. Keep this screen open; it updates on its own.`}
        </p>
      </div>

      <Card tone={settled ? 'dark' : 'default'} className="grid gap-4 md:grid-cols-[220px_1fr] md:items-center">
        <div className="mx-auto w-full max-w-[220px]">
          <SuiSettlementStack settled={settled} assembling={!failure && !settled} decorative />
        </div>
        <ol className="grid gap-3">
          {STAGES.map((entry, index) => {
            const done = stage > index;
            const active = stage === index;
            const at = history.find((event) => (entry.states as readonly string[]).includes(event.state))?.at;
            return (
              <li key={entry.key} className="grid grid-cols-[auto_1fr_auto] items-start gap-3">
                <span
                  className={cn(
                    'mt-0.5 flex size-6 items-center justify-center rounded-full border font-mono text-[11px]',
                    done && (settled ? 'border-[var(--ok)] bg-[var(--ok)] text-[var(--ink-900)]' : 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok-text)]'),
                    active && 'border-[var(--teal-600)] bg-[var(--teal-600)] text-[var(--signal-contrast)] motion-safe:animate-pulse',
                    !done && !active && (settled ? 'border-white/30 text-white/60' : 'border-[var(--line)] text-[var(--text-muted)]'),
                  )}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span>
                  <span className={cn('block text-[14px] font-semibold', settled ? 'text-white' : 'text-[var(--text)]')}>
                    {entry.label}
                    <span className="sr-only">{done ? ' complete' : active ? ' in progress' : ' pending'}</span>
                  </span>
                  <span className={cn('block text-[13px]', settled ? 'text-white/70' : 'text-[var(--text-2)]')}>{entry.detail}</span>
                </span>
                {at ? (
                  <time dateTime={at} className={cn('font-mono text-[12px]', settled ? 'text-white/60' : 'text-[var(--text-muted)]')}>
                    {new Date(at).toISOString().slice(11, 19)}Z
                  </time>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Card>

      {failure ? (
        <Card tone="tint" padding="sm" className="grid gap-3">
          <Badge tone="red">Returned</Badge>
          <p className="break-all font-mono text-[13px] text-[var(--text-2)]">{failure}</p>
          <div className="flex gap-2">
            <Button onClick={retry}>Start again</Button>
            <Button variant="ghost" href="/dashboard/customer-service">
              Contact support
            </Button>
          </div>
        </Card>
      ) : null}

      {state.composedActions?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {state.composedActions.map((action) => (
            <Chip key={`${action.kind}-${action.eventType}`} tone="green">
              {action.label}
            </Chip>
          ))}
        </div>
      ) : null}

      {state.transferIntentId ? <p className="font-mono text-[12px] text-[var(--text-muted)]">Intent {state.transferIntentId}</p> : null}
    </div>
  );
}

'use client';

import { ArrowDownToLine, ArrowUpFromLine, Bot } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import MoneyPathPanel from '@/components/compliance/MoneyPathPanel';
import DataTable from '@/components/shell/DataTable';
import { PageHeader, SummaryStrip } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { Button, ProofRow } from '@/components/system';
import { brand } from '@/lib/brand';
import { formatMoney } from '@/lib/money';
import type { TransferIntentRecord } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

type Snapshot = {
  available: number;
  treasuryPrincipal: number;
  treasuryYield: number;
  executionEnabled: boolean;
  rate: { apy: number; label: string; introductory: boolean };
  withdrawalWindowDays: number;
  withdrawalWindowLabel: string;
  notices: Array<{ id: string; amount: number; availableAt: string; state: string }>;
};

type Settings = { perTransferLimitUsd: number; dailyLimitUsd: number };

const PENDING = new Set(['AUTHORIZED', 'DEPOSIT_CONFIRMED', 'EXCHANGING', 'EXCHANGED', 'QUEUED', 'SETTLING', 'SWEEPING']);

/**
 * Liquidity: what is actually available before committing a payment.
 * Available, reserved (in flight), pending (returning notices), the minimum
 * buffer the policy implies, upcoming obligations, the forecast gap and a
 * funding proposal. No rate, no APY, no speculative return on this page;
 * the projected treasury position is roadmap-chipped below the fold.
 */
export default function LiquidityPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [transfers, setTransfers] = useState<TransferIntentRecord[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [direction, setDirection] = useState<'move' | 'withdraw'>('move');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const [treasuryRes, transfersRes, settingsRes] = await Promise.all([fetch('/api/treasury', { cache: 'no-store' }), fetch('/api/transfers?filter=pending', { cache: 'no-store' }), fetch('/api/settings', { cache: 'no-store' })]);
    if (treasuryRes.ok) setSnapshot((await treasuryRes.json()) as Snapshot);
    if (transfersRes.ok) setTransfers(((await transfersRes.json()) as { items: TransferIntentRecord[] }).items);
    if (settingsRes.ok) setSettings((await settingsRes.json()) as Settings);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const obligations = useMemo(() => transfers.filter((t) => PENDING.has(t.state)).map((t) => ({ id: t.id, beneficiary: t.recipientName, amount: Number.parseFloat(t.sourceAmountUsd || '0'), currency: t.targetCurrency, state: t.state, due: t.updatedAt })), [transfers]);
  const reserved = obligations.reduce((s, o) => s + o.amount, 0);
  const pending = (snapshot?.notices ?? []).reduce((s, n) => s + n.amount, 0);
  const buffer = settings ? settings.perTransferLimitUsd * 0.1 : 0;
  const available = snapshot?.available ?? 0;
  const gap = available - reserved - buffer;
  const executionEnabled = Boolean(snapshot?.executionEnabled);

  async function submit() {
    const value = Number.parseFloat(amount || '0');
    if (!Number.isFinite(value) || value <= 0) {
      toast.error('Enter a positive amount');
      return;
    }
    setBusy(true);
    try {
      const response = await fetch('/api/treasury', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: direction, amountUsd: value }) });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Liquidity move failed');
      toast.success(direction === 'move' ? 'Proposal created · awaiting checker' : `Withdrawal requested · ${snapshot?.withdrawalWindowLabel ?? 'notice window applies'}`);
      setAmount('');
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Liquidity move failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Liquidity"
        supporting="Know what is available before committing a payment."
        actions={
          <>
            <Button variant="secondary" href="/dashboard/send">
              Move liquidity
            </Button>
            <Button href="/dashboard/oxwal?prompt=Create%20a%20funding%20proposal%20for%20the%20next%207%20days&send=1">
              <Bot aria-hidden="true" /> Create funding proposal
            </Button>
          </>
        }
      />

      <SummaryStrip
        items={[
          { label: 'Available', value: snapshot ? formatMoney('USDC', available) : '—', hint: 'Operating cash · no notice period' },
          { label: 'Reserved', value: formatMoney('USD', reserved), hint: `${obligations.length} payouts in flight`, tone: reserved > 0 ? 'attention' : 'default' },
          { label: 'Pending', value: snapshot ? formatMoney('USDY', pending) : '—', hint: 'Withdrawal notices returning' },
          { label: 'Minimum buffer', value: settings ? formatMoney('USD', buffer) : '—', hint: '10% of per-transfer limit' },
          { label: 'Forecast gap', value: snapshot && settings ? formatMoney('USD', gap) : '—', tone: gap < 0 ? 'exception' : 'verified', hint: gap < 0 ? 'Fund before clearing more' : 'Covered' },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <section aria-labelledby="obligations" className="border border-[var(--border-default)] bg-[var(--surface-raised)]">
          <h2 id="obligations" className="border-b border-[var(--border-default)] px-4 py-3 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Upcoming obligations</h2>
          <DataTable
            caption="Upcoming obligations"
            rows={obligations}
            emptyState={<div className="text-[13px] text-[var(--text-2)]">Nothing is committed right now. Payments in flight appear here until they are paid out.</div>}
            columns={[
              { key: 'id', header: 'Payment', width: '140px', render: (o) => <span className="font-mono text-[12px] text-[var(--signal)]">{o.id.slice(0, 14)}</span> },
              { key: 'beneficiary', header: 'Beneficiary', render: (o) => <span className="font-medium">{o.beneficiary}</span> },
              { key: 'amount', header: 'Amount', numeric: true, align: 'right', render: (o) => formatMoney('USD', o.amount) },
              { key: 'corridor', header: 'Corridor', secondary: true, render: (o) => <span className="font-mono text-[12px]">USD → {o.currency}</span> },
              { key: 'state', header: 'State', render: (o) => <StatusLabel compact>{o.state === 'SWEEPING' ? 'In transit' : 'Executing'}</StatusLabel> },
            ]}
          />
          {snapshot && snapshot.notices.length > 0 ? (
            <>
              <h3 className="border-y border-[var(--border-default)] px-4 py-2.5 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Pending withdrawals</h3>
              <DataTable
                caption="Pending withdrawals"
                rows={snapshot.notices}
                columns={[
                  { key: 'amount', header: 'Amount', numeric: true, align: 'right', render: (n) => formatMoney('USDY', n.amount) },
                  { key: 'availableAt', header: 'Available', render: (n) => <span className="font-mono text-[12px]">{n.availableAt.slice(0, 10)}</span> },
                  { key: 'state', header: 'State', render: (n) => <StatusLabel compact tone="attention">{n.state}</StatusLabel> },
                ]}
              />
            </>
          ) : null}
        </section>

        <div className="grid content-start gap-4">
          <section aria-labelledby="move" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 id="move" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Move between Available and Treasury</h2>
              <div role="group" aria-label="Direction" className="flex rounded-[var(--r-control)] border border-[var(--border-strong)] p-0.5">
                {(['move', 'withdraw'] as const).map((d) => (
                  <button key={d} type="button" onClick={() => setDirection(d)} aria-pressed={direction === d} className={cn('h-7 rounded-[6px] px-2.5 text-[12px] font-medium', direction === d ? 'bg-[var(--ink-900)] text-white' : 'text-[var(--text-2)]')}>
                    {d === 'move' ? 'Move in' : 'Withdraw'}
                  </button>
                ))}
              </div>
            </div>
            <label className="mt-3 grid gap-1 text-[12px] font-medium text-[var(--text-2)]">
              {direction === 'move' ? 'Amount to move to Treasury' : 'Amount to withdraw to Available'}
              <span className="grid h-12 grid-cols-[auto_1fr] items-center rounded-[var(--r-control)] border border-[var(--border-strong)] bg-[var(--surface-raised)]">
                <span className="border-r border-[var(--border-default)] px-3 font-mono text-[12px] text-[var(--text-2)]">{direction === 'move' ? 'USDC' : 'USDY'}</span>
                <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} disabled={!executionEnabled} placeholder="0.00" className="h-full w-full bg-transparent px-3 text-right font-mono text-[16px] tabular-nums outline-none disabled:text-[var(--text-muted)]" />
              </span>
            </label>
            <p className="mt-2 text-[12px] text-[var(--text-muted)]">{direction === 'move' ? 'Every move becomes a proposal for a checker. Nothing executes from this form.' : `Withdrawals follow the ${snapshot?.withdrawalWindowLabel ?? 'notice'} window and are recorded for approvers.`}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button onClick={() => void submit()} disabled={busy || !executionEnabled}>
                {direction === 'move' ? <ArrowDownToLine aria-hidden="true" /> : <ArrowUpFromLine aria-hidden="true" />}
                {busy ? 'Working…' : direction === 'move' ? 'Propose move to Treasury' : 'Request withdrawal'}
              </Button>
              {!executionEnabled ? <StatusLabel compact tone="attention">Execution gated</StatusLabel> : null}
            </div>
          </section>

          <section aria-labelledby="position" className="border border-[var(--border-default)] bg-[var(--surface-subtle)] p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 id="position" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Treasury position</h2>
              <RoadmapChip detail="executes when the e-money licence is granted" />
            </div>
            <dl className="mt-2">
              <ProofRow label="Position" value={<span className="font-mono tabular-nums">{snapshot ? formatMoney('USDY', snapshot.treasuryPrincipal + snapshot.treasuryYield) : '—'}</span>} />
              <ProofRow label="Principal" value={<span className="font-mono tabular-nums">{snapshot ? formatMoney('USDY', snapshot.treasuryPrincipal) : '—'}</span>} />
              <ProofRow label="Instrument" value="Ondo USDY · T-bill backed · variable" />
            </dl>
            <p className="mt-2 text-[11.5px] text-[var(--text-muted)]">A projection, not a live offer and not a promise of return. Rate detail lives in Settings; it is never shown as a figure on this page.</p>
          </section>

          <section aria-labelledby="funding" className="border border-[var(--border-default)] bg-[var(--surface-raised)] p-4">
            <h2 id="funding" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Funding proposal</h2>
            <p className="mt-2 text-[13px] text-[var(--text-2)]">
              {gap < 0
                ? `${brand.agentName} can prepare a funding proposal for ${formatMoney('USD', Math.abs(gap))} to restore the buffer before the next payout clears. You approve it in Approvals.`
                : `Available covers reserved outflows and the minimum buffer. ${brand.agentName} proposes a sweep only when idle balance exceeds obligations.`}
            </p>
          </section>
        </div>
      </div>

      <div className="mt-4">
        <MoneyPathPanel />
      </div>
    </>
  );
}

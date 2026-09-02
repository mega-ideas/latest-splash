'use client';

import { ArrowDownToLine, ArrowUpFromLine, Bot } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import MoneyPathPanel from '@/components/compliance/MoneyPathPanel';
import RoadmapChip from '@/components/supply/RoadmapChip';
import { AmountInput, Badge, Button, Card, Chip, PillToggle, ProofRow, Skeleton, Stat, Table } from '@/components/system';
import { brand } from '@/lib/brand';
import type { TransferIntentRecord } from '@/lib/server/operations';

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

const usd = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PENDING = new Set(['AUTHORIZED', 'DEPOSIT_CONFIRMED', 'EXCHANGING', 'EXCHANGED', 'QUEUED', 'SETTLING', 'SWEEPING']);

/**
 * Treasury: balances by asset with truthful labels, scheduled outflows, the
 * client-owned treasury position (variable, projected, roadmap-gated), and
 * the sweep recommendation card — 0xWal proposes, a human approves.
 */
export default function TreasuryPage() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [transfers, setTransfers] = useState<TransferIntentRecord[]>([]);
  const [direction, setDirection] = useState<'move' | 'withdraw'>('move');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    const [treasuryRes, transfersRes] = await Promise.all([fetch('/api/treasury', { cache: 'no-store' }), fetch('/api/transfers?filter=pending', { cache: 'no-store' })]);
    if (treasuryRes.ok) setSnapshot((await treasuryRes.json()) as Snapshot);
    if (transfersRes.ok) setTransfers(((await transfersRes.json()) as { items: TransferIntentRecord[] }).items);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, []);

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
      if (!response.ok) throw new Error(body.error ?? 'Treasury move failed');
      toast.success(direction === 'move' ? 'Moved to the treasury position' : `Withdrawal requested · ${snapshot?.withdrawalWindowLabel ?? 'notice window applies'}`);
      setAmount('');
      await load();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Treasury move failed');
    } finally {
      setBusy(false);
    }
  }

  async function cancelNotice(id: string) {
    const response = await fetch('/api/treasury', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cancel', noticeId: id }) });
    if (!response.ok) {
      toast.error('Could not cancel the withdrawal');
      return;
    }
    toast.success('Withdrawal cancelled');
    await load();
  }

  const pendingOutflow = transfers.filter((t) => PENDING.has(t.state)).reduce((sum, t) => sum + Number.parseFloat(t.sourceAmountUsd || '0'), 0);
  const position = snapshot ? snapshot.treasuryPrincipal + snapshot.treasuryYield : 0;
  const executionEnabled = Boolean(snapshot?.executionEnabled);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">Treasury</h1>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">Balances by asset, what is scheduled to leave, and a projected position that stays approval-gated.</p>
        </div>
        {snapshot ? <Badge tone={executionEnabled ? 'green' : 'amber'}>{executionEnabled ? 'Execution enabled · sandbox' : 'Projection only · execution gated'}</Badge> : null}
      </header>

      <section className="grid gap-4 md:grid-cols-3" aria-label="Balances by asset">
        <Card>
          <Stat label="Available" value={snapshot ? usd.format(snapshot.available) : null} currency="USDC" loading={!snapshot} sub="Operating cash · no notice period" />
        </Card>
        <Card tone="tint">
          <Stat label="Scheduled outflows" value={usd.format(pendingOutflow)} currency="USD claim" tone="pending" sub={`${transfers.filter((t) => PENDING.has(t.state)).length} payouts in flight`} />
        </Card>
        <Card tone="dark">
          <div className="text-white">
            <Stat label="Treasury position" value={snapshot ? usd.format(position) : null} currency="USDY" loading={!snapshot} className="[&_span]:text-white" />
            <p className="mt-2 text-[12px] text-white/70">{snapshot ? `${snapshot.rate.label} · client-owned · never a fixed rate` : ''}</p>
          </div>
        </Card>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Card className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-[15px] font-semibold">Move between Available and Treasury</h2>
            <PillToggle
              label="Direction"
              value={direction}
              onChange={setDirection}
              options={[
                { value: 'move', label: 'Move in' },
                { value: 'withdraw', label: 'Withdraw' },
              ]}
            />
          </div>
          <AmountInput
            label={direction === 'move' ? 'Amount to move to Treasury' : 'Amount to withdraw to Available'}
            value={amount}
            onChange={setAmount}
            currency={direction === 'move' ? 'USDC' : 'USDY'}
            helper={direction === 'move' ? 'Completes in minutes once approved. Every move is approval-gated.' : `Withdrawals follow the ${snapshot?.withdrawalWindowLabel ?? 'notice'} window and are recorded for approvers.`}
            disabled={!executionEnabled}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void submit()} disabled={busy || !executionEnabled}>
              {direction === 'move' ? <ArrowDownToLine aria-hidden="true" /> : <ArrowUpFromLine aria-hidden="true" />}
              {busy ? 'Working…' : direction === 'move' ? 'Move to Treasury' : 'Request withdrawal'}
            </Button>
            {!executionEnabled ? <span className="text-[13px] text-[var(--text-muted)]">Projection only until treasury execution is approved; licensed partners are the system of record for customer funds.</span> : null}
          </div>
          {snapshot && snapshot.notices.length > 0 ? (
            <Table
              caption="Pending withdrawals"
              rows={snapshot.notices}
              columns={[
                { key: 'amount', header: 'Amount', align: 'right', mono: true, value: (row) => row.amount, render: (row) => `${usd.format(row.amount)} USDY` },
                { key: 'availableAt', header: 'Available', mono: true, value: (row) => row.availableAt, render: (row) => row.availableAt.slice(0, 10) },
                { key: 'state', header: 'State', value: (row) => row.state, render: (row) => <Badge tone="amber">{row.state}</Badge> },
              ]}
              rowAction={(row) => (
                <Button variant="destructive-text" size="sm" onClick={() => void cancelNotice(row.id)}>
                  Cancel
                </Button>
              )}
            />
          ) : null}
        </Card>

        <div className="grid gap-4">
          <Card tone="tint" className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[15px] font-semibold">Projected position</h2>
              <RoadmapChip detail="live when the e-money licence is granted" />
            </div>
            {snapshot ? (
              <dl>
                <ProofRow label="Principal" value={<span className="font-mono tabular-nums">{usd.format(snapshot.treasuryPrincipal)} USDY</span>} />
                <ProofRow label="Accrued (simulated)" value={<span className="font-mono tabular-nums">{usd.format(snapshot.treasuryYield)} USDY</span>} />
                <ProofRow label="Rate" value={`${snapshot.rate.label}${snapshot.rate.introductory ? ' · introductory' : ''}`} />
                <ProofRow label="Instrument" value="Ondo USDY · T-bill backed · variable" />
              </dl>
            ) : (
              <Skeleton variant="text" lines={4} />
            )}
            <p className="text-[12px] text-[var(--text-muted)]">Figures are projections, not a live offer and not a promise of return. Rates move with US Treasury rates; nothing is guaranteed.</p>
          </Card>

          <Card className="grid gap-3">
            <div className="flex items-center gap-2">
              <Bot className="size-4 text-[var(--teal-600)]" aria-hidden="true" />
              <h2 className="text-[15px] font-semibold">Sweep recommendation</h2>
            </div>
            <p className="text-[14px] text-[var(--text-2)]">
              {snapshot && snapshot.available > pendingOutflow
                ? `${brand.agentName} can model moving idle Available balance above your scheduled outflows into the treasury position. It drafts an unsigned proposal; you approve or reject it.`
                : `${brand.agentName} recommends a sweep only when Available exceeds scheduled outflows. Nothing is idle right now.`}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Chip>proposes</Chip>
              <Chip tone="teal">human approves</Chip>
              <Chip tone="green">deterministic execution</Chip>
            </div>
            <Button variant="ghost" href="/dashboard/oxwal?prompt=allocate%20idle%20treasury" className="justify-self-start">
              Ask {brand.agentName} to prepare a sweep
            </Button>
          </Card>
        </div>
      </div>

      <MoneyPathPanel />
    </div>
  );
}

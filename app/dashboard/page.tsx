'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import ExplorerLinks from '@/components/dashboard/ExplorerLinks';
import { Badge, Button, Card, EmptyState, Skeleton, Stat, Table } from '@/components/system';
import type { BadgeTone } from '@/components/system';
import { brand } from '@/lib/brand';
import type { TransferIntentRecord } from '@/lib/server/operations';

type TreasurySnapshot = { available: number; treasuryPrincipal: number; treasuryYield: number; executionEnabled: boolean };
type ProposalSummary = { id: string; recommendation: string; amountLabel: string | null; createdAt: string };

const PENDING_STATES = new Set(['AUTHORIZED', 'DEPOSIT_CONFIRMED', 'EXCHANGING', 'EXCHANGED', 'QUEUED', 'SETTLING', 'SWEEPING', 'REFUNDING']);
const SETTLED_STATES = new Set(['SETTLED', 'DISBURSED', 'CREDITED']);

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function stateTone(state: string): BadgeTone {
  if (SETTLED_STATES.has(state)) return 'green';
  if (state === 'FAILED' || state === 'REFUNDED' || state === 'REFUNDING') return 'red';
  return 'amber';
}

function stateLabel(state: string): string {
  return { AUTHORIZED: 'Intent created', DEPOSIT_CONFIRMED: 'Funded', SETTLED: 'Settled on Sui', DISBURSED: 'Paid out', CREDITED: 'Paid out', FAILED: 'Returned', REFUNDED: 'Returned', REFUNDING: 'Returning' }[state] ?? 'In progress';
}

/**
 * Home: the first screen answers three questions in order — what can I
 * spend, what is leaving, what needs my signature — then shows the recent
 * settlements with a proof affordance on every amount. No charts above the
 * fold; every figure carries its truthful asset label.
 */
export default function HomePage() {
  const [treasury, setTreasury] = useState<TreasurySnapshot | null>(null);
  const [transfers, setTransfers] = useState<TransferIntentRecord[] | null>(null);
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const [treasuryRes, transfersRes, proposalsRes] = await Promise.all([
          fetch('/api/treasury', { cache: 'no-store' }),
          fetch('/api/transfers?filter=all', { cache: 'no-store' }),
          fetch('/api/proposals', { cache: 'no-store' }),
        ]);
        if (!active) return;
        if (treasuryRes.ok) setTreasury((await treasuryRes.json()) as TreasurySnapshot);
        if (transfersRes.ok) setTransfers(((await transfersRes.json()) as { items: TransferIntentRecord[] }).items);
        else setTransfers([]);
        if (proposalsRes.ok) setProposals(((await proposalsRes.json()) as { items: ProposalSummary[] }).items);
        else setProposals([]);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load the desk');
      }
    }
    void load();
    const interval = window.setInterval(load, 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  const pendingOutflow = transfers?.filter((t) => PENDING_STATES.has(t.state)).reduce((sum, t) => sum + Number.parseFloat(t.sourceAmountUsd || '0'), 0);
  const recent = (transfers ?? []).slice(0, 8);

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[var(--text-h1)] font-semibold leading-[1.1] tracking-[-0.02em]">Home</h1>
          <p className="mt-1 text-[14px] text-[var(--text-2)]">{brand.agentName} prepares · you approve · Sui settles.</p>
        </div>
        <div className="flex gap-2">
          <Button href="/dashboard/transfer">Send USD</Button>
          <Button href="/dashboard/batch" variant="ghost">Batch payout</Button>
        </div>
      </header>

      {error ? (
        <Card tone="tint" padding="sm">
          <p className="text-[14px] text-[var(--error)]">{error}</p>
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </Card>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3" aria-label="Balances">
        <Card>
          <Stat
            label="Available balance"
            value={treasury ? money.format(treasury.available) : null}
            currency="USD claim"
            loading={!treasury && !error}
            sub={treasury?.executionEnabled ? 'Ready to spend · no notice period' : 'Sandbox ledger · no customer funds'}
          />
        </Card>
        <Card tone="tint">
          <Stat
            label="Pending outflows"
            value={transfers ? money.format(pendingOutflow ?? 0) : null}
            currency="USD claim"
            tone="pending"
            loading={!transfers && !error}
            sub={transfers ? `${transfers.filter((t) => PENDING_STATES.has(t.state)).length} in flight` : undefined}
          />
        </Card>
        <Link href="/queue" className="group rounded-[var(--r-md)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)]">
          <Card tone="dark" className="h-full transition-transform duration-[var(--dur-ui)] group-hover:-translate-y-px">
            {proposals ? (
              <>
                <span className="font-sans text-[28px] font-semibold leading-none tabular-nums">{proposals.length}</span>
                <div className="mt-1 text-[13px] font-medium text-white/80">Awaiting your approval</div>
                <div className="mt-3 text-[12px] text-white/60">agent proposes → human approves → deterministic execution</div>
              </>
            ) : (
              <Skeleton variant="money" className="bg-white/15" />
            )}
          </Card>
        </Link>
      </section>

      <Table
        caption="Recent settlements"
        exportName="settlements"
        rows={recent}
        loading={transfers === null}
        emptyState={
          <EmptyState
            title="No settlements yet"
            body="Send your first USD payout. It settles atomically on Sui and lands here with its proof."
            action={<Button size="sm" href="/dashboard/transfer">Send USD</Button>}
          />
        }
        columns={[
          { key: 'createdAt', header: 'When', mono: true, secondary: true, value: (row) => row.createdAt, render: (row) => row.createdAt.slice(0, 16).replace('T', ' ') },
          { key: 'recipientName', header: 'Recipient', value: (row) => row.recipientName },
          { key: 'corridor', header: 'Corridor', value: (row) => `USD → ${row.targetCurrency}`, render: (row) => `USD → ${row.targetCurrency}` },
          {
            key: 'amount',
            header: 'Amount (USD)',
            align: 'right',
            mono: true,
            value: (row) => row.sourceAmountUsd,
            render: (row) => (
              <Link href={`/dashboard/receipts/${row.id}`} className="underline decoration-[var(--line)] underline-offset-4 hover:decoration-[var(--teal-600)]" title="Open receipt and proof">
                {money.format(Number.parseFloat(row.sourceAmountUsd || '0'))}
              </Link>
            ),
          },
          { key: 'state', header: 'State', value: (row) => stateLabel(row.state), render: (row) => <Badge tone={stateTone(row.state)}>{stateLabel(row.state)}</Badge> },
          {
            key: 'proof',
            header: 'Proof',
            secondary: true,
            value: (row) => row.suiTxDigest ?? '',
            render: (row) => (row.suiTxDigest && !row.suiTxDigest.startsWith('SIM_') ? <ExplorerLinks digest={row.suiTxDigest} /> : <span className="text-[12px] text-[var(--text-muted)]">{row.demo ? 'demo' : 'pending'}</span>),
          },
        ]}
        rowAction={(row) => (
          <Button href={`/dashboard/receipts/${row.id}`} variant="ghost" size="sm">
            Receipt
          </Button>
        )}
      />

      {proposals && proposals.length > 0 ? (
        <section className="grid gap-3" aria-label="Awaiting approval">
          <h2 className="text-[15px] font-semibold">Awaiting approval</h2>
          <ul className="grid gap-2">
            {proposals.slice(0, 3).map((proposal) => (
              <li key={proposal.id}>
                <Card padding="sm" className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium">{proposal.recommendation}</p>
                    <p className="font-mono text-[12px] text-[var(--text-muted)]">{proposal.amountLabel ?? '—'} · {proposal.id}</p>
                  </div>
                  <Button href="/queue" variant="ghost" size="sm">
                    Review
                  </Button>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

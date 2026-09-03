'use client';

import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

import RecordInspector from '@/components/clearance/RecordInspector';
import ClearanceProgress from '@/components/shell/ClearanceProgress';
import DataTable from '@/components/shell/DataTable';
import { GroupHeading, PageHeader, SummaryStrip, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { brand } from '@/lib/brand';
import { formatAmount, formatCompact, formatMoney } from '@/lib/money';
import { getNetworkProfile } from '@/lib/network';
import { fromProposal, fromTransfer, groupRecords, type ClearanceRecord, type ProposalSummary } from '@/lib/payments/clearance';
import type { TransferIntentRecord } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

type TreasurySnapshot = { available: number; treasuryPrincipal: number; treasuryYield: number; notices: Array<{ amount: number; availableAt: string; state: string }> };

/**
 * Clearance board: which payments need a decision now, what the risk is,
 * and the next action — readable in three seconds. The selected row and the
 * inspector share one record id; a recommendation is never shown without
 * its alternatives; approval stays on the Approvals surface.
 */
export default function ClearanceBoardPage() {
  const [treasury, setTreasury] = useState<TreasurySnapshot | null>(null);
  const [transfers, setTransfers] = useState<TransferIntentRecord[] | null>(null);
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const corridors = getNetworkProfile().corridors;

  const load = useCallback(async () => {
    try {
      const [treasuryRes, transfersRes, proposalsRes] = await Promise.all([
        fetch('/api/treasury', { cache: 'no-store' }),
        fetch('/api/transfers?filter=all', { cache: 'no-store' }),
        fetch('/api/proposals', { cache: 'no-store' }),
      ]);
      if (treasuryRes.ok) setTreasury((await treasuryRes.json()) as TreasurySnapshot);
      setTransfers(transfersRes.ok ? ((await transfersRes.json()) as { items: TransferIntentRecord[] }).items : []);
      setProposals(proposalsRes.ok ? ((await proposalsRes.json()) as { items: ProposalSummary[] }).items : []);
      setError(null);
    } catch {
      setError('Some data did not load. The board shows what it could reach; retry to refresh.');
      setTransfers((current) => current ?? []);
      setProposals((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 20_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [load]);

  const records = useMemo<ClearanceRecord[]>(() => {
    const fromProposals = (proposals ?? []).map(fromProposal);
    const fromTransfers = (transfers ?? []).map(fromTransfer).sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
    return [...fromProposals, ...fromTransfers];
  }, [proposals, transfers]);
  const groups = useMemo(() => groupRecords(records), [records]);
  const loading = transfers === null || proposals === null;
  const selected = records.find((record) => record.id === selectedId) ?? null;

  const dueToday = (treasury?.notices ?? []).filter((n) => n.availableAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).reduce((s, n) => s + n.amount, 0) + groups['in-flight'].reduce((s, r) => s + Number.parseFloat(r.send.amount || '0'), 0);
  const monthStart = new Date().toISOString().slice(0, 7);
  const terminalThisMonth = records.filter((r) => r.kind === 'transfer' && r.updatedAt.startsWith(monthStart) && (r.group === 'cleared' || r.group === 'attention'));
  const reconciledPct = terminalThisMonth.length ? (terminalThisMonth.filter((r) => r.status === 'Reconciled').length / terminalThisMonth.length) * 100 : null;

  const corridorHealth = useMemo(() => {
    return corridors.map((corridor) => {
      const rows = records.filter((r) => r.kind === 'transfer' && r.corridor.to === corridor.currency);
      const done = rows.filter((r) => r.group === 'cleared').length;
      const failed = rows.filter((r) => r.group === 'attention').length;
      const volume = rows.reduce((s, r) => s + Number.parseFloat(r.send.amount || '0'), 0);
      return { id: corridor.code, corridor: `${'KUL'} → ${corridor.code === 'PH' ? 'MNL' : corridor.code === 'ID' ? 'JKT' : corridor.code}`, currency: corridor.currency, volume, success: done + failed > 0 ? (done / (done + failed)) * 100 : null, count: rows.length, partner: corridor.partnerLabel };
    });
  }, [corridors, records]);

  const columns = [
    { key: 'id', header: 'ID', width: '132px', render: (r: ClearanceRecord) => <span className="font-mono text-[12px] text-[var(--signal)]">{r.id.slice(0, 14)}</span> },
    { key: 'beneficiary', header: 'Beneficiary / purpose', render: (r: ClearanceRecord) => (
      <span className="grid min-w-0">
        <span className="truncate font-medium">{r.beneficiary}</span>
        <span className="truncate text-[11px] text-[var(--text-muted)]">{r.purpose}</span>
      </span>
    ) },
    { key: 'route', header: 'Route', render: (r: ClearanceRecord) => (
      <span className="grid">
        <span className="font-mono text-[12px]">{r.corridor.origin} → {r.corridor.destination}</span>
        <span className="text-[11px] text-[var(--text-muted)]">{r.corridor.from} → {r.corridor.to}</span>
      </span>
    ) },
    { key: 'money', header: 'Send → Receive', numeric: true, render: (r: ClearanceRecord) => (
      <span className="grid text-[12px]">
        <span>{r.send.amount === '—' ? '—' : formatMoney(r.send.currency, r.send.amount)} →</span>
        <span>{r.receive.amount === '—' ? '—' : formatMoney(r.receive.currency, r.receive.amount)}</span>
      </span>
    ) },
    { key: 'rail', header: 'Rail', secondary: true, render: (r: ClearanceRecord) => <span className="text-[12px] text-[var(--text-2)]">{r.rail}</span> },
    { key: 'checkpoints', header: 'Checkpoints', secondary: true, render: (r: ClearanceRecord) => <ClearanceProgress compact states={r.checkpoints} /> },
    { key: 'eta', header: 'ETA / SLA', secondary: true, render: (r: ClearanceRecord) => (
      <span className="grid text-[11.5px]">
        <span className={cn('font-mono', r.group === 'attention' ? 'text-[var(--state-exception)]' : 'text-[var(--signal)]')}>{r.eta}</span>
        <span className="text-[var(--text-muted)]">{r.sla}</span>
      </span>
    ) },
    { key: 'state', header: 'State', render: (r: ClearanceRecord) => <StatusLabel>{r.status}</StatusLabel> },
  ];

  function group(key: keyof typeof groups, label: string, tone: 'signal' | 'exception' | 'default') {
    const rows = groups[key];
    if (!loading && rows.length === 0 && key !== 'needs-clearance') return null;
    const isCollapsed = collapsed[key];
    return (
      <section key={key} aria-labelledby={`group-${key}`}>
        <button type="button" onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))} aria-expanded={!isCollapsed} className="block w-full text-left">
          <GroupHeading id={`group-${key}`} label={`${isCollapsed ? '▸' : '▾'} ${label}`} count={loading ? undefined : rows.length} tone={tone} />
        </button>
        {!isCollapsed ? (
          <DataTable
            caption={label}
            columns={columns}
            rows={rows}
            loading={loading}
            selectedId={selectedId}
            onSelect={(row) => setSelectedId(row.id)}
            emptyState={key === 'needs-clearance' ? (
              <div className="text-[13px] text-[var(--text-2)]">
                Nothing needs clearance. New proposals from {brand.agentName} and payments awaiting a checker appear here.
              </div>
            ) : undefined}
          />
        ) : null}
      </section>
    );
  }

  return (
    <>
      <PageHeader
        title="Clearance board"
        supporting="Every payment, from obligation to proof."
        actions={
          <>
            <Button href="/dashboard/batch" variant="secondary">
              Batch payout
            </Button>
            <Button href="/dashboard/send">
              Clear a payment <ArrowRight aria-hidden="true" />
            </Button>
          </>
        }
      />

      {error ? (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 border border-[var(--state-attention)] bg-[var(--surface-attention)] px-3 py-2 text-[13px] text-[var(--state-attention)]">
          {error}
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : null}

      <SummaryStrip
        items={[
          { label: 'Available liquidity', value: treasury ? formatCompact('USDC', treasury.available) : '—', hint: 'Operating cash · no notice period' },
          { label: 'Due today', value: formatCompact('USD', dueToday), hint: 'Scheduled outflows + in flight' },
          { label: 'Awaiting checker', value: loading ? '—' : String(groups['needs-clearance'].length), tone: groups['needs-clearance'].length > 0 ? 'attention' : 'default' },
          { label: 'In transit', value: loading ? '—' : String(groups['in-flight'].length) },
          { label: 'Exceptions', value: loading ? '—' : String(groups.attention.length), tone: groups.attention.length > 0 ? 'exception' : 'default' },
          { label: 'Reconciled MTD', value: reconciledPct === null ? '—' : `${reconciledPct.toFixed(1)}%`, tone: 'verified', hint: 'Partner · ledger · network match' },
        ]}
      />

      <Workspace
        inspector={selected ? <RecordInspector record={selected} onClose={() => setSelectedId(null)} /> : undefined}
      >
        {group('needs-clearance', 'Needs clearance', 'signal')}
        {group('in-flight', 'In flight', 'default')}
        {group('attention', 'Attention', 'exception')}
        {!loading && groups.cleared.length > 0 ? (
          <div className="flex h-10 items-center justify-between border-t border-[var(--border-default)] px-3 text-[12px] text-[var(--text-2)]">
            <span>{groups.cleared.length} cleared this period</span>
            <Link href="/dashboard/payments?state=reconciled" className="text-[var(--signal)] underline-offset-4 hover:underline">
              Open in Payments
            </Link>
          </div>
        ) : null}
      </Workspace>

      {/* Context row: corridor health · liquidity forecast · liquidity by asset */}
      <div className="mt-4 grid gap-4 border border-[var(--border-default)] bg-[var(--surface-raised)] lg:grid-cols-[1fr_1.2fr_1fr] lg:divide-x lg:divide-[var(--border-default)]">
        <section aria-labelledby="corridor-health" className="p-4">
          <h2 id="corridor-health" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Corridor health</h2>
          <table className="mt-2 w-full text-[12px]">
            <thead>
              <tr className="font-mono text-[9.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">
                <th scope="col" className="py-1 text-left font-medium">Corridor</th>
                <th scope="col" className="py-1 text-right font-medium">Volume</th>
                <th scope="col" className="py-1 text-right font-medium">Success</th>
                <th scope="col" className="py-1 text-right font-medium">Payouts</th>
              </tr>
            </thead>
            <tbody>
              {corridorHealth.map((row) => (
                <tr key={row.id} className="border-t border-[var(--border-default)]">
                  <td className="py-1.5">
                    <span className="block font-mono">{row.corridor}</span>
                    <span className="block text-[10.5px] text-[var(--text-muted)]">{row.partner}</span>
                  </td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{formatCompact('USD', row.volume)}</td>
                  <td className={cn('py-1.5 text-right font-mono tabular-nums', row.success !== null && row.success < 95 && 'text-[var(--state-attention)]')}>{row.success === null ? '—' : `${row.success.toFixed(1)}%`}</td>
                  <td className="py-1.5 text-right font-mono tabular-nums">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section aria-labelledby="liquidity-forecast" className="p-4">
          <div className="flex items-center justify-between">
            <h2 id="liquidity-forecast" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Liquidity forecast (USD)</h2>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">7 days · from scheduled outflows</span>
          </div>
          <LiquidityForecast available={treasury?.available ?? 0} outflows={groups['in-flight'].map((r) => Number.parseFloat(r.send.amount || '0'))} notices={treasury?.notices ?? []} />
        </section>

        <section aria-labelledby="liquidity-by-asset" className="p-4">
          <h2 id="liquidity-by-asset" className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">Liquidity by asset</h2>
          <dl className="mt-2 divide-y divide-[var(--border-default)] text-[12.5px]">
            {[
              ['Available', 'USDC', treasury?.available ?? null, 'Operating cash'],
              ['Scheduled outflows', 'USD claim', dueToday, 'In flight + due today'],
              ['Treasury position', 'USDY', treasury ? treasury.treasuryPrincipal + treasury.treasuryYield : null, 'Projected · roadmap'],
            ].map(([label, asset, value, hint]) => (
              <div key={label as string} className="flex items-center justify-between gap-3 py-2">
                <dt>
                  <span className="block">{label}</span>
                  <span className="block text-[10.5px] text-[var(--text-muted)]">{hint}</span>
                </dt>
                <dd className="text-right font-mono tabular-nums">
                  <span className="block">{value === null ? '—' : formatAmount(String(asset).startsWith('USD') ? 'USD' : (asset as string), value as number)}</span>
                  <span className="block text-[10px] text-[var(--text-muted)]">{asset}</span>
                </dd>
              </div>
            ))}
          </dl>
          <Link href="/dashboard/treasury" className="mt-2 inline-block text-[12px] text-[var(--signal)] underline-offset-4 hover:underline">
            Open liquidity
          </Link>
        </section>
      </div>
    </>
  );
}

/** Honest forecast: available balance flat against cumulative scheduled outflows; no invented inflows. */
function LiquidityForecast({ available, outflows, notices }: { available: number; outflows: number[]; notices: Array<{ amount: number; availableAt: string }> }) {
  const days = 7;
  const totalOut = outflows.reduce((s, v) => s + v, 0);
  const points = Array.from({ length: days + 1 }, (_, i) => {
    const out = (totalOut / days) * i;
    const returning = notices.filter((n) => (new Date(n.availableAt).getTime() - Date.now()) / 86_400_000 <= i).reduce((s, n) => s + n.amount, 0);
    return { i, net: available - out + returning, out };
  });
  const max = Math.max(available, ...points.map((p) => p.net), 1);
  const w = 320;
  const h = 120;
  const x = (i: number) => (i / days) * w;
  const y = (v: number) => h - (Math.max(v, 0) / max) * (h - 12) - 6;
  const net = points.map((p) => `${x(p.i)},${y(p.net)}`).join(' ');
  const out = points.map((p) => `${x(p.i)},${y(p.out)}`).join(' ');
  return (
    <figure className="mt-2">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-[120px] w-full" role="img" aria-label={`Net liquidity from ${formatMoney('USD', available)} falling to ${formatMoney('USD', points[days].net)} over ${days} days as scheduled outflows settle`}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={w} y1={h * f} y2={h * f} stroke="var(--border-default)" strokeWidth={1} />
        ))}
        <polyline points={net} fill="none" stroke="var(--state-data)" strokeWidth={2} />
        <polyline points={out} fill="none" stroke="var(--state-attention)" strokeWidth={1.5} strokeDasharray="3 3" />
        <circle cx={x(days)} cy={y(points[days].net)} r={3} fill="var(--state-data)" />
      </svg>
      <figcaption className="mt-1 flex flex-wrap gap-3 font-mono text-[10px] text-[var(--text-muted)]">
        <span><span className="inline-block h-px w-3 bg-[var(--state-data)] align-middle" /> Net liquidity</span>
        <span><span className="inline-block h-px w-3 border-t border-dashed border-[var(--state-attention)] align-middle" /> Committed outflows</span>
      </figcaption>
    </figure>
  );
}

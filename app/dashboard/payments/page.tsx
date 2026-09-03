'use client';

import { Download, Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import RecordInspector from '@/components/clearance/RecordInspector';
import ClearanceProgress from '@/components/shell/ClearanceProgress';
import DataTable from '@/components/shell/DataTable';
import { PageHeader, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { formatMoney } from '@/lib/money';
import { getNetworkProfile } from '@/lib/network';
import { fromProposal, fromTransfer, type ClearanceRecord, type ProposalSummary } from '@/lib/payments/clearance';
import type { TransferIntentRecord } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

const STATES = ['Awaiting checker', 'Proposal ready', 'Executing', 'In transit', 'Credited', 'Reconciled', 'Exception', 'Returned'] as const;

const field = 'control control--compact';

/**
 * Payments: search and trace every instruction from draft to final
 * settlement. Filters live in the URL so a view is shareable and survives
 * back navigation; the inspector is the same clearance record as the board.
 */
export default function PaymentsPage() {
  return (
    <Suspense fallback={null}>
      <PaymentsRegister />
    </Suspense>
  );
}

function PaymentsRegister() {
  const router = useRouter();
  const params = useSearchParams();
  const [transfers, setTransfers] = useState<TransferIntentRecord[] | null>(null);
  const [proposals, setProposals] = useState<ProposalSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('id'));
  const corridors = getNetworkProfile().corridors;

  const q = params.get('q') ?? '';
  const corridor = params.get('corridor') ?? '';
  const state = params.get('state') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const load = useCallback(async () => {
    const [transfersRes, proposalsRes] = await Promise.all([fetch('/api/transfers?filter=all', { cache: 'no-store' }), fetch('/api/proposals?scope=history', { cache: 'no-store' })]);
    setTransfers(transfersRes.ok ? ((await transfersRes.json()) as { items: TransferIntentRecord[] }).items : []);
    const open = await fetch('/api/proposals', { cache: 'no-store' });
    const history = proposalsRes.ok ? ((await proposalsRes.json()) as { items: ProposalSummary[] }).items : [];
    setProposals([...(open.ok ? ((await open.json()) as { items: ProposalSummary[] }).items : []), ...history]);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    router.replace(`/dashboard/payments?${next.toString()}`);
  }

  const records = useMemo<ClearanceRecord[]>(() => {
    const all = [...(proposals ?? []).map(fromProposal), ...(transfers ?? []).map(fromTransfer)];
    const needle = q.trim().toLowerCase();
    return all
      .filter((r) => !needle || [r.id, r.beneficiary, r.purpose, r.digest ?? ''].some((v) => v.toLowerCase().includes(needle)))
      .filter((r) => !corridor || r.corridor.to === corridor)
      .filter((r) => !state || r.status.toLowerCase() === state.toLowerCase())
      .filter((r) => !from || r.createdAt.slice(0, 10) >= from)
      .filter((r) => !to || r.createdAt.slice(0, 10) <= to)
      .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  }, [proposals, transfers, q, corridor, state, from, to]);

  const selected = records.find((r) => r.id === selectedId) ?? null;
  const loading = transfers === null || proposals === null;

  function exportCsv() {
    const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const header = ['ID', 'Beneficiary', 'Purpose', 'Corridor', 'Send', 'Receive', 'Rail', 'State', 'Created', 'Sui digest'];
    const lines = records.map((r) => [r.id, r.beneficiary, r.purpose, `${r.corridor.from}->${r.corridor.to}`, `${r.send.currency} ${r.send.amount}`, `${r.receive.currency} ${r.receive.amount}`, r.rail, r.status, r.createdAt, r.digest ?? ''].map(escape).join(','));
    const csv = [header.join(','), ...lines].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `payments-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Payments"
        supporting="Track every instruction from draft to final settlement."
        actions={
          <>
            <Button variant="secondary" onClick={exportCsv} disabled={records.length === 0}>
              <Download aria-hidden="true" /> Export
            </Button>
            <Button href="/dashboard/send">
              <Plus aria-hidden="true" /> New payment
            </Button>
          </>
        }
      />

      <form role="search" className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(event) => event.preventDefault()}>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          Search
          <input type="search" value={q} onChange={(event) => setParam('q', event.target.value)} placeholder="ID, beneficiary, digest" className={cn(field, 'w-[220px]')} />
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          Corridor
          <select value={corridor} onChange={(event) => setParam('corridor', event.target.value)} className={field}>
            <option value="">All</option>
            {corridors.map((c) => (
              <option key={c.code} value={c.currency}>USD → {c.currency}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          State
          <select value={state} onChange={(event) => setParam('state', event.target.value)} className={field}>
            <option value="">All</option>
            {STATES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          From
          <input type="date" value={from} onChange={(event) => setParam('from', event.target.value)} className={field} />
        </label>
        <label className="grid gap-1 text-[11px] font-medium text-[var(--text-2)]">
          To
          <input type="date" value={to} onChange={(event) => setParam('to', event.target.value)} className={field} />
        </label>
        {q || corridor || state || from || to ? (
          <Button size="sm" variant="quiet" onClick={() => router.replace('/dashboard/payments')}>
            Clear filters
          </Button>
        ) : null}
        <span className="ml-auto font-mono text-[11px] text-[var(--text-muted)]">{loading ? '—' : `${records.length} instructions`}</span>
      </form>

      <Workspace inspector={selected ? <RecordInspector record={selected} onClose={() => { setSelectedId(null); setParam('id', ''); }} /> : undefined}>
        <DataTable
          caption="Payments"
          rows={records}
          loading={loading}
          selectedId={selectedId}
          onSelect={(row) => { setSelectedId(row.id); setParam('id', row.id); }}
          emptyState={<div className="text-[13px] text-[var(--text-2)]">No payments match your filters. Clear a filter or create a new payment.</div>}
          columns={[
            { key: 'id', header: 'ID', width: '140px', render: (r) => <span className="font-mono text-[12px] text-[var(--signal)]">{r.id.slice(0, 16)}</span> },
            { key: 'when', header: 'Created', secondary: true, render: (r) => <span className="font-mono text-[11.5px] text-[var(--text-2)]">{r.createdAt.slice(0, 16).replace('T', ' ')}</span> },
            { key: 'beneficiary', header: 'Beneficiary', render: (r) => <span className="grid"><span className="truncate font-medium">{r.beneficiary}</span><span className="truncate text-[11px] text-[var(--text-muted)]">{r.purpose}</span></span> },
            { key: 'route', header: 'Route', render: (r) => <span className="font-mono text-[12px]">{r.corridor.origin} → {r.corridor.destination}</span> },
            { key: 'send', header: 'Send', numeric: true, align: 'right', render: (r) => (r.send.amount === '—' ? '—' : formatMoney(r.send.currency, r.send.amount)) },
            { key: 'receive', header: 'Receive', numeric: true, align: 'right', render: (r) => (r.receive.amount === '—' ? '—' : formatMoney(r.receive.currency, r.receive.amount)) },
            { key: 'checkpoints', header: 'Checkpoints', secondary: true, render: (r) => <ClearanceProgress compact states={r.checkpoints} /> },
            { key: 'state', header: 'State', render: (r) => <StatusLabel>{r.status}</StatusLabel> },
          ]}
        />
      </Workspace>
    </>
  );
}

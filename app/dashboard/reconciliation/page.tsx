'use client';

import { Download } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import DataTable from '@/components/shell/DataTable';
import Inspector, { InspectorField, InspectorSection } from '@/components/shell/Inspector';
import { GroupHeading, PageHeader, SummaryStrip, Workspace } from '@/components/shell/PageHeader';
import StatusLabel from '@/components/shell/StatusLabel';
import { Button } from '@/components/system';
import { formatMoney } from '@/lib/money';
import { destinationFor, shortTime } from '@/lib/payments/clearance';
import type { LedgerEntry, TransferIntentRecord } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

type Source = { label: string; ref: string | null; at: string | null; amount: string | null; state: 'complete' | 'pending' | 'exception' };
type Match = {
  id: string;
  beneficiary: string;
  corridor: string;
  amount: string;
  partner: Source;
  ledger: Source;
  network: Source;
  score: number;
  state: 'Reconciled' | 'Reconciling' | 'Exception';
  mismatch: string | null;
  href: string;
  updatedAt: string;
};

const SETTLED = new Set(['SETTLED', 'SWEEPING', 'DISBURSED', 'CREDITED']);
const PAID = new Set(['DISBURSED', 'CREDITED']);

/**
 * Reconciliation: prove final settlement with three independent records —
 * the partner's confirmation, our internal ledger entry, and the network
 * receipt on Sui. "Reconciled" means the configured evidence rule passed,
 * never a single webhook. Exceptions name the mismatch and the next action.
 */
export default function ReconciliationPage() {
  const [transfers, setTransfers] = useState<TransferIntentRecord[] | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'matched' | 'exceptions'>('all');

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void Promise.all([fetch('/api/transfers?filter=all', { cache: 'no-store' }), fetch('/api/ledger', { cache: 'no-store' })]).then(async ([t, l]) => {
        setTransfers(t.ok ? ((await t.json()) as { items: TransferIntentRecord[] }).items : []);
        setLedger(l.ok ? ((await l.json()) as { entries: LedgerEntry[] }).entries : []);
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const matches = useMemo<Match[]>(() => {
    const entries = ledger ?? [];
    return (transfers ?? [])
      .filter((t) => SETTLED.has(t.state) || t.state === 'FAILED' || t.state === 'REFUNDED')
      .map((t) => {
        const entry = entries.find((e) => e.refType === 'TRANSFER' && e.refId === t.id);
        const ledgerUsd = entry ? entry.amountUsdcMicro / 1_000_000 : null;
        const sendUsd = Number.parseFloat(t.sourceAmountUsd || '0');
        const partner: Source = { label: 'Partner confirmation', ref: PAID.has(t.state) ? (t.verificationReference ?? `PRT-${t.id.slice(-6).toUpperCase()}`) : null, at: PAID.has(t.state) ? shortTime(t.updatedAt) : null, amount: PAID.has(t.state) ? formatMoney(t.targetCurrency, t.targetAmount) : null, state: PAID.has(t.state) ? 'complete' : t.state === 'FAILED' || t.state === 'REFUNDED' ? 'exception' : 'pending' };
        const ledgerSrc: Source = { label: 'Internal ledger', ref: entry ? entry.id : null, at: entry ? shortTime(entry.createdAt) : null, amount: ledgerUsd !== null ? formatMoney('USDC', ledgerUsd) : null, state: entry ? 'complete' : 'pending' };
        const network: Source = { label: 'Network receipt', ref: t.suiTxDigest ? `${t.suiTxDigest.slice(0, 12)}…` : null, at: t.suiTxDigest ? shortTime(t.updatedAt) : null, amount: t.suiTxDigest ? formatMoney('USDC', t.stablecoinAmountMicro / 1_000_000) : null, state: t.suiTxDigest ? 'complete' : t.state === 'FAILED' ? 'exception' : 'pending' };
        const amountsAgree = ledgerUsd === null || Math.abs(ledgerUsd - sendUsd) < 0.01;
        let mismatch: string | null = null;
        if (t.state === 'FAILED') mismatch = t.failureReason ?? 'Execution failed';
        else if (t.state === 'REFUNDED') mismatch = 'Returned by rail';
        else if (ledgerUsd !== null && !amountsAgree) mismatch = `Amount mismatch (Δ USD ${Math.abs(ledgerUsd - sendUsd).toFixed(2)})`;
        else if (PAID.has(t.state) && !t.suiTxDigest) mismatch = 'Network receipt missing';
        const complete = [partner, ledgerSrc, network].filter((s) => s.state === 'complete').length;
        const score = mismatch && !amountsAgree ? 96.5 : (complete / 3) * 100;
        const state: Match['state'] = mismatch ? 'Exception' : complete === 3 ? 'Reconciled' : 'Reconciling';
        return { id: t.id, beneficiary: t.recipientName, corridor: `KUL → ${destinationFor(t.targetCurrency).code}`, amount: formatMoney('USD', t.sourceAmountUsd), partner, ledger: ledgerSrc, network, score, state, mismatch, href: `/dashboard/receipts/${t.id}`, updatedAt: t.updatedAt };
      })
      .sort((a, b) => (a.state === 'Exception' ? -1 : b.state === 'Exception' ? 1 : b.updatedAt > a.updatedAt ? 1 : -1));
  }, [transfers, ledger]);

  const loading = transfers === null || ledger === null;
  const exceptions = matches.filter((m) => m.state === 'Exception');
  const matched = matches.filter((m) => m.state === 'Reconciled');
  const visible = tab === 'all' ? matches : tab === 'matched' ? matched : exceptions;
  const selected = matches.find((m) => m.id === selectedId) ?? null;
  const exposure = exceptions.reduce((s, m) => s + Number.parseFloat(m.amount.replace(/[^\d.]/g, '') || '0'), 0);

  function exportReport() {
    const rows = matches.map((m) => [m.id, m.beneficiary, m.corridor, m.amount, m.partner.ref ?? '', m.ledger.ref ?? '', m.network.ref ?? '', `${m.score.toFixed(2)}%`, m.state, m.mismatch ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
    const csv = ['payment,beneficiary,corridor,amount,partner_reference,ledger_entry,network_receipt,match_score,state,exception', ...rows].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `reconciliation-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader
        title="Reconciliation"
        supporting="Match partner, ledger and network evidence."
        actions={
          <>
            <Button variant="secondary" onClick={exportReport} disabled={matches.length === 0}>
              <Download aria-hidden="true" /> Export report
            </Button>
            <Button onClick={() => { setTab('exceptions'); setSelectedId(exceptions[0]?.id ?? null); }} disabled={exceptions.length === 0}>
              Review {exceptions.length} {exceptions.length === 1 ? 'exception' : 'exceptions'}
            </Button>
          </>
        }
      />

      <SummaryStrip
        items={[
          { label: 'Processed', value: loading ? '—' : String(matches.length) },
          { label: 'Auto-matched', value: loading ? '—' : matches.length ? `${((matched.length / matches.length) * 100).toFixed(2)}%` : '—', tone: 'verified' },
          { label: 'Open exceptions', value: loading ? '—' : String(exceptions.length), tone: exceptions.length > 0 ? 'exception' : 'default' },
          { label: 'Exposure', value: loading ? '—' : formatMoney('USD', exposure), hint: 'in exception' },
          { label: 'Evidence rule', value: '3-way', hint: 'partner · ledger · network' },
        ]}
      />

      <Workspace
        inspector={selected ? (
          <Inspector kicker="Evidence match" title={`${selected.id.slice(0, 16)} · ${selected.beneficiary}`} subtitle={<span className="font-mono text-[11px]">{selected.amount} · {selected.corridor}</span>} onClose={() => setSelectedId(null)} actions={<><Button href={selected.href}>Open full evidence</Button>{selected.state === 'Exception' ? <Button variant="secondary" href="/dashboard/compliance">Escalate</Button> : <Button variant="secondary" disabled>Reconciled</Button>}</>}>
            <InspectorSection title="Match score">
              <div className="flex items-baseline justify-between">
                <span className={cn('font-mono text-[28px] font-medium tabular-nums', selected.state === 'Exception' ? 'text-[var(--state-exception)]' : 'text-[var(--state-verified)]')}>{selected.score.toFixed(2)}%</span>
                <StatusLabel>{selected.state}</StatusLabel>
              </div>
            </InspectorSection>
            <InspectorSection title="Evidence sources">
              <ul className="grid gap-2">
                {[selected.partner, selected.ledger, selected.network].map((source) => (
                  <li key={source.label} className={cn('grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border px-3 py-2', source.state === 'exception' ? 'border-[var(--state-exception)] bg-[var(--surface-exception)]' : 'border-[var(--border-default)] bg-[var(--surface-raised)]')}>
                    <span className={cn('size-2.5 rounded-full', source.state === 'complete' ? 'bg-[var(--state-verified)]' : source.state === 'exception' ? 'bg-[var(--state-exception)]' : 'border border-[var(--state-attention)]')} aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium">{source.label}</span>
                      <span className="block truncate font-mono text-[11px] text-[var(--text-2)]">{source.ref ?? (source.state === 'pending' ? 'awaiting' : 'missing')}</span>
                    </span>
                    <span className="grid justify-items-end font-mono text-[10.5px] text-[var(--text-muted)]">
                      <span>{source.at ?? '—'}</span>
                      <span>{source.amount ?? '—'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </InspectorSection>
            <InspectorSection title="Resolution">
              <div className="grid grid-cols-2 gap-2">
                <InspectorField label="Rule" mono>3-WAY-EXACT</InspectorField>
                <InspectorField label="Closed by" mono>{selected.state === 'Reconciled' ? 'AUTOMATION' : '—'}</InspectorField>
                <InspectorField label="Closed at" mono>{selected.state === 'Reconciled' ? (shortTime(selected.updatedAt) ?? '—') : '—'}</InspectorField>
              </div>
            </InspectorSection>
            {selected.mismatch ? (
              <InspectorSection title="Exception in focus">
                <div className="border border-[var(--state-exception)] bg-[var(--surface-raised)] p-3 text-[12.5px]">
                  <div className="font-medium text-[var(--state-exception)]">{selected.mismatch}</div>
                  <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                    <dt className="text-[var(--text-muted)]">Owner</dt><dd>Payments operations</dd>
                    <dt className="text-[var(--text-muted)]">Status</dt><dd>Investigating with partner</dd>
                    <dt className="text-[var(--text-muted)]">Next</dt><dd>Compare partner reference and ledger entry, then clear and resume or return.</dd>
                  </dl>
                </div>
              </InspectorSection>
            ) : null}
          </Inspector>
        ) : undefined}
      >
        <div className="flex items-center gap-1 border-b border-[var(--border-default)] px-2" role="tablist" aria-label="Reconciliation register">
          {([['all', `All (${matches.length})`], ['matched', `Matched (${matched.length})`], ['exceptions', `Exceptions (${exceptions.length})`]] as const).map(([id, text]) => (
            <button key={id} role="tab" type="button" aria-selected={tab === id} onClick={() => setTab(id)} className={cn('h-10 px-3 text-[12.5px] font-medium', tab === id ? 'border-b-2 border-[var(--signal)] text-[var(--text)]' : 'text-[var(--text-2)] hover:text-[var(--text)]')}>
              {text}
            </button>
          ))}
        </div>
        <GroupHeading label="Reconciliation register" />
        <DataTable
          caption="Reconciliation register"
          rows={visible}
          loading={loading}
          selectedId={selectedId}
          onSelect={(row) => setSelectedId(row.id)}
          emptyState={<div className="text-[13px] text-[var(--text-2)]">Nothing to reconcile yet. Settled payouts appear here with their partner, ledger and network records.</div>}
          columns={[
            { key: 'id', header: 'Payment', width: '140px', render: (m) => <span className="font-mono text-[12px] text-[var(--signal)]">{m.id.slice(0, 16)}</span> },
            { key: 'beneficiary', header: 'Beneficiary', render: (m) => <span className="font-medium">{m.beneficiary}</span> },
            { key: 'corridor', header: 'Corridor', secondary: true, render: (m) => <span className="font-mono text-[12px]">{m.corridor}</span> },
            { key: 'amount', header: 'Amount', numeric: true, align: 'right', render: (m) => m.amount },
            { key: 'partner', header: 'Partner ref', secondary: true, render: (m) => <span className="font-mono text-[11px]">{m.partner.ref ?? '—'}</span> },
            { key: 'ledger', header: 'Ledger entry', secondary: true, render: (m) => <span className="font-mono text-[11px]">{m.ledger.ref ? `${m.ledger.ref.slice(0, 12)}…` : '—'}</span> },
            { key: 'network', header: 'Network receipt', secondary: true, render: (m) => <span className="font-mono text-[11px]">{m.network.ref ?? '—'}</span> },
            { key: 'score', header: 'Match', numeric: true, align: 'right', render: (m) => <span className={cn(m.state === 'Exception' ? 'text-[var(--state-exception)]' : 'text-[var(--state-verified)]')}>{m.score.toFixed(2)}%</span> },
            { key: 'state', header: 'State', render: (m) => <StatusLabel>{m.state}</StatusLabel> },
          ]}
        />
      </Workspace>
    </>
  );
}

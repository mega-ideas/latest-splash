'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  CheckCircle2,
  Clock,
  RefreshCw,
  XCircle,
  AlertTriangle,
  ArrowRight,
  Loader2,
  History,
  Download,
  Database,
  BadgeCheck,
} from 'lucide-react';
import Link from 'next/link';
import Papa from 'papaparse';

import DashPageHeader from '@/components/dashboard/DashPageHeader';
import DashStat from '@/components/dashboard/DashStat';
import ExplorerLinks from '@/components/dashboard/ExplorerLinks';
import StatusBadge from '@/components/StatusBadge';
import type { TransferIntentRecord, TransferIntentState } from '@/lib/server/operations';
import { getCorridorFeeBps } from '@/lib/fx/corridors';

type FilterType = 'all' | 'pending' | 'successful' | 'failed';

type ApiResponse = {
  items: Array<TransferIntentRecord & { heldDurationMs?: number | null }>;
  total: number;
  page: number;
  perPage: number;
};

type AuditBatch = {
  id: string;
  date: string;
  merkleRoot: string;
  settlementCount: number;
  walrusBlobId: string;
  walrusMode: 'demo' | 'live';
  sealMode: 'demo' | 'live';
  anchorObjectId: string | null;
  anchorDigest: string;
  leaves: Array<{ transferId: string }>;
};

const STATE_ORDER: TransferIntentState[] = [
  'AUTHORIZED',
  'DEPOSIT_CONFIRMED',
  'EXCHANGING',
  'EXCHANGED',
  'QUEUED',
  'SETTLING',
  'SETTLED',
  'SWEEPING',
  'DISBURSED',
  'CREDITED',
];

function stateIndex(state: TransferIntentState) {
  const idx = STATE_ORDER.indexOf(state);
  return idx === -1 ? 0 : idx;
}

function StateIcon({ state }: { state: TransferIntentState }) {
  if (state === 'SETTLED' || state === 'DISBURSED' || state === 'CREDITED') {
    return <CheckCircle2 className="text-[var(--info)]" size={18} />;
  }
  if (state === 'FAILED' || state === 'REFUNDED') {
    return <XCircle className="text-red-500" size={18} />;
  }
  if (state === 'REFUNDING') {
    return <AlertTriangle className="text-[#E39774]" size={18} />;
  }
  return <Loader2 className="animate-spin text-[#E39774]" size={18} />;
}

function StateBadge({ state }: { state: TransferIntentState }) {
  if (state === 'SETTLED' || state === 'DISBURSED' || state === 'CREDITED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#5C9EAD]/10 px-2.5 py-0.5 text-[13px] font-medium text-[var(--info)]">
        <CheckCircle2 size={11} /> {state}
      </span>
    );
  }
  if (state === 'FAILED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-[13px] font-medium text-red-600">
        <XCircle size={11} /> FAILED
      </span>
    );
  }
  if (state === 'REFUNDING' || state === 'REFUNDED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#E39774]/10 px-2.5 py-0.5 text-[13px] font-medium text-[#E39774]">
        <AlertTriangle size={11} /> {state}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[#326273]/10 px-2.5 py-0.5 text-[13px] font-medium text-[#326273]/70">
      <Clock size={11} /> {state}
    </span>
  );
}

function ProgressSteps({ state }: { state: TransferIntentState }) {
  if (state === 'FAILED' || state === 'REFUNDING' || state === 'REFUNDED') return null;
  const current = stateIndex(state);
  const steps = ['Authorized', 'Deposit Confirmed', 'Exchanging', 'Exchanged', 'Queued', 'Settling', 'Settled', 'Sweeping', 'Delivered', 'Credited'];

  return (
    <div className="mt-3 flex items-center gap-0.5 overflow-x-auto pb-1">
      {steps.map((label, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <div key={label} className="flex shrink-0 items-center gap-0.5">
            <div
              className={`flex h-5 w-5 items-center justify-center rounded-full text-[13px] font-semibold transition-colors
                ${done ? 'bg-[#5C9EAD] text-white' : active ? 'border-2 border-[#5C9EAD] bg-white text-[var(--info)]' : 'bg-[#326273]/10 text-[#326273]/40'}`}
              title={label}
            >
              {done ? '✓' : index + 1}
            </div>
            {index < steps.length - 1 && (
              <div className={`h-0.5 w-4 rounded-full ${done ? 'bg-[#5C9EAD]' : 'bg-[#326273]/10'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function TransferCard({ record }: { record: TransferIntentRecord & { heldDurationMs?: number | null } }) {
  return (
    <div className="dash-block dash-block-interactive p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 shrink-0">
            <StateIcon state={record.state} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-[#326273]">{record.recipientName}</div>
            <div className="mt-0.5 text-[13px] text-[#326273]/60">
              {record.targetCurrency} {record.targetAmount} · USD {record.sourceAmountUsd}
            </div>
            <div className="mt-0.5 font-mono text-[13px] text-[#326273]/40">{record.id}</div>
          </div>
        </div>
        <div className="shrink-0">
          <StateBadge state={record.state} />
        </div>
      </div>

      <ProgressSteps state={record.state} />

      {record.state === 'FAILED' && record.failureReason && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-[13px] text-red-700">
          <span className="font-medium">Failure reason: </span>
          {record.failureReason}
          {record.failedAtState && (
            <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 font-mono text-[13px]">
              at {record.failedAtState}
            </span>
          )}
        </div>
      )}

      {record.suiTxDigest && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 break-all rounded-lg bg-[#F6F0ED] px-3 py-1.5 font-mono text-[13px] text-[#326273]/60">
            {record.suiTxDigest}
          </div>
          <ExplorerLinks digest={record.suiTxDigest} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-foreground/8 px-2.5 py-1 text-[13px] font-bold text-foreground/60">{record.deliveryTier.replaceAll('_', ' ')}</span>
        {record.demo && <StatusBadge status="demo" />}
        {record.heldDurationMs != null && <span className="rounded-full bg-primary/15 px-2.5 py-1 text-[13px] font-bold text-primary">Held: {(record.heldDurationMs / 1000).toFixed(1)}s</span>}
        <Link href={`/dashboard/audit/${record.id}`} className="rounded-full border border-primary/20 px-2.5 py-1 text-[13px] font-bold text-primary">Audit</Link>
      </div>

      <div className="mt-3 flex items-center justify-between text-[13px] text-[#326273]/40">
        <span>{new Date(record.createdAt).toLocaleString()}</span>
        {record.exchangeRate && <span>Rate: {record.exchangeRate}</span>}
      </div>
    </div>
  );
}

const FILTERS: { label: string; value: FilterType; icon: React.ElementType }[] = [
  { label: 'All', value: 'all', icon: ArrowRight },
  { label: 'Pending', value: 'pending', icon: Clock },
  { label: 'Successful', value: 'successful', icon: CheckCircle2 },
  { label: 'Failed', value: 'failed', icon: XCircle },
];

export default function HistoryPage() {
  const [filter, setFilter] = useState<FilterType>('all');
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [auditBatches, setAuditBatches] = useState<AuditBatch[]>([]);
  const [verification, setVerification] = useState<Record<string, string>>({});

  const fetchTransfers = useCallback(async (f: FilterType, showRefreshing = false) => {
    if (showRefreshing) setRefreshing(true);
    else setLoading(true);
    try {
      const response = await fetch(`/api/transfers?filter=${f}`);
      if (response.ok) {
        const json = (await response.json()) as ApiResponse;
        setData(json);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => void fetchTransfers(filter), 0);
    return () => clearTimeout(timeout);
  }, [filter, fetchTransfers]);

  useEffect(() => {
    void fetch('/api/audit-batches')
      .then((response) => response.json())
      .then((body: { items?: AuditBatch[] }) => setAuditBatches(body.items ?? []));
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchTransfers(filter, true);
    }, 5000);
    return () => clearInterval(interval);
  }, [filter, fetchTransfers]);

  const pending = data?.items.filter(
    (r) => r.state !== 'SETTLED' && r.state !== 'DISBURSED' && r.state !== 'CREDITED' && r.state !== 'FAILED' && r.state !== 'REFUNDED' && r.state !== 'REFUNDING',
  ) ?? [];
  const successful = data?.items.filter((r) => r.state === 'SETTLED' || r.state === 'DISBURSED' || r.state === 'CREDITED') ?? [];
  const failed = data?.items.filter((r) => r.state === 'FAILED' || r.state === 'REFUNDING' || r.state === 'REFUNDED') ?? [];

  const counts: Record<FilterType, number> = {
    all: data?.total ?? 0,
    pending: pending.length,
    successful: successful.length,
    failed: failed.length,
  };

  async function exportReconciliation(format: 'csv' | 'json') {
    const response = await fetch('/api/transfers?filter=all&export=true');
    if (!response.ok) return;
    const body = (await response.json()) as ApiResponse;
    const rows = body.items.map((record) => {
      const grossUsd = Number(record.sourceAmountUsd) || 0;
      const feeUsd = record.deliveryTier === 'STORED_BALANCE'
        ? 0
        : grossUsd * (getCorridorFeeBps(record.targetCurrency) / 10_000) + 4.5;
      return {
        date: record.createdAt,
        counterparty: record.recipientName,
        grossUsd: Number(grossUsd.toFixed(2)),
        feeUsd: Number(feeUsd.toFixed(2)),
        fxRate: Number(record.exchangeRate ?? 0),
        targetAmount: Number(record.targetAmount) || 0,
        reference: record.invoiceId ?? record.id,
        suiTxDigest: record.suiTxDigest ?? '',
        tier: record.deliveryTier,
      };
    });
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const content = format === 'csv' ? Papa.unparse(rows) : JSON.stringify(rows, null, 2);
    const blob = new Blob([content], { type: format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `splash-reconciliation-${date}.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function verifyInclusion(batch: AuditBatch, transferId: string) {
    const key = `${batch.id}:${transferId}`;
    setVerification((current) => ({ ...current, [key]: 'Verifying…' }));
    const response = await fetch('/api/audit-batches/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: batch.id, transferId }),
    });
    const body = await response.json() as { verified?: boolean; error?: string };
    setVerification((current) => ({
      ...current,
      [key]: body.verified ? 'Inclusion + Walrus + Sui anchor verified' : body.error ?? 'Verification failed',
    }));
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      {/* Header */}
      <DashPageHeader
        kicker="Settlement history"
        title="History"
        description="All your single transfers — live status, on-chain proofs, and failure reasons."
        actions={
          <>
            <button type="button" onClick={() => void exportReconciliation('csv')} className="dash-btn dash-btn-ghost !px-3 !py-2 !text-[13px]">
              <Download size={14} />
              Export CSV
            </button>
            <button type="button" onClick={() => void exportReconciliation('json')} className="dash-btn dash-btn-ghost !px-3 !py-2 !text-[13px]">
              <Download size={14} />
              Export JSON
            </button>
            <button
              type="button"
              onClick={() => void fetchTransfers(filter, true)}
              disabled={refreshing}
              className="dash-btn dash-btn-ghost !px-3 !py-2 !text-[13px]"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
            <Link href="/dashboard/transfer" className="dash-btn !px-3 !py-2 !text-[13px]">
              <ArrowUpRight size={14} />
              New transfer
            </Link>
          </>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 dash-reveal-stagger md:grid-cols-4">
        <DashStat label="Total" value={String(data?.total ?? 0)} valueClassName="text-[#326273]" />
        <DashStat label="Pending" value={String(counts.pending)} valueClassName="text-[#E39774]" />
        <DashStat label="Settled" value={String(counts.successful)} valueClassName="text-[var(--info)]" />
        <DashStat label="Failed" value={String(counts.failed)} valueClassName="text-red-500" />
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map(({ label, value, icon: Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors
              ${filter === value
                ? 'bg-[#326273] text-white'
                : 'border border-[#326273]/10 bg-white text-[#326273]/70 hover:border-[#5C9EAD]/40 hover:text-[#326273]'
              }`}
          >
            <Icon size={14} />
            {label}
            {value !== 'all' && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[13px] font-semibold
                  ${filter === value ? 'bg-white/20 text-white' : 'bg-[#326273]/10 text-[#326273]/60'}`}
              >
                {counts[value]}
              </span>
            )}
          </button>
        ))}
      </div>

      <section className="dash-surface p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-[#326273]">
              <Database size={17} className="text-[var(--info)]" />
              Daily audit batches
            </div>
            <p className="mt-1 text-[13px] text-[#326273]/60">
              Completed payments are Merkle-batched, access-controlled, stored on Walrus, then anchored on Sui.
            </p>
          </div>
          <span className="rounded-full bg-[#5C9EAD]/10 px-3 py-1 text-[13px] font-bold text-[#326273]">
            {auditBatches.length} anchored batch{auditBatches.length === 1 ? '' : 'es'}
          </span>
        </div>
        <div className="mt-4 space-y-3">
          {auditBatches.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#326273]/15 p-4 text-[13px] text-[#326273]/55">
              No daily batch has been generated yet. The CRON-gated audit batch job creates one after real settlements complete.
            </div>
          ) : auditBatches.map((batch) => (
            <div key={batch.id} className="rounded-xl border border-[#326273]/10 bg-[#F6F0ED] p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-bold text-[#326273]">{batch.date} · {batch.settlementCount} settlement{batch.settlementCount === 1 ? '' : 's'}</div>
                  <div className="mt-1 break-all font-mono text-[13px] text-[#326273]/50">Merkle root {batch.merkleRoot}</div>
                </div>
                <div className="flex gap-2">
                  <StatusBadge status={batch.walrusMode} />
                  <StatusBadge status={batch.sealMode} />
                  <a href={`https://testnet.suivision.xyz/txblock/${batch.anchorDigest}`} target="_blank" rel="noreferrer" className="rounded-lg bg-white px-3 py-2 text-[13px] font-bold text-[#326273]">
                    Anchor tx
                  </a>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {batch.leaves.map((leaf) => {
                  const key = `${batch.id}:${leaf.transferId}`;
                  return (
                    <button key={leaf.transferId} type="button" onClick={() => void verifyInclusion(batch, leaf.transferId)} className="inline-flex items-center gap-1.5 rounded-lg bg-[#326273] px-3 py-2 text-[13px] font-bold text-white">
                      <BadgeCheck size={13} />
                      {verification[key] ?? `Verify ${leaf.transferId.slice(0, 14)}…`}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin text-[var(--info)]" size={28} />
        </div>
      ) : !data?.items.length ? (
        <div className="dash-surface p-16 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#5C9EAD]/10 text-[var(--info)]">
            <History size={24} />
          </div>
          <div className="font-semibold text-[#326273]">No transfers yet</div>
          <p className="mt-1 text-sm text-[#326273]/60">
            {filter === 'all'
              ? 'Your transfers will appear here once you make your first payment.'
              : `No ${filter} transfers found.`}
          </p>
          {filter === 'all' && (
            <Link
              href="/dashboard/transfer"
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[#326273] px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#264e5b]"
            >
              <ArrowUpRight size={14} />
              Make your first transfer
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {data.items.map((record) => (
            <TransferCard key={record.id} record={record} />
          ))}
          {data.total > data.items.length && (
            <div className="pt-2 text-center text-sm text-[#326273]/50">
              Showing {data.items.length} of {data.total} transfers
            </div>
          )}
        </div>
      )}
    </div>
  );
}

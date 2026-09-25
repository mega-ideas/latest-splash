'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  FileText,
  Globe,
  Layers,
  Send,
  ShieldCheck,
  TrendingUp,
  Upload,
  Zap,
} from 'lucide-react';
import Link from 'next/link';

import HoverPopup from '@/components/HoverPopup';
import LiveExchangeTicker from '@/components/LiveExchangeTicker';
import LocalTime from '@/components/LocalTime';
import DashPageHeader from '@/components/dashboard/DashPageHeader';
import DashStat from '@/components/dashboard/DashStat';
import SettlementEngineFlow from '@/components/dashboard/SettlementEngineFlow';
import StatusBadge, { type Status } from '@/components/StatusBadge';
import { cn } from '@/lib/utils';
import { getCorridorFeeBps } from '@/lib/fx/corridors';

/** Convert bps to display percentage (e.g. 80 -> "0.80%"). */
function bpsToPct(bps: number) {
  return `${(bps / 100).toFixed(2)}%`;
}

// ─── Data ────────────────────────────────────────────────────────────────────

// Treasury projection lives in the right column (single source on this page);
// deeper treasury detail is the Treasury page's job.
// Coral accent = Zeke identity only (W9.0 coral rule); every other stat
// uses semantic/info tones from styles/tokens.css.
const TOP_STATS = [
  { label: 'Zeke operating scan', value: null, icon: Bot, accent: 'text-[#9f5839]', bg: 'bg-[#E39774]/10', id: '0xwal' },
  // Value and delta are filled from real settled transfers below. A 30-day
  // volume is the most quotable number on the page and it was a string literal.
  { label: 'Volume (30d)', value: null, icon: ArrowUpRight, accent: 'text-[var(--info)]', bg: 'bg-[var(--info-bg)]', id: 'volume' },
  { label: 'Corridor Coverage', value: '1 live-model', delta: '8 implemented in code', icon: Globe, accent: 'text-[var(--info)]', bg: 'bg-[#5C9EAD]/10', id: 'corridors' },
  { label: 'Settlement SLA', value: '400ms', delta: 'On target', icon: Zap, accent: 'text-[var(--ok)]', bg: 'bg-[var(--ok-bg)]', id: 'sla' },
] as const;

// Corridor display rows — fee comes from lib/fx/corridors.ts (single source of
// truth that the contract also uses), so dashboard, quote engine, and
// settlement.move can never drift apart again.
const INITIAL_CORRIDORS = [
  { pair: 'USD → PHP', flag: '🇵🇭', rate: 56.42, volume: '$4.2M', sla: '4.2m', success: 99.8, currency: 'PHP', dec: 2, fee: bpsToPct(getCorridorFeeBps('PHP')) },
  { pair: 'USD → MYR', flag: '🇲🇾', rate: 4.71,  volume: '$1.8M', sla: '5.1m', success: 98.9, currency: 'MYR', dec: 2, fee: bpsToPct(getCorridorFeeBps('MYR')) },
  { pair: 'USD → IDR', flag: '🇮🇩', rate: 16284,  volume: '$2.1M', sla: '3.0m', success: 99.5, currency: 'IDR', dec: 0, fee: bpsToPct(getCorridorFeeBps('IDR')) },
  { pair: 'USD → VND', flag: '🇻🇳', rate: 25385,  volume: '$0.9M', sla: '4.8m', success: 98.2, currency: 'VND', dec: 0, fee: bpsToPct(getCorridorFeeBps('VND')) },
  { pair: 'USD → THB', flag: '🇹🇭', rate: 35.82,  volume: '$0.7M', sla: '5.5m', success: 97.8, currency: 'THB', dec: 2, fee: bpsToPct(getCorridorFeeBps('THB')) },
  { pair: 'USD → SGD', flag: '🇸🇬', rate: 1.345,  volume: '$0.4M', sla: '6.1m', success: 99.1, currency: 'SGD', dec: 3, fee: bpsToPct(getCorridorFeeBps('SGD')) },
  { pair: 'USD → EUR', flag: '🇪🇺', rate: 0.924,  volume: '$0.3M', sla: '6.4m', success: 97.6, currency: 'EUR', dec: 3, fee: bpsToPct(getCorridorFeeBps('EUR')) },
  { pair: 'USD → GBP', flag: '🇬🇧', rate: 0.789,  volume: '$0.2M', sla: '7.2m', success: 97.1, currency: 'GBP', dec: 3, fee: bpsToPct(getCorridorFeeBps('GBP')) },
];

/**
 * The transfer states, grouped the way an operator reads them.
 *
 * What was here: three hard-coded pairs under a heading that says "Settlement
 * Pipeline" — 8 authorized / $4,540, 19 settled today / $14,640 — plus six
 * invented transactions carrying ids shaped exactly like real ones
 * (`ti_m8q4_9b21fa`), and a Compliance panel asserting "KYB status: Approved ·
 * Sumsub verified" and "Risk tier: Tier 1 · Low risk" to every reader.
 *
 * The compliance panel is the one that mattered. It rendered identically for an
 * organisation sitting in REGISTERED that cannot move a dollar, and a panel on
 * a dashboard is read as a reading. Telling a customer their KYB is approved
 * when nothing has been checked is a statement about our own regulatory
 * posture, in the place they are most likely to believe it.
 *
 * All of it now comes from /api/transfers, /api/kyb/state and /api/settings,
 * and each panel says so when it has nothing to show.
 */
const SETTLED_STATES = new Set(['SETTLED', 'DISBURSED', 'CREDITED']);
const FAILED_STATES = new Set(['FAILED', 'REFUNDED', 'REFUNDING']);

type TxStatus = 'settled' | 'pending' | 'failed';

type TransferItem = {
  id: string;
  state: string;
  recipientName: string;
  targetCurrency: string;
  targetAmount: string;
  sourceAmountUsd: string;
  createdAt: string;
};

function txStatusOf(state: string): TxStatus {
  if (SETTLED_STATES.has(state)) return 'settled';
  if (FAILED_STATES.has(state)) return 'failed';
  return 'pending';
}

/** KYB lifecycle, in the words a customer needs rather than the enum. */
const KYB_COPY: Record<string, { value: string; status: Status }> = {
  REGISTERED: { value: 'Not started — complete business verification', status: 'pending' },
  KYB_SUBMITTED: { value: 'Submitted — under review', status: 'pending' },
  KYB_PROVIDER_APPROVED: { value: 'Provider approved — awaiting Splash sign-off', status: 'pending' },
  ACTIVE: { value: 'Approved — verified and active', status: 'verified' },
  REJECTED: { value: 'Rejected — contact compliance', status: 'failed' },
  SUSPENDED: { value: 'Suspended — contact compliance', status: 'failed' },
};

const NETWORK_STATUS = [
  { label: 'Pay', status: 'Live-model', copy: 'MY-to-PH payout path' },
  { label: 'Get paid', status: 'Built', copy: 'Invoice and pay links' },
  { label: 'Sweep', status: 'Launch product', copy: 'Recipient account loop' },
  { label: 'Keep', status: 'Corridor gated', copy: 'Stored balance by approval' },
] as const;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function TxPill({ status }: { status: TxStatus }) {
  // Transaction states = semantic tokens (W9.0), never palette one-offs.
  const styles = {
    settled: 'bg-[var(--ok-bg)] text-[#1F4452]',
    pending: 'bg-[var(--warn-bg)] text-[#8b6418]',
    failed: 'bg-[var(--error-bg)] text-[var(--error)]',
  };
  const dots = {
    settled: 'bg-[var(--ok)]',
    pending: 'bg-[var(--warn)]',
    failed: 'bg-[var(--error)]',
  };
  const labels = { settled: 'Settled', pending: 'Pending', failed: 'Failed' };
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[13px] font-medium', styles[status])}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dots[status])} />
      {labels[status]}
    </span>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function DashboardOverview() {
  const [corridors] = useState(INITIAL_CORRIDORS);
  // No number is shown until the ledger answers; the card used to render
  // $24,500 and $98.72 from constants, and "+$3.22" a day from nowhere.
  const [treasuryPhase, setTreasuryPhase] = useState<'loading' | 'gated' | 'live'>('loading');
  const [yieldEarned, setYield]   = useState(0);
  const [treasuryPrincipal, setTreasuryPrincipal] = useState(0);
  const [treasuryApy, setTreasuryApy] = useState(0);
  const [walSummary, setWalSummary] = useState({ detected: 0, batchable: 0, needsApproval: 0 });
  const [treasuryRateLabel, setTreasuryRateLabel] = useState('USDY · variable');
  const [transfers, setTransfers] = useState<TransferItem[] | null>(null);
  const [kyb, setKyb] = useState<{ state: string; blocked: boolean } | null>(null);
  const [limits, setLimits] = useState<{ dailyLimitUsd: number; perTransferLimitUsd: number } | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);

  // This organisation's own transfers. Everything below — the pipeline counts,
  // the recent list and the 30-day volume — is derived from this one read, so
  // three panels cannot disagree about the same transfers.
  useEffect(() => {
    let active = true;
    void fetch('/api/transfers?filter=all', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { items?: TransferItem[] } | null) => {
        if (!active) return;
        setTransfers(Array.isArray(d?.items) ? d.items : []);
      })
      .catch(() => { if (active) setTransfers([]); });
    return () => { active = false; };
  }, []);

  // Compliance standing, read rather than asserted.
  useEffect(() => {
    let active = true;
    void fetch('/api/kyb/state', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { state?: string; blocked?: boolean } | null) => {
        if (!active || !d?.state) return;
        setKyb({ state: d.state, blocked: Boolean(d.blocked) });
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    void fetch('/api/settings', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { dailyLimitUsd?: number; perTransferLimitUsd?: number } | null) => {
        if (!active || typeof d?.dailyLimitUsd !== 'number') return;
        setLimits({ dailyLimitUsd: d.dailyLimitUsd, perTransferLimitUsd: d.perTransferLimitUsd ?? 0 });
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // The header used to read "Acme Trading Sdn Bhd" for everybody.
  useEffect(() => {
    let active = true;
    void fetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { organization?: string } | null) => {
        if (active && d?.organization) setWorkspace(d.organization);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  // Memoised so the three derivations below do not see a new array identity on
  // every render.
  const rows = useMemo(() => transfers ?? [], [transfers]);

  // Read once, on mount. `Date.now()` during render is impure and the window
  // does not need to move while somebody is looking at the page.
  const [mountedAt] = useState(() => Date.now());

  const pipeline = useMemo(() => {
    const bucket = (match: (t: TransferItem) => boolean) => {
      const picked = rows.filter(match);
      const total = picked.reduce((sum, t) => sum + (Number.parseFloat(t.sourceAmountUsd) || 0), 0);
      return { count: picked.length, amount: total };
    };
    return [
      { label: 'Authorized', dot: 'bg-[var(--pending)]', ...bucket((t) => t.state === 'AUTHORIZED') },
      {
        label: 'On the way',
        dot: 'bg-[var(--info)]',
        ...bucket((t) => !SETTLED_STATES.has(t.state) && !FAILED_STATES.has(t.state) && t.state !== 'AUTHORIZED'),
      },
      { label: 'Settled', dot: 'bg-[var(--ok)]', ...bucket((t) => SETTLED_STATES.has(t.state)) },
    ];
  }, [rows]);

  // Thirty days, counted from settled transfers only — an authorized transfer
  // is money that has not moved, and counting it as volume overstates it.
  const volume30d = useMemo(() => {
    const since = mountedAt - 30 * 24 * 60 * 60 * 1000;
    return rows
      .filter((t) => SETTLED_STATES.has(t.state) && new Date(t.createdAt).getTime() >= since)
      .reduce((sum, t) => sum + (Number.parseFloat(t.sourceAmountUsd) || 0), 0);
  }, [rows, mountedAt]);

  const recent = useMemo(
    () =>
      [...rows]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 6),
    [rows],
  );

  // Real two-bucket balances from the treasury ledger.
  useEffect(() => {
    let active = true;
    fetch('/api/treasury')
      .then(async (r) => {
        if (!active) return;
        if (!r.ok) {
          // Phase 0: the treasury is not a feature yet. Say when it arrives.
          const body = await r.json().catch(() => ({}));
          if (r.status === 403 && body?.code === 'custody_not_licensed') setTreasuryPhase('gated');
          return;
        }
        const d = await r.json();
        if (typeof d.treasuryPrincipal === 'number') setTreasuryPrincipal(d.treasuryPrincipal);
        if (typeof d.treasuryYield === 'number') setYield(d.treasuryYield);
        if (d.rate?.label) setTreasuryRateLabel(d.rate.label);
        if (typeof d.rate?.apy === 'number') setTreasuryApy(d.rate.apy);
        setTreasuryPhase('live');
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    void fetch('/api/copilot/summary')
      .then((response) => response.json())
      .then((summary: { detected?: number; batchable?: number; needsApproval?: number }) => {
        setWalSummary({
          detected: summary.detected ?? 0,
          batchable: summary.batchable ?? 0,
          needsApproval: summary.needsApproval ?? 0,
        });
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-5">
      {/* Live FX ticker */}
      <LiveExchangeTicker />

      {/* Page header */}
      <DashPageHeader
        className="mt-5"
        kicker="Operating desk"
        title="Overview"
        description={workspace ? `${workspace} · Updated just now` : 'Updated just now'}
        actions={
          <>
            {/* Was always "verified", on every account, including one that
                cannot move a dollar. */}
            <StatusBadge status={kyb ? (kyb.blocked ? 'pending' : 'verified') : 'pending'} />
            <Link href="/dashboard/transfer" className="dash-btn">
              <Send size={14} />
              New Transfer
            </Link>
            <Link href="/dashboard/batch" className="dash-btn dash-btn-ghost">
              <Layers size={14} />
              Batch Payout
            </Link>
          </>
        }
      />

      {/* Signature: animated settlement-engine flow */}
      <SettlementEngineFlow variant="settlement" className="dash-reveal" />

      <section className="grid gap-3 dash-reveal-stagger sm:grid-cols-2 xl:grid-cols-4" aria-label="Network build status">
        {NETWORK_STATUS.map((item, index) => (
          <div key={item.label} className="dash-block dash-block-interactive p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="dash-kicker">0{index + 1} · {item.status}</span>
              <span className={cn('h-2 w-2 rounded-full', index === 0 ? 'bg-[var(--ok)]' : 'bg-[var(--pending)]')} />
            </div>
            <strong className="mt-2 block text-lg font-semibold text-[#0c3e48]">{item.label}</strong>
            <small className="mt-1 block text-[13px] font-medium text-[#326273]/90">{item.copy}</small>
          </div>
        ))}
      </section>

      {/* Top stats row */}
      <section className="grid grid-cols-2 gap-3 dash-reveal-stagger xl:grid-cols-4">
        {TOP_STATS.map(({ label, value, icon: Icon, accent, bg, id }) => {
          if (id === '0xwal') {
            return (
              <Link key={label} href="/dashboard/0xwal" className="dash-block dash-block-interactive p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#326273]/90">{label}</span>
                  <div className={cn('rounded-lg p-1.5', bg)}>
                    <Icon size={14} className={accent} />
                  </div>
                </div>
                <div className="mt-2 text-sm font-semibold leading-5 text-[#0c3e48]">
                  {walSummary.detected} invoices detected · {walSummary.batchable} batchable · {walSummary.needsApproval} needs approval
                </div>
                <div className="mt-1 text-[13px] font-medium text-[#9f5839]">Open Zeke →</div>
              </Link>
            );
          }
          // "$39,120 · +12.4%" was a string literal on the most quotable
          // number on the page. It is now settled transfers over 30 days, and
          // an em dash while it is still being read.
          const resolved =
            id === 'volume'
              ? transfers === null
                ? '…'
                : `$${fmt(volume30d)}`
              : value ?? '—';
          const delta =
            id === 'volume'
              ? transfers === null
                ? ''
                : 'Settled, last 30 days'
              : (TOP_STATS.find((s) => s.id === id) as { delta?: string })?.delta ?? '';
          return (
            <DashStat
              key={label}
              label={label}
              value={resolved}
              delta={delta}
              deltaClassName="text-[var(--ok)]"
              icon={Icon}
              iconClassName={accent}
              iconWrapClassName={bg}
              valueClassName="text-xl"
            />
          );
        })}
      </section>

      {/* Main 2-col layout */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_300px]">

        {/* ── LEFT COLUMN ── */}
        {/* AI recommendations live on the Zeke desk and Copilot pages; this
            column stays focused on operating state. */}
        <div className="min-w-0 space-y-5">

          {/* Settlement pipeline */}
          <div className="dash-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[#1F4452]">Settlement Pipeline</h2>
              {/* "Next window: 16:30 MYT · 13 transfers · $7,510" was a string.
                  There is no batching window in the product, so there is
                  nothing to replace it with — the count that IS real goes here
                  instead. */}
              <span className="rounded-full bg-[#326273]/8 px-2.5 py-1 text-[13px] font-medium text-[#326273]/90">
                {transfers === null
                  ? 'Loading…'
                  : `${rows.length} ${rows.length === 1 ? 'transfer' : 'transfers'} on record`}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              {pipeline.map((item) => (
                <div key={item.label} className="rounded-xl bg-[#F6F0ED] p-3">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', item.dot)} />
                    <span className="text-[13px] text-[#326273]/90">{item.label}</span>
                  </div>
                  <div className="money mt-2 text-2xl font-medium text-[#1F4452]">
                    {transfers === null ? '—' : item.count}
                  </div>
                  <div className="money mt-0.5 text-[13px] font-medium text-[var(--info)]">
                    {transfers === null ? '' : `$${fmt(item.amount)}`}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Live corridors table */}
          <div className="dash-surface overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#326273]/8 px-4 py-3">
              <h2 className="text-sm font-semibold text-[#1F4452]">Corridor Readiness</h2>
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-[#326273]/90">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ok)]" />
                1 live-model · 8 implemented in code
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#326273]/8 bg-[#F6F0ED]/60">
                    <th className="px-4 py-2 text-left font-medium text-[#326273]/90">Corridor</th>
                    <th className="px-4 py-2 text-right font-medium text-[#326273]/90">Reference rate</th>
                    <th className="hidden px-4 py-2 text-right font-medium text-[#326273]/90 sm:table-cell">Model volume</th>
                    <th className="hidden px-4 py-2 text-right font-medium text-[#326273]/90 md:table-cell">Splash fee</th>
                    <th className="px-4 py-2 text-right font-medium text-[#326273]/90">Test success</th>
                  </tr>
                </thead>
                <tbody>
                  {corridors.map((c, i) => (
                    <tr
                      key={c.pair}
                      className={cn(
                        'border-b border-[#326273]/5 transition-colors hover:bg-[#F6F0ED]/50',
                        i === corridors.length - 1 && 'border-b-0'
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-sm leading-none">{c.flag}</span>
                          <span className="font-medium text-[#1F4452]">{c.pair}</span>
                          <span className={cn(
                            'hidden rounded-full px-1.5 py-0.5 text-[13px] font-semibold sm:inline',
                            i === 0 ? 'bg-[var(--ok-bg)] text-[#1F4452]' : 'bg-[#5C9EAD]/10 text-[#326273]',
                          )}>
                            {i === 0 ? 'Live-model' : 'In code'}
                          </span>
                        </div>
                      </td>
                      <td className="money px-4 py-2.5 font-medium text-[#1F4452]">
                        {c.rate.toLocaleString('en-US', {
                          maximumFractionDigits: c.dec,
                          minimumFractionDigits: c.dec,
                        })}
                      </td>
                      <td className="money hidden px-4 py-2.5 font-medium text-[#326273]/90 sm:table-cell">{c.volume}</td>
                      <td className="hidden px-4 py-2.5 text-right md:table-cell">
                        <span className="money rounded-full bg-[var(--ok-bg)] px-2 py-0.5 text-[13px] font-medium text-[#1F4452]">{c.fee}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span
                          className={cn(
                            'money font-medium',
                            c.success >= 99
                              ? 'text-[var(--ok)]'
                              : c.success >= 98
                              ? 'text-[var(--info)]'
                              : 'text-[#8b6418]'
                          )}
                        >
                          {c.success.toFixed(1)}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Recent transactions table */}
          <div className="dash-surface overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#326273]/8 px-4 py-3">
              <h2 className="text-sm font-semibold text-[#1F4452]">Recent Transactions</h2>
              <Link
                href="/dashboard/history"
                className="text-[13px] font-medium text-[var(--info)] transition-colors hover:text-[#326273]"
              >
                View all →
              </Link>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#326273]/8 bg-[#F6F0ED]/60">
                    <th className="px-4 py-2 text-left font-medium text-[#326273]/90">Description</th>
                    <th className="hidden px-4 py-2 text-left font-medium text-[#326273]/90 sm:table-cell">Corridor</th>
                    <th className="px-4 py-2 text-right font-medium text-[#326273]/90">USD</th>
                    <th className="hidden px-4 py-2 text-right font-medium text-[#326273]/90 md:table-cell">Local</th>
                    <th className="px-4 py-2 text-right font-medium text-[#326273]/90">Status</th>
                    <th className="hidden px-4 py-2 text-right font-medium text-[#326273]/90 sm:table-cell">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((t, i) => (
                    <tr
                      key={t.id}
                      className={cn(
                        'border-b border-[#326273]/5 transition-colors hover:bg-[#F6F0ED]/50',
                        i === recent.length - 1 && 'border-b-0'
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-[#1F4452]">{t.recipientName}</div>
                        <div className="mt-0.5 text-[13px] text-[#326273]/90">{t.id}</div>
                      </td>
                      <td className="hidden px-4 py-2.5 text-[#326273]/90 sm:table-cell">
                        USD&rarr;{t.targetCurrency}
                      </td>
                      <td className="money px-4 py-2.5 font-medium text-[#1F4452]">
                        ${fmt(Number.parseFloat(t.sourceAmountUsd) || 0)}
                      </td>
                      <td className="money hidden px-4 py-2.5 text-[#326273]/90 md:table-cell">
                        {t.targetCurrency} {t.targetAmount}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <TxPill status={txStatusOf(t.state)} />
                      </td>
                      <td className="hidden px-4 py-2.5 text-right text-[#326273]/90 sm:table-cell">
                        <LocalTime value={t.createdAt} format="time" locale="en-GB" options={{ hour: '2-digit', minute: '2-digit' }} />
                      </td>
                    </tr>
                  ))}
                  {/* An empty desk says so. Six invented transactions carrying
                      ids shaped like real ones is how a demo becomes a claim. */}
                  {transfers !== null && recent.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-[13px] font-medium text-[#326273]/90">
                        No transfers yet. Your first one will appear here.
                      </td>
                    </tr>
                  )}
                  {transfers === null && (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-[13px] font-medium text-[#326273]/90">
                        Loading transfers…
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ── RIGHT COLUMN ── */}
        <aside className="space-y-4">

          {/* Approval-gated treasury projection */}
          <div className="dash-block dash-block-accent dash-block-interactive p-4">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2.5">
                <div className="rounded-lg bg-[var(--ok-bg)] p-2">
                  <TrendingUp size={16} className="text-[var(--ok)]" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-[#1F4452]">Treasury Projection</h2>
                  <p className="text-[13px] text-[#326273]/90">Ondo USDY · simulation only</p>
                </div>
              </div>
              {treasuryPhase === 'live' ? (
                <span className="rounded-full bg-[#D9A441]/10 px-2 py-0.5 text-[13px] font-semibold text-[#8b6418]">
                  {treasuryRateLabel}
                </span>
              ) : null}
            </div>

            {treasuryPhase === 'live' ? (
              <>
                <div className="mt-3">
                  <p className="text-[12px] uppercase tracking-wide text-[#326273]/90">Modeled allocation</p>
                  <p className="money mt-0.5 text-2xl font-medium text-[#1F4452]">${fmt(treasuryPrincipal)}</p>
                  <p className="money mt-1 flex items-center gap-1 text-[13px] font-medium text-[var(--ok)]">
                    <TrendingUp size={11} />
                    +${yieldEarned.toFixed(2)} modeled this month
                  </p>
                </div>

                <div className="mt-3 space-y-1 rounded-lg bg-white/70 p-3 text-[13px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[#326273]/90">Modeled daily yield</span>
                    <span className="money font-medium text-[var(--ok)]">
                      +${((treasuryPrincipal * treasuryApy) / 100 / 365).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#326273]/90">Status</span>
                    <span className="flex items-center gap-1 font-medium text-[var(--ok)]">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ok)]" />
                      Approval gated
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#326273]/90">Protocol</span>
                    <span className="font-medium text-[#326273]">Ondo USDY · T-bill</span>
                  </div>
                </div>
              </>
            ) : (
              <div className="mt-3 rounded-lg bg-white/70 p-3 text-[13px] leading-relaxed text-[#326273]/90">
                <p className="font-semibold text-[#1F4452]">Treasury arrives with our licence</p>
                <p className="mt-1">
                  {treasuryPhase === 'gated'
                    ? 'Holding funds is a Phase 2 capability that needs a money-broking licence Splash does not hold yet. Today Splash pays out only.'
                    : 'Checking the ledger…'}
                </p>
              </div>
            )}

            <div className="mt-3 flex gap-2">
              <Link
                href="/dashboard/treasury"
                className="flex-1 rounded-lg bg-[var(--ok)] py-1.5 text-center text-[13px] font-semibold text-white transition-colors hover:opacity-90"
              >
                {treasuryPhase === 'live' ? 'View projection' : 'When it arrives'}
              </Link>
              <Link
                href="/dashboard/treasury"
                className="flex-1 rounded-lg border border-[var(--ok)] py-1.5 text-center text-[13px] font-semibold text-[var(--ok)] transition-colors hover:bg-[var(--ok-bg)]"
              >
                Review controls
              </Link>
            </div>
          </div>

          {/* Compliance posture */}
          <div className="dash-block p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-[var(--info)]" />
              <h2 className="text-sm font-semibold text-[#1F4452]">Compliance</h2>
            </div>
            <div className="mt-3 space-y-2">
              {[
                {
                  label: 'KYB status',
                  ...(kyb
                    ? KYB_COPY[kyb.state] ?? { value: kyb.state, status: 'pending' as Status }
                    : { value: 'Reading…', status: 'pending' as Status }),
                },
                {
                  label: 'Money movement',
                  value: kyb
                    ? kyb.blocked
                      ? 'Blocked until verification completes'
                      : 'Unlocked'
                    : 'Reading…',
                  status: (kyb && !kyb.blocked ? 'verified' : 'pending') as Status,
                },
                {
                  label: 'Daily limit',
                  // The limit is a real setting. How much of it has been used
                  // today is not computed anywhere, and "43% used · $12,100
                  // remaining" was invented — so the limit is stated and the
                  // usage is not.
                  value: limits
                    ? `$${limits.dailyLimitUsd.toLocaleString('en-US')} per day`
                    : 'Reading…',
                  status: 'verified' as Status,
                },
              ].map((item) => (
                <HoverPopup key={item.label} title={item.label} content={item.value}>
                  <div className="flex cursor-pointer items-center justify-between rounded-lg bg-[#F6F0ED] px-3 py-2 transition-colors hover:bg-[#ede8e4]">
                    <div>
                      <div className="text-[13px] font-medium text-[#1F4452]">{item.label}</div>
                      <div className="text-[13px] text-[#326273]/90">{item.value}</div>
                    </div>
                    <StatusBadge status={item.status} />
                  </div>
                </HoverPopup>
              ))}
            </div>
          </div>

          {/* Pending actions */}
          <div className="dash-block p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle size={16} className="text-[#8b6418]" />
              <h2 className="text-sm font-semibold text-[#1F4452]">Pending Actions</h2>
            </div>
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between rounded-lg bg-[var(--warn-bg)] px-3 py-2.5">
                <div>
                  <div className="text-[13px] font-medium text-[#8b6418]">Batch TOTP authorization</div>
                  <div className="text-[13px] text-[#8b6418]">12 transfers · $6,670</div>
                </div>
                <Link
                  href="/dashboard/batch"
                  className="shrink-0 rounded-md bg-[#8b6418] px-2.5 py-1 text-[13px] font-semibold text-white transition-colors hover:opacity-90"
                >
                  Authorize
                </Link>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-[#F6F0ED] px-3 py-2.5">
                <div>
                  <div className="text-[13px] font-medium text-[#1F4452]">KYB document review</div>
                  <div className="text-[13px] text-[#326273]/90">Sumsub · in progress</div>
                </div>
                <Link
                  href="/dashboard/settings"
                  className="shrink-0 rounded-md bg-[#237284] px-2.5 py-1 text-[13px] font-semibold text-white transition-colors hover:bg-[#4a8a99]"
                >
                  Review
                </Link>
              </div>
            </div>
          </div>

          {/* Invoice upload (Walrus) */}
          <div className="dash-block dash-block-interactive p-4">
            <div className="flex items-center gap-2">
              <FileText size={16} className="text-[var(--info)]" />
              <h2 className="text-sm font-semibold text-[#1F4452]">Upload Invoice</h2>
            </div>
            <Link
              href="/dashboard/invoices"
              className="mt-3 flex flex-col items-center rounded-lg border-2 border-dashed border-[#326273]/15 bg-[#F6F0ED] p-4 text-center transition-colors hover:border-[#5C9EAD]/40 hover:bg-[#5C9EAD]/5"
            >
              <Upload size={22} className="text-[#326273]/90" />
              <p className="mt-2 text-[13px] font-medium text-[#326273]/90">Go to Invoice Vault</p>
              <p className="mt-1 text-[13px] text-[#326273]/90">
                Access-controlled · stored on Walrus · 7-yr retention
              </p>
            </Link>
            <Link
              href="/dashboard/invoices"
              className="mt-2 block text-center text-[13px] font-medium text-[var(--info)] transition-colors hover:text-[#326273]"
            >
              View invoice vault →
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

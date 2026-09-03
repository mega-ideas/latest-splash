'use client';

import { useEffect, useState } from 'react';
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
// Coral accent = 0xWal identity only (W9.0 coral rule); every other stat
// uses semantic/info tones from styles/tokens.css.
const TOP_STATS = [
  { label: '0xWal operating scan', value: null, icon: Bot, accent: 'text-[#E39774]', bg: 'bg-[#E39774]/10', id: '0xwal' },
  { label: 'Volume (30d)', value: '$39,120', delta: '+12.4%', icon: ArrowUpRight, accent: 'text-[var(--info)]', bg: 'bg-[var(--info-bg)]', id: 'volume' },
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

// Pipeline dots are STATE, not decoration — semantic tokens (W9.0).
const PIPELINE = [
  { label: 'Authorized',   count: 8,  amount: '$4,540', dot: 'bg-[var(--pending)]' },
  { label: 'On the way',   count: 5,  amount: '$2,960', dot: 'bg-[var(--info)]' },
  { label: 'Settled today',count: 19, amount: '$14,640', dot: 'bg-[var(--ok)]' },
];

type TxStatus = 'settled' | 'pending' | 'failed';
const ACTIVITIES: Array<{
  id: string; desc: string; corridor: string; usd: string; local: string; status: TxStatus; time: string;
}> = [
  { id: 'ti_m8q4_9b21fa',      desc: 'Vendor payout · Manila supplier',         corridor: 'USD→PHP', usd: '$748.00',    local: 'PHP 42,180',  status: 'settled', time: '14:32' },
  { id: 'batch_m8q2_12ac08',   desc: 'BPO payroll batch · 12 recipients', corridor: 'USD→PHP', usd: '$6,670.00',  local: 'PHP 376,377', status: 'pending', time: '13:51' },
  { id: 'dep_m8pr_77a932',     desc: 'Stripe deposit received',            corridor: '—',        usd: '$3,820.00',  local: '—',           status: 'settled', time: '12:04' },
  { id: 'ti_m8pa_3c44f1',      desc: 'Textile supplier · Jakarta',         corridor: 'USD→IDR', usd: '$1,200.00',  local: 'IDR 19.5M',  status: 'settled', time: '11:20' },
  { id: 'ti_m8p9_7e88b2',      desc: 'SG marketplace payout',             corridor: 'USD→SGD', usd: '$890.00',    local: 'SGD 1,197',  status: 'settled', time: '10:55' },
  { id: 'ti_m8p7_2b11a4',      desc: 'EUR freelancer payment',             corridor: 'USD→EUR', usd: '$260.00',    local: 'EUR 240',    status: 'failed',  time: '09:18' },
];

const COMPLIANCE: Array<{ label: string; value: string; status: Status }> = [
  { label: 'KYB status',   value: 'Approved · Sumsub verified',       status: 'verified' },
  { label: 'Risk tier',    value: 'Tier 1 · Low risk',                 status: 'verified' },
  { label: 'Daily limit',  value: '43% used · $12,100 remaining',      status: 'pending'  },
  { label: 'Walrus audit', value: 'Active · 7-year retention',         status: 'verified' },
];

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
    settled: 'bg-[var(--ok-bg)] text-[var(--ok)]',
    pending: 'bg-[var(--warn-bg)] text-[var(--warn)]',
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
  const [yieldEarned, setYield]   = useState(98.72);
  const [treasuryPrincipal, setTreasuryPrincipal] = useState(24500);
  const [walSummary, setWalSummary] = useState({ detected: 0, batchable: 0, needsApproval: 0 });
  const [treasuryRateLabel, setTreasuryRateLabel] = useState('USDY · variable');

  // Real two-bucket balances from the treasury ledger.
  useEffect(() => {
    let active = true;
    fetch('/api/treasury')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!active || !d) return;
        if (typeof d.treasuryPrincipal === 'number') setTreasuryPrincipal(d.treasuryPrincipal);
        if (typeof d.treasuryYield === 'number') setYield(d.treasuryYield);
        if (d.rate?.label) setTreasuryRateLabel(d.rate.label);
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
        description="Acme Trading Sdn Bhd · Updated just now"
        actions={
          <>
            <StatusBadge status="verified" />
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
            <small className="mt-1 block text-[13px] font-medium text-[#326273]/55">{item.copy}</small>
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
                  <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/55">{label}</span>
                  <div className={cn('rounded-lg p-1.5', bg)}>
                    <Icon size={14} className={accent} />
                  </div>
                </div>
                <div className="mt-2 text-sm font-semibold leading-5 text-[#0c3e48]">
                  {walSummary.detected} invoices detected · {walSummary.batchable} batchable · {walSummary.needsApproval} needs approval
                </div>
                <div className="mt-1 text-[13px] font-medium text-[#E39774]">Open 0xWal →</div>
              </Link>
            );
          }
          return (
            <DashStat
              key={label}
              label={label}
              value={value ?? '—'}
              delta={(TOP_STATS.find((s) => s.id === id) as { delta?: string })?.delta ?? ''}
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
        {/* AI recommendations live on the 0xWal desk and Copilot pages; this
            column stays focused on operating state. */}
        <div className="min-w-0 space-y-5">

          {/* Settlement pipeline */}
          <div className="dash-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[#1F4452]">Settlement Pipeline</h2>
              <span className="rounded-full bg-[#326273]/8 px-2.5 py-1 text-[13px] font-medium text-[#326273]/60">
                Next window: 16:30 MYT · 13 transfers · $7,510
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              {PIPELINE.map((item) => (
                <div key={item.label} className="rounded-xl bg-[#F6F0ED] p-3">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('h-2 w-2 rounded-full', item.dot)} />
                    <span className="text-[13px] text-[#326273]/60">{item.label}</span>
                  </div>
                  <div className="money mt-2 text-2xl font-medium text-[#1F4452]">{item.count}</div>
                  <div className="money mt-0.5 text-[13px] font-medium text-[var(--info)]">{item.amount}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Live corridors table */}
          <div className="dash-surface overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#326273]/8 px-4 py-3">
              <h2 className="text-sm font-semibold text-[#1F4452]">Corridor Readiness</h2>
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-[#326273]/50">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ok)]" />
                1 live-model · 8 implemented in code
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#326273]/8 bg-[#F6F0ED]/60">
                    <th className="px-4 py-2 text-left font-medium text-[#326273]/50">Corridor</th>
                    <th className="px-4 py-2 text-right font-medium text-[#326273]/50">Reference rate</th>
                    <th className="hidden px-4 py-2 text-right font-medium text-[#326273]/50 sm:table-cell">Model volume</th>
                    <th className="hidden px-4 py-2 text-right font-medium text-[#326273]/50 md:table-cell">Splash fee</th>
                    <th className="px-4 py-2 text-right font-medium text-[#326273]/50">Test success</th>
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
                            i === 0 ? 'bg-[var(--ok-bg)] text-[var(--ok)]' : 'bg-[#5C9EAD]/10 text-[#326273]',
                          )}>
                            {i === 0 ? 'Live-model' : 'In code'}
                          </span>
                        </div>
                      </td>
                      <td className="money px-4 py-2.5 font-medium text-[#1F4452]">
                        {c.rate.toLocaleString(undefined, {
                          maximumFractionDigits: c.dec,
                          minimumFractionDigits: c.dec,
                        })}
                      </td>
                      <td className="money hidden px-4 py-2.5 font-medium text-[#326273]/55 sm:table-cell">{c.volume}</td>
                      <td className="hidden px-4 py-2.5 text-right md:table-cell">
                        <span className="money rounded-full bg-[var(--ok-bg)] px-2 py-0.5 text-[13px] font-medium text-[var(--ok)]">{c.fee}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <span
                          className={cn(
                            'money font-medium',
                            c.success >= 99
                              ? 'text-[var(--ok)]'
                              : c.success >= 98
                              ? 'text-[var(--info)]'
                              : 'text-[var(--warn)]'
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
                    <th className="px-4 py-2 text-left font-medium text-[#326273]/50">Description</th>
                    <th className="hidden px-4 py-2 text-left font-medium text-[#326273]/50 sm:table-cell">Corridor</th>
                    <th className="px-4 py-2 text-right font-medium text-[#326273]/50">USD</th>
                    <th className="hidden px-4 py-2 text-right font-medium text-[#326273]/50 md:table-cell">Local</th>
                    <th className="px-4 py-2 text-right font-medium text-[#326273]/50">Status</th>
                    <th className="hidden px-4 py-2 text-right font-medium text-[#326273]/50 sm:table-cell">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {ACTIVITIES.map((a, i) => (
                    <tr
                      key={a.id}
                      className={cn(
                        'border-b border-[#326273]/5 transition-colors hover:bg-[#F6F0ED]/50',
                        i === ACTIVITIES.length - 1 && 'border-b-0'
                      )}
                    >
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-[#1F4452]">{a.desc}</div>
                        <div className="mt-0.5 text-[13px] text-[#326273]/35">{a.id}</div>
                      </td>
                      <td className="hidden px-4 py-2.5 text-[#326273]/55 sm:table-cell">{a.corridor}</td>
                      <td className="money px-4 py-2.5 font-medium text-[#1F4452]">{a.usd}</td>
                      <td className="money hidden px-4 py-2.5 text-[#326273]/55 md:table-cell">{a.local}</td>
                      <td className="px-4 py-2.5 text-right">
                        <TxPill status={a.status} />
                      </td>
                      <td className="hidden px-4 py-2.5 text-right text-[#326273]/45 sm:table-cell">{a.time}</td>
                    </tr>
                  ))}
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
                  <p className="text-[13px] text-[#326273]/50">Ondo USDY · simulation only</p>
                </div>
              </div>
              <span className="rounded-full bg-[#D9A441]/15 px-2 py-0.5 text-[13px] font-semibold text-[#9a6f15]">
                {treasuryRateLabel}
              </span>
            </div>

            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wide text-[#326273]/45">Modeled allocation</p>
              <p className="money mt-0.5 text-2xl font-medium text-[#1F4452]">${fmt(treasuryPrincipal)}</p>
              <p className="money mt-1 flex items-center gap-1 text-[13px] font-medium text-[var(--ok)]">
                <TrendingUp size={11} />
                +${yieldEarned.toFixed(2)} modeled this month
              </p>
            </div>

            <div className="mt-3 space-y-1 rounded-lg bg-white/70 p-3 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-[#326273]/55">Modeled daily yield</span>
                <span className="money font-medium text-[var(--ok)]">+$3.22</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#326273]/55">Status</span>
                <span className="flex items-center gap-1 font-medium text-[var(--ok)]">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ok)]" />
                  Approval gated
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#326273]/55">Protocol</span>
                <span className="font-medium text-[#326273]">Ondo USDY · T-bill</span>
              </div>
            </div>

            <div className="mt-3 flex gap-2">
              <Link
                href="/dashboard/treasury"
                className="flex-1 rounded-lg bg-[var(--ok)] py-1.5 text-center text-[13px] font-semibold text-white transition-colors hover:opacity-90"
              >
                View projection
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
              {COMPLIANCE.map((item) => (
                <HoverPopup key={item.label} title={item.label} content={item.value}>
                  <div className="flex cursor-pointer items-center justify-between rounded-lg bg-[#F6F0ED] px-3 py-2 transition-colors hover:bg-[#ede8e4]">
                    <div>
                      <div className="text-[13px] font-medium text-[#1F4452]">{item.label}</div>
                      <div className="text-[13px] text-[#326273]/55">{item.value}</div>
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
              <AlertTriangle size={16} className="text-[var(--warn)]" />
              <h2 className="text-sm font-semibold text-[#1F4452]">Pending Actions</h2>
            </div>
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between rounded-lg bg-[var(--warn-bg)] px-3 py-2.5">
                <div>
                  <div className="text-[13px] font-medium text-[var(--warn)]">Batch TOTP authorization</div>
                  <div className="text-[13px] text-[var(--warn)]/80">12 transfers · $6,670</div>
                </div>
                <Link
                  href="/dashboard/batch"
                  className="shrink-0 rounded-md bg-[var(--warn-bg)]0 px-2.5 py-1 text-[13px] font-semibold text-white transition-colors hover:opacity-90"
                >
                  Authorize
                </Link>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-[#F6F0ED] px-3 py-2.5">
                <div>
                  <div className="text-[13px] font-medium text-[#1F4452]">KYB document review</div>
                  <div className="text-[13px] text-[#326273]/55">Sumsub · in progress</div>
                </div>
                <Link
                  href="/dashboard/settings"
                  className="shrink-0 rounded-md bg-[#5C9EAD] px-2.5 py-1 text-[13px] font-semibold text-white transition-colors hover:bg-[#4a8a99]"
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
              <Upload size={22} className="text-[#326273]/25" />
              <p className="mt-2 text-[13px] font-medium text-[#326273]/50">Go to Invoice Vault</p>
              <p className="mt-1 text-[13px] text-[#326273]/35">
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

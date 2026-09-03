'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Info,
  Landmark,
  Lock,
  PiggyBank,
  ShieldCheck,
  Sparkles,
  Sprout,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import MoneyPathPanel from '@/components/compliance/MoneyPathPanel';

// ─── Types ────────────────────────────────────────────────────────────────────

type TxType = 'deposit' | 'withdraw' | 'yield';
type HistoryEntry = {
  id: string;
  type: TxType;
  desc: string;
  amount: string;
  amountNum: number;
  date: string;
  status: 'confirmed' | 'pending';
};

type WithdrawalNotice = {
  id: string;
  amount: number;
  availableAt: string;
};

type TreasurySnapshot = {
  available: number;
  treasuryPrincipal: number;
  treasuryYield: number;
  executionEnabled: boolean;
  rate: { apy: number; label: string; introductory: boolean };
  withdrawalWindowLabel?: string;
  notices: Array<{ id: string; amount: number; availableAt: string }>;
};

type TreasuryRateView = { apy: number; label: string; introductory: boolean };

// ─── Seed data ──────────────────────────────────────────────────────────────

const SEED_HISTORY: HistoryEntry[] = [
  { id: 'tx_t001', type: 'yield',    desc: 'USDY yield accrual',              amount: '+$3.28',     amountNum:  3.28, date: 'Today, 00:01', status: 'confirmed' },
  { id: 'tx_t002', type: 'yield',    desc: 'USDY yield accrual',              amount: '+$3.25',     amountNum:  3.25, date: 'Yesterday',    status: 'confirmed' },
  { id: 'tx_t003', type: 'deposit',  desc: 'Available → Smart Treasury',      amount: '+$5,000.00', amountNum:  5000, date: '26 May 2026',  status: 'confirmed' },
  { id: 'tx_t004', type: 'yield',    desc: 'USDY yield accrual',              amount: '+$3.22',     amountNum:  3.22, date: '25 May 2026',  status: 'confirmed' },
  { id: 'tx_t006', type: 'withdraw', desc: 'Smart Treasury → Available',      amount: '-$2,000.00', amountNum: -2000, date: '23 May 2026',  status: 'confirmed' },
  { id: 'tx_t007', type: 'deposit',  desc: 'Available → Smart Treasury',      amount: '+$8,000.00', amountNum:  8000, date: '20 May 2026',  status: 'confirmed' },
];

const DAILY_BARS_7D = [
  { day: 'Mon', label: 'Mon · 19 May', amount: 3.18 },
  { day: 'Tue', label: 'Tue · 20 May', amount: 3.21 },
  { day: 'Wed', label: 'Wed · 21 May', amount: 3.19 },
  { day: 'Thu', label: 'Thu · 22 May', amount: 3.24 },
  { day: 'Fri', label: 'Fri · 23 May', amount: 3.22 },
  { day: 'Sat', label: 'Sat · 24 May', amount: 3.25 },
  { day: 'Sun', label: 'Sun · 25 May', amount: 3.28 },
];

const DAILY_BARS_30D = Array.from({ length: 30 }, (_, i) => {
  const base = 3.05 + (i / 30) * 0.3;
  const noise = Math.sin(i * 1.3) * 0.04 + Math.cos(i * 0.7) * 0.03;
  return { day: `D${i + 1}`, label: `Day ${i + 1} · ${i + 1} Apr 2026`, amount: +(base + noise).toFixed(2) };
});

const RISK_ITEMS = [
  { label: 'Instrument',     value: 'Ondo USDY · US Treasury bills',  icon: Landmark    },
  { label: 'Smart contract', value: 'Audited · Sui-native USDY',      icon: ShieldCheck },
  { label: 'Custody',        value: 'Segregated from operating cash', icon: Lock        },
  { label: 'Liquidity',      value: 'USD ↔ USDY conversion on Sui',   icon: Zap         },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtUsd(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function nowLabel() {
  return new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Catmull-Rom → cubic bézier: a smooth line through every data point. */
function smoothPath(pts: Array<[number, number]>) {
  if (pts.length < 2) return '';
  let d = `M ${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Chart geometry (viewBox units). */
const CH = { W: 560, H: 160, PL: 10, PR: 10, PT: 16, PB: 10 };

function HistIcon({ type }: { type: TxType }) {
  if (type === 'deposit')  return <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#D9A441]/15"><ArrowUpRight size={14} className="text-[#C99A2E]" /></div>;
  if (type === 'withdraw') return <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#5C9EAD]/10"><ArrowDownLeft size={14} className="text-[var(--info)]" /></div>;
  return <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#6FB4A0]/18"><Sparkles size={14} className="text-[#4F9C88]" /></div>;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TreasuryPage() {
  const [available, setAvailable]     = useState(11140.0); // USD · 0% · instant
  const [balance, setBalance]         = useState(24500.0); // USDY · Smart Treasury
  const [yield30d, setYield30d]       = useState(98.72);
  const [rate, setRate]               = useState<TreasuryRateView>({ apy: 0, label: 'Variable rate loading...', introductory: false });
  const [executionEnabled, setExecutionEnabled] = useState(false);
  const [history, setHistory]         = useState<HistoryEntry[]>(SEED_HISTORY);
  const [notices, setNotices]         = useState<WithdrawalNotice[]>([]);
  const [tab, setTab]                 = useState<'toTreasury' | 'toAvailable'>('toTreasury');
  const [amount, setAmount]           = useState('');
  const [toast, setToast]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [chartRange, setChartRange]   = useState<'7d' | '30d'>('7d');
  const [hoveredBar, setHoveredBar]   = useState<number | null>(null);
  const [nettingRatio, setNettingRatio] = useState(60);
  const [windowLabel, setWindowLabel] = useState('1–2 business days');
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [cancelingId, setCancelingId] = useState<string | null>(null);
  const counterRef                    = useRef(9);

  // Server-backed ledger: real two-bucket balances, floating rate, and notices.
  function applySnapshot(d: TreasurySnapshot) {
    setAvailable(d.available);
    setBalance(d.treasuryPrincipal);
    setYield30d(d.treasuryYield);
    setExecutionEnabled(d.executionEnabled === true);
    if (d.rate?.apy) setRate({ apy: d.rate.apy, label: d.rate.label, introductory: d.rate.introductory });
    if (d.withdrawalWindowLabel) setWindowLabel(d.withdrawalWindowLabel);
    setNotices((d.notices ?? []).map((n) => ({ id: n.id, amount: n.amount, availableAt: n.availableAt })));
  }

  useEffect(() => {
    let active = true;
    const load = () => {
      fetch('/api/treasury')
        .then((r) => (r.ok ? (r.json() as Promise<TreasurySnapshot>) : null))
        .then((d) => { if (active && d) applySnapshot(d); })
        .catch(() => {});
    };
    load();
    // Refetch when the tab regains focus so a dev-server restart (env flags
    // like TREASURY_EXECUTION_ENABLED load at boot) reflects without a manual
    // reload — the "buttons stuck on Execution disabled" trap.
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      active = false;
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, []);

  const dailyYield  = balance * (rate.apy / 100) / 365;
  const projAnnual  = balance * (rate.apy / 100);
  const totalPosition = available + balance + yield30d;

  const bars        = chartRange === '7d' ? DAILY_BARS_7D : DAILY_BARS_30D;
  const maxBar      = Math.max(...bars.map((d) => d.amount));
  const minBar      = Math.min(...bars.map((d) => d.amount));
  const totalRange  = bars.reduce((sum, d) => sum + d.amount, 0);
  const avgBar      = totalRange / bars.length;
  const focusBar    = hoveredBar !== null ? bars[hoveredBar] : null;

  // Area-chart geometry. The y-domain is zoomed to the daily range (a zero
  // baseline would flatten a ~$3 series into a block) — the high/low gridline
  // labels state the scale explicitly so the zoom is never deceptive.
  const chart = useMemo(() => {
    const span = maxBar - minBar || 0.1;
    const dMin = minBar - span * 0.35;
    const dMax = maxBar + span * 0.2;
    const cx = (i: number) => CH.PL + (bars.length > 1 ? (i / (bars.length - 1)) * (CH.W - CH.PL - CH.PR) : (CH.W - CH.PL - CH.PR) / 2);
    const cy = (v: number) => CH.PT + (1 - (v - dMin) / (dMax - dMin)) * (CH.H - CH.PT - CH.PB);
    const pts = bars.map((d, i) => [cx(i), cy(d.amount)] as [number, number]);
    const line = smoothPath(pts);
    const area = `${line} L ${cx(bars.length - 1).toFixed(1)},${CH.H - CH.PB} L ${cx(0).toFixed(1)},${CH.H - CH.PB} Z`;
    return { pts, line, area, cy, maxIdx: bars.findIndex((b) => b.amount === maxBar) };
  }, [bars, maxBar, minBar]);

  const parsedAmount   = Number.parseFloat(amount);
  const validAmount    = Number.isFinite(parsedAmount) && parsedAmount > 0;
  const toTreasury     = tab === 'toTreasury';
  const sourceBalance  = toTreasury ? available : balance + yield30d;

  const treasuryShare = useMemo(() => {
    const total = available + balance;
    return total > 0 ? Math.round((balance / total) * 100) : 0;
  }, [available, balance]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3600);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!executionEnabled) {
      showToast('Projection only - execution disabled pending regulatory approval.');
      return;
    }
    if (!validAmount) return;
    if (parsedAmount > sourceBalance) {
      showToast(toTreasury ? 'Insufficient Available balance' : 'Insufficient Smart Treasury balance');
      return;
    }
    setLoading(true);
    const action = toTreasury ? 'move' : 'withdraw';
    const id = `tx_t${String(counterRef.current++).padStart(3, '0')}`;
    fetch('/api/treasury', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, amountUsd: parsedAmount }),
    })
      .then(async (r) => {
        const d = (await r.json()) as TreasurySnapshot & { error?: string };
        if (!r.ok) throw new Error(d.error || 'Move failed');
        applySnapshot(d);
        if (action === 'move') {
          setHistory((prev) => [{ id, type: 'deposit', desc: 'Available → Smart Treasury', amount: `+$${fmtUsd(parsedAmount)}`, amountNum: parsedAmount, date: nowLabel(), status: 'confirmed' }, ...prev]);
          showToast(`$${fmtUsd(parsedAmount)} allocated to Smart Treasury`);
        } else {
          setHistory((prev) => [{ id, type: 'withdraw', desc: 'Smart Treasury → Available (notice)', amount: `-$${fmtUsd(parsedAmount)}`, amountNum: -parsedAmount, date: nowLabel(), status: 'pending' }, ...prev]);
          showToast(`Withdrawal requested · funds in Available in ${windowLabel}`);
        }
        setAmount('');
      })
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : 'Move failed'))
      .finally(() => setLoading(false));
  }

  function cancelWithdrawal(noticeId: string) {
    setCancelingId(noticeId);
    fetch('/api/treasury', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', noticeId }),
    })
      .then(async (r) => {
        const d = (await r.json()) as TreasurySnapshot & { error?: string };
        if (!r.ok) throw new Error(d.error || 'Cancel failed');
        applySnapshot(d);
        showToast('Withdrawal cancelled · funds returned to Smart Treasury');
      })
      .catch((err: unknown) => showToast(err instanceof Error ? err.message : 'Cancel failed'))
      .finally(() => { setCancelingId(null); setConfirmCancelId(null); });
  }

  const previewSource = validAmount ? Math.max(0, sourceBalance - parsedAmount) : null;
  const simulationPrincipal = 5_000;
  const simulationFee = simulationPrincipal * 0.014 + 4.5;
  const feesDeleted = simulationFee * (nettingRatio / 100);
  const feesRelocated = simulationFee - feesDeleted;

  return (
    <div className="mx-auto max-w-5xl space-y-6">

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-[#0c3e48] px-4 py-3 text-sm font-medium text-white shadow-xl">
          <CheckCircle2 size={15} className="text-[#6FB4A0]" /> {toast}
        </div>
      )}

      {/* Header */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="dash-kicker">Working capital</span>
          <h1 className="dash-title mt-2">Smart Treasury</h1>
          <p className="mt-1 text-[13px] font-medium text-[#326273]/60">
            Operating cash stays instant. Idle balance earns a floating T-bill rate through Ondo USDY.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-[#D9A441]/40 bg-[#D9A441]/12 px-3 py-1.5 text-sm font-semibold text-[#9a6f15]">{rate.label}</span>
          {rate.introductory && (
            <span className="rounded-full border border-[#E39774]/40 bg-[#E39774]/12 px-3 py-1.5 text-[13px] font-semibold text-[#C97A56]">Introductory rate</span>
          )}
        </div>
      </header>

      {/* Status strip — reflects the real execution state (never contradicts it) */}
      {executionEnabled ? (
        <div className="dash-block flex flex-wrap items-center gap-x-3 gap-y-1 border-[#6FB4A0]/30 bg-[#6FB4A0]/8 p-4 text-sm font-semibold text-[#1F4452]">
          <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} className="text-[#4F9C88]" /> Treasury execution enabled · sandbox</span>
          <span className="text-[13px] font-medium text-[#326273]/65">
            Moves settle against the Splash sandbox ledger · every action is approval-gated · withdrawals follow the notice window. Licensed partners are the system of record for customer funds.
          </span>
        </div>
      ) : (
        <div className="dash-block border-accent/30 bg-accent/10 p-4 text-sm font-semibold text-foreground">
          Projection only — execution disabled pending regulatory approval.
          <span className="mt-1 block text-[13px] font-medium text-foreground/65">
            Licensed partners are the system of record for customer funds; treasury figures stay projected until controls are live.
          </span>
        </div>
      )}

      {/* ── Signature: the Treasury Rail ─────────────────────────────────────
          Two vessels joined by a direction-aware allocation channel. The move
          control lives inside the flow, because allocation IS this page. */}
      <section className="dash-surface dash-reveal overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#326273]/8 px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="dash-kicker">Treasury rail</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-medium text-[#326273]/60">
            <span>Total position <span className="dash-num font-semibold text-[#0c3e48]">${fmtUsd(totalPosition)}</span></span>
            <span className="text-[#4F9C88]">+${fmtUsd(yield30d)} yield accrued</span>
            <span className="hidden sm:inline">{treasuryShare}% allocated to treasury</span>
          </div>
        </div>

        <div className="grid gap-4 p-5 lg:grid-cols-[1fr_250px_1fr] lg:items-stretch">

          {/* Vessel · Operating cash */}
          <div className={cn(
            'dash-block flex flex-col justify-between p-5 transition-shadow',
            !toTreasury && 'tr-vessel-dest-teal',
          )}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/55">Operating cash</span>
              <div className="flex items-center gap-1.5">
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] transition-colors',
                  toTreasury
                    ? 'border border-[#326273]/20 bg-white text-[#326273]/60'
                    : 'bg-[#5C9EAD] text-white shadow-sm',
                )}>
                  {toTreasury ? 'From' : 'To'}
                </span>
                <div className="rounded-lg bg-[#5C9EAD]/10 p-1.5"><Wallet size={14} className="text-[var(--info)]" /></div>
              </div>
            </div>
            <div className="dash-num mt-2 text-3xl font-semibold text-[#0c3e48]">${fmtUsd(available)}</div>
            <div className="mt-1 flex items-center gap-2 text-[13px] font-medium">
              <span className="rounded-full bg-[#326273]/8 px-2 py-0.5 text-[#326273]/70">USD</span>
              <span className="text-[#326273]/55">Instant · funds every payout · 0%</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#326273]/8">
              <div className="h-full rounded-full bg-[#5C9EAD]/70 transition-all" style={{ width: `${100 - treasuryShare}%` }} />
            </div>
          </div>

          {/* Channel · allocation control inside the flow */}
          <form
            onSubmit={handleSubmit}
            className={cn(
              'flex flex-col gap-3 rounded-2xl border p-4 transition-colors',
              toTreasury ? 'border-[#D9A441]/35 bg-[#D9A441]/6' : 'border-[#5C9EAD]/30 bg-[#5C9EAD]/6',
            )}
          >
            <div className="flex rounded-lg bg-white p-1 shadow-sm">
              {([['toTreasury', 'Allocate', ArrowRight], ['toAvailable', 'Withdraw', ArrowLeft]] as const).map(([t, lbl, Icon]) => (
                <button
                  key={t}
                  type="button"
                  disabled={!executionEnabled}
                  aria-pressed={tab === t}
                  onClick={() => { setTab(t); setAmount(''); }}
                  className={cn(
                    'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md py-2 text-[13px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50',
                    tab === t
                      ? (t === 'toTreasury' ? 'bg-[#C99A2E] text-white shadow' : 'bg-[#5C9EAD] text-white shadow')
                      // bg-transparent is load-bearing: the global button
                      // normalizer paints any bg-less flex-1 button teal,
                      // which made BOTH toggle tabs look pressed.
                      : 'bg-transparent text-[#326273]/45 hover:text-[#326273]',
                  )}
                >
                  <Icon size={12} />{lbl}
                </button>
              ))}
            </div>

            {/* Explicit direction — sentence order matches the vessels' layout */}
            <div className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-semibold',
              toTreasury ? 'bg-[#D9A441]/14 text-[#9a6f15]' : 'bg-[#5C9EAD]/14 text-[#326273]',
            )}>
              <span>Operating cash</span>
              {toTreasury ? <ArrowRight size={12} className="shrink-0" /> : <ArrowLeft size={12} className="shrink-0" />}
              <span>Smart Treasury</span>
            </div>

            {/* Direction-aware flow strip */}
            <div className={cn('tr-flow', !toTreasury && 'tr-flow-reverse')} aria-hidden="true">
              <span className="tr-flow-dot" /><span className="tr-flow-dot" /><span className="tr-flow-dot" />
            </div>

            <div>
              <label className="text-[11px] font-medium uppercase tracking-wide text-[#326273]/50">Amount (USD)</label>
              <div className="mt-1 flex items-center gap-2 rounded-lg border border-[#326273]/15 bg-white px-3 py-2.5 transition-all focus-within:border-[#D9A441] focus-within:ring-2 focus-within:ring-[#D9A441]/15">
                <span className="text-sm font-medium text-[#326273]/50">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  disabled={!executionEnabled}
                  onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d{0,2}$/.test(v)) setAmount(v); }}
                  placeholder="0.00"
                  className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-[#1F4452] placeholder-[#326273]/30 outline-none"
                />
                <button type="button" disabled={!executionEnabled} onClick={() => setAmount(String(Math.floor(sourceBalance)))} className="shrink-0 rounded-md bg-[#326273]/10 px-2 py-0.5 text-[13px] font-semibold text-[#326273]/60 transition-colors hover:bg-[#326273]/20 hover:text-[#326273] disabled:cursor-not-allowed disabled:opacity-40">MAX</button>
              </div>
            </div>

            <div className="space-y-1.5 rounded-lg bg-white/70 p-3 text-[13px]">
              <div className="flex justify-between"><span className="text-[#326273]/55">From {toTreasury ? 'Operating (USD)' : 'Treasury (USDY)'}</span><span className="dash-num font-medium text-[#1F4452]">${fmtUsd(sourceBalance)}</span></div>
              {previewSource !== null && (
                <div className="flex justify-between border-t border-[#326273]/10 pt-1.5"><span className="font-medium text-[#326273]/70">After</span><span className="dash-num font-semibold text-[#1F4452]">${fmtUsd(previewSource)}</span></div>
              )}
              {!toTreasury && (
                <div className="flex items-center gap-1.5 text-[13px] text-[#C97A56]"><Clock size={10} /> Lands in Operating in {windowLabel}</div>
              )}
            </div>

            <button
              type="submit"
              disabled={!executionEnabled || loading || !validAmount}
              className={cn(
                'w-full rounded-lg py-2.5 text-sm font-semibold text-white transition-all disabled:opacity-50',
                toTreasury ? 'bg-[#C99A2E] hover:bg-[#b3881f]' : 'bg-[#5C9EAD] hover:bg-[#4a8a99]',
              )}
            >
              {!executionEnabled ? 'Execution disabled' : loading ? 'Processing…' : toTreasury
                ? <span className="inline-flex items-center gap-1.5">Allocate to Treasury <ArrowRight size={14} /></span>
                : <span className="inline-flex items-center gap-1.5"><ArrowLeft size={14} /> Withdraw to Operating</span>}
            </button>
          </form>

          {/* Vessel · Smart Treasury */}
          <div className={cn(
            'dash-block dash-block-accent flex flex-col justify-between p-5 transition-shadow',
            toTreasury && 'tr-vessel-dest',
          )}>
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#9a6f15]">Smart Treasury</span>
              <div className="flex items-center gap-1.5">
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em] transition-colors',
                  toTreasury
                    ? 'bg-[#C99A2E] text-white shadow-sm'
                    : 'border border-[#326273]/20 bg-white text-[#326273]/60',
                )}>
                  {toTreasury ? 'To' : 'From'}
                </span>
                <div className="rounded-lg bg-[#D9A441]/18 p-1.5"><TrendingUp size={14} className="text-[#C99A2E]" /></div>
              </div>
            </div>
            <div className="dash-num mt-2 text-3xl font-semibold text-[#0c3e48]">${fmtUsd(balance)}</div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] font-medium">
              <span className="rounded-full bg-[#D9A441]/15 px-2 py-0.5 text-[#9a6f15]">Ondo USDY</span>
              <span className="text-[#326273]/55">{rate.label}</span>
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-[13px] font-medium text-[#4F9C88]">
              <Sparkles size={11} /> +${fmtUsd(yield30d)} accrued · ~${dailyYield.toFixed(2)}/day · accrues daily 00:00 UTC
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#326273]/8">
              <div className="h-full rounded-full bg-[#C99A2E]/80 transition-all" style={{ width: `${treasuryShare}%` }} />
            </div>
          </div>
        </div>
      </section>

      {/* Main layout */}
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">

        {/* ── Left ── */}
        <div className="space-y-5">

          {/* Yield chart — one series, one hue */}
          <div className="dash-surface p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-[#1F4452]">USDY daily yield</h2>
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#D9A441]/15 px-1.5 py-0.5 text-[13px] font-semibold text-[#9a6f15]">
                    variable
                  </span>
                </div>
                <p className="mt-0.5 text-[13px] text-[#326273]/50">
                  {focusBar
                    ? <>Hovering <span className="font-medium text-[#1F4452]">{focusBar.label}</span></>
                    : 'Accrues daily via USDY redemption price · floating, not fixed'}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <div className="text-right">
                  <div className="text-lg font-semibold text-[#C99A2E]">
                    +${focusBar ? focusBar.amount.toFixed(3) : dailyYield.toFixed(3)}
                  </div>
                  <div className="text-[13px] text-[#326273]/50">{focusBar ? 'that day' : 'estimated today'}</div>
                </div>
                <div className="inline-flex rounded-md bg-[#F6F0ED] p-0.5">
                  {(['7d', '30d'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => { setChartRange(r); setHoveredBar(null); }}
                      className={cn('rounded px-2.5 py-1 text-[13px] font-semibold transition-colors', chartRange === r ? 'bg-white text-[#1F4452] shadow-sm' : 'text-[#326273]/55 hover:text-[#326273]')}
                    >
                      {r.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Smooth accrual curve — gold area, dashed average, explicit high/low scale */}
            <div
              className="relative mt-4 cursor-crosshair select-none"
              onMouseLeave={() => setHoveredBar(null)}
              onMouseMove={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const frac = (e.clientX - rect.left) / rect.width;
                const plotFrac = (frac * CH.W - CH.PL) / (CH.W - CH.PL - CH.PR);
                const idx = Math.round(plotFrac * (bars.length - 1));
                setHoveredBar(Math.max(0, Math.min(bars.length - 1, idx)));
              }}
            >
              <svg viewBox={`0 0 ${CH.W} ${CH.H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={`Daily USDY yield, ${chartRange}: low $${minBar.toFixed(2)}, high $${maxBar.toFixed(2)}, average $${avgBar.toFixed(2)} per day`}>
                <defs>
                  <linearGradient id="usdyFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#D9A441" stopOpacity="0.34" />
                    <stop offset="100%" stopColor="#D9A441" stopOpacity="0.02" />
                  </linearGradient>
                </defs>

                {/* Scale gridlines: high / low, plus dashed average */}
                <line x1={CH.PL} x2={CH.W - CH.PR} y1={chart.cy(maxBar)} y2={chart.cy(maxBar)} stroke="#326273" strokeOpacity="0.1" vectorEffect="non-scaling-stroke" />
                <line x1={CH.PL} x2={CH.W - CH.PR} y1={chart.cy(minBar)} y2={chart.cy(minBar)} stroke="#326273" strokeOpacity="0.1" vectorEffect="non-scaling-stroke" />
                <line x1={CH.PL} x2={CH.W - CH.PR} y1={chart.cy(avgBar)} y2={chart.cy(avgBar)} stroke="#5C9EAD" strokeOpacity="0.5" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />

                <path d={chart.area} fill="url(#usdyFill)" />
                <path d={chart.line} fill="none" stroke="#C99A2E" strokeWidth="2" vectorEffect="non-scaling-stroke" />

                {/* Best day, always marked */}
                <circle cx={chart.pts[chart.maxIdx][0]} cy={chart.pts[chart.maxIdx][1]} r="3.5" fill="white" stroke="#C99A2E" strokeWidth="2" />

                {/* Hover crosshair + point */}
                {hoveredBar !== null && (
                  <g>
                    <line x1={chart.pts[hoveredBar][0]} x2={chart.pts[hoveredBar][0]} y1={CH.PT} y2={CH.H - CH.PB} stroke="#0c3e48" strokeOpacity="0.25" vectorEffect="non-scaling-stroke" />
                    <circle cx={chart.pts[hoveredBar][0]} cy={chart.pts[hoveredBar][1]} r="4.5" fill="#C99A2E" stroke="white" strokeWidth="2" />
                  </g>
                )}
              </svg>

              {/* Scale labels pinned to their gridlines */}
              <span className="dash-num pointer-events-none absolute right-1 -translate-y-1/2 rounded bg-white/80 px-1 font-mono text-[9px] font-semibold text-[#326273]/55" style={{ top: `${(chart.cy(maxBar) / CH.H) * 100}%` }}>high ${maxBar.toFixed(2)}</span>
              <span className="dash-num pointer-events-none absolute right-1 -translate-y-1/2 rounded bg-white/80 px-1 font-mono text-[9px] font-semibold text-[#326273]/55" style={{ top: `${(chart.cy(minBar) / CH.H) * 100}%` }}>low ${minBar.toFixed(2)}</span>
              <span className="dash-num pointer-events-none absolute left-1 -translate-y-1/2 rounded bg-white/80 px-1 font-mono text-[9px] font-semibold text-[var(--info)]" style={{ top: `${(chart.cy(avgBar) / CH.H) * 100}%` }}>avg ${avgBar.toFixed(2)}</span>

              {/* Tooltip above the hovered point */}
              {focusBar && hoveredBar !== null && (
                <div
                  className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[130%] whitespace-nowrap rounded-lg bg-[#0c3e48] px-2.5 py-1.5 text-[13px] font-medium text-white shadow-xl"
                  style={{
                    left: `${Math.min(86, Math.max(14, (chart.pts[hoveredBar][0] / CH.W) * 100))}%`,
                    top: `${(chart.pts[hoveredBar][1] / CH.H) * 100}%`,
                  }}
                >
                  <div className="text-white/60">{focusBar.label}</div>
                  <div className="font-mono text-[#E0B05A]">+${focusBar.amount.toFixed(3)}</div>
                </div>
              )}
            </div>

            {/* X-axis: every day on 7d, sparse markers on 30d */}
            <div className="mt-1 flex justify-between px-1 text-[13px] text-[#326273]/40">
              {(chartRange === '7d' ? bars : [bars[0], bars[9], bars[19], bars[29]]).map((d) => (
                <span key={d.day} className={cn('transition-colors', focusBar?.day === d.day && 'font-semibold text-[#1F4452]')}>{d.day}</span>
              ))}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-[#D9A441]/20 bg-[#D9A441]/8 p-3">
                <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[#9a6f15]"><Sparkles size={10} /> Daily yield</div>
                <div className="dash-num mt-1 font-mono text-sm font-semibold text-[#9a6f15]">+${dailyYield.toFixed(3)}</div>
              </div>
              <div className="rounded-lg bg-[#F6F0ED] p-3">
                <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[#326273]/55"><CalendarDays size={10} /> Period total</div>
                <div className="dash-num mt-1 font-mono text-sm font-semibold text-[#1F4452]">+${totalRange.toFixed(2)}</div>
              </div>
              <div className="rounded-lg bg-[#F6F0ED] p-3">
                <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[#326273]/55"><TrendingUp size={10} /> Avg / day</div>
                <div className="dash-num mt-1 font-mono text-sm font-semibold text-[#1F4452]">+${avgBar.toFixed(3)}</div>
              </div>
              <div className="rounded-lg bg-[#5C9EAD]/10 p-3">
                <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-[var(--info)]"><PiggyBank size={10} /> Est. annual</div>
                <div className="dash-num mt-1 font-mono text-sm font-semibold text-[#326273]">+${projAnnual.toFixed(2)}</div>
              </div>
            </div>
          </div>

          {/* Loop economics simulator */}
          <section className="dash-surface overflow-hidden">
            <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
              <div className="border-b border-[#326273]/10 p-5 lg:border-b-0 lg:border-r">
                <span className="dash-kicker">Loop economics simulator</span>
                <h2 className="mt-2 text-xl font-semibold text-[#0c3e48]">Sweep vs hold</h2>
                <p className="mt-2 max-w-xl text-[13px] leading-5 text-[#326273]/60">
                  On a $5,000 payment, internal netting removes repeated payout work. The remainder is relocated to the point where funds eventually leave the Splash loop.
                </p>
                <label className="mt-6 block">
                  <span className="flex items-center justify-between text-[13px] font-semibold text-[#326273]">
                    <span>Netting ratio</span>
                    <span className="font-mono text-[#E39774]">{nettingRatio}%</span>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={nettingRatio}
                    onChange={(event) => setNettingRatio(Number(event.target.value))}
                    className="mt-3 h-2 w-full cursor-pointer accent-[#E39774]"
                  />
                  <span className="mt-2 flex justify-between text-[10px] font-semibold uppercase tracking-wide text-[#326273]/35"><span>Full sweep</span><span>Full hold</span></span>
                </label>
              </div>
              <div className="bg-[#F6F0ED]/55 p-5">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-[#5C9EAD]/20 bg-white p-4">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--info)]">Fees deleted</div>
                    <div className="dash-num mt-2 text-2xl font-semibold text-[#0c3e48]">${feesDeleted.toFixed(2)}</div>
                    <p className="mt-1 text-[13px] leading-4 text-[#326273]/55">Avoided while value stays netted inside the operating loop.</p>
                  </div>
                  <div className="rounded-2xl border border-[#E39774]/20 bg-white p-4">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#E39774]">Fees relocated</div>
                    <div className="dash-num mt-2 text-2xl font-semibold text-[#0c3e48]">${feesRelocated.toFixed(2)}</div>
                    <p className="mt-1 text-[13px] leading-4 text-[#326273]/55">Still paid when the remaining value reaches a local cash-out rail.</p>
                  </div>
                </div>
                <div className="mt-4 overflow-hidden rounded-full bg-[#E39774]/25">
                  <div className="h-3 rounded-full bg-[#5C9EAD] transition-all" style={{ width: `${nettingRatio}%` }} />
                </div>
                <div className="mt-3 flex items-start gap-2 rounded-xl bg-white p-3 text-[13px] leading-4 text-[#326273]/60">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--info)]" />
                  Simulation only. Netting reduces repeated payout costs; it does not remove the cost of the final external payout.
                </div>
              </div>
            </div>
          </section>

          {/* Activity */}
          <div className="dash-surface overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#326273]/8 px-4 py-3">
              <h2 className="text-sm font-semibold text-[#1F4452]">Treasury activity</h2>
              <span className="text-[13px] font-medium text-[#326273]/45">USD ↔ USDY · treasury ledger</span>
            </div>
            <div className="divide-y divide-[#326273]/5">
              {history.slice(0, 10).map((tx) => (
                <div key={tx.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[#F6F0ED]/50">
                  <HistIcon type={tx.type} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-[#1F4452]">{tx.desc}</div>
                    <div className="text-[13px] text-[#326273]/45">{tx.date} · {tx.id}</div>
                  </div>
                  <div className="text-right">
                    <div className={cn('dash-num text-sm font-semibold', tx.type === 'withdraw' ? 'text-[var(--info)]' : tx.type === 'yield' ? 'text-[#4F9C88]' : 'text-[#C99A2E]')}>{tx.amount}</div>
                    <div className={cn('text-[13px]', tx.status === 'confirmed' ? 'text-[#4F9C88]' : 'text-[#C99A2E]')}>{tx.status}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* How it works */}
          <div className="dash-surface overflow-hidden">
            <div className="flex items-center justify-between border-b border-[#326273]/8 px-5 py-3">
              <div className="flex items-center gap-2">
                <Sprout size={14} className="text-[#4F9C88]" />
                <h2 className="text-sm font-semibold text-[#1F4452]">How the treasury works</h2>
              </div>
              <span className="rounded-full bg-[#D9A441]/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#9a6f15]">T-bill yield</span>
            </div>
            <div className="relative grid gap-0 sm:grid-cols-4">
              <div className="pointer-events-none absolute left-5 right-5 top-[3.25rem] hidden h-px bg-gradient-to-r from-[#5C9EAD]/0 via-[#D9A441] to-[#E39774]/40 sm:block" />
              {[
                { step: '01', title: 'Prepare recommendation', desc: '0xWal models an allocation from Operating cash. Your business must approve it.', icon: CreditCard, accent: '#5C9EAD', bg: 'bg-[#5C9EAD]/10', tag: 'Human approval' },
                { step: '02', title: 'Ondo USDY (T-bills)', desc: 'USDY is backed by short-dated US Treasuries — real, off-chain yield.', icon: Landmark, accent: '#C99A2E', bg: 'bg-[#D9A441]/15', tag: 'T-bill backed' },
                { step: '03', title: 'Yield accrues', desc: 'USDY redemption price rises daily. Floating net rate — never fixed.', icon: Sprout, accent: '#4F9C88', bg: 'bg-[#6FB4A0]/18', tag: rate.label.replace(' · variable', '') },
                { step: '04', title: 'Withdraw on notice', desc: `Request a withdrawal; USDY converts back to USD and lands in Operating in ${windowLabel}.`, icon: PiggyBank, accent: '#E39774', bg: 'bg-[#E39774]/10', tag: 'Notice required' },
              ].map(({ step, title, desc, icon: Icon, accent, bg, tag }, i, arr) => (
                <div key={step} className={cn('relative px-5 py-4', i < arr.length - 1 && 'border-[#326273]/8 sm:border-r')}>
                  <div className="flex items-center gap-3">
                    <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm ring-2 ring-white', bg)} style={{ color: accent }}>
                      <Icon size={16} />
                    </div>
                    <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-[#326273]/35">{step}</span>
                  </div>
                  <div className="mt-3 text-[13px] font-semibold text-[#1F4452]">{title}</div>
                  <div className="mt-1 text-[13px] leading-[1.125rem] text-[#326273]/65">{desc}</div>
                  <div className="mt-2.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider" style={{ backgroundColor: `${accent}15`, color: accent }}>
                    <CheckCircle2 size={9} />{tag}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3 border-t border-[#326273]/8 bg-gradient-to-r from-[#D9A441]/8 via-[#6FB4A0]/5 to-[#5C9EAD]/5 px-5 py-3 text-[13px]">
              <div className="flex items-center gap-1.5 font-medium text-[#1F4452]"><ShieldCheck size={12} className="text-[#4F9C88]" /> Funds segregated from operating</div>
              <span className="text-[#326273]/30">•</span>
              <div className="flex items-center gap-1.5 text-[#326273]/65"><Lock size={11} className="text-[var(--info)]" /> Daily reconciliation, audit-anchored on Sui</div>
            </div>
          </div>
        </div>

        {/* ── Right ── */}
        <aside className="space-y-4">

          {/* Pending withdrawals — money in flight comes first */}
          {notices.length > 0 && (
            <div className="dash-block p-4">
              <div className="flex items-center gap-2">
                <Clock size={14} className="text-[#C97A56]" />
                <h2 className="text-sm font-semibold text-[#1F4452]">Pending withdrawals</h2>
              </div>
              <div className="mt-3 space-y-2">
                {notices.map((n) => {
                  const confirming = confirmCancelId === n.id;
                  const busy = cancelingId === n.id;
                  return (
                    <div key={n.id} className="rounded-lg bg-[#E39774]/10 px-3 py-2 text-[13px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="dash-num font-semibold text-[#1F4452]">${fmtUsd(n.amount)}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-[#C97A56]">by {new Date(n.availableAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                          {!confirming && (
                            <button
                              type="button"
                              onClick={() => setConfirmCancelId(n.id)}
                              className="rounded-md px-1.5 py-0.5 text-[13px] font-semibold text-[#326273]/50 transition-colors hover:bg-[#326273]/10 hover:text-[#326273]"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                      {confirming && (
                        <div className="mt-2 flex items-center justify-between gap-2 border-t border-[#E39774]/25 pt-2">
                          <span className="text-[13px] text-[#326273]/60">Cancel and return to Treasury?</span>
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => cancelWithdrawal(n.id)}
                              className="rounded-md bg-[#C97A56] px-2 py-1 text-[13px] font-semibold text-white transition-colors hover:bg-[#b65f3f] disabled:opacity-50"
                            >
                              {busy ? 'Cancelling…' : 'Yes, cancel'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmCancelId(null)}
                              className="rounded-md px-2 py-1 text-[13px] font-semibold text-[#326273]/60 transition-colors hover:bg-[#326273]/10 disabled:opacity-50"
                            >
                              Keep
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[13px] leading-4 text-[#326273]/50">Reserved from Treasury now · credited to Operating on the date shown. Cancel any time before it settles.</p>
            </div>
          )}

          {/* Risk & compliance */}
          <div className="dash-block p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck size={15} className="text-[var(--info)]" />
              <h2 className="text-sm font-semibold text-[#1F4452]">Risk &amp; Compliance</h2>
            </div>
            <div className="mt-3 space-y-2">
              {RISK_ITEMS.map((r) => (
                <div key={r.label} className="flex items-start gap-2 rounded-lg bg-[#F6F0ED] px-3 py-2">
                  <r.icon size={13} className="mt-0.5 shrink-0 text-[var(--info)]" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-[#326273]/50">{r.label}</div>
                    <div className="text-[13px] font-medium text-[#1F4452]">{r.value}</div>
                  </div>
                  <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-[#4F9C88]" />
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2.5">
              <AlertCircle size={13} className="mt-0.5 shrink-0 text-amber-600" />
              <p className="text-[13px] leading-4 text-amber-700">
                Yield is variable and not guaranteed. USDY is T-bill backed; rates move with US Treasury yields.
              </p>
            </div>
          </div>

          {/* Links */}
          <div className="space-y-2">
            {[
              { label: 'Ondo USDY overview', icon: Info, href: 'https://ondo.finance/usdy' },
              { label: 'View on Sui Explorer', icon: Landmark, href: 'https://suiscan.xyz/testnet' },
            ].map(({ label, icon: Icon, href }) => (
              <a key={label} href={href} target="_blank" rel="noopener noreferrer" className="flex w-full items-center justify-between rounded-lg border border-[#326273]/10 bg-white px-3 py-2.5 text-[13px] font-medium text-[#326273] transition-colors hover:border-[#5C9EAD]/40 hover:text-[var(--info)]">
                <div className="flex items-center gap-2"><Icon size={13} />{label}</div>
                <ChevronRight size={13} className="text-[#326273]/30" />
              </a>
            ))}
          </div>
        </aside>
      </div>

      {/* W9.4 — where your money sits: partner-of-record path, config-driven */}
      <MoneyPathPanel />
    </div>
  );
}

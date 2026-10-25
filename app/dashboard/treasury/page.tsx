'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Info,
  KeyRound,
  Landmark,
  Loader2,
  PenLine,
  RefreshCw,
  ShieldCheck,
  Sprout,
  TrendingUp,
  Wallet,
  Zap,
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import MoneyPathPanel from '@/components/compliance/MoneyPathPanel';
import LocalTime from '@/components/LocalTime';
import FundReferralPanel from '@/components/treasury/FundReferralPanel';
import { businessWalletFrom } from '@/lib/dashboard/home';
import { FEES_OFF_NOTICE } from '@/lib/fees/copy';
import { buildFeeQuote } from '@/lib/fees/quote';
import { BANK_DESTINATION, destinationKind } from '@/lib/fees/destination';
import { usePublishedFees } from '@/lib/fees/use-published-pricing';
import { formatMinor } from '@/lib/money';
import { suiScanAccountUrlOn } from '@/lib/explorer';
import { formatUsdc, STABLECOIN_NETWORK } from '@/lib/payments/stablecoin-lane';
import { projectValue, usdcValueOfUsdy } from '@/lib/payments/treasury-usdy';

/*
 * Treasury (v2 D9, brief 5.7). USDY sits in the business's own Splash
 * Wallet: the business swaps USDC for it, and redeems it back, from there,
 * and the wallet's owners sign every swap. Splash holds nothing and signs
 * nothing, so nothing here waits on custody.
 *
 * The concept of the earlier page is kept: two vessels (operating cash and
 * treasury) joined by a direction-aware channel that holds the control, a
 * single-series projection, the netting simulator, activity, how it works,
 * and the risk card. What changed is where the money is and what the numbers
 * are: balances are the wallet's, read from Sui; a swap is quoted at the
 * redemption rate and on the Sui market, side by side; and nothing is shown
 * that did not come from the chain, the quote or this business's records.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

type Direction = 'swap' | 'redeem';
type Role = 'OWNER' | 'FINANCE_ADMIN' | 'APPROVER' | 'MAKER' | 'VIEWER' | string;

type Order = {
  id: string;
  intentId: string;
  direction: Direction;
  amountInMinor: string;
  minOutMinor: string;
  quotedOutMinor: string;
  status: 'awaiting_signatures' | 'executed' | 'failed' | 'expired' | 'cancelled';
  sandbox: boolean;
  txDigest: string | null;
  createdAt: string;
};

type Overview = {
  flags: { walletSwaps: boolean; fundReferral: boolean; tokenizedStocks: boolean };
  issuerConfirmed: boolean;
  issuer: string;
  fundManager: string;
  role: Role;
  price: { status: 'LIVE' | 'STALE' | 'UNAVAILABLE'; priceMicros: string | null; asOf: string | null };
  apyPct: number;
  address: string | null;
  balances: { usdcMinor: string; usdyMinor: string } | { error: string } | null;
  orders: Order[] | null;
};

type Quote = {
  direction: Direction;
  allowed: boolean;
  mode: 'SANDBOX' | 'LIVE';
  reasons: string[];
  orderable: boolean;
  inMinor: string;
  outMinor: string | null;
  minOutMinor: string | null;
  atRedemptionMinor: string | null;
  shortfallBps: number | null;
  providers: string[];
  error?: string;
};

type WalletSource = 'loading' | 'address' | 'none' | 'pending' | 'off' | 'no_access' | 'error';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MINOR = /^\d{1,30}$/;
const minor = (s: string | null | undefined): bigint | null => (s && MINOR.test(s) ? BigInt(s) : null);

/** Six-decimal amounts, as a person types them. */
function parseAmountMinor(input: string): bigint | null {
  const m = /^(\d{1,12})(?:\.(\d{0,6}))?$/.exec(input.trim());
  if (!m) return null;
  const value = BigInt(m[1]) * 1_000_000n + BigInt(((m[2] ?? '') + '000000').slice(0, 6));
  return value > 0n ? value : null;
}

function shortfallLabel(bps: number): string {
  if (bps <= 0) return 'no loss against the redemption value';
  const pct = bps / 100;
  return `${pct >= 10 ? pct.toFixed(0) : pct.toFixed(1)}% below the redemption value`;
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

const ORDER_STATUS: Record<Order['status'], { label: string; className: string }> = {
  awaiting_signatures: { label: 'Waiting for signatures', className: 'bg-[var(--gold-tint)] text-[var(--gold-ink)]' },
  executed: { label: 'Done', className: 'bg-[var(--ok-bg)] text-[#1F4452]' },
  failed: { label: 'Failed', className: 'bg-[var(--error-bg)] text-[var(--error)]' },
  expired: { label: 'Expired', className: 'bg-[#326273]/8 text-[#326273]' },
  cancelled: { label: 'Cancelled', className: 'bg-[#326273]/8 text-[#326273]' },
};

const WALLET_NOTE: Record<Exclude<WalletSource, 'address' | 'loading'>, string> = {
  none: 'Your business has no Splash Wallet yet. Set it up in Wallet, then hold USDY in it here.',
  pending: 'Your business wallet is being set up. Its balances appear here once its owners confirm it.',
  off: 'Business wallets are not available on this server, so no balance is shown. Quotes still work.',
  no_access: 'Your membership does not include the business wallet, so its balances are not shown.',
  error: 'The wallet balance could not be read just now.',
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function TreasuryPage() {
  // Nothing is shown as a figure until the chain or the business's records
  // answer: the earlier page rendered a seeded yield series and constant
  // balances as if they were the business's.
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [walletSource, setWalletSource] = useState<WalletSource>('loading');
  const [direction, setDirection] = useState<Direction>('swap');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [toast, setToast] = useState('');
  const [chartRange, setChartRange] = useState<'30d' | '1y'>('30d');
  const [hovered, setHovered] = useState<number | null>(null);
  const [nettingRatio, setNettingRatio] = useState(60);

  const load = useCallback(async () => {
    setOverviewError(null);
    let address: string | null = null;
    try {
      const res = await fetch('/api/wallet/business', { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      const source = businessWalletFrom(res.status, body);
      if (source.kind === 'address') address = source.address;
      setWalletSource(source.kind);
    } catch {
      setWalletSource('error');
    }
    try {
      const res = await fetch(`/api/treasury/wallet${address ? `?address=${encodeURIComponent(address)}` : ''}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        setOverviewError((body as { error?: string } | null)?.error ?? 'Treasury could not be loaded.');
        return;
      }
      setOverview(body as Overview);
    } catch {
      setOverviewError('Treasury could not be loaded.');
    }
  }, []);

  useEffect(() => {
    // The first read happens when the page opens; later reads follow actions.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const balances = overview?.balances && 'usdcMinor' in overview.balances ? overview.balances : null;
  const balanceError = overview?.balances && 'error' in overview.balances ? overview.balances.error : null;
  const usdcMinor = minor(balances?.usdcMinor);
  const usdyMinor = minor(balances?.usdyMinor);
  const priceMicros = minor(overview?.price.priceMicros);
  const usdyValueMinor = usdyMinor !== null && priceMicros !== null ? usdcValueOfUsdy(usdyMinor, priceMicros) : null;
  const totalMinor = usdcMinor !== null && usdyValueMinor !== null ? usdcMinor + usdyValueMinor : null;
  const treasuryShare = totalMinor && totalMinor > 0n && usdyValueMinor !== null ? Number((usdyValueMinor * 100n) / totalMinor) : 0;
  const apy = overview?.apyPct ?? 0;
  const rateLabel = overview ? `Modeled at ${apy}% APY · variable` : 'Rate loading…';
  const toTreasury = direction === 'swap';
  const amountMinor = parseAmountMinor(amount);
  const sourceMinor = toTreasury ? usdcMinor : usdyMinor;
  const overBalance = amountMinor !== null && sourceMinor !== null && amountMinor > sourceMinor;
  const canOrder = overview?.role !== 'VIEWER';

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3600);
  }

  function changeDirection(next: Direction) {
    setDirection(next);
    setAmount('');
    setQuote(null);
    setIntentId(null);
    setSendError(null);
  }

  async function getQuote(e: React.FormEvent) {
    e.preventDefault();
    if (amountMinor === null) return;
    setQuoting(true);
    setSendError(null);
    try {
      const res = await fetch('/api/treasury/wallet/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction, amount: amount.trim() }),
      });
      const body = (await res.json().catch(() => ({ error: 'The quote could not be read.' }))) as Quote;
      setQuote(res.ok ? body : { ...body, error: body.error ?? 'The quote could not be made.' });
      // One intent per quote: a retried or double-clicked send is the same order.
      setIntentId(typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : null);
    } catch {
      setQuote({ error: 'The quote could not be made.' } as Quote);
    } finally {
      setQuoting(false);
    }
  }

  async function sendToSigners() {
    if (!quote?.orderable || !quote.minOutMinor || !intentId) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch('/api/treasury/wallet/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId, direction, amount: amount.trim(), minOutMinor: quote.minOutMinor }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSendError(body.error ?? 'It could not be sent to your signers.');
        return;
      }
      showToast("Sent to your wallet's owners to sign");
      setAmount('');
      setQuote(null);
      setIntentId(null);
      await load();
    } catch {
      setSendError('It could not be sent to your signers. Try again.');
    } finally {
      setSending(false);
    }
  }

  // ── Projection: one series, one hue. From the USDY held, or the amount
  // being swapped in when nothing is held yet. A projection, labelled so.
  const basisMinor = usdyValueMinor && usdyValueMinor > 0n ? usdyValueMinor : toTreasury && amountMinor ? amountMinor : null;
  // Plain computations: the React Compiler memoizes them.
  const projection = basisMinor === null || apy <= 0
    ? null
    : (chartRange === '30d' ? Array.from({ length: 31 }, (_, i) => i) : Array.from({ length: 13 }, (_, i) => Math.round((i * 365) / 12)))
      .map((days, i) => ({
        days,
        label: chartRange === '30d' ? `Day ${days}` : `Month ${i}`,
        valueMinor: projectValue(basisMinor, apy, days),
      }));

  const chart = (() => {
    if (!projection) return null;
    const values = projection.map((p) => Number(p.valueMinor) / 1e6);
    const lo = values[0];
    const hi = values[values.length - 1];
    const span = hi - lo || Math.max(lo * 0.001, 0.01);
    const dMin = lo - span * 0.25;
    const dMax = hi + span * 0.15;
    const cx = (i: number) => CH.PL + (i / (values.length - 1)) * (CH.W - CH.PL - CH.PR);
    const cy = (v: number) => CH.PT + (1 - (v - dMin) / (dMax - dMin)) * (CH.H - CH.PT - CH.PB);
    const pts = values.map((v, i) => [cx(i), cy(v)] as [number, number]);
    const line = smoothPath(pts);
    const area = `${line} L ${cx(values.length - 1).toFixed(1)},${CH.H - CH.PB} L ${cx(0).toFixed(1)},${CH.H - CH.PB} Z`;
    return { pts, line, area, cy, lo, hi };
  })();

  const focus = projection && hovered !== null ? projection[hovered] : null;
  const endValue = projection ? projection[projection.length - 1].valueMinor : null;
  const gain = projection && endValue !== null ? endValue - projection[0].valueMinor : null;

  // The simulation's fee is Splash's fee on a 5,000 USDC payout to a bank,
  // from the schedule in force and whether its fees are on: no flat rate and
  // no fixed fee (A1 §2.8), and none while FeeConfig's fees are off. Nothing
  // is shown until the schedule has loaded.
  const publishedFees = usePublishedFees();
  const simulationPrincipalMicro = 5_000_000_000n;
  const simulationFee = publishedFees
    ? Number(formatMinor(
      buildFeeQuote({ kind: destinationKind(BANK_DESTINATION), principalMinor: simulationPrincipalMicro, state: { feesOn: publishedFees.feesOn, schedule: publishedFees.schedule } }).splashFee.minor,
      6,
    ))
    : null;
  const feesDeleted = simulationFee === null ? null : simulationFee * (nettingRatio / 100);
  const feesRelocated = simulationFee === null || feesDeleted === null ? null : simulationFee - feesDeleted;

  const issuer = overview?.issuer ?? 'the issuer';
  const statusLine = !overview
    ? null
    : !overview.flags.walletSwaps
      ? { tone: 'quiet' as const, title: 'Quotes only on this server', detail: 'Swaps from the wallet are not switched on here, so nothing is sent to your signers. Every quote below is live.' }
      : !overview.issuerConfirmed
        ? { tone: 'quiet' as const, title: 'Preview', detail: `Eligibility with ${issuer} is not confirmed for your business yet, so swaps are prepared in the sandbox only.` }
        : { tone: 'ok' as const, title: "Swaps go to your wallet's owners to sign", detail: 'Splash signs nothing and holds nothing. The wallet threshold your owners set applies to every swap.' };

  const unit = { in: toTreasury ? 'USDC' : 'USDY', out: toTreasury ? 'USDY' : 'USDC' };
  const walletKnown = walletSource === 'address' && balances !== null;
  const disabledReason = !overview
    ? null
    : !overview.flags.walletSwaps
      ? 'Swaps are not switched on on this server.'
      : !canOrder
        ? 'A viewer cannot ask the wallet to swap.'
        : quote && !quote.error && !quote.orderable
          ? 'This quote cannot be sent to your signers.'
          : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">

      {/* Toast */}
      {toast && (
        <div role="status" className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-xl bg-[#0c3e48] px-4 py-3 text-sm font-medium text-white shadow-xl">
          <CheckCircle2 size={15} className="text-[#6FB4A0]" aria-hidden="true" /> {toast}
        </div>
      )}

      {/* Header */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <span className="dash-kicker">Working capital</span>
          <h1 className="dash-title mt-2">Treasury</h1>
          <p className="mt-1 max-w-2xl text-[13px] font-medium text-[#326273]">
            Operating cash stays in USDC. Idle cash can be swapped for USDY in your own Splash Wallet, and redeemed from there.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-[#D9A441]/40 bg-[#D9A441]/12 px-3 py-1.5 text-sm font-semibold text-[#1F4452]">{rateLabel}</span>
          <span className="rounded-full border border-[var(--gold-light)] bg-[var(--gold-tint)] px-3 py-1.5 text-[13px] font-semibold text-[var(--gold-ink)]">Not Shariah-compliant</span>
        </div>
      </header>

      {/* Status strip: what this server will do with a swap */}
      {statusLine && (
        <div className={cn(
          'dash-block flex flex-wrap items-center gap-x-3 gap-y-1 p-4 text-sm font-semibold text-[#1F4452]',
          statusLine.tone === 'ok' ? 'border-[#6FB4A0]/30 bg-[#6FB4A0]/8' : 'border-[#D9A441]/30 bg-[var(--gold-tint)]/60',
        )}>
          <span className="inline-flex items-center gap-1.5">
            {statusLine.tone === 'ok'
              ? <CheckCircle2 size={14} className="text-[var(--ok)]" aria-hidden="true" />
              : <Info size={14} className="text-[var(--gold-ink)]" aria-hidden="true" />}
            {statusLine.title}
          </span>
          <span className="text-[13px] font-medium text-[#326273]">{statusLine.detail}</span>
        </div>
      )}
      {overviewError && (
        <div role="alert" className="dash-block flex flex-wrap items-center gap-3 p-4 text-sm font-medium text-[var(--error)]">
          {overviewError}
          <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-1 font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
            <RefreshCw size={13} aria-hidden="true" /> Try again
          </button>
        </div>
      )}

      {/* ── Signature: the Treasury rail ─────────────────────────────────────
          Two vessels in the business's own wallet, joined by a
          direction-aware channel. The control lives inside the flow, because
          moving between the two IS this page. */}
      <section className="dash-surface dash-reveal overflow-hidden" aria-labelledby="rail-title">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#326273]/8 px-5 py-3">
          <h2 id="rail-title" className="dash-kicker">Treasury rail · your Splash Wallet</h2>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-medium text-[#326273]">
            {totalMinor !== null ? (
              <>
                <span>In the wallet <span className="dash-num font-semibold text-[#0c3e48]">${formatUsdc(totalMinor)}</span></span>
                <span className="hidden sm:inline">{treasuryShare}% in USDY</span>
              </>
            ) : (
              <span>{walletSource === 'loading' ? 'Reading the wallet…' : walletSource === 'address' ? (balanceError ?? 'Reading the wallet…') : WALLET_NOTE[walletSource]}</span>
            )}
          </div>
        </div>

        <div className="grid gap-4 p-5 lg:grid-cols-[1fr_270px_1fr] lg:items-stretch">

          {/* Vessel · Operating cash (USDC) */}
          <div className={cn('dash-block flex flex-col justify-between p-5 transition-shadow', !toTreasury && 'tr-vessel-dest-teal')}>
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[#326273]">Operating cash</span>
              <div className="flex items-center gap-1.5">
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-[12px] font-semibold uppercase tracking-[0.14em] transition-colors',
                  toTreasury ? 'border border-[#326273]/20 bg-white text-[#326273]' : 'bg-[#237284] text-white shadow-sm',
                )}>
                  {toTreasury ? 'From' : 'To'}
                </span>
                <div className="rounded-lg bg-[#5C9EAD]/10 p-1.5"><Wallet size={14} className="text-[var(--info)]" aria-hidden="true" /></div>
              </div>
            </div>
            <div className="dash-num mt-2 text-3xl font-semibold text-[#0c3e48]">{usdcMinor !== null ? `$${formatUsdc(usdcMinor)}` : '—'}</div>
            <div className="mt-1 flex items-center gap-2 text-[13px] font-medium">
              <span className="rounded-full bg-[#326273]/8 px-2 py-0.5 text-[#326273]">USDC</span>
              <span className="text-[#326273]">Funds every payout · no yield</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#326273]/8">
              <div className="h-full rounded-full bg-[#5C9EAD]/70 transition-all" style={{ width: `${walletKnown ? 100 - treasuryShare : 0}%` }} />
            </div>
          </div>

          {/* Channel · the quote and the hand-off to the signers */}
          <form
            onSubmit={getQuote}
            className={cn(
              'flex flex-col gap-3 rounded-2xl border p-4 transition-colors',
              toTreasury ? 'border-[#D9A441]/35 bg-[#D9A441]/6' : 'border-[#5C9EAD]/30 bg-[#5C9EAD]/6',
            )}
          >
            <div className="flex rounded-lg bg-white p-1 shadow-sm" role="group" aria-label="Direction">
              {([['swap', 'Swap in', ArrowRight], ['redeem', 'Redeem', ArrowLeft]] as const).map(([d, lbl, Icon]) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={direction === d}
                  onClick={() => changeDirection(d)}
                  className={cn(
                    'inline-flex min-h-10 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] font-semibold transition-all',
                    direction === d
                      ? (d === 'swap' ? 'bg-[#C99A2E] text-[#073d49] shadow' : 'bg-[#237284] text-white shadow')
                      // bg-transparent is load-bearing: the global button
                      // normalizer paints any bg-less flex-1 button teal.
                      : 'bg-transparent text-[#326273] hover:text-[#0c3e48]',
                  )}
                >
                  <Icon size={12} aria-hidden="true" />{lbl}
                </button>
              ))}
            </div>

            {/* Explicit direction: sentence order matches the vessels' layout */}
            <div className={cn(
              'flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px] font-semibold',
              toTreasury ? 'bg-[#D9A441]/14 text-[#1F4452]' : 'bg-[#5C9EAD]/14 text-[#1F4452]',
            )}>
              <span>USDC</span>
              {toTreasury ? <ArrowRight size={12} className="shrink-0" aria-label="to" /> : <ArrowLeft size={12} className="shrink-0" aria-label="from" />}
              <span>USDY</span>
            </div>

            <div className={cn('tr-flow', !toTreasury && 'tr-flow-reverse')} aria-hidden="true">
              <span className="tr-flow-dot" /><span className="tr-flow-dot" /><span className="tr-flow-dot" />
            </div>

            <div>
              <label htmlFor="treasury-amount" className="text-[12px] font-semibold uppercase tracking-wide text-[#326273]">Amount ({unit.in})</label>
              <div className="mt-1 flex items-center gap-2 rounded-lg border border-[#326273]/20 bg-white px-3 py-2.5 transition-all focus-within:border-[#C99A2E] focus-within:ring-2 focus-within:ring-[#D9A441]/25">
                <input
                  id="treasury-amount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '' || /^\d{0,12}(\.\d{0,6})?$/.test(v)) {
                      setAmount(v);
                      setQuote(null);
                      setIntentId(null);
                    }
                  }}
                  placeholder="0.00"
                  aria-describedby="treasury-amount-help"
                  className="min-w-0 flex-1 bg-transparent font-mono text-sm font-semibold text-[#1F4452] placeholder-[#326273]/60 outline-none"
                />
                {sourceMinor !== null && sourceMinor > 0n && (
                  <button
                    type="button"
                    onClick={() => { setAmount(formatMinor(sourceMinor, 6)); setQuote(null); setIntentId(null); }}
                    className="shrink-0 rounded-md bg-[#326273]/10 px-2 py-1 text-[13px] font-semibold text-[#326273] transition-colors hover:bg-[#326273]/20"
                  >
                    Max
                  </button>
                )}
              </div>
              <p id="treasury-amount-help" className={cn('mt-1 text-[12px]', overBalance ? 'font-semibold text-[var(--error)]' : 'text-[#326273]')}>
                {overBalance
                  ? `More than the ${unit.in} in the wallet.`
                  : sourceMinor !== null
                    ? `${formatUsdc(sourceMinor)} ${unit.in} in the wallet`
                    : 'Quote any amount; balances show once the wallet is read.'}
              </p>
            </div>

            <button
              type="submit"
              disabled={quoting || amountMinor === null}
              className="dash-btn-ghost inline-flex min-h-11 w-full items-center justify-center gap-1.5 !py-2 !text-[13px] disabled:opacity-50"
            >
              {quoting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Get quote
            </button>

            {quote && (
              <div className="space-y-1.5 rounded-lg bg-white/80 p-3 text-[13px] text-[#1F4452]" aria-live="polite">
                {quote.error ? (
                  <p role="alert" className="font-medium text-[var(--error)]">{quote.error}</p>
                ) : (
                  <>
                    {quote.atRedemptionMinor && (
                      <div className="flex justify-between gap-3"><span className="text-[#326273]">At the redemption rate</span><span className="dash-num font-mono">{formatUsdc(BigInt(quote.atRedemptionMinor))} {unit.out}</span></div>
                    )}
                    {quote.outMinor && (
                      <div className={cn('rounded-md border px-2 py-1.5', quote.orderable ? 'border-[#326273]/12' : 'border-[var(--warn)] bg-[var(--warn-bg)]')}>
                        <div className="flex justify-between gap-3 font-semibold"><span>On Sui right now</span><span className="dash-num font-mono">{formatUsdc(BigInt(quote.outMinor))} {unit.out}</span></div>
                        {quote.shortfallBps !== null && <p className="mt-0.5 text-[12px] text-[#326273]">{shortfallLabel(quote.shortfallBps)}</p>}
                      </div>
                    )}
                    {quote.minOutMinor && quote.orderable && (
                      <div className="flex justify-between gap-3 border-t border-[#326273]/10 pt-1.5"><span className="font-medium text-[#326273]">At least</span><span className="dash-num font-mono font-semibold">{formatUsdc(BigInt(quote.minOutMinor))} {unit.out}</span></div>
                    )}
                    {quote.reasons.map((r) => <p key={r} className="text-[12px] leading-5 text-[var(--warn-ink)]">{r}</p>)}
                    <p className="text-[12px] text-[#326273]">No Splash fee on a swap. The route&rsquo;s cost is in the market figure above.</p>
                  </>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => void sendToSigners()}
              disabled={sending || !quote?.orderable || disabledReason !== null || overBalance || !intentId}
              className={cn(
                'inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-semibold transition-all disabled:opacity-50',
                // Gold takes ink words; the teal is deep enough for white.
                toTreasury ? 'bg-[#C99A2E] text-[#073d49] hover:bg-[#C99A2E]/85' : 'bg-[#237284] text-white hover:bg-[#145d6a]',
              )}
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <PenLine size={14} aria-hidden="true" />}
              Send to owners to sign
            </button>
            {(disabledReason || sendError) && (
              <p role={sendError ? 'alert' : undefined} className={cn('text-[12px] leading-5', sendError ? 'font-medium text-[var(--error)]' : 'text-[#326273]')}>
                {sendError ?? disabledReason}
              </p>
            )}
          </form>

          {/* Vessel · Treasury (USDY) */}
          <div className={cn('dash-block dash-block-accent flex flex-col justify-between p-5 transition-shadow', toTreasury && 'tr-vessel-dest')}>
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold uppercase tracking-[0.12em] text-[var(--gold-ink)]">Treasury</span>
              <div className="flex items-center gap-1.5">
                <span className={cn(
                  'rounded-full px-2 py-0.5 text-[12px] font-semibold uppercase tracking-[0.14em] transition-colors',
                  toTreasury ? 'bg-[#C99A2E] text-[#073d49] shadow-sm' : 'border border-[#326273]/20 bg-white text-[#326273]',
                )}>
                  {toTreasury ? 'To' : 'From'}
                </span>
                <div className="rounded-lg bg-[#D9A441]/18 p-1.5"><TrendingUp size={14} className="text-[var(--gold-ink)]" aria-hidden="true" /></div>
              </div>
            </div>
            <div className="dash-num mt-2 text-3xl font-semibold text-[#0c3e48]">{usdyMinor !== null ? formatUsdc(usdyMinor) : '—'}<span className="ml-1.5 text-base font-semibold text-[#326273]">USDY</span></div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] font-medium">
              <span className="rounded-full bg-[#D9A441]/10 px-2 py-0.5 text-[var(--gold-ink)]">US Treasury bills</span>
              <span className="text-[#326273]">
                {usdyValueMinor !== null ? `Worth $${formatUsdc(usdyValueMinor)} at the redemption rate` : rateLabel}
              </span>
            </div>
            <p className="mt-2 text-[12px] leading-5 text-[#326273]">
              {priceMicros !== null
                ? <>USDY price ${formatUsdc(priceMicros)}{overview?.price.asOf ? <>, <LocalTime value={overview.price.asOf} /></> : null}{overview?.price.status === 'STALE' ? ' (stale)' : ''}</>
                : overview ? 'The USDY price is unavailable, so nothing is valued.' : 'Reading the USDY price…'}
            </p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#326273]/8">
              <div className="h-full rounded-full bg-[#C99A2E]/80 transition-all" style={{ width: `${walletKnown ? treasuryShare : 0}%` }} />
            </div>
          </div>
        </div>
      </section>

      {/* Main layout */}
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">

        {/* ── Left ── */}
        <div className="min-w-0 space-y-5">

          {/* Projection: one series, one hue, labelled as a projection */}
          <section className="dash-surface p-5" aria-labelledby="projection-title">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 id="projection-title" className="text-sm font-semibold text-[#1F4452]">Projected value</h2>
                  <span className="rounded-full bg-[#D9A441]/15 px-1.5 py-0.5 text-[12px] font-semibold text-[var(--gold-ink)]">variable</span>
                </div>
                <p className="mt-0.5 text-[13px] text-[#326273]">
                  {focus
                    ? <>At <span className="font-medium text-[#1F4452]">{focus.label}</span></>
                    : usdyValueMinor && usdyValueMinor > 0n
                      ? `The USDY you hold, at the modeled ${apy}% a year. USDY's price moves; this is not a promise.`
                      : `The amount you are swapping in, at the modeled ${apy}% a year. A projection, not a promise.`}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                {projection && (
                  <div className="text-right">
                    <div className="dash-num text-lg font-semibold text-[var(--gold-ink)]">
                      ${formatUsdc(focus ? focus.valueMinor : (endValue as bigint))}
                    </div>
                    <div className="text-[13px] text-[#326273]">{focus ? 'projected' : gain !== null ? `+$${formatUsdc(gain)} over ${chartRange === '30d' ? '30 days' : 'a year'}` : ''}</div>
                  </div>
                )}
                <div className="inline-flex rounded-md bg-[#F6F0ED] p-0.5" role="group" aria-label="Projection range">
                  {(['30d', '1y'] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={chartRange === r}
                      onClick={() => { setChartRange(r); setHovered(null); }}
                      className={cn('min-h-9 rounded px-3 text-[13px] font-semibold transition-colors', chartRange === r ? 'bg-white text-[#1F4452] shadow-sm' : 'bg-transparent text-[#326273] hover:text-[#0c3e48]')}
                    >
                      {r === '30d' ? '30D' : '1Y'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {projection && chart ? (
              <>
                <div
                  className="relative mt-4 cursor-crosshair select-none"
                  onMouseLeave={() => setHovered(null)}
                  onMouseMove={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const frac = (e.clientX - rect.left) / rect.width;
                    const plotFrac = (frac * CH.W - CH.PL) / (CH.W - CH.PL - CH.PR);
                    setHovered(Math.max(0, Math.min(projection.length - 1, Math.round(plotFrac * (projection.length - 1)))));
                  }}
                >
                  <svg viewBox={`0 0 ${CH.W} ${CH.H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={`Projected value over ${chartRange === '30d' ? '30 days' : 'a year'} at ${apy}% a year: from $${chart.lo.toFixed(2)} to $${chart.hi.toFixed(2)}`}>
                    <defs>
                      <linearGradient id="usdyFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#D9A441" stopOpacity="0.34" />
                        <stop offset="100%" stopColor="#D9A441" stopOpacity="0.02" />
                      </linearGradient>
                    </defs>
                    <line x1={CH.PL} x2={CH.W - CH.PR} y1={chart.cy(chart.hi)} y2={chart.cy(chart.hi)} stroke="#326273" strokeOpacity="0.1" vectorEffect="non-scaling-stroke" />
                    <line x1={CH.PL} x2={CH.W - CH.PR} y1={chart.cy(chart.lo)} y2={chart.cy(chart.lo)} stroke="#326273" strokeOpacity="0.1" vectorEffect="non-scaling-stroke" />
                    <path d={chart.area} fill="url(#usdyFill)" />
                    <path d={chart.line} fill="none" stroke="#C99A2E" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                    {hovered !== null && (
                      <g>
                        <line x1={chart.pts[hovered][0]} x2={chart.pts[hovered][0]} y1={CH.PT} y2={CH.H - CH.PB} stroke="#0c3e48" strokeOpacity="0.25" vectorEffect="non-scaling-stroke" />
                        <circle cx={chart.pts[hovered][0]} cy={chart.pts[hovered][1]} r="4.5" fill="#C99A2E" stroke="white" strokeWidth="2" />
                      </g>
                    )}
                  </svg>
                  <span className="dash-num pointer-events-none absolute right-1 -translate-y-1/2 rounded bg-white/85 px-1 font-mono text-[12px] font-semibold text-[#326273]" style={{ top: `${(chart.cy(chart.hi) / CH.H) * 100}%` }}>${chart.hi.toFixed(2)}</span>
                  <span className="dash-num pointer-events-none absolute left-1 -translate-y-1/2 rounded bg-white/85 px-1 font-mono text-[12px] font-semibold text-[#326273]" style={{ top: `${(chart.cy(chart.lo) / CH.H) * 100}%` }}>${chart.lo.toFixed(2)}</span>
                </div>
                <div className="mt-1 flex justify-between px-1 text-[13px] text-[#326273]">
                  <span>Today</span>
                  <span>{chartRange === '30d' ? '15 days' : '6 months'}</span>
                  <span>{chartRange === '30d' ? '30 days' : '1 year'}</span>
                </div>
              </>
            ) : (
              <p className="mt-4 rounded-lg bg-[#F6F0ED] px-4 py-6 text-center text-[13px] text-[#326273]">
                {overview && apy <= 0 ? 'No modeled rate is set, so nothing is projected.' : 'Hold USDY, or enter an amount to swap in, to see a projection.'}
              </p>
            )}
          </section>

          {/* Loop economics simulator */}
          <section className="dash-surface overflow-hidden" aria-labelledby="sim-title">
            <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
              <div className="border-b border-[#326273]/10 p-5 lg:border-b-0 lg:border-r">
                <h2 id="sim-title" className="text-xl font-semibold text-[#0c3e48]">Sweep vs hold</h2>
                <p className="mt-2 max-w-xl text-[13px] leading-5 text-[#326273]">
                  On a $5,000 payment, internal netting removes repeated payout work. The remainder is relocated to the point where funds eventually leave the Splash loop.
                </p>
                <label className="mt-6 block">
                  <span className="flex items-center justify-between text-[13px] font-semibold text-[#326273]">
                    <span>Netting ratio</span>
                    <span className="font-mono text-[var(--gold-ink)]">{nettingRatio}%</span>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={nettingRatio}
                    onChange={(event) => setNettingRatio(Number(event.target.value))}
                    className="mt-3 h-2 w-full cursor-pointer accent-[var(--gold-light)]"
                  />
                  <span className="mt-2 flex justify-between text-[12px] font-semibold uppercase tracking-wide text-[#326273]"><span>Full sweep</span><span>Full hold</span></span>
                </label>
              </div>
              <div className="bg-[#F6F0ED]/55 p-5">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-[#5C9EAD]/20 bg-white p-4">
                    <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[#145d6a]">Fees deleted</div>
                    <div className="dash-num mt-2 text-2xl font-semibold text-[#0c3e48]">{feesDeleted === null ? '—' : `$${feesDeleted.toFixed(2)}`}</div>
                    <p className="mt-1 text-[13px] leading-4 text-[#326273]">Avoided while value stays netted inside the operating loop.</p>
                  </div>
                  <div className="rounded-2xl border border-[var(--gold-light)] bg-white p-4">
                    <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--gold-ink)]">Fees relocated</div>
                    <div className="dash-num mt-2 text-2xl font-semibold text-[#0c3e48]">{feesRelocated === null ? '—' : `$${feesRelocated.toFixed(2)}`}</div>
                    <p className="mt-1 text-[13px] leading-4 text-[#326273]">Still paid when the remaining value reaches a local cash-out rail.</p>
                  </div>
                </div>
                <div className="mt-4 overflow-hidden rounded-full bg-[var(--gold-tint)]">
                  <div className="h-3 rounded-full bg-[#5C9EAD] transition-all" style={{ width: `${nettingRatio}%` }} />
                </div>
                <div className="mt-3 flex items-start gap-2 rounded-xl bg-white p-3 text-[13px] leading-4 text-[#326273]">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--info)]" aria-hidden="true" />
                  Simulation only. Netting reduces repeated payout costs; it does not remove the cost of the final external payout.
                  {publishedFees && !publishedFees.feesOn ? ` ${FEES_OFF_NOTICE}` : null}
                </div>
              </div>
            </div>
          </section>

          {/* Activity: this business's swaps and redemptions */}
          <section className="dash-surface overflow-hidden" aria-labelledby="activity-title">
            <div className="flex items-center justify-between border-b border-[#326273]/8 px-4 py-3">
              <h2 id="activity-title" className="text-sm font-semibold text-[#1F4452]">Treasury activity</h2>
              <span className="text-[13px] font-medium text-[#326273]">USDC ↔ USDY · signed in your wallet</span>
            </div>
            {overview?.orders && overview.orders.length > 0 ? (
              <ul className="divide-y divide-[#326273]/5">
                {overview.orders.slice(0, 10).map((o) => {
                  const swap = o.direction === 'swap';
                  const style = ORDER_STATUS[o.status];
                  return (
                    <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-full', swap ? 'bg-[#D9A441]/15' : 'bg-[#5C9EAD]/10')}>
                        {swap ? <ArrowRight size={14} className="text-[var(--gold-ink)]" aria-hidden="true" /> : <ArrowLeft size={14} className="text-[var(--info)]" aria-hidden="true" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-[#1F4452]">
                          {swap ? 'Swap in' : 'Redeem'} · {formatUsdc(BigInt(o.amountInMinor))} {swap ? 'USDC' : 'USDY'} for at least {formatUsdc(BigInt(o.minOutMinor))} {swap ? 'USDY' : 'USDC'}
                        </div>
                        <div className="text-[13px] text-[#326273]">
                          <LocalTime value={o.createdAt} locale="en-US" options={{ month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }} />
                          {o.sandbox ? ' · sandbox' : ''}
                        </div>
                      </div>
                      <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-semibold', style.className)}>{style.label}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="px-4 py-6 text-[13px] text-[#326273]">
                {overview?.orders === null ? 'Activity needs the database, and this server has none.' : 'No swaps yet. A quote you send to your owners to sign appears here.'}
              </p>
            )}
          </section>

          {/* How it works: a real sequence, so the steps are numbered */}
          <section className="dash-surface overflow-hidden" aria-labelledby="how-title">
            <div className="flex items-center justify-between border-b border-[#326273]/8 px-5 py-3">
              <div className="flex items-center gap-2">
                <Sprout size={14} className="text-[var(--ok)]" aria-hidden="true" />
                <h2 id="how-title" className="text-sm font-semibold text-[#1F4452]">How the treasury works</h2>
              </div>
              <span className="rounded-full bg-[#D9A441]/12 px-2 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--gold-ink)]">In your wallet</span>
            </div>
            <ol className="relative grid gap-0 sm:grid-cols-4">
              <div className="pointer-events-none absolute left-5 right-5 top-[3.25rem] hidden h-px bg-gradient-to-r from-[#5C9EAD]/0 via-[#D9A441] to-[var(--gold-light)]/40 sm:block" aria-hidden="true" />
              {[
                { step: '01', title: 'Quote', desc: 'Splash prices the swap at the redemption rate and on the Sui market, side by side.', icon: Zap, accent: '#145d6a', bg: 'bg-[#5C9EAD]/10' },
                { step: '02', title: 'Owners sign', desc: "The swap goes to your wallet's owners. It runs only at your wallet's threshold.", icon: KeyRound, accent: 'var(--gold-ink)', bg: 'bg-[#D9A441]/15' },
                { step: '03', title: 'USDY in your wallet', desc: 'Backed by short-dated US Treasury bills. Its price moves; the rate is variable.', icon: Landmark, accent: 'var(--ok)', bg: 'bg-[#6FB4A0]/18' },
                { step: '04', title: 'Redeem any time', desc: 'Swap USDY back to USDC on Sui, at the price the market pays then.', icon: ArrowLeft, accent: '#145d6a', bg: 'bg-[#5C9EAD]/10' },
              ].map(({ step, title, desc, icon: Icon, accent, bg }, i, arr) => (
                <li key={step} className={cn('relative px-5 py-4', i < arr.length - 1 && 'border-[#326273]/8 sm:border-r')}>
                  <div className="flex items-center gap-3">
                    <div className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl shadow-sm ring-2 ring-white', bg)} style={{ color: accent }}>
                      <Icon size={16} aria-hidden="true" />
                    </div>
                    <span className="font-mono text-[12px] font-semibold uppercase tracking-widest text-[#326273]">{step}</span>
                  </div>
                  <div className="mt-3 text-[13px] font-semibold text-[#1F4452]">{title}</div>
                  <div className="mt-1 text-[13px] leading-[1.125rem] text-[#326273]">{desc}</div>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[#326273]/8 bg-gradient-to-r from-[#D9A441]/8 via-[#6FB4A0]/5 to-[#5C9EAD]/5 px-5 py-3 text-[13px]">
              <span className="inline-flex items-center gap-1.5 font-medium text-[#1F4452]"><ShieldCheck size={12} className="text-[var(--ok)]" aria-hidden="true" /> Splash holds no key to your wallet</span>
              <span className="text-[#326273]">No Splash fee on a swap</span>
            </div>
          </section>

          {/* The fund manager: behind its flag until legal signs off the wording */}
          {overview && overview.flags.fundReferral && (
            <FundReferralPanel label={overview.fundManager} canAnswer={overview.role === 'OWNER'} />
          )}

          {/* Tokenized stocks: a later phase, hidden unless switched on */}
          {overview && overview.flags.tokenizedStocks && (
            <section className="dash-surface p-5" aria-labelledby="stocks-title">
              <h2 id="stocks-title" className="text-sm font-semibold text-[#1F4452]">Tokenized stocks and ETFs</h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-5 text-[#326273]">
                Held in a multisig of your own on Solana, with the same signers as your Splash Wallet. USDC moves there through Circle&rsquo;s CCTP, and back the same way.
              </p>
              <Link href="/dashboard/customer-service" className="mt-3 inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
                Ask about access <ChevronRight size={13} aria-hidden="true" />
              </Link>
            </section>
          )}
        </div>

        {/* ── Right ── */}
        <aside className="space-y-4">

          {/* Risk */}
          <section className="dash-block p-4" aria-labelledby="risk-title">
            <div className="flex items-center gap-2">
              <ShieldCheck size={15} className="text-[var(--info)]" aria-hidden="true" />
              <h2 id="risk-title" className="text-sm font-semibold text-[#1F4452]">What you are holding</h2>
            </div>
            <dl className="mt-3 space-y-2">
              {[
                { label: 'Instrument', value: `USDY, issued by ${issuer}, backed by US Treasury bills`, icon: Landmark },
                { label: 'Where it sits', value: 'Your own Splash Wallet. Splash has no key to it.', icon: Wallet },
                { label: 'Shariah', value: 'Not Shariah-compliant: its return is interest from Treasury bills.', icon: AlertCircle },
                { label: 'Liquidity', value: 'USDC ↔ USDY on Sui. Thin at size: every quote shows the market.', icon: Zap },
              ].map((r) => (
                <div key={r.label} className="flex items-start gap-2 rounded-lg bg-[#F6F0ED] px-3 py-2">
                  <r.icon size={13} className="mt-0.5 shrink-0 text-[var(--info)]" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <dt className="text-[13px] text-[#326273]">{r.label}</dt>
                    <dd className="text-[13px] font-medium text-[#1F4452]">{r.value}</dd>
                  </div>
                </div>
              ))}
            </dl>
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-[var(--warn)]/40 bg-[var(--warn-bg)] px-3 py-2.5">
              <AlertCircle size={13} className="mt-0.5 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" />
              <p className="text-[13px] leading-4 text-[var(--warn-ink)]">
                The rate is variable and not promised: USDY&rsquo;s price moves with US Treasury yields. USDY is not offered to US persons.
              </p>
            </div>
          </section>

          {/* Links */}
          <nav className="space-y-2" aria-label="Treasury links">
            <Link href="/dashboard/wallet" className="flex min-h-11 w-full items-center justify-between rounded-lg border border-[#326273]/12 bg-white px-3 py-2.5 text-[13px] font-medium text-[#326273] transition-colors hover:border-[#5C9EAD]/40 hover:text-[#145d6a]">
              <span className="flex items-center gap-2"><Wallet size={13} aria-hidden="true" />Open Wallet</span>
              <ChevronRight size={13} aria-hidden="true" />
            </Link>
            {overview?.address && (
              <a href={suiScanAccountUrlOn(STABLECOIN_NETWORK, overview.address)} target="_blank" rel="noopener noreferrer" className="flex min-h-11 w-full items-center justify-between rounded-lg border border-[#326273]/12 bg-white px-3 py-2.5 text-[13px] font-medium text-[#326273] transition-colors hover:border-[#5C9EAD]/40 hover:text-[#145d6a]">
                <span className="flex items-center gap-2"><Landmark size={13} aria-hidden="true" />The wallet on Sui Explorer</span>
                <ChevronRight size={13} aria-hidden="true" />
              </a>
            )}
          </nav>
        </aside>
      </div>

      {/* W9.4: where your money sits, partner-of-record path, config-driven */}
      <MoneyPathPanel />
    </div>
  );
}

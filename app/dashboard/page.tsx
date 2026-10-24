'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CircleCheck,
  Layers,
  RefreshCw,
  Send,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';

import LocalTime from '@/components/LocalTime';
import StatusBadge, { type Status } from '@/components/StatusBadge';
import DashPageHeader from '@/components/dashboard/DashPageHeader';
import {
  approvalNote,
  businessWalletFrom,
  formatUsdcMinor,
  ownRequestsNote,
  type HomePaymentRow,
  type HomeSummary,
  type PaymentStatus,
} from '@/lib/dashboard/home';
import { cn } from '@/lib/utils';

/*
 * Home (v2 brief 5.2): the first screen after sign-in, laid out as the board
 * (docs/design/v2-previews/boards/Main.dc.html): Splash Wallet, Needs
 * approval and Sent this month over Recent payments, with quick actions.
 *
 * Every figure is read. The settlement-engine container, the roadmap cards,
 * the corridor table of model volumes and test success, "Settlement SLA
 * 400ms", the sine-wave FX ticker, a hard-coded "Batch TOTP authorization ·
 * 12 transfers" and the treasury projection were all deleted: none of them
 * came from this business's records. A figure that cannot be read says so.
 */

/** KYB lifecycle, in the words a customer needs rather than the enum. */
const KYB_COPY: Record<string, { value: string; status: Status }> = {
  REGISTERED: { value: 'Not started. Finish business verification to send money.', status: 'pending' },
  KYB_SUBMITTED: { value: 'Submitted. We are reviewing your business.', status: 'pending' },
  KYB_PROVIDER_APPROVED: { value: 'Checks passed. Waiting for Splash sign-off.', status: 'pending' },
  ACTIVE: { value: 'Approved. Your business is verified.', status: 'verified' },
  REJECTED: { value: 'Not approved. Contact compliance.', status: 'failed' },
  SUSPENDED: { value: 'Suspended. Contact compliance.', status: 'failed' },
};

/**
 * The Splash Wallet card. Only `unavailable` (a failed read) offers Try
 * again: no wallet yet, one being set up, wallets switched off on this
 * server and no access each stay true until something else changes, and a
 * retry would only show the same thing.
 */
type WalletState =
  | { kind: 'loading' }
  | { kind: 'business'; usdcMinor: string }
  | { kind: 'none' | 'pending' | 'off'; passkeyUsdcMinor: string | null }
  | { kind: 'no_access' }
  | { kind: 'unavailable' };

function minorFrom(body: unknown): string | null {
  const value = (body as { usdcMinor?: unknown } | null)?.usdcMinor;
  if (typeof value === 'string' && /^\d+$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/**
 * The Splash Wallet balance, from the chain. The business wallet is the
 * Phase 2 API's (GET /api/wallet/business); until there is one, the person's
 * own passkey wallet is shown as theirs, never as the business's.
 */
async function readWallet(): Promise<WalletState> {
  let kind: 'none' | 'pending' | 'off';
  try {
    const res = await fetch('/api/wallet/business', { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    const source = businessWalletFrom(res.status, body);
    if (source.kind === 'error') return { kind: 'unavailable' };
    if (source.kind === 'no_access') return { kind: 'no_access' };
    if (source.kind === 'address') {
      const balance = await fetch(`/api/stablecoin/wallet?address=${encodeURIComponent(source.address)}`, { cache: 'no-store' });
      const minor = balance.ok ? minorFrom(await balance.json().catch(() => null)) : null;
      return minor === null ? { kind: 'unavailable' } : { kind: 'business', usdcMinor: minor };
    }
    kind = source.kind;
  } catch {
    return { kind: 'unavailable' };
  }
  let passkeyUsdcMinor: string | null = null;
  try {
    const own = await fetch('/api/stablecoin/wallet', { cache: 'no-store' });
    if (own.ok) passkeyUsdcMinor = minorFrom(await own.json().catch(() => null));
  } catch {
    /* the business figure is what matters here; the passkey line just stays off */
  }
  return { kind, passkeyUsdcMinor };
}

const STATUS_STYLE: Record<PaymentStatus, { label: string; className: string }> = {
  settled: { label: 'Settled', className: 'bg-[var(--ok-bg)] text-[#1F4452]' },
  on_the_way: { label: 'On the way', className: 'bg-[var(--info-bg)] text-[#1F4452]' },
  failed: { label: 'Failed', className: 'bg-[var(--error-bg)] text-[var(--error)]' },
  expired: { label: 'Expired', className: 'bg-[var(--warn-bg)] text-[var(--warn-ink)]' },
};

function PaymentPill({ status }: { status: PaymentStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold', style.className)}>
      {style.label}
    </span>
  );
}

function FigureSkeleton() {
  return (
    <div aria-hidden="true" className="mt-3 space-y-2">
      <div className="h-7 w-40 rounded-md bg-[#326273]/10 motion-safe:animate-pulse" />
      <div className="h-4 w-28 rounded-md bg-[#326273]/10 motion-safe:animate-pulse" />
    </div>
  );
}

/** A figure card whose summary did not load: said aloud, and retryable. */
function FigureError({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[13px] font-medium text-[#326273]" role="status">
      Couldn&rsquo;t load.
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-11 items-center gap-1 font-semibold text-[#145d6a] underline decoration-1 underline-offset-2"
      >
        <RefreshCw size={13} aria-hidden="true" />
        Try again
      </button>
    </p>
  );
}

function Figure({ value, unit }: { value: string; unit?: string }) {
  return (
    <p className="dash-num mt-2 text-[28px] font-extrabold leading-tight tracking-[-0.02em] text-[#0c3e48]">
      {value}
      {unit ? <span className="ml-1.5 text-[13px] font-semibold tracking-normal text-[#326273]">{unit}</span> : null}
    </p>
  );
}

/** "Your own passkey wallet holds 12.50 USDC." Theirs, never the business's. */
function PasskeyLine({ minor }: { minor: string | null }) {
  if (minor === null) return null;
  return (
    <>
      Your own passkey wallet holds <span className="dash-num font-semibold text-[#1F4452]">{formatUsdcMinor(minor)} USDC</span>.{' '}
    </>
  );
}

function OpenWalletLink() {
  return (
    <Link href="/dashboard/wallet" className="font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
      Open Wallet
    </Link>
  );
}

const QUICK_ACTIONS = [
  { href: '/dashboard/transfer', label: 'Pay someone', help: 'A bank account, a business on Splash or a wallet', icon: Send },
  { href: '/dashboard/batch', label: 'Batch payout', help: 'Pay many suppliers from one sheet', icon: Layers },
  { href: '/dashboard/wallet', label: 'Open Wallet', help: 'Balances and your wallet address', icon: Wallet },
  { href: '/dashboard/zeke', label: 'Ask Zeke', help: 'Draft a payment or find a receipt', icon: Bot },
] as const;

export default function DashboardHome() {
  const [summary, setSummary] = useState<HomeSummary | null>(null);
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [wallet, setWallet] = useState<WalletState>({ kind: 'loading' });
  const [kyb, setKyb] = useState<{ state: string; blocked: boolean } | null>(null);
  const [workspace, setWorkspace] = useState<string | null>(null);
  // The clock the expiry note counts down from. Read when the summary lands,
  // and once a minute after, so "expires in 3 min" does not go stale.
  const [nowMs, setNowMs] = useState<number | null>(null);

  const loadSummary = useCallback(async () => {
    setSummaryFailed(false);
    try {
      const res = await fetch('/api/home', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setSummary((await res.json()) as HomeSummary);
      setNowMs(Date.now());
    } catch {
      setSummaryFailed(true);
    }
  }, []);

  const loadWallet = useCallback(async () => {
    setWallet({ kind: 'loading' });
    setWallet(await readWallet());
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set when it answers
    void loadSummary();
    void loadWallet();
  }, [loadSummary, loadWallet]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 60_000);
    return () => window.clearInterval(id);
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
    void fetch('/api/auth/session', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { organization?: string } | null) => {
        if (active && d?.organization) setWorkspace(d.organization);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const note = summary && nowMs !== null ? approvalNote(summary.needsApproval, nowMs) : null;
  const ownNote = summary ? ownRequestsNote(summary.needsApproval) : null;

  // The soonest approval lapsed while the page was open: fetch the count
  // again rather than keep counting it. Once per summary, so a page clock
  // ahead of the server's cannot loop.
  const refetchedFor = useRef<string | null>(null);
  const stale = Boolean(note?.stale);
  useEffect(() => {
    if (!stale || !summary || refetchedFor.current === summary.generatedAt) return;
    refetchedFor.current = summary.generatedAt;
    void loadSummary();
  }, [stale, summary, loadSummary]);

  const kybCopy = kyb ? KYB_COPY[kyb.state] ?? { value: kyb.state, status: 'pending' as Status } : null;

  return (
    <div className="space-y-5">
      <DashPageHeader
        kicker="Operating desk"
        title="Home"
        description={
          <>
            {workspace ?? 'Your workspace'}
            {summary ? (
              <>
                {' · Updated '}
                <LocalTime value={summary.generatedAt} format="time" locale="en-GB" options={{ hour: '2-digit', minute: '2-digit' }} />
              </>
            ) : null}
          </>
        }
        actions={<StatusBadge status={kyb ? (kyb.blocked ? 'pending' : 'verified') : 'pending'} />}
      />

      {kyb?.blocked && kybCopy ? (
        <div className="dash-surface flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" role="status">
          <div className="flex items-start gap-3">
            <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-[#1F4452]">Business verification</p>
              <p className="text-[13px] text-[#326273]">{kybCopy.value}</p>
            </div>
          </div>
          <Link href="/dashboard/setup" className="dash-btn dash-btn-ghost min-h-11 shrink-0">
            Continue setup
          </Link>
        </div>
      ) : null}

      {/* The three figures */}
      <section aria-label="This business at a glance" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.25fr_1fr_1fr]">
        {/* Splash Wallet */}
        <article className="dash-block dash-block-accent p-4 sm:col-span-2 lg:col-span-1" aria-labelledby="home-wallet" aria-busy={wallet.kind === 'loading'}>
          <div className="flex items-center justify-between gap-2">
            <h2 id="home-wallet" className="dash-kicker">Splash Wallet</h2>
            <Wallet size={16} className="text-[#145d6a]" aria-hidden="true" />
          </div>
          {wallet.kind === 'loading' ? (
            <FigureSkeleton />
          ) : wallet.kind === 'business' ? (
            <>
              <Figure value={formatUsdcMinor(wallet.usdcMinor)} unit="USDC" />
              <p className="mt-1 text-[13px] font-medium text-[#326273]">Held by your business</p>
            </>
          ) : wallet.kind === 'none' ? (
            <>
              <p className="mt-2 text-lg font-bold text-[#0c3e48]">No business wallet yet</p>
              <p className="mt-1 text-[13px] font-medium text-[#326273]">
                <PasskeyLine minor={wallet.passkeyUsdcMinor} />
                <OpenWalletLink />
              </p>
            </>
          ) : wallet.kind === 'pending' ? (
            <>
              <p className="mt-2 text-lg font-bold text-[#0c3e48]">Wallet being set up</p>
              <p className="mt-1 text-[13px] font-medium text-[#326273]">
                Waiting for the owners to sign. <PasskeyLine minor={wallet.passkeyUsdcMinor} />
                <OpenWalletLink />
              </p>
            </>
          ) : wallet.kind === 'off' || wallet.kind === 'no_access' ? (
            <>
              <p className="mt-2 text-lg font-bold text-[#0c3e48]">Business wallet not available</p>
              <p className="mt-1 text-[13px] font-medium text-[#326273]">
                {wallet.kind === 'off' ? (
                  <>
                    Splash hasn&rsquo;t switched business wallets on for this workspace. <PasskeyLine minor={wallet.passkeyUsdcMinor} />
                  </>
                ) : (
                  <>Your membership doesn&rsquo;t cover this business&rsquo;s wallet. Ask an owner. </>
                )}
                <OpenWalletLink />
              </p>
            </>
          ) : (
            <>
              <p className="mt-2 text-lg font-bold text-[#0c3e48]">Balance unavailable</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[13px] font-medium text-[#326273]" role="status">
                We couldn&rsquo;t read it from Sui.
                <button
                  type="button"
                  onClick={() => void loadWallet()}
                  className="inline-flex min-h-11 items-center gap-1 font-semibold text-[#145d6a] underline decoration-1 underline-offset-2"
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  Try again
                </button>
              </p>
            </>
          )}
        </article>

        {/* Needs approval */}
        <article className="dash-block p-4" aria-labelledby="home-approvals" aria-busy={!summary && !summaryFailed}>
          <div className="flex items-center justify-between gap-2">
            <h2 id="home-approvals" className="dash-kicker">Needs approval</h2>
            <CircleCheck size={16} className="text-[#145d6a]" aria-hidden="true" />
          </div>
          {summary ? (
            <>
              <Figure
                value={String(summary.needsApproval.count)}
                unit={summary.needsApproval.count === 1 ? 'payment' : 'payments'}
              />
              {note ? (
                <p className={cn('mt-1 flex items-center gap-1.5 text-[13px] font-medium', note.warn ? 'text-[var(--warn-ink)]' : 'text-[#326273]')}>
                  {note.warn ? <AlertTriangle size={13} aria-hidden="true" /> : null}
                  {note.text}
                </p>
              ) : null}
              {ownNote ? <p className="mt-1 text-[13px] font-medium text-[#326273]">{ownNote}</p> : null}
              {summary.needsApproval.count > 0 || ownNote ? (
                <Link href="/queue" className="mt-2 inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-[#145d6a]">
                  {summary.needsApproval.count > 0 ? 'Review approvals' : 'See your requests'}
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
              ) : null}
            </>
          ) : summaryFailed ? (
            <FigureError onRetry={() => void loadSummary()} />
          ) : (
            <FigureSkeleton />
          )}
        </article>

        {/* Sent this month */}
        <article className="dash-block p-4" aria-labelledby="home-sent" aria-busy={!summary && !summaryFailed}>
          <div className="flex items-center justify-between gap-2">
            <h2 id="home-sent" className="dash-kicker">Sent this month</h2>
            <Send size={16} className="text-[#145d6a]" aria-hidden="true" />
          </div>
          {summary ? (
            <>
              <Figure value={formatUsdcMinor(summary.sentThisMonth.usdcMinor)} unit="USDC" />
              <p className="mt-1 text-[13px] font-medium text-[#326273]">
                {summary.sentThisMonth.payments} settled {summary.sentThisMonth.payments === 1 ? 'payment' : 'payments'} since{' '}
                <LocalTime value={summary.sentThisMonth.since} format="date" locale="en-GB" options={{ day: 'numeric', month: 'short', timeZone: 'UTC' }} /> (UTC)
              </p>
              {summary.sentThisMonth.notCounted > 0 ? (
                <p className="mt-1 text-[12px] font-medium text-[#326273]">
                  {summary.sentThisMonth.notCounted} paid in another stablecoin {summary.sentThisMonth.notCounted === 1 ? 'is' : 'are'} not counted.
                </p>
              ) : null}
              {summary.sentThisMonth.unreadable > 0 ? (
                <p className="mt-1 text-[12px] font-medium text-[#326273]">
                  {summary.sentThisMonth.unreadable} with an amount we couldn&rsquo;t read {summary.sentThisMonth.unreadable === 1 ? 'is' : 'are'} not counted.
                </p>
              ) : null}
            </>
          ) : summaryFailed ? (
            <FigureError onRetry={() => void loadSummary()} />
          ) : (
            <FigureSkeleton />
          )}
        </article>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
        {/* Quick actions: first on a phone, the right column on a desktop. */}
        <nav aria-labelledby="home-actions" className="dash-surface p-4 lg:order-2 lg:self-start">
          <h2 id="home-actions" className="text-sm font-semibold text-[#1F4452]">Quick actions</h2>
          <ul className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-1">
            {QUICK_ACTIONS.map(({ href, label, help, icon: Icon }) => (
              <li key={href}>
                <Link
                  href={href}
                  className="group flex min-h-11 h-full items-start gap-3 rounded-xl border border-[#326273]/12 bg-white/70 p-3 transition-colors hover:border-[#0d6370]/45 hover:bg-white"
                >
                  <span className="rounded-lg bg-[#0d6370]/10 p-1.5 text-[#0d6370]">
                    <Icon size={15} aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-[#1F4452]">{label}</span>
                    <span className="mt-0.5 hidden text-[12px] text-[#326273] sm:block">{help}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {/* Recent payments */}
        <section aria-labelledby="home-recent" className="dash-surface min-w-0 overflow-hidden lg:order-1">
          <div className="flex items-center justify-between gap-2 border-b border-[#326273]/10 px-4 py-3">
            <h2 id="home-recent" className="text-sm font-semibold text-[#1F4452]">Recent payments</h2>
            <Link href="/dashboard/history" className="inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-[#145d6a]">
              View all
              <ArrowRight size={13} aria-hidden="true" />
            </Link>
          </div>

          {summary === null ? (
            <p className="px-4 py-8 text-center text-[13px] font-medium text-[#326273]" role="status">
              {summaryFailed ? (
                <>
                  Couldn&rsquo;t load your payments.{' '}
                  <button type="button" onClick={() => void loadSummary()} className="min-h-11 font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
                    Try again
                  </button>
                </>
              ) : (
                'Loading payments…'
              )}
            </p>
          ) : summary.recent.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-[13px] font-semibold text-[#1F4452]">No payments yet.</p>
              <p className="mt-1 text-[13px] text-[#326273]">Your first payment and its receipt will appear here.</p>
              <Link href="/dashboard/transfer" className="dash-btn mt-4 min-h-11">
                Pay someone
              </Link>
            </div>
          ) : (
            <>
              {/* Phone: one row per payment. */}
              <ul className="divide-y divide-[#326273]/8 sm:hidden">
                {summary.recent.map((row: HomePaymentRow) => (
                  <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-[#1F4452]">{row.recipient}</p>
                      <p className="mt-0.5 text-[12px] text-[#326273]">
                        {row.type} ·{' '}
                        <LocalTime value={row.createdAt} format="date" locale="en-GB" options={{ day: 'numeric', month: 'short' }} />
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="money text-[13px] font-semibold text-[#1F4452]">{row.amount}</p>
                      <div className="mt-1"><PaymentPill status={row.status} /></div>
                    </div>
                  </li>
                ))}
              </ul>

              {/* Tablet and desktop: the board's table. */}
              <div className="hidden overflow-x-auto sm:block">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-[#326273]/10 bg-[#F6F0ED]/60 text-left">
                      <th scope="col" className="px-4 py-2 font-medium text-[#326273]">Recipient</th>
                      <th scope="col" className="px-4 py-2 font-medium text-[#326273]">Type</th>
                      <th scope="col" className="money px-4 py-2 font-medium text-[#326273]">They get</th>
                      <th scope="col" className="px-4 py-2 font-medium text-[#326273]">Status</th>
                      <th scope="col" className="hidden px-4 py-2 text-right font-medium text-[#326273] md:table-cell">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.recent.map((row: HomePaymentRow) => (
                      <tr key={row.id} className="border-b border-[#326273]/6 last:border-b-0">
                        <td className="px-4 py-2.5 font-medium text-[#1F4452]">{row.recipient}</td>
                        <td className="px-4 py-2.5 text-[#326273]">{row.type}</td>
                        <td className="money px-4 py-2.5 font-medium text-[#1F4452]">{row.amount}</td>
                        <td className="px-4 py-2.5"><PaymentPill status={row.status} /></td>
                        <td className="hidden px-4 py-2.5 text-right text-[#326273] md:table-cell">
                          <LocalTime value={row.createdAt} format="date" locale="en-GB" options={{ day: 'numeric', month: 'short' }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

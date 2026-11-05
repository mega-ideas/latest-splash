'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Bot,
  CircleCheck,
  Layers,
  Send,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';

import LocalTime from '@/components/LocalTime';
import StatusBadge, { type Status } from '@/components/StatusBadge';
import DashPageHeader from '@/components/dashboard/DashPageHeader';
import { usePhone } from '@/components/dashboard/Device';
import PhoneHome from '@/components/home/PhoneHome';
import { Figure, FigureError, FigureSkeleton, PaymentPill } from '@/components/home/parts';
import WalletBody from '@/components/home/WalletBody';
import { readWallet, type WalletState } from '@/components/home/wallet-state';
import { waitingForMe } from '@/lib/dashboard/phone';
import {
  approvalNote,
  formatUsdcMinor,
  ownRequestsNote,
  type HomePaymentRow,
  type HomeSummary,
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
  // Wallet requests waiting for this person's passkey: null until read, and when it could not be read.
  const [waiting, setWaiting] = useState<number | null>(null);
  const phone = usePhone();
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
    void fetch('/api/wallet/signing-requests', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { requests?: unknown } | null) => {
        if (active) setWaiting(d ? waitingForMe(d.requests) : null);
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

  // A phone has its own Home (v2 brief 5.10): the same reads, arranged for a thumb.
  if (phone) {
    return (
      <PhoneHome
        workspace={workspace}
        summary={summary}
        summaryFailed={summaryFailed}
        onRetrySummary={() => void loadSummary()}
        wallet={wallet}
        onRetryWallet={() => void loadWallet()}
        waiting={waiting}
        kyb={kyb && kybCopy ? { blocked: kyb.blocked, text: kybCopy.value } : null}
        approvalNote={note ? { text: note.text, warn: note.warn } : null}
        ownNote={ownNote}
      />
    );
  }

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
          <WalletBody wallet={wallet} onRetry={() => void loadWallet()} />
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

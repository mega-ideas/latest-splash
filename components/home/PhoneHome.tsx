'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight, Bot, ChevronRight, Fingerprint, Layers, Send, ShieldCheck, WalletMinimal, type LucideIcon } from 'lucide-react';

import LocalTime from '@/components/LocalTime';
import StatusBadge from '@/components/StatusBadge';
import { useTeamAccess } from '@/components/team/useTeamAccess';
import { walletActions } from '@/lib/team/view';
import { formatUsdcMinor, type HomePaymentRow, type HomeSummary } from '@/lib/dashboard/home';
import { cn } from '@/lib/utils';
import { Figure, FigureError, FigureSkeleton, PaymentPill } from './parts';
import WalletBody from './WalletBody';
import type { WalletState } from './wallet-state';

const ACTIONS: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/dashboard/transfer', label: 'Pay someone', icon: Send },
  { href: '/dashboard/wallet#top-up', label: 'Add funds', icon: WalletMinimal },
  { href: '/dashboard/batch', label: 'Batch payout', icon: Layers },
  { href: '/dashboard/zeke', label: 'Ask Zeke', icon: Bot },
];

export type PhoneHomeProps = {
  workspace: string | null;
  summary: HomeSummary | null;
  summaryFailed: boolean;
  onRetrySummary: () => void;
  wallet: WalletState;
  onRetryWallet: () => void;
  /** Wallet requests waiting for this person's signature; null when they could not be read, so nothing is claimed. */
  waiting: number | null;
  kyb: { blocked: boolean; text: string } | null;
  approvalNote: { text: string; warn: boolean } | null;
  ownNote: string | null;
};

/**
 * Home on a phone (v2 brief 5.10): its own composition, not the desktop's
 * columns stacked. The balance is the first thing, the four things a person
 * does are one row of 44px-plus targets under it, what waits for their
 * passkey comes before anything that is history, and payments are rows.
 * Every figure is the page's own read (the same summary and wallet reads as
 * the desktop); this component only arranges them. The one thing it asks for
 * itself is whether Add funds is offered to this person (an owner grants it).
 */
export default function PhoneHome({ workspace, summary, summaryFailed, onRetrySummary, wallet, onRetryWallet, waiting, kyb, approvalNote, ownNote }: PhoneHomeProps) {
  // Add funds is offered only to someone an owner let use it; until the server has said, it is not shown.
  const access = useTeamAccess();
  const quick = ACTIONS.filter((a) => !a.href.includes('#top-up') || walletActions(access).addFunds);
  return (
    <div className="space-y-4" data-testid="phone-home">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="dash-title text-[28px] leading-tight">Home</h1>
          <p className="mt-0.5 truncate text-[13px] font-medium text-[#326273]">
            {workspace ?? 'Your workspace'}
            {summary ? (
              <>
                {' · Updated '}
                <LocalTime value={summary.generatedAt} format="time" locale="en-GB" options={{ hour: '2-digit', minute: '2-digit' }} />
              </>
            ) : null}
          </p>
        </div>
        <StatusBadge status={kyb ? (kyb.blocked ? 'pending' : 'verified') : 'pending'} />
      </header>

      {kyb?.blocked ? (
        <div className="dash-surface flex items-start gap-3 p-4" role="status">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--warn-ink)]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[#1F4452]">Business verification</p>
            <p className="text-[13px] text-[#326273]">{kyb.text}</p>
            <Link href="/dashboard/setup" className="dash-btn dash-btn-ghost mt-2 min-h-11">Continue setup</Link>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="ph-wallet" aria-busy={wallet.kind === 'loading'} className="dash-block dash-block-accent p-5">
        <h2 id="ph-wallet" className="dash-kicker">Splash Wallet</h2>
        <WalletBody wallet={wallet} onRetry={onRetryWallet} large />
      </section>

      <nav aria-label="Quick actions">
        <ul className={cn('grid gap-2', quick.length === 4 ? 'grid-cols-4' : 'grid-cols-3')}>
          {quick.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className="flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-2xl border border-[#326273]/15 bg-white px-1 py-2 text-center text-[12px] font-semibold leading-tight text-[#1F4452] transition-colors active:bg-[#eef4f5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
              >
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#0d6370]/10 text-[#0d6370]">
                  <Icon size={18} aria-hidden="true" />
                </span>
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {waiting !== null && waiting > 0 ? (
        <Link
          href="/dashboard/approve"
          className="flex min-h-16 items-center gap-3 rounded-2xl border border-[var(--gold-edge)] bg-[var(--gold-tint)] p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
        >
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--gold-light)] text-[#0c3e48]">
            <Fingerprint size={20} aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-extrabold text-[#0c3e48]">Needs your signature</span>
            <span className="block text-[13px] font-medium text-[#1F4452]">
              {waiting} {waiting === 1 ? 'request waits' : 'requests wait'} for your passkey
            </span>
          </span>
          <ChevronRight size={18} className="shrink-0 text-[#0c3e48]" aria-hidden="true" />
        </Link>
      ) : null}

      <section aria-label="This month" className="grid grid-cols-2 gap-3">
        <article className="dash-block p-4" aria-labelledby="ph-approvals" aria-busy={!summary && !summaryFailed}>
          <h2 id="ph-approvals" className="dash-kicker">Needs approval</h2>
          {summary ? (
            <>
              <Figure compact value={String(summary.needsApproval.count)} unit={summary.needsApproval.count === 1 ? 'payment' : 'payments'} />
              {approvalNote ? (
                <p className={cn('mt-1 flex items-start gap-1 text-[13px] font-medium', approvalNote.warn ? 'text-[var(--warn-ink)]' : 'text-[#326273]')}>
                  {approvalNote.warn ? <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> : null}
                  {approvalNote.text}
                </p>
              ) : null}
              {ownNote ? <p className="mt-1 text-[13px] font-medium text-[#326273]">{ownNote}</p> : null}
              {summary.needsApproval.count > 0 || ownNote ? (
                <Link href="/queue" className="mt-1 inline-flex min-h-11 items-center gap-1 text-[13px] font-semibold text-[#145d6a]">
                  {summary.needsApproval.count > 0 ? 'Review' : 'See requests'}
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
              ) : null}
            </>
          ) : summaryFailed ? (
            <FigureError onRetry={onRetrySummary} />
          ) : (
            <FigureSkeleton />
          )}
        </article>

        <article className="dash-block p-4" aria-labelledby="ph-sent" aria-busy={!summary && !summaryFailed}>
          <h2 id="ph-sent" className="dash-kicker">Sent this month</h2>
          {summary ? (
            <>
              <Figure compact value={formatUsdcMinor(summary.sentThisMonth.usdcMinor)} unit="USDC" />
              <p className="mt-1 text-[13px] font-medium text-[#326273]">
                {summary.sentThisMonth.payments} settled {summary.sentThisMonth.payments === 1 ? 'payment' : 'payments'}
              </p>
              {summary.sentThisMonth.notCounted + summary.sentThisMonth.unreadable > 0 ? (
                <p className="mt-1 text-[12px] font-medium text-[#326273]">
                  {summary.sentThisMonth.notCounted + summary.sentThisMonth.unreadable} not counted.
                </p>
              ) : null}
            </>
          ) : summaryFailed ? (
            <FigureError onRetry={onRetrySummary} />
          ) : (
            <FigureSkeleton />
          )}
        </article>
      </section>

      <section aria-labelledby="ph-recent" className="dash-surface overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-[#326273]/10 px-4 py-1">
          <h2 id="ph-recent" className="text-sm font-semibold text-[#1F4452]">Recent payments</h2>
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
                <button type="button" onClick={onRetrySummary} className="min-h-11 font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
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
            <Link href="/dashboard/transfer" className="dash-btn mt-4 min-h-11">Pay someone</Link>
          </div>
        ) : (
          <ul className="divide-y divide-[#326273]/8">
            {summary.recent.map((row: HomePaymentRow) => (
              <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-[#1F4452]">{row.recipient}</p>
                  <p className="mt-0.5 text-[13px] text-[#326273]">
                    {row.type} ·{' '}
                    <LocalTime value={row.createdAt} format="date" locale="en-GB" options={{ day: 'numeric', month: 'short' }} />
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="money text-[14px] font-semibold text-[#1F4452]">{row.amount}</p>
                  <div className="mt-1"><PaymentPill status={row.status} /></div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

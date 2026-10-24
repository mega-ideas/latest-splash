'use client';

import Link from 'next/link';
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  History,
  Home,
  Layers,
  Lock,
  TrendingUp,
  X,
  type LucideIcon,
} from 'lucide-react';

import type { ZekeDeskSnapshot, ZekeRecentState } from '@/lib/agent/zeke-desk';
import { cn } from '@/lib/utils';

/**
 * The Zeke page's cards (boards "Zeke page · start" and "asking to pay"),
 * plus the two Sky asked back: What MemWal stores, and the quick links.
 *
 * Every number on them is the desk snapshot's (lib/agent/zeke-desk.ts). When
 * the snapshot could not be read, a card says what it would show instead of
 * showing 0: "nothing waiting" and "could not look" are different facts.
 */

export const ZEKE_CARD =
  'rounded-[14px] border border-[#326273]/14 bg-[var(--zeke-paper)] shadow-[0_1px_2px_rgba(50,98,115,0.06),0_10px_24px_-16px_rgba(50,98,115,0.26)]';

/** Small mono label, as on the boards. Used once per card, never above a heading. */
const MONO_LABEL = 'font-mono text-[12px] font-bold uppercase tracking-[0.14em]';

// ─── What Zeke can do ───────────────────────────────────────────────────────

const CAN_DO: { label: string; answer: 'Yes' | 'Never' }[] = [
  { label: 'Read balances and history', answer: 'Yes' },
  { label: 'Draft a payment', answer: 'Yes' },
  { label: 'Approve or send money', answer: 'Never' },
];

export function ZekeCanDo() {
  return (
    <section aria-labelledby="zeke-can-do" className={cn(ZEKE_CARD, 'p-5')}>
      <h2 id="zeke-can-do" className="text-[15px] font-bold text-[#0c3e48]">
        What Zeke can do
      </h2>
      <dl className="mt-3 space-y-2.5">
        {CAN_DO.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
            <dt className="font-medium text-[#326273]">{row.label}</dt>
            <dd
              className={cn(
                'inline-flex items-center gap-1 font-bold',
                row.answer === 'Yes' ? 'text-[#0d6370]' : 'text-[var(--error)]',
              )}
            >
              {row.answer === 'Yes' ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <X className="h-3.5 w-3.5" aria-hidden="true" />}
              {row.answer}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

// ─── Approvals ──────────────────────────────────────────────────────────────

function closesSoonLine(ms: number | null): string | null {
  if (ms === null || ms <= 0 || ms >= 60 * 60_000) return null;
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `The soonest closes in ${minutes === 1 ? '1 minute' : `${minutes} minutes`}.`;
}

export function ZekeApprovals({ snapshot }: { snapshot: ZekeDeskSnapshot | null }) {
  const known = Boolean(snapshot?.known);
  const count = known && snapshot ? snapshot.waiting : 0;
  const heading = !known ? 'Your approvals' : count === 0 ? 'Nothing waiting' : `${count} waiting for you`;
  const body = !known
    ? 'Open the queue to see what needs your decision.'
    : count === 0
      ? 'Payments that need your decision appear here, and in the queue.'
      : (closesSoonLine(snapshot?.soonestCloseMs ?? null) ?? 'Each one shows what it pays, from where, and who approves.');

  return (
    <section
      aria-labelledby="zeke-approvals"
      className="rounded-[14px] bg-[#0c3e48] p-5 text-white shadow-[0_12px_28px_-14px_rgba(8,54,64,0.55)]"
    >
      <p className={cn(MONO_LABEL, 'text-[#efc46f]')}>Approvals</p>
      <h2 id="zeke-approvals" className="mt-2 text-[26px] font-extrabold leading-tight tracking-[-0.01em]">
        {heading}
      </h2>
      <p className="mt-2 text-sm font-medium leading-6 text-white/85">{body}</p>
      <Link
        href="/queue"
        className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-[10px] bg-[#efc46f] px-4 text-[15px] font-bold text-[#0c3e48] shadow-[0_3px_0_var(--gold-edge)] transition hover:brightness-105 active:translate-y-px active:shadow-[0_1px_0_var(--gold-edge)] focus-ring"
      >
        Open approvals
      </Link>
    </section>
  );
}

// ─── What MemWal stores (Sky: back from the old copilot room) ───────────────

const STORED = ['Corridor frequency and timing', 'Batch size patterns', 'Rate sensitivity bands', 'What you call this assistant'];
const NEVER_STORED = ['Invoice PDFs or their contents', 'Recipient bank details', 'Account numbers', 'KYB documents'];

export function MemWalStores() {
  return (
    <section aria-labelledby="memwal-stores" className={cn(ZEKE_CARD, 'p-5')}>
      <div className="flex items-center gap-2">
        <Lock className="h-4 w-4 text-[#0d6370]" aria-hidden="true" />
        <h2 id="memwal-stores" className="text-[15px] font-bold text-[#0c3e48]">
          What MemWal stores
        </h2>
      </div>
      <div className="mt-3 grid gap-3">
        <div>
          <h3 className="text-[13px] font-bold text-[#0d6370]">Stored: behaviour only</h3>
          <ul className="mt-1.5 space-y-1">
            {STORED.map((item) => (
              <li key={item} className="flex items-center gap-2 text-[13px] font-medium text-[#326273]">
                <Check className="h-3.5 w-3.5 shrink-0 text-[#0d6370]" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
        <div className="border-t border-[#326273]/12 pt-3">
          <h3 className="text-[13px] font-bold text-[var(--error)]">Never stored</h3>
          <ul className="mt-1.5 space-y-1">
            {NEVER_STORED.map((item) => (
              <li key={item} className="flex items-center gap-2 text-[13px] font-medium text-[#326273]">
                <X className="h-3.5 w-3.5 shrink-0 text-[var(--error)]" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

// ─── Quick links (Sky: back from the old copilot room) ──────────────────────

const QUICK_LINKS: { label: string; href: string; icon: LucideIcon }[] = [
  { label: 'Batch payouts', href: '/dashboard/batch', icon: Layers },
  { label: 'Treasury', href: '/dashboard/treasury', icon: TrendingUp },
  { label: 'History and receipts', href: '/dashboard/history', icon: History },
  { label: 'Home', href: '/dashboard', icon: Home },
];

export function ZekeQuickLinks() {
  return (
    <nav aria-label="Quick links" className="grid gap-2">
      {QUICK_LINKS.map(({ label, href, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className="flex min-h-11 items-center justify-between rounded-[10px] border border-[#326273]/14 bg-white px-3.5 text-[13px] font-bold text-[#326273] transition hover:border-[#0d6370]/50 hover:text-[#0c3e48] focus-ring"
        >
          <span className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-[#0d6370]" aria-hidden="true" />
            {label}
          </span>
          <ChevronRight className="h-4 w-4 text-[#326273]" aria-hidden="true" />
        </Link>
      ))}
    </nav>
  );
}

// ─── Recent with Zeke ───────────────────────────────────────────────────────

const STATE_TONE: Record<ZekeRecentState, string> = {
  waiting: 'text-[var(--gold-ink)]',
  approved: 'text-[var(--gold-ink)]',
  sent: 'text-[#0d6370]',
  rejected: 'text-[#326273]',
  expired: 'text-[#326273]',
  failed: 'text-[var(--error)]',
  draft: 'text-[#326273]',
};

/** Where a row goes: what still needs a person goes to the queue, what went to History. */
function hrefFor(state: ZekeRecentState): string | null {
  if (state === 'waiting' || state === 'approved') return '/queue';
  if (state === 'sent') return '/dashboard/history';
  return null;
}

export function ZekeRecent({
  snapshot,
  state,
}: {
  snapshot: ZekeDeskSnapshot | null;
  state: 'loading' | 'ready' | 'unavailable';
}) {
  const items = snapshot?.known ? snapshot.recent : [];
  return (
    <section aria-labelledby="zeke-recent">
      <h2 id="zeke-recent" className={cn(MONO_LABEL, 'text-[#326273]')}>
        Recent with Zeke
      </h2>
      <div className="mt-2.5 overflow-hidden rounded-xl border border-[#326273]/14 bg-white">
        {state === 'loading' && (
          <div className="space-y-px" aria-hidden="true">
            <div className="h-11 animate-pulse bg-[#f6f0ed]" />
            <div className="h-11 animate-pulse bg-[#f6f0ed]/70" />
          </div>
        )}
        {state === 'unavailable' && (
          <p className="px-4 py-3 text-[13px] font-medium text-[#326273]">
            Recent work could not be read just now. What Zeke prepared is still in the approval queue.
          </p>
        )}
        {state === 'ready' && items.length === 0 && (
          <p className="px-4 py-3 text-[13px] font-medium text-[#326273]">
            Nothing yet. What you ask Zeke to prepare appears here, with where it stands.
          </p>
        )}
        {items.length > 0 && (
          <ul className="divide-y divide-[#326273]/10">
            {items.map((item) => {
              const href = hrefFor(item.state);
              const row = (
                <>
                  <span className="min-w-0 truncate text-sm font-medium text-[#0c3e48]">{item.title}</span>
                  <span className={cn('flex shrink-0 items-center gap-1 text-[12px] font-bold', STATE_TONE[item.state])}>
                    {item.label}
                    {href && <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
                  </span>
                </>
              );
              return (
                <li key={item.id}>
                  {href ? (
                    <Link href={href} className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5 transition hover:bg-[#f6f0ed]/60 focus-ring">
                      {row}
                    </Link>
                  ) : (
                    <div className="flex min-h-11 items-center justify-between gap-3 px-4 py-2.5">{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

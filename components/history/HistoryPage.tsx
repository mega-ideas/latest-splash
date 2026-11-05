'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUpRight, CalendarClock, Download, FileText, Landmark, Layers, RefreshCw, Search, Send } from 'lucide-react';

import DashPageHeader from '@/components/dashboard/DashPageHeader';
import DashStat from '@/components/dashboard/DashStat';
import LocalTime from '@/components/LocalTime';
import RunWindow from '@/components/schedule/RunWindow';
import { call, errorText } from '@/components/transfer/api';
import { QuietButton } from '@/components/transfer/ui';
import { Loading, Note, Pill } from '@/components/wallet/parts';
import { formatUsdc } from '@/lib/fees/copy';
import { buildHistory, failureNote, filterHistory, historyCsv, mergeLists, statTones, summaryOf, type BatchRow, type EarlierRow, type Group, type HistoryEntry, type Lists, type ScheduledRunRow, type TransferRow, type WithdrawalRow } from '@/lib/history-page/entries';

const FILTERS: Array<{ id: Group | 'all'; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'paid', label: 'Paid' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'failed', label: 'Failed' },
  { id: 'not_paid', label: 'Not paid' },
];

const ICONS = { payment: Send, batch: Layers, withdrawal: Landmark, earlier: FileText, scheduled: CalendarClock } as const;
const PAGE = 40;
const REFRESH_MS = 15_000;

/**
 * History (v2 brief 5.9), receipts first: every payment, batch and withdrawal
 * of the signed-in person's business, newest first, each with the receipt to
 * open once there is one. What a row says (Paid, On its way, Waiting for an
 * owner) is worded in lib/history-page/entries.ts; this page only lists. It
 * refreshes only while something is in progress.
 */
export default function HistoryPage() {
  const [lists, setLists] = useState<Lists | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [failed, setFailed] = useState<string>('');
  const [scheduledNote, setScheduledNote] = useState<string>('');
  const [group, setGroup] = useState<Group | 'all'>('all');
  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [refreshing, setRefreshing] = useState(false);
  // What the lists held at the last answer, so a refresh that fails in part keeps the rest.
  const loaded = useRef<Lists | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    const [t, b, w, e, s] = await Promise.all([
      call<{ transfers?: TransferRow[] }>('/api/wallet/transfers'),
      call<{ batches?: BatchRow[] }>('/api/wallet/batches'),
      call<{ withdrawals?: WithdrawalRow[] }>('/api/wallet/withdrawals'),
      call<{ items?: EarlierRow[] }>('/api/transfers?filter=all'),
      call<{ runs?: ScheduledRunRow[] }>('/api/wallet/schedules/runs'),
    ]);
    setRefreshing(false);
    const previous = loaded.current;
    // Each list is folded in on its own: one that failed keeps what it held before and is named, a viewer's 403 is the business's rule.
    const merged = mergeLists(previous, {
      transfers: { ok: t.ok, status: t.status, items: t.body?.transfers ?? [] },
      batches: { ok: b.ok, status: b.status, items: b.body?.batches ?? [] },
      withdrawals: { ok: w.ok, status: w.status, items: w.body?.withdrawals ?? [] },
      earlier: { ok: e.ok, status: e.status, items: e.body?.items ?? [] },
    });
    // Scheduled runs are folded in beside the four lists. One that cannot be read keeps what it held, and a viewer's 403 is the business's rule.
    const scheduled = s.ok ? (s.body?.runs ?? []) : s.status === 403 ? [] : (previous?.scheduled ?? []);
    const withScheduled = merged.lists ? { ...merged.lists, scheduled } : null;
    loaded.current = withScheduled;
    setLists(withScheduled);
    setScheduledNote(s.ok || s.status === 403 || merged.lists === null ? '' : 'Scheduled payments could not be refreshed, so they may be missing or out of date below.');
    // With no list at all the error below says so; a sentence about the last time it loaded would be false.
    setFailed(merged.lists === null ? '' : failureNote(merged.failed, merged.missing));
    setProblem(merged.lists === null ? errorText(t, 'Your history could not be loaded.') : null);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set when the answers arrive
    void load();
  }, [load]);

  const entries = useMemo(() => (lists ? buildHistory(lists) : []), [lists]);
  const summary = useMemo(() => summaryOf(entries, new Date()), [entries]);
  const tones = statTones(summary);
  const visible = useMemo(() => filterHistory(entries, { group, query }), [entries, group, query]);
  const counts = useMemo(() => ({ all: entries.length, paid: entries.filter((e) => e.group === 'paid').length, in_progress: summary.inProgress, failed: summary.failed, not_paid: summary.notPaid }), [entries, summary]);

  // Something can still change by itself (on its way, or a failed withdrawal whose USDC is coming back): ask again every so often, but never from a hidden tab.
  const moving = useMemo(() => entries.some((e) => e.mayChange), [entries]);
  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [moving, load]);

  function exportCsv() {
    const blob = new Blob([historyCsv(entries)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `splash-history-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5">
      <DashPageHeader
        kicker="Receipts"
        title="History"
        description="Every payment, batch and withdrawal, with its receipt. Open one to share it with a supplier or your accountant."
        actions={
          <>
            <QuietButton type="button" onClick={exportCsv} disabled={entries.length === 0} className="!px-3 !text-[13px]">
              <Download className="h-4 w-4" aria-hidden="true" />
              Export CSV
            </QuietButton>
            <QuietButton type="button" onClick={() => void load()} disabled={refreshing} className="!px-3 !text-[13px]">
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
              Refresh
            </QuietButton>
            <Link href="/dashboard/transfer" className="inline-flex h-11 items-center gap-2 rounded-xl bg-[#0d6370] px-4 text-[13px] font-bold text-white hover:bg-[#073d49]">
              <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
              New transfer
            </Link>
          </>
        }
      />

      <div className="dash-reveal-stagger grid grid-cols-2 gap-3 md:grid-cols-5">
        <DashStat label="Sent this month" value={`${formatUsdc(BigInt(summary.sentThisMonthMinor))} USDC`} valueClassName="text-[#326273]" />
        <DashStat label="In progress" value={String(summary.inProgress)} valueClassName={tones.inProgress} />
        <DashStat label="Failed" value={String(summary.failed)} valueClassName={tones.failed} />
        <DashStat label="Not paid" value={String(summary.notPaid)} valueClassName={tones.notPaid} />
        <DashStat label="Receipts and records" value={String(summary.total)} valueClassName="text-[var(--info)]" className="col-span-2 md:col-span-1" />
      </div>

      <div className="dash-surface space-y-3 p-3 sm:p-4">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => {
            const on = group === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setGroup(f.id);
                  setShown(PAGE);
                }}
                className={`inline-flex min-h-11 items-center gap-2 rounded-xl border px-3 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0c3e48] bg-[#0c3e48] text-white' : 'border-[#326273]/20 bg-white text-[#1F4452] hover:border-[#0d6370]/60'}`}
              >
                {f.label}
                <span className={`rounded-full px-1.5 text-[12px] font-bold tabular-nums ${on ? 'bg-white/20 text-white' : 'bg-[#326273]/10 text-[#1F4452]'}`}>{counts[f.id]}</span>
              </button>
            );
          })}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#326273]" aria-hidden="true" />
          <input
            type="search"
            aria-label="Search history by payee, reference or amount"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
            placeholder="Search by payee, reference or amount"
            className="h-11 w-full rounded-xl border border-[#326273]/25 bg-white pl-10 pr-3 text-sm text-[#0c3e48] outline-none placeholder:text-[#326273] focus:border-[#0d6370] focus:ring-2 focus:ring-[#0d6370]/20"
          />
        </div>
      </div>

      {lists?.restricted ? <Note>Only an owner or a staff member can see the business&rsquo;s payments and batches. You can see its withdrawals, but not open their receipts.</Note> : null}
      {/* A live region is read out when its content changes, so it stays on the page and only its sentence comes and goes. */}
      <div role="status" className="empty:mb-0">{failed ? <Note tone="warn">{failed}</Note> : null}</div>
      <div role="status" className="empty:hidden">{scheduledNote ? <Note tone="warn">{scheduledNote}</Note> : null}</div>
      {failed ? <QuietButton type="button" onClick={() => void load()} disabled={refreshing}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton> : null}

      {problem ? (
        <div className="space-y-3">
          <Note tone="error">{problem}</Note>
          <QuietButton type="button" onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton>
        </div>
      ) : !lists ? (
        <Loading label="Reading your history…" />
      ) : visible.length === 0 && entries.length === 0 && failed ? null : visible.length === 0 ? (
        <div className="dash-surface p-10 text-center">
          <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#5C9EAD]/10 text-[var(--info)]"><FileText className="h-5 w-5" aria-hidden="true" /></span>
          <p className="text-sm font-bold text-[#0c3e48]">{entries.length === 0 ? 'Nothing here yet' : 'Nothing matches'}</p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] leading-5 text-[#326273]">
            {entries.length === 0 ? 'Each payment you make leaves a receipt here.' : 'Try another filter or a shorter search.'}
          </p>
          {entries.length === 0 ? (
            <Link href="/dashboard/transfer" className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl bg-[#0d6370] px-5 text-sm font-bold text-white hover:bg-[#073d49]">Make a transfer</Link>
          ) : null}
        </div>
      ) : (
        <>
          <ul className="space-y-3" aria-label="Receipts and records">
            {visible.slice(0, shown).map((entry) => (
              <Row key={entry.key} entry={entry} />
            ))}
          </ul>
          {visible.length > shown ? (
            <div className="text-center">
              <QuietButton type="button" onClick={() => setShown((n) => n + PAGE)}>Show more ({visible.length - shown} left)</QuietButton>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function Row({ entry }: { entry: HistoryEntry }) {
  const Icon = ICONS[entry.kind];
  return (
    <li className="dash-block p-3 sm:p-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#5C9EAD]/10 text-[var(--info)]">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <h3 className="truncate text-sm font-bold text-[#0c3e48]">{entry.title}</h3>
          <p className="mt-0.5 text-[13px] text-[#326273]">{entry.detail}</p>
          <RunWindow startsAt={entry.startsAt} windowOpen={entry.windowOpen} serverNowMs={entry.serverNowMs} className="mt-0.5 text-[13px] font-bold text-[#0c3e48]" />
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-[13px] text-[#326273]">
            <span><LocalTime value={entry.date} /></span>
            {entry.reference ? <span className="font-mono">{entry.reference}</span> : null}
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:w-auto sm:flex-col sm:items-end sm:justify-start">
          <span className="font-mono text-[15px] font-bold tabular-nums text-[#0c3e48]">{entry.amountText}</span>
          <Pill tone={entry.status.tone}>{entry.status.label}</Pill>
        </div>
      </div>
      {entry.explain ? (
        <dl className="mt-3 space-y-2 rounded-xl border-l-4 border-[var(--error)] bg-[var(--error-bg)] p-3 text-[13px] leading-5 text-[var(--ink)]">
          <div>
            <dt className="font-bold">What happened</dt>
            <dd>{entry.explain.why}</dd>
          </div>
          <div>
            <dt className="font-bold">What to do next</dt>
            <dd>{entry.explain.next}</dd>
          </div>
        </dl>
      ) : null}
      <div className="mt-3 border-t border-[#326273]/10 pt-3">
        {entry.href ? (
          <Link href={entry.href} aria-label={`Open the receipt for ${entry.title}`} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-bold text-[#0d6370] hover:underline">
            <FileText className="h-4 w-4" aria-hidden="true" />
            {entry.kind === 'earlier' ? 'Open the record' : 'Open receipt'}
          </Link>
        ) : (
          <p className="text-[13px] text-[#326273]">{entry.noReceipt}</p>
        )}
      </div>
    </li>
  );
}

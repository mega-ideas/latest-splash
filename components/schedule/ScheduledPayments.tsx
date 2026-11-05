'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { CalendarClock, FileText, Pencil, Play, Plus, SkipForward, Square, Trash2 } from 'lucide-react';

import LocalTime from '@/components/LocalTime';
import { call, errorText } from '@/components/transfer/api';
import { PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Loading, Note, Pill } from '@/components/wallet/parts';
import { formatUsdc } from '@/lib/fees/copy';
import { GRACE_DEFAULT_MINUTES, MODE_WORDS, RUN_STATE, dueInWords, runIsOpen } from '@/lib/schedule/rules';
import type { AutomaticStatus, RunView, ScheduleView } from '@/lib/schedule/views';
import AutomaticPanel from './AutomaticPanel';
import RunWindow, { useNow, useSkew, windowIsOpen } from './RunWindow';
import ScheduleForm from './ScheduleForm';

type Loaded = { schedules: ScheduleView[]; automatic: AutomaticStatus | null; you: { role: string; owner: boolean; financeLead: boolean; canSchedule: boolean } };

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;
const REFRESH_MS = 20_000;

/**
 * Scheduled payments (v2 Phase 3), the Scheduled tab of Transfer: batches of
 * payments that fall due once, every week or every month. Each is either “Ask
 * me first” (Splash prepares it and asks your owners to approve) or “Pay
 * automatically within my limits”. Skip, Stop, Edit and Delete take effect at
 * once. What each run is doing is said in plain words, with the reason when it
 * was handed back or did not go through.
 */
export default function ScheduledPayments() {
  const focus = useSearchParams().get('run');
  const [data, setData] = useState<Loaded | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'denied' | 'failed'>('loading');
  const [formFor, setFormFor] = useState<{ open: boolean; editing: ScheduleView | null }>({ open: false, editing: null });
  const [notice, setNotice] = useState<{ tone: 'plain' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [allowanceOpen, setAllowanceOpen] = useState(false);

  const load = useCallback(async () => {
    const answer = await call<Loaded>('/api/wallet/schedules');
    if (answer.status === 401 || answer.status === 403) setState('denied');
    else if (!answer.ok || !answer.body) setState((s) => (s === 'ok' ? s : 'failed'));
    else {
      setData(answer.body);
      setState('ok');
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the tab loads its own data once
    void load();
  }, [load]);

  // Something is waiting, or being paid: ask again every so often, never from a hidden tab.
  const moving = data?.schedules.some((s) => s.runs.some((r) => runIsOpen(r.status))) ?? false;
  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [moving, load]);

  async function act(id: string, action: 'skip' | 'stop' | 'resume', body?: Record<string, unknown>, done?: string) {
    setBusy(`${id}:${action}`);
    setNotice(null);
    const answer = await call(`/api/wallet/schedules/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: body ?? {} });
    setBusy(null);
    if (!answer.ok) setNotice({ tone: 'error', text: errorText(answer, 'That did not change. Nothing was paid or lost; try again.') });
    else setNotice({ tone: 'plain', text: done ?? 'Done. It is in force now.' });
    await load();
  }

  async function remove(id: string) {
    setBusy(`${id}:delete`);
    setNotice(null);
    const answer = await call(`/api/wallet/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    setBusy(null);
    setConfirmDelete(null);
    if (!answer.ok) setNotice({ tone: 'error', text: errorText(answer, 'The schedule was not deleted. Try again.') });
    else setNotice({ tone: 'plain', text: 'Deleted. Nothing more will run, and its history stays in History.' });
    await load();
  }

  const canSchedule = data?.you.canSchedule ?? false;
  const automatic = data?.automatic ?? null;
  const canAutomatic = Boolean(data?.you.owner && automatic?.payer.ready);
  const autoWhy = !data?.you.owner ? 'Only an owner can make a schedule pay automatically.' : !automatic?.payer.ready ? (automatic?.payer.reason ?? 'Automatic payments are not switched on for your business here yet.') : null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <header className="dash-reveal overflow-hidden rounded-2xl bg-[#0c3e48] text-white">
        <div className="flex flex-col gap-4 p-5 md:flex-row md:items-start md:justify-between md:p-6">
          <div className="min-w-0">
            <span className="inline-flex rounded-md border border-white/25 px-2.5 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-white">Scheduled</span>
            <h1 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">Scheduled payments</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-white/85">Set a batch to be paid once, every week or every month. Your owners approve each run, or you let Splash pay it inside limits they signed.</p>
          </div>
          {canSchedule ? (
            <button
              type="button"
              onClick={() => setFormFor({ open: true, editing: null })}
              className="inline-flex h-11 shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-xl bg-[#efc46f] px-5 text-sm font-bold text-[#0c3e48] transition-colors hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              New schedule
            </button>
          ) : null}
        </div>
      </header>

      <div role="status" className="empty:hidden">{notice ? notice.tone === 'error' ? <Note tone="error">{notice.text}</Note> : <Note tone="warn">{notice.text}</Note> : null}</div>

      {state === 'loading' ? (
        <Loading label="Reading your schedules…" />
      ) : state === 'denied' ? (
        <Note tone="error">You do not have a place in a business here yet, so there is nothing scheduled.</Note>
      ) : state === 'failed' || !data ? (
        <div className="space-y-3">
          <Note tone="error">Splash could not load your schedules just now. Nothing was paid or changed. Try again in a moment.</Note>
          <QuietButton type="button" onClick={() => void load()}>Try again</QuietButton>
        </div>
      ) : (
        <>
          {automatic ? <AutomaticPanel status={automatic} schedules={data.schedules} allowanceOpen={allowanceOpen} onAllowanceOpen={setAllowanceOpen} onChanged={() => void load()} /> : null}

          {data.schedules.length === 0 ? (
            <section className="dash-surface p-8 text-center" aria-label="No schedules yet">
              <span className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-[#5C9EAD]/10 text-[var(--info)]"><CalendarClock className="h-5 w-5" aria-hidden="true" /></span>
              <p className="text-base font-bold text-[#0c3e48]">Nothing is scheduled</p>
              <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-[#326273]">Rent, a supplier, a payroll file: set it once. At the due time Splash prepares it and asks your owners to approve, unless you chose to let it pay inside your limits.</p>
              {canSchedule ? (
                <PrimaryButton type="button" onClick={() => setFormFor({ open: true, editing: null })} className="mt-4">
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Schedule a payment
                </PrimaryButton>
              ) : (
                <p className="mt-3 text-[13px] text-[#326273]">An owner or the Finance lead sets up scheduled payments.</p>
              )}
            </section>
          ) : (
            <ul className="space-y-4" aria-label="Schedules">
              {data.schedules.map((s) => (
                <ScheduleCard
                  key={s.id}
                  s={s}
                  focus={focus}
                  busy={busy}
                  confirming={confirmDelete === s.id}
                  onConfirm={(on) => setConfirmDelete(on ? s.id : null)}
                  onEdit={() => setFormFor({ open: true, editing: s })}
                  onSkip={(runId) => act(s.id, 'skip', runId ? { runId } : {}, 'Skipped. Nothing will be paid for that run.')}
                  onStop={() => act(s.id, 'stop', {}, 'Stopped. Nothing more starts until you start it again.')}
                  onResume={() => act(s.id, 'resume', {}, 'Started again from its next time.')}
                  onDelete={() => remove(s.id)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <ScheduleForm
        open={formFor.open}
        editing={formFor.editing}
        canAutomatic={canAutomatic}
        autoWhy={autoWhy}
        graceMinutes={automatic?.graceMinutes ?? GRACE_DEFAULT_MINUTES}
        allowanceActive={automatic?.allowance.state === 'active'}
        onClose={() => setFormFor({ open: false, editing: null })}
        onSaved={(text, saved) => {
          setNotice({ tone: 'plain', text });
          void load();
          // A schedule that now pays automatically needs the owners' allowance: show what Splash will pay before they are asked to sign it.
          if (saved.automatic && automatic && automatic.allowance.state !== 'active' && automatic.payer.ready) setAllowanceOpen(true);
        }}
      />
    </div>
  );
}

function ScheduleCard({
  s,
  focus,
  busy,
  confirming,
  onConfirm,
  onEdit,
  onSkip,
  onStop,
  onResume,
  onDelete,
}: {
  s: ScheduleView;
  focus: string | null;
  busy: string | null;
  confirming: boolean;
  onConfirm: (on: boolean) => void;
  onEdit: () => void;
  onSkip: (runId?: string) => void;
  onStop: () => void;
  onResume: () => void;
  onDelete: () => void;
}) {
  const active = s.status === 'active';
  const openRuns = s.runs.filter((r) => runIsOpen(r.status));
  const pastRuns = s.runs.filter((r) => !runIsOpen(r.status)).slice(0, 4);
  const [now] = useState(() => Date.now());
  const ref = useRef<HTMLLIElement>(null);
  const focused = focus !== null && s.runs.some((r) => r.id === focus);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' });
  }, [focused]);
  return (
    <li ref={ref} className={`dash-surface p-4 sm:p-5 ${focused ? 'ring-2 ring-[#0d6370]' : ''}`} aria-label={s.name}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-extrabold text-[#0c3e48]">{s.name}</h2>
          <p className="mt-0.5 text-sm text-[#326273]">{s.cadenceText}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Pill tone={s.mode === 'auto' ? 'ok' : 'wait'}>{s.mode === 'auto' ? 'Pays automatically' : MODE_WORDS.ask.label}</Pill>
          {s.status !== 'active' ? <Pill tone="bad">{s.status === 'stopped' ? 'Stopped' : 'Finished'}</Pill> : null}
        </div>
      </div>

      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Pays</dt>
          <dd className="mt-0.5 text-sm font-bold tabular-nums text-[#0c3e48]">{s.itemCount} {s.itemCount === 1 ? 'payment' : 'payments'}, {usdc(s.totalMinor)}</dd>
          <dd className="text-[13px] text-[#326273]">{BigInt(s.feeMinor) > 0n ? `Up to ${usdc(s.feeMinor)} in Splash fees` : 'No Splash fee'}</dd>
        </div>
        <div>
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Next run</dt>
          <dd className="mt-0.5 text-sm font-bold text-[#0c3e48]">{active && s.nextDueAt ? <LocalTime value={s.nextDueAt} /> : 'None coming'}</dd>
          <dd className="text-[13px] text-[#326273]">{active && s.nextDueAt ? dueInWords(Date.parse(s.nextDueAt), now) : s.status === 'stopped' ? 'Stopped, so nothing starts' : 'It has run its last time'}</dd>
        </div>
        <div>
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Paid how</dt>
          <dd className="mt-0.5 text-[13px] leading-5 text-[#326273]">{s.mode === 'auto' ? 'With no one present, inside your owners’ allowance. Anything outside it comes to you.' : 'Your owners approve each run with their passkeys. Nothing is paid before.'}</dd>
        </div>
      </dl>

      <details className="mt-3 group">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-[13px] font-bold text-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">Who is paid ({s.itemCount})</summary>
        <ul className="mt-1 divide-y divide-[#326273]/10 rounded-xl border border-[#326273]/12 bg-white">
          {s.items.map((i) => (
            <li key={i.position} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5">
              <span className="min-w-0 text-sm font-semibold text-[#0c3e48]">{i.name}<span className="ml-2 font-mono text-[12px] font-normal text-[#326273]">{i.masked}</span></span>
              <span className="text-sm font-bold tabular-nums text-[#0c3e48]">{usdc(i.amountMinor)}{i.reference ? <span className="ml-2 font-mono text-[12px] font-normal text-[#326273]">{i.reference}</span> : null}</span>
            </li>
          ))}
        </ul>
      </details>

      {openRuns.length > 0 || pastRuns.length > 0 ? (
        <ul className="mt-3 space-y-2" aria-label={`Runs of ${s.name}`}>
          {[...openRuns, ...pastRuns].map((r) => (
            <RunLine key={r.id} run={r} canSkip={s.can.skip} canStop={s.can.stop && active} busy={busy === `${s.id}:skip`} stopping={busy === `${s.id}:stop`} onSkip={() => onSkip(r.id)} onStop={onStop} highlight={focus === r.id} />
          ))}
        </ul>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#326273]/10 pt-4">
        {active && s.can.skip && s.nextDueAt && !openRuns.some((r) => r.dueAt === s.nextDueAt) ? (
          <QuietButton type="button" onClick={() => onSkip()} disabled={busy === `${s.id}:skip`} aria-label={`Skip the next run of ${s.name}`}>
            <SkipForward className="h-4 w-4" aria-hidden="true" />
            Skip the next run
          </QuietButton>
        ) : null}
        {s.can.stop && active ? (
          <QuietButton type="button" onClick={onStop} disabled={busy === `${s.id}:stop`}>
            <Square className="h-4 w-4" aria-hidden="true" />
            Stop schedule
          </QuietButton>
        ) : null}
        {s.can.stop && s.status === 'stopped' ? (
          <QuietButton type="button" onClick={onResume} disabled={busy === `${s.id}:resume`}>
            <Play className="h-4 w-4" aria-hidden="true" />
            Start again
          </QuietButton>
        ) : null}
        {s.can.edit ? (
          <QuietButton type="button" onClick={onEdit}>
            <Pencil className="h-4 w-4" aria-hidden="true" />
            Edit
          </QuietButton>
        ) : null}
        {s.can.delete ? (
          confirming ? (
            <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label={`Delete ${s.name}`}>
              <QuietButton type="button" onClick={onDelete} disabled={busy === `${s.id}:delete`} className="!border-[var(--error)] !text-[var(--error)]">Delete it</QuietButton>
              <QuietButton type="button" onClick={() => onConfirm(false)}>Keep it</QuietButton>
            </span>
          ) : (
            <QuietButton type="button" onClick={() => onConfirm(true)} aria-label={`Delete ${s.name}`}>
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              Delete
            </QuietButton>
          )
        ) : null}
        {!s.can.edit ? <span className="text-[13px] text-[#326273]">Only an owner changes a schedule that pays automatically.</span> : null}
      </div>
    </li>
  );
}

function RunLine({ run, canSkip, canStop, busy, stopping, onSkip, onStop, highlight }: { run: RunView; canSkip: boolean; canStop: boolean; busy: boolean; stopping: boolean; onSkip: () => void; onStop: () => void; highlight: boolean }) {
  const state = RUN_STATE[run.status];
  // While the warning window is open, Skip and Stop sit right on the run: this is where a notice's link lands.
  // By the server's clock, not the device's: a device whose clock runs fast must not take Stop away while the window is open.
  const now = useNow();
  const skew = useSkew(run.serverNowMs);
  const windowOpen = windowIsOpen(run.startsAt, now, skew, run.windowOpen);
  return (
    <li className={`rounded-xl border p-3 ${highlight ? 'border-[#0d6370] bg-white' : 'border-[#326273]/12 bg-[#fffaf6]'}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Pill tone={run.tone}>{run.label}</Pill>
          <span className="text-sm font-semibold text-[#0c3e48]"><LocalTime value={run.dueAt} /></span>
          <span className="text-sm tabular-nums text-[#326273]">{usdc(run.totalMinor)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {run.status === 'waiting_approval' ? (
            <Link href="/dashboard/approve" className="inline-flex min-h-11 items-center text-[13px] font-bold text-[#0d6370] underline underline-offset-2">Review and approve</Link>
          ) : null}
          {run.receiptPath ? (
            <Link href={run.receiptPath} className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-bold text-[#0d6370] hover:underline">
              <FileText className="h-4 w-4" aria-hidden="true" />
              Open receipt
            </Link>
          ) : null}
          {run.canSkip && canSkip ? (
            <QuietButton type="button" onClick={onSkip} disabled={busy} className="!h-11 !px-3 !text-[13px]">
              <SkipForward className="h-4 w-4" aria-hidden="true" />
              Skip this run
            </QuietButton>
          ) : null}
          {windowOpen && canStop ? (
            <QuietButton type="button" onClick={onStop} disabled={stopping} className="!h-11 !px-3 !text-[13px]">
              <Square className="h-4 w-4" aria-hidden="true" />
              Stop schedule
            </QuietButton>
          ) : null}
        </div>
      </div>
      <RunWindow startsAt={run.startsAt} windowOpen={run.windowOpen} serverNowMs={run.serverNowMs} className="mt-1.5 text-[13px] font-bold text-[#0c3e48]" />
      <p className="mt-1.5 text-[13px] leading-5 text-[#326273]">{run.reason?.trim() ? run.reason : windowOpen ? 'It has fallen due. Nothing has been paid yet, and nothing is until the time above.' : state.says}</p>
      {run.payments && run.payments.length > 0 && run.status !== 'paid' ? (
        <ul className="mt-2 space-y-1 text-[13px] text-[#1F4452]">
          {run.payments.map((p) => (
            <li key={p.position}>{p.payeeName}: {p.status === 'paid' ? 'paid' : p.status === 'failed' ? 'not paid' : p.status === 'submitting' ? 'on its way' : 'waiting'}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

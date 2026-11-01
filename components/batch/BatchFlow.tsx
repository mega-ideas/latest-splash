'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, CircleHelp, Wallet } from 'lucide-react';

import { useTeamAccess } from '@/components/team/useTeamAccess';
import { BATCH_MAX_PAYMENTS, type SheetRow } from '@/lib/batch/sheet';
import { walletActions } from '@/lib/team/view';
import { formatUsdc } from '@/lib/fees/copy';
import LocalTime from '../LocalTime';
import { call, errorText, newBatchKey, type BatchReview, type BatchView, type Context, type SigningView, type StepNumber } from './api';
import HowItWorks from './HowItWorks';
import StepApprove, { type MadeBatch } from './StepApprove';
import StepReceipts from './StepReceipts';
import StepReview from './StepReview';
import StepSend from './StepSend';
import StepUpload from './StepUpload';

const STEPS = ['Upload', 'Review rows', 'Approve', 'Send', 'Receipts'] as const;

const STATUS_WORDS: Record<BatchView['status'], string> = {
  prepared: 'Waiting for an owner',
  awaiting_signatures: 'Waiting for signatures',
  on_the_way: 'Being sent',
  settled: 'Paid',
  failed: 'Did not go through',
  expired: 'Expired',
  declined: 'Declined by the owners',
  withdrawn: 'Withdrawn',
};

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;

const renumber = (rows: SheetRow[]): SheetRow[] => rows.map((r, i) => ({ ...r, line: i + 1 }));

/** The five steps of a batch (v2 brief 5.6): upload, review rows, approve, send, receipts. */
export default function BatchFlow() {
  // Add funds is offered only to someone an owner let use it.
  const canAddFunds = walletActions(useTeamAccess()).addFunds;
  const [ctx, setCtx] = useState<Context | null>(null);
  const [ctxState, setCtxState] = useState<'loading' | 'ok' | 'denied' | 'failed'>('loading');
  const [step, setStep] = useState<StepNumber>(1);
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [review, setReview] = useState<BatchReview | null>(null);
  const [stale, setStale] = useState(false);
  const [checking, setChecking] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [readNotes, setReadNotes] = useState<string[]>([]);
  const [confirmed, setConfirmed] = useState({ duplicates: false, newPayees: false });
  // Each review carries a number; only the latest one is believed, and an edit retires every review still running.
  const reviewSeq = useRef(0);
  const [intentKey, setIntentKey] = useState('');
  const [made, setMade] = useState<MadeBatch | null>(null);
  const [batches, setBatches] = useState<BatchView[]>([]);
  const [how, setHow] = useState(false);

  const go = useCallback((next: StepNumber) => {
    setStep(next);
    window.scrollTo({ top: 0 });
  }, []);

  const loadBatches = useCallback(async () => {
    const answer = await call<{ batches?: BatchView[] }>('/api/wallet/batches');
    if (answer.ok && Array.isArray(answer.body?.batches)) setBatches(answer.body.batches);
  }, []);

  useEffect(() => {
    void (async () => {
      const c = await call<Context>('/api/wallet/transfers/context');
      if (c.status === 403 || c.status === 401) setCtxState('denied');
      else if (!c.ok || !c.body) setCtxState('failed');
      else {
        setCtx(c.body);
        setCtxState('ok');
      }
      await loadBatches();
    })();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first intent id is made once, in the browser
    setIntentKey(newBatchKey());
  }, [loadBatches]);

  const runReview = useCallback(async (sheet: SheetRow[]) => {
    reviewSeq.current += 1;
    const seq = reviewSeq.current;
    setChecking(true);
    setReviewError(null);
    setConfirmed({ duplicates: false, newPayees: false });
    const answer = await call<{ review?: BatchReview }>('/api/wallet/batches/review', { body: { rows: sheet.map((r) => ({ recipient: r.recipient, amount: r.amount, reference: r.reference })) } });
    // The rows changed while this was being checked: the answer is for rows that are no longer on the screen.
    if (seq !== reviewSeq.current) return;
    setChecking(false);
    if (answer.ok && answer.body?.review) {
      setReview(answer.body.review);
      setStale(false);
    } else {
      setReview(null);
      setReviewError(errorText(answer, 'The rows could not be checked just now. Nothing was sent.'));
    }
  }, []);

  const takeRows = useCallback(
    (next: SheetRow[], notes: string[] = []) => {
      setReadNotes(notes);
      const numbered = renumber(next);
      setRows(numbered);
      setReview(null);
      setStale(true);
      setMade(null);
      setIntentKey(newBatchKey());
      go(2);
      void runReview(numbered);
    },
    [go, runReview],
  );

  /** Any change to the rows retires the review still running and the confirmations given for the old rows. */
  const changed = () => {
    reviewSeq.current += 1;
    setChecking(false);
    setConfirmed({ duplicates: false, newPayees: false });
    setStale(true);
    setIntentKey(newBatchKey());
  };

  const edit = (index: number, change: Partial<Pick<SheetRow, 'recipient' | 'amount' | 'reference'>>) => {
    changed();
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...change } : r)));
  };
  const remove = (index: number) => {
    changed();
    const next = renumber(rows.filter((_, i) => i !== index));
    setRows(next);
    if (next.length === 0) {
      setReview(null);
      go(1);
    }
  };
  const add = () => {
    if (rows.length >= BATCH_MAX_PAYMENTS) return;
    changed();
    setRows(renumber([...rows, { line: 0, recipient: '', amount: '', reference: '' }]));
  };
  const removeProblems = () => {
    if (!review) return;
    const bad = new Set(review.rows.filter((r) => !r.ok).map((r) => r.line));
    const next = renumber(rows.filter((r) => !bad.has(r.line)));
    changed();
    setRows(next);
    if (next.length === 0) {
      setReview(null);
      go(1);
      return;
    }
    void runReview(next);
  };

  const restart = useCallback(() => {
    reviewSeq.current += 1;
    setChecking(false);
    setConfirmed({ duplicates: false, newPayees: false });
    setRows([]);
    setReadNotes([]);
    setReview(null);
    setStale(false);
    setMade(null);
    setIntentKey(newBatchKey());
    go(1);
    void loadBatches();
  }, [go, loadBatches]);

  const onMade = useCallback(
    (m: MadeBatch) => {
      setMade(m);
      void loadBatches();
      if (m.batch.status === 'on_the_way') setStep(4);
      if (m.batch.status === 'settled') setStep(5);
    },
    [loadBatches],
  );

  const open = useCallback(
    async (b: BatchView) => {
      const answer = await call<{ batch?: BatchView; signingRequest?: SigningView | null }>(`/api/wallet/batches/${encodeURIComponent(b.id)}`);
      if (!answer.ok || !answer.body?.batch) return;
      const batch = answer.body.batch;
      setMade({ batch, signing: answer.body.signingRequest ?? null, approved: null });
      go(batch.status === 'settled' ? 5 : batch.status === 'on_the_way' ? 4 : 3);
    },
    [go],
  );

  const onExecuted = useCallback(() => {
    setMade((m) => (m ? { ...m, batch: { ...m.batch, status: 'settled' } } : m));
    void loadBatches();
    go(5);
  }, [go, loadBatches]);

  const total = useMemo(() => (made ? made.batch.totalMinor : review?.totalMinor ?? '0'), [made, review]);
  const balance = review?.balance.state === 'ok' ? usdc(review.balance.usdcMinor) : null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <header className="dash-reveal overflow-hidden rounded-2xl bg-[#0c3e48] text-white">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-start md:justify-between md:p-6">
          <div className="min-w-0">
            <span className="inline-flex rounded-md border border-white/25 px-2.5 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-white">Batch payouts</span>
            <h1 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">Pay many, approve once</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-white/85">Upload a sheet, check each row, get one approval from your owners, and keep a receipt for every payment.</p>
          </div>
          <div className="flex items-center justify-between gap-4 md:flex-col md:items-end">
            <button
              type="button"
              onClick={() => setHow(true)}
              className="inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-white/30 bg-white/10 px-4 text-sm font-semibold text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <CircleHelp className="h-4 w-4" aria-hidden="true" />
              How it works
            </button>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-white/80">Current step</div>
                <div className="text-sm font-bold">{STEPS[step - 1]}</div>
              </div>
              <span className="rounded-lg bg-[#efc46f] px-2.5 py-1.5 font-mono text-[13px] font-bold text-[#0c3e48]">{step}/5</span>
            </div>
          </div>
        </div>
        <div className="h-1 bg-white/15" role="presentation"><div className="h-full bg-[#8fd7c7] transition-[width] motion-reduce:transition-none" style={{ width: `${step * 20}%` }} /></div>
      </header>

      <nav aria-label="Steps" className="dash-surface overflow-hidden">
        <ol className="grid grid-cols-5 sm:flex sm:flex-wrap">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const active = n === step;
            const done = n < step;
            return (
              <li key={label} aria-current={active ? 'step' : undefined} className={`flex min-h-[56px] items-center justify-center gap-3 px-2 py-2 sm:flex-1 sm:justify-start sm:px-4 ${active ? 'bg-white shadow-[inset_0_-3px_0_#0d6370]' : ''}`}>
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold ${done ? 'bg-[#0d6370] text-white' : active ? 'bg-[#0c3e48] text-white' : 'bg-[#ede8e4] text-[#1F4452]'}`}>{done ? <Check className="h-4 w-4" aria-hidden="true" /> : n}</span>
                <span className={`hidden text-sm sm:block ${active ? 'font-bold text-[#0c3e48]' : 'font-semibold text-[#1F4452]'}`}>{label}</span>
              </li>
            );
          })}
        </ol>
        <p className="border-t border-[#326273]/10 px-4 py-2 text-sm font-bold text-[#0c3e48] sm:hidden">Step {step} of 5: {STEPS[step - 1]}</p>
      </nav>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="dash-surface min-w-0 p-4 sm:p-6" aria-label={STEPS[step - 1]}>
          {ctxState === 'loading' ? (
            <p role="status" className="text-sm text-[#326273]">Loading…</p>
          ) : ctxState === 'denied' ? (
            <p role="alert" className="text-sm font-medium text-[var(--error)]">You do not have a place in a business here yet, so there is nothing to pay from.</p>
          ) : ctxState === 'failed' ? (
            <p role="alert" className="text-sm font-medium text-[var(--error)]">Splash could not load your business just now. Nothing was sent. Try again in a moment.</p>
          ) : ctx && ctx.walletState !== 'ready' ? (
            <p role="status" className="text-sm leading-6 text-[#1F4452]">A batch is paid from your Splash Wallet, and your business does not have one set up yet. Set it up in <Link href="/dashboard/wallet" className="font-semibold text-[#0d6370] underline underline-offset-2">Wallet</Link>, then come back.</p>
          ) : (
            <>
              {step === 1 ? (
                <div className="space-y-8">
                  <StepUpload onRows={takeRows} />
                  <RecentBatches batches={batches} onOpen={(b) => void open(b)} />
                </div>
              ) : null}
              {step === 2 && readNotes.length > 0 ? (
                <div role="status" className="mb-4 rounded-xl bg-[#F6F0ED] p-3 text-sm leading-6 text-[#1F4452]">
                  <p className="font-bold text-[#0c3e48]">Splash cleaned some cells in your file</p>
                  <ul className="mt-1 space-y-0.5">
                    {readNotes.slice(0, 8).map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                    {readNotes.length > 8 ? <li>And {readNotes.length - 8} more changes to cells.</li> : null}
                  </ul>
                </div>
              ) : null}
              {step === 2 ? (
                <StepReview rows={rows} review={review} stale={stale} checking={checking} error={reviewError} onEdit={edit} onRemove={remove} onAdd={add} onCheck={() => void runReview(rows)} onRemoveProblems={removeProblems} confirmed={confirmed} onConfirm={(change) => setConfirmed((c) => ({ ...c, ...change }))} back={restart} next={() => go(3)} />
              ) : null}
              {step === 3 ? <StepApprove ctx={ctx} rows={rows} review={review} confirmed={confirmed} intentKey={intentKey} made={made} onMade={onMade} onExecuted={onExecuted} onRestart={restart} back={() => go(2)} /> : null}
              {step === 4 && made ? <StepSend batch={made.batch} onBatch={(b) => setMade((m) => (m ? { ...m, batch: b } : m))} onSettled={() => go(5)} onRestart={restart} /> : null}
              {step === 5 && made ? <StepReceipts batchId={made.batch.id} onNew={restart} /> : null}
            </>
          )}
        </section>

        <aside className="space-y-3" aria-label="This batch">
          <div className="rounded-2xl bg-[#0c3e48] p-4 text-white">
            <div className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-white/80">This batch</div>
            <div className="mt-2 text-xl font-extrabold">{made ? STATUS_WORDS[made.batch.status] : rows.length > 0 ? `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}` : 'Not started'}</div>
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-white/15 pt-3 text-sm">
              <div>
                <dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/75">You pay in</dt>
                <dd className="font-bold">USDC</dd>
              </div>
              <div>
                <dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/75">To recipients</dt>
                <dd className="font-bold tabular-nums">{total !== '0' ? usdc(total) : 'Not set'}</dd>
              </div>
            </dl>
          </div>
          <div className="dash-block p-4">
            <div className="flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-[#145d6a]"><Wallet className="h-3.5 w-3.5" aria-hidden="true" />Splash Wallet</div>
            <div className="mt-1.5 text-2xl font-extrabold tabular-nums text-[#0c3e48]">{balance ?? 'Shown when you review'}</div>
            {canAddFunds ? <Link href="/dashboard/wallet#top-up" className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-[#0d6370] underline underline-offset-2">Add funds</Link> : null}
          </div>
        </aside>
      </div>
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </div>
  );
}

/** Batches already made: a team member's batch waits here for an owner, and a paid batch opens its receipts. */
function RecentBatches({ batches, onOpen }: { batches: BatchView[]; onOpen: (b: BatchView) => void }) {
  if (batches.length === 0) return null;
  return (
    <section aria-labelledby="recent-batches">
      <h2 id="recent-batches" className="text-lg font-extrabold text-[#0c3e48]">Your batches</h2>
      <ul className="mt-3 space-y-2">
        {batches.slice(0, 8).map((b) => (
          <li key={b.id}>
            <button
              type="button"
              onClick={() => onOpen(b)}
              className="flex min-h-14 w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-[#326273]/15 bg-white px-4 py-3 text-left transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
            >
              <span className="min-w-0">
                <span className="block text-sm font-bold text-[#0c3e48]">{b.rowCount} {b.rowCount === 1 ? 'payment' : 'payments'} · {usdc(b.totalMinor)}</span>
                <span className="block text-[13px] text-[#326273]"><LocalTime value={b.createdAt} format="date" /></span>
              </span>
              <span className={`rounded-full border px-3 py-1 text-[13px] font-semibold ${b.status === 'settled' ? 'border-[var(--ok)] bg-[var(--ok-bg)] text-[#1F4452]' : b.status === 'failed' || b.status === 'expired' || b.status === 'declined' || b.status === 'withdrawn' ? 'border-[var(--error)] bg-[var(--error-bg)] text-[var(--error)]' : 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn-ink)]'}`}>{STATUS_WORDS[b.status]}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

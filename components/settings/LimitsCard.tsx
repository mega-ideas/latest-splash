'use client';

import { useRef, useState } from 'react';
import { CircleAlert, Clock3, Loader2, RefreshCw, Undo2 } from 'lucide-react';

import StartQuestions from '@/components/limits/StartQuestions';
import FewApprovers from '@/components/team/FewApprovers';
import { call, errorText } from '@/components/transfer/api';
import { CONTROL, Field, Modal, PrimaryButton, QuietButton, TextInput } from '@/components/transfer/ui';
import { Card, Loading, Note, Pill, newKey, useLoad } from '@/components/wallet/parts';
import { WHAT_HAPPENS_NEXT, REASON_MAX, REASON_MIN, limitInputValue, lowerNeedsConfirm, lowerProblems, parseLimitValue, raiseProblems, reasonProblems, type LimitKind, type LimitValues } from '@/lib/limits/rules';
import { askedNoteWords, controlsAndLimitsWords, type AskedKind, type ControlsFigures, type SkippedKind } from '@/lib/limits/start';
import type { LimitWire, LimitsWire, RequestWire } from '@/lib/server/business-limits';

const TEXTAREA = CONTROL.replace('h-11 ', 'min-h-28 py-2.5 leading-6 ');

type Sheet = { mode: 'raise' | 'lower'; limit: LimitWire } | null;

/**
 * Limits (v2 Phase 3, Sky's decision): the four limits Splash holds automatic
 * payments to, each in plain words with its figure and why it is that figure.
 * A new business starts at the starting figures, or lower at what its own
 * answers worked out to, and the page says so ("We started you at ... because you
 * told us ..."). An owner lowers one at once, puts one they lowered back at once
 * (up to the most their business has held), or asks Splash for a higher one:
 * Splash reviews it and, if it approves, the higher limit starts after a 24 hour
 * notice that any owner can cancel. "Ask for higher limits" asks, in one tap, for
 * what the answers worked out to beyond the start. The Finance lead sees all of
 * it and asks for nothing.
 *
 * Settings, Controls (the older per-transfer and daily guard-rails, in USD) are a
 * separate set that guards the payments the team sends; they are shown beside
 * these Limits, with which payments each one holds, in one block at the foot.
 *
 * The page does the same arithmetic as the server (lib/limits/rules.ts) so a
 * figure that would be refused is said so before it is sent; the server decides.
 * It reads the signed-in person's own business only.
 *
 * `controls`: the Controls figures; `undefined` while they are being read and `null` when they could not be.
 */
export default function LimitsCard({ controls }: { controls?: ControlsFigures | null }) {
  const view = useLoad<LimitsWire>('/api/limits', 'Your limits could not be read.');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askedNote, setAskedNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { reload } = view;

  if (view.loading) return <Card id="limits" title="Limits on automatic payments"><Loading label="Reading your limits…" /></Card>;
  if (view.error || !view.data) {
    return (
      <Card id="limits" title="Limits on automatic payments">
        <div className="space-y-3">
          <Note tone="error">{view.error ?? 'Your limits could not be read.'}</Note>
          <QuietButton type="button" onClick={reload}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton>
        </div>
      </Card>
    );
  }

  const data = view.data;

  async function cancel(request: RequestWire) {
    setCancelling(request.id);
    setProblem(null);
    const answer = await call(`/api/limits/requests/${request.id}`, { method: 'DELETE' });
    setCancelling(null);
    if (!answer.ok) setProblem(errorText(answer, 'The request could not be cancelled. Nothing was changed.'));
    reload();
  }

  // Putting a lowered limit back is an owner's own change: it applies at once and nothing is asked of Splash.
  async function restore(limit: LimitWire) {
    setRestoring(limit.kind);
    setProblem(null);
    const answer = await call('/api/limits/restore', { method: 'POST', body: { kind: limit.kind, value: limitInputValue(limit.kind as LimitKind, BigInt(limit.held)) } });
    setRestoring(null);
    if (!answer.ok) setProblem(errorText(answer, 'The limit was not put back. Nothing was changed.'));
    reload();
  }

  // One tap asks Splash, on the ordinary request path, for what the answers worked out to beyond the limits now. The server reads the figures from the answers it holds.
  async function askForHigher() {
    if (asking) return;
    setAsking(true);
    setProblem(null);
    setAskedNote(null);
    const answer = await call<{ asked?: AskedKind[]; skipped?: SkippedKind[] }>('/api/limits/answers/ask', { method: 'POST', body: {} });
    setAsking(false);
    if (!answer.ok) setProblem(errorText(answer, 'The request was not sent. Nothing was changed.'));
    else setAskedNote(askedNoteWords(answer.body?.asked ?? [], answer.body?.skipped ?? []));
    reload();
  }

  const current = Object.fromEntries(data.limits.map((l) => [l.kind, BigInt(l.current)])) as LimitValues;
  const newBusiness = data.limits.every((l) => l.source === 'standard');
  const start = data.start;

  return (
    <Card id="limits" title="Limits on automatic payments">
      <div className="space-y-4">
        <p className="max-w-[62ch] text-[13px] leading-5 text-[#1F4452]">
          These are the most Splash will pay for you automatically. They are where your business started, and they can go up or down. {data.canAsk ? 'You can lower any of them at once, and put one back at once. To go higher than your business has had, ask Splash.' : 'Only an owner can lower a limit or ask Splash for a higher one.'}
        </p>
        {problem ? <Note tone="error">{problem}</Note> : null}
        {data.canAsk ? <FewApprovers /> : null}

        {start.headline ? (
          <div role="group" className="space-y-2 rounded-xl bg-[#F6F0ED] p-3" aria-labelledby="limits-start-title">
            <p id="limits-start-title" className="text-[13px] font-bold text-[#0c3e48]">How your limits started</p>
            <p className="max-w-[62ch] text-[13px] leading-5 text-[#1F4452]">{start.headline}</p>
            {start.capped ? <p className="max-w-[62ch] text-[13px] leading-5 text-[#1F4452]">{start.capped}</p> : null}
            {start.canAskHigher ? (
              <div className="pt-1">
                <PrimaryButton type="button" onClick={() => void askForHigher()} disabled={asking}>
                  {asking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                  Ask for higher limits
                </PrimaryButton>
                <p className="mt-1.5 max-w-[62ch] text-[13px] leading-5 text-[#326273]">{WHAT_HAPPENS_NEXT}</p>
              </div>
            ) : null}
            {askedNote ? <p role="status" className="max-w-[62ch] text-[13px] font-semibold leading-5 text-[#1F4452]">{askedNote}</p> : null}
          </div>
        ) : start.ask ? (
          <div className="space-y-3 rounded-xl bg-[#F6F0ED] p-3">
            <p className="text-[13px] font-bold text-[#0c3e48]">Tell us how you will use Splash</p>
            <p className="max-w-[62ch] text-[13px] leading-5 text-[#1F4452]">
              {newBusiness
                ? 'We use your answers to set your starting limits. A rough figure is fine.'
                : 'Your business keeps the limits it already runs on. Answer these three questions and we will show you what a new business like yours would start at, and you can ask Splash for it.'}
            </p>
            <StartQuestions submitLabel="Save my answers" onSaved={() => reload()} />
          </div>
        ) : null}

        <ul className="divide-y divide-[#326273]/12 border-y border-[#326273]/12">
          {data.limits.map((limit) => (
            <LimitRow key={limit.kind} limit={limit} canAsk={data.canAsk} cancelling={cancelling} restoring={restoring} onRaise={() => setSheet({ mode: 'raise', limit })} onLower={() => setSheet({ mode: 'lower', limit })} onRestore={() => void restore(limit)} onCancel={cancel} />
          ))}
        </ul>
        <ControlsBlock controls={controls} limits={current} />
      </div>
      {sheet ? <LimitSheet key={`${sheet.mode}-${sheet.limit.kind}`} sheet={sheet} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} /> : null}
    </Card>
  );
}

/**
 * The older Settings, Controls figures and these Limits, side by side, with the payments each one holds. They are two
 * models and stay two: a payment is held to one set, never both (the words are lib/limits/start.ts controlsAndLimitsWords,
 * and a test reads the code to keep them true).
 */
function ControlsBlock({ controls, limits }: { controls?: ControlsFigures | null; limits: LimitValues }) {
  const words = controlsAndLimitsWords(controls ?? null, limits);
  return (
    <section aria-labelledby="limits-controls-title" className="space-y-3 rounded-xl border border-[#326273]/20 bg-white p-3">
      <h3 id="limits-controls-title" className="text-[14px] font-extrabold text-[#0c3e48]">Controls and Limits, together</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <p className="text-[13px] font-bold text-[#0c3e48]">{words.controls.title} <span className="font-normal text-[#326273]">(Settings, Controls)</span></p>
          {controls === undefined ? (
            <p className="text-[13px] text-[#326273]">Reading your Controls…</p>
          ) : words.controls.unavailable ? (
            <p className="text-[13px] leading-5 text-[#1F4452]">{words.controls.unavailable}</p>
          ) : (
            <dl className="grid gap-1">
              {words.controls.figures.map((f) => (
                <div key={f.label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[13px] text-[#326273]">{f.label}</dt>
                  <dd className="text-[14px] font-extrabold tabular-nums text-[#0c3e48]">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="text-[13px] leading-5 text-[#1F4452]">{words.controls.says}</p>
        </div>
        <div className="space-y-1.5">
          <p className="text-[13px] font-bold text-[#0c3e48]">{words.limits.title} <span className="font-normal text-[#326273]">(above)</span></p>
          <dl className="grid gap-1">
            {words.limits.figures.map((f) => (
              <div key={f.label} className="flex items-baseline justify-between gap-3">
                <dt className="text-[13px] text-[#326273]">{f.label}</dt>
                <dd className="text-[14px] font-extrabold tabular-nums text-[#0c3e48]">{f.value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-[13px] leading-5 text-[#1F4452]">{words.limits.says}</p>
          <p className="text-[13px] leading-5 text-[#326273]">{words.limits.dailyNote}</p>
        </div>
      </div>
      <p className="max-w-[62ch] text-[13px] leading-5 text-[#1F4452]">{words.order}</p>
      <p className="max-w-[62ch] text-[13px] leading-5 text-[#326273]">{words.approvalLine}</p>
    </section>
  );
}

function LimitRow({ limit, canAsk, cancelling, restoring, onRaise, onLower, onRestore, onCancel }: { limit: LimitWire; canAsk: boolean; cancelling: string | null; restoring: string | null; onRaise: () => void; onLower: () => void; onRestore: () => void; onCancel: (request: RequestWire) => Promise<void> }) {
  const open = limit.open;
  const last = limit.last && !open && limit.last.phase !== 'in_force' ? limit.last : null;
  // Only the length of an allowance has a ceiling (a year); an amount can always be asked for, and Splash decides.
  const atLongest = limit.ceiling != null && BigInt(limit.current) >= BigInt(limit.ceiling);
  const atFloor = BigInt(limit.current) <= BigInt(limit.floor);
  // A control that is off says why in words on the page: a title attribute is not read on a phone or reliably by a screen reader.
  const whyOff = [
    atLongest ? 'This is the longest an allowance can last.' : open ? 'A request is already open for this limit.' : null,
    atFloor ? 'This is the lowest a limit can be.' : null,
  ].filter((text): text is string => text !== null);
  const whyId = `limit-${limit.kind}-why`;
  return (
    <li className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6">
      {/* On a phone: the name, the figure and its buttons, then the words. From sm up: the words on the left, the figure on the right. */}
      <h3 className="min-w-0 text-[15px] font-extrabold text-[#0c3e48] sm:col-start-1">{limit.label}</h3>
      <div className="flex flex-col gap-3 sm:col-start-2 sm:row-span-3 sm:row-start-1 sm:items-end sm:text-right">
        <div>
          <p className="text-2xl font-extrabold tabular-nums leading-none text-[#0c3e48]">{limit.currentWords}</p>
          {limit.ceilingWords ? <p className="mt-1.5 text-[13px] text-[#326273]">Longest an allowance can last: <span className="tabular-nums">{limit.ceilingWords}</span></p> : null}
        </div>
        {canAsk ? (
          <div className="flex flex-col gap-2 sm:items-end">
            <div className="flex flex-wrap gap-2 sm:justify-end">
              {limit.canRestore ? (
                <QuietButton type="button" onClick={onRestore} disabled={restoring === limit.kind} aria-label={`Restore ${limit.label} to ${limit.heldWords}`}>
                  {restoring === limit.kind ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Undo2 className="h-4 w-4" aria-hidden="true" />}
                  Restore to <span className="tabular-nums">{limit.heldWords}</span>
                </QuietButton>
              ) : null}
              <QuietButton type="button" onClick={onRaise} disabled={atLongest || Boolean(open)} aria-label={`Ask for more: ${limit.label}`} aria-describedby={atLongest || open ? whyId : undefined}>Ask for more</QuietButton>
              <QuietButton type="button" onClick={onLower} disabled={atFloor} aria-label={`Lower: ${limit.label}`} aria-describedby={atFloor ? whyId : undefined}>Lower</QuietButton>
            </div>
            {whyOff.length > 0 ? <p id={whyId} className="max-w-[34ch] text-[13px] leading-5 text-[#326273] sm:text-right">{whyOff.join(' ')}</p> : null}
          </div>
        ) : null}
      </div>
      <div className="min-w-0 space-y-2 sm:col-start-1">
        <p className="text-[13px] leading-5 text-[#1F4452]">{limit.says}</p>
        <p className="text-[13px] leading-5 text-[#326273]">{limit.why}</p>
      </div>
      <div className="min-w-0 empty:hidden sm:col-start-1">
        {open ? (
          <div className="space-y-2 rounded-xl bg-[var(--warn-bg)] p-3">
            <Pill tone="wait"><Clock3 className="mr-1.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{open.phase === 'asked' ? 'Waiting for Splash' : 'Approved, starts after the notice'}</Pill>
            <p className="text-[13px] leading-5 text-[#1F4452]">{open.says}</p>
            {canAsk ? (
              <QuietButton type="button" onClick={() => void onCancel(open)} disabled={cancelling === open.id}>
                {cancelling === open.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                Cancel this request
              </QuietButton>
            ) : null}
          </div>
        ) : last ? (
          <div className="space-y-1.5 rounded-xl bg-[#F6F0ED] p-3">
            <Pill tone={last.phase === 'declined' ? 'bad' : 'wait'}>{last.phase === 'declined' ? 'Splash declined' : 'You cancelled'}</Pill>
            <p className="text-[13px] leading-5 text-[#1F4452]">{last.says}</p>
          </div>
        ) : null}
      </div>
    </li>
  );
}

function LimitSheet({ sheet, onClose, onDone }: { sheet: NonNullable<Sheet>; onClose: () => void; onDone: () => void }) {
  const { limit, mode } = sheet;
  const kind = limit.kind as LimitKind;
  const [figure, setFigure] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // The figure is judged once the person has left the field, not on every key.
  const [figureSeen, setFigureSeen] = useState(false);
  // One key per sheet: a retry, a second click or a second tab asks once.
  const key = useRef(newKey('limit'));
  const raising = mode === 'raise';
  const days = kind === 'days';

  const parsed = parseLimitValue(kind, figure);
  const figureProblems = figure.trim() === '' ? [days ? 'Give a whole number of days.' : 'Give an amount in USDC.'] : parsed == null ? [days ? 'Give a whole number of days.' : 'Give an amount in USDC, for example 3,000.'] : raising ? raiseProblems(kind, parsed, BigInt(limit.current)) : lowerProblems(kind, parsed, BigInt(limit.current));
  const reasonList = raising ? reasonProblems(reason) : [];
  const invalid = figureProblems.length > 0 || reasonList.length > 0;
  // "2" for "2,000" is a missing zero more often than a decision. The owner is asked to look again; it can be put back at once either way.
  const lookAgain = !raising && parsed != null && figureProblems.length === 0 && lowerNeedsConfirm(kind, parsed, BigInt(limit.current));

  async function send() {
    setTouched(true);
    if (invalid) {
      // A bad submit takes the person to the first field that is wrong.
      document.getElementById(figureProblems.length > 0 ? 'limit-figure' : 'limit-reason')?.focus();
      return;
    }
    if (busy) return;
    setBusy(true);
    setError(null);
    const answer = raising
      ? await call('/api/limits/requests', { method: 'POST', key: key.current, body: { kind, requested: figure, reason } })
      : await call('/api/limits/lower', { method: 'POST', body: { kind, value: figure } });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, raising ? 'The request was not sent. Nothing was changed.' : 'The limit was not lowered. Nothing was changed.'));
      return;
    }
    onDone();
  }

  return (
    <Modal open onClose={onClose} title={raising ? `Ask for a higher limit` : 'Lower this limit'} eyebrow={limit.label} side>
      <form
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-[#F6F0ED] p-3 text-[13px]">
          <div>
            <dt className="text-[#326273]">Your limit now</dt>
            <dd className="mt-0.5 text-base font-extrabold tabular-nums text-[#0c3e48]">{limit.currentWords}</dd>
          </div>
          <div>
            <dt className="text-[#326273]">{raising ? (days ? 'Longest it can be' : 'After Splash approves') : 'Lowest you can set'}</dt>
            <dd className="mt-0.5 text-base font-extrabold tabular-nums text-[#0c3e48]">{raising ? (days ? limit.ceilingWords : '24 hour notice') : days ? '1 day' : '0.01 USDC'}</dd>
          </div>
        </dl>

        <Field label={raising ? 'New limit' : 'Lower it to'} hint={days ? 'days' : 'USDC'} htmlFor="limit-figure" error={touched || figureSeen ? figureProblems[0] ?? null : null}>
          <TextInput id="limit-figure" inputMode={days ? 'numeric' : 'decimal'} autoComplete="off" value={figure} onChange={(e) => setFigure(e.target.value)} onBlur={() => setFigureSeen(figure.trim() !== '')} className="tabular-nums" aria-describedby={raising ? 'limit-ask-note' : undefined} />
        </Field>
        {raising ? <p id="limit-ask-note" className="-mt-2 text-[13px] leading-5 text-[#326273]">{limit.askNote}</p> : null}

        {lookAgain && parsed != null ? (
          <p role="status" className="flex items-start gap-2 rounded-xl border border-[#326273]/25 bg-[var(--warn-bg)] p-3 text-[13px] leading-5 text-[#1F4452]">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>That is less than a tenth of your limit of {limit.currentWords}. Check you have not left a zero off. If you meant it, go ahead: you can put the limit back at once with Restore.</span>
          </p>
        ) : null}

        {raising ? (
          <Field label="Why do you need it?" hint={`${reason.trim().length} of ${REASON_MAX}`} htmlFor="limit-reason" error={touched ? reasonList[0] ?? null : null}>
            <textarea
              id="limit-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={REASON_MAX}
              aria-describedby="limit-reason-help"
              className={TEXTAREA}
            />
            <p id="limit-reason-help" className="mt-1.5 text-[13px] text-[#326273]">A sentence or two for the person at Splash who reads it. At least {REASON_MIN} characters.</p>
          </Field>
        ) : null}

        <div className="rounded-xl border border-[#326273]/20 bg-white p-3 text-[13px] leading-5 text-[#1F4452]">
          {raising ? (
            <>
              <p className="font-bold text-[#0c3e48]">What happens next</p>
              <p className="mt-1">{WHAT_HAPPENS_NEXT} Until then your limit stays {limit.currentWords}. You can cancel the request at any time before it starts.</p>
            </>
          ) : days ? (
            <>
              <p className="font-bold text-[#0c3e48]">What happens next</p>
              <p className="mt-1">This holds for the next allowance you give. An allowance you have already given keeps its length until you give it again or take it back, in Automatic payments. There is nothing to ask Splash. If a request for a higher limit is open, it is cancelled so it cannot raise this one later.</p>
            </>
          ) : (
            <>
              <p className="font-bold text-[#0c3e48]">What happens next</p>
              <p className="mt-1">
                The lower limit applies at once, to every automatic payment from now on{kind === 'monthly' ? ' (what was paid in the last 30 days counts towards it)' : ''}. There is nothing to ask Splash. If a request for a higher limit is open, it is cancelled so it cannot raise this one later. If you change your mind, you can put the limit back at once with Restore.
              </p>
            </>
          )}
        </div>

        <div role="status" className="empty:hidden">{error ? <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-[13px] font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span></p> : null}</div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[#326273]/12 pt-4">
          <QuietButton type="button" onClick={onClose}>Close</QuietButton>
          <PrimaryButton type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {raising ? 'Send request' : lookAgain ? 'Lower it anyway' : 'Lower limit'}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
}

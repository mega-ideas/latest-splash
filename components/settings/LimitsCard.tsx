'use client';

import { useRef, useState } from 'react';
import { CircleAlert, Clock3, Loader2, RefreshCw } from 'lucide-react';

import { call, errorText } from '@/components/transfer/api';
import { CONTROL, Field, Modal, PrimaryButton, QuietButton, TextInput } from '@/components/transfer/ui';
import { Card, Loading, Note, Pill, newKey, useLoad } from '@/components/wallet/parts';
import { WHAT_HAPPENS_NEXT, REASON_MAX, REASON_MIN, lowerProblems, parseLimitValue, raiseProblems, reasonProblems, type LimitKind } from '@/lib/limits/rules';
import type { LimitWire, LimitsWire, RequestWire } from '@/lib/server/business-limits';

const TEXTAREA = CONTROL.replace('h-11 ', 'min-h-28 py-2.5 leading-6 ');

type Sheet = { mode: 'raise' | 'lower'; limit: LimitWire } | null;

/**
 * Limits (v2 Phase 3, Sky's decision): the four limits Splash holds automatic
 * payments to, each in plain words with its figure and why it is that figure.
 * An owner lowers one at once, or asks Splash for a higher one: Splash reviews
 * it and, if it approves, the higher limit starts after a 24 hour notice that
 * any owner can cancel. The Finance lead sees all of it and asks for nothing.
 *
 * The page does the same arithmetic as the server (lib/limits/rules.ts) so a
 * figure that would be refused is said so before it is sent; the server decides.
 * It reads the signed-in person's own business only.
 */
export default function LimitsCard() {
  const view = useLoad<LimitsWire>('/api/limits', 'Your limits could not be read.');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
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

  return (
    <Card id="limits" title="Limits on automatic payments">
      <div className="space-y-4">
        <p className="max-w-[62ch] text-[13px] leading-5 text-[#1F4452]">
          These are the most Splash will pay for you automatically. Every business starts with the same four. {data.canAsk ? 'You can lower any of them at once. To go higher, ask Splash.' : 'Only an owner can lower a limit or ask Splash for a higher one.'}
        </p>
        {problem ? <Note tone="error">{problem}</Note> : null}
        <ul className="divide-y divide-[#326273]/12 border-y border-[#326273]/12">
          {data.limits.map((limit) => (
            <LimitRow key={limit.kind} limit={limit} canAsk={data.canAsk} cancelling={cancelling} onRaise={() => setSheet({ mode: 'raise', limit })} onLower={() => setSheet({ mode: 'lower', limit })} onCancel={cancel} />
          ))}
        </ul>
        <p className="max-w-[62ch] text-[13px] leading-5 text-[#326273]">
          The amount above which an owner approves every payment is set in your spending policy, and only owners change it. Nothing here moves that line.
        </p>
      </div>
      {sheet ? <LimitSheet key={`${sheet.mode}-${sheet.limit.kind}`} sheet={sheet} onClose={() => setSheet(null)} onDone={() => { setSheet(null); reload(); }} /> : null}
    </Card>
  );
}

function LimitRow({ limit, canAsk, cancelling, onRaise, onLower, onCancel }: { limit: LimitWire; canAsk: boolean; cancelling: string | null; onRaise: () => void; onLower: () => void; onCancel: (request: RequestWire) => Promise<void> }) {
  const open = limit.open;
  const last = limit.last && !open && limit.last.phase !== 'in_force' ? limit.last : null;
  const atCeiling = BigInt(limit.current) >= BigInt(limit.ceiling);
  const atFloor = BigInt(limit.current) <= BigInt(limit.floor);
  return (
    <li className="grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6">
      {/* On a phone: the name, the figure and its buttons, then the words. From sm up: the words on the left, the figure on the right. */}
      <h3 className="min-w-0 text-[15px] font-extrabold text-[#0c3e48] sm:col-start-1">{limit.label}</h3>
      <div className="flex flex-col gap-3 sm:col-start-2 sm:row-span-3 sm:row-start-1 sm:items-end sm:text-right">
        <div>
          <p className="text-2xl font-extrabold tabular-nums leading-none text-[#0c3e48]">{limit.currentWords}</p>
          <p className="mt-1.5 text-[13px] text-[#326273]">Most Splash offers: <span className="tabular-nums">{limit.ceilingWords}</span></p>
        </div>
        {canAsk ? (
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <QuietButton type="button" onClick={onRaise} disabled={atCeiling || Boolean(open)} aria-label={`Ask for more: ${limit.label}`} title={atCeiling ? 'This is the most Splash offers.' : open ? 'A request is already open for this limit.' : undefined}>Ask for more</QuietButton>
            <QuietButton type="button" onClick={onLower} disabled={atFloor} aria-label={`Lower: ${limit.label}`}>Lower</QuietButton>
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

  async function send() {
    setTouched(true);
    if (invalid || busy) return;
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
            <dt className="text-[#326273]">{raising ? 'Most Splash offers' : 'Lowest you can set'}</dt>
            <dd className="mt-0.5 text-base font-extrabold tabular-nums text-[#0c3e48]">{raising ? limit.ceilingWords : days ? '1 day' : '0.01 USDC'}</dd>
          </div>
        </dl>

        <Field label={raising ? 'New limit' : 'Lower it to'} hint={days ? 'days' : 'USDC'} htmlFor="limit-figure" error={touched || figureSeen ? figureProblems[0] ?? null : null}>
          <TextInput id="limit-figure" inputMode={days ? 'numeric' : 'decimal'} autoComplete="off" value={figure} onChange={(e) => setFigure(e.target.value)} onBlur={() => setFigureSeen(figure.trim() !== '')} className="tabular-nums" aria-describedby={raising ? 'limit-ceiling' : undefined} />
        </Field>
        {raising ? <p id="limit-ceiling" className="-mt-2 text-[13px] leading-5 text-[#326273]">{limit.ceilingSentence}</p> : null}

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
          ) : (
            <>
              <p className="font-bold text-[#0c3e48]">What happens next</p>
              <p className="mt-1">The lower limit applies at once. There is nothing to ask Splash. If a request for a higher limit is open, it is cancelled so it cannot raise this one later.</p>
            </>
          )}
        </div>

        <div role="status" className="empty:hidden">{error ? <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-[13px] font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /><span>{error}</span></p> : null}</div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[#326273]/12 pt-4">
          <QuietButton type="button" onClick={onClose}>Cancel</QuietButton>
          <PrimaryButton type="submit" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {raising ? 'Send request' : 'Lower limit'}
          </PrimaryButton>
        </div>
      </form>
    </Modal>
  );
}

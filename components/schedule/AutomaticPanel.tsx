'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CircleCheck, CircleAlert, Hand, PauseCircle, PlayCircle } from 'lucide-react';

import LocalTime from '@/components/LocalTime';
import { call, errorText } from '@/components/transfer/api';
import { Field, Modal, PrimaryButton, QuietButton, TextInput } from '@/components/transfer/ui';
import { newKey, Note, Pill } from '@/components/wallet/parts';
import { formatUsdc } from '@/lib/fees/copy';
import { ALLOWANCE_DEFAULTS, GRACE_MAX_MINUTES, allowanceSentence, graceWords, parseAllowanceInput, parseGraceMinutes } from '@/lib/schedule/rules';
import { automaticSummary, paymentsOfSchedules, type AutomaticSummary } from '@/lib/schedule/summary';
import type { AutomaticStatus, ScheduleView } from '@/lib/schedule/views';

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;

const ALLOWANCE_LABEL: Record<string, string> = { none: 'Not given', unreadable: 'Could not be read', active: 'In force', expired: 'Ended', not_started: 'Not started yet', revoked: 'Taken back' };

type Props = {
  status: AutomaticStatus;
  /** Every schedule of the business: the summary lists the payments of those that pay automatically. */
  schedules: ScheduleView[];
  /** The allowance screen is open. The Scheduled tab opens it itself after an owner switches a schedule to automatic. */
  allowanceOpen: boolean;
  onAllowanceOpen: (open: boolean) => void;
  onChanged: () => void;
};

/**
 * Automatic payments (owners): whether Splash can pay with no one present, the
 * allowance the owners signed and what is left of it, the daily limit, the
 * warning window before the first payment of a run, and the kill switch. The
 * allowance is asked for here and signed by the owners' passkeys like any
 * spending rule, after a plain-words summary built from the very values the
 * request is built from; the kill switch and the window are one owner, at once.
 */
export default function AutomaticPanel({ status, schedules, allowanceOpen, onAllowanceOpen, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'plain' | 'error'; text: string } | null>(null);
  const [revoking, setRevoking] = useState(false);
  const allowance = status.allowance;
  const live = allowance.state === 'active';

  async function toggle() {
    setBusy(true);
    setMessage(null);
    const answer = await call('/api/wallet/schedules/automatic', { method: 'POST', body: { action: status.paused ? 'resume' : 'pause' } });
    setBusy(false);
    if (!answer.ok) setMessage({ tone: 'error', text: errorText(answer, 'That did not change. Try again.') });
    else {
      setMessage({ tone: 'plain', text: status.paused ? 'Automatic payments are on again.' : 'Automatic payments are paused. The next run comes to you for approval.' });
      onChanged();
    }
  }

  async function takeBack() {
    setBusy(true);
    setMessage(null);
    const answer = await call('/api/wallet/schedules/automatic/allowance', { method: 'DELETE' });
    setBusy(false);
    setRevoking(false);
    if (!answer.ok) setMessage({ tone: 'error', text: errorText(answer, 'The request to take the allowance back was not made. Try again.') });
    else setMessage({ tone: 'plain', text: 'Your owners are asked to sign taking it back. Until they do it still stands; pausing automatic payments stops them at once.' });
    onChanged();
  }

  return (
    <section aria-labelledby="auto-title" className="dash-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="auto-title" className="text-lg font-extrabold text-[#0c3e48]">Automatic payments</h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-[#326273]">
            A schedule set to pay automatically is paid at its time with no one present, but only inside an allowance your owners sign, only to recipients you verified and have paid before. Anything else comes to you for approval.
          </p>
        </div>
        <Pill tone={status.paused ? 'bad' : live && status.payer.ready ? 'ok' : 'wait'}>{status.paused ? 'Paused' : live && status.payer.ready ? 'On' : 'Not ready'}</Pill>
      </div>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="dash-block p-3">
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Payer</dt>
          <dd className="mt-1 text-sm font-bold text-[#0c3e48]">{status.payer.ready ? 'Ready' : 'Not switched on'}</dd>
          <dd className="mt-0.5 text-[13px] leading-5 text-[#326273]">{status.payer.ready ? <span className="font-mono">{status.payer.address}</span> : (status.payer.reason ?? 'Automatic payments are not switched on for your business here yet.')}</dd>
        </div>
        <div className="dash-block p-3">
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Allowance</dt>
          <dd className="mt-1 text-sm font-bold text-[#0c3e48]">{ALLOWANCE_LABEL[allowance.state] ?? allowance.state}</dd>
          <dd className="mt-0.5 text-[13px] leading-5 text-[#326273]">
            {'perPaymentMaxMinor' in allowance ? (
              <>
                Up to {usdc(allowance.perPaymentMaxMinor)} a payment. {usdc(allowance.spendableNowMinor)} left this month.
                {allowance.expiresAtMs ? (
                  <>
                    {' '}Ends <LocalTime value={Number(allowance.expiresAtMs)} format="date" />.
                  </>
                ) : null}
              </>
            ) : allowance.state === 'none' ? (
              'Give one and your owners sign it.'
            ) : (
              'Splash could not read it from the network just now.'
            )}
          </dd>
        </div>
        <div className="dash-block p-3">
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Daily limit</dt>
          <dd className="mt-1 text-sm font-bold tabular-nums text-[#0c3e48]">{usdc(status.dailyCapMinor)}</dd>
          <dd className="mt-0.5 text-[13px] leading-5 text-[#326273]">
            {usdc(status.dailyUsedMinor)} paid automatically in the last 24 hours.
            {status.pendingDailyCapMinor ? ` Your owners have been asked to sign a limit of ${usdc(status.pendingDailyCapMinor)}; the limit above holds until they do.` : ''}
          </dd>
        </div>
        <div className="dash-block p-3">
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Pause switch</dt>
          <dd className="mt-1 text-sm font-bold text-[#0c3e48]">{status.paused ? 'Paused' : 'Not paused'}</dd>
          <dd className="mt-0.5 text-[13px] leading-5 text-[#326273]">One owner can pause every automatic payment, at once.</dd>
        </div>
      </dl>

      <WarningWindow status={status} onChanged={onChanged} />

      <div className="mt-4 flex flex-wrap gap-2">
        <PrimaryButton type="button" onClick={() => onAllowanceOpen(true)} disabled={!status.payer.ready}>
          <Hand className="h-4 w-4" aria-hidden="true" />
          {live ? 'Change the allowance' : 'Give an allowance'}
        </PrimaryButton>
        <QuietButton type="button" onClick={toggle} disabled={busy}>
          {status.paused ? <PlayCircle className="h-4 w-4" aria-hidden="true" /> : <PauseCircle className="h-4 w-4" aria-hidden="true" />}
          {status.paused ? 'Turn automatic payments back on' : 'Pause all automatic payments'}
        </QuietButton>
        {live || allowance.state === 'not_started' ? (
          revoking ? (
            <span className="inline-flex flex-wrap items-center gap-2" role="group" aria-label="Take the allowance back">
              <QuietButton type="button" onClick={takeBack} disabled={busy} className="!border-[var(--error)] !text-[var(--error)]">Ask owners to take it back</QuietButton>
              <QuietButton type="button" onClick={() => setRevoking(false)}>Keep it</QuietButton>
            </span>
          ) : (
            <QuietButton type="button" onClick={() => setRevoking(true)}>Take the allowance back</QuietButton>
          )
        ) : null}
      </div>
      <div role="status" className="mt-3 empty:mt-0">{message ? message.tone === 'error' ? <Note tone="error">{message.text}</Note> : <Note>{message.text}</Note> : null}</div>

      <AllowanceModal open={allowanceOpen} onClose={() => onAllowanceOpen(false)} onAsked={onChanged} status={status} schedules={schedules} />
    </section>
  );
}

/** The warning before the first automatic payment of a run: whole minutes, 0 to 60. An owner's own change, in force at once. */
function WarningWindow({ status, onChanged }: { status: AutomaticStatus; onChanged: () => void }) {
  const [minutes, setMinutes] = useState(String(status.graceMinutes));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'plain' | 'error'; text: string } | null>(null);
  const parsed = parseGraceMinutes(minutes);
  const problem = parsed === null ? `Use a whole number of minutes from 0 to ${GRACE_MAX_MINUTES}.` : null;

  async function save() {
    if (parsed === null) return;
    setBusy(true);
    setMessage(null);
    const answer = await call('/api/wallet/schedules/automatic', { method: 'POST', body: { action: 'grace', minutes: parsed } });
    setBusy(false);
    if (!answer.ok) setMessage({ tone: 'error', text: errorText(answer, 'The window was not changed. Try again.') });
    else {
      setMessage({ tone: 'plain', text: 'Saved. It applies to the next run that starts; a run already announced keeps the start it was given.' });
      onChanged();
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="dash-block mt-3 grid gap-3 p-3 sm:grid-cols-[minmax(0,14rem)_auto_minmax(0,1fr)] sm:items-end"
      noValidate
    >
      <Field label="Warning before the first payment" hint="minutes, 0 to 60" htmlFor="grace-minutes" error={problem && minutes !== String(status.graceMinutes) ? problem : null}>
        <TextInput id="grace-minutes" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} className="tabular-nums" />
      </Field>
      <QuietButton type="submit" disabled={busy || parsed === null || parsed === status.graceMinutes}>{busy ? 'Saving…' : 'Save the window'}</QuietButton>
      <div className="min-w-0 text-[13px] leading-5 text-[#326273]">
        <p>{graceWords(status.graceMinutes)}</p>
        <div role="status" className="empty:hidden">{message ? message.tone === 'error' ? <Note tone="error">{message.text}</Note> : <Note>{message.text}</Note> : null}</div>
      </div>
    </form>
  );
}

type Step = 'form' | 'review' | 'asked';

function AllowanceModal({ open, onClose, onAsked, status, schedules }: { open: boolean; onClose: () => void; onAsked: () => void; status: AutomaticStatus; schedules: ScheduleView[] }) {
  const [perPayment, setPerPayment] = useState(String(ALLOWANCE_DEFAULTS.perPaymentUsdc));
  const [daily, setDaily] = useState(String(ALLOWANCE_DEFAULTS.dailyUsdc));
  const [monthly, setMonthly] = useState(String(ALLOWANCE_DEFAULTS.monthlyUsdc));
  const [days, setDays] = useState(String(ALLOWANCE_DEFAULTS.expiresInDays));
  const [step, setStep] = useState<Step>('form');
  // The clock the end date is counted from; read again when the owner moves to the summary.
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState<AutomaticSummary | null>(null);

  // What was typed is read the way the server reads it, and the summary is built from that same result.
  const { form, problems } = parseAllowanceInput({ perPaymentUsdc: perPayment, dailyUsdc: daily, monthlyUsdc: monthly, expiresInDays: days });
  const { payments, firstPaymentMs } = paymentsOfSchedules(schedules);
  const summary = automaticSummary({ payments, form, graceMinutes: status.graceMinutes, nowMs: now, firstPaymentMs });

  function close() {
    setStep('form');
    setAsked(null);
    setError(null);
    onClose();
  }

  async function ask() {
    setBusy(true);
    setError(null);
    const answer = await call<{ summary?: AutomaticSummary }>('/api/wallet/schedules/automatic/allowance', {
      method: 'POST',
      key: newKey('allowance'),
      body: { perPaymentUsdc: perPayment, dailyUsdc: daily, monthlyUsdc: monthly, expiresInDays: days },
    });
    setBusy(false);
    if (!answer.ok) setError(errorText(answer, 'The request was not made. Nothing changed.'));
    else {
      setAsked(answer.body?.summary ?? summary);
      setStep('asked');
      onAsked();
    }
  }

  return (
    <Modal open={open} onClose={close} title="Allowance for automatic payments" eyebrow="Your owners sign it" wide={step === 'review'}>
      {step === 'asked' && asked ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-sm leading-6 text-[#0c3e48]"><CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#0d6370]" aria-hidden="true" />Your owners have been asked to sign it. Nothing is in force until they do, and you can take it back at any time.</p>
          <p className="rounded-xl bg-[#F6F0ED] p-3 text-[13px] leading-5 text-[#1F4452]">{asked.headline}</p>
          <Link href="/dashboard/approve" className="inline-flex h-11 items-center rounded-xl bg-[#0d6370] px-5 text-sm font-bold text-white hover:bg-[#073d49]">Open approvals</Link>
        </div>
      ) : step === 'review' ? (
        <Review summary={summary} error={error} busy={busy} onBack={() => setStep('form')} onAsk={() => void ask()} />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (problems.length === 0) {
              setNow(Date.now());
              setStep('review');
            }
          }}
          className="space-y-4"
          noValidate
        >
          <p className="text-sm leading-6 text-[#326273]">Splash can pay recipients you verified and have paid before, up to these limits, for as long as the allowance lasts. It is signed by your owners&rsquo; passkeys and you can take it back at any time.</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Most for one payment" hint="USDC" htmlFor="al-per"><TextInput id="al-per" inputMode="decimal" value={perPayment} onChange={(e) => setPerPayment(e.target.value)} className="tabular-nums" /></Field>
            <Field label="Most in a day" hint="USDC" htmlFor="al-day"><TextInput id="al-day" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} className="tabular-nums" /></Field>
            <Field label="Most in a month" hint="USDC" htmlFor="al-month"><TextInput id="al-month" inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} className="tabular-nums" /></Field>
            <Field label="Lasts" hint="days, at most a year" htmlFor="al-days"><TextInput id="al-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} className="tabular-nums" /></Field>
          </div>
          {problems.length > 0 ? (
            <ul className="space-y-1" aria-label="What to fix">
              {problems.map((p) => (
                <li key={p} className="flex items-start gap-1.5 text-[13px] font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{p}</li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl bg-[#F6F0ED] p-3 text-[13px] leading-5 text-[#1F4452]">{allowanceSentence(form)}</p>
          )}
          <Note>The monthly limit is held by the network itself. The daily limit is held by Splash. {status.dailyCapMinor !== '0' ? `Today it is ${usdc(status.dailyCapMinor)}.` : ''}</Note>
          <div className="flex flex-wrap justify-end gap-2 border-t border-[#326273]/12 pt-4">
            <QuietButton type="button" onClick={close}>Cancel</QuietButton>
            <PrimaryButton type="submit" disabled={problems.length > 0}>Check what you are agreeing to</PrimaryButton>
          </div>
        </form>
      )}
    </Modal>
  );
}

/**
 * Check this before your owners sign: the summary in plain words, then the exact
 * payments, the limits, the recipients, the end date, the warning window and how
 * to stop. Every figure is read from the summary, which is built from the values
 * the request is made from.
 */
function Review({ summary, error, busy, onBack, onAsk }: { summary: AutomaticSummary; error: string | null; busy: boolean; onBack: () => void; onAsk: () => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Check this before your owners sign</h3>
        <p className="mt-2 text-base font-bold leading-7 text-[#0c3e48]">{summary.headline}</p>
      </div>

      {summary.payments.length > 0 ? (
        <section aria-label="The payments" className="space-y-2">
          <h4 className="text-[13px] font-semibold text-[#1F4452]">The payments, exactly as you sent them</h4>
          <ul className="divide-y divide-[#326273]/10 rounded-xl border border-[#326273]/12 bg-white">
            {summary.payments.map((p) => (
              <li key={`${p.schedule ?? ''}-${p.position}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2.5">
                <span className="min-w-0 text-sm font-semibold text-[#0c3e48]">
                  {p.name}
                  <span className="ml-2 font-mono text-[12px] font-normal text-[#326273]">{p.masked}</span>
                  {p.schedule ? <span className="block text-[12px] font-normal text-[#326273]">{p.schedule}</span> : null}
                </span>
                <span className="text-sm font-bold tabular-nums text-[#0c3e48]">
                  {usdc(p.amountMinor)}
                  {p.reference ? <span className="ml-2 font-mono text-[12px] font-normal text-[#326273]">{p.reference}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-2">
        <Figure label="Most for one payment" value={usdc(summary.perPaymentMinor)} />
        <Figure label="Most in a day" value={usdc(summary.dailyMinor)} note="Held by Splash." />
        <Figure label="Most in a month" value={usdc(summary.monthlyMinor)} note="Held by the network itself." />
        <div className="dash-block p-3">
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">The allowance ends</dt>
          <dd className="mt-1 text-sm font-bold text-[#0c3e48]"><LocalTime value={summary.endsAtMs} format="date" /></dd>
        </div>
        <div className="dash-block p-3 sm:col-span-2">
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Recipients</dt>
          <dd className="mt-1 text-sm font-semibold text-[#0c3e48]">{summary.recipients.length > 0 ? summary.recipients.join(', ') : 'None yet'}</dd>
        </div>
        <div className="dash-block p-3 sm:col-span-2">
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">Warning before the first payment</dt>
          <dd className="mt-1 text-[13px] leading-5 text-[#326273]">{summary.graceText}</dd>
        </div>
        <div className="dash-block p-3 sm:col-span-2">
          <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">How to stop</dt>
          <dd className="mt-1 text-[13px] leading-5 text-[#326273]">{summary.stopText}</dd>
        </div>
      </dl>

      {error ? <Note tone="error">{error}</Note> : null}
      <div className="flex flex-wrap justify-end gap-2 border-t border-[#326273]/12 pt-4">
        <QuietButton type="button" onClick={onBack}>Change the limits</QuietButton>
        <PrimaryButton type="button" onClick={onAsk} disabled={busy}>{busy ? 'Asking…' : 'Ask my owners to sign'}</PrimaryButton>
      </div>
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="dash-block p-3">
      <dt className="font-mono text-[12px] font-bold uppercase tracking-[0.12em] text-[#145d6a]">{label}</dt>
      <dd className="mt-1 text-sm font-bold tabular-nums text-[#0c3e48]">{value}</dd>
      {note ? <dd className="text-[13px] leading-5 text-[#326273]">{note}</dd> : null}
    </div>
  );
}

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { CircleCheck, CircleAlert, Hand, PauseCircle, PlayCircle } from 'lucide-react';

import LocalTime from '@/components/LocalTime';
import { call, errorText } from '@/components/transfer/api';
import { Field, Modal, PrimaryButton, QuietButton, TextInput } from '@/components/transfer/ui';
import { newKey, Note, Pill } from '@/components/wallet/parts';
import { formatUsdc } from '@/lib/fees/copy';
import { ALLOWANCE_DEFAULTS, allowanceProblems, allowanceSentence } from '@/lib/schedule/rules';
import type { AutomaticStatus } from '@/lib/schedule/views';
import { parseAmountMinor } from '@/lib/transfer/plan';

const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;

const ALLOWANCE_LABEL: Record<string, string> = { none: 'Not given', unreadable: 'Could not be read', active: 'In force', expired: 'Ended', not_started: 'Not started yet', revoked: 'Taken back' };

/**
 * Automatic payments (owners): whether Splash can pay with no one present, the
 * allowance the owners signed and what is left of it, the daily limit, and the
 * kill switch. The allowance is asked for here and signed by the owners'
 * passkeys like any spending rule; the kill switch is one owner, at once.
 */
export default function AutomaticPanel({ status, onChanged }: { status: AutomaticStatus; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
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

      <div className="mt-4 flex flex-wrap gap-2">
        <PrimaryButton type="button" onClick={() => setOpen(true)} disabled={!status.payer.ready}>
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

      <AllowanceModal open={open} onClose={() => setOpen(false)} onAsked={onChanged} status={status} />
    </section>
  );
}

function AllowanceModal({ open, onClose, onAsked, status }: { open: boolean; onClose: () => void; onAsked: () => void; status: AutomaticStatus }) {
  const [perPayment, setPerPayment] = useState(String(ALLOWANCE_DEFAULTS.perPaymentUsdc));
  const [daily, setDaily] = useState(String(ALLOWANCE_DEFAULTS.dailyUsdc));
  const [monthly, setMonthly] = useState(String(ALLOWANCE_DEFAULTS.monthlyUsdc));
  const [days, setDays] = useState(String(ALLOWANCE_DEFAULTS.expiresInDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  const parsed = { perPaymentMinor: parseAmountMinor(perPayment) ?? 0n, dailyMinor: parseAmountMinor(daily) ?? 0n, monthlyMinor: parseAmountMinor(monthly) ?? 0n, expiresInDays: Number(days) };
  const problems = allowanceProblems(parsed);

  async function ask() {
    setBusy(true);
    setError(null);
    const answer = await call('/api/wallet/schedules/automatic/allowance', {
      method: 'POST',
      key: newKey('allowance'),
      body: { perPaymentUsdc: perPayment, dailyUsdc: daily, monthlyUsdc: monthly, expiresInDays: parsed.expiresInDays },
    });
    setBusy(false);
    if (!answer.ok) setError(errorText(answer, 'The request was not made. Nothing changed.'));
    else {
      setAsked(true);
      onAsked();
    }
  }

  return (
    <Modal open={open} onClose={() => { setAsked(false); onClose(); }} title="Allowance for automatic payments" eyebrow="Your owners sign it">
      {asked ? (
        <div className="space-y-4">
          <p className="flex items-start gap-2 text-sm leading-6 text-[#0c3e48]"><CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#0d6370]" aria-hidden="true" />Your owners have been asked to sign it. Nothing is in force until they do, and you can take it back at any time.</p>
          <Link href="/dashboard/approve" className="inline-flex h-11 items-center rounded-xl bg-[#0d6370] px-5 text-sm font-bold text-white hover:bg-[#073d49]">Open approvals</Link>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (problems.length === 0) void ask(); }} className="space-y-4" noValidate>
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
            <p className="rounded-xl bg-[#F6F0ED] p-3 text-[13px] leading-5 text-[#1F4452]">{allowanceSentence(parsed)}</p>
          )}
          <Note>The monthly limit is held by the network itself. The daily limit is held by Splash. {status.dailyCapMinor !== '0' ? `Today it is ${usdc(status.dailyCapMinor)}.` : ''}</Note>
          {error ? <Note tone="error">{error}</Note> : null}
          <div className="flex flex-wrap justify-end gap-2 border-t border-[#326273]/12 pt-4">
            <QuietButton type="button" onClick={onClose}>Cancel</QuietButton>
            <PrimaryButton type="submit" disabled={busy || problems.length > 0}>{busy ? 'Asking…' : 'Ask my owners to sign'}</PrimaryButton>
          </div>
        </form>
      )}
    </Modal>
  );
}

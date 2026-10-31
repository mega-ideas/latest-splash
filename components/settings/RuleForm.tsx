'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, CircleDollarSign, Gauge } from 'lucide-react';

import { Field, PrimaryButton, QuietButton, Segmented, SelectInput, TextInput } from '@/components/transfer/ui';
import { Loading, Note, Pill } from '@/components/wallet/parts';
import { formatUsdc } from '@/lib/fees/copy';
import { defaultExpiry, ruleRequest, type RuleBody, type RuleForm as Form } from '@/lib/team-rules/form';
import { ruleSteps, validateStep, withRecipients, type RecipientPick } from '@/lib/team-rules/steps';
import { reviewSummary } from '@/lib/team-rules/summary';
import { shortAddress } from '@/lib/team-rules/words';
import type { PolicyLike } from '@/lib/team-rules/view';

export type StaffChoice = { userId: string; name: string; role: string; hasRule: boolean; /** false: no passkey on this site yet, so no rule can be given; undefined: not known. */ hasPasskey?: boolean };
export type RecipientOffers = {
  loading: boolean;
  error: string | null;
  allowed: Array<{ address: string; tag: string; name: string | null }>;
  offers: Array<{ id: string; name: string; address: string; tag: 'wallet' | 'exchange' }>;
};

const short = shortAddress;

/**
 * Give or change a spending rule, one question at a time (v2 §4.2; brief
 * 5.10: one question per screen on a phone). It is shown in a sheet, so on a
 * phone each question has the whole screen. What is typed is checked step by
 * step (lib/team-rules/steps.ts) and turned into the exact body the route
 * takes (lib/team-rules/form.ts); the last step reads the rule back in plain
 * words before anyone is asked to sign. A rule is for one staff member or
 * approver, names no address (the server uses the person's own passkey), and
 * ends at the close of the day chosen (UTC), within a year. Nothing here signs
 * or names a business.
 */
export default function RuleForm({ staff, policy, recipients, changing, initial, name, busy, error, onSubmit, onCancel }: {
  staff: StaffChoice[];
  policy: PolicyLike | null;
  recipients: RecipientOffers;
  changing: boolean;
  initial?: Partial<Form>;
  /** Whose rule is being changed. */
  name: string | null;
  busy: boolean;
  error: string | null;
  onSubmit: (body: RuleBody) => void;
  onCancel: () => void;
}) {
  const steps = useMemo(() => ruleSteps(changing), [changing]);
  const [at, setAt] = useState(0);
  const [form, setForm] = useState<Form>(() => ({ staffUserId: '', perPayment: '', period: 'day', cap: '', expires: defaultExpiry(new Date()), lifetimeCap: '', ...initial }));
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const policyMax = policy ? BigInt(policy.perPaymentMaxMinor) : null;
  const ctx = () => ({ now: new Date(), policyMaxMinor: policyMax });
  const step = steps[at];
  const choices = staff.filter((s) => (changing ? s.userId === form.staffUserId : !s.hasRule));
  const personName = changing ? name : staff.find((s) => s.userId === form.staffUserId)?.name ?? null;
  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  };

  // A new question starts at the top, with its first control ready (after the sheet has taken focus itself).
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const target = body.current?.querySelector<HTMLElement>('input:not([type="checkbox"]), select, [role="radio"][aria-checked="true"], [data-step-focus]');
      target?.focus({ preventScroll: true });
      body.current?.scrollIntoView({ block: 'nearest' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [at]);

  const picks: RecipientPick[] = recipients.offers.filter((o) => picked.includes(o.id)).map((o) => ({ address: o.address, tag: o.tag }));

  function complete(): RuleBody | null {
    const made = ruleRequest(form, ctx());
    if (!made.ok) {
      setErrors(made.errors);
      // Go back to the first question that is wrong.
      const wrong = steps.findIndex((s) => Object.keys(validateStep(s.id, form, ctx())).length > 0);
      if (wrong >= 0) setAt(wrong);
      return null;
    }
    return changing ? made.body : withRecipients(made.body, picks);
  }

  function next() {
    if (step.id === 'review') {
      const made = complete();
      if (made) onSubmit(made);
      return;
    }
    const wrong = validateStep(step.id, form, ctx());
    if (Object.keys(wrong).length > 0) {
      setErrors(wrong);
      return;
    }
    setErrors({});
    setAt((i) => Math.min(i + 1, steps.length - 1));
  }

  const lifetimeEmpty = form.lifetimeCap.trim() === '';
  const summary = step.id === 'review' ? (() => {
    const made = ruleRequest(form, ctx());
    return made.ok ? reviewSummary(changing ? made.body : withRecipients(made.body, picks), policy, personName, changing ? [] : recipients.offers.filter((o) => picked.includes(o.id)).map((o) => ({ name: o.name, address: o.address }))) : null;
  })() : null;
  const nextLabel = step.id === 'review'
    ? busy ? 'Asking your owners…' : changing ? 'Ask the owners to sign the change' : 'Ask the owners to sign'
    : step.id === 'lifetime' && lifetimeEmpty ? 'No total limit' : step.id === 'recipients' && picked.length === 0 ? 'Continue' : 'Next';

  return (
    <form
      noValidate
      aria-label={changing ? 'Change a spending rule' : 'Give a spending rule'}
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) next();
      }}
      className="flex min-h-[28rem] flex-col gap-5"
    >
      <div className="space-y-2">
        <p className="text-[13px] font-semibold text-[#1F4452]" aria-live="polite">
          Question {at + 1} of {steps.length}{personName && step.id !== 'who' ? ` for ${personName}` : ''}
        </p>
        <ol className="flex gap-1.5" aria-label="Questions">
          {steps.map((s, i) => (
            <li
              key={s.id}
              aria-current={i === at ? 'step' : undefined}
              aria-label={`${s.question}${i < at ? ' (answered)' : i === at ? ' (now)' : ''}`}
              className={`h-1.5 flex-1 rounded-full ${i < at ? 'bg-[#0d6370]' : i === at ? 'bg-[#0c3e48]' : 'bg-[#326273]/20'}`}
            />
          ))}
        </ol>
      </div>

      <div ref={body} className="flex-1 space-y-4">
        <div className="space-y-1.5">
          <h3 id={`rule-q-${step.id}`} className="text-lg font-extrabold leading-snug text-[#0c3e48]">{step.question}</h3>
          <p className="text-[13px] leading-5 text-[#326273]">{step.hint}</p>
        </div>

        {step.id === 'who' ? (
          <Field label="Person" error={errors.staffUserId} htmlFor="rule-staff">
            <SelectInput id="rule-staff" value={form.staffUserId} aria-describedby={`rule-q-${step.id}`} onChange={(e) => set('staffUserId', e.target.value)}>
              <option value="">{choices.length === 0 ? 'Everyone who can have a rule has one' : 'Choose a person'}</option>
              {choices.map((s) => (
                <option key={s.userId} value={s.userId} disabled={s.hasPasskey === false}>{s.hasPasskey === false ? `${s.name} (no passkey yet)` : s.name}</option>
              ))}
            </SelectInput>
          </Field>
        ) : null}

        {step.id === 'per_payment' ? (
          <Field label="Most one payment" hint="USDC" error={errors.perPayment} htmlFor="rule-per">
            <TextInput id="rule-per" icon={CircleDollarSign} inputMode="decimal" value={form.perPayment} onChange={(e) => set('perPayment', e.target.value)} autoComplete="off" aria-invalid={Boolean(errors.perPayment)} />
          </Field>
        ) : null}
        {step.id === 'per_payment' && policyMax !== null ? <p className="text-[13px] text-[#326273]">The business’s own limit for any one payment is {formatUsdc(policyMax)} USDC.</p> : null}

        {step.id === 'cap' ? (
          <div className="space-y-4">
            <Segmented label="How often the cap renews" value={form.period} options={[{ value: 'day', label: 'Every day' }, { value: 'month', label: 'Every month' }]} onChange={(v) => set('period', v)} />
            <Field label={form.period === 'month' ? 'Most in a month' : 'Most in a day'} hint="USDC" error={errors.cap} htmlFor="rule-cap">
              <TextInput id="rule-cap" icon={Gauge} inputMode="decimal" value={form.cap} onChange={(e) => set('cap', e.target.value)} autoComplete="off" aria-invalid={Boolean(errors.cap)} />
            </Field>
          </div>
        ) : null}

        {step.id === 'lifetime' ? (
          <Field label="Most in all" hint="USDC, optional" error={errors.lifetimeCap} htmlFor="rule-life">
            <TextInput id="rule-life" icon={CircleDollarSign} inputMode="decimal" value={form.lifetimeCap} onChange={(e) => set('lifetimeCap', e.target.value)} autoComplete="off" aria-invalid={Boolean(errors.lifetimeCap)} />
          </Field>
        ) : null}

        {step.id === 'recipients' ? (
          <div id="rule-recipients" data-step-focus tabIndex={-1} className="space-y-3 outline-none">
            <p className="text-[13px] leading-5 text-[#326273]">The list is the business’s, so it is the same for everyone with a rule. A recipient is on it only after an owner verified it.</p>
            {recipients.loading ? <Loading label="Reading your recipients…" /> : null}
            {recipients.error ? <Note tone="error">{recipients.error}</Note> : null}
            {recipients.allowed.length > 0 ? (
              <ul className="space-y-2" aria-label="Verified recipients">
                {recipients.allowed.map((a) => (
                  <li key={a.address} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#F6F0ED] px-3 py-2 text-sm text-[#1F4452]">
                    <span className="min-w-0"><span className="font-semibold">{a.name ?? 'Not in your saved recipients'}</span> <span className="font-mono text-[13px] text-[#326273]">{short(a.address)}</span></span>
                    <Pill tone="ok"><Check className="mr-1 h-3 w-3" aria-hidden="true" />{a.tag === 'exchange' ? 'Exchange' : 'Wallet'}</Pill>
                  </li>
                ))}
              </ul>
            ) : !recipients.loading ? <Note>No recipient is verified yet, so this person’s payments go to the owners until one is.</Note> : null}
            {recipients.offers.length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="text-[13px] font-semibold text-[#1F4452]">Also verify, with this rule</legend>
                {recipients.offers.map((o) => (
                  <label key={o.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border border-[#326273]/20 bg-white px-3 py-2 text-sm text-[#1F4452] has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[#0d6370]">
                    <input
                      type="checkbox"
                      checked={picked.includes(o.id)}
                      onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o.id] : p.filter((x) => x !== o.id)))}
                      className="h-5 w-5 shrink-0 accent-[#0d6370]"
                    />
                    <span className="min-w-0"><span className="font-semibold">{o.name}</span> <span className="font-mono text-[13px] text-[#326273]">{short(o.address)}</span></span>
                  </label>
                ))}
                <p className="text-[13px] leading-5 text-[#326273]">The owners verify them in the same request they sign for the rule.</p>
              </fieldset>
            ) : null}
          </div>
        ) : null}

        {step.id === 'ends' ? (
          <Field label="Last day of the rule" hint="UTC, within a year" error={errors.expires} htmlFor="rule-end">
            <TextInput id="rule-end" icon={CalendarDays} type="date" value={form.expires} onChange={(e) => set('expires', e.target.value)} aria-invalid={Boolean(errors.expires)} />
          </Field>
        ) : null}

        {step.id === 'review' ? (
          <div id="rule-review" data-step-focus tabIndex={-1} className="space-y-4 outline-none">
            {summary ? (
              <>
                <section aria-labelledby="rule-alone" className="space-y-1.5">
                  <h4 id="rule-alone" className="text-sm font-extrabold text-[#0c3e48]">{personName ?? 'They'} can pay alone</h4>
                  <ul className="list-disc space-y-1 pl-5 text-[13px] leading-5 text-[#1F4452]">
                    {summary.alone.map((l) => <li key={l}>{l}</li>)}
                  </ul>
                </section>
                <section aria-labelledby="rule-owners" className="space-y-1.5">
                  <h4 id="rule-owners" className="text-sm font-extrabold text-[#0c3e48]">What needs the owners</h4>
                  <ul className="list-disc space-y-1 pl-5 text-[13px] leading-5 text-[#1F4452]">
                    {summary.approval.map((l) => <li key={l}>{l}</li>)}
                  </ul>
                </section>
                {summary.added && summary.added.length > 0 ? (
                  <section aria-labelledby="rule-added" className="space-y-1.5">
                    <h4 id="rule-added" className="text-sm font-extrabold text-[#0c3e48]">Added for everyone with a rule</h4>
                    <ul className="list-disc space-y-1 pl-5 text-[13px] leading-5 text-[#1F4452]">
                      {summary.added.map((l) => <li key={l}>{l}</li>)}
                    </ul>
                    <p className="text-[13px] leading-5 text-[#326273]">The list is the business’s. Once the owners sign, every staff member and approver who has a rule can pay these recipients alone.</p>
                  </section>
                ) : null}
                {changing ? <Note>What was spent so far carries over to the new rule, so a change does not give a fresh allowance.</Note> : null}
              </>
            ) : <Note tone="error">Something in an earlier answer needs fixing. Go back.</Note>}
          </div>
        ) : null}
      </div>

      {error ? <Note tone="error">{error}</Note> : null}

      <div className="flex flex-wrap gap-2">
        <PrimaryButton type="submit" disabled={busy}>{nextLabel}</PrimaryButton>
        {at > 0 ? <QuietButton type="button" disabled={busy} onClick={() => { setErrors({}); setAt((i) => Math.max(0, i - 1)); }}>Back</QuietButton> : <QuietButton type="button" onClick={onCancel}>Cancel</QuietButton>}
      </div>
    </form>
  );
}

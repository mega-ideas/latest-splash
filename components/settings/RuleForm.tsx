'use client';

import { useState } from 'react';
import { CalendarDays, CircleDollarSign, Gauge } from 'lucide-react';

import { Field, PrimaryButton, QuietButton, SelectInput, TextInput } from '@/components/transfer/ui';
import { defaultExpiry, ruleRequest, type RuleBody, type RuleForm as Form } from '@/lib/team-rules/form';

export type StaffChoice = { userId: string; name: string; role: string; hasRule: boolean };

/**
 * Give or change a spending rule. What is typed is turned into the exact body
 * the route takes (lib/team-rules/form.ts) and checked field by field before
 * anything is asked of the owners. A rule is for one staff member or approver,
 * names no address (the server uses the person's own passkey), and ends at the
 * close of the day chosen (UTC), within a year.
 */
export default function RuleForm({ staff, policyMaxMinor, changing, initial, busy, error, onSubmit, onCancel }: {
  staff: StaffChoice[];
  policyMaxMinor: bigint | null;
  changing: boolean;
  initial?: Partial<Form>;
  busy: boolean;
  error: string | null;
  onSubmit: (body: RuleBody) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<Form>(() => ({ staffUserId: '', perPayment: '', period: 'day', cap: '', expires: defaultExpiry(new Date()), lifetimeCap: '', ...initial }));
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  const choices = staff.filter((s) => (changing ? s.userId === form.staffUserId : !s.hasRule));

  function submit() {
    const made = ruleRequest(form, { now: new Date(), policyMaxMinor });
    if (!made.ok) {
      setErrors(made.errors);
      return;
    }
    setErrors({});
    onSubmit(made.body);
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-4 rounded-2xl border border-[#326273]/15 bg-white p-4 sm:p-5"
    >
      <h3 className="text-base font-extrabold text-[#0c3e48]">{changing ? 'Change this rule' : 'Give a rule'}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="For" error={errors.staffUserId} htmlFor="rule-staff" className="sm:col-span-2">
          <SelectInput id="rule-staff" value={form.staffUserId} disabled={changing} onChange={(e) => set('staffUserId', e.target.value)}>
            <option value="">{choices.length === 0 ? 'Everyone who can have a rule has one' : 'Choose a staff member'}</option>
            {choices.map((s) => (
              <option key={s.userId} value={s.userId}>{s.name}</option>
            ))}
          </SelectInput>
        </Field>
        <Field label="Most one payment may be" hint="USDC" error={errors.perPayment} htmlFor="rule-per" >
          <TextInput id="rule-per" icon={CircleDollarSign} inputMode="decimal" value={form.perPayment} onChange={(e) => set('perPayment', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Cap" hint="USDC" error={errors.cap} htmlFor="rule-cap">
          <TextInput id="rule-cap" icon={Gauge} inputMode="decimal" value={form.cap} onChange={(e) => set('cap', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="The cap renews" htmlFor="rule-period">
          <SelectInput id="rule-period" value={form.period} onChange={(e) => set('period', e.target.value === 'month' ? 'month' : 'day')}>
            <option value="day">Every day</option>
            <option value="month">Every month</option>
          </SelectInput>
        </Field>
        <Field label="Last day of the rule" hint="UTC, within a year" error={errors.expires} htmlFor="rule-end">
          <TextInput id="rule-end" icon={CalendarDays} type="date" value={form.expires} onChange={(e) => set('expires', e.target.value)} />
        </Field>
        <Field label="Lifetime cap (optional)" hint="USDC, in all" error={errors.lifetimeCap} htmlFor="rule-life" className="sm:col-span-2">
          <TextInput id="rule-life" icon={CircleDollarSign} inputMode="decimal" value={form.lifetimeCap} onChange={(e) => set('lifetimeCap', e.target.value)} autoComplete="off" />
        </Field>
      </div>
      <p className="text-[13px] leading-5 text-[#326273]">
        Inside this rule the person pays alone, to recipients you have allowed, from their own device. Anything outside it goes to the owners. The cap counts each payment plus the most its fee could be.
      </p>
      {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <PrimaryButton type="submit" disabled={busy}>{busy ? 'Asking your owners…' : changing ? 'Ask the owners to sign the change' : 'Ask the owners to sign'}</PrimaryButton>
        <QuietButton type="button" onClick={onCancel}>Cancel</QuietButton>
      </div>
    </form>
  );
}

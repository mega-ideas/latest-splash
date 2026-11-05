'use client';

import { useState } from 'react';
import { Building2, Check, CircleHelp, Hash, Landmark, MapPin, UserRound } from 'lucide-react';

import { BANK_BLANK, type BankErrors, type BankForm } from '@/lib/transfer/bank-form';
import { BANK_COUNTRIES, RELATIONSHIP_OPTIONS, corridorAccess } from '@/lib/transfer/payee';
import type { Beneficiary } from './api';
import { saveBeneficiary } from './bank-save';
import PilotAccess from './PilotAccess';
import RequirementsSheet from './RequirementsSheet';
import { Field, PrimaryButton, QuietButton, Segmented, SelectInput, TextInput } from './ui';
import type { StepProps } from './flow';

/** Step 2 for a bank: a saved supplier, or a new one. One list of fields, one input height, one icon gutter. */
export default function DetailsBank({ flow, patch, ctx, beneficiaries, reload }: Pick<StepProps, 'flow' | 'patch' | 'ctx' | 'beneficiaries' | 'reload'>) {
  const owner = ctx?.role === 'OWNER';
  const [adding, setAdding] = useState(beneficiaries.length === 0);
  const [form, setForm] = useState<BankForm>(BANK_BLANK);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<BankErrors>({});
  const set = <K extends keyof BankForm>(key: K, value: BankForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const access = corridorAccess(form.country);
  const chosenId = flow.chosen?.kind === 'bank' ? flow.chosen.beneficiaryId : null;

  const choose = (b: Beneficiary) =>
    patch({ chosen: { kind: 'bank', beneficiaryId: b.id, name: b.holderName, country: b.country, currency: b.currency, last4: b.last4 } });

  async function save() {
    setBusy(true);
    const saved = await saveBeneficiary(form);
    setBusy(false);
    if (!saved.ok) {
      setErrors(saved.errors);
      return;
    }
    setErrors({});
    choose(saved.beneficiary);
    setAdding(false);
    setForm(BANK_BLANK);
    reload();
  }

  return (
    <div className="space-y-5">
      {beneficiaries.length > 0 ? (
        <fieldset>
          <legend className="text-[13px] font-semibold text-[#1F4452]">Saved supplier accounts</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {beneficiaries.map((b) => {
              const on = chosenId === b.id;
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => choose(b)}
                  className={`flex min-h-[64px] items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0d6370] bg-[#f4f8fa] shadow-[inset_3px_0_0_#0d6370]' : 'border-[#326273]/20 bg-white hover:border-[#0d6370]/60'}`}
                >
                  <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${on ? 'bg-[#0d6370] text-white' : 'bg-[#eef4f5] text-[#145d6a]'}`}>
                    {on ? <Check className="h-4 w-4" aria-hidden="true" /> : <Landmark className="h-4 w-4" aria-hidden="true" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-bold text-[#0c3e48]">{b.holderName}</span>
                    <span className="block truncate text-[13px] text-[#326273]">{b.country} · {b.currency} · {b.bankCode} ••{b.last4}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {!adding ? (
            <QuietButton type="button" className="mt-3" onClick={() => setAdding(true)} disabled={!owner} title={owner ? undefined : 'An owner adds supplier accounts'}>
              Add another supplier account
            </QuietButton>
          ) : null}
        </fieldset>
      ) : null}

      {adding && !owner ? (
        <p className="rounded-xl border border-[#326273]/15 bg-white p-4 text-sm text-[#1F4452]">
          Only an owner can add a supplier&rsquo;s bank account. Ask an owner to add it in Recipients, then come back to pay it.
        </p>
      ) : null}

      {adding && owner ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="space-y-5 rounded-2xl border border-[#326273]/15 bg-white p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-extrabold text-[#0c3e48]">Add a supplier&rsquo;s bank account</h3>
            {access === 'live' ? (
              <button
                type="button"
                onClick={() => setSheet(true)}
                className="inline-flex h-11 items-center gap-2 rounded-xl border border-[#0d6370]/40 bg-[#f4f8fa] px-4 text-sm font-bold text-[#0d6370] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]"
              >
                <CircleHelp className="h-4 w-4" aria-hidden="true" />
                What&rsquo;s needed for {form.country}
              </button>
            ) : null}
          </div>

          <div>
            <span className="text-[13px] font-semibold text-[#1F4452]">Country of the bank</span>
            <div role="radiogroup" aria-label="Country of the bank" className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {BANK_COUNTRIES.map((c) => {
                const on = form.country === c.country;
                return (
                  <button
                    key={c.country}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set('country', c.country)}
                    className={`flex h-14 flex-col justify-center rounded-xl border px-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0c3e48] bg-[#0c3e48] text-white' : 'border-[#326273]/20 bg-white text-[#1F4452] hover:border-[#0d6370]/60'}`}
                  >
                    <span className="text-sm font-bold">{c.name}</span>
                    <span className={`text-[12px] font-semibold ${on ? 'text-[#bfe6ee]' : 'text-[#326273]'}`}>{c.currency}{c.access === 'pilot' ? ' · Pilot access' : ''}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {access === 'pilot' ? (
            <PilotAccess country={form.country} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[13px] font-semibold text-[#1F4452]">Paying a</span>
                <Segmented label="Business or person" value={form.holder} onChange={(v) => set('holder', v)} options={[{ value: 'business', label: 'Business' }, { value: 'person', label: 'Person' }]} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Registered name on the account" error={errors.holderName} htmlFor="b-holder" className="sm:col-span-2">
                  <TextInput id="b-holder" icon={form.holder === 'business' ? Building2 : UserRound} value={form.holderName} onChange={(e) => set('holderName', e.target.value)} autoComplete="off" />
                </Field>
                {form.holder === 'business' ? (
                  <Field label="Company registration number" error={errors.registrationNumber} htmlFor="b-reg">
                    <TextInput id="b-reg" icon={Hash} value={form.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} autoComplete="off" />
                  </Field>
                ) : null}
                <Field label="Relationship to you" htmlFor="b-rel">
                  <SelectInput id="b-rel" value={form.relationship} onChange={(e) => set('relationship', e.target.value)}>
                    {RELATIONSHIP_OPTIONS.map((o) => (
                      <option key={o.code} value={o.code}>{o.label}</option>
                    ))}
                  </SelectInput>
                </Field>
                <Field label="Bank code" error={errors.bankCode} htmlFor="b-bank">
                  <TextInput id="b-bank" icon={Landmark} mono value={form.bankCode} onChange={(e) => set('bankCode', e.target.value.toUpperCase())} autoComplete="off" />
                </Field>
                <Field label="Account number" error={errors.accountNumber} htmlFor="b-acct">
                  <TextInput id="b-acct" icon={Hash} mono inputMode="numeric" value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Street" htmlFor="b-street" className="sm:col-span-2">
                  <TextInput id="b-street" icon={MapPin} value={form.street} onChange={(e) => set('street', e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Town or city" error={errors.city} htmlFor="b-city">
                  <TextInput id="b-city" icon={MapPin} value={form.city} onChange={(e) => set('city', e.target.value)} autoComplete="off" />
                </Field>
                <Field label="Postcode" hint="Optional" htmlFor="b-post">
                  <TextInput id="b-post" icon={MapPin} value={form.postCode} onChange={(e) => set('postCode', e.target.value)} autoComplete="off" />
                </Field>
              </div>
              {errors.form ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{errors.form}</p> : null}
              <div className="flex flex-wrap gap-2">
                <PrimaryButton type="submit" disabled={busy}>{busy ? 'Checking with the bank…' : 'Check and save account'}</PrimaryButton>
                {beneficiaries.length > 0 ? <QuietButton type="button" onClick={() => setAdding(false)}>Cancel</QuietButton> : null}
              </div>
              <p className="text-[13px] leading-5 text-[#326273]">The bank&rsquo;s own name for the account must match the name you gave. The account number is stored encrypted, and only its last four digits are shown after it is saved.</p>
            </>
          )}
        </form>
      ) : null}
      <RequirementsSheet country={form.country} open={sheet} onClose={() => setSheet(false)} />
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Building2,
  CircleAlert,
  CircleHelp,
  Landmark,
  MapPin,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';

import type { TravelRuleBeneficiary } from '@/lib/server/operations';

/**
 * What has to travel with the payment.
 *
 * Splash collected a name, an account number and an optional SWIFT code. A
 * partner filing a FATF R.16 record needs considerably more, and which "more"
 * depends entirely on where the money lands: the Philippines routes on a
 * PESONet bank code, Singapore wants a bank AND a branch, the eurozone folds
 * the account into an IBAN and asking for both invites a mismatch.
 *
 * ─── The fields are not hardcoded here ──────────────────────────────────────
 *
 * Every requirement comes from `/api/compliance/travel-rule`, which is
 * `lib/compliance/travel-rule.ts` — the same module the authorize route
 * validates against and `travelRuleSnapshot` freezes. A corridor added there
 * appears here with no change to this file, and the form cannot ask for
 * something different from what the server will accept. Duplicating the rules
 * in a component is how a form starts demanding a field nobody checks, or
 * omitting one everybody does.
 *
 * ─── Every requirement says why ─────────────────────────────────────────────
 *
 * An operator asked for a beneficiary's date of birth will want to know why,
 * and "required" is not an answer — it is how a field gets filled with
 * 01/01/1970. The engine returns a `because` for each one, in the payer's
 * words, and it is on screen rather than in a tooltip nobody opens.
 */

export type TravelRulePayment = {
  purposeCode?: string;
  purposeDescription?: string;
  sourceOfFunds?: string;
  beneficiaryRelationship?: string;
};

type Requirement = { field: string; label: string; because: string };

type CorridorInfo = {
  country: string;
  currency: string;
  note: string;
  requiresBranchCode: boolean;
  requiresPurposeCode: boolean;
  requiresAccountNumber: boolean;
  schemes: Array<{ scheme: string; label: string }>;
};

type CheckResponse = {
  corridor: CorridorInfo | null;
  missing: Requirement[];
  originator: { complete: boolean; legalName: string | null; missing: Requirement[] };
  ready: boolean;
};

const INPUT =
  'w-full rounded-xl border border-[#326273]/15 bg-[#F6F0ED] px-3 py-3 text-sm text-[#326273] outline-none placeholder:text-[#326273]/35 focus:border-[#5C9EAD]';
const MONO = `${INPUT} font-mono uppercase placeholder:font-sans placeholder:normal-case`;

export default function TravelRuleFields({
  country,
  value,
  payment,
  onChange,
  onPaymentChange,
  onReadyChange,
  showErrors,
}: {
  country: string;
  value: TravelRuleBeneficiary;
  payment: TravelRulePayment;
  onChange: (next: TravelRuleBeneficiary) => void;
  onPaymentChange: (next: TravelRulePayment) => void;
  onReadyChange: (ready: boolean) => void;
  showErrors: boolean;
}) {
  const [check, setCheck] = useState<CheckResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  const set = useCallback(
    (patch: Partial<TravelRuleBeneficiary>) => onChange({ ...value, ...patch }),
    [onChange, value],
  );

  // Debounced: this runs on every keystroke and the answer only matters once
  // typing pauses. Stale responses are dropped by sequence number rather than
  // by aborting, so a slow reply cannot overwrite a newer one.
  useEffect(() => {
    const seq = ++latest.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/compliance/travel-rule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ destinationCountry: country, beneficiary: value, payment }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as CheckResponse;
        if (seq === latest.current) setCheck(data);
      } catch {
        // Leave the last good answer on screen. A network blip must not make
        // the form claim a payment is ready when it has not been checked.
      } finally {
        if (seq === latest.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [country, value, payment]);

  useEffect(() => {
    // Unchecked is NOT ready. Until the server has answered, the step stays
    // gated — the alternative is a form that lets a payment through in the gap
    // before the first response lands.
    onReadyChange(Boolean(check?.ready));
  }, [check, onReadyChange]);

  const corridor = check?.corridor ?? null;
  const isIndividual = value.beneficiaryType === 'INDIVIDUAL';
  const missingByField = useMemo(
    () => new Map((check?.missing ?? []).map((item) => [item.field, item])),
    [check],
  );
  const errorFor = (field: string) =>
    showErrors ? missingByField.get(`beneficiary.${field}`)?.label ?? null : null;
  // Payment context is namespaced `payment.` by the engine. Looking these up
  // under `beneficiary.` silently matched nothing, so a required purpose code
  // showed no error while blocking the step.
  const paymentErrorFor = (field: string) =>
    showErrors ? missingByField.get(`payment.${field}`)?.label ?? null : null;
  const requiredByCorridor = (field: string) => missingByField.has(`payment.${field}`);

  const schemeOptions = corridor?.schemes ?? [];
  const activeScheme = value.bankIdScheme ?? schemeOptions[0]?.scheme ?? '';
  const activeSchemeLabel =
    schemeOptions.find((s) => s.scheme === activeScheme)?.label ?? 'Bank identifier';

  return (
    <div className="space-y-5">
      {/* What this corridor asks, in its own words. */}
      {corridor && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[#5C9EAD]/25 bg-[#5C9EAD]/8 px-3.5 py-3">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#0d6370]" aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-[#0C3E48]">
              Paying into {corridor.country} · {corridor.currency}
            </p>
            <p className="mt-0.5 text-[13px] leading-relaxed text-[#326273]/80">{corridor.note}</p>
          </div>
        </div>
      )}

      {/* The payer's own half. Not asked for here — fixed once, in the profile. */}
      {check && !check.originator.complete && (
        <div className="rounded-xl border border-[#9b4e32]/25 bg-[#9b4e32]/6 px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#9b4e32]">
            <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" />
            Your own business details are incomplete
          </p>
          <p className="mt-1 text-[13px] leading-relaxed text-[#326273]/80">
            The travel rule sends the payer&rsquo;s identity alongside the beneficiary&rsquo;s. These
            are set once and reused on every payment, so they live in your business profile rather
            than in this form.
          </p>
          <ul className="mt-2 space-y-1">
            {check.originator.missing.map((item) => (
              <li key={item.field} className="text-[13px] text-[#326273]">
                <span className="font-semibold">{item.label}</span>
                <span className="text-[#326273]/70"> — {item.because}</span>
              </li>
            ))}
          </ul>
          <Link
            href="/settings/kyb"
            className="mt-2 inline-block text-[13px] font-semibold text-[#0d6370] underline-offset-2 hover:underline"
          >
            Complete your business profile
          </Link>
        </div>
      )}

      {/* ── Who they are ───────────────────────────────────────────────────── */}
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">
          Who you are paying
        </h4>
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <div
              className="grid grid-cols-2 rounded-xl border border-[#326273]/12 bg-[#F6F0ED] p-1 text-[13px] font-bold"
              role="radiogroup"
              aria-label="Beneficiary type"
            >
              {(
                [
                  { key: 'BUSINESS' as const, label: 'A business', Icon: Building2 },
                  { key: 'INDIVIDUAL' as const, label: 'A person', Icon: UserRound },
                ]
              ).map(({ key, label, Icon }) => {
                const on = value.beneficiaryType === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set({ beneficiaryType: key })}
                    className={`flex items-center justify-center gap-1.5 rounded-lg py-2 transition ${
                      on ? 'bg-white text-[#0C3E48] shadow-sm' : 'text-[#326273]/60 hover:text-[#326273]'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <TrField label="Registered legal name" error={errorFor('legalName')} className="sm:col-span-2">
            <input
              className={INPUT}
              value={value.legalName ?? ''}
              onChange={(e) => set({ legalName: e.target.value })}
              placeholder={isIndividual ? 'Full name as on their ID' : 'Name exactly as registered'}
            />
          </TrField>

          {isIndividual ? (
            <>
              <TrField label="Date of birth" error={errorFor('dateOfBirth')}>
                <input
                  type="date"
                  className={INPUT}
                  value={value.dateOfBirth ?? ''}
                  onChange={(e) => set({ dateOfBirth: e.target.value })}
                />
              </TrField>
              <TrField label="National ID number" error={errorFor('nationalIdNumber')}>
                <input
                  className={INPUT}
                  value={value.nationalIdNumber ?? ''}
                  onChange={(e) => set({ nationalIdNumber: e.target.value })}
                  placeholder="As printed on the document"
                />
              </TrField>
            </>
          ) : (
            <TrField
              label="Company registration number"
              error={errorFor('registrationNumber')}
              className="sm:col-span-2"
            >
              <input
                className={INPUT}
                value={value.registrationNumber ?? ''}
                onChange={(e) => set({ registrationNumber: e.target.value })}
                placeholder="SSM, UEN, DTI, NPWP — whichever their registry issues"
              />
            </TrField>
          )}
        </div>
      </section>

      {/* ── Where they are ─────────────────────────────────────────────────── */}
      <section>
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">
          <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
          Their registered address
        </h4>
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          <TrField label="Street address" error={errorFor('addressLine1')} className="sm:col-span-2">
            <input
              className={INPUT}
              value={value.addressLine1 ?? ''}
              onChange={(e) => set({ addressLine1: e.target.value })}
              placeholder="Unit, building, street"
            />
          </TrField>
          <TrField label="City" error={errorFor('addressCity')}>
            <input
              className={INPUT}
              value={value.addressCity ?? ''}
              onChange={(e) => set({ addressCity: e.target.value })}
            />
          </TrField>
          <TrField label="State or province" hint="Optional">
            <input
              className={INPUT}
              value={value.addressState ?? ''}
              onChange={(e) => set({ addressState: e.target.value })}
            />
          </TrField>
          <TrField label="Postal code" hint="Optional">
            <input
              className={INPUT}
              value={value.addressPostalCode ?? ''}
              onChange={(e) => set({ addressPostalCode: e.target.value })}
            />
          </TrField>
          <TrField label="Country" error={errorFor('addressCountry')}>
            <input
              className={MONO}
              value={value.addressCountry ?? ''}
              onChange={(e) => set({ addressCountry: e.target.value.toUpperCase().slice(0, 2) })}
              placeholder="PH"
              maxLength={2}
            />
          </TrField>
        </div>
      </section>

      {/* ── How the money routes ───────────────────────────────────────────── */}
      <section>
        <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">
          <Landmark className="h-3.5 w-3.5" aria-hidden="true" />
          How the money reaches them
        </h4>
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          {schemeOptions.length > 1 && (
            <TrField label="Routing identifier" className="sm:col-span-2">
              <select
                className={INPUT}
                value={activeScheme}
                onChange={(e) => set({ bankIdScheme: e.target.value })}
              >
                {schemeOptions.map((option) => (
                  <option key={option.scheme} value={option.scheme}>
                    {option.label}
                  </option>
                ))}
              </select>
            </TrField>
          )}

          <TrField label="Bank name" error={errorFor('bankName')} className="sm:col-span-2">
            <input
              className={INPUT}
              value={value.bankName ?? ''}
              onChange={(e) => set({ bankName: e.target.value })}
              placeholder="BDO Unibank"
            />
          </TrField>

          <TrField label={activeSchemeLabel} error={errorFor('bankIdValue')}>
            <input
              className={MONO}
              value={value.bankIdValue ?? ''}
              onChange={(e) => set({ bankIdValue: e.target.value.toUpperCase(), bankIdScheme: activeScheme })}
              placeholder={activeSchemeLabel}
            />
          </TrField>

          {corridor?.requiresBranchCode && (
            <TrField label="Branch code" error={errorFor('bankBranchCode')}>
              <input
                className={MONO}
                value={value.bankBranchCode ?? ''}
                onChange={(e) => set({ bankBranchCode: e.target.value.toUpperCase() })}
              />
            </TrField>
          )}

          {corridor?.requiresAccountNumber !== false && (
            <TrField label="Account number" error={errorFor('bankAccountNumber')}>
              <input
                className={`${INPUT} font-mono`}
                value={value.bankAccountNumber ?? ''}
                onChange={(e) => set({ bankAccountNumber: e.target.value })}
                inputMode="numeric"
              />
            </TrField>
          )}

          <TrField
            label="Account holder name"
            error={errorFor('bankAccountName')}
            hint="As the bank has it"
          >
            <input
              className={INPUT}
              value={value.bankAccountName ?? ''}
              onChange={(e) => set({ bankAccountName: e.target.value })}
              placeholder="Exactly as it appears on the account"
            />
          </TrField>

          <TrField label="Bank country" hint="If different" >
            <input
              className={MONO}
              value={value.bankCountry ?? ''}
              onChange={(e) => set({ bankCountry: e.target.value.toUpperCase().slice(0, 2) })}
              placeholder={country}
              maxLength={2}
            />
          </TrField>
        </div>
      </section>

      {/* ── Why you are paying ─────────────────────────────────────────────── */}
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">
          Why you are paying
        </h4>
        <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
          {corridor?.requiresPurposeCode && (
            <TrField label="Purpose code" error={paymentErrorFor('purposeCode')}>
              <input
                className={MONO}
                value={payment.purposeCode ?? ''}
                onChange={(e) => onPaymentChange({ ...payment, purposeCode: e.target.value.toUpperCase() })}
                placeholder="As your partner specifies"
              />
            </TrField>
          )}
          <TrField
            label="What the payment is for"
            error={paymentErrorFor('purposeDescription')}
            className={corridor?.requiresPurposeCode ? '' : 'sm:col-span-2'}
          >
            <input
              className={INPUT}
              value={payment.purposeDescription ?? ''}
              onChange={(e) => onPaymentChange({ ...payment, purposeDescription: e.target.value })}
              placeholder="Invoice 4471 — component supply"
            />
          </TrField>
          {/* Not labelled "Optional": several corridors require these, and the
              engine is what knows which. A hint that contradicts the rule is
              how a form tells someone a field is optional and then refuses. */}
          <TrField
            label="Source of funds"
            error={paymentErrorFor('sourceOfFunds')}
            hint={requiredByCorridor('sourceOfFunds') ? undefined : 'Optional'}
          >
            <input
              className={INPUT}
              value={payment.sourceOfFunds ?? ''}
              onChange={(e) => onPaymentChange({ ...payment, sourceOfFunds: e.target.value })}
              placeholder="Trading revenue"
            />
          </TrField>
          <TrField
            label="Your relationship"
            error={paymentErrorFor('beneficiaryRelationship')}
            hint={requiredByCorridor('beneficiaryRelationship') ? undefined : 'Optional'}
          >
            <input
              className={INPUT}
              value={payment.beneficiaryRelationship ?? ''}
              onChange={(e) => onPaymentChange({ ...payment, beneficiaryRelationship: e.target.value })}
              placeholder="Supplier since 2024"
            />
          </TrField>
        </div>
      </section>

      {/* What is still missing, and why each one is asked. */}
      {check && check.missing.length > 0 && (
        <div className="rounded-xl border border-[#326273]/15 bg-[#F6F0ED] px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#0C3E48]">
            <CircleHelp className="h-3.5 w-3.5 text-[#326273]/50" aria-hidden="true" />
            Still needed for {corridor?.country ?? country}
            {loading && <span className="font-normal text-[#326273]/45">· checking</span>}
          </p>
          <ul className="mt-2 space-y-1.5">
            {check.missing.map((item) => (
              <li key={item.field} className="text-[13px] leading-relaxed">
                <span className="font-semibold text-[#326273]">{item.label}</span>
                <span className="text-[#326273]/70"> — {item.because}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {check?.ready && (
        <p className="flex items-center gap-1.5 text-[13px] font-semibold text-[#2e7d6b]">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Everything this corridor requires is present.
        </p>
      )}
    </div>
  );
}

function TrField({
  label,
  hint,
  error,
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-xs font-semibold uppercase tracking-[0.1em] text-[#326273]/55">
          {label}
        </label>
        {hint && <span className="text-[13px] font-semibold text-[#326273]/35">{hint}</span>}
      </div>
      <div className="mt-1.5">{children}</div>
      {error && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[13px] font-semibold text-[#9b4e32]">
          <CircleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> {error}
        </p>
      )}
    </div>
  );
}

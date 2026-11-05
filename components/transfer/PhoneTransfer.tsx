'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, CircleHelp, Landmark, Loader2, Wallet, X } from 'lucide-react';

import PhoneBar from '@/components/dashboard/PhoneBar';
import { formatUsdc, kindPrice } from '@/lib/fees/copy';
import { FEE_KIND } from '@/lib/fees/schedule';
import { usePublishedFees } from '@/lib/fees/use-published-pricing';
import { checkPayeeField } from '@/lib/transfer/addresses';
import { BANK_BLANK, type BankErrors, type BankForm } from '@/lib/transfer/bank-form';
import { BANK_COUNTRIES, PAYEE_CARDS, PURPOSE_OPTIONS, RELATIONSHIP_OPTIONS, SOURCE_OPTIONS, type PayeeKind } from '@/lib/transfer/payee';
import { defaultScreen, nextScreen, prevScreen, progressOf, screenReady, screensFor, stepOf, type PhoneState, type Screen } from '@/lib/transfer/phone-steps';
import type { Beneficiary, Context, SavedRecipient } from './api';
import { useAmountPlan } from './amount-plan';
import { saveBeneficiary } from './bank-save';
import DetailsBusiness from './DetailsBusiness';
import DetailsWallet from './DetailsWallet';
import type { Balance, Chosen, Flow, Made } from './flow';
import PilotAccess from './PilotAccess';
import RequirementsSheet from './RequirementsSheet';
import StepReceipt from './StepReceipt';
import StepReview from './StepReview';
import TopUpPanel from './TopUpPanel';

/** A control a thumb can hit and a phone will not zoom the page for: 56px tall, 17px type. */
const PHONE_INPUT = 'h-14 w-full rounded-xl border border-[#326273]/25 bg-white px-4 text-[17px] text-[#0c3e48] outline-none transition-colors placeholder:text-[#326273] focus:border-[#0d6370] focus:ring-2 focus:ring-[#0d6370]/20';

/** One heading and one line of help per question. Review and the receipt carry their own. */
const QUESTION: Record<Exclude<Screen, 'receipt' | 'review'>, { title: string; hint?: string }> = {
  'who': { title: 'Who are you paying?', hint: 'This decides the questions that follow.' },
  'supplier': { title: 'Which supplier?', hint: 'A supplier’s business bank account. They are paid in local currency.' },
  'business': { title: 'Which business on Splash?', hint: 'Search by registered name. There is no account number to type.' },
  'address': { title: 'Where does the USDC go?', hint: 'An address you save once and check once. Payments on Sui are final.' },
  'b.country': { title: 'Which country is the bank in?' },
  'b.holder': { title: 'Who holds the account?' },
  'b.name': { title: 'What name does the bank hold on the account?', hint: 'The bank checks this against the account before it is saved.' },
  'b.registration': { title: 'What is the company registration number?' },
  'b.bank': { title: 'What is the bank code?' },
  'b.account': { title: 'What is the account number?', hint: 'Digits only. Only the last four are shown once it is saved.' },
  'b.city': { title: 'Which town or city is the supplier in?' },
  'b.relationship': { title: 'How do you know them?' },
  'b.confirm': { title: 'Check and save the account', hint: 'The bank’s own name for the account must match the name you gave.' },
  'amount': { title: 'How much?' },
  'purpose': { title: 'What is the payment for?' },
  'source': { title: 'Where does the money come from?' },
  'reference': { title: 'Is there an invoice or reference?', hint: 'Optional. It goes on the receipt.' },
};

export type PhoneTransferProps = {
  ctxState: 'loading' | 'ok' | 'denied' | 'failed';
  flow: Flow;
  patch: (change: Partial<Flow>) => void;
  go: (step: Flow['step']) => void;
  ctx: Context | null;
  balance: Balance;
  recipients: SavedRecipient[];
  beneficiaries: Beneficiary[];
  reload: () => void;
  made: Made | null;
  onMade: (m: Made) => void;
  onExecuted: (digest: string | null) => void;
  onRestart: () => void;
  receiptRef: string | null;
  topUpId: string | null;
  onTopUp: (id: string | null) => void;
  onHow: () => void;
};

/**
 * Transfer on a phone (v2 brief 5.10): one question per screen. The order of
 * the screens and what each needs is lib/transfer/phone-steps.ts; the state,
 * the draft, the quote, the fee bound, the intent id as the idempotency key
 * and the signing are the desktop flow's own (TransferFlow and StepReview), so
 * walking back and forward never makes a second payment, and this file makes
 * no payment of its own. It asks the questions, shows the answer to each, and
 * gives one 56px button at the foot.
 */
export default function PhoneTransfer(props: PhoneTransferProps) {
  const { ctxState, flow, patch, go, ctx, balance, recipients, beneficiaries, reload, made, receiptRef, topUpId, onTopUp, onHow } = props;
  const router = useRouter();
  const owner = ctx?.role === 'OWNER';
  const [micro, setMicro] = useState<Screen | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<BankForm>(BANK_BLANK);
  const [errors, setErrors] = useState<BankErrors>({});
  const [saving, setSaving] = useState(false);
  const [sheet, setSheet] = useState(false);
  // Review is sending the request: Back is off until it has answered, so the screen is not left under it.
  const [sending, setSending] = useState(false);
  const plan = useAmountPlan(flow, balance);
  const heading = useRef<HTMLHeadingElement>(null);
  const set = <K extends keyof BankForm>(key: K, value: BankForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const state: PhoneState = { payeeType: flow.payeeType, adding, holder: form.holder, owner };
  const list = screensFor(state);
  // The screen is the step's own question, or the one the person walked to inside the step.
  const screen: Screen = micro && stepOf(micro) === flow.step && list.includes(micro) ? micro : defaultScreen(flow.step, state);
  const progress = progressOf(screen, state);
  const { funds } = plan;
  const fundsOk = funds?.enough === true;
  const accountCheck = checkPayeeField('bank', form.accountNumber);
  const ready = screenReady(screen, { payeeType: flow.payeeType, chosen: flow.chosen, amountText: flow.amountText, purposeCode: flow.purposeCode, sourceOfFunds: flow.sourceOfFunds, fundsOk, bank: form });

  // A new question is announced: focus moves to its heading, except where the question is a field that takes focus itself.
  const firstScreen = useRef(true);
  useEffect(() => {
    if (firstScreen.current) {
      firstScreen.current = false;
      return;
    }
    if (!TEXT_SCREENS.has(screen)) heading.current?.focus({ preventScroll: true });
  }, [screen]);

  function goTo(target: Screen) {
    // Back to the list of suppliers leaves the form: what was typed is kept, the questions are not asked again.
    if (target === 'supplier') setAdding(false);
    setMicro(target);
    go(stepOf(target));
  }
  const forward = nextScreen(screen, state);
  const back = prevScreen(screen, state);
  const choose = (chosen: Chosen) => patch({ chosen });

  async function save() {
    setSaving(true);
    const saved = await saveBeneficiary(form);
    setSaving(false);
    if (!saved.ok) {
      setErrors(saved.errors);
      return;
    }
    const b = saved.beneficiary;
    setErrors({});
    choose({ kind: 'bank', beneficiaryId: b.id, name: b.holderName, country: b.country, currency: b.currency, last4: b.last4 });
    setAdding(false);
    setForm(BANK_BLANK);
    reload();
    setMicro('amount');
    go(3);
  }

  function restart() {
    setAdding(false);
    setForm(BANK_BLANK);
    setErrors({});
    setMicro(null);
    props.onRestart();
  }

  if (ctxState === 'loading') return <p role="status" className="dash-surface flex items-center gap-2 p-4 text-sm text-[#326273]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</p>;
  if (ctxState === 'denied') return <p role="alert" className="dash-surface p-4 text-sm font-medium text-[var(--error)]">You do not have a place in a business here yet, so there is nothing to pay from.</p>;
  if (ctxState === 'failed') return <p role="alert" className="dash-surface p-4 text-sm font-medium text-[var(--error)]">Splash could not load your business just now. Nothing was sent. Try again in a moment.</p>;

  const paid = screen === 'receipt';
  // Once the request is made, what was asked is what is out for signature: no Back, so the draft cannot be changed under it.
  const sent = made !== null;
  const shared = { flow, patch, ctx, balance, recipients, beneficiaries, reload };

  return (
    <div className="mx-auto w-full max-w-lg" data-testid="phone-transfer">
      {!paid && !sent ? (
        <div className="mb-4">
          <div className="flex items-center justify-between gap-2">
            {back ? (
              <button type="button" aria-label="Back" disabled={sending} onClick={() => goTo(back)} className={ICON_BUTTON}><ArrowLeft className="h-5 w-5" aria-hidden="true" /></button>
            ) : (
              <button type="button" aria-label="Close and keep the draft" onClick={() => router.push('/dashboard')} className={ICON_BUTTON}><X className="h-5 w-5" aria-hidden="true" /></button>
            )}
            <p className="text-[13px] font-bold text-[#0c3e48]" aria-live="polite">Question {progress.n} of {progress.of}</p>
            <button type="button" aria-label="How it works" onClick={onHow} className={ICON_BUTTON}><CircleHelp className="h-5 w-5" aria-hidden="true" /></button>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#326273]/15" role="presentation">
            <div className="h-full rounded-full bg-[#0d6370] transition-[width] motion-reduce:transition-none" style={{ width: `${(progress.n / progress.of) * 100}%` }} />
          </div>
        </div>
      ) : null}

      {screen !== 'review' && screen !== 'receipt' ? (
        <div className="mb-5">
          <h1 ref={heading} tabIndex={-1} className="text-[26px] font-extrabold leading-tight tracking-[-0.01em] text-[#0c3e48] outline-none">{QUESTION[screen].title}</h1>
          {QUESTION[screen].hint ? <p className="mt-1.5 text-[15px] leading-6 text-[#326273]">{QUESTION[screen].hint}</p> : null}
        </div>
      ) : null}

      <div className="dash-surface mb-32 p-4">
        {screen === 'who' ? <Who flow={flow} patch={patch} /> : null}

        {screen === 'supplier' ? (
          <Supplier flow={flow} beneficiaries={beneficiaries} owner={owner} onChoose={(b) => choose({ kind: 'bank', beneficiaryId: b.id, name: b.holderName, country: b.country, currency: b.currency, last4: b.last4 })} onAdd={() => { setAdding(true); setMicro('b.country'); go(2); }} />
        ) : null}
        {screen === 'business' ? <DetailsBusiness flow={flow} patch={patch} /> : null}
        {screen === 'address' ? <DetailsWallet flow={flow} patch={patch} recipients={recipients} reload={reload} /> : null}

        {screen === 'b.country' ? (
          <div className="space-y-3">
            <Choices label="Country of the bank">
              {BANK_COUNTRIES.map((c) => (
                <Choice key={c.country} on={form.country === c.country} title={c.name} body={`${c.currency}${c.access === 'pilot' ? ' · Pilot access' : ''}`} onClick={() => set('country', c.country)} />
              ))}
            </Choices>
            {BANK_COUNTRIES.find((c) => c.country === form.country)?.access === 'pilot' ? (
              <PilotAccess country={form.country} />
            ) : (
              <button type="button" onClick={() => setSheet(true)} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[#0d6370]/40 bg-[#f4f8fa] px-4 text-sm font-bold text-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
                <CircleHelp className="h-4 w-4" aria-hidden="true" />
                What&rsquo;s needed for {form.country}
              </button>
            )}
          </div>
        ) : null}
        {screen === 'b.holder' ? (
          <Choices label="Who holds the account">
            <Choice on={form.holder === 'business'} title="A business" body="Needs the company registration number." onClick={() => set('holder', 'business')} />
            <Choice on={form.holder === 'person'} title="A person" body="No company number is needed." onClick={() => set('holder', 'person')} />
          </Choices>
        ) : null}
        {screen === 'b.name' ? <TextQuestion autoFocus id="pb-name" label="Registered name on the account" value={form.holderName} onChange={(v) => set('holderName', v)} autoComplete="off" /> : null}
        {screen === 'b.registration' ? <TextQuestion autoFocus id="pb-reg" label="Company registration number" value={form.registrationNumber} onChange={(v) => set('registrationNumber', v)} autoComplete="off" /> : null}
        {screen === 'b.bank' ? <TextQuestion autoFocus id="pb-bank" label="Bank code" value={form.bankCode} mono onChange={(v) => set('bankCode', v.toUpperCase())} autoComplete="off" /> : null}
        {screen === 'b.account' ? (
          <TextQuestion autoFocus id="pb-acct" label="Account number" value={form.accountNumber} mono inputMode="numeric" onChange={(v) => set('accountNumber', v)} autoComplete="off" error={accountCheck.ok || form.accountNumber.trim() === '' ? null : accountCheck.message} />
        ) : null}
        {screen === 'b.city' ? (
          <div className="space-y-4">
            <TextQuestion autoFocus id="pb-city" label="Town or city" value={form.city} onChange={(v) => set('city', v)} autoComplete="address-level2" />
            <TextQuestion id="pb-street" label="Street" hint="Optional" value={form.street} onChange={(v) => set('street', v)} autoComplete="off" />
            <TextQuestion id="pb-post" label="Postcode" hint="Optional" value={form.postCode} onChange={(v) => set('postCode', v)} autoComplete="off" />
          </div>
        ) : null}
        {screen === 'b.relationship' ? (
          <Choices label="Relationship to you">
            {RELATIONSHIP_OPTIONS.map((o) => (
              <Choice key={o.code} on={form.relationship === o.code} title={o.label} onClick={() => set('relationship', o.code)} />
            ))}
          </Choices>
        ) : null}
        {screen === 'b.confirm' ? (
          <div className="space-y-3">
            <dl className="divide-y divide-[#326273]/10 rounded-2xl border border-[#326273]/15 bg-white text-sm">
              <Fact label="Name on the account" value={form.holderName.trim()} />
              <Fact label="Country" value={BANK_COUNTRIES.find((c) => c.country === form.country)?.name ?? form.country} />
              {form.holder === 'business' ? <Fact label="Company registration number" value={form.registrationNumber.trim()} /> : null}
              <Fact label="Bank code" value={form.bankCode.trim()} mono />
              <Fact label="Account number" value={form.accountNumber.trim()} mono />
              <Fact label="Town or city" value={[form.street.trim(), form.city.trim(), form.postCode.trim()].filter(Boolean).join(', ')} />
            </dl>
            {errors.form ? <p role="alert" className="flex items-start gap-2 text-sm font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{errors.form}</p> : null}
            {Object.keys(errors).filter((k) => k !== 'form').map((k) => (
              <p key={k} role="alert" className="text-sm font-medium text-[var(--error)]">{errors[k as keyof BankErrors]}</p>
            ))}
            <p className="text-[13px] leading-5 text-[#326273]">The account number is stored encrypted, and only its last four digits are shown after it is saved.</p>
          </div>
        ) : null}

        {screen === 'amount' ? (
          <div className="space-y-5">
            <div>
              <label htmlFor="pt-amt" className="text-sm font-semibold text-[#1F4452]">Amount to pay, in USDC</label>
              <div className="relative mt-1.5">
                <input
                  id="pt-amt"
                  inputMode="decimal"
                  autoComplete="off"
                  value={flow.amountText}
                  onChange={(e) => patch({ amountText: e.target.value })}
                  placeholder="0.00"
                  aria-describedby="pt-amt-help"
                  className="h-16 w-full rounded-xl border border-[#326273]/25 bg-white pl-4 pr-20 font-mono text-[28px] font-bold tabular-nums text-[#0c3e48] outline-none focus:border-[#0d6370] focus:ring-2 focus:ring-[#0d6370]/20"
                />
                <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-sm font-bold text-[#326273]">USDC</span>
              </div>
              {flow.amountText && plan.amount === null ? <p role="alert" className="mt-1.5 text-[13px] font-medium text-[var(--error)]">Enter an amount above zero, with at most six decimals.</p> : null}
              <p id="pt-amt-help" className="mt-1.5 text-[13px] leading-5 text-[#326273]">
                {plan.bank && flow.chosen?.kind === 'bank' ? `${flow.chosen.name} receives ${flow.chosen.currency}. The rate is quoted once your funds are in. ` : ''}
                {plan.estimateUp !== null && plan.amount !== null ? `Splash fee about ${formatUsdc(plan.estimateUp)} USDC. ` : ''}The exact fee is shown before you approve.
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-[#326273]/15 bg-white p-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef4f5] text-[#145d6a]"><Wallet className="h-5 w-5" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-[#0c3e48]">Splash Wallet · USDC</p>
                <p className="text-[13px] text-[#326273]">Held by your business. Splash has no key to it.</p>
              </div>
              <p className="font-mono text-base font-bold tabular-nums text-[#0c3e48]">{balance.state === 'ok' ? formatUsdc(balance.usdcMinor) : balance.state === 'loading' ? '…' : 'Not available'}</p>
            </div>
            {balance.state === 'off' || balance.state === 'none' || balance.state === 'unavailable' ? (
              <p role="status" className="flex items-start gap-2 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-4 text-sm leading-6 text-[#1F4452]">
                <CircleAlert className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
                {balance.state === 'none' ? 'Your business has no Splash Wallet yet. Set it up in Wallet, then come back; this draft is kept.' : balance.state === 'off' ? 'Business wallets are not switched on for this business here, so there is nothing to pay from.' : 'The wallet balance could not be read just now. Try again in a moment.'}
              </p>
            ) : null}
            {funds && !funds.unknown && !funds.enough ? (
              <div className="space-y-3">
                <p role="status" className="flex items-start gap-2 text-sm font-bold text-[var(--warn-ink)]">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Short by {formatUsdc(funds.shortByMinor)} USDC, counting the Splash fee.
                </p>
                <TopUpPanel shortByMinor={funds.shortByMinor} intentKey={flow.intentKey} existingIntentId={topUpId} onStarted={onTopUp} onArrived={reload} />
              </div>
            ) : null}
            {funds?.enough ? <p role="status" className="text-sm font-semibold text-[#145d6a]">Your wallet covers this payment.</p> : null}
          </div>
        ) : null}

        {screen === 'purpose' ? (
          <Choices label="Purpose of payment">
            {PURPOSE_OPTIONS.map((o) => <Choice key={o.code} on={flow.purposeCode === o.code} title={o.label} onClick={() => patch({ purposeCode: o.code })} />)}
          </Choices>
        ) : null}
        {screen === 'source' ? (
          <Choices label="Where the money comes from">
            {SOURCE_OPTIONS.map((o) => <Choice key={o.code} on={flow.sourceOfFunds === o.code} title={o.label} onClick={() => patch({ sourceOfFunds: o.code })} />)}
          </Choices>
        ) : null}
        {screen === 'reference' ? <TextQuestion autoFocus id="pt-ref" label="Invoice or reference" value={flow.reference} maxLength={60} onChange={(v) => patch({ reference: v })} autoComplete="off" /> : null}

        {screen === 'review' ? (
          <StepReview {...shared} next={() => undefined} back={() => back && goTo(back)} made={made} onMade={props.onMade} onExecuted={props.onExecuted} onRestart={restart} onSending={setSending} stickyActions />
        ) : null}
        {screen === 'receipt' && receiptRef ? <StepReceipt refId={receiptRef} onNew={restart} /> : null}
      </div>

      {!paid && screen !== 'review' ? (
        <BottomBar
          label={screen === 'b.confirm' ? (saving ? 'Checking with the bank…' : 'Check and save account') : screen === 'reference' && flow.reference.trim() === '' ? 'Skip' : 'Continue'}
          disabled={!ready || saving || (screen !== 'b.confirm' && forward === null)}
          onClick={() => (screen === 'b.confirm' ? void save() : forward && goTo(forward))}
        />
      ) : null}
      <RequirementsSheet country={form.country} open={sheet} onClose={() => setSheet(false)} />
    </div>
  );
}

/** The screens that are one text field: it takes focus (and the keyboard) itself. */
const TEXT_SCREENS = new Set<Screen>(['b.name', 'b.registration', 'b.bank', 'b.account', 'b.city', 'reference']);

const ICON_BUTTON = 'grid h-11 w-11 place-items-center rounded-xl border border-[#326273]/20 bg-white text-[#1F4452] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]';

/** The one action of a question screen: a 56px bar at the foot, clear of the home indicator. The tab bar steps aside for it. */
function BottomBar({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <PhoneBar>
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-[#0d6370] px-5 text-base font-bold text-white transition-colors hover:bg-[#073d49] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
        <ArrowRight className="h-5 w-5" aria-hidden="true" />
      </button>
    </PhoneBar>
  );
}

function Choices({ label, children }: { label: string; children: ReactNode }) {
  return <div role="radiogroup" aria-label={label} className="grid gap-2.5">{children}</div>;
}

/** One answer among several: a row at least 56px tall, one selected state. */
function Choice({ on, title, body, tags, onClick }: { on: boolean; title: string; body?: string; tags?: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={`flex min-h-14 w-full items-center gap-3 rounded-2xl border-[1.5px] bg-white p-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${on ? 'border-[#0d6370] shadow-[0_0_0_4px_rgba(13,99,112,0.1)]' : 'border-[#326273]/20 active:bg-[#eef4f5]'}`}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-base font-extrabold text-[#0c3e48]">{title}</span>
        {body ? <span className="mt-0.5 block text-[14px] leading-5 text-[#326273]">{body}</span> : null}
        {tags}
      </span>
      <span className={`h-5 w-5 shrink-0 rounded-full border-2 ${on ? 'border-[6px] border-[#0d6370] bg-white' : 'border-[#326273]/40 bg-white'}`} aria-hidden="true" />
    </button>
  );
}

function TextQuestion({ id, label, hint, value, onChange, mono = false, error = null, autoFocus = false, ...rest }: { id: string; label: string; hint?: string; value: string; onChange: (value: string) => void; mono?: boolean; error?: string | null; autoFocus?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'id'>) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-[#1F4452]">{label}</label>
        {hint ? <span className="text-[13px] text-[#326273]">{hint}</span> : null}
      </div>
      <input id={id} autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-err` : undefined} {...rest} className={`mt-1.5 ${PHONE_INPUT} ${mono ? 'font-mono' : ''}`} />
      {error ? <p id={`${id}-err`} role="alert" className="mt-1.5 flex items-start gap-1.5 text-[13px] font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{error}</p> : null}
    </div>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-[13px] font-semibold text-[#326273]">{label}</dt>
      <dd className={`mt-0.5 break-words text-base font-bold text-[#0c3e48] ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  );
}

function Who({ flow, patch }: { flow: Flow; patch: (change: Partial<Flow>) => void }) {
  const fees = usePublishedFees();
  const price = (kind: PayeeKind): string | null => {
    if (!fees) return null;
    return kindPrice(fees.schedule, kind === 'bank' ? FEE_KIND.BANK_PAYOUT : kind === 'splash_business' ? FEE_KIND.SPLASH_BUSINESS : FEE_KIND.WALLET);
  };
  return (
    <Choices label="Payment type">
      {PAYEE_CARDS.map((card) => {
        const cost = price(card.kind);
        return (
          <Choice
            key={card.kind}
            on={flow.payeeType === card.kind}
            title={card.title}
            body={card.body}
            tags={
              <span className="mt-2 flex flex-wrap gap-1.5">
                {card.kind === 'splash_business' ? <Image src="/splash-main-icon.png" alt="" width={16} height={16} className="h-4 w-4 object-contain" /> : null}
                {card.tags.map((tag) => <span key={tag} className="rounded-full bg-[#eef4f5] px-2.5 py-1 text-[12px] font-semibold text-[#145d6a]">{tag}</span>)}
                {cost ? <span className="rounded-full bg-[var(--ok-bg)] px-2.5 py-1 text-[12px] font-semibold text-[#145d6a]">{cost}</span> : null}
              </span>
            }
            onClick={() => patch({ payeeType: card.kind, chosen: null })}
          />
        );
      })}
      <p className="pt-1 text-[13px] text-[#326273]">Paying many suppliers from a sheet? Use Batch payouts.</p>
    </Choices>
  );
}

function Supplier({ flow, beneficiaries, owner, onChoose, onAdd }: { flow: Flow; beneficiaries: Beneficiary[]; owner: boolean; onChoose: (b: Beneficiary) => void; onAdd: () => void }) {
  const chosenId = flow.chosen?.kind === 'bank' ? flow.chosen.beneficiaryId : null;
  return (
    <div className="space-y-4">
      {beneficiaries.length > 0 ? (
        <Choices label="Saved supplier accounts">
          {beneficiaries.map((b) => (
            <Choice key={b.id} on={chosenId === b.id} title={b.holderName} body={`${b.country} · ${b.currency} · ${b.bankCode} ••${b.last4}`} onClick={() => onChoose(b)} />
          ))}
        </Choices>
      ) : null}
      {owner ? (
        <button type="button" onClick={onAdd} className={`flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl border-[1.5px] px-4 text-base font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370] ${beneficiaries.length === 0 ? 'border-[#0d6370] bg-[#0d6370] text-white' : 'border-[#326273]/25 bg-white text-[#0c3e48]'}`}>
          <Landmark className="h-5 w-5" aria-hidden="true" />
          {beneficiaries.length === 0 ? 'Add a supplier’s bank account' : 'Add another supplier account'}
        </button>
      ) : (
        <p className="rounded-xl border border-[#326273]/15 bg-white p-4 text-sm leading-6 text-[#1F4452]">
          Only an owner can add a supplier&rsquo;s bank account. Ask an owner to add it in Recipients, then come back to pay it.
        </p>
      )}
      {chosenId ? <p role="status" className="flex items-center gap-2 text-sm font-semibold text-[#145d6a]"><Check className="h-4 w-4" aria-hidden="true" />Chosen. Continue to the amount.</p> : null}
    </div>
  );
}

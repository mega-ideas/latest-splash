'use client';

import { ArrowLeft, ArrowRight, CircleAlert, FileText, Wallet } from 'lucide-react';

import { formatUsdc, kindLabel } from '@/lib/fees/copy';
import { PURPOSE_OPTIONS, SOURCE_OPTIONS } from '@/lib/transfer/payee';
import { useAmountPlan } from './amount-plan';
import { Field, PrimaryButton, QuietButton, SelectInput, TextInput } from './ui';
import TopUpPanel from './TopUpPanel';
import type { StepProps } from './flow';

/** Step 3, "Amount and pay from": the Splash Wallet balance, the shortfall and a top-up from a verified source. */
export default function StepAmount({ flow, patch, balance, next, back, reload, topUpId, onTopUp }: StepProps & { topUpId: string | null; onTopUp: (id: string | null) => void }) {
  const { fees, bank, amount, kind, estimateUp, funds } = useAmountPlan(flow, balance);
  const declared = !bank || (flow.purposeCode && flow.sourceOfFunds);
  const canGo = amount !== null && Boolean(declared) && funds?.enough === true;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[22px] font-extrabold text-[#0c3e48]">How much?</h2>
        <p className="mt-1 text-sm text-[#326273]">
          You pay in USDC{bank && flow.chosen?.kind === 'bank' ? `; ${flow.chosen.name} receives ${flow.chosen.currency}. The rate is quoted once your funds are in.` : '.'}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount to pay" error={flow.amountText && amount === null ? 'Enter an amount above zero, with at most six decimals.' : null} htmlFor="amt">
          <div className="relative">
            <input
              id="amt"
              inputMode="decimal"
              autoComplete="off"
              value={flow.amountText}
              onChange={(e) => patch({ amountText: e.target.value })}
              placeholder="0.00"
              aria-describedby="amt-help"
              className="h-14 w-full rounded-xl border border-[#326273]/25 bg-white pl-4 pr-16 font-mono text-2xl font-bold tabular-nums text-[#0c3e48] outline-none focus:border-[#0d6370] focus:ring-2 focus:ring-[#0d6370]/20"
            />
            <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 font-mono text-sm font-bold text-[#326273]">USDC</span>
          </div>
          <p id="amt-help" className="mt-1.5 text-[13px] text-[#326273]">
            {kind !== null && fees ? `${kindLabel(kind)} payments${estimateUp !== null && amount !== null ? `: Splash fee about ${formatUsdc(estimateUp)} USDC` : ''}. The exact fee is shown before you approve.` : 'The exact fee is shown before you approve.'}
          </p>
        </Field>
        <Field label="Invoice or reference" hint="Optional" htmlFor="ref">
          <TextInput id="ref" icon={FileText} value={flow.reference} maxLength={60} onChange={(e) => patch({ reference: e.target.value })} autoComplete="off" />
        </Field>
        {bank ? (
          <>
            <Field label="Purpose of payment" htmlFor="purpose">
              <SelectInput id="purpose" value={flow.purposeCode} onChange={(e) => patch({ purposeCode: e.target.value })}>
                <option value="">Choose one</option>
                {PURPOSE_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>{o.label}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Where the money comes from" htmlFor="source">
              <SelectInput id="source" value={flow.sourceOfFunds} onChange={(e) => patch({ sourceOfFunds: e.target.value })}>
                <option value="">Choose one</option>
                {SOURCE_OPTIONS.map((o) => (
                  <option key={o.code} value={o.code}>{o.label}</option>
                ))}
              </SelectInput>
            </Field>
          </>
        ) : null}
      </div>

      <section aria-labelledby="payfrom" className="space-y-3">
        <h3 id="payfrom" className="text-base font-extrabold text-[#0c3e48]">Pay from</h3>
        <div className="flex items-center gap-3 rounded-xl border border-[#326273]/15 bg-white p-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef4f5] text-[#145d6a]"><Wallet className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-[#0c3e48]">Splash Wallet · USDC</p>
            <p className="text-[13px] text-[#326273]">Held by your business. Splash has no key to it.</p>
          </div>
          <p className="font-mono text-lg font-bold tabular-nums text-[#0c3e48]">
            {balance.state === 'ok' ? formatUsdc(balance.usdcMinor) : balance.state === 'loading' ? '…' : 'Not available'}
          </p>
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
      </section>

      <div className="flex flex-col-reverse gap-2 border-t border-[#326273]/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
        <QuietButton type="button" onClick={back}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </QuietButton>
        <PrimaryButton type="button" disabled={!canGo} onClick={next}>
          Review the payment
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </PrimaryButton>
      </div>
    </div>
  );
}

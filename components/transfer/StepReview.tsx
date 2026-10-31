'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, CircleAlert, Clock3, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';

import { formatUsdc, kindLabel } from '@/lib/fees/copy';
import { groupAddress } from '@/lib/transfer/addresses';
import { formatMoney } from '@/lib/formatMoney';
import { approvalPlan, approvalReasonLines, APPROVAL_REASON_TEXT, executableRoute, maxFeeToSend, parseAmountMinor, SETTLE_WINDOW_MS } from '@/lib/transfer/plan';
import PhoneBar from '@/components/dashboard/PhoneBar';
import { call, errorText, type SigningView } from './api';
import SignPanel from './SignPanel';
import { PrimaryButton, QuietButton } from './ui';
import type { Made, Quote, StepProps } from './flow';

type BankQuoteWire = {
  route: string;
  currency: string;
  sendMinor: string;
  rateMicro: string;
  receiveMinor: string;
  partnerFees: Array<{ partner: string; label: string; currency: string; amountMinor: string }>;
  splashFee: { kind: number; minor: string; feesOn: boolean };
  maxFeeMinor: string;
  totalDebitMinor: string;
  expiresAt: string;
  sandbox: boolean;
};
type TransferQuoteWire = { kind: number; principalMinor: string; feeMinor: string; feesOn: boolean; maxFeeMinor: string; totalDebitMinor: string; payee?: { address: string; country: string | null; recentlyAdded: boolean } };

function rateText(rateMicro: string): string {
  const micro = BigInt(rateMicro);
  const whole = (micro / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${(micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}

/**
 * Step 4, "Review and approve": the fee shown is the fee signed. The owners sign together. A staff member whose rule covers the
 * amount, the recipient and the time signs alone with their own passkey; anything outside the rule goes to the owners, and the
 * page says why, with the numbers.
 */
export default function StepReview({ flow, ctx, balance, reload, back, made, onMade, onExecuted, onRestart, onSending, stickyActions = false }: StepProps & { made: Made | null; onMade: (m: Made) => void; onExecuted: (digest: string | null) => void; onRestart: () => void; /** Told when the request is being sent and when it has answered, so a phone's own Back can be off in between. */ onSending?: (sending: boolean) => void; /** On a phone the actions are one fixed bar at the foot (v2 brief 5.10), and the tab bar steps aside for it. */ stickyActions?: boolean }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [addressChecked, setAddressChecked] = useState(false);
  const chosen = flow.chosen;
  const amount = parseAmountMinor(flow.amountText);

  const load = useCallback(async () => {
    if (!chosen || amount === null) return;
    setLoading(true);
    setError(null);
    if (chosen.kind === 'bank') {
      const answer = await call<{ quote?: BankQuoteWire }>('/api/wallet/payouts/quotes', { body: { beneficiaryId: chosen.beneficiaryId, amountMinor: amount.toString() } });
      const q = answer.body?.quote;
      if (!answer.ok || !q) {
        setQuote(null);
        setError(errorText(answer, 'There is no quote right now. Nothing was sent.'));
      } else {
        setQuote({
          principalMinor: BigInt(q.sendMinor),
          feeMinor: BigInt(q.splashFee.minor),
          feesOn: q.splashFee.feesOn,
          maxFeeMinor: BigInt(q.maxFeeMinor),
          totalDebitMinor: BigInt(q.totalDebitMinor),
          kind: q.splashFee.kind,
          partnerFees: q.partnerFees,
          receive: { currency: q.currency, minor: q.receiveMinor, rateMicro: q.rateMicro },
          acceptedReceiveMinor: q.receiveMinor,
          expiresAt: q.expiresAt,
          route: q.route,
          sandbox: q.sandbox,
          payee: null,
        });
      }
    } else {
      const payee = chosen.kind === 'splash_business' ? { kind: 'splash_business', businessId: chosen.businessId } : { kind: 'recipient', recipientId: chosen.recipientId };
      const answer = await call<{ quote?: TransferQuoteWire }>('/api/wallet/transfers/quote', { body: { payee, amountMinor: amount.toString() } });
      const q = answer.body?.quote;
      if (!answer.ok || !q) {
        setQuote(null);
        setError(errorText(answer, 'There is no quote right now. Nothing was sent.'));
      } else {
        setQuote({ principalMinor: BigInt(q.principalMinor), feeMinor: BigInt(q.feeMinor), feesOn: q.feesOn, maxFeeMinor: BigInt(q.maxFeeMinor), totalDebitMinor: BigInt(q.totalDebitMinor), kind: q.kind, partnerFees: [], receive: null, acceptedReceiveMinor: null, expiresAt: null, route: null, sandbox: false, payee: q.payee ?? null });
      }
    }
    setLoading(false);
  }, [chosen, amount]);

  useEffect(() => {
    if (made) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch the quote on mount; state is set when it answers
    void load();
  }, [load, made]);

  useEffect(() => {
    onSending?.(sending);
  }, [sending, onSending]);

  useEffect(() => {
    const first = window.setTimeout(() => setNow(Date.now()), 0);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(tick);
    };
  }, []);

  const secondsLeft = quote?.expiresAt && now ? Math.max(0, Math.floor((Date.parse(quote.expiresAt) - now) / 1000)) : null;
  const lapsed = secondsLeft === 0;

  const plan = useMemo(() => {
    if (!ctx || !chosen || amount === null) return null;
    const payee =
      chosen.kind === 'bank'
        ? ({ kind: 'bank' } as const)
        : chosen.kind === 'splash_business'
          ? ({ kind: 'splash_business' } as const)
          : ({ kind: 'wallet', wallet: chosen.deliveryKind === 'EXCHANGE' ? 'exchange' : chosen.deliveryKind === 'CROSS_CHAIN' ? 'cross_chain' : 'self_custody', address: chosen.address } as const);
    const address = chosen.kind === 'recipient' ? chosen.address : null;
    const counted = address ? ctx.runningTotals[address.toLowerCase()] : undefined;
    return executableRoute(
      approvalPlan({
        role: ctx.role,
        amountMinor: amount,
        feeMinor: quote?.maxFeeMinor ?? 0n,
        payee,
        rule: ctx.rule,
        policy: ctx.policy,
        runningTotalMinor: counted ? BigInt(counted) : 0n,
        asset: 'USDC',
        ...(now ? { nowMs: BigInt(now), settleByMs: BigInt(now + SETTLE_WINDOW_MS) } : {}),
      }),
      ctx.staffRulePaymentsWired,
    );
  }, [ctx, chosen, amount, quote, now]);

  /** Why the owners decide, in sentences with the limit, what is left and when the cap renews. */
  const reasonLines = useMemo(
    () => (plan && amount !== null && ctx ? approvalReasonLines(plan, { rule: ctx.rule, policy: ctx.policy, amountMinor: amount, ...(now ? { nowMs: now } : {}) }) : []),
    [plan, amount, ctx, now],
  );
  /** What is left of the person's cap once this payment is made, when it is paid under their rule. */
  const leftAfter = plan?.route === 'staff_rule' && ctx?.rule && quote ? BigInt(ctx.rule.spendableNowMinor) - quote.totalDebitMinor : null;

  async function send() {
    if (!chosen || !quote || amount === null) return;
    const maxFee = maxFeeToSend({ feeMinor: quote.maxFeeMinor });
    if (maxFee === null) return;
    setSending(true);
    setSendError(null);
    if (chosen.kind === 'bank') {
      const answer = await call<{ payout?: { id: string }; request?: SigningView | null }>('/api/wallet/payouts', {
        key: flow.intentKey,
        body: { beneficiaryId: chosen.beneficiaryId, amountMinor: amount.toString(), acceptedReceiveMinor: quote.acceptedReceiveMinor, maxFeeMinor: maxFee, purposeCode: flow.purposeCode, sourceOfFunds: flow.sourceOfFunds, remittanceInfo: flow.reference || undefined },
      });
      setSending(false);
      const payout = answer.body?.payout;
      if (!answer.ok || !payout) {
        setSendError(errorText(answer, 'The payment was not sent. Nothing left your wallet.'));
        return;
      }
      onMade({ ref: payout.id, route: ctx?.role === 'OWNER' ? 'owners_sign' : 'asked_owners', signing: answer.body?.request ?? null, askId: null, expected: { recipient: null, amountMinor: amount.toString(), maxFeeMinor: maxFee, payeeName: chosen.name } });
      return;
    }
    const payee = chosen.kind === 'splash_business' ? { kind: 'splash_business', businessId: chosen.businessId } : { kind: 'recipient', recipientId: chosen.recipientId };
    const answer = await call<{ transfer?: { id: string; route: 'owners_sign' | 'asked_owners' | 'staff_rule' }; signingRequest?: SigningView | null; ask?: { id: string } | null; plan?: { reasons: string[]; lines: string[] }; feeMinor?: string; code?: string }>('/api/wallet/transfers', {
      key: flow.intentKey,
      // A page that said "within your spending rule" asks to pay alone: if the server finds it is not, it says why instead of quietly asking the owners.
      body: { payee, amountMinor: amount.toString(), maxFeeMinor: maxFee, reference: flow.reference || undefined, asset: 'USDC', via: plan?.route === 'staff_rule' ? 'rule' : undefined },
    });
    setSending(false);
    if (answer.status === 409 && answer.body?.code === 'fee_changed') {
      setSendError('Splash’s fee changed since it was shown. Check the new fee below, then approve again.');
      void load();
      return;
    }
    if (answer.status === 409 && answer.body?.code === 'outside_rule') {
      // The rule changed since the page read it: read it again, and say why in the server's words.
      setSendError(errorText(answer, 'This payment is outside your spending rule now. Nothing was sent.'));
      reload();
      return;
    }
    const transfer = answer.body?.transfer;
    if (!answer.ok || !transfer) {
      setSendError(errorText(answer, 'The payment was not sent. Nothing left your wallet.'));
      return;
    }
    onMade({ ref: transfer.id, route: transfer.route, signing: answer.body?.signingRequest ?? null, askId: answer.body?.ask?.id ?? null, plan: answer.body?.plan, expected: { recipient: quote.payee?.address ?? null, amountMinor: amount.toString(), maxFeeMinor: maxFee, payeeName: chosen.name } });
  }

  const feeLine = quote ? (quote.feesOn ? `${formatUsdc(quote.feeMinor)} USDC` : 'None charged yet') : '';
  const ownerRoute = plan?.route === 'owners_sign';
  const ruleRoute = plan?.route === 'staff_rule';

  if (made) {
    return (
      <div className="space-y-5">
        <h2 className="text-[22px] font-extrabold text-[#0c3e48]">{made.route === 'owners_sign' ? 'Approve the payment' : made.route === 'staff_rule' ? 'Sign your payment' : 'Sent to your owners'}</h2>
        {made.signing ? (
          <SignPanel initial={made.signing} expected={made.expected} onExecuted={onExecuted} onRestart={onRestart} />
        ) : (
          <div className="space-y-3 rounded-2xl border border-[#326273]/15 bg-white p-4 sm:p-5" role="status">
            <p className="flex items-center gap-2 text-base font-extrabold text-[#0c3e48]"><ShieldCheck className="h-5 w-5 text-[#0d6370]" aria-hidden="true" />{made.route === 'asked_owners' ? 'Your owners have been asked' : 'Waiting for the owners'}</p>
            {made.plan && made.plan.lines.length > 0 ? (
              <div>
                <p className="text-sm font-bold text-[#0c3e48]">Why it went to them</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[13px] leading-5 text-[#1F4452]">
                  {made.plan.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p className="text-sm leading-6 text-[#1F4452]">Nothing has left your wallet. An owner reviews the payment and signs it with the other owners; you are told in Splash when it is paid. The receipt appears here and in History.</p>
            <QuietButton type="button" onClick={onRestart}>Start another payment</QuietButton>
          </div>
        )}
      </div>
    );
  }

  const actions = (
    <>
      <QuietButton type="button" disabled={sending} onClick={back} className={stickyActions ? 'min-h-14 shrink-0' : undefined}>
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back
      </QuietButton>
      <PrimaryButton type="button" className={stickyActions ? 'min-h-14 flex-1 text-base' : undefined} disabled={!quote || lapsed || sending || (quote.payee?.recentlyAdded === true && !addressChecked) || plan?.route === 'blocked' || !plan || (balance.state === 'ok' && quote !== null && balance.usdcMinor < quote.totalDebitMinor)} onClick={() => void send()}>
        {sending ? 'Sending…' : ownerRoute ? 'Approve and collect signatures' : ruleRoute ? 'Pay now' : 'Ask the owners to approve'}
      </PrimaryButton>
    </>
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[22px] font-extrabold text-[#0c3e48]">Review and approve</h2>
        <p className="mt-1 text-sm text-[#326273]">The amount, who is paid and the fee below are what the approvers sign. If anything changes, you are asked again.</p>
      </div>

      {loading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-[#326273]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Getting the quote…</p>
      ) : error || !quote ? (
        <div className="space-y-3">
          <p role="alert" className="flex items-start gap-2 rounded-xl border border-[var(--error)]/40 bg-[var(--error-bg)] p-4 text-sm font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{error}</p>
          <QuietButton type="button" onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Try again</QuietButton>
        </div>
      ) : (
        <dl className="divide-y divide-[#326273]/10 rounded-2xl border border-[#326273]/15 bg-white text-sm">
          <Row
            label="To"
            value={chosen?.name ?? ''}
            sub={chosen?.kind === 'bank' ? `${chosen.country} bank account ••${chosen.last4}` : chosen?.kind === 'splash_business' ? 'A business on Splash' : chosen?.kind === 'recipient' ? (chosen.deliveryKind === 'EXCHANGE' ? 'Exchange account on Sui' : 'Sui wallet') : undefined}
            extra={
              quote.payee ? (
                <>
                  <span className="mt-1 block break-all font-mono text-[13px] leading-5 text-[#0c3e48]" data-testid="payee-address">{groupAddress(quote.payee.address)}</span>
                  {quote.payee.country ? <span className="block text-[13px] text-[#326273]">Country: {quote.payee.country}</span> : null}
                </>
              ) : null
            }
          />
          {quote.receive ? <Row label="They receive" value={formatMoney(BigInt(quote.receive.minor), quote.receive.currency)} sub={`1 USDC = ${rateText(quote.receive.rateMicro)} ${quote.receive.currency}`} /> : null}
          <Row label="You pay" value={`${formatUsdc(quote.principalMinor)} USDC`} />
          <Row label={`Splash fee · ${kindLabel(quote.kind)}`} value={feeLine} sub={quote.feesOn ? 'You will never be charged more than this.' : "No Splash fee is charged yet. Fees start only after 24 hours' public notice."} />
          {quote.partnerFees.map((f, i) => (
            <Row key={`${f.label}-${i}`} label={f.partner === 'Circle' ? 'Circle fee' : 'Payout partner fee'} value={formatMoney(BigInt(f.amountMinor), f.currency)} sub={`${f.label}. This is the partner’s own fee, taken from what arrives.`} />
          ))}
          <Row strong label="Leaves your wallet at most" value={`${formatUsdc(quote.totalDebitMinor)} USDC`} />
          {secondsLeft !== null ? (
            <div className="flex items-center justify-between gap-3 px-4 py-3 text-[13px]">
              <span className="flex items-center gap-2 text-[#1F4452]"><Clock3 className="h-4 w-4" aria-hidden="true" />{lapsed ? 'This rate has lapsed.' : `Rate held for ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`}</span>
              {lapsed ? <QuietButton type="button" className="h-11" onClick={() => void load()}><RefreshCw className="h-4 w-4" aria-hidden="true" />Get a new rate</QuietButton> : null}
            </div>
          ) : null}
        </dl>
      )}

      {quote?.payee?.recentlyAdded ? (
        <label className="flex items-start gap-3 rounded-xl border border-[var(--warn)] bg-[var(--warn-bg)] p-3.5 text-sm leading-6 text-[#1F4452]">
          <input type="checkbox" checked={addressChecked} onChange={(e) => setAddressChecked(e.target.checked)} className="mt-1 h-5 w-5 shrink-0 accent-[#0d6370]" />
          <span>This address was saved in the last 24 hours. I have checked it with {chosen?.name ?? 'the recipient'}, letter for letter.</span>
        </label>
      ) : null}
      {quote?.sandbox ? <p className="text-[13px] font-semibold text-[var(--warn-ink)]">This quote comes from a test service, not a payout partner.</p> : null}
      {balance.state === 'ok' && quote && balance.usdcMinor < quote.totalDebitMinor ? (
        <p role="alert" className="text-sm font-semibold text-[var(--error)]">Your wallet holds {formatUsdc(balance.usdcMinor)} USDC, which is less than this payment needs. Go back and top up.</p>
      ) : null}

      {plan ? (
        <section aria-labelledby="who-approves" className="space-y-2 rounded-2xl border border-[#326273]/15 bg-[#f4f8fa] p-4">
          <h3 id="who-approves" className="flex items-center gap-2 text-sm font-extrabold text-[#0c3e48]"><ShieldCheck className="h-4 w-4 text-[#0d6370]" aria-hidden="true" />Who approves</h3>
          {plan.route === 'owners_sign' ? (
            <p className="text-sm leading-6 text-[#1F4452]">Your owners approve this together. Each signs on their own device with their own passkey, and Splash combines the signatures. Splash has no key to your wallet.</p>
          ) : plan.route === 'staff_rule' ? (
            <>
              <h4 className="text-sm font-bold text-[#145d6a]">Within your spending rule</h4>
              <p className="text-sm leading-6 text-[#1F4452]">The amount, the recipient and the time all fit your rule, so you sign this yourself with your passkey. It is paid from your business wallet, and no one else has to approve it.</p>
              {leftAfter !== null && leftAfter >= 0n ? <p className="text-[13px] leading-5 text-[#326273]">After this, your rule has {formatUsdc(leftAfter)} USDC left{ctx?.rule?.renewsAtMs ? ' until it renews' : ''}.</p> : null}
            </>
          ) : plan.route === 'ask_owners' ? (
            <>
              <p className="text-sm leading-6 text-[#1F4452]">Your owners approve this payment. Nothing leaves your wallet until they do.</p>
              <ul className="list-disc space-y-1 pl-5 text-[13px] leading-5 text-[#1F4452]">
                {reasonLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm leading-6 text-[#1F4452]">{plan.reasons[0] ? APPROVAL_REASON_TEXT[plan.reasons[0]] : 'You cannot make this payment.'}</p>
          )}
        </section>
      ) : null}

      {sendError ? <p role="alert" className="flex items-start gap-2 text-sm font-medium text-[var(--error)]"><CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />{sendError}</p> : null}

      <div className={stickyActions ? undefined : 'flex flex-col-reverse gap-2 border-t border-[#326273]/10 pt-4 sm:flex-row sm:items-center sm:justify-between'}>
        {stickyActions ? (
          // On a phone the actions are the one bar at the foot, and the tab bar steps aside for it.
          <PhoneBar>
            <div className="flex items-center gap-2">{actions}</div>
          </PhoneBar>
        ) : (
          actions
        )}
      </div>
    </div>
  );
}

function Row({ label, value, sub, strong, extra }: { label: string; value: string; sub?: string; strong?: boolean; extra?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
      <dt className="text-[#326273]">{label}</dt>
      <dd className="min-w-0 sm:text-right">
        <span className={`block break-words font-mono tabular-nums ${strong ? 'text-lg font-extrabold' : 'font-bold'} text-[#0c3e48]`}>{value}</span>
        {sub ? <span className="block text-[13px] text-[#326273]">{sub}</span> : null}
        {extra}
      </dd>
    </div>
  );
}

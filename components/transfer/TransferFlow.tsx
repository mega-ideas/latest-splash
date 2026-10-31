'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, CircleHelp, Wallet } from 'lucide-react';

import { formatUsdc } from '@/lib/fees/copy';
import { newIntentKey, draftStorageKey, parseDraft, serializeDraft, type TransferDraft } from '@/lib/transfer/draft';
import { parseAmountMinor } from '@/lib/transfer/plan';
import { call, type Beneficiary, type Context, type SavedRecipient } from './api';
import type { Balance, Chosen, Flow, Made } from './flow';
import HowItWorks from './HowItWorks';
import StepAmount from './StepAmount';
import StepDetails from './StepDetails';
import StepReceipt from './StepReceipt';
import StepReview from './StepReview';
import StepWho from './StepWho';

const STEPS = ['Who you’re paying', 'Recipient details', 'Amount and pay from', 'Review and approve', 'Receipt'] as const;

const BLANK: Flow = { step: 1, payeeType: null, chosen: null, amountText: '', purposeCode: '', sourceOfFunds: '', reference: '', intentKey: '' };

function draftOf(flow: Flow, topUp: string | null, now: Date): TransferDraft | null {
  const c = flow.chosen;
  if (!c || !flow.intentKey) return null;
  const payee: TransferDraft['payee'] =
    c.kind === 'bank' ? { kind: 'bank', beneficiaryId: c.beneficiaryId, name: c.name, country: c.country } : c.kind === 'splash_business' ? { kind: 'splash_business', businessId: c.businessId, name: c.name } : { kind: 'recipient', recipientId: c.recipientId, name: c.name };
  return {
    v: 1,
    intentKey: flow.intentKey,
    payee,
    amountText: flow.amountText,
    ...(flow.purposeCode ? { purposeCode: flow.purposeCode } : {}),
    ...(flow.sourceOfFunds ? { sourceOfFunds: flow.sourceOfFunds } : {}),
    ...(flow.reference ? { reference: flow.reference } : {}),
    ...(topUp ? { topUp: { fundingIntentId: topUp, startedAt: now.toISOString() } } : {}),
    savedAt: now.toISOString(),
  };
}

function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* a draft is a convenience: without storage the page still works */
  }
}

/** The five steps of one payment (v2 brief 5.4): who, details, amount and pay from, review and approve, receipt. */
export default function TransferFlow() {
  const [flow, setFlow] = useState<Flow>(BLANK);
  const [ctx, setCtx] = useState<Context | null>(null);
  const [ctxState, setCtxState] = useState<'loading' | 'ok' | 'denied' | 'failed'>('loading');
  const [balance, setBalance] = useState<Balance>({ state: 'loading' });
  const [recipients, setRecipients] = useState<SavedRecipient[]>([]);
  const [beneficiaries, setBeneficiaries] = useState<Beneficiary[]>([]);
  const [made, setMade] = useState<Made | null>(null);
  const [receiptRef, setReceiptRef] = useState<string | null>(null);
  const [topUp, setTopUp] = useState<string | null>(null);
  const [how, setHow] = useState(false);
  const restored = useRef(false);

  const patch = useCallback((change: Partial<Flow>) => setFlow((f) => ({ ...f, ...change })), []);
  const go = useCallback((step: Flow['step']) => {
    setFlow((f) => ({ ...f, step }));
    window.scrollTo({ top: 0 });
  }, []);

  const load = useCallback(async () => {
    const [c, r, b] = await Promise.all([call<Context>('/api/wallet/transfers/context'), call<SavedRecipient[]>('/api/recipients'), call<{ beneficiaries?: Beneficiary[] }>('/api/wallet/payouts')]);
    if (c.status === 403 || c.status === 401) setCtxState('denied');
    else if (!c.ok || !c.body) setCtxState('failed');
    else {
      setCtx(c.body);
      setCtxState('ok');
    }
    if (r.ok && Array.isArray(r.body)) setRecipients(r.body);
    if (b.ok && Array.isArray(b.body?.beneficiaries)) setBeneficiaries(b.body.beneficiaries);
    const body = c.body;
    if (!body || body.walletState !== 'ready' || !body.wallet) {
      setBalance({ state: body?.walletState === 'none' || body?.walletState === 'pending' ? 'none' : body?.walletState === 'off' ? 'off' : 'unavailable' });
      return;
    }
    const bal = await call<{ usdcMinor?: string | number }>(`/api/stablecoin/wallet?address=${encodeURIComponent(body.wallet)}`);
    const minor = bal.body?.usdcMinor;
    if (bal.ok && minor !== undefined && /^\d+$/.test(String(minor))) setBalance({ state: 'ok', usdcMinor: BigInt(String(minor)) });
    else setBalance({ state: 'unavailable' });
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the page loads its own data once
    void load();
  }, [load]);

  // A draft kept from before (a top-up that took a while, a tab that was closed): the same payment, the same intent id.
  useEffect(() => {
    if (restored.current || ctxState !== 'ok' || !ctx) return;
    restored.current = true;
    const draft = parseDraft(readStore(draftStorageKey(ctx.orgId)), new Date());
    if (!draft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the first intent id is made once the business is known
      setFlow((f) => ({ ...f, intentKey: newIntentKey() }));
      return;
    }
    let chosen: Chosen | null = null;
    let payeeType: Flow['payeeType'] = null;
    if (draft.payee.kind === 'bank') {
      const b = beneficiaries.find((x) => x.id === (draft.payee as { beneficiaryId: string }).beneficiaryId);
      if (b) {
        payeeType = 'bank';
        chosen = { kind: 'bank', beneficiaryId: b.id, name: b.holderName, country: b.country, currency: b.currency, last4: b.last4 };
      }
    } else if (draft.payee.kind === 'splash_business') {
      payeeType = 'splash_business';
      chosen = { kind: 'splash_business', businessId: draft.payee.businessId, name: draft.payee.name, country: null };
    } else {
      const id = draft.payee.recipientId;
      const r = recipients.find((x) => x.id === id);
      const kind = r?.delivery?.deliveryKind;
      if (r && (kind === 'EXCHANGE' || kind === 'SELF_CUSTODY' || kind === 'CROSS_CHAIN')) {
        payeeType = 'wallet';
        chosen = { kind: 'recipient', recipientId: r.id, name: r.name, deliveryKind: kind, address: r.walletAddress ?? r.delivery?.destinationAddress ?? null, blocked: null };
      }
    }
    if (!chosen) {
      setFlow((f) => ({ ...f, intentKey: newIntentKey() }));
      return;
    }
    setFlow({ step: 3, payeeType, chosen, amountText: draft.amountText, purposeCode: draft.purposeCode ?? '', sourceOfFunds: draft.sourceOfFunds ?? '', reference: draft.reference ?? '', intentKey: draft.intentKey });
    setTopUp(draft.topUp?.fundingIntentId ?? null);
  }, [ctxState, ctx, beneficiaries, recipients]);

  useEffect(() => {
    if (!ctx || !restored.current || made) return;
    const draft = draftOf(flow, topUp, new Date());
    if (draft && flow.step <= 4) writeStore(draftStorageKey(ctx.orgId), serializeDraft(draft));
  }, [flow, topUp, ctx, made]);

  const restart = useCallback(() => {
    if (ctx) writeStore(draftStorageKey(ctx.orgId), null);
    setMade(null);
    setReceiptRef(null);
    setTopUp(null);
    setFlow({ ...BLANK, intentKey: newIntentKey() });
    window.scrollTo({ top: 0 });
  }, [ctx]);

  const onMade = useCallback(
    (m: Made) => {
      setMade(m);
      if (ctx) writeStore(draftStorageKey(ctx.orgId), null);
    },
    [ctx],
  );
  const onExecuted = useCallback(() => {
    setMade((m) => {
      if (m) setReceiptRef(m.ref);
      return m;
    });
    setFlow((f) => ({ ...f, step: 5 }));
  }, []);

  const amount = parseAmountMinor(flow.amountText);
  const step = flow.step;
  const shared = { flow, patch, ctx, balance, recipients, beneficiaries, reload: () => void load() };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      <header className="dash-reveal overflow-hidden rounded-2xl bg-[#0c3e48] text-white">
        <div className="flex flex-col gap-5 p-5 md:flex-row md:items-start md:justify-between md:p-6">
          <div className="min-w-0">
            <span className="inline-flex rounded-md border border-white/25 px-2.5 py-1 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-white">New payment</span>
            <h1 className="mt-3 text-3xl font-black tracking-tight md:text-4xl">Send a payment</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-white/85">Pick who you&rsquo;re paying, check the amount, get it approved, and keep the receipt.</p>
          </div>
          <div className="flex items-center justify-between gap-4 md:flex-col md:items-end">
            <button
              type="button"
              onClick={() => setHow(true)}
              className="inline-flex h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-xl border border-white/30 bg-white/10 px-4 text-sm font-semibold text-white transition-colors hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <CircleHelp className="h-4 w-4" aria-hidden="true" />
              How it works
            </button>
            <div className="flex items-center gap-3">
              <div className="text-right">
                <div className="font-mono text-[12px] uppercase tracking-[0.14em] text-white/80">Current step</div>
                <div className="text-sm font-bold">{STEPS[step - 1]}</div>
              </div>
              <span className="rounded-lg bg-[#efc46f] px-2.5 py-1.5 font-mono text-[13px] font-bold text-[#0c3e48]">{step}/5</span>
            </div>
          </div>
        </div>
        <div className="h-1 bg-white/15" role="presentation"><div className="h-full bg-[#8fd7c7] transition-[width] motion-reduce:transition-none" style={{ width: `${step * 20}%` }} /></div>
      </header>

      <nav aria-label="Steps" className="dash-surface overflow-hidden">
        <ol className="grid grid-cols-5 sm:flex sm:flex-wrap">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const active = n === step;
            const done = n < step;
            return (
              <li key={label} aria-current={active ? 'step' : undefined} className={`flex min-h-[56px] items-center justify-center gap-3 px-2 py-2 sm:flex-1 sm:justify-start sm:px-4 ${active ? 'bg-white shadow-[inset_0_-3px_0_#0d6370]' : ''}`}>
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold ${done ? 'bg-[#0d6370] text-white' : active ? 'bg-[#0c3e48] text-white' : 'bg-[#ede8e4] text-[#1F4452]'}`}>{done ? <Check className="h-4 w-4" aria-hidden="true" /> : n}</span>
                <span className={`hidden text-sm sm:block ${active ? 'font-bold text-[#0c3e48]' : 'font-semibold text-[#1F4452]'}`}>{label}</span>
              </li>
            );
          })}
        </ol>
        <p className="border-t border-[#326273]/10 px-4 py-2 text-sm font-bold text-[#0c3e48] sm:hidden">Step {step} of 5: {STEPS[step - 1]}</p>
      </nav>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="dash-surface min-w-0 p-4 sm:p-6" aria-label={STEPS[step - 1]}>
          {ctxState === 'loading' ? (
            <p role="status" className="text-sm text-[#326273]">Loading…</p>
          ) : ctxState === 'denied' ? (
            <p role="alert" className="text-sm font-medium text-[var(--error)]">You do not have a place in a business here yet, so there is nothing to pay from.</p>
          ) : ctxState === 'failed' ? (
            <p role="alert" className="text-sm font-medium text-[var(--error)]">Splash could not load your business just now. Nothing was sent. Try again in a moment.</p>
          ) : (
            <>
              {step === 1 ? <StepWho {...shared} next={() => go(2)} back={() => undefined} /> : null}
              {step === 2 ? <StepDetails {...shared} next={() => go(3)} back={() => go(1)} /> : null}
              {step === 3 ? <StepAmount {...shared} topUpId={topUp} onTopUp={setTopUp} next={() => go(4)} back={() => go(2)} /> : null}
              {step === 4 ? <StepReview {...shared} made={made} onMade={onMade} onExecuted={onExecuted} onRestart={restart} next={() => go(5)} back={() => go(3)} /> : null}
              {step === 5 && receiptRef ? <StepReceipt refId={receiptRef} onNew={restart} /> : null}
            </>
          )}
        </section>

        <aside className="space-y-3" aria-label="This payment">
          <div className="rounded-2xl bg-[#0c3e48] p-4 text-white">
            <div className="font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-white/80">This payment</div>
            <div className="mt-2 text-xl font-extrabold">{flow.payeeType === 'bank' ? 'To a bank account' : flow.payeeType === 'splash_business' ? 'To a business on Splash' : flow.payeeType === 'wallet' ? 'To a Sui wallet' : 'Not chosen yet'}</div>
            {flow.chosen ? <div className="mt-1 truncate text-sm text-white/85">{flow.chosen.name}</div> : null}
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-white/15 pt-3 text-sm">
              <div>
                <dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/75">You pay in</dt>
                <dd className="font-bold">USDC</dd>
              </div>
              <div>
                <dt className="font-mono text-[12px] uppercase tracking-[0.12em] text-white/75">Amount</dt>
                <dd className="font-bold tabular-nums">{amount !== null ? `${formatUsdc(amount)} USDC` : 'Not set'}</dd>
              </div>
            </dl>
          </div>
          <div className="dash-block p-4">
            <div className="flex items-center gap-2 font-mono text-[12px] font-bold uppercase tracking-[0.14em] text-[#145d6a]"><Wallet className="h-3.5 w-3.5" aria-hidden="true" />Splash Wallet</div>
            <div className="mt-1.5 text-2xl font-extrabold tabular-nums text-[#0c3e48]">{balance.state === 'ok' ? `${formatUsdc(balance.usdcMinor)} USDC` : balance.state === 'loading' ? '…' : 'Not available'}</div>
            <Link href="/dashboard/wallet" className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-[#0d6370] underline underline-offset-2">Add funds</Link>
          </div>
        </aside>
      </div>
      <HowItWorks open={how} onClose={() => setHow(false)} />
    </div>
  );
}

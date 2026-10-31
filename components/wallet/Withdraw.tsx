'use client';

import { useState } from 'react';
import { Landmark } from 'lucide-react';

import { call, errorText, type SigningView } from '@/components/transfer/api';
import SignPanel, { type SignLabels } from '@/components/transfer/SignPanel';
import { Field, PrimaryButton, QuietButton, SelectInput, TextInput } from '@/components/transfer/ui';
import { formatUsdc } from '@/lib/fees/copy';
import { formatMoney } from '@/lib/formatMoney';
import { withdrawalLine } from '@/lib/wallet-page/labels';
import { Card, Loading, Note, Pill, newKey, useLoad } from './parts';
import RouteSetup from './RouteSetup';

type Destination = { id: string; route: string; country: string; currency: string; bankCode: string; holderName: string; last4: string; label: string };
type Withdrawal = { id: string; status: string; destination: { label: string; last4: string } | null; amountMinor: string; currency: string; receiveMinor: string; createdAt: string; kind: string };
type Quote = {
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
type Overview = { withdrawals: Withdrawal[]; destinations: Destination[]; depositAddress: { status: string; address: string } | null };

const AMOUNT = /^\d{1,9}(\.\d{1,6})?$/;
const toMinor = (text: string) => {
  const [whole, frac = ''] = text.trim().split('.');
  return BigInt(whole || '0') * 1_000_000n + BigInt(frac.padEnd(6, '0'));
};
const rateText = (micro: string) => {
  const m = BigInt(micro);
  return `${(m / 1_000_000n).toString()}.${(m % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')}`;
};

const LABELS: SignLabels = {
  working: 'Sending the withdrawal',
  done: 'Withdrawal sent',
  doneNote: 'The USDC has left your wallet for your bank partner. Its status updates below.',
  deadNote: 'Nothing left your wallet. You can start the withdrawal again.',
  restart: 'Start again',
};

/**
 * Withdraw to your own bank (v2 brief 4.4, 5.5). Only to a bank account in the
 * business's own name; Splash never receives the money. The quote comes
 * first, with each partner's fee as its own line; the fee shown is the fee
 * signed (`maxFeeMinor`), and the least the bank receives is the amount
 * shown. An owner, or a staff member asking the owners, withdraws; only the
 * owners' quorum signs. The Idempotency-Key is made once per attempt.
 */
export default function Withdraw({ canAsk, owner, onChanged }: { canAsk: boolean; owner: boolean; onChanged: () => void }) {
  const data = useLoad<Overview>('/api/wallet/withdrawals', 'Your withdrawals could not be loaded.');
  const [destinationId, setDestinationId] = useState('');
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SigningView | null>(null);

  if (data.loading) return <Card id="withdraw" title="Withdraw to your bank"><Loading label="Loading…" /></Card>;
  if (!data.data) return <Card id="withdraw" title="Withdraw to your bank"><Note tone="error">{data.error}</Note></Card>;
  const { destinations, withdrawals } = data.data;
  const ready = destinations.length > 0 && data.data.depositAddress?.status === 'verified';
  const chosen = destinations.find((d) => d.id === destinationId) ?? null;
  const valid = AMOUNT.test(amount.trim()) && toMinor(amount) > 0n;

  async function getQuote() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    const answer = await call<{ quote?: Quote }>('/api/wallet/withdrawals/quotes', { body: { destinationId: chosen.id, amountMinor: toMinor(amount).toString() } });
    setBusy(false);
    if (!answer.ok || !answer.body?.quote) {
      setQuote(null);
      setError(errorText(answer, 'There is no quote right now. Nothing was sent.'));
      return;
    }
    setQuote(answer.body.quote);
    if (!key) setKey(newKey('wd'));
  }

  async function send() {
    if (!chosen || !quote || !key) return;
    setBusy(true);
    setError(null);
    const answer = await call<{ request?: SigningView | null }>('/api/wallet/withdrawals', {
      key,
      body: { destinationId: chosen.id, amountMinor: toMinor(amount).toString(), acceptedReceiveMinor: quote.receiveMinor, maxFeeMinor: quote.maxFeeMinor },
    });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, 'The withdrawal was not started. Nothing left your wallet.'));
      return;
    }
    setRequest(answer.body?.request ?? null);
    setQuote(null);
    setAmount('');
    data.reload();
  }

  const owners = owner ? 'your owners' : 'the owners';
  return (
    <Card id="withdraw" title="Withdraw to your bank">
      <div className="space-y-4">
        <p className="text-[13px] leading-5 text-[#326273]">Only to a bank account in your company&rsquo;s own name. Splash never receives the money: your wallet pays your bank partner directly, and the partner pays your bank.</p>
        {request ? (
          <SignPanel initial={request} labels={LABELS} onExecuted={() => { setRequest(null); data.reload(); onChanged(); }} onRestart={() => setRequest(null)} />
        ) : !canAsk ? (
          <Note tone="warn">Viewers cannot withdraw. Ask an owner.</Note>
        ) : !ready ? (
          owner ? (
            <RouteSetup destinations={destinations} depositAddress={data.data.depositAddress} onChanged={data.reload} onSigned={() => { data.reload(); onChanged(); }} />
          ) : (
            <Note tone="warn"><Landmark className="mr-1.5 inline h-4 w-4 align-text-bottom" aria-hidden="true" />Withdrawals to your bank are not set up yet. An owner sets up the bank account and the partner route first.</Note>
          )
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="To your bank account" htmlFor="wd-dest">
                <SelectInput id="wd-dest" value={destinationId} onChange={(e) => { setDestinationId(e.target.value); setQuote(null); }}>
                  <option value="">Choose an account</option>
                  {destinations.map((d) => <option key={d.id} value={d.id}>{d.label} ••{d.last4} ({d.currency})</option>)}
                </SelectInput>
              </Field>
              <Field label="Amount to withdraw" hint="USDC" htmlFor="wd-amount">
                <TextInput id="wd-amount" value={amount} onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, '')); setQuote(null); }} inputMode="decimal" mono placeholder="1,000.00" autoComplete="off" />
              </Field>
            </div>
            {quote ? (
              <div className="rounded-xl border border-[#326273]/15 bg-white p-4 text-sm text-[#1F4452]" aria-live="polite">
                <p className="font-bold text-[#0c3e48]">Your bank receives about {formatMoney(BigInt(quote.receiveMinor), quote.currency)}</p>
                <p className="text-[13px] text-[#326273]">1 USDC = {rateText(quote.rateMicro)} {quote.currency}. The rate is fixed when the partner receives your USDC; you accept no less than this amount.</p>
                <dl className="mt-3 space-y-1 text-[13px]">
                  <div className="flex justify-between gap-3"><dt>You withdraw</dt><dd className="font-mono">{formatUsdc(BigInt(quote.sendMinor))} USDC</dd></div>
                  <div className="flex justify-between gap-3"><dt>Splash fee</dt><dd className="font-mono">{quote.splashFee.feesOn ? `${formatUsdc(BigInt(quote.splashFee.minor))} USDC` : 'None'}</dd></div>
                  {quote.partnerFees.map((l, i) => <div key={`${l.label}-${i}`} className="flex justify-between gap-3"><dt>{l.label}<span className="text-[#326273]"> (partner&rsquo;s own fee)</span></dt><dd className="font-mono">{formatMoney(BigInt(l.amountMinor), l.currency)}</dd></div>)}
                  <div className="flex justify-between gap-3 border-t border-dashed border-[#326273]/25 pt-1.5 font-semibold"><dt>Leaves your wallet at most</dt><dd className="font-mono">{formatUsdc(BigInt(quote.totalDebitMinor))} USDC</dd></div>
                </dl>
                <p className="mt-2 text-[13px] text-[#326273]">{quote.route}.{quote.sandbox ? ' This quote is from a sandbox.' : ''} {owners.charAt(0).toUpperCase() + owners.slice(1)} sign before anything leaves the wallet.</p>
              </div>
            ) : null}
            {error ? <Note tone="error">{error}</Note> : null}
            <div className="flex flex-wrap gap-2">
              {quote ? (
                <>
                  <PrimaryButton type="button" disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : owner ? 'Send for signatures' : 'Ask the owners to approve'}</PrimaryButton>
                  <QuietButton type="button" onClick={() => setQuote(null)}>Change</QuietButton>
                </>
              ) : (
                <PrimaryButton type="button" disabled={busy || !chosen || !valid} onClick={() => void getQuote()}>{busy ? 'Getting the quote…' : 'Get a quote'}</PrimaryButton>
              )}
            </div>
          </div>
        )}

        {withdrawals.filter((w) => w.kind === 'withdrawal').length > 0 ? (
          <div>
            <h3 className="text-[13px] font-extrabold text-[#0c3e48]">Your withdrawals</h3>
            <ul className="mt-2 space-y-2">
              {withdrawals.filter((w) => w.kind === 'withdrawal').slice(0, 6).map((w) => {
                const line = withdrawalLine(w.status);
                return (
                  <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#326273]/12 bg-white p-3 text-[13px]">
                    <span className="min-w-0">
                      <span className="block font-mono font-semibold text-[#0c3e48]">{formatUsdc(BigInt(w.amountMinor))} USDC to {w.destination ? `${w.destination.label} ••${w.destination.last4}` : 'your bank'}</span>
                      {line.note ? <span className="block text-[#326273]">{line.note}</span> : null}
                    </span>
                    <Pill tone={line.tone}>{line.state}</Pill>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

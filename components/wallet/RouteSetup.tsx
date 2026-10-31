'use client';

import { useState } from 'react';
import { Check, Circle } from 'lucide-react';

import { call, errorText, type SigningView } from '@/components/transfer/api';
import SignPanel, { type SignLabels } from '@/components/transfer/SignPanel';
import { Field, PrimaryButton, QuietButton, SelectInput, TextInput } from '@/components/transfer/ui';
import { Address, CopyButton, Note } from './parts';

type Destination = { id: string; label: string; last4: string; holderName: string };
type DepositAddress = { status: string; address: string } | null;

const LABELS: SignLabels = {
  working: 'Sending the test deposit',
  done: 'Test deposit sent',
  doneNote: 'Your partner confirms it. Withdrawals open when it has.',
  deadNote: 'Nothing was sent. You can ask for the test deposit again.',
  restart: 'Start again',
};

/**
 * Setting up the route to the business's own bank (v2 brief 4.4; Sky's
 * decisions of 24 Oct): a bank account in the company's own name (checked
 * against the registered name and the bank's own holder name), the fixed
 * deposit address the partner gives this business, and a 1 USDC test deposit
 * the owners sign once. Only the partner's signed confirmation of that exact
 * deposit verifies the address. Owners only.
 */
export default function RouteSetup({ destinations, depositAddress, onChanged, onSigned }: { destinations: Destination[]; depositAddress: DepositAddress; onChanged: () => void; onSigned: () => void }) {
  const [adding, setAdding] = useState(destinations.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SigningView | null>(null);
  const status = depositAddress?.status ?? 'none';

  async function post(body: Record<string, string>): Promise<{ ok: boolean; request?: SigningView }> {
    setBusy(true);
    setError(null);
    const answer = await call<{ request?: SigningView }>('/api/wallet/withdrawals/deposit-address', { body });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, 'That did not work. Nothing was changed.'));
      return { ok: false };
    }
    onChanged();
    return { ok: true, request: answer.body?.request };
  }

  const steps = [
    { done: destinations.length > 0, label: 'A bank account in your company’s name' },
    { done: status !== 'none', label: 'Your deposit address with the bank partner' },
    { done: status === 'verified', label: 'A 1 USDC test deposit, confirmed by the partner' },
  ];

  if (request) return <SignPanel initial={request} labels={LABELS} onExecuted={onSigned} onRestart={() => setRequest(null)} />;

  return (
    <div className="space-y-4">
      <ol className="space-y-2" aria-label="Setting up withdrawals">
        {steps.map((step) => (
          <li key={step.label} className="flex items-center gap-2.5 text-sm text-[#1F4452]">
            {step.done ? <Check className="h-4 w-4 text-[var(--ok)]" aria-label="Done" /> : <Circle className="h-4 w-4 text-[#326273]" aria-label="To do" />}
            <span className={step.done ? 'font-semibold' : ''}>{step.label}</span>
          </li>
        ))}
      </ol>

      {destinations.length === 0 || adding ? (
        <AddBank onAdded={() => { setAdding(false); onChanged(); }} onClose={destinations.length > 0 ? () => setAdding(false) : null} />
      ) : (
        <ul className="space-y-1.5 text-[13px] text-[#1F4452]">
          {destinations.map((d) => <li key={d.id}>{d.label} ••{d.last4}, held by {d.holderName}</li>)}
          <li><button type="button" onClick={() => setAdding(true)} className="min-h-11 font-semibold text-[var(--info)] underline underline-offset-2">Add another account</button></li>
        </ul>
      )}

      {destinations.length > 0 ? (
        <div className="space-y-2">
          {status === 'none' ? (
            <>
              <Note>Ask the bank partner for the address your business pays into. It is fixed for your business and is checked once with a small test deposit.</Note>
              <PrimaryButton type="button" disabled={busy} onClick={() => void post({ action: 'request' })}>{busy ? 'Asking…' : 'Get my deposit address'}</PrimaryButton>
            </>
          ) : (
            <>
              {depositAddress ? <div className="flex items-center gap-2 rounded-xl bg-[#F6F0ED]/70 p-3"><Address value={depositAddress.address} /><CopyButton value={depositAddress.address} label="Copy the deposit address" /></div> : null}
              {status === 'pending_test' ? (
                <>
                  <Note>Check the address with a 1 USDC test deposit. Your owners sign it, and the partner confirms it arrived.</Note>
                  <PrimaryButton type="button" disabled={busy} onClick={() => void post({ action: 'test_deposit' }).then((r) => r.ok && r.request && setRequest(r.request))}>{busy ? 'Preparing…' : 'Send the 1 USDC test deposit'}</PrimaryButton>
                </>
              ) : null}
              {status === 'test_requested' ? <Note tone="warn">The test deposit is waiting for your owners to sign. It is under Needs your signature.</Note> : null}
              {status === 'test_sent' ? <Note tone="warn">The test deposit was sent. Withdrawals open when the partner confirms it arrived.</Note> : null}
            </>
          )}
        </div>
      ) : null}
      {error ? <Note tone="error">{error}</Note> : null}
    </div>
  );
}

const COUNTRIES = [['MY', 'Malaysia']] as const;

function AddBank({ onAdded, onClose }: { onAdded: () => void; onClose: (() => void) | null }) {
  const [f, setF] = useState({ holderName: '', country: 'MY', bankCode: '', accountNumber: '', label: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    setError(null);
    const answer = await call('/api/wallet/withdrawals/destinations', { body: { holderName: f.holderName.trim(), country: f.country, bankCode: f.bankCode.trim(), accountNumber: f.accountNumber.trim(), label: f.label.trim() } });
    setBusy(false);
    if (!answer.ok) {
      setError(errorText(answer, 'The account was not saved.'));
      return;
    }
    onAdded();
  }

  return (
    <div className="space-y-3 rounded-xl border border-[#326273]/15 bg-[#f4f8fa] p-4">
      <h3 className="text-sm font-extrabold text-[#0c3e48]">Your bank account</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name for this account" htmlFor="rs-label"><TextInput id="rs-label" value={f.label} onChange={set('label')} placeholder="Operating account" maxLength={60} /></Field>
        <Field label="Name on the account" hint="Your registered company name" htmlFor="rs-holder"><TextInput id="rs-holder" value={f.holderName} onChange={set('holderName')} autoComplete="organization" /></Field>
        <Field label="Country" htmlFor="rs-country">
          <SelectInput id="rs-country" value={f.country} onChange={set('country')}>
            {COUNTRIES.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </SelectInput>
        </Field>
        <Field label="Bank code" htmlFor="rs-bank"><TextInput id="rs-bank" value={f.bankCode} onChange={set('bankCode')} mono /></Field>
        <Field label="Account number" hint="Stored sealed; only the last four are shown" htmlFor="rs-number" className="sm:col-span-2"><TextInput id="rs-number" value={f.accountNumber} onChange={set('accountNumber')} inputMode="numeric" autoComplete="off" mono /></Field>
      </div>
      <Note>It is saved only when both the name you give and the name the bank holds match your company&rsquo;s registered name.</Note>
      {error ? <Note tone="error">{error}</Note> : null}
      <div className="flex flex-wrap gap-2">
        <PrimaryButton type="button" disabled={busy || !f.holderName.trim() || !f.bankCode.trim() || f.accountNumber.trim().length < 4} onClick={() => void save()}>{busy ? 'Checking the account…' : 'Check and save the account'}</PrimaryButton>
        {onClose ? <QuietButton type="button" onClick={onClose}>Cancel</QuietButton> : null}
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Check, ShieldCheck } from 'lucide-react';

import { type SigningView } from '@/components/transfer/api';
import { Field, PrimaryButton, QuietButton, TextInput } from '@/components/transfer/ui';
import { Card, Loading, Note, Pill, useLoad } from '@/components/wallet/parts';
import { policyRequest, type PolicyForm } from '@/lib/team-rules/form';
import { policyView, recipientOffers, type SpendWire } from '@/lib/team-rules/view';
import type { ClientRecipient } from '@/lib/recipients-page/wire';
import SignFlow, { askToSign } from './SignFlow';

const BLANK: PolicyForm = { perPayment: '', threshold: '', windowHours: '' };

/**
 * The business's spending policy (v2 §4.2): the most any one payment under a
 * rule may be, the amount at which an owner must approve (default 10,000
 * USDC), and the window that adds a recipient's payments together, so splitting
 * a payment does not avoid the approval. It also holds the verified recipients
 * staff may pay alone: only a recipient the payment gate would pay is offered.
 * Owners set and change all of it, each change signed by the owners and
 * effective at once; everyone else reads it.
 */
export default function PolicyCard({ owner, spend, onChanged }: { owner: boolean; spend: SpendWire; onChanged: () => void }) {
  const saved = useLoad<ClientRecipient[]>('/api/recipients', 'Your recipients could not be read.');
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PolicyForm>(BLANK);
  const [errors, setErrors] = useState<Partial<Record<keyof PolicyForm | 'form', string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SigningView | null>(null);
  const view = policyView(spend.policy);
  const creating = spend.policy === null;
  const set = <K extends keyof PolicyForm>(key: K, value: PolicyForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    const made = policyRequest(form, { creating });
    if (!made.ok) {
      setErrors(made.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    setError(null);
    // Created once for a wallet (POST); after that, a limit at a time or together (PATCH).
    const asked = creating
      ? await askToSign('/api/wallet/spending-rules/policy', { method: 'POST', body: made.body })
      : await askToSign('/api/wallet/spending-rules/policy', { method: 'PATCH', body: made.body });
    setBusy(false);
    if (!asked.ok) {
      setError(asked.error);
      return;
    }
    setEditing(false);
    setForm(BLANK);
    setRequest(asked.request);
  }

  async function recipients(change: { add?: Array<{ address: string; tag: 'wallet' | 'exchange' }>; remove?: string[] }) {
    setBusy(true);
    setError(null);
    const asked = await askToSign('/api/wallet/spending-rules/recipients', { method: 'POST', body: change });
    setBusy(false);
    if (!asked.ok) {
      setError(asked.error);
      return;
    }
    setRequest(asked.request);
  }

  const done = () => {
    setRequest(null);
    saved.reload();
    onChanged();
  };

  if (request) {
    return (
      <Card id="policy" title="Spending policy">
        <SignFlow request={request} onDone={done} onCancel={() => setRequest(null)} />
      </Card>
    );
  }

  const offers = recipientOffers(spend.policy, saved.data ?? []);

  return (
    <Card id="policy" title="Spending policy">
      <div className="space-y-4">
        {view ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            {[
              ['Most one payment', view.perPayment],
              ['An owner approves from', view.threshold],
              ['Payments to one recipient add up over', view.window],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-[#326273]/12 bg-white p-3">
                <dt className="text-[13px] font-semibold text-[#1F4452]">{label}</dt>
                <dd className="mt-1 text-lg font-extrabold tabular-nums text-[#0c3e48]">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <Note>{owner ? 'No spending policy is set yet, so staff payments go to your owners. Set the most any one payment under a rule may be to start.' : 'No spending policy is set yet, so staff payments go to your owners.'}</Note>
        )}

        {owner && !editing ? (
          <QuietButton type="button" onClick={() => { setError(null); setEditing(true); }} className="!h-10 !text-[13px]">{creating ? 'Set the spending policy' : 'Change the limits'}</QuietButton>
        ) : null}

        {owner && editing ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            className="space-y-4 rounded-2xl border border-[#326273]/15 bg-white p-4"
          >
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Most one payment" hint="USDC" error={errors.perPayment} htmlFor="pol-per">
                <TextInput id="pol-per" inputMode="decimal" value={form.perPayment} onChange={(e) => set('perPayment', e.target.value)} autoComplete="off" />
              </Field>
              {!creating ? (
                <>
                  <Field label="An owner approves from" hint="USDC" error={errors.threshold} htmlFor="pol-thr">
                    <TextInput id="pol-thr" inputMode="decimal" value={form.threshold} onChange={(e) => set('threshold', e.target.value)} autoComplete="off" />
                  </Field>
                  <Field label="Payments add up over" hint="hours" error={errors.windowHours} htmlFor="pol-win">
                    <TextInput id="pol-win" inputMode="numeric" value={form.windowHours} onChange={(e) => set('windowHours', e.target.value)} autoComplete="off" />
                  </Field>
                </>
              ) : null}
            </div>
            {!creating ? <p className="text-[13px] leading-5 text-[#326273]">Fill in only what you want to change. The window is 1 to 720 hours (up to 30 days).</p> : null}
            {errors.form ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{errors.form}</p> : null}
            {error ? <Note tone="error">{error}</Note> : null}
            <div className="flex flex-wrap gap-2">
              <PrimaryButton type="submit" disabled={busy}>{busy ? 'Asking your owners…' : 'Ask the owners to sign'}</PrimaryButton>
              <QuietButton type="button" onClick={() => { setEditing(false); setErrors({}); setError(null); }}>Cancel</QuietButton>
            </div>
          </form>
        ) : null}

        {view ? (
          <div className="space-y-3 border-t border-[#326273]/10 pt-4">
            <h3 className="flex items-center gap-2 text-sm font-extrabold text-[#0c3e48]"><ShieldCheck className="h-4 w-4 text-[var(--info)]" aria-hidden="true" />Recipients staff may pay alone</h3>
            <p className="text-[13px] leading-5 text-[#326273]">Only a recipient that is screened, approved by an owner and, for a wallet, proven by the supplier can be allowed. A bank account is allowed per beneficiary{view.bankAccounts > 0 ? ` (${view.bankAccounts} on the policy now)` : ''}.</p>
            {saved.loading ? <Loading label="Reading your recipients…" /> : null}
            {offers.allowed.length === 0 && !saved.loading ? <Note>No recipient is allowed yet, so staff ask the owners for each payment.</Note> : null}
            {offers.allowed.length > 0 ? (
              <ul className="space-y-2" aria-label="Allowed recipients">
                {offers.allowed.map((a) => (
                  <li key={a.address} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#F6F0ED] px-3 py-2 text-sm text-[#1F4452]">
                    <span className="min-w-0"><span className="font-semibold">{a.name ?? 'Not in your saved recipients'}</span> <span className="font-mono text-[13px] text-[#326273]">{`${a.address.slice(0, 6)}…${a.address.slice(-4)}`}</span></span>
                    <span className="flex items-center gap-2">
                      <Pill tone="ok"><Check className="mr-1 h-3 w-3" aria-hidden="true" />{a.tag === 'exchange' ? 'Exchange' : 'Wallet'}</Pill>
                      {owner ? <QuietButton type="button" disabled={busy} className="!h-10 !text-[13px]" aria-label={`Stop allowing ${a.name ?? a.address}`} onClick={() => void recipients({ remove: [a.address] })}>Stop allowing</QuietButton> : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {owner && offers.offers.length > 0 ? (
              <ul className="space-y-2" aria-label="Recipients you can allow">
                {offers.offers.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#326273]/12 bg-white px-3 py-2 text-sm text-[#1F4452]">
                    <span className="min-w-0 font-semibold">{o.name}</span>
                    <PrimaryButton type="button" disabled={busy} className="!h-10 !text-[13px]" aria-label={`Allow staff to pay ${o.name}`} onClick={() => void recipients({ add: [{ address: o.address, tag: o.tag }] })}>Allow staff to pay</PrimaryButton>
                  </li>
                ))}
              </ul>
            ) : null}
            {saved.error ? <Note tone="error">{saved.error}</Note> : null}
            {!editing && error ? <Note tone="error">{error}</Note> : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

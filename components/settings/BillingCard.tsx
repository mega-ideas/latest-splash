'use client';

import { useState } from 'react';

import { type SigningView } from '@/components/transfer/api';
import { Modal, PrimaryButton, QuietButton } from '@/components/transfer/ui';
import { Card, Loading, Note, Pill, useLoad } from '@/components/wallet/parts';
import { formatUsdc } from '@/lib/fees/copy';
import SignFlow, { askToSign } from './SignFlow';

type Plan = { id: string; name: string; priceMinor: string; termMonths: number; copy: string };
type Subscription = { id: string; planId: string; planName: string; status: string; priceMinor: string; copy: string; termStart: string; expiresAt: string; graceUntil: string | null };
type Billing = {
  subscription: Subscription | null;
  pending: Subscription | null;
  invoices: Array<{ id: string; number: string; period: string; planName: string; amountMinor: string; voided: boolean }>;
  receipts: Array<{ id: string; invoiceId: string; amountMinor: string; paidAt: string }>;
};

const STATUS: Record<string, string> = { active: 'Active', grace: 'Payment is late', pending: 'Waiting for signatures' };
const usdc = (minor: string) => `${formatUsdc(BigInt(minor))} USDC`;

/**
 * Billing (Amendment A1 §6), shown only while FEATURE_SUBSCRIPTION_BILLING is
 * on, which it is not: the page is not given this card otherwise, and every
 * route behind it answers 404. A plan is an allowance the business wallet's
 * owners sign: Splash can draw at most the plan's price per calendar month
 * (UTC), and the owners revoke it at any time. There are no late fees, and
 * billing never holds a payment back. Splash's price here is the plan's; the
 * payments' fees are on Fees and on each receipt.
 */
export default function BillingCard({ owner }: { owner: boolean }) {
  const billing = useLoad<Billing>('/api/wallet/subscription', 'Your plan could not be loaded.');
  const plans = useLoad<{ plans: Plan[] }>('/api/billing/plans', 'The plans could not be loaded.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<SigningView | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function ask(body: { action: 'subscribe' | 'change' | 'cancel'; planId?: string }) {
    setBusy(true);
    setError(null);
    const made = await askToSign('/api/wallet/subscription', { method: 'POST', body });
    setBusy(false);
    setCancelling(false);
    if (!made.ok) {
      setError(made.error);
      return;
    }
    setRequest(made.request);
  }

  if (request) {
    return (
      <Card id="billing" title="Billing">
        <SignFlow request={request} onDone={() => { setRequest(null); billing.reload(); }} onCancel={() => setRequest(null)} />
      </Card>
    );
  }
  if (billing.loading || plans.loading) return <Card id="billing" title="Billing"><Loading label="Reading your plan…" /></Card>;
  if (!billing.data) return <Card id="billing" title="Billing"><Note>{owner ? billing.error : 'Only an owner can see the plan.'}</Note></Card>;
  const { subscription, pending, invoices, receipts } = billing.data;

  return (
    <Card id="billing" title="Billing">
      <div className="space-y-4">
        {subscription ? (
          <div className="space-y-2 rounded-xl border border-[#326273]/12 bg-white p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-[#0c3e48]">{subscription.planName}</h3>
              <Pill tone={subscription.status === 'active' ? 'ok' : 'wait'}>{STATUS[subscription.status] ?? subscription.status}</Pill>
            </div>
            <p className="text-[13px] leading-5 text-[#1F4452]">{subscription.copy}</p>
            <p className="text-[13px] text-[#326273]">The plan runs to {subscription.expiresAt.slice(0, 10)} (UTC).{subscription.graceUntil ? ` A pull did not go through; billing stays open until ${subscription.graceUntil.slice(0, 10)}. Your payments are not affected.` : ''}</p>
            {owner ? <QuietButton type="button" disabled={busy} onClick={() => setCancelling(true)} className="!h-10 !text-[13px]">Cancel the plan</QuietButton> : null}
          </div>
        ) : (
          <Note>No plan yet. A plan lets Splash draw its monthly price from your wallet under an allowance your owners sign. Billing never holds a payment back. Revoke any time.</Note>
        )}
        {pending ? <Note>A plan change is waiting for signatures: {pending.planName}.</Note> : null}

        {owner && plans.data && plans.data.plans.length > 0 ? (
          <ul className="space-y-2" aria-label="Plans">
            {plans.data.plans.filter((p) => p.id !== subscription?.planId).map((p) => (
              <li key={p.id} className="rounded-xl border border-[#326273]/12 bg-white p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[#0c3e48]">{p.name}</h3>
                  <span className="font-mono text-sm font-bold tabular-nums text-[#0c3e48]">{usdc(p.priceMinor)} a month</span>
                </div>
                <p className="mt-1 text-[13px] leading-5 text-[#326273]">{p.copy}</p>
                <PrimaryButton type="button" disabled={busy || pending !== null} onClick={() => void ask({ action: subscription ? 'change' : 'subscribe', planId: p.id })} className="mt-3 !h-10 !text-[13px]" aria-label={`${subscription ? 'Change to' : 'Choose'} ${p.name}`}>
                  {subscription ? 'Change to this plan' : 'Choose this plan'}
                </PrimaryButton>
              </li>
            ))}
          </ul>
        ) : null}
        {plans.error && owner ? <Note>{plans.error}</Note> : null}

        {invoices.length > 0 ? (
          <div>
            <h3 className="text-sm font-extrabold text-[#0c3e48]">Invoices</h3>
            <ul className="mt-2 space-y-1.5" aria-label="Invoices">
              {invoices.map((i) => {
                const paid = receipts.some((r) => r.invoiceId === i.id);
                return (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-[#1F4452]">
                    <span><span className="font-mono">{i.number}</span> · {i.planName} · {i.period}</span>
                    <span className="flex items-center gap-2"><span className="tabular-nums">{usdc(i.amountMinor)}</span><Pill tone={i.voided ? 'bad' : paid ? 'ok' : 'wait'}>{i.voided ? 'Void' : paid ? 'Paid' : 'Due'}</Pill></span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {error ? <Note tone="error">{error}</Note> : null}
      </div>

      <Modal open={cancelling} onClose={() => setCancelling(false)} title="Cancel the plan?">
        <div className="space-y-4">
          <p className="text-sm leading-6 text-[#1F4452]">The owners revoke the allowance, so Splash can draw nothing more. Nothing already paid is returned, and your payments are not affected.</p>
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="button" disabled={busy} onClick={() => void ask({ action: 'cancel' })}>Ask the owners to sign</PrimaryButton>
            <QuietButton type="button" onClick={() => setCancelling(false)}>Keep the plan</QuietButton>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

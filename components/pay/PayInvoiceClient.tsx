'use client';

import { useState } from 'react';
import { Check, CheckCircle2, Copy, Info, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import PayWithUsdc, { type PublicUsdc } from '@/components/pay/PayWithUsdc';
import { CUSTODY_LICENCE } from '@/lib/custody-phase-rules';

type PublicInvoice = {
  issuerOrg: string;
  issuerVerified: boolean;
  amountUsd: string;
  targetCurrency: string;
  dueDate: string;
  memo?: string;
  status: string;
  paymentReference: string;
  /** A Splash collection account, or null in Phase 0: Splash may not hold the
   *  payer's funds yet, so the payer pays the issuer directly. */
  bankInstructions: { beneficiary: string; bank: string; account: string; swift: string } | null;
  /** USDC on Sui straight to the issuer's own wallet, when they have one. */
  usdc?: PublicUsdc;
  /** Whether a bank payment can be reported here. False in a USDC-only
   *  launch, where the report route answers 403. Absent means true. */
  bankReports?: boolean;
};

export default function PayInvoiceClient({ slug, invoice }: { slug: string; invoice: PublicInvoice }) {
  const [payerOrgName, setPayerOrgName] = useState('');
  const [payerOrgEmail, setPayerOrgEmail] = useState('');
  const [paid, setPaid] = useState(invoice.status === 'paid' || invoice.status === 'settled');
  const [submitting, setSubmitting] = useState(false);

  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    toast.success('Copied');
  }

  async function confirmPaid() {
    setSubmitting(true);
    const response = await fetch(`/api/pay/${slug}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payerOrgName, payerOrgEmail, paymentReference: invoice.paymentReference }),
    });
    setSubmitting(false);
    if (!response.ok) return toast.error('Enter valid payer details');
    setPaid(true);
    toast.success('Payment notification sent');
  }

  return (
    <main className="splash-page-bg min-h-screen px-4 py-10 text-foreground">
      <div className="mx-auto max-w-3xl">
        <header className="mb-7 flex items-center justify-between">
          <div>
            <div className="text-2xl font-black">Splash<span className="text-primary">.</span></div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-foreground/50">Global settlement engine</div>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-card px-3 py-1.5 text-xs font-bold">
            <ShieldCheck className="h-4 w-4 text-primary" /> Secure payment request
          </div>
        </header>

        <section className="dash-surface overflow-hidden">
          <div className="bg-foreground p-7 text-card">
            <div className="flex flex-wrap items-center gap-2 text-xs font-bold uppercase tracking-[0.15em] text-card/60">
              Payment request from {invoice.issuerOrg}
              {invoice.issuerVerified && <span className="rounded-full bg-primary/20 px-2 py-1 text-primary">Verified</span>}
            </div>
            <div className="mt-5 text-5xl font-black">${Number(invoice.amountUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
            <div className="mt-2 text-sm text-card/65">Due {invoice.dueDate}{invoice.bankReports === false ? '' : ` · settlement target ${invoice.targetCurrency}`}</div>
          </div>

          <div className="grid gap-6 p-7 md:grid-cols-[1fr_0.9fr]">
            <div>
              {invoice.bankInstructions ? (
                <>
                  <h1 className="text-xl font-black">Bank transfer instructions</h1>
                  <p className="mt-1 text-sm text-foreground/60">Use the unique reference so the payment can be matched automatically.</p>
                </>
              ) : (
                <>
                  <h1 className="text-xl font-black">Pay {invoice.issuerOrg} directly</h1>
                  <p className="mt-1 text-sm text-foreground/60">Send the transfer to the bank account on {invoice.issuerOrg}&rsquo;s invoice, with this reference so they can match it.</p>
                </>
              )}
              <div className="mt-5 space-y-3">
                {invoice.bankInstructions && Object.entries(invoice.bankInstructions).map(([label, value]) => (
                  <button key={label} type="button" onClick={() => copy(value)} className="flex w-full items-center justify-between rounded-xl bg-muted/50 p-3 text-left">
                    <span><small className="block uppercase tracking-wide text-foreground/45">{label}</small><strong>{value}</strong></span>
                    <Copy className="h-4 w-4 text-primary" />
                  </button>
                ))}
                <button type="button" onClick={() => copy(invoice.paymentReference)} className="flex w-full items-center justify-between rounded-xl border border-accent/30 bg-accent/10 p-3 text-left">
                  <span><small className="block uppercase tracking-wide text-foreground/45">Payment reference</small><strong className="font-mono">{invoice.paymentReference}</strong></span>
                  <Copy className="h-4 w-4 text-accent" />
                </button>
              </div>
              {!invoice.bankInstructions && (
                <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-[var(--info)]/20 bg-[var(--info-bg)] p-3">
                  <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--info)]" aria-hidden="true" />
                  <p className="text-[13px] leading-relaxed text-[var(--info)]">
                    <strong className="block font-semibold text-[var(--ink)]">Splash doesn&rsquo;t collect payments yet</strong>
                    Collecting a payment for someone else means holding their funds, which needs {CUSTODY_LICENCE}.
                  </p>
                </div>
              )}
              {invoice.memo && <p className="mt-4 rounded-xl bg-muted/50 p-3 text-sm text-foreground/65">{invoice.memo}</p>}
              <PayWithUsdc slug={slug} issuer={invoice.issuerOrg} usdc={invoice.usdc ?? null} />
            </div>

            <div className="rounded-2xl border border-foreground/10 bg-card p-5">
              {invoice.bankReports === false && !paid ? (
                <div className="flex h-full flex-col justify-center">
                  <h2 className="text-lg font-black">Paid by bank?</h2>
                  <p className="mt-1 text-sm text-foreground/60">
                    Let {invoice.issuerOrg} know directly.{' '}
                    {invoice.usdc ? 'This page confirms USDC payments on Sui only.' : `${invoice.issuerOrg} has not set up USDC payments on Sui yet, so pay them directly.`}
                  </p>
                </div>
              ) : paid ? (
                <div className="flex h-full flex-col items-center justify-center text-center">
                  <CheckCircle2 className="h-12 w-12 text-primary" />
                  <h2 className="mt-3 text-lg font-black">Payment reported</h2>
                  <p className="mt-1 text-sm text-foreground/60">The issuer can now match and settle this invoice.</p>
                </div>
              ) : (
                <>
                  <h2 className="text-lg font-black">Already transferred?</h2>
                  <p className="mt-1 text-sm text-foreground/60">Tell the issuer who sent the bank transfer.</p>
                  <input value={payerOrgName} onChange={(event) => setPayerOrgName(event.target.value)} placeholder="Organisation name" className="mt-5 w-full rounded-xl border border-foreground/15 bg-background px-3 py-3 outline-none focus:border-primary" />
                  <input value={payerOrgEmail} onChange={(event) => setPayerOrgEmail(event.target.value)} placeholder="Finance email" type="email" className="mt-3 w-full rounded-xl border border-foreground/15 bg-background px-3 py-3 outline-none focus:border-primary" />
                  <button disabled={submitting || !payerOrgName || !payerOrgEmail} onClick={confirmPaid} className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 py-3 font-black text-card disabled:opacity-50">
                    <Check className="h-4 w-4" /> {submitting ? 'Sending...' : 'I sent the transfer'}
                  </button>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

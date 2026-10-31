'use client';

import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Check, Copy, Download, ExternalLink, FileText, Loader2, Mail, MessageCircle, Send } from 'lucide-react';

import { MY_STATE_CODES, SELF_BILLED_CLASSIFICATIONS } from '@/lib/myinvois/self-billed';
import { EINVOICE_GUIDELINE, isEmail, mailtoUrl, receiptShareText, whatsappUrl } from '@/lib/transfer/receipt';
import { call, errorText, type ReceiptAnswer } from './api';
import { Field, PrimaryButton, QuietButton, SelectInput, TextInput } from './ui';

/** Step 5, "Receipt": the card, the ways to share it, the accountant, and the self-billed e-invoice. */
export default function StepReceipt({ refId, onNew }: { refId: string; onNew: () => void }) {
  const base = `/api/wallet/transfers/${encodeURIComponent(refId)}`;
  const [data, setData] = useState<ReceiptAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [accountant, setAccountant] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const answer = await call<ReceiptAnswer>(`${base}/receipt`);
    if (!answer.ok || !answer.body) {
      setError(errorText(answer, 'The receipt could not be loaded.'));
      return;
    }
    setError(null);
    setData(answer.body);
  }, [base]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch the receipt on mount; state is set when it answers
    void load();
  }, [load]);

  useEffect(() => {
    if (!data || data.receipt.final) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [data, load]);

  async function makeLink(): Promise<string | null> {
    if (link) return link;
    setBusy('link');
    const answer = await call<{ url?: string }>(`${base}/share`, { body: { via: 'link' } });
    setBusy(null);
    if (!answer.ok || !answer.body?.url) {
      setNote(errorText(answer, 'The link could not be made.'));
      return null;
    }
    setLink(answer.body.url);
    return answer.body.url;
  }

  if (error && !data) return <p role="alert" className="rounded-xl border border-[var(--error)]/40 bg-[var(--error-bg)] p-4 text-sm font-medium text-[var(--error)]">{error}</p>;
  if (!data) return <p role="status" className="flex items-center gap-2 text-sm text-[#326273]"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading the receipt…</p>;
  const { receipt, rows } = data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[22px] font-extrabold text-[#0c3e48]">{receipt.final ? 'Paid' : 'On its way'}</h2>
        <p className="mt-1 text-sm text-[#326273]">{receipt.final ? 'Keep this receipt, or hand it to your supplier or accountant.' : 'The payment has not settled yet. This page updates when it has; the receipt is final then.'}</p>
      </div>

      <article aria-label="Payment receipt" className="overflow-hidden rounded-2xl border border-[#326273]/15 bg-white">
        <header className="flex items-center justify-between gap-3 border-b border-[#326273]/10 bg-[#0c3e48] px-4 py-3 text-white">
          <span className="text-sm font-bold">Payment receipt</span>
          {receipt.final ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ok-bg)] px-2.5 py-1 text-[12px] font-bold text-[#145d6a]"><BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />Verified on Sui</span>
          ) : (
            <span className="rounded-full bg-[var(--gold-tint)] px-2.5 py-1 text-[12px] font-bold text-[#0c3e48]">Not final</span>
          )}
        </header>
        <dl className="divide-y divide-[#326273]/10 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5 px-4 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
              <dt className="text-[#326273]">{row.label}</dt>
              <dd className="min-w-0 break-words font-mono font-bold tabular-nums text-[#0c3e48] sm:text-right">{row.value}</dd>
            </div>
          ))}
        </dl>
        {receipt.verifyUrl ? (
          <a href={receipt.verifyUrl} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center justify-between gap-3 border-t border-[#326273]/10 px-4 py-3 text-sm font-bold text-[#0d6370] hover:bg-[#f4f8fa] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0d6370]">
            Check this payment on Sui
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
          </a>
        ) : null}
      </article>

      {receipt.final ? (
        <section aria-labelledby="share-h" className="space-y-3">
          <h3 id="share-h" className="text-base font-extrabold text-[#0c3e48]">Share</h3>
          <div className="flex flex-wrap gap-2">
            <QuietButton
              type="button"
              disabled={busy === 'link'}
              onClick={async () => {
                const url = await makeLink();
                if (url) window.open(whatsappUrl(receiptShareText(receipt, url)), '_blank', 'noopener,noreferrer');
              }}
            >
              <MessageCircle className="h-4 w-4" aria-hidden="true" />WhatsApp
            </QuietButton>
            <QuietButton
              type="button"
              disabled={busy === 'link'}
              onClick={async () => {
                const url = await makeLink();
                if (url) window.location.href = mailtoUrl({ subject: `Receipt ${receipt.receiptNo}`, body: receiptShareText(receipt, url) });
              }}
            >
              <Mail className="h-4 w-4" aria-hidden="true" />Email
            </QuietButton>
            <QuietButton
              type="button"
              disabled={busy === 'link'}
              onClick={async () => {
                const url = await makeLink();
                if (!url) return;
                try {
                  await navigator.clipboard.writeText(url);
                  setNote('Link copied. Anyone with it can check this receipt against Sui, without signing in. It works for 30 days.');
                } catch {
                  setNote(url);
                }
              }}
            >
              {link ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}Copy link
            </QuietButton>
            <a href={`${base}/receipt?format=pdf`} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] transition-colors hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
              <FileText className="h-4 w-4" aria-hidden="true" />PDF
            </a>
          </div>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!isEmail(accountant.trim())) {
                setNote('Enter your accountant’s email address.');
                return;
              }
              setBusy('accountant');
              const answer = await call(`${base}/share`, { body: { via: 'accountant', to: accountant.trim() } });
              setBusy(null);
              setNote(answer.ok ? `Sent to ${accountant.trim()}.` : errorText(answer, 'The email could not be sent.'));
            }}
          >
            <div className="flex-1">
              <TextInput type="email" icon={Mail} aria-label="Your accountant's email" placeholder="accountant@firm.com" value={accountant} onChange={(e) => setAccountant(e.target.value)} autoComplete="off" />
            </div>
            <PrimaryButton type="submit" disabled={busy === 'accountant'}>
              <Send className="h-4 w-4" aria-hidden="true" />
              {busy === 'accountant' ? 'Sending…' : 'Send to accountant'}
            </PrimaryButton>
          </form>
          {note ? <p role="status" className="break-words text-sm text-[#1F4452]">{note}</p> : null}
        </section>
      ) : null}

      <EInvoice base={base} data={data} onChange={load} />

      <div className="flex justify-end border-t border-[#326273]/10 pt-4">
        <PrimaryButton type="button" onClick={onNew}>Make another payment</PrimaryButton>
      </div>
    </div>
  );
}

function EInvoice({ base, data, onChange }: { base: string; data: ReceiptAnswer; onChange: () => Promise<void> }) {
  const { offer, made } = data.eInvoice;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ buyerTin: '', phone: '', stateCode: '14', description: '', classification: '034', exchangeRateToMyr: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  if (!offer.offered && offer.why !== 'supplier_country_unknown') return null;

  async function make() {
    setBusy(true);
    setError(null);
    const answer = await call(`${base}/e-invoice`, { body: form });
    setBusy(false);
    if (!answer.ok) {
      const problems = (answer.body as { problems?: string[] } | null)?.problems;
      setError(problems?.length ? problems.join(' ') : errorText(answer, 'The e-invoice could not be made.'));
      return;
    }
    await onChange();
  }

  return (
    <section aria-labelledby="einv-h" className="space-y-3 rounded-2xl border border-[#326273]/15 bg-white p-4 sm:p-5">
      <h3 id="einv-h" className="text-base font-extrabold text-[#0c3e48]">Self-billed e-invoice (MyInvois)</h3>
      {!offer.offered ? (
        <p className="text-sm leading-6 text-[#1F4452]">Splash does not have this supplier&rsquo;s country on file, so it cannot tell whether a self-billed e-invoice applies. Add the country in Recipients.</p>
      ) : made ? (
        <div className="space-y-3">
          <p className="text-sm leading-6 text-[#1F4452]">Your file is ready ({made.fileName}). Download it, then upload it in MyInvois. Splash does not submit it for you.</p>
          <div className="flex flex-wrap gap-2">
            <a href={`${base}/e-invoice?download=1`} className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-[#326273]/25 bg-white px-4 text-sm font-semibold text-[#1F4452] hover:border-[#0d6370] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
              <Download className="h-4 w-4" aria-hidden="true" />Download the file
            </a>
            <a href={EINVOICE_GUIDELINE.portal} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-[#0d6370] px-5 text-sm font-bold text-white hover:bg-[#073d49] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0d6370]">
              <ExternalLink className="h-4 w-4" aria-hidden="true" />Open MyInvois
            </a>
          </div>
        </div>
      ) : !open ? (
        <>
          <p className="text-sm leading-6 text-[#1F4452]">For a Malaysian business paying a supplier outside Malaysia, LHDN asks you to issue the e-invoice yourself. Splash makes the file; you upload it in MyInvois.</p>
          <QuietButton type="button" onClick={() => setOpen(true)}>Make the e-invoice file</QuietButton>
        </>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void make();
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your business's TIN" hint="As LHDN issued it" htmlFor="e-tin"><TextInput id="e-tin" mono value={form.buyerTin} onChange={(e) => set('buyerTin', e.target.value.toUpperCase())} autoComplete="off" /></Field>
            <Field label="Contact number" htmlFor="e-phone"><TextInput id="e-phone" inputMode="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)} autoComplete="tel" /></Field>
            <Field label="Your state" htmlFor="e-state">
              <SelectInput id="e-state" value={form.stateCode} onChange={(e) => set('stateCode', e.target.value)}>
                {Object.entries(MY_STATE_CODES).map(([code, name]) => (
                  <option key={code} value={code}>{name}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="This paid for" htmlFor="e-class">
              <SelectInput id="e-class" value={form.classification} onChange={(e) => set('classification', e.target.value)}>
                {Object.entries(SELF_BILLED_CLASSIFICATIONS).map(([code, name]) => (
                  <option key={code} value={code}>{name.replace('Self-billed - ', '')}</option>
                ))}
              </SelectInput>
            </Field>
            <Field label="What was bought" htmlFor="e-desc" className="sm:col-span-2"><TextInput id="e-desc" value={form.description} onChange={(e) => set('description', e.target.value)} autoComplete="off" /></Field>
            <Field label="Exchange rate, MYR per USD" hint="For the payment date" htmlFor="e-rate"><TextInput id="e-rate" mono inputMode="decimal" value={form.exchangeRateToMyr} onChange={(e) => set('exchangeRateToMyr', e.target.value)} autoComplete="off" /></Field>
          </div>
          {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <PrimaryButton type="submit" disabled={busy}>{busy ? 'Making the file…' : 'Make the file'}</PrimaryButton>
            <QuietButton type="button" onClick={() => setOpen(false)}>Cancel</QuietButton>
          </div>
          <p className="text-[13px] leading-5 text-[#326273]">Splash fills in none of these for you. The file follows {EINVOICE_GUIDELINE.version}, checked {EINVOICE_GUIDELINE.checkedOn}.</p>
        </form>
      )}
    </section>
  );
}

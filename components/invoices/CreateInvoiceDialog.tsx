'use client';

/**
 * Create an invoice (Get paid, v2 brief 5.8). The fields are the ones the
 * form always had; what changed is the flow: grouped questions, errors under
 * the field they belong to, a preview of what the payer sees, and the pay
 * link ready to copy the moment the invoice exists.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Copy, ExternalLink, Loader2, Lock, X } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { ACTIVE_USD_CORRIDORS } from '@/lib/fx/corridors';
import type { InvoiceRecord } from '@/lib/server/operations';

type Form = { issuerOrg: string; payerOrgName: string; payerOrgEmail: string; amountUsd: string; targetCurrency: string; dueDate: string; memo: string };
type Errors = Partial<Record<keyof Form, string>>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

function inDays(n: number): string {
  return new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
}

function validate(form: Form): Errors {
  const e: Errors = {};
  if (form.issuerOrg.trim().length < 2) e.issuerOrg = 'Enter the name your payer knows you by.';
  if (form.payerOrgName.trim().length < 2) e.payerOrgName = 'Enter who is paying.';
  if (form.payerOrgEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.payerOrgEmail)) e.payerOrgEmail = 'That email address does not look right.';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(form.amountUsd) || !/[1-9]/.test(form.amountUsd)) e.amountUsd = 'Enter an amount above zero with at most two decimals, like 1250.00.';
  if (!form.dueDate) e.dueDate = 'Choose a due date.';
  else if (form.dueDate < new Date().toISOString().slice(0, 10)) e.dueDate = 'The due date is in the past.';
  if (form.memo.length > 500) e.memo = 'Keep the note under 500 characters.';
  return e;
}

/** What a 409 create_key_reused names: the invoice already made under the key. */
type ExistingInvoice = Pick<InvoiceRecord, 'id' | 'amountUsd' | 'dueDate' | 'status' | 'payLinkSlug'> & { payerOrgName: string | null };

export default function CreateInvoiceDialog({ issuerName, documentsOpen, close, onCreated }: {
  issuerName: string; documentsOpen: boolean; close: () => void; onCreated: () => void;
}) {
  const [form, setForm] = useState<Form>({ issuerOrg: issuerName, payerOrgName: '', payerOrgEmail: '', amountUsd: '', targetCurrency: ACTIVE_USD_CORRIDORS[0]?.currency ?? 'PHP', dueDate: inDays(14), memo: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [documentBase64, setDocumentBase64] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<InvoiceRecord | null>(null);
  // Whether the payer would find a wallet to pay: unknown until the server says.
  const [walletReady, setWalletReady] = useState<boolean | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  // One key for the invoice this dialog is creating, kept across retries, so
  // a second click or a retry after a dropped connection is answered with
  // the same invoice and pay link (lib/invoices/create-once.ts).
  const [createKey] = useState(() => crypto.randomUUID());
  const [submitError, setSubmitError] = useState<string | null>(null);
  // A 409 names the invoice already made under this form's key.
  const [existing, setExisting] = useState<ExistingInvoice | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  // Typing something in, or attaching a file, is work a stray tap should not throw away.
  const [initial] = useState(form);
  const dirty = !created && (documentBase64 !== undefined || (Object.keys(form) as Array<keyof Form>).some((k) => form[k] !== initial[k]));
  const guard = useRef<() => void>(() => {});
  useEffect(() => { guard.current = () => { if (dirty) setAskDiscard(true); else close(); }; }, [dirty, close]);
  const requestClose = useCallback(() => guard.current(), []);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    firstField.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [requestClose]);

  const set = (key: keyof Form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }));
  };

  async function attach(file: File) {
    const reader = new FileReader();
    reader.onload = () => setDocumentBase64(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = Object.keys(found)[0];
      dialogRef.current?.querySelector<HTMLElement>(`#ci-${first}`)?.focus();
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    setExisting(null);
    try {
      const response = await fetch('/api/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, payerOrgEmail: form.payerOrgEmail || '', documentBase64, createKey }),
      });
      const body = (await response.json().catch(() => ({}))) as { invoice?: InvoiceRecord; error?: string; code?: string; existing?: ExistingInvoice | null; receiveWallet?: { ready: boolean } };
      setWalletReady(body.receiveWallet ? body.receiveWallet.ready : null);
      if (!response.ok || !body.invoice) {
        // Shown once, in the role=alert line under the button (no toast, so
        // a screen reader hears it once).
        if (body.code === 'create_key_reused') {
          setExisting(body.existing ?? null);
          setSubmitError(body.existing
            ? `An invoice was already created from this form: ${Number(body.existing.amountUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC${body.existing.payerOrgName ? ` from ${body.existing.payerOrgName}` : ''}, with other details than these. Open it to check it before you send it, or close this form and start a new one.`
            : 'An invoice was already created from this form, with other details. Close this form and start a new one.');
        } else {
          setSubmitError(body.error ?? 'The invoice was not created. Try again.');
        }
        return;
      }
      setCreated(body.invoice);
      onCreated();
    } catch {
      setSubmitError('The connection dropped before Splash answered. Try again: the invoice will not be made twice.');
    } finally {
      setSubmitting(false);
    }
  }

  const payLink = created ? `${window.location.origin}/pay/${created.payLinkSlug}` : '';
  const amountShown = useMemo(() => (Number(form.amountUsd) > 0 ? Number(form.amountUsd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'), [form.amountUsd]);

  async function copyLink() {
    await navigator.clipboard.writeText(payLink);
    toast.success('Pay link copied');
    if (created && created.status === 'draft') {
      await fetch(`/api/invoices/${created.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'sent' }) });
      setCreated({ ...created, status: 'sent' });
      onCreated();
    }
  }

  // On document.body, above the floating Zeke button.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-[#0c3e48]/40 p-0 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="ci-title" className="dash-surface max-h-[92dvh] w-full max-w-4xl overflow-y-auto rounded-b-none p-5 sm:rounded-b-2xl sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="ci-title" className="text-2xl font-bold tracking-tight text-[#0c3e48]">{created ? 'Your invoice is ready' : 'Create an invoice'}</h2>
            <p className="mt-1 text-sm text-[#326273]">{created ? 'Share the pay link with your payer. It shows the amount, the due date and how to pay.' : 'Your payer gets a pay link to pay you in USDC on Sui.'}</p>
          </div>
          <button type="button" onClick={requestClose} aria-label="Close" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-transparent text-[#1f4452] hover:bg-[#326273]/10"><X className="h-5 w-5" aria-hidden="true" /></button>
        </div>

        {askDiscard && (
          <div role="alertdialog" aria-labelledby="ci-discard" className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--warn)]/35 bg-[var(--warn-bg)] p-4 text-sm text-[var(--warn-ink)]">
            <p id="ci-discard" className="font-semibold">Close without creating this invoice? What you typed is lost.</p>
            <div className="flex gap-2">
              <button type="button" autoFocus onClick={() => setAskDiscard(false)} className="dash-btn min-h-11 !text-[13px]">Keep editing</button>
              <button type="button" onClick={close} className="dash-btn dash-btn-ghost min-h-11 !text-[13px]">Close it</button>
            </div>
          </div>
        )}

        {created ? (
          <div className="mt-6 space-y-4">
            <div className="flex items-start gap-3 rounded-xl border border-[var(--ok)]/25 bg-[var(--ok-bg)] p-4 text-sm text-[#1f4452]">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[var(--ok)]" aria-hidden="true" />
              <p><strong className="font-semibold">{created.payerOrgName}</strong> owes {Number(created.amountUsd).toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC by {dayLabel(created.dueDate)}.</p>
            </div>
            {walletReady === false && (
              <div role="alert" className="rounded-xl border border-[var(--warn)]/35 bg-[var(--warn-bg)] p-4 text-sm leading-6 text-[var(--warn-ink)]">
                <strong className="font-semibold">Your payer cannot pay this link yet.</strong> USDC arrives in the Splash Wallet of your main admin, and that wallet is not set up. Set up a passkey in <Link href="/dashboard/settings" className="font-semibold underline underline-offset-2">Settings, Security</Link>, then share the link.
              </div>
            )}
            <label htmlFor="ci-link" className="block text-[13px] font-semibold text-[#1f4452]">Pay link</label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input id="ci-link" readOnly value={payLink} onFocus={(e) => e.currentTarget.select()} className="h-11 min-w-0 flex-1 rounded-lg border border-[#326273]/20 bg-white px-3 font-mono text-[13px] text-[#1f4452]" />
              <button type="button" onClick={() => void copyLink()} disabled={walletReady === false} className="dash-btn min-h-11 disabled:opacity-50"><Copy className="h-4 w-4" aria-hidden="true" /> Copy pay link</button>
              <a href={payLink} target="_blank" rel="noreferrer" className="dash-btn dash-btn-ghost min-h-11 !text-[13px]">Preview <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
            </div>
            <div className="flex justify-end"><button type="button" onClick={close} className="dash-btn dash-btn-ghost min-h-11 !text-[13px]">Done</button></div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-6">
              <Group title="Who is paying">
                <Field id="payerOrgName" label="Payer’s business" required error={errors.payerOrgName}>
                  <input ref={firstField} id="ci-payerOrgName" autoComplete="organization" value={form.payerOrgName} onChange={(e) => set('payerOrgName')(e.target.value)} aria-invalid={Boolean(errors.payerOrgName)} aria-describedby="ci-payerOrgName-msg" />
                </Field>
                <Field id="payerOrgEmail" label="Their finance email" hint="Optional. Where the pay link is sent." error={errors.payerOrgEmail}>
                  <input id="ci-payerOrgEmail" type="email" autoComplete="email" value={form.payerOrgEmail} onChange={(e) => set('payerOrgEmail')(e.target.value)} aria-invalid={Boolean(errors.payerOrgEmail)} aria-describedby="ci-payerOrgEmail-msg" />
                </Field>
              </Group>
              <Group title="What they owe">
                <Field id="amountUsd" label="Amount (USDC)" required error={errors.amountUsd}>
                  <input id="ci-amountUsd" inputMode="decimal" autoComplete="off" placeholder="1250.00" value={form.amountUsd} onChange={(e) => set('amountUsd')(e.target.value)} aria-invalid={Boolean(errors.amountUsd)} aria-describedby="ci-amountUsd-msg" className="font-mono" />
                </Field>
                <Field id="targetCurrency" label="Settlement currency" hint="The local currency this invoice is recorded against.">
                  <select id="ci-targetCurrency" value={form.targetCurrency} onChange={(e) => set('targetCurrency')(e.target.value)} aria-describedby="ci-targetCurrency-msg">
                    {ACTIVE_USD_CORRIDORS.map((c) => <option key={c.currency} value={c.currency}>{c.currency}</option>)}
                  </select>
                </Field>
                <Field id="memo" label="What it is for" hint="Shown to your payer." error={errors.memo} wide>
                  <textarea id="ci-memo" rows={2} value={form.memo} onChange={(e) => set('memo')(e.target.value)} aria-invalid={Boolean(errors.memo)} aria-describedby="ci-memo-msg" />
                </Field>
              </Group>
              <Group title="When, and from whom">
                <Field id="dueDate" label="Due date" required error={errors.dueDate}>
                  <input id="ci-dueDate" type="date" value={form.dueDate} onChange={(e) => set('dueDate')(e.target.value)} aria-invalid={Boolean(errors.dueDate)} aria-describedby="ci-dueDate-msg" />
                </Field>
                <Field id="issuerOrg" label="Your business name" required hint="As your payer knows you." error={errors.issuerOrg}>
                  <input id="ci-issuerOrg" autoComplete="organization" value={form.issuerOrg} onChange={(e) => set('issuerOrg')(e.target.value)} aria-invalid={Boolean(errors.issuerOrg)} aria-describedby="ci-issuerOrg-msg" />
                </Field>
              </Group>
              {documentsOpen && (
                <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-[#326273]/30 bg-white/60 p-4 focus-within:ring-2 focus-within:ring-[#5c9ead]/40">
                  <Lock className="h-5 w-5 text-[#145d6a]" aria-hidden="true" />
                  <span className="text-sm"><strong className="block font-semibold text-[#1f4452]">Attach the PDF (optional)</strong><span className="text-[13px] text-[#326273]">Encrypted before it is stored</span></span>
                  <input type="file" accept=".pdf,image/*" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); }} />
                  {documentBase64 && <CheckCircle2 className="ml-auto h-5 w-5 text-[var(--ok)]" aria-label="Attached" />}
                </label>
              )}
            </div>

            <aside aria-labelledby="ci-preview" className="lg:sticky lg:top-0 lg:self-start">
              <h3 id="ci-preview" className="text-[13px] font-semibold text-[#326273]">What your payer sees</h3>
              <div className="mt-2 overflow-hidden rounded-2xl border border-[#326273]/12 bg-white shadow-[6px_7px_0_rgba(12,62,72,.08)]">
                <div className="bg-[#0c3e48] p-4 text-white">
                  <p className="text-[12px] text-white/80">Payment request from {form.issuerOrg || 'your business'}</p>
                  <p className="dash-num mt-2 font-mono text-3xl font-semibold">{amountShown} <span className="text-base font-medium text-white/80">USDC</span></p>
                  <p className="mt-1 text-[13px] text-white/80">Due {form.dueDate ? dayLabel(form.dueDate) : 'on the date you choose'}</p>
                </div>
                <div className="space-y-2 p-4 text-[13px] text-[#1f4452]">
                  <p><span className="text-[#326273]">To </span>{form.payerOrgName || 'your payer'}</p>
                  {form.memo && <p className="rounded-lg bg-[#326273]/6 p-2">{form.memo}</p>}
                  <p className="text-[#326273]">Pays in USDC on Sui, to the Splash Wallet of your main admin.</p>
                </div>
              </div>
              <button type="submit" disabled={submitting} aria-describedby={submitError ? 'ci-submit-error' : undefined} className="dash-btn mt-4 min-h-11 w-full disabled:opacity-50">
                {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} {submitting ? 'Creating…' : 'Create invoice and pay link'}
              </button>
              {submitError && (
                <p id="ci-submit-error" role="alert" className="mt-2 text-[13px] font-semibold leading-snug text-[var(--error)]">{submitError}</p>
              )}
              {existing && (
                <button type="button" onClick={() => { setCreated({ ...existing, payerOrgName: existing.payerOrgName ?? form.payerOrgName } as InvoiceRecord); onCreated(); }} className="dash-btn dash-btn-ghost mt-2 min-h-11 w-full !text-[13px]">
                  Open the invoice already made
                </button>
              )}
            </aside>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-3 text-sm font-semibold text-[#0c3e48]">{title}</legend>
      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Field({ id, label, hint, error, required, wide, children }: { id: string; label: string; hint?: string; error?: string; required?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <div className={cn(wide && 'sm:col-span-2')}>
      <label htmlFor={`ci-${id}`} className="text-[13px] font-semibold text-[#1f4452]">
        {label}{required && <span className="text-[var(--error)]" aria-hidden="true">*</span>}
      </label>
      <div className="mt-1 [&_input]:h-11 [&_input]:w-full [&_input]:rounded-lg [&_input]:border [&_input]:border-[#326273]/20 [&_input]:bg-white [&_input]:px-3 [&_input]:text-sm [&_input]:text-[#1f4452] [&_input:focus]:border-[#145d6a] [&_input:focus]:outline-none [&_input:focus]:ring-2 [&_input:focus]:ring-[#5c9ead]/30 [&_input[aria-invalid=true]]:border-[var(--error)] [&_select]:h-11 [&_select]:w-full [&_select]:rounded-lg [&_select]:border [&_select]:border-[#326273]/20 [&_select]:bg-white [&_select]:px-3 [&_select]:text-sm [&_textarea]:w-full [&_textarea]:rounded-lg [&_textarea]:border [&_textarea]:border-[#326273]/20 [&_textarea]:bg-white [&_textarea]:px-3 [&_textarea]:py-2 [&_textarea]:text-sm">
        {children}
      </div>
      <p id={`ci-${id}-msg`} className={cn('mt-1 min-h-4 text-[12px]', error ? 'font-semibold text-[var(--error)]' : 'text-[#326273]')} role={error ? 'alert' : undefined}>
        {error ?? hint ?? ''}
      </p>
    </div>
  );
}

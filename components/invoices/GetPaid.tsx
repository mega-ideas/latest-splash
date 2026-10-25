'use client';

/**
 * Get paid (v2 brief 5.8): invoices the business sends, each with a pay link,
 * a status that only moves forward (lib/invoices/status.ts) and a receipt
 * once paid.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, ExternalLink, FilePlus2, Loader2, ReceiptText, RefreshCw, Search, X } from 'lucide-react';
import { toast } from 'sonner';

import CreateInvoiceDialog from '@/components/invoices/CreateInvoiceDialog';
import LocalTime from '@/components/LocalTime';
import { useLaunchScope } from '@/components/dashboard/CustodyPhaseContext';
import { suiScanTxUrlOn } from '@/lib/explorer';
import { INVOICE_STATUS_LABEL, canMoveInvoice, invoiceOpen } from '@/lib/invoices/status';
import type { InvoiceRecord, InvoiceStatusV2 } from '@/lib/server/operations';
import { cn } from '@/lib/utils';

const STATUS_STYLE: Record<InvoiceStatusV2, string> = {
  draft: 'bg-[#326273]/10 text-[#1f4452]',
  sent: 'bg-[var(--info-bg)] text-[var(--info)]',
  viewed: 'bg-[var(--info-bg)] text-[var(--info)]',
  reported: 'bg-[var(--warn-bg)] text-[var(--warn-ink)]',
  overdue: 'bg-[var(--error-bg)] text-[var(--error)]',
  paid: 'bg-[var(--ok-bg)] text-[#1f4452]',
  settled: 'bg-[#0c3e48] text-white',
};

const FILTERS: Array<'all' | 'open' | InvoiceStatusV2> = ['all', 'open', 'reported', 'overdue', 'paid', 'settled'];
const FILTER_LABEL: Record<string, string> = { all: 'All', open: 'Open', reported: 'Payer says paid', overdue: 'Overdue', paid: 'Paid', settled: 'Settled' };

async function fetchInvoices() {
  const response = await fetch('/api/invoices', { cache: 'no-store' });
  if (!response.ok) throw new Error('Invoices could not be loaded.');
  return (await response.json()) as { invoices: InvoiceRecord[] };
}

function usdc(value: string | number): string {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar day (YYYY-MM-DD) as "19 Nov 2026". A day has no time zone, so none is applied. */
function dateLabel(iso?: string): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}


export default function GetPaid({ issuerName, onCounts }: { issuerName: string; onCounts?: (counts: { open: number }) => void }) {
  const queryClient = useQueryClient();
  const documentsOpen = useLaunchScope() !== 'stablecoin';
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [marking, setMarking] = useState<InvoiceRecord | null>(null);
  const [receipt, setReceipt] = useState<InvoiceRecord | null>(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['invoices'], queryFn: fetchInvoices });
  const invoices = useMemo(() => data?.invoices ?? [], [data?.invoices]);

  useEffect(() => {
    // Only a loaded list is a count; an empty one while loading is not zero.
    if (data) onCounts?.({ open: data.invoices.filter((i) => invoiceOpen(i.status)).length });
  }, [data, onCounts]);

  const filtered = useMemo(() => invoices.filter((invoice) => {
    const q = search.trim().toLowerCase();
    const statusOk = filter === 'all' || (filter === 'open' ? invoiceOpen(invoice.status) : invoice.status === filter);
    return statusOk && (!q || invoice.payerOrgName?.toLowerCase().includes(q) || invoice.id.toLowerCase().includes(q) || invoice.memo?.toLowerCase().includes(q));
  }), [filter, invoices, search]);

  const totals = useMemo(() => {
    const month = new Date().toISOString().slice(0, 7);
    const open = invoices.filter((i) => invoiceOpen(i.status));
    return {
      openAmount: open.reduce((s, i) => s + Number(i.amountUsd || 0), 0),
      openCount: open.length,
      overdue: invoices.filter((i) => i.status === 'overdue').length,
      paidMonth: invoices.filter((i) => (i.status === 'paid' || i.status === 'settled') && (i.usdcPaidAt ?? i.updatedAt).slice(0, 7) === month).reduce((s, i) => s + Number(i.amountUsd || 0), 0),
    };
  }, [invoices]);

  const statusMutation = useMutation({
    mutationFn: async ({ id, status, paymentReference }: { id: string; status: InvoiceStatusV2; paymentReference?: string }) => {
      const response = await fetch(`/api/invoices/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, ...(paymentReference ? { paymentReference } : {}) }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'The invoice was not updated.');
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['invoices'] }),
    onError: (e) => toast.error(e.message),
  });

  // Every open invoice against one read of the business's Splash Wallet on
  // Sui (lib/server/usdc-invoice-payments.ts). Reads and records; moves nothing.
  const usdcSync = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/invoices/usdc-sync', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { status?: string; paid?: Array<{ invoiceId: string }>; checked?: number; alreadyUsed?: string[]; reason?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? 'USDC payments could not be checked.');
      return body;
    },
    onSuccess: (body) => {
      if (body.status === 'NO_WALLET') toast.info('USDC payments arrive in your Splash Wallet. Set up a passkey first, in Settings, Security.');
      else if (body.status === 'UNAVAILABLE') toast.error(`Sui could not be read just now: ${body.reason ?? 'try again shortly'}`);
      else {
        const paid = body.paid?.length ?? 0;
        toast.success(paid > 0 ? `${paid} invoice${paid === 1 ? '' : 's'} paid in USDC, recorded.` : `No new USDC payments across ${body.checked ?? 0} open invoice${body.checked === 1 ? '' : 's'}.`);
        if ((body.alreadyUsed?.length ?? 0) > 0) toast.warning('One transfer matched more than one invoice; it was recorded against the first only.');
      }
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (e) => toast.error(e.message),
  });

  async function copyPayLink(invoice: InvoiceRecord) {
    await navigator.clipboard.writeText(`${window.location.origin}/pay/${invoice.payLinkSlug}`);
    toast.success('Pay link copied');
    if (invoice.status === 'draft') statusMutation.mutate({ id: invoice.id, status: 'sent' });
  }

  function actions(invoice: InvoiceRecord, compact = false) {
    const btn = 'inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-[13px] font-semibold';
    return (
      <div className={cn('flex flex-wrap gap-2', !compact && 'justify-end')}>
        {invoiceOpen(invoice.status) && (
          <>
            <button type="button" onClick={() => void copyPayLink(invoice)} className={cn(btn, 'border border-[#326273]/15 bg-white text-[#1f4452]')}><Copy className="h-3.5 w-3.5" aria-hidden="true" /> Pay link</button>
            {canMoveInvoice(invoice.status, 'paid') && (
              <button type="button" onClick={() => setMarking(invoice)} className={cn(btn, 'border border-[#326273]/15 bg-white text-[#1f4452]')}><CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Mark as paid</button>
            )}
          </>
        )}
        {invoice.status === 'paid' && (
          <button type="button" onClick={() => statusMutation.mutate({ id: invoice.id, status: 'settled' })} className={cn(btn, 'bg-[#237284] text-white')}>Mark settled</button>
        )}
        {(invoice.status === 'paid' || invoice.status === 'settled') && (
          <button type="button" onClick={() => setReceipt(invoice)} className={cn(btn, 'border border-[#326273]/15 bg-white text-[#1f4452]')}><ReceiptText className="h-3.5 w-3.5" aria-hidden="true" /> Receipt</button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="dash-block grid grid-cols-3 divide-x divide-[#326273]/10 p-0">
          {[
            { label: 'Open', value: `${usdc(totals.openAmount)}`, sub: `${totals.openCount} invoice${totals.openCount === 1 ? '' : 's'}` },
            { label: 'Overdue', value: String(totals.overdue), sub: 'past due' },
            { label: 'Paid this month', value: usdc(totals.paidMonth), sub: 'USDC' },
          ].map((s) => (
            <div key={s.label} className="min-w-0 px-3 py-3 sm:px-4">
              <p className="text-[12px] font-semibold text-[#326273]">{s.label}</p>
              <p className="dash-num mt-0.5 font-mono text-[15px] sm:text-lg font-semibold leading-tight text-[#0c3e48] [overflow-wrap:anywhere]">{s.value}</p>
              <p className="text-[12px] text-[#326273]">{s.sub}</p>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => usdcSync.mutate()} disabled={usdcSync.isPending} className="dash-btn dash-btn-ghost min-h-11 !text-[13px] disabled:opacity-60">
            {usdcSync.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />} Check USDC payments
          </button>
          <button type="button" onClick={() => setCreateOpen(true)} className="dash-btn dash-btn-gold order-first min-h-11 sm:order-none"><FilePlus2 className="h-4 w-4" aria-hidden="true" /> Create invoice</button>
        </div>
      </div>

      <section className="dash-surface overflow-hidden" aria-labelledby="sent-invoices-title">
        <div className="flex flex-col gap-3 border-b border-[#326273]/10 p-4 md:flex-row md:items-center md:justify-between">
          <h2 id="sent-invoices-title" className="sr-only">Invoices you sent</h2>
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:pb-0" role="group" aria-label="Show">
            {FILTERS.map((value) => (
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)} className={cn('min-h-11 shrink-0 rounded-full px-3 text-[13px] font-semibold', filter === value ? 'bg-[#0c3e48] text-white' : 'bg-[#326273]/8 text-[#1f4452]')}>
                {FILTER_LABEL[value]}
              </button>
            ))}
          </div>
          <label className="flex min-h-11 items-center gap-2 rounded-xl border border-[#326273]/15 bg-white px-3">
            <Search className="h-4 w-4 text-[#326273]" aria-hidden="true" />
            <span className="sr-only">Search invoices</span>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by payer or note" className="w-full bg-transparent text-sm text-[#1f4452] outline-none placeholder:text-[#326273] md:w-56" />
          </label>
        </div>

        {error ? (
          <p role="alert" className="p-6 text-sm font-medium text-[var(--error)]">{(error as Error).message}</p>
        ) : isLoading ? (
          <div className="space-y-2 p-4" aria-hidden="true">{[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-[#326273]/8" />)}</div>
        ) : filtered.length === 0 ? (
          <div className="p-6 text-sm text-[#326273]">
            {invoices.length === 0 ? (
              <>
                <p className="font-semibold text-[#1f4452]">No invoices yet.</p>
                <p className="mt-1">Create one, and your payer gets a pay link to pay you in USDC on Sui.</p>
              </>
            ) : <p>No invoices match.</p>}
          </div>
        ) : (
          <>
            <table className="hidden w-full text-sm md:table">
              <thead className="text-left text-[12px] font-semibold text-[#326273]">
                <tr className="border-b border-[#326273]/10"><th className="px-4 py-2.5">Payer</th><th className="px-4 py-2.5 text-right">Amount</th><th className="px-4 py-2.5">Due</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {filtered.map((invoice) => (
                  <tr key={invoice.id} className="border-b border-[#326273]/6 last:border-0">
                    <td className="px-4 py-3"><strong className="font-semibold text-[#1f4452]">{invoice.payerOrgName ?? 'Payer not named'}</strong><span className="mt-0.5 block max-w-[28ch] truncate text-[12px] text-[#326273]">{invoice.memo || invoice.id}</span></td>
                    <td className="px-4 py-3 text-right"><span className="dash-num font-mono font-semibold text-[#0c3e48]">{usdc(invoice.amountUsd)}</span> <span className="text-[12px] text-[#326273]">USDC</span></td>
                    <td className="px-4 py-3 text-[#1f4452]">{dateLabel(invoice.dueDate)}</td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-block rounded-full px-2.5 py-1 text-[12px] font-semibold', STATUS_STYLE[invoice.status])}>{INVOICE_STATUS_LABEL[invoice.status]}</span>
                      {invoice.usdcTxDigest && <span className="mt-1 block text-[12px] text-[#326273]">Paid in USDC on Sui</span>}
                      {invoice.status === 'reported' && invoice.payerReportedReference && <span className="mt-1 block text-[12px] text-[#326273]">Their reference <span className="font-mono break-all">{invoice.payerReportedReference}</span></span>}
                    </td>
                    <td className="px-4 py-3">{actions(invoice)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-[#326273]/8 md:hidden">
              {filtered.map((invoice) => (
                <li key={invoice.id} className="space-y-2 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-[#1f4452]">{invoice.payerOrgName ?? 'Payer not named'}</p>
                      <p className="text-[12px] text-[#326273]">Due {dateLabel(invoice.dueDate)}</p>
                    </div>
                    <p className="dash-num shrink-0 font-mono font-semibold text-[#0c3e48]">{usdc(invoice.amountUsd)} <span className="text-[12px] font-normal text-[#326273]">USDC</span></p>
                  </div>
                  <span className={cn('inline-block rounded-full px-2.5 py-1 text-[12px] font-semibold', STATUS_STYLE[invoice.status])}>{INVOICE_STATUS_LABEL[invoice.status]}</span>
                  {invoice.status === 'reported' && invoice.payerReportedReference && <p className="text-[12px] text-[#326273]">Their reference <span className="font-mono break-all">{invoice.payerReportedReference}</span></p>}
                  {actions(invoice, true)}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {createOpen && (
        <CreateInvoiceDialog
          issuerName={issuerName || invoices[0]?.issuerOrg || ''}
          documentsOpen={documentsOpen}
          close={() => setCreateOpen(false)}
          onCreated={() => void queryClient.invalidateQueries({ queryKey: ['invoices'] })}
        />
      )}
      {marking && (
        <MarkPaid
          invoice={marking}
          close={() => setMarking(null)}
          submit={(reference) => statusMutation.mutate({ id: marking.id, status: 'paid', paymentReference: reference }, { onSuccess: () => setMarking(null) })}
          busy={statusMutation.isPending}
        />
      )}
      {receipt && <InvoiceReceipt invoice={receipt} close={() => setReceipt(null)} />}
    </div>
  );
}

function Sheet({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); previous?.focus?.(); };
  }, [close]);
  // On document.body, so no stacking context in the page puts the floating
  // Zeke button over the sheet's own button.
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-[#0c3e48]/40 backdrop-blur-sm sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className="dash-surface w-full max-w-md rounded-b-none p-5 sm:rounded-b-2xl">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-[#0c3e48]">{title}</h2>
          <button type="button" onClick={close} aria-label="Close" className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-transparent text-[#1f4452] hover:bg-[#326273]/10"><X className="h-5 w-5" aria-hidden="true" /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function MarkPaid({ invoice, close, submit, busy }: { invoice: InvoiceRecord; close: () => void; submit: (reference: string) => void; busy: boolean }) {
  // Empty on purpose: the reference is the one the business finds on its own
  // bank statement, typed here. The payer's report is shown beside it, never
  // filled in for them.
  const [reference, setReference] = useState('');
  const payer = invoice.payerReportedName ?? invoice.payerOrgName ?? 'The payer';
  return (
    <Sheet title="Mark as paid" close={close}>
      <form onSubmit={(e) => { e.preventDefault(); if (reference.trim().length >= 4) submit(reference.trim()); }} className="mt-3 space-y-3">
        <p className="text-sm text-[#1f4452]">Mark it paid once the payment of <span className="dash-num font-mono">{usdc(invoice.amountUsd)}</span> USD has reached your account. Enter the reference your bank shows for it.</p>
        {invoice.payerReportedReference && (
          <div className="rounded-xl bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn-ink)]">
            <p className="font-semibold">{payer} says they paid</p>
            <p className="mt-1">Their reference: <span className="font-mono break-all">{invoice.payerReportedReference}</span>{invoice.payerReportedAt ? <>, reported <LocalTime value={invoice.payerReportedAt} format="date" locale="en-GB" options={{ day: 'numeric', month: 'short', year: 'numeric' }} /></> : null}. Find it on your statement before you mark it paid.</p>
          </div>
        )}
        <div>
          <label htmlFor="mark-ref" className="text-[13px] font-semibold text-[#1f4452]">Reference on your statement<span className="text-[var(--error)]" aria-hidden="true">*</span></label>
          <input id="mark-ref" value={reference} onChange={(e) => setReference(e.target.value)} minLength={4} maxLength={64} autoComplete="off" aria-describedby="mark-ref-help" className="mt-1 h-11 w-full rounded-lg border border-[#326273]/20 bg-white px-3 font-mono text-sm focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30" />
          <p id="mark-ref-help" className="mt-1 text-[12px] text-[#326273]">4 to 64 characters, as your bank shows it. It cannot be changed once the invoice is paid.</p>
        </div>
        <button type="submit" disabled={busy || reference.trim().length < 4} className="dash-btn min-h-11 w-full disabled:opacity-50">Mark as paid</button>
      </form>
    </Sheet>
  );
}

function InvoiceReceipt({ invoice, close }: { invoice: InvoiceRecord; close: () => void }) {
  const rows: Array<[string, React.ReactNode]> = [
    ['Receipt for', <span key="i" className="font-mono">{invoice.id}</span>],
    ['From', invoice.payerOrgName ?? 'Payer not named'],
    ['To', invoice.issuerOrg],
    ['Amount', <span key="a" className="dash-num font-mono">{usdc(invoice.amountUsd)} USDC</span>],
    ['Paid', <LocalTime key="p" value={invoice.usdcPaidAt ?? invoice.updatedAt} format="date" locale="en-GB" options={{ day: 'numeric', month: 'short', year: 'numeric' }} />],
    ['Method', invoice.usdcTxDigest ? 'USDC on Sui' : 'Bank transfer, confirmed by you'],
    ...(invoice.receivedReference
      ? [['Your reference', <span key="rr" className="font-mono break-all">{invoice.receivedReference}</span>] as [string, React.ReactNode]]
      : []),
    // The reference the pay link asked the payer to quote (app/pay/[slug]/page.tsx).
    ['Reference asked for', <span key="r" className="font-mono break-all">{invoice.paymentReference ?? `SPL-${invoice.payLinkSlug.toUpperCase()}-${invoice.id.slice(-4).toUpperCase()}`}</span>],
    ['Status', INVOICE_STATUS_LABEL[invoice.status]],
  ];
  return (
    <Sheet title="Receipt" close={close}>
      <dl className="mt-3 divide-y divide-[#326273]/8 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 py-2"><dt className="text-[#326273]">{k}</dt><dd className="text-right font-medium text-[#1f4452]">{v}</dd></div>
        ))}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2">
        {invoice.usdcTxDigest && (
          <a href={suiScanTxUrlOn('mainnet', invoice.usdcTxDigest)} target="_blank" rel="noreferrer" className="dash-btn dash-btn-ghost min-h-11 !text-[13px]">Verify on Sui <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /></a>
        )}
        <button type="button" onClick={() => window.print()} className="dash-btn dash-btn-ghost min-h-11 !text-[13px]">Save as PDF</button>
      </div>
    </Sheet>
  );
}

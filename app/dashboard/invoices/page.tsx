'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, CheckCircle2, Copy, Database, FilePlus2, FileText, Loader2, Lock, RefreshCw, Search, Send, ShieldCheck, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';

import InvoiceLoop from '@/components/invoices/InvoiceLoop';
import StatusBadge from '@/components/StatusBadge';
import { suiScanTxUrlOn } from '@/lib/explorer';
import { ACTIVE_USD_CORRIDORS } from '@/lib/fx/corridors';
import type { InvoiceRecord, InvoiceStatusV2 } from '@/lib/server/operations';

type InvoiceView = 'vault' | 'loop';

const statusStyle: Record<InvoiceStatusV2, string> = {
  draft: 'bg-foreground/10 text-foreground/90',
  sent: 'bg-primary/10 text-foreground',
  viewed: 'bg-primary/10 text-foreground',
  paid: 'bg-accent/15 text-[#9f5839]',
  settled: 'bg-primary/15 text-foreground',
  overdue: 'bg-destructive/10 text-[#1F4452]',
};

async function fetchInvoices() {
  const response = await fetch('/api/invoices');
  if (!response.ok) throw new Error('Invoices unavailable');
  return (await response.json()) as { invoices: InvoiceRecord[] };
}

export default function InvoicesPage() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<InvoiceView>('vault');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | InvoiceStatusV2>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading } = useQuery({ queryKey: ['invoices'], queryFn: fetchInvoices });
  const invoices = useMemo(() => data?.invoices ?? [], [data?.invoices]);

  // Deep links from the old /dashboard/0xwal route land on the loop tab.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') !== 'loop') return;
    const timeout = setTimeout(() => setView('loop'), 0);
    return () => clearTimeout(timeout);
  }, []);

  const filtered = useMemo(() => invoices.filter((invoice) => {
    const q = search.trim().toLowerCase();
    return (filter === 'all' || invoice.status === filter) &&
      (!q || invoice.payerOrgName?.toLowerCase().includes(q) || invoice.id.toLowerCase().includes(q));
  }), [filter, invoices, search]);

  const statusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: InvoiceStatusV2 }) => {
      const response = await fetch(`/api/invoices/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error('Invoice update failed');
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['invoices'] }),
    onError: (error) => toast.error(error.message),
  });

  // Every open invoice against one read of the main admin's Splash wallet on
  // Sui (lib/server/usdc-invoice-payments.ts): records USDC payments a payer
  // never pressed "check" for. Reads and records; moves nothing.
  const usdcSync = useMutation({
    mutationFn: async () => {
      const response = await fetch('/api/invoices/usdc-sync', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as {
        status?: string; paid?: Array<{ invoiceId: string }>; checked?: number; alreadyUsed?: string[]; reason?: string; error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? 'USDC payments could not be checked.');
      return body;
    },
    onSuccess: (body) => {
      if (body.status === 'NO_WALLET') {
        toast.info('USDC payments go to your main admin’s Splash wallet — they need a passkey first (Settings → Security).');
      } else if (body.status === 'UNAVAILABLE') {
        toast.error(`Couldn't read Sui just now: ${body.reason ?? 'try again shortly'}`);
      } else {
        const paid = body.paid?.length ?? 0;
        toast.success(paid > 0 ? `${paid} invoice${paid === 1 ? '' : 's'} paid in USDC — recorded.` : `No new USDC payments across ${body.checked ?? 0} open invoice${body.checked === 1 ? '' : 's'}.`);
        if ((body.alreadyUsed?.length ?? 0) > 0) toast.warning('A transfer matched more than one invoice; it was recorded against the first only.');
      }
      void queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
    onError: (error) => toast.error(error.message),
  });

  async function copyPayLink(invoice: InvoiceRecord) {
    const link = `${window.location.origin}/pay/${invoice.payLinkSlug}`;
    await navigator.clipboard.writeText(link);
    toast.success('Pay link copied');
    if (invoice.status === 'draft') statusMutation.mutate({ id: invoice.id, status: 'sent' });
  }

  const totals = {
    value: invoices.reduce((sum, invoice) => sum + Number(invoice.amountUsd || 0), 0),
    walrus: invoices.filter((invoice) => invoice.walrusBlobId).length,
    settled: invoices.filter((invoice) => invoice.status === 'settled').length,
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <span className="dash-kicker">Get paid</span>
          <h1 className="dash-title mt-2">Invoices</h1>
          <p className="mt-1 text-sm text-foreground">
            {view === 'vault'
              ? 'Create a pay link, protect the document with Seal, and preserve its proof on Walrus.'
              : 'Ask Zeke to inspect an invoice: encrypted intake, Walrus proof, Seal access, and a route recommendation.'}
          </p>
        </div>
        {view === 'vault' && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => usdcSync.mutate()}
              disabled={usdcSync.isPending}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-foreground/15 bg-card px-4 py-3 text-sm font-bold disabled:opacity-60"
            >
              {usdcSync.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
              Check USDC payments
            </button>
            <button onClick={() => setCreateOpen(true)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-bold text-[#073d49] shadow-lg shadow-accent/20">
              <FilePlus2 className="h-4 w-4" /> Create invoice
            </button>
          </div>
        )}
      </header>

      {/* The old standalone "Invoice loop" page now lives here as a tab. */}
      <div className="flex w-fit gap-1 rounded-xl border border-foreground/10 bg-card p-1">
        {([
          { key: 'vault', label: 'Invoice vault', icon: FileText },
          { key: 'loop', label: 'Inspection loop', icon: Sparkles },
        ] as const).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition ${
              view === key ? 'bg-foreground text-card shadow-sm' : 'text-foreground/90 hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {view === 'loop' && <InvoiceLoop />}

      {view === 'vault' && (<>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: 'Invoices', value: invoices.length, icon: FileText },
          { label: 'Invoice value', value: `$${totals.value.toLocaleString()}`, icon: Archive },
          { label: 'Walrus proofs', value: `${totals.walrus}/${invoices.length}`, icon: Database },
          { label: 'Settled', value: totals.settled, icon: CheckCircle2 },
        ].map(({ label, value, icon: Icon }) => (
          <div key={label} className="dash-block p-4">
            <div className="flex items-center justify-between"><span className="text-[12px] font-semibold uppercase tracking-[0.16em] text-foreground/90">{label}</span><Icon className="h-4 w-4 text-foreground" /></div>
            <div className="dash-num mt-2 text-2xl font-bold">{value}</div>
          </div>
        ))}
      </section>

      <section className="dash-surface overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-foreground/10 p-4 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap gap-2">
            {(['all', 'draft', 'sent', 'paid', 'settled', 'overdue'] as const).map((value) => (
              <button key={value} onClick={() => setFilter(value)} className={`rounded-full px-3 py-1.5 text-[13px] font-bold capitalize ${filter === value ? 'bg-foreground text-card' : 'bg-muted/50 text-[#1F4452]'}`}>
                {value}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-foreground/10 bg-card px-3 py-2">
            <Search className="h-4 w-4 text-foreground/90" />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search invoices" className="bg-transparent text-sm outline-none" />
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-muted/40 text-left text-[12px] font-semibold uppercase tracking-[0.14em] text-foreground/90">
              <tr><th className="px-4 py-3">Payer</th><th className="px-4 py-3">Amount</th><th className="px-4 py-3">Due</th><th className="px-4 py-3">Proof</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Action</th></tr>
            </thead>
            <tbody>
              {isLoading ? <tr><td colSpan={6} className="p-8 text-center text-foreground/90">Loading invoice vault...</td></tr> :
                filtered.map((invoice) => (
                  <tr key={invoice.id} className="border-t border-foreground/8">
                    <td className="px-4 py-4"><strong>{invoice.payerOrgName ?? 'Draft payer'}</strong><small className="mt-1 block font-mono text-foreground/90">{invoice.id}</small></td>
                    <td className="px-4 py-4"><strong>${Number(invoice.amountUsd).toLocaleString()}</strong><small className="mt-1 block text-foreground/90">USD → {invoice.targetCurrency}</small></td>
                    <td className="px-4 py-4 text-foreground/90">{invoice.dueDate}</td>
                    <td className="px-4 py-4">
                      {invoice.walrusBlobId ? <span className="inline-flex items-center gap-2 rounded-full bg-primary/10 px-2.5 py-1 text-[13px] font-semibold text-foreground"><ShieldCheck className="h-3 w-3" /> Seal + Walrus</span> : <span className="text-[13px] text-foreground/90">No document</span>}
                    </td>
                    <td className="px-4 py-4"><span className={`rounded-full px-2.5 py-1 text-[13px] font-bold capitalize ${statusStyle[invoice.status]}`}>{invoice.status}</span>{invoice.demo && <span className="ml-2"><StatusBadge status="demo" /></span>}{invoice.usdcTxDigest && <a href={suiScanTxUrlOn('mainnet', invoice.usdcTxDigest)} target="_blank" rel="noreferrer" className="mt-1 block text-[12px] font-semibold text-foreground hover:underline">Paid in USDC · verified on Sui</a>}</td>
                    <td className="px-4 py-4">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => copyPayLink(invoice)} className="inline-flex items-center gap-1 rounded-lg border border-foreground/10 bg-card px-3 py-2 text-[13px] font-bold"><Copy className="h-3.5 w-3.5" /> Pay link</button>
                        {invoice.status === 'paid' && <button onClick={() => statusMutation.mutate({ id: invoice.id, status: 'settled' })} className="inline-flex items-center gap-1 rounded-lg bg-[#237284] px-3 py-2 text-[13px] font-bold text-card"><CheckCircle2 className="h-3.5 w-3.5" /> Settle</button>}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>
      </>)}

      {createOpen && <CreateInvoiceModal close={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void queryClient.invalidateQueries({ queryKey: ['invoices'] }); }} />}
    </div>
  );
}

function CreateInvoiceModal({ close, onCreated }: { close: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ issuerOrg: 'Splash Workspace', payerOrgName: '', payerOrgEmail: '', amountUsd: '', targetCurrency: 'PHP', dueDate: '', memo: '' });
  const [documentBase64, setDocumentBase64] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function fileToBase64(file: File) {
    const reader = new FileReader();
    reader.onload = () => setDocumentBase64(String(reader.result).split(',')[1]);
    reader.readAsDataURL(file);
  }

  async function create() {
    setSubmitting(true);
    const response = await fetch('/api/invoices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, documentBase64 }),
    });
    setSubmitting(false);
    if (!response.ok) return toast.error('Complete the required invoice fields');
    toast.success('Invoice created');
    onCreated();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="dash-surface max-h-[90vh] w-full max-w-2xl overflow-y-auto p-6">
        <div className="flex items-start justify-between"><div><span className="dash-kicker">New payment request</span><h2 className="mt-2 text-2xl font-bold">Create invoice</h2></div><button onClick={close} className="rounded-full p-2 hover:bg-muted"><X className="h-5 w-5" /></button></div>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Issuer organisation"><input value={form.issuerOrg} onChange={(e) => setForm({ ...form, issuerOrg: e.target.value })} /></Field>
          <Field label="Payer organisation"><input value={form.payerOrgName} onChange={(e) => setForm({ ...form, payerOrgName: e.target.value })} /></Field>
          <Field label="Payer finance email"><input type="email" value={form.payerOrgEmail} onChange={(e) => setForm({ ...form, payerOrgEmail: e.target.value })} /></Field>
          <Field label="Amount USD"><input type="number" min="1" value={form.amountUsd} onChange={(e) => setForm({ ...form, amountUsd: e.target.value })} /></Field>
          <Field label="Settlement currency"><select value={form.targetCurrency} onChange={(e) => setForm({ ...form, targetCurrency: e.target.value })}>{ACTIVE_USD_CORRIDORS.map((corridor) => <option key={corridor.currency}>{corridor.currency}</option>)}</select></Field>
          <Field label="Due date"><input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
        </div>
        <Field label="Memo"><textarea value={form.memo} onChange={(e) => setForm({ ...form, memo: e.target.value })} /></Field>
        <label className="mt-4 flex cursor-pointer items-center gap-3 rounded-2xl border border-dashed border-primary/35 bg-primary/5 p-4">
          <Lock className="h-5 w-5 text-foreground" /><span><strong className="block">Optional PDF</strong><small className="text-foreground/90">Encrypted before Walrus storage</small></span>
          <input type="file" accept=".pdf,image/*" className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) void fileToBase64(file); }} />
          {documentBase64 && <CheckCircle2 className="ml-auto h-5 w-5 text-foreground" />}
        </label>
        <button disabled={submitting} onClick={create} className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 font-bold text-[#073d49] disabled:opacity-50"><Send className="h-4 w-4" /> {submitting ? 'Creating...' : 'Create secure pay link'}</button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="mt-4 block text-xs font-semibold uppercase tracking-[0.12em] text-foreground/90">{label}<div className="mt-1 [&_input]:w-full [&_input]:rounded-xl [&_input]:border [&_input]:border-foreground/15 [&_input]:bg-card [&_input]:px-3 [&_input]:py-3 [&_input]:text-sm [&_input]:font-medium [&_select]:w-full [&_select]:rounded-xl [&_select]:border [&_select]:border-foreground/15 [&_select]:bg-card [&_select]:px-3 [&_select]:py-3 [&_textarea]:min-h-20 [&_textarea]:w-full [&_textarea]:rounded-xl [&_textarea]:border [&_textarea]:border-foreground/15 [&_textarea]:bg-card [&_textarea]:px-3 [&_textarea]:py-3">{children}</div></label>;
}

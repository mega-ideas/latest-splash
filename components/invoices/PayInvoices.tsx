'use client';

/**
 * Pay invoices (v2 brief 5.8): a supplier's invoice from intake to receipt.
 *
 * The left column brings invoices in and lists them by where they are. The
 * right column is one invoice: the document as it was read, with each value
 * Zeke found marked where it was found, the fields to check, and the steps
 * after (duplicates, recipient, schedule, approve, paid, receipt and the
 * self-billed MyInvois e-invoice). The server decides every step
 * (lib/server/bills.ts); this page shows what it decided and why.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  FileDown,
  FileText,
  Loader2,
  Lock,
  Paperclip,
  ReceiptText,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import LocalTime from '@/components/LocalTime';
import { cn } from '@/lib/utils';
import { formatMicros, toMicros } from '@/lib/bills/amount';
import { BILL_CURRENCIES, BILL_FIELDS, CONFIDENCE_LABEL, COUNTRY_CODES, type BillField, type Confidence } from '@/lib/bills/extract';
import { BILL_STEP_LABEL, type BillStatus, type BillStep, type StepState } from '@/lib/bills/flow';
import { MYINVOIS_PORTAL_URL, MY_STATE_CODES, SELF_BILLED_CLASSIFICATIONS } from '@/lib/myinvois/self-billed';
import type { BillView } from '@/lib/server/bills';

type ListResponse = {
  bills: BillView[];
  business: { name: string; country: string | null } | null;
  canWrite: boolean;
  reader: 'zeke' | 'parser';
  paymentFlowWired: boolean;
  /** The payment flow can drop an intent nobody signed, so an invoice can be withdrawn from approval. */
  paymentFlowCancels?: boolean;
};

const FIELD_LABEL: Record<BillField, string> = {
  payee: 'Supplier',
  invoiceNumber: 'Invoice number',
  amount: 'Amount due',
  currency: 'Currency',
  dueDate: 'Due date',
  invoiceDate: 'Invoice date',
  payeeCountry: 'Supplier country',
};

const COUNTRY_NAME: Record<string, string> = {
  PH: 'Philippines', ID: 'Indonesia', MY: 'Malaysia', SG: 'Singapore', TH: 'Thailand', VN: 'Vietnam', CN: 'China',
  HK: 'Hong Kong', US: 'United States', IN: 'India', JP: 'Japan', AU: 'Australia', GB: 'United Kingdom', KR: 'South Korea',
  TW: 'Taiwan', AE: 'United Arab Emirates', DE: 'Germany', FR: 'France', NL: 'Netherlands',
};

/** One tint per field, shared by the mark in the document and its row in the form. */
const FIELD_TINT: Record<BillField, string> = {
  payee: 'bg-[#5c9ead]/25',
  invoiceNumber: 'bg-[#efc46f]/45',
  amount: 'bg-[#6fb4a0]/35',
  currency: 'bg-[#6fb4a0]/20',
  dueDate: 'bg-[#d9a441]/30',
  invoiceDate: 'bg-[#326273]/15',
  payeeCountry: 'bg-[#5c9ead]/15',
};

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: 'border-[var(--ok)]/30 bg-[var(--ok-bg)] text-[#1f4452]',
  medium: 'border-[var(--info)]/25 bg-[var(--info-bg)] text-[var(--info)]',
  low: 'border-[var(--warn)]/35 bg-[var(--warn-bg)] text-[var(--warn-ink)]',
  none: 'border-[var(--pending)]/25 bg-[var(--pending-bg)] text-[#1f4452]',
};

const GROUPS: Array<{ title: string; statuses: BillStatus[] }> = [
  { title: 'To review', statuses: ['review'] },
  { title: 'Scheduled', statuses: ['scheduled'] },
  { title: 'Waiting for approval', statuses: ['approving'] },
  { title: 'Paid', statuses: ['paid'] },
  { title: 'Cancelled', statuses: ['cancelled'] },
];

const TEXT_TYPES = '.txt,.csv,.xml,.json,.eml,.html,.htm,.pdf,text/plain,application/pdf';

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string; code?: string; fields?: Record<string, string>; problems?: string[]; blockers?: string[] } }> {
  const response = await fetch(url, { cache: 'no-store', ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A calendar day (YYYY-MM-DD) as "19 Nov 2026". A day has no time zone, so none is applied. */
function dayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}

function dueLabel(iso: string | null | undefined): string {
  return iso ? dayLabel(iso) : 'No due date';
}

const STAMP: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function amountLine(bill: BillView): string {
  if (bill.confirmed?.amountDisplay) return `${bill.confirmed.amountDisplay} ${bill.confirmed.currency}`;
  const f = bill.extraction.fields;
  if (!f.amount.value) return 'Amount not read';
  let shown = f.amount.value;
  try { shown = formatMicros(toMicros(f.amount.value), f.currency.value || 'USD'); } catch { /* shown as read */ }
  return `${shown}${f.currency.value ? ` ${f.currency.value}` : ''}`;
}

export default function PayInvoices({ onCounts }: { onCounts?: (counts: { toReview: number }) => void }) {
  const [list, setList] = useState<ListResponse | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BillView | null>(null);
  const caseRef = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    const r = await call<ListResponse>('/api/bills');
    if (!r.ok) {
      setListError(r.body.error ?? 'Invoices could not be loaded.');
      return;
    }
    setListError(null);
    setList(r.body);
    onCounts?.({ toReview: r.body.bills.filter((b) => b.status === 'review').length });
  }, [onCounts]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // The latest open wins: an answer that lands after a newer click is dropped.
  const openSeq = useRef(0);
  const open = useCallback(async (id: string, scroll = true) => {
    const mine = ++openSeq.current;
    setSelectedId(id);
    const r = await call<{ bill: BillView }>(`/api/bills/${encodeURIComponent(id)}`);
    if (mine !== openSeq.current) return;
    if (r.ok) setDetail(r.body.bill);
    else toast.error(r.body.error ?? 'That invoice could not be opened.');
    if (scroll && window.matchMedia('(max-width: 1023px)').matches) {
      requestAnimationFrame(() => caseRef.current?.scrollIntoView({ block: 'start' }));
    }
  }, []);

  const replace = useCallback((bill: BillView) => {
    setDetail(bill);
    void load();
  }, [load]);

  const canWrite = list?.canWrite ?? false;

  return (
    <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)] lg:items-start">
      <div className={cn('space-y-4', selectedId && 'hidden lg:block')}>
        {canWrite && <Intake reader={list?.reader ?? 'parser'} onAdded={(bill, note) => { void load(); void open(bill.id); if (note) toast.info(note); }} />}
        <section className="dash-surface overflow-hidden" aria-labelledby="bills-list-title">
          <h2 id="bills-list-title" className="border-b border-[#326273]/10 px-4 py-3 text-sm font-semibold text-[#0c3e48]">Supplier invoices</h2>
          {listError ? (
            <p role="alert" className="p-4 text-sm font-medium text-[var(--error)]">{listError}</p>
          ) : !list ? (
            <div className="space-y-2 p-4" aria-hidden="true">
              {[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-[#326273]/8" />)}
            </div>
          ) : list.bills.length === 0 ? (
            <p className="p-4 text-sm leading-6 text-[#326273]">
              No supplier invoices yet. Paste one above or attach the file, and Zeke reads the supplier, the amount and the due date for you to check.
            </p>
          ) : (
            <div className="divide-y divide-[#326273]/8">
              {GROUPS.map((group) => {
                const bills = list.bills.filter((b) => group.statuses.includes(b.status));
                if (bills.length === 0) return null;
                return (
                  <div key={group.title} className="px-2 py-2">
                    <h3 className="px-2 pb-1 pt-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-[#326273]">{group.title} <span className="dash-num">{bills.length}</span></h3>
                    <ul className="space-y-1">
                      {bills.map((b) => (
                        <li key={b.id}>
                          <button
                            type="button"
                            onClick={() => void open(b.id)}
                            aria-current={selectedId === b.id ? 'true' : undefined}
                            className={cn(
                              'flex min-h-14 w-full items-start justify-between gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                              selectedId === b.id ? 'bg-[#0c3e48] text-white' : 'bg-transparent text-[#1f4452] hover:bg-[#326273]/6',
                            )}
                          >
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-semibold">{b.payee || b.documentName || 'Supplier not read'}</span>
                              <span className={cn('mt-0.5 block text-[12px]', selectedId === b.id ? 'text-white/80' : 'text-[#326273]')}>
                                {b.scheduledFor ? `Pay on ${dueLabel(b.scheduledFor)}` : `Due ${dueLabel(b.confirmed?.dueDate ?? b.extraction.fields.dueDate.value)}`}
                              </span>
                            </span>
                            <span className="dash-num shrink-0 font-mono text-[13px] font-semibold">{amountLine(b)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <section ref={caseRef} aria-label="Invoice" className={cn('min-w-0 scroll-mt-4', !selectedId && 'hidden lg:block')}>
        {selectedId && (
          <button type="button" onClick={() => { setSelectedId(null); setDetail(null); }} className="mb-3 inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-transparent px-1 text-sm font-semibold text-[#145d6a] lg:hidden">
            <ArrowLeft size={16} aria-hidden="true" /> All supplier invoices
          </button>
        )}
        {!selectedId ? (
          <EmptyCase />
        ) : !detail || detail.id !== selectedId ? (
          <div className="dash-surface h-96 animate-pulse" aria-hidden="true" />
        ) : (
          <BillCase bill={detail} canWrite={canWrite} paymentFlowWired={list?.paymentFlowWired ?? false} paymentFlowCancels={list?.paymentFlowCancels ?? false} onChange={replace} onOpen={(id) => void open(id, false)} />
        )}
      </section>
    </div>
  );
}

function EmptyCase() {
  return (
    <div className="dash-surface flex min-h-[420px] flex-col justify-center gap-5 p-8">
      <div>
        <h2 className="text-xl font-bold text-[#0c3e48]">From a supplier’s invoice to a paid one, with proof</h2>
        <p className="mt-2 max-w-[60ch] text-sm leading-6 text-[#326273]">
          Bring in an invoice and choose it from the list. You check what Zeke read, pay a recipient you have already verified, and keep the receipt.
        </p>
      </div>
      <ol className="grid gap-2 text-sm text-[#1f4452] sm:grid-cols-2">
        {(['read', 'duplicates', 'recipient', 'schedule', 'approve', 'receipt'] as BillStep[]).map((step, i) => (
          <li key={step} className="flex items-center gap-3 rounded-xl border border-[#326273]/10 bg-white/70 px-3 py-2.5">
            <span className="dash-num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#0c3e48] text-[12px] font-semibold text-white">{i + 1}</span>
            {BILL_STEP_LABEL[step]}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Intake ─────────────────────────────────────────────────────────────────

function Intake({ reader, onAdded }: { reader: 'zeke' | 'parser'; onAdded: (bill: BillView, note?: string) => void }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; text?: string; pdfBase64?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function choose(f: File) {
    setError(null);
    if (f.size > 5 * 1024 * 1024) { setError('That file is over 5 MB.'); return; }
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
      const data = await new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
        r.readAsDataURL(f);
      });
      setFile({ name: f.name, pdfBase64: data });
    } else {
      setFile({ name: f.name, text: await f.text() });
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file && !text.trim()) { setError('Paste the invoice text or attach the file.'); return; }
    setBusy(true);
    setError(null);
    const r = await call<{ bill: BillView; duplicate?: string; replayed?: boolean }>('/api/bills', {
      method: 'POST',
      body: JSON.stringify({
        intakeKey: crypto.randomUUID(),
        documentName: file?.name ?? 'Pasted invoice',
        ...(file?.pdfBase64 ? { pdfBase64: file.pdfBase64 } : { text: file?.text ?? text }),
      }),
    });
    setBusy(false);
    if (!r.ok) { setError(r.body.error ?? 'The invoice could not be added.'); return; }
    setText('');
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
    onAdded(r.body.bill, r.body.duplicate === 'same_document' ? 'That invoice is already in your list. It is opened for you.' : undefined);
  }

  return (
    <form onSubmit={submit} className="dash-block p-4" aria-labelledby="intake-title">
      <h2 id="intake-title" className="flex items-center gap-2 text-sm font-semibold text-[#0c3e48]">
        <Sparkles size={15} className="text-[#145d6a]" aria-hidden="true" /> Bring in an invoice
      </h2>
      <label htmlFor="intake-text" className="mt-3 block text-[13px] font-medium text-[#326273]">Paste the invoice text</label>
      <textarea
        id="intake-text"
        value={text}
        onChange={(e) => { setText(e.target.value); setError(null); }}
        disabled={Boolean(file)}
        rows={4}
        placeholder={'Invoice No: 0412\nTotal due: USD 1,250.00\nDue date: 2026-11-19'}
        className="mt-1 w-full resize-y rounded-xl border border-[#326273]/20 bg-white px-3 py-2.5 font-mono text-[13px] text-[#1f4452] placeholder:text-[#326273] focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30 disabled:opacity-60"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input ref={fileInput} id="intake-file" type="file" accept={TEXT_TYPES} className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); }} />
        <label htmlFor="intake-file" className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-lg border border-[#326273]/20 bg-white px-3 text-[13px] font-semibold text-[#1f4452] hover:border-[#145d6a]/50 focus-within:ring-2 focus-within:ring-[#5c9ead]/40">
          <Paperclip size={14} aria-hidden="true" /> {file ? 'Change file' : 'Attach a file'}
        </label>
        {file && (
          <span className="inline-flex min-w-0 items-center gap-1 text-[13px] text-[#1f4452]">
            <FileText size={14} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{file.name}</span>
            <button type="button" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ''; }} aria-label="Remove the file" className="inline-flex h-11 w-11 items-center justify-center rounded-lg bg-transparent text-[#326273] hover:text-[#0c3e48]">
              <XCircle size={15} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>
      <p className="mt-2 text-[12px] leading-5 text-[#326273]">
        {reader === 'zeke'
          ? 'Zeke reads text and PDF invoices. The invoice is treated as data: nothing in it can change who is paid.'
          : 'Text invoices are read on this server. For a PDF, paste its text.'}
      </p>
      {error && <p role="alert" className="mt-2 text-[13px] font-medium text-[var(--error)]">{error}</p>}
      <button type="submit" disabled={busy} className="dash-btn mt-3 w-full min-h-11 disabled:opacity-50">
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Read the invoice
      </button>
    </form>
  );
}

// ─── One invoice ────────────────────────────────────────────────────────────

function StepRail({ steps }: { steps: BillView['steps'] }) {
  const current = steps.findIndex((s) => s.state === 'current' || s.state === 'blocked');
  const STATE_TEXT: Record<StepState, string> = { done: 'done', current: 'now', blocked: 'blocked', todo: 'to do' };
  return (
    <div>
      <p className="text-[13px] font-medium text-[#326273] sm:hidden">
        {current >= 0 ? `Step ${current + 1} of ${steps.length}: ${BILL_STEP_LABEL[steps[current].step]}` : 'Every step is done'}
      </p>
      <ol className="mt-2 hidden gap-1 sm:grid sm:grid-cols-7" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s.step} className="min-w-0">
            <div className={cn(
              'h-1.5 rounded-full',
              s.state === 'done' ? 'bg-[#237284]' : s.state === 'current' ? 'bg-[#5c9ead]' : s.state === 'blocked' ? 'bg-[var(--error)]' : 'bg-[#326273]/15',
            )} />
            <span className={cn('mt-1.5 block truncate text-[12px]', s.state === 'current' || s.state === 'blocked' ? 'font-semibold text-[#0c3e48]' : 'text-[#326273]')}>
              <span className="sr-only">Step {i + 1}, {STATE_TEXT[s.state]}: </span>{BILL_STEP_LABEL[s.step]}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#326273]/15 sm:hidden" aria-hidden="true">
        <div className="h-full rounded-full bg-[#237284]" style={{ width: `${(steps.filter((s) => s.state === 'done').length / steps.length) * 100}%` }} />
      </div>
    </div>
  );
}

function BillCase({ bill, canWrite, paymentFlowWired, paymentFlowCancels, onChange, onOpen }: {
  bill: BillView; canWrite: boolean; paymentFlowWired: boolean; paymentFlowCancels: boolean; onChange: (b: BillView) => void; onOpen: (id: string) => void;
}) {
  const [focusField, setFocusField] = useState<BillField | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(body: Record<string, unknown>, label: string): Promise<{ ok: boolean; fields?: Record<string, string> }> {
    setBusy(label);
    const r = await call<{ bill: BillView }>(`/api/bills/${encodeURIComponent(bill.id)}`, { method: 'PATCH', body: JSON.stringify(body) });
    setBusy(null);
    if (!r.ok) {
      toast.error(r.body.error ?? 'That change was not made.');
      // Someone changed it: show the invoice as it is now, not as it was.
      if (r.body.code === 'changed' && r.body.bill) onChange(r.body.bill);
      return { ok: false, fields: r.body.fields };
    }
    onChange(r.body.bill);
    return { ok: true };
  }

  const closed = bill.status === 'paid' || bill.status === 'cancelled';
  const head = bill.confirmed ?? null;

  return (
    <div className="space-y-4">
      <header className="dash-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-[#326273]">{bill.statusLabel}{bill.documentName ? ` · ${bill.documentName}` : ''}</p>
            <h2 className="mt-1 truncate text-2xl font-bold tracking-tight text-[#0c3e48]">{head?.payee ?? (bill.payee || 'Supplier not read')}</h2>
          </div>
          <div className="sm:text-right">
            <p className="dash-num font-mono text-2xl font-semibold text-[#0c3e48]">{amountLine(bill)}</p>
            <p className="text-[13px] text-[#326273]">Due {dueLabel(head?.dueDate ?? bill.extraction.fields.dueDate.value)}</p>
          </div>
        </div>
        <div className="mt-4"><StepRail steps={bill.steps} /></div>
      </header>

      <ReadingStep bill={bill} canWrite={canWrite && bill.status === 'review'} focusField={focusField} onFocusField={setFocusField} onConfirm={(fields) => act({ action: 'confirm', fields }, 'confirm')} busy={busy === 'confirm'} />

      {bill.confirmed && <DuplicateStep bill={bill} canWrite={canWrite && bill.status === 'review'} onOpen={onOpen} onAcknowledge={(reason) => act({ action: 'acknowledge_duplicate', reason }, 'ack')} busy={busy === 'ack'} />}

      {bill.confirmed && <RecipientStep bill={bill} canWrite={canWrite && bill.status === 'review'} onMatch={(recipientId, reason) => act({ action: 'match', recipientId, ...(reason ? { reason } : {}) }, 'match')} busy={busy} />}

      {bill.confirmed && <ScheduleStep bill={bill} canWrite={canWrite} paymentFlowWired={paymentFlowWired} paymentFlowCancels={paymentFlowCancels} act={act} busy={busy} onChange={onChange} />}

      {bill.status === 'paid' && <ReceiptStep bill={bill} canWrite={canWrite} onChange={onChange} />}

      {!closed && bill.status !== 'approving' && canWrite && (
        <div className="flex justify-start">
          <button type="button" disabled={busy !== null} onClick={() => { if (window.confirm('Cancel this invoice? It stays in the list as cancelled.')) void act({ action: 'cancel' }, 'cancel'); }} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-[var(--error)]/25 bg-white px-3 text-[13px] font-semibold text-[var(--error)] disabled:opacity-50">
            <XCircle size={14} aria-hidden="true" /> Cancel invoice
          </button>
        </div>
      )}
    </div>
  );
}

function StepCard({ title, icon: Icon, state, children, id }: { title: string; icon: typeof FileText; state: 'done' | 'open' | 'warn'; children: ReactNode; id: string }) {
  return (
    <section className="dash-surface p-5" aria-labelledby={id}>
      <h3 id={id} className="flex items-center gap-2 text-base font-semibold text-[#0c3e48]">
        <Icon size={16} className={state === 'done' ? 'text-[var(--ok)]' : state === 'warn' ? 'text-[var(--warn)]' : 'text-[#145d6a]'} aria-hidden="true" />
        {title}
        {state === 'done' && <span className="ml-1 rounded-full bg-[var(--ok-bg)] px-2 py-0.5 text-[12px] font-semibold text-[#1f4452]">Done</span>}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** The document with each value marked where it was read. */
function DocumentSheet({ text, extraction, focusField }: { text: string; extraction: BillView['extraction']; focusField: BillField | null }) {
  const pieces = useMemo(() => {
    const spans = BILL_FIELDS
      .map((f) => ({ f, span: extraction.fields[f].span }))
      .filter((x): x is { f: BillField; span: [number, number] } => Array.isArray(x.span))
      .sort((a, b) => a.span[0] - b.span[0]);
    const out: Array<{ text: string; field: BillField | null }> = [];
    let at = 0;
    for (const { f, span } of spans) {
      if (span[0] < at || span[1] > text.length) continue;
      if (span[0] > at) out.push({ text: text.slice(at, span[0]), field: null });
      out.push({ text: text.slice(span[0], span[1]), field: f });
      at = span[1];
    }
    if (at < text.length) out.push({ text: text.slice(at), field: null });
    return out;
  }, [text, extraction]);
  return (
    <div className="max-h-[440px] overflow-auto rounded-xl border border-[#326273]/12 bg-[var(--zeke-paper)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,.8)]">
      <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-6 text-[#1f4452]">
        {pieces.map((p, i) => p.field ? (
          <mark key={i} title={FIELD_LABEL[p.field]} className={cn('rounded px-0.5 text-[#0c3e48]', FIELD_TINT[p.field], focusField === p.field && 'outline outline-2 outline-[#0c3e48]')}>{p.text}</mark>
        ) : <span key={i}>{p.text}</span>)}
      </pre>
    </div>
  );
}

function ReadingStep({ bill, canWrite, focusField, onFocusField, onConfirm, busy }: {
  bill: BillView; canWrite: boolean; focusField: BillField | null; onFocusField: (f: BillField | null) => void;
  onConfirm: (fields: Record<string, string>) => Promise<{ ok: boolean; fields?: Record<string, string> }>; busy: boolean;
}) {
  const f = bill.extraction.fields;
  const initial = useMemo(() => ({
    payee: bill.confirmed?.payee ?? f.payee.value,
    invoiceNumber: bill.confirmed?.invoiceNumber ?? f.invoiceNumber.value,
    amount: bill.confirmed?.amount ?? f.amount.value,
    currency: bill.confirmed?.currency ?? f.currency.value,
    dueDate: bill.confirmed?.dueDate ?? f.dueDate.value,
    invoiceDate: bill.confirmed?.invoiceDate ?? f.invoiceDate.value,
    payeeCountry: bill.confirmed?.payeeCountry ?? f.payeeCountry.value,
  }), [bill.confirmed, f]);
  const [values, setValues] = useState<Record<BillField, string>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    const t = setTimeout(() => { setValues(initial); setErrors({}); }, 0);
    return () => clearTimeout(t);
  }, [bill.id, initial]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await onConfirm(values);
    setErrors(r.ok ? {} : r.fields ?? {});
  }

  if (bill.status !== 'review' && bill.confirmed) {
    const c = bill.confirmed;
    const rows: Array<[string, string]> = [
      ['Supplier', c.payee ?? ''], ['Invoice number', c.invoiceNumber ?? ''], ['Amount due', `${c.amountDisplay ?? ''} ${c.currency ?? ''}`],
      ['Due date', dueLabel(c.dueDate)], ['Invoice date', c.invoiceDate ? dueLabel(c.invoiceDate) : 'Not given'], ['Supplier country', COUNTRY_NAME[c.payeeCountry ?? ''] ?? c.payeeCountry ?? ''],
    ];
    return (
      <StepCard id={`read-${bill.id}`} title="What was confirmed" icon={Sparkles} state="done">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {rows.map(([k, v]) => <div key={k}><dt className="text-[12px] text-[#326273]">{k}</dt><dd className="font-medium text-[#1f4452]">{v}</dd></div>)}
        </dl>
        {bill.needsRateQuote && <RateQuoteNote currency={c.currency} />}
        {bill.documentText && (
          <details className="mt-3">
            <summary className="min-h-11 cursor-pointer py-2 text-[13px] font-semibold text-[#145d6a]">Show the invoice as it was read</summary>
            <DocumentSheet text={bill.documentText} extraction={bill.extraction} focusField={null} />
          </details>
        )}
      </StepCard>
    );
  }

  const source = bill.extraction.source === 'parser' ? 'Read by the invoice parser' : bill.extraction.source === 'model_pdf' ? 'Read by Zeke from the PDF' : 'Read by Zeke, checked against the document';

  return (
    <StepCard id={`read-${bill.id}`} title="Check what Zeke read" icon={Sparkles} state={bill.confirmed ? 'done' : 'open'}>
      <p className="text-[13px] text-[#326273]">{source}. Every value is yours to check; nothing is paid as read.</p>
      {bill.confirmed && bill.needsRateQuote && <RateQuoteNote currency={bill.confirmed.currency} />}
      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {bill.documentText ? (
          <DocumentSheet text={bill.documentText} extraction={bill.extraction} focusField={focusField} />
        ) : (
          <div className="flex items-center gap-2 rounded-xl border border-[#326273]/12 bg-[var(--zeke-paper)] p-4 text-[13px] text-[#326273]">
            <FileText size={16} aria-hidden="true" /> The PDF itself is not kept. Compare the fields with your copy.
          </div>
        )}
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" noValidate>
          {BILL_FIELDS.map((field) => {
            const read = f[field];
            const id = `${bill.id}-${field}`;
            const err = errors[field];
            return (
              <div key={field} onFocus={() => onFocusField(field)} onBlur={() => onFocusField(null)} className={cn('rounded-xl border px-3 py-2.5', (field === 'payee' || field === 'invoiceNumber') && 'sm:col-span-2', focusField === field ? 'border-[#145d6a]/50 bg-white' : 'border-[#326273]/10 bg-white/70')}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor={id} className="flex items-center gap-2 text-[13px] font-semibold text-[#1f4452]">
                    <span className={cn('inline-block h-3 w-3 rounded-sm', FIELD_TINT[field])} aria-hidden="true" />
                    {FIELD_LABEL[field]}{field !== 'invoiceDate' && <span className="text-[var(--error)]" aria-hidden="true">*</span>}
                  </label>
                  <span className={cn('rounded-full border px-2 py-0.5 text-[12px] font-semibold', CONFIDENCE_STYLE[read.confidence])}>
                    <span className="sr-only">Confidence: </span>{CONFIDENCE_LABEL[read.confidence]}
                  </span>
                </div>
                <FieldInput id={id} field={field} value={values[field]} disabled={!canWrite} invalid={Boolean(err)} describedBy={`${id}-why`} onChange={(v) => setValues((cur) => ({ ...cur, [field]: v }))} />
                <p id={`${id}-why`} className={cn('mt-1 text-[12px]', err ? 'font-semibold text-[var(--error)]' : 'text-[#326273]')}>{err ?? read.reason}</p>
              </div>
            );
          })}
          {canWrite && (
            <button type="submit" disabled={busy} className="dash-btn min-h-11 w-full disabled:opacity-50 sm:col-span-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
              {bill.confirmed ? 'Save the changes' : 'Confirm these details'}
            </button>
          )}
          {bill.confirmed && <p className="text-[12px] text-[#326273] sm:col-span-2">Confirmed <LocalTime value={bill.confirmed.at} locale="en-GB" options={STAMP} />.</p>}
        </form>
      </div>
    </StepCard>
  );
}

/**
 * Said as soon as the currency is confirmed, not at the approve step: USDC
 * pays USD one for one, and any other currency needs a rate quote, which
 * Transfer takes and shows. Transfer starts from the recipient there; it
 * does not take a supplier invoice from this list.
 */
function RateQuoteNote({ currency }: { currency: string | null }) {
  return (
    <p role="status" className="mt-3 rounded-xl border border-[var(--warn)]/35 bg-[var(--warn-bg)] p-3 text-[13px] leading-5 text-[var(--warn-ink)]">
      This invoice is in {currency}. It is paid in USDC, so it needs a rate quote, and Invoices does not quote rates.{' '}
      <Link href="/dashboard/transfer" className="font-semibold underline decoration-1 underline-offset-2">Pay it from Transfer</Link>, where the rate is quoted and shown before anyone signs.
    </p>
  );
}

function FieldInput({ id, field, value, disabled, invalid, describedBy, onChange }: {
  id: string; field: BillField; value: string; disabled: boolean; invalid: boolean; describedBy: string; onChange: (v: string) => void;
}) {
  const cls = 'mt-1.5 h-11 w-full rounded-lg border border-[#326273]/20 bg-white px-3 text-sm text-[#1f4452] focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30 disabled:bg-[#326273]/5 aria-[invalid=true]:border-[var(--error)]';
  const common = { id, disabled, 'aria-invalid': invalid, 'aria-describedby': describedBy, className: cls };
  if (field === 'currency') {
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose</option>
        {BILL_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    );
  }
  if (field === 'payeeCountry') {
    return (
      <select {...common} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose</option>
        {COUNTRY_CODES.map((c) => <option key={c} value={c}>{COUNTRY_NAME[c] ?? c}</option>)}
      </select>
    );
  }
  if (field === 'dueDate' || field === 'invoiceDate') {
    return <input {...common} type="date" value={value} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <input
      {...common}
      type="text"
      inputMode={field === 'amount' ? 'decimal' : undefined}
      autoComplete="off"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={cn(cls, field === 'amount' && 'font-mono dash-num')}
    />
  );
}

function DuplicateStep({ bill, canWrite, onOpen, onAcknowledge, busy }: {
  bill: BillView; canWrite: boolean; onOpen: (id: string) => void; onAcknowledge: (reason: string) => Promise<{ ok: boolean }>; busy: boolean;
}) {
  const [reason, setReason] = useState('');
  const number = bill.duplicates.filter((d) => d.kind === 'same_number');
  const amount = bill.duplicates.filter((d) => d.kind === 'same_amount');
  const blocked = bill.facts.sameNumber;
  const needsAck = bill.facts.sameAmount && !bill.facts.duplicateAcknowledged;
  return (
    <StepCard id={`dup-${bill.id}`} title="Duplicate check" icon={blocked || needsAck ? AlertTriangle : ShieldCheck} state={blocked || needsAck ? 'warn' : 'done'}>
      {bill.status !== 'review' || bill.duplicates.length === 0 ? (
        <p className="text-sm text-[#1f4452]">Checked against every invoice in your list that is not cancelled: none has this invoice number from this supplier or to the recipient it pays, and none has the same amount from either in the last 45 days.</p>
      ) : (
        <div className="space-y-3 text-sm text-[#1f4452]">
          {number.length > 0 && (
            <div role="alert" className="rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3">
              <p className="font-semibold text-[var(--error)]">{number.some((d) => d.by === 'recipient') ? 'The same invoice number is already in your list, paid to the same recipient under another supplier name.' : 'The same invoice number from this supplier is already in your list.'}</p>
              <p className="mt-1">It cannot be paid twice. Cancel one of them.</p>
              <ul className="mt-2 space-y-1">{number.map((d) => <li key={d.billId}><button type="button" onClick={() => onOpen(d.billId)} className="min-h-11 bg-transparent font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">Open the other invoice ({d.status})</button></li>)}</ul>
            </div>
          )}
          {amount.length > 0 && (
            <div className="rounded-xl border border-[var(--warn)]/35 bg-[var(--warn-bg)] p-3">
              <p className="font-semibold text-[var(--warn-ink)]">{amount.some((d) => d.by === 'recipient') ? 'The same amount to the same recipient in the last 45 days, under another number.' : 'The same amount from this supplier in the last 45 days, under another number.'}</p>
              <ul className="mt-1 space-y-1">{amount.map((d) => <li key={d.billId}><button type="button" onClick={() => onOpen(d.billId)} className="min-h-11 bg-transparent font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">Open that invoice ({d.status})</button></li>)}</ul>
              {bill.duplicateAck ? (
                <p className="mt-2">Not a duplicate: “{bill.duplicateAck.reason}”</p>
              ) : canWrite ? (
                <form onSubmit={async (e) => { e.preventDefault(); if ((await onAcknowledge(reason)).ok) setReason(''); }} className="mt-2">
                  <label htmlFor={`ack-${bill.id}`} className="block text-[13px] font-semibold text-[#1f4452]">Why is it not a duplicate?</label>
                  <input id={`ack-${bill.id}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={8} maxLength={300} placeholder="For example: a second shipment, PO 7781" className="mt-1 h-11 w-full rounded-lg border border-[#326273]/20 bg-white px-3 text-sm focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30" />
                  <button type="submit" disabled={busy || reason.trim().length < 8} className="dash-btn dash-btn-ghost mt-2 min-h-11 !text-[13px] disabled:opacity-50">It is not a duplicate</button>
                </form>
              ) : null}
            </div>
          )}
        </div>
      )}
    </StepCard>
  );
}

function RecipientStep({ bill, canWrite, onMatch, busy }: { bill: BillView; canWrite: boolean; onMatch: (id: string, reason?: string) => Promise<{ ok: boolean }>; busy: string | null }) {
  const [changing, setChanging] = useState(false);
  const [otherId, setOtherId] = useState('');
  const [otherReason, setOtherReason] = useState('');
  // A suggested recipient whose name is only close, not the same: chosen with a written reason.
  const [closeId, setCloseId] = useState<string | null>(null);
  const [closeReason, setCloseReason] = useState('');
  const showChoices = canWrite && (!bill.recipient || changing);
  const supplier = bill.confirmed?.payee ?? bill.payee;
  return (
    <StepCard id={`recipient-${bill.id}`} title="Who is paid" icon={UserRoundCheck} state={bill.facts.recipientMatched && bill.facts.recipientVerified ? 'done' : 'open'}>
      {bill.recipient && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#326273]/12 bg-white/80 p-3">
          <div className="min-w-0">
            <p className="font-semibold text-[#0c3e48]">{bill.recipient.name}</p>
            <p className="text-[13px] text-[#326273]">{bill.recipient.destination} · {COUNTRY_NAME[bill.recipient.country] ?? bill.recipient.country}</p>
          </div>
          <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-semibold', bill.recipient.verified ? 'bg-[var(--ok-bg)] text-[#1f4452]' : 'bg-[var(--warn-bg)] text-[var(--warn-ink)]')}>
            {bill.recipient.verified ? <><ShieldCheck size={12} aria-hidden="true" /> Verified</> : bill.recipient.blocked === 'ownership_unproven' ? 'Ownership not proved' : 'Not verified'}
          </span>
          {canWrite && bill.status === 'review' && !changing && (
            <button type="button" onClick={() => setChanging(true)} className="min-h-11 bg-transparent px-1 text-[13px] font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">Change</button>
          )}
        </div>
      )}
      {bill.recipient && bill.recipientNameDiffers && (
        <p className="mt-2 text-[13px] text-[#1f4452]">
          {bill.matchReason
            ? <>Paid for {supplier} because: “{bill.matchReason}”</>
            : <>The recipient’s name is close to {supplier}, not the same. Check it is the same business.</>}
        </p>
      )}
      {bill.recipientMissing && <p role="alert" className="mt-2 text-[13px] font-medium text-[var(--error)]">The recipient this invoice was matched to is no longer in your list. Choose another.</p>}
      {bill.extraction.paymentDetailsRead === 'not_read' && (
        <p className="mt-3 rounded-xl border border-[var(--info)]/25 bg-[var(--info-bg)] p-3 text-[13px] leading-5 text-[var(--info)]">
          The bank account or wallet printed on this PDF was not read, so it was not compared with the recipient’s. Check it against your copy before you schedule.
        </p>
      )}
      {bill.paymentDetailsDiffer && (
        <div role="alert" className="mt-3 flex gap-2 rounded-xl border border-[var(--warn)]/35 bg-[var(--warn-bg)] p-3 text-[13px] text-[var(--warn-ink)]">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <p><strong className="font-semibold">The invoice prints payment details that are not this recipient’s.</strong> The payment goes to the recipient on file, not to what the invoice says. If the supplier says its account changed, confirm it with them by phone and update the recipient in Recipients first.</p>
        </div>
      )}
      {showChoices && (
        <div className="mt-3">
          {bill.matches.length > 0 ? (
            <ul className="space-y-2">
              {bill.matches.map((m) => (
                <li key={m.id} className="rounded-xl border border-[#326273]/10 bg-white/70 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-[#1f4452]">{m.name}<span className="ml-2 text-[12px] font-medium text-[#326273]">{m.exact ? 'Same name' : 'Similar name'}</span></p>
                      <p className="text-[13px] text-[#326273]">{m.destination} · {COUNTRY_NAME[m.country] ?? m.country}</p>
                    </div>
                    {!m.verified ? (
                      <span className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--warn-ink)]"><Lock size={13} aria-hidden="true" /> {m.blocked === 'ownership_unproven' ? 'Ownership not proved yet' : 'Not verified yet'}</span>
                    ) : m.exact ? (
                      <button type="button" disabled={busy !== null} onClick={async () => { if ((await onMatch(m.id)).ok) setChanging(false); }} className="dash-btn dash-btn-ghost min-h-11 !py-2 !text-[13px] disabled:opacity-50">Pay this recipient</button>
                    ) : closeId !== m.id ? (
                      <button type="button" disabled={busy !== null} onClick={() => { setCloseId(m.id); setCloseReason(''); }} className="dash-btn dash-btn-ghost min-h-11 !py-2 !text-[13px] disabled:opacity-50">Pay this recipient</button>
                    ) : null}
                  </div>
                  {m.verified && m.blocked === null && !m.exact && closeId === m.id && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (closeReason.trim().length < 8) return;
                        if ((await onMatch(m.id, closeReason.trim())).ok) { setChanging(false); setCloseId(null); setCloseReason(''); }
                      }}
                      className="mt-3 space-y-2 border-t border-[#326273]/10 pt-3"
                    >
                      <label htmlFor={`close-why-${m.id}`} className="block text-[13px] font-semibold text-[#1f4452]">{m.name} and {supplier} are not the same name. Why is this recipient paid for the invoice?</label>
                      <input id={`close-why-${m.id}`} value={closeReason} onChange={(e) => setCloseReason(e.target.value)} minLength={8} maxLength={300} aria-describedby={`close-why-help-${m.id}`} className="h-11 w-full rounded-lg border border-[#326273]/20 bg-white px-3 text-sm focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30" />
                      <p id={`close-why-help-${m.id}`} className="text-[12px] text-[#326273]">At least 8 characters, for example: the same company under its registered name.</p>
                      <div className="flex flex-wrap gap-2">
                        <button type="submit" disabled={busy !== null || closeReason.trim().length < 8} className="dash-btn dash-btn-ghost min-h-11 !text-[13px] disabled:opacity-50">Pay this recipient</button>
                        <button type="button" onClick={() => setCloseId(null)} className="min-h-11 bg-transparent px-2 text-[13px] font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">Not this one</button>
                      </div>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[#1f4452]">No recipient in your list matches “{supplier}”.</p>
          )}
          {bill.otherRecipients.length > 0 && (
            <details className="mt-3 rounded-xl border border-[#326273]/10 bg-white/70 px-3">
              <summary className="min-h-11 cursor-pointer py-3 text-[13px] font-semibold text-[#145d6a]">Paid under another name</summary>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!otherId || otherReason.trim().length < 8) return;
                  if ((await onMatch(otherId, otherReason.trim())).ok) { setChanging(false); setOtherId(''); setOtherReason(''); }
                }}
                className="space-y-3 pb-3"
              >
                <p className="text-[13px] text-[#326273]">For a supplier paid through a trading name or an agent. Say why, and it is kept with the invoice.</p>
                <div>
                  <label htmlFor={`other-${bill.id}`} className="block text-[13px] font-semibold text-[#1f4452]">Recipient</label>
                  <select id={`other-${bill.id}`} value={otherId} onChange={(e) => setOtherId(e.target.value)} className="mt-1 h-11 w-full rounded-lg border border-[#326273]/20 bg-white px-3 text-sm text-[#1f4452] focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30">
                    <option value="">Choose a verified recipient</option>
                    {bill.otherRecipients.map((r) => <option key={r.id} value={r.id}>{r.name}, {r.destination}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor={`other-why-${bill.id}`} className="block text-[13px] font-semibold text-[#1f4452]">Why this recipient is paid for {supplier}</label>
                  <input id={`other-why-${bill.id}`} value={otherReason} onChange={(e) => setOtherReason(e.target.value)} minLength={8} maxLength={300} aria-describedby={`other-why-help-${bill.id}`} className="mt-1 h-11 w-full rounded-lg border border-[#326273]/20 bg-white px-3 text-sm focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30" />
                  <p id={`other-why-help-${bill.id}`} className="mt-1 text-[12px] text-[#326273]">At least 8 characters, for example: its Philippine trading name.</p>
                </div>
                <button type="submit" disabled={busy !== null || !otherId || otherReason.trim().length < 8} className="dash-btn dash-btn-ghost min-h-11 !text-[13px] disabled:opacity-50">Pay this recipient</button>
              </form>
            </details>
          )}
          <p className="mt-3 text-[13px] text-[#326273]">
            Not listed? <Link href="/dashboard/recipients" className="font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">Add the supplier in Recipients</Link>, then come back. A new recipient is screened before it can be paid.
          </p>
        </div>
      )}
    </StepCard>
  );
}

function ScheduleStep({ bill, canWrite, paymentFlowWired, paymentFlowCancels, act, busy, onChange }: {
  bill: BillView; canWrite: boolean; paymentFlowWired: boolean; paymentFlowCancels: boolean;
  act: (body: Record<string, unknown>, label: string) => Promise<{ ok: boolean; fields?: Record<string, string> }>;
  busy: string | null; onChange: (b: BillView) => void;
}) {
  const due = bill.confirmed?.dueDate ?? '';
  const today = todayIso();
  const [payOn, setPayOn] = useState(due && due >= today ? due : today);
  const [notWired, setNotWired] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function approve() {
    setSending(true);
    // The version of the invoice on screen: a changed one is refused, not paid.
    const r = await call<{ bill: BillView }>(`/api/bills/${encodeURIComponent(bill.id)}/approve`, { method: 'POST', body: JSON.stringify({ revision: bill.revision }) });
    setSending(false);
    if (r.body.code === 'PAYMENT_FLOW_NOT_WIRED') { setNotWired(r.body.error ?? null); return; }
    if (!r.ok) {
      toast.error(r.body.error ?? 'It was not sent for approval.');
      if (r.body.code === 'changed' && r.body.bill) onChange(r.body.bill);
      return;
    }
    onChange(r.body.bill);
    toast.success('Sent for approval');
  }

  if (bill.status === 'review') {
    return (
      <StepCard id={`schedule-${bill.id}`} title="Schedule the payment" icon={CalendarClock} state="open">
        {bill.blockers.length > 0 ? (
          <ul className="space-y-1 text-sm text-[#1f4452]">
            {bill.blockers.map((b) => <li key={b} className="flex gap-2"><span aria-hidden="true" className="text-[#326273]">·</span>{b}</li>)}
          </ul>
        ) : canWrite ? (
          <form onSubmit={(e) => { e.preventDefault(); void act({ action: 'schedule', payOn, revision: bill.revision }, 'schedule'); }} className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor={`payon-${bill.id}`} className="block text-[13px] font-semibold text-[#1f4452]">Pay on</label>
              <input id={`payon-${bill.id}`} type="date" min={today} value={payOn} onChange={(e) => setPayOn(e.target.value)} className="mt-1 h-11 rounded-lg border border-[#326273]/20 bg-white px-3 text-sm focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30" />
            </div>
            <button type="submit" disabled={busy !== null} className="dash-btn min-h-11 disabled:opacity-50">Schedule payment</button>
            {due && payOn > due && <p className="w-full text-[13px] text-[var(--warn-ink)]">That is after the due date ({dueLabel(due)}).</p>}
          </form>
        ) : (
          <p className="text-sm text-[#326273]">Ready to schedule.</p>
        )}
      </StepCard>
    );
  }

  if (bill.status === 'scheduled') {
    return (
      <StepCard id={`approve-${bill.id}`} title={BILL_STEP_LABEL.approve} icon={ShieldCheck} state="open">
        <p className="text-sm text-[#1f4452]">Scheduled to pay on <strong className="font-semibold">{dueLabel(bill.scheduledFor)}</strong>. The owners approve it in Transfer, with the fee and the rate shown before anyone signs.</p>
        {bill.needsRateQuote && <RateQuoteNote currency={bill.confirmed?.currency ?? null} />}
        {(!paymentFlowWired || notWired) && (
          <p role="status" className="mt-3 rounded-xl border border-[var(--info)]/25 bg-[var(--info-bg)] p-3 text-[13px] leading-5 text-[var(--info)]">
            {notWired ?? 'Approving from Invoices is not connected to Transfer on this server yet. The invoice stays scheduled; nothing is sent for approval.'}
          </p>
        )}
        {canWrite && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" onClick={() => void approve()} disabled={sending || !paymentFlowWired || Boolean(notWired) || bill.needsRateQuote} className="dash-btn min-h-11 disabled:opacity-50">
              {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Send for approval
            </button>
            <button type="button" onClick={() => void act({ action: 'unschedule' }, 'unschedule')} disabled={busy !== null} className="dash-btn dash-btn-ghost min-h-11 !text-[13px] disabled:opacity-50">Change it</button>
          </div>
        )}
      </StepCard>
    );
  }

  if (bill.status === 'approving') {
    return (
      <StepCard id={`approve-${bill.id}`} title={BILL_STEP_LABEL.approve} icon={ShieldCheck} state="open">
        <p className="text-sm text-[#1f4452]">Waiting for the owners’ approval in Transfer. It is marked paid when the payment settles on Sui.</p>
        {bill.approval && <p className="mt-1 break-all font-mono text-[12px] text-[#326273]">Payment {bill.approval.paymentIntentId}</p>}
        {canWrite && paymentFlowCancels && (
          <div className="mt-3">
            <button type="button" disabled={busy !== null} onClick={() => { if (window.confirm('Withdraw this invoice from approval? The payment waiting in Transfer is dropped, and the invoice goes back to scheduled.')) void act({ action: 'withdraw' }, 'withdraw'); }} className="dash-btn dash-btn-ghost min-h-11 !text-[13px] disabled:opacity-50">
              Withdraw from approval
            </button>
          </div>
        )}
      </StepCard>
    );
  }
  return null;
}

// ─── Receipt and the self-billed e-invoice ──────────────────────────────────

function ReceiptStep({ bill, canWrite, onChange }: { bill: BillView; canWrite: boolean; onChange: (b: BillView) => void }) {
  const paid = bill.paid!;
  const rows: Array<[string, ReactNode]> = [
    ['Receipt no.', <span key="r" className="font-mono">{paid.receiptNo}</span>],
    ['Paid on', <LocalTime key="p" value={paid.at} locale="en-GB" options={STAMP} />],
    ['Amount', <span key="a" className="dash-num font-mono">{amountLine(bill)}</span>],
    ['Supplier', bill.confirmed?.payee ?? bill.payee],
    ['Supplier invoice', bill.confirmed?.invoiceNumber ?? ''],
    ['Paid to', bill.recipient?.destination ?? 'Recipient on file'],
    ['Approved by', paid.approvers.length > 0 ? paid.approvers.join(', ') : 'Recorded with the payment'],
  ];
  return (
    <>
      <StepCard id={`receipt-${bill.id}`} title={BILL_STEP_LABEL.receipt} icon={ReceiptText} state="done">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-[#326273]/8 py-1.5 sm:block sm:border-0">
              <dt className="text-[13px] text-[#326273]">{k}</dt>
              <dd className="text-right font-medium text-[#1f4452] sm:text-left">{v}</dd>
            </div>
          ))}
        </dl>
        {paid.verifyUrl && (
          <a href={paid.verifyUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-[13px] font-semibold text-[#145d6a] underline decoration-1 underline-offset-2">
            Verify the payment on Sui <ExternalLink size={13} aria-hidden="true" />
          </a>
        )}
        <button type="button" onClick={() => window.print()} className="ml-4 inline-flex min-h-11 items-center gap-1.5 bg-transparent text-[13px] font-semibold text-[#145d6a]">
          <FileDown size={13} aria-hidden="true" /> Save as PDF
        </button>
      </StepCard>
      <EInvoiceCard bill={bill} canWrite={canWrite} onChange={onChange} />
    </>
  );
}

function EInvoiceCard({ bill, canWrite, onChange }: { bill: BillView; canWrite: boolean; onChange: (b: BillView) => void }) {
  const foreign = bill.facts.foreignSupplier;
  const currency = bill.confirmed?.currency ?? '';
  const needsRate = currency !== 'MYR';
  const [form, setForm] = useState({ buyerTin: '', phone: '', stateCode: '', classification: '034', description: '', exchangeRateToMyr: '' });
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function make(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const r = await call<{ eInvoice: unknown }>(`/api/bills/${encodeURIComponent(bill.id)}/e-invoice`, {
      method: 'POST',
      body: JSON.stringify({ ...form, exchangeRateToMyr: needsRate ? form.exchangeRateToMyr : undefined }),
    });
    setBusy(false);
    if (!r.ok) { setProblems(r.body.problems ?? [r.body.error ?? 'The e-invoice was not made.']); return; }
    setProblems([]);
    const fresh = await call<{ bill: BillView }>(`/api/bills/${encodeURIComponent(bill.id)}`);
    if (fresh.ok) onChange(fresh.body.bill);
    toast.success('Self-billed e-invoice made');
  }

  const input = 'mt-1 h-11 w-full rounded-lg border border-[#326273]/20 bg-white px-3 text-sm focus:border-[#145d6a] focus:outline-none focus:ring-2 focus:ring-[#5c9ead]/30';

  return (
    <StepCard id={`einvoice-${bill.id}`} title="Self-billed e-invoice (MyInvois)" icon={FileText} state={bill.eInvoice ? 'done' : 'open'}>
      {!foreign ? (
        <p className="text-sm text-[#1f4452]">The supplier is in Malaysia, so it issues the e-invoice itself. Nothing to make here.</p>
      ) : bill.eInvoice ? (
        <div className="space-y-3 text-sm text-[#1f4452]">
          <p>Made {bill.eInvoice.generatedAt ? <LocalTime value={bill.eInvoice.generatedAt} locale="en-GB" options={STAMP} /> : ''}. Submit it in the MyInvois portal within 72 hours of that time.</p>
          <div className="flex flex-wrap gap-2">
            <a href={`/api/bills/${encodeURIComponent(bill.id)}/e-invoice?download=1`} className="dash-btn min-h-11"><FileDown size={14} aria-hidden="true" /> Download the file</a>
            <a href={MYINVOIS_PORTAL_URL} target="_blank" rel="noreferrer" className="dash-btn dash-btn-ghost min-h-11 !text-[13px]">Open the MyInvois portal <ExternalLink size={13} aria-hidden="true" /></a>
          </div>
          <p className="font-mono text-[12px] text-[#326273]">SHA-256 {bill.eInvoice.sha256}</p>
        </div>
      ) : canWrite ? (
        <form onSubmit={make} className="space-y-3">
          <p className="text-[13px] leading-5 text-[#326273]">A supplier outside Malaysia is not in MyInvois, so your business issues this e-invoice. The supplier’s details are filled in from the invoice; these are yours.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor={`tin-${bill.id}`} className="text-[13px] font-semibold text-[#1f4452]">Your TIN<span className="text-[var(--error)]" aria-hidden="true">*</span></label>
              <input id={`tin-${bill.id}`} value={form.buyerTin} onChange={(e) => setForm({ ...form, buyerTin: e.target.value })} placeholder="C1234567890" autoComplete="off" className={input} />
            </div>
            <div>
              <label htmlFor={`phone-${bill.id}`} className="text-[13px] font-semibold text-[#1f4452]">Contact number<span className="text-[var(--error)]" aria-hidden="true">*</span></label>
              <input id={`phone-${bill.id}`} type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+60 3 2161 0000" autoComplete="tel" className={input} />
            </div>
            <div>
              <label htmlFor={`state-${bill.id}`} className="text-[13px] font-semibold text-[#1f4452]">State<span className="text-[var(--error)]" aria-hidden="true">*</span></label>
              <select id={`state-${bill.id}`} value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })} className={input}>
                <option value="">Choose</option>
                {Object.entries(MY_STATE_CODES).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={`class-${bill.id}`} className="text-[13px] font-semibold text-[#1f4452]">What it paid for</label>
              <select id={`class-${bill.id}`} value={form.classification} onChange={(e) => setForm({ ...form, classification: e.target.value })} className={input}>
                {Object.entries(SELF_BILLED_CLASSIFICATIONS).map(([code, name]) => <option key={code} value={code}>{name.replace('Self-billed - ', '')}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor={`desc-${bill.id}`} className="text-[13px] font-semibold text-[#1f4452]">Description<span className="text-[var(--error)]" aria-hidden="true">*</span></label>
              <input id={`desc-${bill.id}`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="For example: capacitor reels" className={input} />
            </div>
            {needsRate && (
              <div className="sm:col-span-2">
                <label htmlFor={`rate-${bill.id}`} className="text-[13px] font-semibold text-[#1f4452]">MYR per 1 {currency === 'USDC' ? 'USD' : currency}<span className="text-[var(--error)]" aria-hidden="true">*</span></label>
                <input id={`rate-${bill.id}`} inputMode="decimal" value={form.exchangeRateToMyr} onChange={(e) => setForm({ ...form, exchangeRateToMyr: e.target.value })} aria-describedby={`rate-${bill.id}-help`} className={cn(input, 'font-mono')} />
                <p id={`rate-${bill.id}-help`} className="mt-1 text-[12px] text-[#326273]">The rate you use for tax, such as Bank Negara Malaysia’s for the payment date. Splash does not fill this in.{currency === 'USDC' ? ' USDC is recorded as USD.' : ''}</p>
              </div>
            )}
          </div>
          {problems.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-xl border border-[var(--error)]/30 bg-[var(--error-bg)] p-3 text-[13px] text-[var(--error)]">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className="dash-btn min-h-11 disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null} Make the e-invoice file</button>
            <a href={MYINVOIS_PORTAL_URL} target="_blank" rel="noreferrer" className="dash-btn dash-btn-ghost min-h-11 !text-[13px]">Open the MyInvois portal <ExternalLink size={13} aria-hidden="true" /></a>
          </div>
        </form>
      ) : (
        <p className="text-sm text-[#326273]">Someone who can change invoices makes this file.</p>
      )}
    </StepCard>
  );
}

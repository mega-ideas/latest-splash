'use client';

/**
 * Invoices (v2 brief 5.8). Two jobs, chosen first:
 *   Get paid       invoices the business sends, with a pay link
 *   Pay invoices   invoices its suppliers send, read by Zeke, checked by a
 *                  person, paid to a verified recipient (the old "Inspection
 *                  loop", whose ?view=loop links land here)
 */
import { useCallback, useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';

import GetPaid from '@/components/invoices/GetPaid';
import PayInvoices from '@/components/invoices/PayInvoices';
import { cn } from '@/lib/utils';

type View = 'get-paid' | 'pay';

function viewFromUrl(): View {
  const v = new URLSearchParams(window.location.search).get('view');
  return v === 'pay' || v === 'loop' ? 'pay' : 'get-paid';
}

export default function InvoicesPage() {
  const [view, setView] = useState<View>('get-paid');
  const [counts, setCounts] = useState<{ open: number | null; toReview: number | null }>({ open: null, toReview: null });
  const [issuerName, setIssuerName] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setView(viewFromUrl()), 0);
    // The business's name for a new invoice, and the count on the Pay invoices tab.
    void fetch('/api/bills', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { business?: { name?: string } | null; bills?: Array<{ status: string }> } | null) => {
        if (!body) return;
        if (body.business?.name) setIssuerName(body.business.name);
        if (body.bills) setCounts((c) => ({ ...c, toReview: body.bills!.filter((b) => b.status === 'review').length }));
      })
      .catch(() => {});
    return () => clearTimeout(t);
  }, []);

  function choose(next: View) {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.set('view', next);
    window.history.replaceState(null, '', url);
  }

  const onOpenCount = useCallback(({ open }: { open: number }) => setCounts((c) => (c.open === open ? c : { ...c, open })), []);
  const onReviewCount = useCallback(({ toReview }: { toReview: number }) => setCounts((c) => (c.toReview === toReview ? c : { ...c, toReview })), []);

  const tabs = [
    {
      key: 'get-paid' as const,
      title: 'Get paid',
      body: 'Send an invoice with a pay link and see when it is paid.',
      icon: ArrowDownLeft,
      count: counts.open === null ? null : `${counts.open} open`,
    },
    {
      key: 'pay' as const,
      title: 'Pay invoices',
      body: 'Zeke reads a supplier’s invoice. You check it, schedule it and approve it.',
      icon: ArrowUpRight,
      count: counts.toReview === null ? null : `${counts.toReview} to review`,
    },
  ];

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header>
        <h1 className="dash-title">Invoices</h1>
        <p className="mt-2 max-w-[65ch] text-sm text-[#326273]">Money in and money out, each with its proof.</p>
      </header>

      <div role="tablist" aria-label="Invoices" className="grid gap-3 sm:grid-cols-2">
        {tabs.map(({ key, title, body, icon: Icon, count }) => {
          const selected = view === key;
          return (
            <button
              key={key}
              id={`tab-${key}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`panel-${key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => choose(key)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                  e.preventDefault();
                  const next = key === 'get-paid' ? 'pay' : 'get-paid';
                  choose(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }
              }}
              className={cn(
                'group relative flex min-h-[92px] items-start gap-4 overflow-hidden rounded-2xl border p-4 text-left transition-[transform,box-shadow] sm:p-5',
                selected
                  ? 'border-[#0c3e48] bg-[#0c3e48] text-white shadow-[6px_7px_0_rgba(12,62,72,0.18)]'
                  : 'border-[#326273]/15 bg-white text-[#1f4452] hover:-translate-y-0.5 hover:shadow-[5px_6px_0_rgba(12,62,72,0.10)]',
              )}
            >
              <span aria-hidden="true" className={cn('absolute inset-y-0 left-0 w-1', selected ? 'bg-[#efc46f]' : 'bg-transparent')} />
              <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl', selected ? 'bg-white/12 text-[#efc46f]' : 'bg-[#326273]/8 text-[#145d6a]')}>
                <Icon size={20} aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-lg font-bold tracking-tight">{title}</span>
                  {count && <span className={cn('dash-num text-[13px] font-semibold', selected ? 'text-[#efc46f]' : 'text-[#326273]')}>{count}</span>}
                </span>
                <span className={cn('mt-1 block text-[13px] leading-5', selected ? 'text-white/85' : 'text-[#326273]')}>{body}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div id="panel-get-paid" role="tabpanel" aria-labelledby="tab-get-paid" hidden={view !== 'get-paid'}>
        {view === 'get-paid' && <GetPaid issuerName={issuerName} onCounts={onOpenCount} />}
      </div>
      <div id="panel-pay" role="tabpanel" aria-labelledby="tab-pay" hidden={view !== 'pay'}>
        {view === 'pay' && <PayInvoices onCounts={onReviewCount} />}
      </div>
    </div>
  );
}

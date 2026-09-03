'use client';

import { useEffect, useState } from 'react';

import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';

export type StripData = {
  id: string;
  sendUsd: number;
  delivered: number;
  currency: string;
  feeUsd: number;
  feePct: number;
  rate: number;
  effective: number;
};

const CHECKPOINTS = [
  { code: 'B', label: 'Beneficiary', state: 'complete', note: 'Verified' },
  { code: 'FX', label: 'FX', state: 'complete', note: 'Locked 30s' },
  { code: 'POL', label: 'Policy', state: 'complete', note: 'Passed' },
  { code: 'APP', label: 'Approval', state: 'active', note: 'Checker pending' },
  { code: 'EXE', label: 'Execution', state: 'pending', note: 'Partner rail' },
  { code: 'PRO', label: 'Proof', state: 'pending', note: '3-way match' },
] as const;

/**
 * The hero's thesis, as a real record: a clearance strip for one payment
 * from Kuala Lumpur to Manila. Built from borders and text, not a
 * screenshot. The six checkpoints light in sequence on load and the quote
 * freshness counts down, both held still when the visitor prefers reduced
 * motion.
 */
export default function ClearanceStrip({ data }: { data: StripData }) {
  const [seconds, setSeconds] = useState(27);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (query.matches) return undefined;
    const timer = window.setInterval(() => setSeconds((s) => (s <= 1 ? 30 : s - 1)), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const fresh = seconds > 8;

  return (
    <figure className="clearance-strip mx-auto w-full max-w-[1040px] border border-[var(--border-strong)] bg-[var(--surface-raised)] text-[var(--text)] shadow-[0_24px_64px_-32px_rgba(11,42,51,0.45)]" aria-label={`Clearance record ${data.id}: USD ${data.sendUsd} to ${data.currency}, awaiting checker`}>
      <div className="grid gap-3 border-b border-[var(--border-default)] px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center sm:px-5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">
          <span>Clearance record</span>
          <span className="text-[var(--text)]">{data.id}</span>
          <span aria-hidden="true">·</span>
          <span>Supplier settlement</span>
        </div>
        <span className="inline-flex h-6 w-fit items-center gap-1.5 border border-[var(--amber-700)]/40 bg-[var(--surface-attention)] px-2 font-mono text-[11px] font-medium text-[var(--state-attention)]">
          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" /> Awaiting checker
        </span>
      </div>

      <div className="grid gap-5 px-4 py-5 sm:px-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-8">
        <div className="grid gap-4">
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-3">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">Origin</div>
              <div className="font-mono text-[28px] font-semibold leading-none tracking-[-0.02em] sm:text-[34px]">KUL</div>
              <div className="mt-1 text-[12px] text-[var(--text-2)]">Kuala Lumpur · USD</div>
            </div>
            <div className="route-path relative h-10 self-center" aria-hidden="true">
              <svg viewBox="0 0 200 40" preserveAspectRatio="none" className="absolute inset-0 h-full w-full">
                <path d="M2 34 C 60 2, 140 2, 198 34" fill="none" stroke="var(--signal)" strokeWidth="1.5" strokeDasharray="4 4" className="route-line" />
                <circle cx="2" cy="34" r="3" fill="var(--signal)" />
                <circle cx="198" cy="34" r="3" fill="none" stroke="var(--signal)" strokeWidth="1.5" />
              </svg>
            </div>
            <div className="text-right">
              <div className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">Destination</div>
              <div className="font-mono text-[28px] font-semibold leading-none tracking-[-0.02em] sm:text-[34px]">MNL</div>
              <div className="mt-1 text-[12px] text-[var(--text-2)]">Manila · {data.currency}</div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 border-y border-[var(--border-default)] py-3">
            <div>
              <div className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">You send</div>
              <div className="font-mono text-[20px] font-medium tabular-nums sm:text-[22px]">{formatMoney('USD', data.sendUsd)}</div>
            </div>
            <div className="text-right">
              <div className="font-mono text-[11px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">They receive</div>
              <div className="font-mono text-[20px] font-medium tabular-nums text-[var(--teal-700)] sm:text-[22px]">{formatMoney(data.currency, data.delivered)}</div>
            </div>
          </div>
          <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Checkpoints">
            {CHECKPOINTS.map((c, index) => (
              <li key={c.code} className={cn('checkpoint grid gap-1 border-t-2 pt-2', c.state === 'complete' && 'border-[var(--state-verified)]', c.state === 'active' && 'border-[var(--signal)]', c.state === 'pending' && 'border-[var(--border-strong)]')} style={{ animationDelay: `${index * 140}ms` }}>
                <span className="flex items-center gap-1.5 font-mono text-[11px] font-semibold">
                  <span className={cn('grid size-4 place-items-center rounded-full text-[9px]', c.state === 'complete' && 'bg-[var(--state-verified)] text-white', c.state === 'active' && 'bg-[var(--signal)] text-[var(--signal-contrast)]', c.state === 'pending' && 'border border-[var(--border-strong)] text-[var(--text-muted)]')} aria-hidden="true">{c.state === 'complete' ? '✓' : index + 1}</span>
                  {c.code}
                </span>
                <span className="text-[11px] leading-tight text-[var(--text-2)]">{c.note}</span>
                <span className="sr-only">{c.label}: {c.note}</span>
              </li>
            ))}
          </ol>
        </div>

        <dl className="grid grid-cols-2 content-start gap-x-4 gap-y-3 border-t border-[var(--border-default)] pt-4 text-[12.5px] lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
          <Row label="Effective FX" value={`1 USD = ${data.effective.toFixed(4)} ${data.currency}`} hint={`Rate ${data.rate.toFixed(4)} before cost`} />
          <Row label="All-in cost" value={`${formatMoney('USD', data.feeUsd)} · ${data.feePct.toFixed(2)}%`} hint="Partner fee · no hidden margin" />
          <Row label="Delivery" value="Same day" hint="Sui finality ~400 ms · local rail SLA 4h" />
          <Row label="Route" value="Regulated partner rail" hint="Policy passed · executable" />
          <Row label="Quote freshness" value={fresh ? `Fresh · 00:${String(seconds).padStart(2, '0')}` : `Expiring · 00:${String(seconds).padStart(2, '0')}`} hint={fresh ? 'Locked for 30 s' : 'Refresh quote before execute'} tone={fresh ? 'verified' : 'attention'} />
          <Row label="Live state" value="Awaiting checker" hint="Maker ≠ checker · dual approval on" tone="attention" />
        </dl>
      </div>
      <figcaption className="border-t border-[var(--border-default)] px-4 py-2 font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)] sm:px-5">Illustrative record · sandbox pricing · no customer funds move until MFCA activation</figcaption>
    </figure>
  );
}

function Row({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: 'verified' | 'attention' }) {
  return (
    <div className="grid gap-0.5">
      <dt className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{label}</dt>
      <dd className={cn('font-mono text-[12.5px] font-medium tabular-nums', tone === 'verified' && 'text-[var(--state-verified)]', tone === 'attention' && 'text-[var(--state-attention)]')}>{value}</dd>
      <dd className="text-[11px] text-[var(--text-2)]">{hint}</dd>
    </div>
  );
}

'use client';

import { RefreshCw } from 'lucide-react';

import type { PaymentStatus } from '@/lib/dashboard/home';
import { cn } from '@/lib/utils';

/** The small parts Home's desktop and phone layouts share, so they cannot drift. */

const STATUS_STYLE: Record<PaymentStatus, { label: string; className: string }> = {
  settled: { label: 'Settled', className: 'bg-[var(--ok-bg)] text-[#1F4452]' },
  on_the_way: { label: 'On the way', className: 'bg-[var(--info-bg)] text-[#1F4452]' },
  failed: { label: 'Failed', className: 'bg-[var(--error-bg)] text-[var(--error)]' },
  expired: { label: 'Expired', className: 'bg-[var(--warn-bg)] text-[var(--warn-ink)]' },
};

export function PaymentPill({ status }: { status: PaymentStatus }) {
  const style = STATUS_STYLE[status];
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold', style.className)}>
      {style.label}
    </span>
  );
}

export function FigureSkeleton() {
  return (
    <div aria-hidden="true" className="mt-3 space-y-2">
      <div className="h-7 w-40 rounded-md bg-[#326273]/10 motion-safe:animate-pulse" />
      <div className="h-4 w-28 rounded-md bg-[#326273]/10 motion-safe:animate-pulse" />
    </div>
  );
}

/** A figure card whose summary did not load: said aloud, and retryable. */
export function FigureError({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[13px] font-medium text-[#326273]" role="status">
      Couldn&rsquo;t load.
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-11 items-center gap-1 font-semibold text-[#145d6a] underline decoration-1 underline-offset-2"
      >
        <RefreshCw size={13} aria-hidden="true" />
        Try again
      </button>
    </p>
  );
}

export function Figure({ value, unit, large = false, compact = false }: { value: string; unit?: string; large?: boolean; compact?: boolean }) {
  return (
    <p className={cn('dash-num mt-2 font-extrabold leading-tight tracking-[-0.02em] text-[#0c3e48]', large ? 'text-[40px]' : compact ? 'text-[24px]' : 'text-[28px]')}>
      {value}
      {unit ? <span className={cn('text-[13px] font-semibold tracking-normal text-[#326273]', compact ? 'block' : 'ml-1.5')}>{unit}</span> : null}
    </p>
  );
}

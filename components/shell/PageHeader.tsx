import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Page header: 32px title, one supporting line, one primary action (right). */
export function PageHeader({ title, supporting, actions, className }: { title: string; supporting?: string; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn('mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between', className)}>
      <div className="min-w-0">
        <h1 className="text-[28px] font-semibold leading-[1.1] tracking-[-0.02em] md:text-[32px]">{title}</h1>
        {supporting ? <p className="mt-1 text-[14px] text-[var(--text-2)]">{supporting}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2 md:ml-auto">{actions}</div> : null}
    </header>
  );
}

/** Work area with an optional inspector rail: 1fr + 400px at lg, stacked below. */
export function Workspace({ children, inspector, className }: { children: ReactNode; inspector?: ReactNode; className?: string }) {
  return (
    <div className={cn('grid min-w-0 border border-[var(--border-default)] bg-[var(--surface-raised)]', inspector ? 'lg:grid-cols-[minmax(0,1fr)_minmax(22.5rem,var(--inspector-width))]' : '', className)}>
      <div className="min-w-0">{children}</div>
      {inspector}
    </div>
  );
}

/** Continuous operating summary: figures in a hairline row, not KPI cards. */
export function SummaryStrip({ items, className }: { items: Array<{ label: string; value: ReactNode; tone?: 'default' | 'attention' | 'exception' | 'verified'; hint?: string }>; className?: string }) {
  const tone = { default: 'text-[var(--text)]', attention: 'text-[var(--state-attention)]', exception: 'text-[var(--state-exception)]', verified: 'text-[var(--state-verified)]' };
  return (
    <dl className={cn('mb-5 grid grid-cols-2 divide-y divide-[var(--border-default)] border-y border-[var(--border-default)] md:grid-cols-3 md:divide-y-0 xl:flex xl:divide-x', className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 px-4 py-3 first:pl-0 xl:flex-1">
          <dt className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{item.label}</dt>
          <dd className={cn('mt-1 font-mono text-[22px] font-medium leading-none tabular-nums', tone[item.tone ?? 'default'])}>{item.value}</dd>
          {item.hint ? <dd className="mt-1 text-[11px] text-[var(--text-muted)]">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** Group heading inside a register: "Needs clearance · 3". */
export function GroupHeading({ label, count, tone = 'default', id }: { label: string; count?: number; tone?: 'default' | 'signal' | 'exception'; id?: string }) {
  return (
    <h2 id={id} className={cn('flex h-10 items-center gap-2 border-b border-[var(--border-default)] bg-[var(--surface-subtle)] px-3 font-mono text-[11px] font-medium uppercase tracking-[var(--tracking-label)]', tone === 'signal' ? 'text-[var(--signal)]' : tone === 'exception' ? 'text-[var(--state-exception)]' : 'text-[var(--text-2)]')}>
      {label}
      {typeof count === 'number' ? <span className="tabular-nums">{count}</span> : null}
    </h2>
  );
}

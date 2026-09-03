'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The right inspector rail — the product's core detail pattern. It keeps the
 * list in view on desktop, names the selected record at the top, orders
 * information decision → money → route → evidence → action, and becomes a
 * full-screen sheet below lg when it can be closed (the row list stays
 * behind it). An always-open inspector (no onClose) stacks under the list
 * instead, so nothing is trapped. Escape closes; focus moves to the title on
 * open and back to the opener on close.
 */
export default function Inspector({
  kicker = 'Clearance record',
  title,
  subtitle,
  onClose,
  children,
  actions,
  className,
}: {
  kicker?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!onClose) return undefined;
    openerRef.current = document.activeElement;
    const timer = window.setTimeout(() => titleRef.current?.focus(), 30);
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && onClose) onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      const opener = openerRef.current;
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, [onClose]);

  return (
    <aside
      aria-labelledby="inspector-title"
      className={cn(
        'grid grid-rows-[auto_minmax(0,1fr)_auto] bg-[var(--surface-subtle)] lg:static lg:z-auto lg:min-w-0 lg:border-l lg:border-t-0 lg:border-[var(--border-default)]',
        onClose ? 'fixed inset-0 z-40' : 'border-t border-[var(--border-default)]',
        className,
      )}
    >
      <header className="grid min-h-12 gap-0.5 border-b border-[var(--border-default)] bg-[var(--surface-subtle)] px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{kicker}</span>
          {onClose ? (
            <button type="button" onClick={onClose} aria-label="Close clearance record" className="grid size-8 place-items-center rounded-[var(--r-control)] text-[var(--text-2)] hover:bg-[var(--surface-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <h2 id="inspector-title" ref={titleRef} tabIndex={-1} className="truncate text-[15px] font-medium outline-none">
          {title}
        </h2>
        {subtitle ? <div className="text-[12px] text-[var(--text-2)]">{subtitle}</div> : null}
      </header>
      <div className="min-h-0 overflow-y-auto p-4">{children}</div>
      {actions ? <footer className="grid grid-cols-1 gap-2 border-t border-[var(--border-default)] bg-[var(--surface-subtle)] p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:grid-cols-2">{actions}</footer> : null}
    </aside>
  );
}

/** Label/value rows inside the inspector: money, route, identifiers. */
export function InspectorField({ label, children, mono = false, className }: { label: string; children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="font-mono text-[10px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{label}</div>
      <div className={cn('mt-0.5 break-words text-[13px] text-[var(--text)]', mono && 'font-mono tabular-nums')}>{children}</div>
    </div>
  );
}

export function InspectorSection({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="font-mono text-[10.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-2)]">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

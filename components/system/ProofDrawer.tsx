import { ChevronDown, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Collapsed-by-default proof layer. The only place raw chain vocabulary
 * (digest, blob id, hashes) may appear on a business-facing surface.
 */
export default function ProofDrawer({
  summary = 'View independent settlement proof',
  children,
  className,
  defaultOpen,
}: {
  summary?: string;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={cn('group rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)]', className)} open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[14px] font-semibold text-[var(--text)] outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--teal-500)] [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <ShieldCheck className="size-4 text-[var(--ok-text)]" aria-hidden="true" />
          {summary}
        </span>
        <ChevronDown className="size-4 text-[var(--text-muted)] transition-transform duration-[var(--dur-ui)] group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="border-t border-[var(--divider)] px-4 py-4">{children}</div>
    </details>
  );
}

export function ProofRow({ label, value, mono, href }: { label: string; value: ReactNode; mono?: boolean; href?: string }) {
  const content = href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--teal-600)] underline underline-offset-2">
      {value}
    </a>
  ) : (
    value
  );
  return (
    <div className="grid gap-0.5 py-1.5 sm:grid-cols-[140px_1fr] sm:gap-3">
      <dt className="text-[12px] uppercase tracking-[0.06em] text-[var(--text-muted)]">{label}</dt>
      <dd className={cn('break-all text-[13px] text-[var(--text)]', mono && 'font-mono')}>{content}</dd>
    </div>
  );
}

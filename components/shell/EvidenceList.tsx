import { Check, Circle, X } from 'lucide-react';

import { cn } from '@/lib/utils';

export type EvidenceItem = {
  id: string;
  label: string;
  /** Evidence reference (EV-…, digest, blob id). */
  ref?: string | null;
  at?: string | null;
  state: 'complete' | 'pending' | 'exception';
  detail?: string;
};

/** Evidence timeline: what was checked, by which record, when. */
export default function EvidenceList({ items, className }: { items: EvidenceItem[]; className?: string }) {
  return (
    <ol className={cn('grid', className)}>
      {items.map((item) => (
        <li key={item.id} className="grid min-h-9 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-[var(--border-default)] py-1.5 last:border-b-0">
          <span
            className={cn(
              'grid size-4 place-items-center rounded-full border',
              item.state === 'complete' && 'border-[var(--state-verified)] bg-[var(--state-verified)] text-white',
              item.state === 'pending' && 'border-[var(--state-attention)] text-[var(--state-attention)]',
              item.state === 'exception' && 'border-[var(--state-exception)] bg-[var(--state-exception)] text-white',
            )}
            aria-hidden="true"
          >
            {item.state === 'complete' ? <Check className="size-2.5" strokeWidth={3} /> : item.state === 'exception' ? <X className="size-2.5" strokeWidth={3} /> : <Circle className="size-1.5 fill-current" />}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] text-[var(--text)]">{item.label}</span>
            {item.detail ? <span className="block truncate text-[11px] text-[var(--text-muted)]">{item.detail}</span> : null}
          </span>
          <span className="grid justify-items-end font-mono text-[10.5px] text-[var(--text-muted)]">
            <span className="truncate">{item.ref ?? '—'}</span>
            <span>{item.at ?? '—'}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

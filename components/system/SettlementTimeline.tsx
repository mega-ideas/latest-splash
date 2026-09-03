import { AlertTriangle, Check, RotateCcw } from 'lucide-react';

import { formatInstant } from '@/lib/format/time';
import type { DeliveryRail } from '@/lib/network';
import { buildTimeline, type TimelineEntry } from '@/lib/settlement/delivery-states';
import { cn } from '@/lib/utils';

/**
 * D7 settlement timeline: the rail's happy path with observed hops marked
 * done, the next hop current, and RETURNED / HOP_STUCK rendered as a branch.
 * Evidence rows carry the digest or partner reference for each hop.
 */
export default function SettlementTimeline({
  rail,
  entries,
  className,
  compact,
}: {
  rail: DeliveryRail;
  entries: TimelineEntry[];
  className?: string;
  compact?: boolean;
}) {
  const nodes = buildTimeline(rail, entries);
  return (
    <ol className={cn('grid gap-0', className)} aria-label="Settlement timeline">
      {nodes.map((node, index) => {
        const last = index === nodes.length - 1;
        return (
          <li key={`${node.state}-${index}`} className="grid grid-cols-[28px_1fr] gap-3">
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-full border',
                  node.status === 'done' && 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok-text)]',
                  node.status === 'current' && 'border-[var(--teal-600)] bg-[var(--teal-600)] text-white',
                  node.status === 'todo' && 'border-[var(--line)] bg-[var(--surface)] text-[var(--text-muted)]',
                  node.status === 'branch' && (node.state === 'RETURNED'
                    ? 'border-[var(--error)] bg-[var(--error-bg)] text-[var(--error-text)]'
                    : 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn-text)]'),
                )}
                aria-hidden="true"
              >
                {node.status === 'done' ? <Check className="size-3.5" /> : null}
                {node.status === 'branch' && node.state === 'RETURNED' ? <RotateCcw className="size-3.5" /> : null}
                {node.status === 'branch' && node.state === 'HOP_STUCK' ? <AlertTriangle className="size-3.5" /> : null}
                {node.status === 'current' ? <span className="size-2 rounded-full bg-white" /> : null}
              </span>
              {!last ? <span className={cn('w-px flex-1 min-h-4', node.status === 'done' ? 'bg-[var(--ok)]' : 'bg-[var(--line)]')} /> : null}
            </div>
            <div className={cn('pb-4', last && 'pb-0')}>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className={cn('text-[14px] font-semibold', node.status === 'todo' ? 'text-[var(--text-muted)]' : 'text-[var(--text)]')}>
                  {node.label}
                  <span className="sr-only">
                    {node.status === 'done' ? ' (complete)' : node.status === 'current' ? ' (in progress)' : node.status === 'branch' ? ' (exception)' : ' (pending)'}
                  </span>
                </span>
                {node.at ? <time dateTime={node.at} className="font-mono text-[12px] text-[var(--text-muted)]">{formatInstant(node.at)}</time> : null}
              </div>
              {!compact && node.hint && node.status !== 'todo' ? <p className="mt-0.5 text-[13px] text-[var(--text-2)]">{node.hint}</p> : null}
              {node.evidence ? (
                <p className="mt-1 font-mono text-[12px] text-[var(--text-muted)]">
                  {node.evidence.label}:{' '}
                  {node.evidence.href ? (
                    <a href={node.evidence.href} target="_blank" rel="noopener noreferrer" className="text-[var(--teal-600)] underline underline-offset-2">
                      {node.evidence.value}
                    </a>
                  ) : (
                    node.evidence.value
                  )}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * An empty screen is an invitation to act: one focal illustration, a plain
 * statement of what is missing, and the one action that fills it.
 */
export default function EmptyState({
  art,
  title,
  body,
  action,
  className,
}: {
  /** Isometric focal object (components/illustrations/iso EmptyState). */
  art?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('grid justify-items-center gap-3 rounded-[12px] border border-dashed border-[var(--border-default)] px-6 py-10 text-center', className)}>
      {art ? <div className="w-full max-w-[240px]">{art}</div> : null}
      <h3 className="text-[16px] font-semibold text-[var(--text)]">{title}</h3>
      {body ? <p className="max-w-[42ch] text-[14px] leading-[1.55] text-[var(--text-2)]">{body}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type BadgeTone = 'amber' | 'green' | 'slate' | 'red' | 'teal';

const tones: Record<BadgeTone, string> = {
  amber: 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn)]',
  green: 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok)]',
  slate: 'border-[var(--line)] bg-[var(--surface-2)] text-[var(--text-2)]',
  red: 'border-[var(--error)] bg-[var(--error-bg)] text-[var(--error)]',
  teal: 'border-[var(--info)] bg-[var(--info-bg)] text-[var(--info)]',
};

/**
 * State badge. amber = pending / legacy-rail contrast, green = settled /
 * positive, slate = neutral, red = returned / rejected. Never colour alone:
 * the label carries the meaning.
 */
export default function Badge({
  tone = 'slate',
  children,
  className,
  outline,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  /** Transparent fill (contrast badges under connector lines). */
  outline?: boolean;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--r-pill)] border px-2.5 py-1 text-[12px] font-semibold leading-none tracking-[0.01em]',
        tones[tone],
        outline && 'bg-transparent',
        className,
      )}
    >
      {children}
    </span>
  );
}

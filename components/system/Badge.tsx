import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type BadgeTone = 'amber' | 'green' | 'slate' | 'red' | 'teal';

const tones: Record<BadgeTone, string> = {
  amber: 'border-[var(--warn)] bg-[var(--warn-bg)] text-[var(--warn-text)]',
  green: 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok-text)]',
  slate: 'border-[var(--line)] bg-[var(--surface-2)] text-[var(--text-2)]',
  red: 'border-[var(--error)] bg-[var(--error-bg)] text-[var(--error-text)]',
  teal: 'border-[var(--info)] bg-[var(--info-bg)] text-[var(--info-text)]',
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
        'inline-flex h-6 items-center gap-1.5 rounded-[var(--r-pill)] border px-2 text-[11px] font-medium leading-none',
        tones[tone],
        outline && 'bg-transparent',
        className,
      )}
    >
      {children}
    </span>
  );
}

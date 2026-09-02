import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/utils';

type Tone = 'default' | 'tint' | 'dark';

const tones: Record<Tone, string> = {
  default: 'border border-[var(--line)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-rest)]',
  tint: 'border border-transparent bg-[var(--surface-2)] text-[var(--text)]',
  dark: 'border border-transparent bg-[var(--ink-900)] text-white',
};

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  tone?: Tone;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  elevated?: boolean;
  children: ReactNode;
};

const paddings = { none: '', sm: 'p-4', md: 'p-5 md:p-6', lg: 'p-6 md:p-8' };

/** Surface primitive. Use cards only where elevation communicates hierarchy. */
export default function Card({ tone = 'default', padding = 'md', elevated, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn('rounded-[var(--r-md)]', tones[tone], paddings[padding], elevated && 'shadow-[var(--shadow-elevated)]', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

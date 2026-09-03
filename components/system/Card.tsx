import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '@/lib/utils';

type Tone = 'default' | 'tint' | 'dark';

const tones: Record<Tone, string> = {
  default: 'border border-[var(--border-default)] bg-[var(--surface-raised)] text-[var(--text)]',
  tint: 'border border-[var(--border-default)] bg-[var(--surface-subtle)] text-[var(--text)]',
  dark: 'border border-transparent bg-[var(--ink-900)] text-white',
};

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  tone?: Tone;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  elevated?: boolean;
  children: ReactNode;
};

const paddings = { none: '', sm: 'p-4', md: 'p-5', lg: 'p-6' };

/** Surface primitive: flat, opaque, one-pixel border (Clearance Signal). Elevation only on overlays. */
export default function Card({ tone = 'default', padding = 'md', elevated, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn('rounded-[12px]', tones[tone], paddings[padding], elevated && 'shadow-[var(--shadow-elevated)]', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

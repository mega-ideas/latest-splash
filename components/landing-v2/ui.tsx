import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Shared layout atoms for landing v2. One container width, one section rhythm. */
export const container = 'mx-auto w-full max-w-[1200px] px-5 md:px-8';

export function Section({ id, children, className, tone = 'paper', labelledBy }: { id?: string; children: ReactNode; className?: string; tone?: 'paper' | 'surface'; labelledBy?: string }) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cn('py-16 md:py-24', tone === 'surface' && 'bg-[var(--surface)]', className)}>
      <div className={container}>{children}</div>
    </section>
  );
}

/** Two-tone headline: line one in --text, line two in --text-2 (§1.2). */
export function TwoTone({ id, as: Tag = 'h2', line1, line2, size = 'h2', className }: { id?: string; as?: 'h1' | 'h2'; line1: string; line2?: string; size?: 'display' | 'h2'; className?: string }) {
  const scale = size === 'display' ? 'text-[clamp(2.25rem,6vw,3.5rem)] leading-[1.05]' : 'text-[clamp(1.5rem,4vw,1.75rem)] leading-[1.15]';
  return (
    <Tag id={id} className={cn('font-semibold tracking-[-0.02em] text-[var(--text)]', scale, className)}>
      {line1}
      {line2 ? (
        <>
          {' '}
          <span className="block text-[var(--text-2)]">{line2}</span>
        </>
      ) : null}
    </Tag>
  );
}

export function Lede({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('max-w-[62ch] text-[16px] leading-[1.6] text-[var(--text-2)]', className)}>{children}</p>;
}

/** Mono chip for module names and infrastructure (§1.3). */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('inline-flex h-6 items-center rounded-[999px] border border-[var(--line)] bg-[var(--surface-2)] px-2 font-mono text-[12px] text-[var(--text-2)]', className)}>{children}</code>;
}

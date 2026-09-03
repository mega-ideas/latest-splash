import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Status vocabulary (copy deck). Meaning never depends on hue alone: the
 * label is the meaning, the dot is a secondary cue. Tones:
 * verified (evidence-backed pass), attention (pending / expiring / review),
 * exception (blocked / failed / mismatch), signal (active movement),
 * neutral (draft / informational).
 */
export type StatusTone = 'verified' | 'attention' | 'exception' | 'signal' | 'neutral';

export const STATUS_TONES: Record<string, StatusTone> = {
  Draft: 'neutral',
  'Beneficiary review': 'attention',
  'Quote required': 'attention',
  'Proposal ready': 'signal',
  'Awaiting maker': 'attention',
  'Awaiting checker': 'attention',
  'Checker pending': 'attention',
  Approved: 'verified',
  Executing: 'signal',
  'In transit': 'signal',
  Credited: 'verified',
  Reconciling: 'signal',
  Reconciled: 'verified',
  Verified: 'verified',
  'Policy passed': 'verified',
  'Review required': 'attention',
  'Quote expiring': 'attention',
  'Quote expired': 'exception',
  Returned: 'exception',
  Blocked: 'exception',
  Exception: 'exception',
  Cancelled: 'neutral',
  Live: 'verified',
  Sandbox: 'attention',
};

const toneClass: Record<StatusTone, string> = {
  verified: 'bg-[var(--surface-verified)] text-[var(--state-verified)]',
  attention: 'bg-[var(--surface-attention)] text-[var(--state-attention)]',
  exception: 'bg-[var(--surface-exception)] text-[var(--state-exception)]',
  signal: 'bg-[var(--surface-selected)] text-[var(--teal-700)]',
  neutral: 'bg-[var(--surface-subtle)] text-[var(--text-2)]',
};

export default function StatusLabel({ children, tone, className, compact }: { children: ReactNode; tone?: StatusTone; className?: string; compact?: boolean }) {
  const resolved = tone ?? (typeof children === 'string' ? STATUS_TONES[children] ?? 'neutral' : 'neutral');
  return (
    <span className={cn('inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-[999px] font-medium', compact ? 'h-5 px-1.5 text-[10.5px]' : 'h-6 px-2 text-[11px]', toneClass[resolved], className)}>
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}

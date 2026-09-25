import { cn } from '@/lib/utils';

export type Status = 'unverified' | 'pending' | 'verified' | 'failed' | 'demo' | 'live';

/**
 * A status as a word on its state's tint. The word is ink on every tint, where
 * the tint colours were 1.9-4.4:1; the tint and border carry the state.
 * Waiting states pulse a dot, not the badge, which faded the word to half.
 */
export default function StatusBadge({ status }: { status: Status }) {
  const map = {
    unverified: { label: 'Unverified', cls: 'border-[#E39774]/30 bg-[#E39774]/15', waiting: true },
    pending: { label: 'Pending', cls: 'border-[#E39774]/30 bg-[#E39774]/15', waiting: true },
    verified: { label: 'Verified', cls: 'border-[#5C9EAD]/30 bg-[#5C9EAD]/15', waiting: false },
    failed: { label: 'Failed', cls: 'border-red-500/30 bg-red-500/10', waiting: false },
    demo: { label: 'DEMO', cls: 'border-[#D9A441]/30 bg-[#D9A441]/15', waiting: false },
    live: { label: 'LIVE', cls: 'border-emerald-500/30 bg-emerald-500/10', waiting: false },
  } as const;
  const variant = map[status];

  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium text-[#1F4452]', variant.cls)}>
      {variant.waiting && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[#9f5839] motion-safe:animate-pulse" />}
      {variant.label}
    </span>
  );
}

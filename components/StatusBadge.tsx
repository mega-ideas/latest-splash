import { cn } from '@/lib/utils';

export type Status = 'unverified' | 'pending' | 'verified' | 'failed' | 'demo' | 'live';

export default function StatusBadge({ status }: { status: Status }) {
  const map = {
    unverified: { label: 'Unverified', cls: 'border-[#E39774]/30 bg-[#E39774]/15 text-[#E39774] animate-pulse' },
    pending: { label: 'Pending', cls: 'border-[#E39774]/30 bg-[#E39774]/15 text-[#E39774] animate-pulse' },
    verified: { label: 'Verified', cls: 'border-[#5C9EAD]/30 bg-[#5C9EAD]/15 text-[var(--info)]' },
    failed: { label: 'Failed', cls: 'border-red-500/30 bg-red-500/10 text-red-600' },
    demo: { label: 'DEMO', cls: 'border-[#D9A441]/30 bg-[#D9A441]/15 text-[#9a6f15]' },
    live: { label: 'LIVE', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700' },
  } as const;
  const variant = map[status];

  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-3 py-1 text-[13px] font-medium', variant.cls)}>{variant.label}</span>;
}

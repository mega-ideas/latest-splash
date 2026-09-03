import { cn } from '@/lib/utils';

/**
 * The six checkpoints every payment passes: beneficiary · FX · policy ·
 * approval · execution · proof. This is the clearance record's spine; it
 * appears in table rows (compact), the inspector, the receipt and the
 * landing strip, always in the same order with the same marks.
 */
export type CheckpointKey = 'B' | 'FX' | 'POL' | 'APP' | 'EXE' | 'PRO';
export type CheckpointState = 'complete' | 'active' | 'attention' | 'exception' | 'pending';

export const CHECKPOINTS: Array<{ key: CheckpointKey; label: string }> = [
  { key: 'B', label: 'Beneficiary' },
  { key: 'FX', label: 'FX' },
  { key: 'POL', label: 'Policy' },
  { key: 'APP', label: 'Approval' },
  { key: 'EXE', label: 'Execution' },
  { key: 'PRO', label: 'Proof' },
];

const markClass: Record<CheckpointState, string> = {
  complete: 'border-[var(--state-verified)] bg-[var(--state-verified)]',
  active: 'border-[var(--signal)] bg-[var(--signal)]',
  attention: 'border-[var(--state-attention)] bg-[var(--surface-raised)]',
  exception: 'border-[var(--state-exception)] bg-[var(--state-exception)]',
  pending: 'border-[var(--border-strong)] bg-[var(--surface-raised)]',
};

export type CheckpointStates = Record<CheckpointKey, CheckpointState>;

export function describeCheckpoints(states: CheckpointStates): string {
  return CHECKPOINTS.map((c) => `${c.label}: ${states[c.key]}`).join(', ');
}

export default function ClearanceProgress({ states, compact = false, className }: { states: CheckpointStates; compact?: boolean; className?: string }) {
  return (
    <ol className={cn('flex items-start', compact ? 'w-[132px] gap-0' : 'w-full', className)} aria-label={`Checkpoints — ${describeCheckpoints(states)}`}>
      {CHECKPOINTS.map((checkpoint, index) => {
        const state = states[checkpoint.key];
        const previousComplete = index > 0 && states[CHECKPOINTS[index - 1].key] === 'complete';
        return (
          <li key={checkpoint.key} className="relative grid min-w-0 flex-1 justify-items-center gap-1 text-center">
            {index > 0 ? (
              <span
                aria-hidden="true"
                className={cn('absolute top-[6px] h-px', compact ? 'left-[-50%] right-[50%]' : 'left-[calc(-50%+8px)] right-[calc(50%+8px)]', previousComplete && state !== 'pending' ? 'bg-[var(--state-verified)]' : 'bg-[var(--border-default)]')}
              />
            ) : null}
            <span className={cn('relative z-[1] block rounded-full border-2', compact ? 'size-[11px]' : 'size-[13px]', markClass[state])} />
            <span className={cn('font-mono uppercase text-[var(--text-muted)]', compact ? 'text-[8.5px] leading-none' : 'text-[10px] tracking-[0.04em]', state === 'active' && 'text-[var(--signal)]', state === 'exception' && 'text-[var(--state-exception)]')}>
              {compact ? checkpoint.key : checkpoint.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

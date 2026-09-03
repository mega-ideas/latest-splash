import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';

export type Step = { label: string; detail?: string };

/**
 * Process strip for real sequences (send flow, five-step settlement).
 * Horizontal from md, vertical timeline below. The current step is
 * announced via aria-current.
 */
export default function StepStrip({
  steps,
  current,
  className,
  footnote,
}: {
  steps: Step[];
  /** Index of the current step; steps before it are done. */
  current: number;
  className?: string;
  footnote?: string;
}) {
  return (
    <div className={cn('grid gap-3', className)}>
      <ol className="grid gap-4 md:grid-flow-col md:auto-cols-fr md:gap-2">
        {steps.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'current' : 'todo';
          return (
            <li key={step.label} className="flex gap-3 md:flex-col md:gap-2" aria-current={state === 'current' ? 'step' : undefined}>
              <div className="flex items-center gap-2 md:w-full">
                <span
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-full border font-mono text-[12px] font-semibold',
                    state === 'done' && 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok)]',
                    state === 'current' && 'border-[var(--teal-600)] bg-[var(--teal-600)] text-white',
                    state === 'todo' && 'border-[var(--line)] text-[var(--text-muted)]',
                  )}
                >
                  {state === 'done' ? <Check className="size-3.5" aria-hidden="true" /> : index + 1}
                </span>
                <span className={cn('hidden h-px flex-1 md:block', index < current ? 'bg-[var(--ok)]' : 'bg-[var(--line)]', index === steps.length - 1 && 'md:invisible')} />
              </div>
              <div>
                <div className={cn('text-[14px] font-semibold', state === 'todo' ? 'text-[var(--text-muted)]' : 'text-[var(--text)]')}>{step.label}</div>
                {step.detail ? <div className="text-[13px] text-[var(--text-muted)]">{step.detail}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
      {footnote ? <p className="text-[12px] text-[var(--text-muted)]">{footnote}</p> : null}
    </div>
  );
}

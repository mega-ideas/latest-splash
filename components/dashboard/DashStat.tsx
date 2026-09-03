'use client';

import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

type DashStatProps = {
  label: string;
  value: string;
  delta?: string;
  deltaClassName?: string;
  icon?: LucideIcon;
  iconClassName?: string;
  iconWrapClassName?: string;
  valueClassName?: string;
  interactive?: boolean;
  className?: string;
};

/**
 * Shared stat tile (dash-block) used across dashboard pages. The value renders
 * as itself — no count-up. Tweening a balance means the screen spends most of a
 * second displaying an amount that is not true, which is the wrong trade on a
 * page whose purpose is that the figures can be checked.
 */
export default function DashStat({
  label,
  value,
  delta,
  deltaClassName,
  icon: Icon,
  iconClassName,
  iconWrapClassName,
  valueClassName,
  interactive = true,
  className,
}: DashStatProps) {

  // No count-up. A tween over 800ms means the screen spends most of a second
  // showing a number that is not the balance — on a page whose whole job is
  // that the figures are checkable. The value renders as itself.

  return (
    <div className={cn('dash-block p-4', interactive && 'dash-block-interactive', className)}>
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#326273]/55">{label}</span>
        {Icon && (
          <span className={cn('rounded-lg p-1.5', iconWrapClassName ?? 'bg-[#5C9EAD]/10')}>
            <Icon size={14} className={iconClassName ?? 'text-[var(--info)]'} />
          </span>
        )}
      </div>
      <div className={cn('dash-num mt-2 text-2xl font-semibold text-[#0c3e48]', valueClassName)}>
        {value}
      </div>
      {delta && <div className={cn('mt-0.5 text-[13px] font-medium', deltaClassName ?? 'text-[#326273]/55')}>{delta}</div>}
    </div>
  );
}

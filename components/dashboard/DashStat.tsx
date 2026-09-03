'use client';

import { useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

gsap.registerPlugin(useGSAP);

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
 * Shared stat tile (dash-block) used across dashboard pages. The first number
 * inside `value` counts up on mount / change; prefix, suffix, grouping and
 * decimals are preserved. Text mutation only — never opacity — so a hidden
 * mount still ends with the correct final value.
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
  const valueRef = useRef<HTMLDivElement>(null);
  const lastValueRef = useRef(0);

  useGSAP(() => {
    const el = valueRef.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const match = value.match(/-?[\d,]+(?:\.(\d+))?/);
    if (!match) return;
    const target = Number.parseFloat(match[0].replace(/,/g, ''));
    if (!Number.isFinite(target)) return;
    const decimals = match[1]?.length ?? 0;
    const state = { v: lastValueRef.current };
    gsap.to(state, {
      v: target,
      duration: 0.8,
      ease: 'power2.out',
      onUpdate: () => {
        el.textContent = value.replace(
          match[0],
          state.v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }),
        );
      },
      onComplete: () => {
        lastValueRef.current = target;
        el.textContent = value;
      },
    });
  }, [value]);

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
      <div ref={valueRef} className={cn('dash-num mt-2 text-2xl font-semibold text-[#0c3e48]', valueClassName)}>
        {value}
      </div>
      {delta && <div className={cn('mt-0.5 text-[13px] font-medium', deltaClassName ?? 'text-[#326273]/55')}>{delta}</div>}
    </div>
  );
}

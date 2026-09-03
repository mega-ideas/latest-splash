import { cn } from '@/lib/utils';

/**
 * Skeleton for every async money value. Reserve the final shape so the
 * figure never shifts layout when it arrives (CLS).
 */
export function Skeleton({
  variant = 'block',
  className,
  lines = 1,
}: {
  variant?: 'block' | 'text' | 'money' | 'circle';
  className?: string;
  lines?: number;
}) {
  const base = 'animate-pulse bg-[var(--surface-2)] motion-reduce:animate-none';
  if (variant === 'text') {
    return (
      <span className={cn('grid gap-2', className)} aria-hidden="true">
        {Array.from({ length: lines }).map((_, index) => (
          <span key={index} className={cn(base, 'block h-3.5 rounded-[6px]', index === lines - 1 && lines > 1 ? 'w-2/3' : 'w-full')} />
        ))}
      </span>
    );
  }
  if (variant === 'money') {
    return <span className={cn(base, 'inline-block h-7 w-32 rounded-[8px] align-middle', className)} aria-hidden="true" />;
  }
  if (variant === 'circle') {
    return <span className={cn(base, 'inline-block size-9 rounded-full', className)} aria-hidden="true" />;
  }
  return <span className={cn(base, 'block h-20 w-full rounded-[var(--r-sm)]', className)} aria-hidden="true" />;
}

export default Skeleton;

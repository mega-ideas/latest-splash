import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import Card, { type CardProps } from './Card';

/**
 * Bento layout: exactly as many cells as there is content. Cells declare
 * their span; single column below md.
 */
export function BentoGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-1 gap-4 md:grid-cols-6', className)}>{children}</div>;
}

export function BentoCell({
  span = 2,
  rowSpan = 1,
  className,
  children,
  ...card
}: CardProps & { span?: 2 | 3 | 4 | 6; rowSpan?: 1 | 2 }) {
  const spans = { 2: 'md:col-span-2', 3: 'md:col-span-3', 4: 'md:col-span-4', 6: 'md:col-span-6' }[span];
  const rows = rowSpan === 2 ? 'md:row-span-2' : '';
  return (
    <Card className={cn(spans, rows, 'flex flex-col', className)} {...card}>
      {children}
    </Card>
  );
}

export default BentoGrid;

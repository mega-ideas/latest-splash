'use client';

import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type DataColumn<Row> = {
  key: string;
  header: string;
  render: (row: Row) => ReactNode;
  align?: 'left' | 'right';
  /** Mono + tabular numerals. */
  numeric?: boolean;
  /** Hidden below md. */
  secondary?: boolean;
  width?: string;
};

/**
 * Operational register: semantic table, 44px rows, 1px dividers, no
 * vertical gridlines, numeric right-aligned in mono. A selected row carries
 * a 2px signal start edge and the selected tint; hover is a lighter surface
 * so it never looks like selection. Below md the register becomes a list of
 * blocks with column labels, unless `mobile="scroll"`.
 */
export default function DataTable<Row extends { id: string }>({
  columns,
  rows,
  caption,
  selectedId,
  onSelect,
  rowHref,
  compact = false,
  emptyState,
  loading = false,
  className,
}: {
  columns: DataColumn<Row>[];
  rows: Row[];
  caption: string;
  selectedId?: string | null;
  onSelect?: (row: Row) => void;
  rowHref?: (row: Row) => string;
  compact?: boolean;
  emptyState?: ReactNode;
  loading?: boolean;
  className?: string;
}) {
  const rowH = compact ? 'h-9' : 'h-11';
  return (
    <div className={cn('min-w-0', className)}>
      <table className="hidden w-full border-collapse text-[12.5px] md:table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" style={column.width ? { width: column.width } : undefined} className={cn('h-10 border-b border-[var(--border-default)] px-3 text-left font-mono text-[10.5px] font-medium uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]', column.align === 'right' && 'text-right')}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 4 }, (_, i) => (
                <tr key={`skeleton-${i}`} className={rowH}>
                  {columns.map((column) => (
                    <td key={column.key} className="border-b border-[var(--border-default)] px-3">
                      <span className="block h-3 w-[70%] animate-pulse rounded bg-[var(--surface-subtle)]" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row) => {
                const selected = selectedId === row.id;
                const interactive = Boolean(onSelect || rowHref);
                return (
                  <tr
                    key={row.id}
                    aria-selected={onSelect ? selected : undefined}
                    tabIndex={interactive ? 0 : undefined}
                    onClick={onSelect ? () => onSelect(row) : undefined}
                    onKeyDown={onSelect ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(row); } } : undefined}
                    className={cn(
                      rowH,
                      'transition-colors duration-[var(--dur-fast)]',
                      interactive && 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
                      selected ? 'bg-[var(--surface-selected)] shadow-[inset_2px_0_0_var(--signal)]' : interactive && 'hover:bg-[var(--surface-subtle)]',
                    )}
                  >
                    {columns.map((column) => (
                      <td key={column.key} className={cn('border-b border-[var(--border-default)] px-3 align-middle', column.align === 'right' && 'text-right', column.numeric && 'font-mono tabular-nums')}>
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                );
              })}
        </tbody>
      </table>

      {/* Mobile: semantic list, one block per row, labels visible. */}
      <ul className="grid md:hidden" aria-label={caption}>
        {loading
          ? Array.from({ length: 3 }, (_, i) => <li key={`m-skeleton-${i}`} className="h-20 animate-pulse border-b border-[var(--border-default)] bg-[var(--surface-subtle)]/60" />)
          : rows.map((row) => {
              const selected = selectedId === row.id;
              const primary = columns[0];
              const rest = columns.slice(1).filter((column) => !column.secondary);
              const inner = (
                <>
                  <div className="text-[14px] font-medium">{primary.render(row)}</div>
                  <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1">
                    {rest.map((column) => (
                      <div key={column.key} className="min-w-0">
                        <dt className="font-mono text-[9.5px] uppercase tracking-[var(--tracking-label)] text-[var(--text-muted)]">{column.header}</dt>
                        <dd className={cn('truncate text-[12.5px]', column.numeric && 'font-mono tabular-nums')}>{column.render(row)}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              );
              const cls = cn('block w-full border-b border-[var(--border-default)] p-3 text-left', selected ? 'bg-[var(--surface-selected)] shadow-[inset_2px_0_0_var(--signal)]' : 'active:bg-[var(--surface-subtle)]');
              return (
                <li key={row.id}>
                  {onSelect ? (
                    <button type="button" onClick={() => onSelect(row)} className={cls} aria-pressed={selected}>
                      {inner}
                    </button>
                  ) : rowHref ? (
                    <a href={rowHref(row)} className={cls}>
                      {inner}
                    </a>
                  ) : (
                    <div className={cls}>{inner}</div>
                  )}
                </li>
              );
            })}
      </ul>

      {!loading && rows.length === 0 && emptyState ? <div className="p-6">{emptyState}</div> : null}
    </div>
  );
}

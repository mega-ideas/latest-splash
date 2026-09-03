import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type DataColumn = { key: string; header: string; align?: 'left' | 'right'; mono?: boolean; sticky?: boolean };
export type DataRow = Record<string, ReactNode> & { id: string };

/**
 * Server-renderable data table for public pages. Below md it becomes row
 * cards (label + value pairs) unless `scroll` is set, in which case the
 * first column sticks and the table scrolls horizontally (rates).
 */
export default function DataTable({ columns, rows, caption, scroll = false, footnote }: { columns: DataColumn[]; rows: DataRow[]; caption: string; scroll?: boolean; footnote?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[16px] border border-[var(--line)] bg-[var(--surface)]">
      <div className={cn(scroll ? 'overflow-x-auto' : 'hidden md:block')}>
        <table className={cn('w-full text-[14px]', scroll && 'min-w-[560px]')}>
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-[var(--divider)] font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {columns.map((column) => (
                <th key={column.key} scope="col" className={cn('px-4 py-2.5 font-medium', column.align === 'right' ? 'text-right' : 'text-left', column.sticky && scroll && 'sticky left-0 z-10 bg-[var(--surface)]')}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--divider)]">
            {rows.map((row) => (
              <tr key={row.id}>
                {columns.map((column, index) => {
                  const cell = (
                    <span className={cn(column.mono && 'font-mono tabular-nums')}>{row[column.key]}</span>
                  );
                  return index === 0 ? (
                    <th key={column.key} scope="row" className={cn('px-4 py-3 text-left font-medium', column.sticky && scroll && 'sticky left-0 z-10 bg-[var(--surface)]')}>
                      {cell}
                    </th>
                  ) : (
                    <td key={column.key} className={cn('px-4 py-3', column.align === 'right' && 'text-right')}>
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!scroll ? (
        <ul className="divide-y divide-[var(--divider)] md:hidden" aria-label={caption}>
          {rows.map((row) => (
            <li key={row.id} className="grid gap-1.5 p-4">
              <div className="text-[15px] font-semibold">{row[columns[0].key]}</div>
              <dl className="grid gap-1">
                {columns.slice(1).map((column) => (
                  <div key={column.key} className="flex items-baseline justify-between gap-3 text-[13px]">
                    <dt className="text-[var(--text-muted)]">{column.header}</dt>
                    <dd className={cn('text-right', column.mono && 'font-mono tabular-nums')}>{row[column.key]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      ) : null}
      {footnote ? <p className="border-t border-[var(--divider)] px-4 py-2.5 text-[11px] text-[var(--text-muted)]">{footnote}</p> : null}
    </div>
  );
}

'use client';

import { Download } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import Button from './Button';

export type Column<Row> = {
  key: string;
  header: string;
  /** Money and numeric columns align right and use tabular numerals. */
  align?: 'left' | 'right';
  mono?: boolean;
  /** Renders the cell; the raw value is used for CSV export. */
  render?: (row: Row) => ReactNode;
  value?: (row: Row) => string | number | null | undefined;
  /** Hide on the row-card layout below md (secondary columns). */
  secondary?: boolean;
};

function csvEscape(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Build a CSV string from the same columns the table renders. */
export function toCsv<Row>(columns: Column<Row>[], rows: Row[]): string {
  const header = columns.map((column) => csvEscape(column.header)).join(',');
  const body = rows.map((row) =>
    columns
      .map((column) => csvEscape(column.value ? column.value(row) : (row as Record<string, unknown>)[column.key]))
      .join(','),
  );
  return [header, ...body].join('\n');
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Money-aligned data table. Below `md` every row becomes a card so no table
 * with an action ever scrolls horizontally. CSV export is on by default.
 */
export default function Table<Row extends { id: string }>({
  columns,
  rows,
  caption,
  emptyState,
  exportName,
  rowAction,
  loading,
  className,
}: {
  columns: Column<Row>[];
  rows: Row[];
  caption: string;
  emptyState?: ReactNode;
  /** Filename stem for CSV export; omit to hide the export control. */
  exportName?: string;
  rowAction?: (row: Row) => ReactNode;
  loading?: boolean;
  className?: string;
}) {
  const showExport = Boolean(exportName) && rows.length > 0;
  return (
    <div className={cn('grid gap-3', className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-[var(--text)]">{caption}</h3>
        {showExport ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => downloadCsv(`${exportName}-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(columns, rows))}
          >
            <Download aria-hidden="true" /> Export CSV
          </Button>
        ) : null}
      </div>

      {rows.length === 0 && !loading ? (
        emptyState ?? <p className="text-[14px] text-[var(--text-muted)]">Nothing here yet.</p>
      ) : (
        <>
          {/* Desktop: table */}
          <div className="hidden overflow-hidden rounded-[var(--r-md)] border border-[var(--line)] md:block">
            <table className="w-full border-collapse text-[14px]">
              <caption className="sr-only">{caption}</caption>
              <thead className="bg-[var(--surface-2)] text-[12px] uppercase tracking-[0.06em] text-[var(--text-muted)]">
                <tr>
                  {columns.map((column) => (
                    <th key={column.key} scope="col" className={cn('px-4 py-2.5 font-semibold', column.align === 'right' ? 'text-right' : 'text-left')}>
                      {column.header}
                    </th>
                  ))}
                  {rowAction ? <th scope="col" className="px-4 py-2.5 text-right font-semibold">Actions</th> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--divider)] bg-[var(--surface)]">
                {rows.map((row) => (
                  <tr key={row.id} className="transition-colors hover:bg-[var(--surface-2)]">
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          'px-4 py-3 align-middle text-[var(--text)]',
                          column.align === 'right' && 'text-right tabular-nums',
                          column.mono && 'font-mono text-[13px]',
                        )}
                      >
                        {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}
                      </td>
                    ))}
                    {rowAction ? <td className="px-4 py-3 text-right">{rowAction(row)}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile: row cards */}
          <ul className="grid gap-2 md:hidden">
            {rows.map((row) => (
              <li key={row.id} className="rounded-[var(--r-md)] border border-[var(--line)] bg-[var(--surface)] p-4">
                <dl className="grid gap-1.5">
                  {columns
                    .filter((column) => !column.secondary)
                    .map((column) => (
                      <div key={column.key} className="flex items-baseline justify-between gap-3">
                        <dt className="text-[12px] uppercase tracking-[0.06em] text-[var(--text-muted)]">{column.header}</dt>
                        <dd className={cn('text-right text-[15px] text-[var(--text)]', column.align === 'right' && 'tabular-nums', column.mono && 'font-mono text-[13px]')}>
                          {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? '')}
                        </dd>
                      </div>
                    ))}
                </dl>
                {rowAction ? <div className="mt-3 flex justify-end">{rowAction(row)}</div> : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

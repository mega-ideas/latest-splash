'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, XCircle } from 'lucide-react';

import { SHEET_COPY, preparedLine } from '@/lib/agent/sheet-copy';
import { formatUsdc } from '@/lib/fees/copy';
import type { OxwalSheetState } from '@/lib/oxwal/use-oxwal-thread';
import type { SheetCardRow, SheetFlag } from '@/lib/server/zeke-batch-sheet';
import { cn } from '@/lib/utils';

/**
 * A payout sheet in the Zeke thread (v2 Phase 3).
 *
 * The rows the server read, as a plain table to check: recipient, amount,
 * currency, reference, and for each row whether it is clear, needs a look, or
 * cannot be paid, with the reason in words. Then one button, Prepare batch,
 * which makes the batch in the wallet batch flow, the same one Batch payouts
 * uses. Nothing here sends or approves anything, and nothing says it did.
 *
 * Text from the file is shown as React text, escaped, and only after the server
 * removed links, formulas and commands from it. On a narrow screen (and in the
 * floating Zeke) each row is a small block instead of a table row.
 */

const usdc = (minor: string) => formatUsdc(BigInt(minor));
const mask = (text: string) => (/^0x[0-9a-f]{40,}$/i.test(text) ? `${text.slice(0, 6)}…${text.slice(-4)}` : text);

const STATE = {
  ready: { label: SHEET_COPY.stateReady, Icon: CheckCircle2, text: 'text-[var(--ok-ink)]', row: '' },
  confirm: { label: SHEET_COPY.stateConfirm, Icon: AlertTriangle, text: 'text-[var(--warn-ink)]', row: 'bg-[var(--warn-bg)]' },
  blocked: { label: SHEET_COPY.stateBlocked, Icon: XCircle, text: 'text-[var(--error)]', row: 'bg-[var(--error-bg)]' },
} as const;

const FLAG_TONE: Record<SheetFlag['severity'], string> = {
  blocked: 'text-[var(--error)]',
  confirm: 'text-[var(--warn-ink)]',
  owners: 'text-[var(--ink)]',
  note: 'text-[var(--ink-muted)]',
};

function StateLabel({ state }: { state: SheetCardRow['state'] }) {
  const { label, Icon, text } = STATE[state];
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-bold', text)}>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}

function Flags({ flags }: { flags: SheetFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {flags.map((flag, i) => (
        <li key={`${flag.code}-${i}`} className={cn('text-[13px] leading-5', FLAG_TONE[flag.severity])}>
          {flag.text}
          {flag.detail ? <span className="block text-[var(--ink-muted)]">{flag.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Payee({ row }: { row: SheetCardRow }) {
  if (!row.payee) return null;
  return (
    <span className="block text-[13px] leading-5 text-[var(--ink-muted)]">
      Saved as {row.payee.name} · <span className="font-mono">{row.payee.masked}</span>
    </span>
  );
}

export default function SheetCard({
  id,
  sheet,
  compact = false,
  onPrepare,
  onConfirm,
  onDismiss,
}: {
  id: string;
  sheet: OxwalSheetState;
  compact?: boolean;
  onPrepare: (id: string) => void;
  onConfirm: (id: string, confirmed: boolean) => void;
  onDismiss: (id: string) => void;
}) {
  const indent = compact ? 'pl-7' : 'pl-8';

  if (sheet.phase === 'reading') {
    return (
      <div className={indent}>
        <p role="status" className="inline-flex items-center gap-2 rounded-lg border border-[#326273]/14 bg-white px-3 py-2.5 text-[13px] font-semibold text-[#326273]">
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#5C9EAD] border-t-transparent motion-reduce:animate-none" aria-hidden="true" />
          {SHEET_COPY.reading}
        </p>
      </div>
    );
  }

  if (sheet.phase === 'failed') {
    return (
      <div className={indent}>
        <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--warn)] bg-[var(--warn-bg)] px-3 py-2.5 text-[13px] font-semibold leading-5 text-[var(--warn-ink)]">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{sheet.text}</span>
          <button type="button" onClick={() => onDismiss(id)} className="inline-flex min-h-11 items-center rounded-md border border-[#326273]/25 bg-white px-3 text-[13px] font-bold text-[#0c3e48] focus-ring">
            {SHEET_COPY.dismiss}
          </button>
        </div>
      </div>
    );
  }

  const { card } = sheet;
  const prepared = sheet.phase === 'prepared';
  const review = sheet.phase === 'review' ? sheet : null;
  const role = card.goesTo === 'owners_sign' ? 'OWNER' : 'MAKER';
  const canPrepare = !!review && card.ready && (!card.needsConfirmation || review.confirmed) && !review.preparing;
  const summary = [
    `${card.rows.length} ${card.rows.length === 1 ? 'payment' : 'payments'}`,
    `${usdc(card.totalMinor)} USDC`,
    BigInt(card.feeMinor) > 0n ? `Splash fee ${usdc(card.feeMinor)} USDC` : null,
  ].filter(Boolean);

  return (
    <div className={indent}>
      <section aria-label={SHEET_COPY.title} className="overflow-hidden rounded-xl border border-[#326273]/16 bg-white">
        <header className="flex flex-wrap items-start gap-3 border-b border-[#326273]/12 px-3.5 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[var(--zeke-tint)]">
            <FileSpreadsheet className="h-[18px] w-[18px] text-[#0d6370]" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-bold text-[#0c3e48]">{card.fileName ?? 'Pasted rows'}</h3>
            <p className="text-[13px] leading-5 text-[var(--ink-muted)] tabular-nums">{summary.join(' · ')}</p>
          </div>
          <p className={cn('rounded-md px-2 py-1 text-[13px] font-bold', card.blockedCount > 0 ? 'bg-[var(--error-bg)] text-[var(--error)]' : card.confirmCount > 0 ? 'bg-[var(--warn-bg)] text-[var(--warn-ink)]' : 'bg-[var(--ok-bg)] text-[var(--ok-ink)]')}>
            {card.blockedCount > 0
              ? `${card.blockedCount} cannot be paid`
              : card.confirmCount > 0
                ? `${card.confirmCount} to check`
                : `${card.readyCount} of ${card.rows.length} clear`}
          </p>
        </header>

        <p className="border-b border-[#326273]/12 bg-[var(--zeke-tint)] px-3.5 py-2 text-[13px] font-medium leading-5 text-[#0c3e48]">{card.limit}</p>

        <div className={cn(compact ? 'hidden' : 'hidden md:block')}>
          <table className="w-full table-fixed border-collapse text-left text-sm">
            <caption className="sr-only">Rows read from the sheet</caption>
            <colgroup>
              <col className="w-9" />
              <col />
              <col className="w-28" />
              <col className="w-20" />
              <col className="w-36" />
              <col className="w-36" />
            </colgroup>
            <thead>
              <tr className="border-b border-[#326273]/12 text-[12px] font-bold uppercase tracking-[0.08em] text-[var(--ink-muted)]">
                <th scope="col" className="px-3.5 py-2 font-bold">#</th>
                <th scope="col" className="py-2 pr-3 font-bold">Recipient</th>
                <th scope="col" className="py-2 pr-3 text-right font-bold">Amount</th>
                <th scope="col" className="py-2 pr-3 font-bold">Currency</th>
                <th scope="col" className="py-2 pr-3 font-bold">Reference</th>
                <th scope="col" className="py-2 pr-3.5 font-bold">Status</th>
              </tr>
            </thead>
            {card.rows.map((row) => (
              <tbody key={row.line} className={cn('border-b border-[#326273]/10 last:border-b-0', STATE[row.state].row)}>
                <tr className="align-top">
                  <td className="px-3.5 pt-2.5 text-[13px] tabular-nums text-[var(--ink-muted)]">{row.line}</td>
                  <td className="break-words py-2.5 pr-3 font-semibold text-[#0c3e48]">
                    {row.recipient ? <span title={row.recipient}>{mask(row.recipient)}</span> : <span className="font-medium text-[var(--ink-muted)]">No recipient</span>}
                    <Payee row={row} />
                  </td>
                  <td className="py-2.5 pr-3 text-right font-semibold tabular-nums text-[#0c3e48]">{row.amount || '–'}</td>
                  <td className="py-2.5 pr-3 text-[13px] font-semibold text-[#0c3e48]">{row.currency}</td>
                  <td className="break-words py-2.5 pr-3 text-[13px] text-[#1F4452]">{row.reference || <span className="text-[var(--ink-muted)]">None</span>}</td>
                  <td className="py-2.5 pr-3.5"><StateLabel state={row.state} /></td>
                </tr>
                {row.flags.length > 0 ? (
                  <tr>
                    <td />
                    <td colSpan={5} className="pb-2.5 pr-3.5"><Flags flags={row.flags} /></td>
                  </tr>
                ) : null}
              </tbody>
            ))}
          </table>
        </div>

        <ul className={cn('divide-y divide-[#326273]/10', compact ? 'block' : 'md:hidden')} aria-label="Rows read from the sheet">
          {card.rows.map((row) => (
            <li key={row.line} className={cn('px-3.5 py-3', STATE[row.state].row)}>
              <div className="flex items-start justify-between gap-3">
                <p className="min-w-0 break-words text-sm font-semibold text-[#0c3e48]">
                  <span className="mr-1.5 text-[13px] font-medium tabular-nums text-[var(--ink-muted)]">{row.line}.</span>
                  {row.recipient ? <span title={row.recipient}>{mask(row.recipient)}</span> : <span className="font-medium text-[var(--ink-muted)]">No recipient</span>}
                </p>
                <p className="shrink-0 text-sm font-semibold tabular-nums text-[#0c3e48]">
                  {row.amount || '–'} <span className="text-[13px]">{row.currency}</span>
                </p>
              </div>
              <Payee row={row} />
              <p className="mt-0.5 break-words text-[13px] text-[#1F4452]">{row.reference || <span className="text-[var(--ink-muted)]">No reference</span>}</p>
              <div className="mt-1"><StateLabel state={row.state} /></div>
              <Flags flags={row.flags} />
            </li>
          ))}
        </ul>

        {card.notes.length > 0 || card.ignoredColumns.length > 0 ? (
          <ul className="space-y-1 border-t border-[#326273]/12 px-3.5 py-2.5">
            {card.notes.map((note) => (
              <li key={note.code} className={cn('text-[13px] leading-5', FLAG_TONE[note.severity])}>
                {note.text}
                {note.detail ? <span className="text-[var(--ink-muted)]"> {note.detail}</span> : null}
              </li>
            ))}
            {card.ignoredColumns.length > 0 ? (
              <li className="text-[13px] leading-5 text-[var(--ink-muted)]">
                {SHEET_COPY.ignored_columns} {card.ignoredColumns.join(', ')}.
              </li>
            ) : null}
          </ul>
        ) : null}

        {prepared ? (
          <div role="status" className="flex flex-wrap items-center gap-3 border-t border-[#5C9EAD]/40 bg-[var(--ok-bg)] px-3.5 py-3">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--ok-ink)]" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-[13px] font-semibold leading-5 text-[#0c3e48]">{preparedLine({ role, rowCount: card.rows.length })}</p>
            <Link href="/dashboard/batch" className="inline-flex min-h-11 items-center rounded-md bg-[#0c3e48] px-3.5 text-[13px] font-bold text-white transition hover:bg-[#0d6370] focus-ring">
              {SHEET_COPY.openBatchPayouts}
            </Link>
          </div>
        ) : review ? (
          <div className="space-y-3 border-t border-[#326273]/12 px-3.5 py-3">
            <p className="text-[13px] leading-5 text-[#1F4452]">
              {card.blockedCount > 0 || !card.ready ? SHEET_COPY.blockedHelp : card.goesTo === 'owners_sign' ? SHEET_COPY.readyHelp : SHEET_COPY.readyHelpStaff}
            </p>
            {card.needsConfirmation && card.ready ? (
              <label className="flex min-h-11 cursor-pointer items-start gap-2.5 text-[13px] font-medium leading-5 text-[#0c3e48]">
                <input
                  type="checkbox"
                  checked={review.confirmed}
                  onChange={(event) => onConfirm(id, event.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#0d6370]"
                />
                {SHEET_COPY.confirmLabel}
              </label>
            ) : null}
            {review.error ? (
              <p role="alert" className="text-[13px] font-semibold leading-5 text-[var(--error)]">{review.error}</p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={!canPrepare}
                onClick={() => onPrepare(id)}
                className="inline-flex min-h-11 items-center rounded-md bg-[#0c3e48] px-4 text-sm font-bold text-white transition hover:bg-[#0d6370] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 focus-ring"
              >
                {review.preparing ? SHEET_COPY.preparing : SHEET_COPY.prepareButton}
              </button>
              <button
                type="button"
                onClick={() => onDismiss(id)}
                className="inline-flex min-h-11 items-center rounded-md border border-[#326273]/25 bg-white px-3.5 text-sm font-bold text-[#0c3e48] transition hover:border-[#0d6370] focus-ring"
              >
                {SHEET_COPY.dismiss}
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

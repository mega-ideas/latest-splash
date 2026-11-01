'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { Download, FileSpreadsheet, Plus, Upload } from 'lucide-react';

import { BATCH_MAX_PAYMENTS, type SheetRow } from '@/lib/batch/sheet';
import { errorText, pastedSheet, readSheetFile, sampleSheetCsv, sendSheet, SheetFileError, type SheetPayload } from '@/lib/batch/file';
import { QuietButton } from '../transfer/ui';

/**
 * Step 1 of a batch (v2 brief 5.6): get the rows in. A file, rows pasted from a
 * spreadsheet, or one blank row to type into. The server reads a file or pasted
 * rows by fixed rules (lib/batch/ingest.ts; the same reader Zeke uses), then the
 * rows go to the review step, where Splash matches each one to a recipient the
 * business saved. A sheet names people; it never adds one, and nothing in a cell
 * is read as an instruction.
 */
export default function StepUpload({ onRows }: { onRows: (rows: SheetRow[], notes: string[]) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function send(payload: SheetPayload) {
    setError(null);
    setBusy(true);
    try {
      const answer = await sendSheet<{ rows?: SheetRow[]; notes?: Array<{ text: string }> }>(payload, { review: false });
      if (answer.ok && Array.isArray(answer.body?.rows) && answer.body.rows.length > 0) {
        onRows(answer.body.rows, (answer.body.notes ?? []).map((n) => n.text));
      } else {
        setError(errorText(answer, 'That sheet could not be read just now. Nothing was sent.'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    try {
      await send(await readSheetFile(file));
    } catch (e) {
      setError(e instanceof SheetFileError ? e.message : 'That file could not be read. Upload a .csv or .xlsx file with the columns recipient, amount and reference.');
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  async function readPasted() {
    const text = pasted.trim();
    if (!text) {
      setError('Paste the rows first, with a header line: recipient, amount, reference.');
      return;
    }
    await send(pastedSheet(text));
  }

  function downloadSample() {
    const blob = new Blob([sampleSheetCsv()], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'splash-batch-sheet.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-extrabold text-[#0c3e48]">Upload your sheet</h2>
        <p className="mt-1 text-sm leading-6 text-[#326273]">Up to {BATCH_MAX_PAYMENTS} payments, all in USDC. Each row names a recipient you have saved, the amount, and a reference for your records.</p>
      </div>

      <label className="relative flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-[#326273]/35 bg-white p-6 text-center transition-colors focus-within:border-[#0d6370] focus-within:ring-2 focus-within:ring-[#0d6370]/25 hover:border-[#0d6370]">
        <Upload className="h-6 w-6 text-[#145d6a]" aria-hidden="true" />
        <span className="text-[15px] font-bold text-[#0c3e48]">{busy ? 'Reading the file…' : 'Choose a CSV or Excel file'}</span>
        <span className="text-[13px] text-[#326273]">Columns: recipient, amount, reference</span>
        <input ref={input} type="file" accept=".csv,.xlsx" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} aria-label="Choose a CSV or Excel file" />
      </label>

      <div className="rounded-2xl border border-[#326273]/15 bg-white p-4">
        <label htmlFor="batch-paste" className="text-[13px] font-semibold text-[#1F4452]">Or paste rows from a spreadsheet</label>
        <textarea
          id="batch-paste"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder={'recipient,amount,reference\nName of a saved recipient,1500.00,INV-1001'}
          className="mt-1.5 w-full rounded-xl border border-[#326273]/25 bg-white p-3 font-mono text-[13px] leading-5 text-[#0c3e48] outline-none placeholder:text-[#326273] focus:border-[#0d6370] focus:ring-2 focus:ring-[#0d6370]/20"
        />
        <div className="mt-2 flex flex-wrap gap-2">
          <QuietButton type="button" onClick={() => void readPasted()} disabled={busy}><FileSpreadsheet className="h-4 w-4" aria-hidden="true" />Use these rows</QuietButton>
          <QuietButton type="button" onClick={() => onRows([{ line: 1, recipient: '', amount: '', reference: '' }], [])}><Plus className="h-4 w-4" aria-hidden="true" />Start with one blank row</QuietButton>
          <QuietButton type="button" onClick={downloadSample}><Download className="h-4 w-4" aria-hidden="true" />Download a sample sheet</QuietButton>
        </div>
      </div>

      {error ? <p role="alert" className="text-sm font-medium text-[var(--error)]">{error}</p> : null}

      <div className="rounded-xl bg-[#F6F0ED] p-4 text-sm leading-6 text-[#1F4452]">
        <p className="font-bold text-[#0c3e48]">Who can be in a batch</p>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          <li>A recipient you saved and Splash has screened: a wallet your supplier holds, or a business on Splash by its registered name.</li>
          <li>Not a bank account, an exchange account, or USDC on another chain. Those are paid one at a time from <Link href="/dashboard/transfer" className="font-semibold text-[#0d6370] underline underline-offset-2">Transfer</Link>.</li>
          <li>Someone new? Save them first in <Link href="/dashboard/recipients" className="font-semibold text-[#0d6370] underline underline-offset-2">Recipients</Link>.</li>
        </ul>
      </div>
    </div>
  );
}

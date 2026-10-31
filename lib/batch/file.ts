'use client';

/**
 * Reading an uploaded batch sheet in the browser (v2 brief 5.6). Nothing is
 * sent anywhere from here: the rows go to the review step, where the server
 * matches each to a recipient the business saved. Cells are kept exactly as
 * written (no currency sign is stripped), so "RM 20k" is refused in review
 * rather than read as 20.
 */
import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/universal';

import { BATCH_MAX_PAYMENTS, rowsFromRecords, type SheetRow } from './sheet';

/** A sheet larger than this is not a batch of at most BATCH_MAX_PAYMENTS rows. */
const MAX_FILE_BYTES = 512 * 1024;

export class SheetFileError extends Error {}

export async function readSheetFile(file: File): Promise<SheetRow[]> {
  if (file.size > MAX_FILE_BYTES) throw new SheetFileError('That file is too large to be a batch. A batch is at most 20 payments.');
  const ext = file.name.split('.').pop()?.toLowerCase();
  let records: Array<Record<string, unknown>>;
  if (ext === 'csv') {
    records = await new Promise((resolve, reject) => {
      Papa.parse<Record<string, unknown>>(file, { header: true, skipEmptyLines: true, complete: ({ data }) => resolve(data), error: (error) => reject(new SheetFileError(error.message)) });
    });
  } else if (ext === 'xlsx') {
    const [first] = await readXlsxFile(await file.arrayBuffer());
    const [header = [], ...body] = first?.data ?? [];
    const keys = header.map((h) => (h == null ? '' : String(h)).trim());
    records = body.map((cells) => Object.fromEntries(keys.map((key, i) => [key, cells[i] instanceof Date ? (cells[i] as Date).toISOString().slice(0, 10) : cells[i] == null ? '' : String(cells[i])]).filter(([key]) => key)));
  } else {
    throw new SheetFileError('Upload a .csv or .xlsx file.');
  }
  const rows = rowsFromRecords(records);
  if (rows.length === 0) throw new SheetFileError('The file has no rows. The columns are recipient, amount and reference.');
  if (rows.length > BATCH_MAX_PAYMENTS + 5) throw new SheetFileError(`The file has ${rows.length} rows. A batch is at most ${BATCH_MAX_PAYMENTS} payments: split it into smaller files.`);
  return rows;
}

/** The file a person can start from: three columns and nothing that looks like a real payee. */
export function sampleSheetCsv(): string {
  return ['recipient,amount,reference', 'Name of a saved recipient,1500.00,INV-1001', 'Another saved recipient,250.50,INV-1002'].join('\n');
}

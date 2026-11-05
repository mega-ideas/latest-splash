'use client';

/**
 * Handing a payout sheet to the server (v2 Phase 3). The browser does not read
 * the sheet any more: it takes the file as text (a CSV) or as bytes (a
 * spreadsheet), checks only its size and kind, and sends it to
 * POST /api/wallet/batches/sheet, where the rows are read by fixed rules
 * (lib/batch/ingest.ts), the same for Zeke's composer and for Batch payouts.
 * Cells are never stripped or reshaped here, and nothing is stored.
 */
import { call, errorText, type Answer } from '@/components/transfer/api';

/** The server's own cap; a larger file is refused here without being sent. */
export const MAX_FILE_BYTES = 256 * 1024;

export class SheetFileError extends Error {}

export type SheetPayload =
  | { kind: 'text'; name: string | null; text: string; source: 'file' | 'pasted' }
  | { kind: 'xlsx'; name: string | null; base64: string; source: 'file' };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export async function readSheetFile(file: File): Promise<SheetPayload> {
  if (file.size > MAX_FILE_BYTES) throw new SheetFileError('That file is too large to be a batch. A batch is at most 20 payments.');
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'xlsx') return { kind: 'xlsx', name: file.name, base64: toBase64(new Uint8Array(await file.arrayBuffer())), source: 'file' };
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') return { kind: 'text', name: file.name, text: await file.text(), source: 'file' };
  throw new SheetFileError('Upload a .csv or .xlsx file.');
}

export function pastedSheet(text: string): SheetPayload {
  return { kind: 'text', name: null, text, source: 'pasted' };
}

/** Send a sheet. `review: false` asks for the rows only (Batch payouts reviews them on its next step). */
export async function sendSheet<T>(payload: SheetPayload, options: { review: boolean }): Promise<Answer<T>> {
  const body = payload.kind === 'xlsx' ? { kind: 'xlsx', base64: payload.base64 } : { kind: 'text', text: payload.text };
  return call<T>('/api/wallet/batches/sheet', { body: { ...body, name: payload.name ?? undefined, source: payload.source, review: options.review } });
}

export { errorText };

/** The file a person can start from: three columns and nothing that looks like a real payee. */
export function sampleSheetCsv(): string {
  return ['recipient,amount,reference', 'Name of a saved recipient,1500.00,INV-1001', 'Another saved recipient,250.50,INV-1002'].join('\n');
}

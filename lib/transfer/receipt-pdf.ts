/**
 * The receipt as a PDF (server side: the writer uses Node's Buffer). The same
 * rows the card shows, nothing more (lib/transfer/receipt.ts).
 */
import { renderTextPdf, type PdfLine } from '../compliance/pdf-text.ts';
import { receiptRows, type PaymentReceipt } from './receipt.ts';

export function receiptPdf(r: PaymentReceipt): Uint8Array {
  const lines: PdfLine[] = [
    { kind: 'title', text: r.final ? 'Payment receipt' : 'Payment receipt (not final)' },
    { kind: 'text', text: r.final ? 'Verified on Sui.' : 'This payment has not settled yet, so there is nothing to check on Sui.' },
    { kind: 'gap' },
    ...receiptRows(r).map((row): PdfLine => ({ kind: 'field', label: row.label, value: row.value })),
  ];
  if (r.paidAt) lines.push({ kind: 'field', label: 'Paid on', value: r.paidAt });
  if (r.suiDigest) lines.push({ kind: 'field', label: 'Sui transaction (full)', value: r.suiDigest });
  if (r.verifyUrl) lines.push({ kind: 'field', label: 'Check it on Sui', value: r.verifyUrl });
  return renderTextPdf(lines, { footer: r.receiptNo });
}

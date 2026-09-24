import { explorerTxUrl } from './stablecoin-lane.ts';

/**
 * USDC transfer records as CSV, for the business's own books.
 *
 * One row per transfer Splash quoted — sent, failed or expired — with what an
 * accountant or auditor asks for: who was paid, how much, the fee, who asked
 * for it and who approved it, the transaction on Sui, and the sha256 audit
 * record Splash kept. Amounts are exact, six decimal places as USDC has, with
 * no thousands separators, so a spreadsheet reads them as numbers.
 *
 * Recipient names are typed by people, and a cell that begins with = + - @
 * is run as a formula by Excel and Sheets. Every text cell that could start
 * with one is prefixed with an apostrophe (OWASP's CSV-injection advice).
 */

export type UsdcRecord = {
  id: string;
  kind: 'TRANSFER' | 'X402' | string;
  status: string;
  createdAt: Date | string;
  confirmedAt: Date | string | null;
  recipientName: string | null;
  recipientAddress: string;
  resource: string | null;
  principalMinor: bigint;
  feeMinor: bigint;
  senderAddress: string;
  txDigest: string | null;
  auditHash: string | null;
  anchorStatus: string;
  requestedBy: string | null;
  approvedBy: string | null;
  approvalMethod: string | null;
  approvedAt: Date | string | null;
  failureReason: string | null;
};

export const USDC_RECORD_COLUMNS = [
  'created_at',
  'confirmed_at',
  'kind',
  'status',
  'recipient',
  'recipient_address',
  'x402_resource',
  'amount_usdc',
  'fee_usdc',
  'total_usdc',
  'sender_address',
  'tx_digest',
  'explorer_url',
  'audit_hash',
  'anchor_status',
  'requested_by',
  'approved_by',
  'approval_method',
  'approved_at',
  'failure_reason',
] as const;

/** Six-decimal minor units as a plain decimal: 1234500000n → "1234.500000". */
export function plainUsdc(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? '-' : ''}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')}`;
}

function iso(value: Date | string | null): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** A text cell, safe to open in a spreadsheet. */
export function textCell(value: string | null | undefined): string {
  const text = value ?? '';
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function methodLabel(method: string | null): string {
  if (method === 'WHATSAPP_PASSKEY') return 'WhatsApp code + passkey';
  if (method === 'CLICK') return 'Click to approve';
  return method ?? '';
}

export function usdcRecordsCsv(records: UsdcRecord[]): string {
  const lines = [USDC_RECORD_COLUMNS.join(',')];
  for (const r of records) {
    const total = r.principalMinor + r.feeMinor;
    lines.push([
      iso(r.createdAt),
      iso(r.confirmedAt),
      r.kind === 'X402' ? 'x402' : 'transfer',
      textCell(r.status.toLowerCase()),
      textCell(r.recipientName),
      textCell(r.recipientAddress),
      textCell(r.resource),
      plainUsdc(r.principalMinor),
      plainUsdc(r.feeMinor),
      plainUsdc(total),
      textCell(r.senderAddress),
      textCell(r.txDigest),
      r.txDigest ? textCell(explorerTxUrl('mainnet', r.txDigest)) : '',
      textCell(r.auditHash),
      textCell(r.anchorStatus.toLowerCase()),
      textCell(r.requestedBy),
      textCell(r.approvedBy),
      textCell(methodLabel(r.approvalMethod)),
      iso(r.approvedAt),
      textCell(r.failureReason),
    ].join(','));
  }
  // CRLF, per RFC 4180; a trailing newline so appending files stays clean.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * The batch sheet (v2 Phase 3, brief 5.6): what a person uploads, as rules.
 *
 * A sheet is UNTRUSTED DATA. A row says who to pay by a name or an address the
 * business has already saved, and how much; it can never introduce a payee, a
 * bank account or a fee. The server matches each cell against this business's
 * own saved recipients (lib/server/wallet-batches.ts) and refuses what it
 * cannot match. Nothing in a cell is ever read as an instruction.
 *
 * One currency convention: every amount is USDC, written as a plain number
 * ("5,000" or "5000.50", up to six decimals). A currency sign or code beside it
 * is refused rather than guessed at.
 *
 * Pure and client-safe.
 */
import { parseAmountMinor } from '../transfer/plan.ts';

/** Most payments in one batch. One transaction carries them all, and the chain bounds what one transaction may hold. */
export const BATCH_MAX_PAYMENTS = 20;
export const RECIPIENT_CELL_MAX = 120;
export const REFERENCE_MAX = 60;

export type SheetRow = {
  /** 1-based position in the sheet (the line a person sees). */
  line: number;
  /** A saved recipient's name, a saved wallet address, or a registered business name on Splash. */
  recipient: string;
  /** USDC, as typed. */
  amount: string;
  reference: string;
};

export type SheetProblem = { line: number; code: 'recipient_missing' | 'recipient_too_long' | 'bad_amount' | 'reference_too_long' | 'currency_marker' };

const HEADER_ALIASES: Record<'recipient' | 'amount' | 'reference', string[]> = {
  recipient: ['recipient', 'name', 'payee', 'supplier', 'vendor', 'beneficiary', 'address', 'wallet', 'to'],
  amount: ['amount', 'amountusdc', 'usdc', 'value', 'total', 'pay'],
  reference: ['reference', 'ref', 'purpose', 'memo', 'note', 'description', 'invoice'],
};

const norm = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Control and bidirectional-override characters have no place in a name a person approves. */
const UNSAFE = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g;

export function cleanCell(value: unknown): string {
  return String(value ?? '').replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
}

/**
 * Records keyed by their header (a parsed CSV or workbook) as sheet rows.
 * Several columns may carry a recipient ("name" and "address", from an older
 * sheet or from Zeke's upload); the address wins when both are present, since
 * it is the exact one. Rows with nothing in them are dropped.
 */
export function rowsFromRecords(records: Array<Record<string, unknown>>): SheetRow[] {
  const out: SheetRow[] = [];
  let line = 0;
  for (const record of records) {
    const lookup = new Map<string, unknown>();
    for (const [k, v] of Object.entries(record ?? {})) lookup.set(norm(k), v);
    const pick = (field: keyof typeof HEADER_ALIASES): string => {
      for (const alias of HEADER_ALIASES[field]) {
        const v = cleanCell(lookup.get(alias));
        if (lookup.has(alias) && v) return v;
      }
      return '';
    };
    const address = cleanCell(lookup.get('address') ?? lookup.get('wallet'));
    const recipient = address.startsWith('0x') ? address : pick('recipient');
    const amount = pick('amount');
    const reference = pick('reference');
    if (!recipient && !amount && !reference) continue;
    line += 1;
    out.push({ line, recipient, amount, reference });
  }
  return out;
}

/** The sheet rows a sent body carries: only the three fields, cleaned, never more than the cap plus one (so "too many" can be said). */
export function sheetRowsFromBody(value: unknown): SheetRow[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, BATCH_MAX_PAYMENTS + 1).map((raw, i) => {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return { line: i + 1, recipient: cleanCell(r.recipient), amount: cleanCell(r.amount), reference: cleanCell(r.reference) };
  });
}

/** A currency sign or code next to an amount ("RM 20k", "$5,000", "USD 100"): one convention only, so it is refused, not read. */
const CURRENCY_MARKER = /(?:^|[^a-z])(?:rm|myr|usd|php|idr|sgd|eur|gbp|thb|vnd)(?:[^a-z]|$)|[$€£¥₱]|\b\d+(?:\.\d+)?\s*[km]\b/i;

export function problemsOf(row: SheetRow): SheetProblem['code'][] {
  const out: SheetProblem['code'][] = [];
  if (!row.recipient) out.push('recipient_missing');
  else if (row.recipient.length > RECIPIENT_CELL_MAX) out.push('recipient_too_long');
  if (CURRENCY_MARKER.test(row.amount)) out.push('currency_marker');
  else if (parseAmountMinor(row.amount) === null) out.push('bad_amount');
  if (row.reference.length > REFERENCE_MAX) out.push('reference_too_long');
  return out;
}

export const PROBLEM_TEXT: Record<SheetProblem['code'], string> = {
  recipient_missing: 'Say who to pay: a saved recipient’s name or wallet address.',
  recipient_too_long: 'The recipient is too long to be a name or an address.',
  bad_amount: 'The amount must be a number above zero in USDC, with at most six decimals.',
  currency_marker: 'Amounts are in USDC only. Write the number alone, with no currency sign or code.',
  reference_too_long: `The reference is longer than ${REFERENCE_MAX} characters.`,
};

/** Split a pasted or uploaded CSV into records. A small reader for the server and tests; the page uses papaparse. */
export function recordsFromCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  const src = String(text ?? '').replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  const [header = [], ...body] = rows;
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] ?? ''])));
}

/** The sheet a person can download to start from: three columns, no example of a payee Splash does not hold. */
export const SHEET_HEADER = 'recipient,amount,reference';

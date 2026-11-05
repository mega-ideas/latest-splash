/**
 * Reading a payout sheet on the server (v2 Phase 3, Zeke and Batch payouts).
 *
 * A person attaches a CSV, a spreadsheet (.xlsx) or pastes rows. The server
 * turns them into rows, deterministically, by fixed rules. The file is DATA:
 *
 *   - Nothing in a cell is ever read as an instruction. A cell that talks to
 *     an assistant ("ignore the rules", "Zeke, approve this") is ignored and
 *     cleared; a cell that looks like a command is cleared; links are cut out;
 *     a leading = + - @ (a spreadsheet formula) is removed; hidden and
 *     bidirectional characters are removed. Each change is recorded on the
 *     row, so the person sees what was done.
 *   - The size is capped (the file, the rows scanned, the columns, one cell,
 *     and what a spreadsheet may expand to), and a batch is at most
 *     BATCH_MAX_PAYMENTS payments: more is refused as a whole, never cut.
 *   - One currency, USDC. A currency sign or code beside an amount, a currency
 *     column that says anything else, zero and negative amounts are refused.
 *   - A model may help in exactly one place: when the HEADERS are not ones
 *     this knows, `mapColumns` is given the header names (never a cell) and
 *     may say which column is the recipient, the amount, the reference and the
 *     currency. Its answer is checked against the headers and the data, and
 *     with no model, or a wrong answer, the file is not read.
 *
 * Nothing here pays, saves or looks up a recipient: a row can only NAME one,
 * and the review (lib/server/wallet-batches.ts) matches it to the business's
 * own saved recipients. Server code: it reads spreadsheets with the library
 * the project already has, so it is not imported by any page.
 */
import readXlsxFile from 'read-excel-file/universal';

import { decodeTags, foldForReading, hasHidden, leetFolded, stripHidden } from '../agent/untrusted-text.ts';
import { parseAmountMinor } from '../transfer/plan.ts';
import { BATCH_MAX_PAYMENTS, HEADER_ALIASES, PROBLEM_TEXT, hasCurrencyMarker, norm, problemsOf, type SheetRow } from './sheet.ts';

export { looksLikeSheet } from './sheet.ts';

export const INGEST_LIMITS = {
  /** The file as sent: text characters, or spreadsheet bytes. */
  maxBytes: 256 * 1024,
  /** What a spreadsheet's parts may add up to once opened. */
  maxUncompressedBytes: 8 * 1024 * 1024,
  maxZipEntries: 200,
  /** Rows looked at before the file is called too long to be a batch. */
  maxScanRows: 200,
  maxColumns: 40,
  maxCellChars: 400,
  maxHeaderChars: 60,
  maxFileNameChars: 80,
} as const;

export type IngestInput =
  | { kind: 'text'; name?: string; text: string }
  | { kind: 'xlsx'; name?: string; bytes: Uint8Array };

/** Given header names only. Returns what the model said, unchecked: `ingestSheet` checks it. */
export type ColumnMapper = (headers: string[]) => Promise<unknown>;

export type CellNoteCode = 'formula_removed' | 'link_removed' | 'command_removed' | 'instruction_ignored' | 'hidden_removed' | 'truncated';
export type CellNote = { field: 'recipient' | 'amount' | 'reference' | 'currency'; code: CellNoteCode; text: string };
export type RowProblem = { code: 'recipient_missing' | 'recipient_too_long' | 'bad_amount' | 'reference_too_long' | 'currency_marker' | 'currency_not_usdc'; text: string };

export type IngestedRow = {
  line: number;
  recipient: string;
  amount: string;
  /** What the file said the currency is, upper case; USDC when it said nothing. */
  currency: string;
  reference: string;
  notes: CellNote[];
  problems: RowProblem[];
};

export type IngestFailureCode = 'empty' | 'too_large' | 'too_many_rows' | 'too_wide' | 'unreadable' | 'columns_not_understood';

/** The columns the rows were read from, by the names the file gave them. */
export type ColumnNames = { recipient: string[]; amount: string; reference: string | null; currency: string | null };

export type IngestResult =
  | { ok: true; rows: IngestedRow[]; mappedBy: 'headers' | 'positions' | 'assistant'; columns: ColumnNames; ignoredColumns: string[] }
  | { ok: false; code: IngestFailureCode; error: string };

const fail = (code: IngestFailureCode, error: string): IngestResult => ({ ok: false, code, error });

export const NOTE_TEXT: Record<CellNoteCode, string> = {
  formula_removed: 'A leading =, +, - or @ was removed, so a spreadsheet cannot run this cell.',
  link_removed: 'A link was removed.',
  command_removed: 'This cell looked like a command, so it was cleared.',
  instruction_ignored: 'This cell read like an instruction to an assistant. It was ignored and cleared.',
  hidden_removed: 'Hidden characters were removed from this cell.',
  truncated: 'This cell was very long and was cut short.',
};

export const CURRENCY_NOT_USDC_TEXT = (currency: string) => `Batches pay USDC only, and this row says ${currency || 'another currency'}.`;
/** The currency cell had something in it that was cleared, so the row cannot be read as USDC. */
export const CURRENCY_UNREADABLE_TEXT = 'The currency cell could not be read, so this row is not read as USDC. Batches pay USDC only.';
/** The recipient cell read like an instruction or a command and was cleared. */
export const RECIPIENT_CLEARED_TEXT = 'The recipient read like an instruction or a command, so it was cleared. Use the wallet address of the saved recipient instead.';

// ─── Cells ──────────────────────────────────────────────────────────────────

/**
 * Phrases that can only be aimed at an assistant or at the payment's
 * authority. They hold for every cell, names included. Names and references
 * that merely contain a word like "transfer" or "wire" do not match.
 */
const STRICT_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass|skip)\b.{0,40}\b(?:previous|prior|above|earlier|all|any|the|these|those|your|every)\b.{0,40}\b(?:instructions?|rules?|checks?|limits?|prompts?|polic(?:y|ies)|approvals?|screening|guidelines?)\b/,
  /\b0xwal\b/,
  /\b(?:system|assistant|developer)\s*:/,
  /<\s*\|/,
  /\byou\s+are\s+now\b/,
  /\b(?:from\s+now\s+on|going\s+forward|all\s+future)\b/,
  /\b(?:propose[a-z]+|signproposal|prepareusdctransfer|setassistantname|findsavedrecipient|listsavedrecipients)\b/,
  /\b(?:do\s+not|don'?t|never)\s+(?:tell|mention|show|reveal|warn|inform|alert)\b/,
  /\b(?:tell|ask|make|get|have)\s+(?:the\s+)?(?:assistant|zeke|ai|model|bot|chatbot)\b/,
  /\b(?:as|being)\s+an?\s+(?:ai|assistant|language\s+model)\b/,
];

/**
 * A verb and its object, which is also how a supplier can be called ("Release
 * Payments Ltd", "Sign All Graphics", "Send It Logistics") and how Zeke can be
 * addressed. In a reference they hold. In a name they hold only when the cell
 * reads as an order: it starts with please or kindly, or is a sentence long.
 */
const SENTENCE_INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\bzeke\b/,
  /\b(?:please\s+|kindly\s+)?(?:approve|sign|submit|execute|send|release|authori[sz]e|confirm)\b.{0,30}\b(?:this|it|the|all|batch|payment|payments|transaction|transfer|immediately|now)\b/,
  /\b(?:pay|send|forward|remit|deposit|wire)\s+(?:the\s+)?(?:funds\s+|money\s+)?(?:to|into)\b/,
  /\b(?:new|updated|changed|revised|different)\s+(?:bank|account|payee|beneficiary|wallet|iban)\b/,
];

/** Words in a name from which it reads as a sentence rather than a business. */
const SENTENCE_WORDS = 5;

type CellKind = 'name' | 'text';

function readsLikeInstruction(text: string, kind: CellKind = 'text'): boolean {
  const folded = foldForReading(text);
  const forms = [folded, leetFolded(folded)];
  const hits = (patterns: readonly RegExp[]) => patterns.some((pattern) => forms.some((form) => pattern.test(form)));
  if (hits(STRICT_INSTRUCTION_PATTERNS)) return true;
  if (kind === 'name') {
    const words = folded.split(/\s+/).filter(Boolean).length;
    if (words < SENTENCE_WORDS && !/^(?:please|kindly)\b/.test(folded)) return false;
  }
  return hits(SENTENCE_INSTRUCTION_PATTERNS);
}

/** Text a shell, a spreadsheet or a browser could run. */
const COMMAND_PATTERNS: readonly RegExp[] = [
  /`/,
  /\$\(/,
  /\$\{/,
  /&&/,
  /\|/,
  /<\s*\/?\s*[a-z!?][^>]*>?/i,
  /\b(?:javascript|vbscript)\s*:/i,
  /\bdata\s*:\s*text\//i,
  /\b(?:cmd(?:\.exe)?|powershell|pwsh|bash|zsh|sh|wscript|cscript|mshta|regsvr32|rundll32|certutil|bitsadmin|curl|wget|sudo|chmod|chown|eval|exec|netcat|ncat|nc)\s+(?:-|\/|\\|\.\/|~)/i,
  /\b(?:rm|del|erase|format|shutdown|kill)\s+-?[a-z]*\s*[/\\~*]/i,
  /\b(?:hyperlink|importxml|importdata|importhtml|importfeed|importrange|webservice|dde|msexcel|shell)\s*\(/i,
  /\b(?:curl|wget)\b.*\b[a-z0-9-]+\.[a-z]{2,}\b/i,
];

function readsLikeCommand(text: string): boolean {
  return COMMAND_PATTERNS.some((pattern) => pattern.test(text));
}

/** A link: a scheme, www., an address with a path, or an email address. */
const LINK_PATTERN = /\b(?:https?|ftp|sftp|file|wss?|mailto|tel|ssh)\s*:\s*(?:\/)*\S*|\bwww\.\S+|\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+[/?#]\S*|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** A leading character a spreadsheet reads as the start of a formula or a command. */
const FORMULA_LEAD = /^[=+\-@|\t\r\\]+\s*/;

const isAddress = (text: string) => /^0x[0-9a-f]{1,64}$/i.test(text);

export type CleanCell = { text: string; notes: CellNoteCode[] };

/**
 * One cell as the person will see it and as the review will read it. Text is
 * folded to NFKC (a full-width ＝ is still an =), stripped of invisible
 * characters, cut to a length, and then cleared or cleaned by the rules above.
 * An amount is kept as written (so the person sees why it is refused) except
 * that a cell that is an instruction or a command is cleared.
 */
export function sanitizeCell(raw: unknown, field: 'recipient' | 'amount' | 'reference' | 'currency'): CleanCell {
  const notes: CellNoteCode[] = [];
  const spaced = cellText(raw).normalize('NFKC').replace(/[\t\n\r\u{2028}\u{2029}]/gu, ' ');
  // Text spelled in hidden characters is read before it is dropped: what a screen does not show, a model may read.
  const hidden = hasHidden(spaced);
  let text = stripHidden(spaced).replace(/\s+/g, ' ').trim();
  if (hidden) notes.push('hidden_removed');
  const aloud = hidden ? decodeTags(spaced).replace(/\s+/g, ' ').trim() : text;
  if (text.length > INGEST_LIMITS.maxCellChars) {
    text = text.slice(0, INGEST_LIMITS.maxCellChars).trim();
    notes.push('truncated');
  }
  if (isAddress(text)) return { text, notes };
  const kind: CellKind = field === 'recipient' ? 'name' : 'text';
  if (readsLikeInstruction(aloud, kind)) return { text: '', notes: [...notes, 'instruction_ignored'] };
  if (readsLikeCommand(text)) return { text: '', notes: [...notes, 'command_removed'] };
  if (field === 'amount' || field === 'currency') return { text, notes };
  const noLinks = text.replace(LINK_PATTERN, ' ').replace(/\s+/g, ' ').trim();
  if (noLinks !== text) notes.push('link_removed');
  const noFormula = noLinks.replace(FORMULA_LEAD, '').trim();
  if (noFormula !== noLinks) notes.push('formula_removed');
  return { text: noFormula, notes };
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return '';
}

/**
 * A file name as it may be shown and stored (the card header, the batch label):
 * its last part, letters, digits and a few joiners. A name that is a link, a
 * host name (a dot followed by letters, as in www.example.com), or reads like an
 * instruction is not shown at all: the person sees a generic title and the
 * label is generic too.
 */
export function safeFileName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const last = (name.split(/[\\/]/).pop() ?? '').normalize('NFKC');
  const aloud = decodeTags(last);
  const cleaned = stripHidden(last)
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\-+= ]+/, '')
    .trim()
    .slice(0, INGEST_LIMITS.maxFileNameChars)
    .trim();
  if (!cleaned) return null;
  const base = cleaned.replace(/\.(?:csv|tsv|txt|xlsx)$/i, '');
  if (/\.[a-z]{2,}/i.test(base) || /\b(?:https?|ftp|www)\b/i.test(base)) return null;
  if (readsLikeInstruction(aloud.replace(/\.(?:csv|tsv|txt|xlsx)$/i, ''), 'name') || readsLikeInstruction(base, 'name') || readsLikeCommand(base)) return null;
  return cleaned;
}

// ─── Tables ─────────────────────────────────────────────────────────────────

type Table = { rows: string[][]; overflow: boolean };

function detectDelimiter(text: string): ',' | '\t' | ';' {
  const first = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? '';
  let quoted = false;
  const count = { ',': 0, '\t': 0, ';': 0 };
  for (const ch of first) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === ',' || ch === '\t' || ch === ';')) count[ch] += 1;
  }
  if (count['\t'] > 0 && count['\t'] >= count[','] && count['\t'] >= count[';']) return '\t';
  if (count[';'] > count[',']) return ';';
  return ',';
}

/** Rows of cells, with quotes. Stops once more than `limit` non-empty rows have been seen. */
function parseDelimited(text: string, delimiter: string, limit: number): Table {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  const push = () => {
    row.push(cell);
    cell = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      push();
      if (rows.length > limit) return { rows, overflow: true };
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) push();
  return { rows, overflow: rows.length > limit };
}

/** What a zip says its parts will expand to, read from its directory without opening any part. */
function inspectZip(bytes: Uint8Array): 'ok' | 'not_zip' | 'too_large' {
  if (bytes.length < 22) return 'not_zip';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return 'not_zip';
  const entries = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryAt = view.getUint32(end + 16, true);
  if (entries === 0xffff || directorySize === 0xffffffff || directoryAt === 0xffffffff) return 'too_large';
  if (entries > INGEST_LIMITS.maxZipEntries) return 'too_large';
  if (directoryAt + directorySize > bytes.length) return 'not_zip';
  let at = directoryAt;
  let total = 0;
  for (let n = 0; n < entries; n += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return 'not_zip';
    const size = view.getUint32(at + 24, true);
    if (size === 0xffffffff) return 'too_large';
    total += size;
    if (total > INGEST_LIMITS.maxUncompressedBytes) return 'too_large';
    at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return 'ok';
}

async function tableFromXlsx(bytes: Uint8Array): Promise<Table | IngestResult> {
  if (bytes.length > INGEST_LIMITS.maxBytes) return fail('too_large', 'That file is too large to be a batch. A batch is at most 20 payments.');
  const zip = inspectZip(bytes);
  if (zip === 'not_zip') return fail('unreadable', 'That is not a spreadsheet Splash can read. Upload a .csv or .xlsx file, or paste the rows.');
  if (zip === 'too_large') return fail('too_large', 'That spreadsheet expands to far more than a batch can be, so it was not opened. A batch is at most 20 payments.');
  try {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const [first] = await readXlsxFile(copy);
    const data = first?.data ?? [];
    const rows: string[][] = [];
    for (const cells of data) {
      const row = cells.slice(0, INGEST_LIMITS.maxColumns + 1).map((c) => cellText(c));
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      if (rows.length > INGEST_LIMITS.maxScanRows + 1) return { rows, overflow: true };
    }
    return { rows, overflow: false };
  } catch {
    return fail('unreadable', 'That spreadsheet could not be read. Save it as .xlsx or .csv and try again, or paste the rows.');
  }
}

// ─── Columns ────────────────────────────────────────────────────────────────

type Mapping = { recipient: number[]; amount: number; reference: number | null; currency: number | null };

const CURRENCY_ALIASES = ['currency', 'ccy', 'asset', 'token', 'coin'];

function aliasMapping(headers: string[]): { mapping: Mapping | null; hits: number } {
  const keys = headers.map((h) => norm(h));
  const used = new Set<number>();
  const first = (aliases: readonly string[]): number | null => {
    for (const alias of aliases) {
      const at = keys.findIndex((k, i) => k === alias && !used.has(i));
      if (at >= 0) return at;
    }
    return null;
  };
  const recipient: number[] = [];
  for (const alias of HEADER_ALIASES.recipient) {
    const at = keys.findIndex((k, i) => k === alias && !used.has(i));
    if (at >= 0) {
      recipient.push(at);
      used.add(at);
    }
  }
  const amount = first(HEADER_ALIASES.amount);
  if (amount !== null) used.add(amount);
  const reference = first(HEADER_ALIASES.reference);
  if (reference !== null) used.add(reference);
  const currency = first(CURRENCY_ALIASES);
  const hits = recipient.length + (amount === null ? 0 : 1);
  if (recipient.length === 0 || amount === null) return { mapping: null, hits };
  return { mapping: { recipient, amount, reference, currency }, hits };
}

/** Name shown for a column: its header, unless that reads like an instruction or a command. */
function headerLabel(raw: string, index: number): string {
  const cleaned = sanitizeCell(raw, 'reference').text.slice(0, INGEST_LIMITS.maxHeaderChars);
  const touched = readsLikeInstruction(cleaned) || readsLikeCommand(cleaned) || cleaned === '';
  return touched ? `(column ${index + 1})` : cleaned;
}

function looksLikeAmount(cell: string): boolean {
  return parseAmountMinor(cell) !== null;
}

/** A cell that is a number, or an amount with a currency beside it: something the row check can judge. */
function isAmountLike(cell: string): boolean {
  const text = cell.trim();
  return parseAmountMinor(text) !== null || /^[-+]?\d[\d,]*(?:\.\d+)?$/.test(text) || hasCurrencyMarker(text);
}

const isWhole = (cell: string) => /^\d[\d,]*$/.test(cell.trim());

/** The model's answer, checked against the headers and the data. Anything else is no mapping. */
function checkedMapping(answer: unknown, labels: string[], body: string[][]): Mapping | null {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return null;
  const a = answer as Record<string, unknown>;
  const indexOf = (value: unknown): number | null => {
    if (typeof value !== 'string') return null;
    const matches = labels.map((l, i) => (l === value && !/^\(column \d+\)$/.test(l) ? i : -1)).filter((i) => i >= 0);
    return matches.length === 1 ? matches[0] : null;
  };
  const recipients = (Array.isArray(a.recipient) ? a.recipient : [a.recipient]).map(indexOf);
  const amount = indexOf(a.amount);
  if (recipients.length === 0 || recipients.length > 3 || recipients.some((i) => i === null) || amount === null) return null;
  const reference = a.reference === undefined || a.reference === null ? null : indexOf(a.reference);
  const currency = a.currency === undefined || a.currency === null ? null : indexOf(a.currency);
  const chosen = [...(recipients as number[]), amount, ...(reference === null ? [] : [reference]), ...(currency === null ? [] : [currency])];
  if (new Set(chosen).size !== chosen.length) return null;
  const column = (i: number) => body.map((r) => String(r[i] ?? '').trim()).filter(Boolean);
  const amounts = column(amount);
  // Every amount cell must be an amount: one guess is not allowed to leave a stray cell for the row check to find.
  if (amounts.length === 0 || !amounts.every(isAmountLike)) return null;
  if ((recipients as number[]).every((i) => column(i).length === 0)) return null;
  // A column of whole numbers (invoice numbers, ids) is not the money when another column of amounts has cents.
  if (amounts.every(isWhole)) {
    const taken = new Set([amount, ...(recipients as number[])]);
    const rival = labels.some((_, i) => {
      if (taken.has(i)) return false;
      const cells = column(i);
      return cells.length > 0 && cells.every(isAmountLike) && cells.some((c) => /\.\d/.test(c));
    });
    if (rival) return null;
  }
  return { recipient: recipients as number[], amount, reference, currency };
}

// ─── The reader ─────────────────────────────────────────────────────────────

export async function ingestSheet(input: IngestInput, opts: { mapColumns?: ColumnMapper | null } = {}): Promise<IngestResult> {
  let table: Table;
  if (input.kind === 'xlsx') {
    const read = await tableFromXlsx(input.bytes);
    if ('ok' in read) return read;
    table = read;
  } else {
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.length > INGEST_LIMITS.maxBytes) return fail('too_large', 'That file is too large to be a batch. A batch is at most 20 payments.');
    const clean = text.replace(/^\u{feff}/u, '');
    if (!clean.trim()) return fail('empty', 'There is nothing in it. A sheet has a header line (recipient, amount, reference) and one row per payment.');
    table = parseDelimited(clean, detectDelimiter(clean), INGEST_LIMITS.maxScanRows + 1);
  }
  if (table.overflow) return fail('too_many_rows', `The file has more than ${INGEST_LIMITS.maxScanRows} rows. A batch is at most ${BATCH_MAX_PAYMENTS} payments: split it into smaller files.`);
  if (table.rows.length === 0) return fail('empty', 'There is nothing in it. A sheet has a header line (recipient, amount, reference) and one row per payment.');
  const width = Math.max(...table.rows.map((r) => r.length));
  if (width > INGEST_LIMITS.maxColumns) return fail('too_wide', `The file has ${width} columns. A payout sheet needs three: recipient, amount and reference.`);

  const headerRow = table.rows[0];
  const headers = headerRow.map((h) => String(h ?? ''));
  const labels = headers.map((h, i) => headerLabel(h, i));
  const found = aliasMapping(headers);
  let mapping = found.mapping;
  let mappedBy: 'headers' | 'positions' | 'assistant' = 'headers';
  let body = table.rows.slice(1);

  if (!mapping) {
    const headerless = found.hits === 0 && headerRow.length >= 2 && headerRow.some((c) => looksLikeAmount(String(c).trim().replace(/,/g, '')));
    if (headerless) {
      mapping = { recipient: [0], amount: 1, reference: headerRow.length > 2 ? 2 : null, currency: null };
      mappedBy = 'positions';
      body = table.rows;
    } else if (opts.mapColumns) {
      let answer: unknown = null;
      try {
        answer = await opts.mapColumns(labels);
      } catch {
        answer = null;
      }
      mapping = checkedMapping(answer, labels, body);
      mappedBy = 'assistant';
    }
  }
  if (!mapping) {
    return fail('columns_not_understood', `Splash could not tell which columns are which${labels.length ? ` (${labels.slice(0, 8).join(', ')})` : ''}. Name the columns recipient, amount and reference, then attach the file again.`);
  }

  body = body.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (body.length === 0) return fail('empty', 'There are no payments in it. Add one row per payment under the header line.');
  if (body.length > BATCH_MAX_PAYMENTS) return fail('too_many_rows', `The file has ${body.length} payments. A batch is at most ${BATCH_MAX_PAYMENTS}: split it into smaller files.`);

  const m = mapping;
  const rows: IngestedRow[] = body.map((cells, i) => {
    const notes: CellNote[] = [];
    const take = (index: number, field: CellNote['field']): string => {
      const clean = sanitizeCell(cells[index], field);
      for (const code of clean.notes) notes.push({ field, code, text: NOTE_TEXT[code] });
      return clean.text;
    };
    const candidates = m.recipient.map((idx) => take(idx, 'recipient'));
    const recipient = candidates.find((c) => /^0x/i.test(c)) ?? candidates.find((c) => c !== '') ?? '';
    const amount = take(m.amount, 'amount');
    const reference = m.reference === null ? '' : take(m.reference, 'reference');
    const written = m.currency === null ? '' : cellText(cells[m.currency]).trim();
    const said = m.currency === null ? '' : take(m.currency, 'currency').toUpperCase().slice(0, 12);
    // Only a currency cell that is truly empty means USDC. One that had something in it which was cleared (a command, an instruction) is not USDC: it is unreadable, and the row is refused.
    const unreadable = written !== '' && said === '';
    const currency = unreadable ? '?' : said || 'USDC';
    const line = i + 1;
    const nameCleared = recipient === '' && notes.some((n) => n.field === 'recipient' && (n.code === 'instruction_ignored' || n.code === 'command_removed'));
    const problems: RowProblem[] = problemsOf({ line, recipient, amount, reference }).map((code) => ({ code, text: code === 'recipient_missing' && nameCleared ? RECIPIENT_CLEARED_TEXT : PROBLEM_TEXT[code] }));
    if (unreadable) problems.push({ code: 'currency_not_usdc', text: CURRENCY_UNREADABLE_TEXT });
    else if (currency !== 'USDC') problems.push({ code: 'currency_not_usdc', text: CURRENCY_NOT_USDC_TEXT(currency) });
    return { line, recipient, amount, currency, reference, notes, problems };
  });

  const ignoredColumns = labels
    .map((label, i) => ({ label, i }))
    .filter(({ i, label }) => ![...m.recipient, m.amount, m.reference, m.currency].includes(i) && label.trim() !== '' && mappedBy !== 'positions')
    .map(({ label }) => label)
    .slice(0, 10);

  // A headerless sheet has no names to give: its first row is data, so the columns are named by position.
  const nameOf = (index: number) => (mappedBy === 'positions' ? `(column ${index + 1})` : labels[index]);
  const columns: ColumnNames = {
    recipient: m.recipient.map(nameOf),
    amount: nameOf(m.amount),
    reference: m.reference === null ? null : nameOf(m.reference),
    currency: m.currency === null ? null : nameOf(m.currency),
  };

  return { ok: true, rows, mappedBy, columns, ignoredColumns };
}

/**
 * The rows as the batch flow takes them: three fields. A currency other than
 * USDC travels WITH the amount ("100 EUR"), so the review refuses it as it
 * refuses any amount with a currency beside it; a row cannot become USDC by
 * being passed on.
 */
export function toSheetRows(rows: readonly IngestedRow[]): SheetRow[] {
  return rows.map((r) => ({ line: r.line, recipient: r.recipient, amount: r.currency === 'USDC' ? r.amount : `${r.amount} ${r.currency}`.trim(), reference: r.reference }));
}

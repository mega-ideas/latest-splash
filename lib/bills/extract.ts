/**
 * Reading a supplier's invoice (v2 brief 5.8, Pay invoices).
 *
 * The invoice is untrusted data. Nothing read here is acted on: every value
 * is a proposal a person confirms, the payee is only ever matched against the
 * business's own verified recipients (lib/bills/match.ts), and payment details
 * printed on the invoice (an account number, a wallet address) are read only
 * to warn when they differ from the verified recipient's. Money goes to the
 * recipient on file, never to what the invoice says.
 *
 * Confidence is earned, not asserted. A value is
 *   high    found beside its own label ("Total due", "Due date", "Invoice no")
 *   medium  found in the document without a label, or read by Zeke and found
 *           in the document text
 *   low     read by Zeke but not found anywhere in the document text, or one
 *           of several candidates
 *   none    not read
 * and `reason` says which. No percentage is shown, because nothing here
 * measures one.
 */
import { normalizeAmount } from './amount.ts';

export type Confidence = 'high' | 'medium' | 'low' | 'none';
export const BILL_FIELDS = ['payee', 'amount', 'currency', 'dueDate', 'invoiceNumber', 'invoiceDate', 'payeeCountry'] as const;
export type BillField = (typeof BILL_FIELDS)[number];

export type ExtractedField = {
  value: string;
  confidence: Confidence;
  reason: string;
  /** Where in the document text the value was found, for highlighting. */
  span: [number, number] | null;
};

export type BillExtraction = {
  fields: Record<BillField, ExtractedField>;
  /** Printed payment details. Read for a mismatch warning only; never paid to. */
  paymentDetails: { walletAddresses: string[]; accountNumbers: string[] };
  /**
   * How the printed payment details were read: from the document's text, by
   * Zeke from a PDF, or not at all (a PDF Zeke said nothing about). When they
   * were not read, the page says the changed-details check did not run,
   * rather than showing an empty list as a pass. Absent on invoices read
   * before 0058, which were all text.
   */
  paymentDetailsRead?: PaymentDetailsRead;
  source: 'parser' | 'model' | 'model_pdf';
};

export type PaymentDetailsRead = 'document_text' | 'zeke_pdf' | 'not_read';

/** What Zeke may answer: the seven fields, and the account numbers and wallets the invoice prints. */
export type ModelReading = Partial<Record<BillField, unknown>> & { paymentAccounts?: unknown; paymentWallets?: unknown };

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  none: 'Not read',
};

const NONE = (reason = 'Not found in the document'): ExtractedField => ({ value: '', confidence: 'none', reason, span: null });

const ISO_CURRENCIES = ['USDC', 'USD', 'PHP', 'IDR', 'MYR', 'SGD', 'THB', 'VND', 'EUR', 'GBP', 'CNY', 'HKD', 'JPY', 'AUD', 'INR', 'KRW'] as const;
export const BILL_CURRENCIES: readonly string[] = ISO_CURRENCIES;
const SYMBOLS: Array<[RegExp, string]> = [[/₱/, 'PHP'], [/\bRp\.?/i, 'IDR'], [/\bRM\b/, 'MYR'], [/S\$/, 'SGD'], [/฿/, 'THB'], [/₫/, 'VND'], [/€/, 'EUR'], [/£/, 'GBP']];

const COUNTRY_NAMES: Array<[RegExp, string]> = [
  [/\bphilippines\b/i, 'PH'], [/\bindonesia\b/i, 'ID'], [/\bmalaysia\b/i, 'MY'], [/\bsingapore\b/i, 'SG'],
  [/\bthailand\b/i, 'TH'], [/\bviet\s?nam\b/i, 'VN'], [/\bchina\b|\bPRC\b/, 'CN'], [/\bhong kong\b/i, 'HK'],
  [/\bunited states\b|\bU\.?S\.?A\.?\b/i, 'US'], [/\bindia\b/i, 'IN'], [/\bjapan\b/i, 'JP'], [/\baustralia\b/i, 'AU'],
  [/\bunited kingdom\b/i, 'GB'],
];
export const COUNTRY_CODES = ['PH', 'ID', 'MY', 'SG', 'TH', 'VN', 'CN', 'HK', 'US', 'IN', 'JP', 'AU', 'GB', 'KR', 'TW', 'AE', 'DE', 'FR', 'NL'] as const;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const DATE_SOURCE = String.raw`(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})`;

/** A printed date as ISO, with whether the reading had to assume day-first. */
export function readDate(raw: string): { iso: string; assumedDayFirst: boolean } | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) { const v = iso(+m[1], +m[2], +m[3]); return v ? { iso: v, assumedDayFirst: false } : null; }
  m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/.exec(s);
  if (m) {
    // Day first, as invoices in Southeast Asia print it. Ambiguous when both
    // parts could be a month, and then the confidence says so.
    const v = iso(+m[3], +m[2], +m[1]);
    return v ? { iso: v, assumedDayFirst: +m[1] <= 12 && +m[2] <= 12 && m[1] !== m[2] } : null;
  }
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s);
  if (m) { const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] ?? MONTHS[m[2].slice(0, 3).toLowerCase()]; const v = mo ? iso(+m[3], mo, +m[1]) : null; return v ? { iso: v, assumedDayFirst: false } : null; }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) { const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()]; const v = mo ? iso(+m[3], mo, +m[2]) : null; return v ? { iso: v, assumedDayFirst: false } : null; }
  return null;
}

function found(value: string, confidence: Confidence, reason: string, start: number, length: number): ExtractedField {
  return { value, confidence, reason, span: [start, start + length] };
}

function labelled(text: string, label: RegExp, value: RegExp): { match: RegExpExecArray; valueIndex: number } | null {
  const re = new RegExp(`${label.source}\\s*[:#\\-]?\\s*${value.source}`, 'i');
  const match = re.exec(text);
  if (!match) return null;
  const captured = match[match.length - 1];
  return { match, valueIndex: match.index + match[0].lastIndexOf(captured) };
}

function readInvoiceNumber(text: string): ExtractedField {
  const hit = labelled(text, /(?:invoice\s*(?:no\.?|number|#)|inv\.?\s*(?:no\.?|#)|bill\s*(?:no\.?|number))/, /([A-Z0-9][A-Z0-9\-\/]{1,30})/);
  if (hit) {
    const value = hit.match[hit.match.length - 1];
    return found(value, 'high', 'Beside “Invoice no”', hit.valueIndex, value.length);
  }
  return NONE();
}

function readDateField(text: string, label: RegExp, labelName: string): ExtractedField {
  const re = new RegExp(`${label.source}\\s*[:\\-]?\\s*${DATE_SOURCE}`, 'i');
  const m = re.exec(text);
  if (!m) return NONE();
  const raw = m[m.length - 1];
  const read = readDate(raw);
  if (!read) return { value: '', confidence: 'none', reason: `“${raw}” is not a date`, span: null };
  const start = m.index + m[0].lastIndexOf(raw);
  return read.assumedDayFirst
    ? found(read.iso, 'medium', `Beside “${labelName}”, read as day/month/year`, start, raw.length)
    : found(read.iso, 'high', `Beside “${labelName}”`, start, raw.length);
}

function readAmountAndCurrency(text: string): { amount: ExtractedField; currency: ExtractedField } {
  const codes = ISO_CURRENCIES.join('|');
  const number = String.raw`(\d{1,3}(?:[,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)`;
  const prefix = String.raw`(?:(${codes})\s*|(₱|Rp\.?|RM|S\$|\$|฿|₫|€|£)\s*)?`;
  const suffix = String.raw`(?:\s*(${codes})\b)?`;
  const labels: Array<[RegExp, string]> = [
    [/(?:total\s*(?:amount\s*)?due|amount\s*due|balance\s*due|total\s*payable|amount\s*payable|please\s*pay)/, 'Total due'],
    [/(?:grand\s*total|invoice\s*total|total\s*amount)/, 'Total'],
    [/\btotal\b/, 'Total'],
  ];
  for (const [label, name] of labels) {
    const re = new RegExp(`${label.source}\\s*(?:\\(([A-Z]{3,4})\\))?\\s*[:\\-]?\\s*${prefix}${number}${suffix}`, 'i');
    const m = re.exec(text);
    if (!m) continue;
    const [, paren, code, symbol, raw, after] = m;
    const plain = normalizeAmount(raw);
    if (!plain || plain === '0') continue;
    const start = m.index + m[0].indexOf(raw, m[0].search(/\d/));
    const amount = found(plain, name === 'Total due' ? 'high' : 'medium', `Beside “${name}”`, start, raw.length);
    const codeRead = (code ?? after ?? paren)?.toUpperCase();
    let currency: ExtractedField;
    if (codeRead && (ISO_CURRENCIES as readonly string[]).includes(codeRead)) {
      const at = m.index + m[0].toUpperCase().indexOf(codeRead);
      currency = found(codeRead, 'high', 'Printed with the amount', at, codeRead.length);
    } else if (symbol) {
      const mapped = SYMBOLS.find(([re2]) => re2.test(symbol))?.[1];
      const at = m.index + m[0].indexOf(symbol);
      currency = mapped
        ? found(mapped, 'medium', `Read from the “${symbol}” sign`, at, symbol.length)
        : found('USD', 'low', 'A “$” sign alone could be several dollars', at, symbol.length);
    } else {
      currency = readAnyCurrency(text);
    }
    return { amount, currency };
  }
  return { amount: NONE('No total found'), currency: readAnyCurrency(text) };
}

function readAnyCurrency(text: string): ExtractedField {
  const re = new RegExp(`\\b(${ISO_CURRENCIES.join('|')})\\b`, 'g');
  const seen = [...text.matchAll(re)];
  if (seen.length === 0) return NONE();
  const distinct = new Set(seen.map((m) => m[1]));
  const first = seen[0];
  return found(first[1], distinct.size === 1 ? 'medium' : 'low', distinct.size === 1 ? 'Named in the document' : 'Several currencies are named', first.index ?? 0, first[1].length);
}

const COMPANY = /\b(inc\.?|incorporated|ltd\.?|limited|corp\.?|corporation|co\.|company|llc|pte\.?|sdn\.?\s*bhd\.?|bhd\.?|pt\b|tbk|trading|enterprises?|industries|manufacturing|logistics|textiles?)\b/i;

function readPayee(text: string): ExtractedField {
  const re = /(?:^|\n)\s*(?:from|supplier|vendor|seller|bill\s*from|sold\s*by|pay\s*to|payee|beneficiary(?:\s*name)?|account\s*name|remit\s*to)\s*[:\-]\s*([^\n]{2,80})/i;
  const m = re.exec(text);
  if (m) {
    const value = m[1].trim().replace(/[,;]$/, '');
    return found(value, 'high', 'Beside “From” or “Supplier”', m.index + m[0].indexOf(m[1]), m[1].trim().length);
  }
  // The first line that looks like a company and is not the buyer's block.
  let offset = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t && COMPANY.test(t) && !/bill\s*to|ship\s*to|sold\s*to|customer/i.test(t) && t.length <= 80) {
      return found(t, 'medium', 'The company named at the top', offset + line.indexOf(t), t.length);
    }
    offset += line.length + 1;
  }
  return NONE();
}

function readCountry(text: string, buyerCountry: string | null): ExtractedField {
  const hits = COUNTRY_NAMES
    .map(([re, code]) => { const m = re.exec(text); return m ? { code, index: m.index, length: m[0].length } : null; })
    .filter((h): h is { code: string; index: number; length: number } => h !== null)
    .filter((h) => h.code !== buyerCountry)
    .sort((a, b) => a.index - b.index);
  if (hits.length === 0) return NONE();
  const h = hits[0];
  return found(h.code, hits.length === 1 ? 'medium' : 'low', hits.length === 1 ? 'A country named in the document' : 'Several countries are named', h.index, h.length);
}

function readPaymentDetails(text: string): BillExtraction['paymentDetails'] {
  const walletAddresses = [...new Set([...text.matchAll(/\b0x[0-9a-fA-F]{64}\b/g)].map((m) => m[0].toLowerCase()))];
  const accountNumbers = [...new Set(
    [...text.matchAll(/(?:account\s*(?:no\.?|number|#)|acct\.?\s*(?:no\.?)?|a\/c\s*(?:no\.?)?)\s*[:#]?\s*(\d[\d\s\-]{4,30}\d)/gi)]
      .map((m) => m[1].replace(/\D/g, '')),
  )];
  return { walletAddresses, accountNumbers };
}

/** The deterministic reading: labels and patterns only. Works with no model and no network. */
export function parseBillText(text: string, options: { buyerCountry?: string | null } = {}): BillExtraction {
  const doc = text.slice(0, 20_000);
  const { amount, currency } = readAmountAndCurrency(doc);
  return {
    fields: {
      payee: readPayee(doc),
      amount,
      currency,
      dueDate: readDateField(doc, /(?:due\s*date|payment\s*due(?:\s*date)?|due\s*on|pay\s*by|due\s*by)/, 'Due date'),
      invoiceNumber: readInvoiceNumber(doc),
      invoiceDate: readDateField(doc, /(?:invoice\s*date|date\s*of\s*issue|issue\s*date|date\s*issued|dated)/, 'Invoice date'),
      payeeCountry: readCountry(doc, options.buyerCountry ?? null),
    },
    paymentDetails: readPaymentDetails(doc),
    paymentDetailsRead: doc.trim() ? 'document_text' : 'not_read',
    source: 'parser',
  };
}

const MAX_PRINTED = 10;

/**
 * The account numbers and wallets Zeke says a PDF prints, kept only when they
 * have the form of one: a Sui address (0x and 64 hex), or 5 to 34 digits
 * written with spaces or dashes at most. Null when Zeke gave neither list,
 * which means the details were not read, not that there were none.
 */
export function readPrintedDetails(reading: ModelReading): BillExtraction['paymentDetails'] | null {
  const { paymentAccounts, paymentWallets } = reading;
  if (!Array.isArray(paymentAccounts) && !Array.isArray(paymentWallets)) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()) : []);
  const walletAddresses = [...new Set(strings(paymentWallets).filter((w) => /^0x[0-9a-fA-F]{64}$/.test(w)).map((w) => w.toLowerCase()))].slice(0, MAX_PRINTED);
  const accountNumbers = [...new Set(
    strings(paymentAccounts)
      .filter((a) => /^[\d\s-]{5,48}$/.test(a))
      .map((a) => a.replace(/\D/g, ''))
      .filter((a) => a.length >= 5 && a.length <= 34),
  )].slice(0, MAX_PRINTED);
  return { walletAddresses, accountNumbers };
}

/** What a model may say about a field, normalised to the form a person confirms, or '' when it is not that form. */
export function normaliseReading(field: BillField, raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
  if (!s || s.length > 120) return '';
  switch (field) {
    case 'amount': return normalizeAmount(s) ?? '';
    case 'currency': { const c = s.toUpperCase(); return (ISO_CURRENCIES as readonly string[]).includes(c) ? c : ''; }
    case 'dueDate':
    case 'invoiceDate': return readDate(s)?.iso ?? '';
    case 'payeeCountry': { const c = s.toUpperCase(); return (COUNTRY_CODES as readonly string[]).includes(c) ? c : ''; }
    case 'invoiceNumber': return /^[A-Za-z0-9][A-Za-z0-9\-\/]{0,40}$/.test(s) ? s : '';
    case 'payee': return s.replace(/[\u0000-\u001f]/g, ' ').slice(0, 80);
  }
}

function locate(text: string, field: BillField, value: string): [number, number] | null {
  const lower = text.toLowerCase();
  const candidates = [value];
  if (field === 'amount') {
    const [w, f = ''] = value.split('.');
    const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    candidates.push(`${grouped}.${(f + '00').slice(0, 2)}`, grouped, w.replace(/\B(?=(\d{3})+(?!\d))/g, '.'));
  }
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i >= 0) return [i, i + c.length];
  }
  return null;
}

/**
 * Combine Zeke's reading with the parser's. The parser's labelled reading
 * wins a disagreement (it is what the document says beside its label); a
 * model value is "medium" only when it is found in the document text, and
 * "low" when it is not. A PDF the model read has no text to check against,
 * so nothing it read is better than medium.
 */
export function groundReading(
  text: string,
  reading: ModelReading | null,
  parsed: BillExtraction,
  source: 'model' | 'model_pdf',
): BillExtraction {
  if (!reading) return parsed;
  const fields = { ...parsed.fields };
  for (const field of BILL_FIELDS) {
    const value = normaliseReading(field, reading[field]);
    if (!value) continue;
    const mine = parsed.fields[field];
    if (mine.value && mine.value.toLowerCase() === value.toLowerCase()) {
      fields[field] = { ...mine, confidence: mine.confidence === 'none' ? 'medium' : mine.confidence === 'low' ? 'medium' : mine.confidence, reason: `${mine.reason}; Zeke read the same` };
      continue;
    }
    if (mine.value && mine.confidence === 'high') {
      fields[field] = { ...mine, confidence: 'medium', reason: `${mine.reason}; Zeke read “${value}”, check which is right` };
      continue;
    }
    if (source === 'model_pdf') {
      fields[field] = { value, confidence: 'medium', reason: 'Read by Zeke from the PDF', span: null };
      continue;
    }
    const span = locate(text, field, value);
    fields[field] = span
      ? { value, confidence: 'medium', reason: 'Read by Zeke and found in the document', span }
      : { value, confidence: 'low', reason: 'Read by Zeke but not found in the document text', span: null };
  }
  if (source === 'model_pdf') {
    // A PDF has no text here: its printed details are Zeke's to read, and
    // checked for form only. They are never paid to (lib/bills/match.ts).
    const printed = readPrintedDetails(reading);
    return { ...parsed, fields, source, paymentDetails: printed ?? { walletAddresses: [], accountNumbers: [] }, paymentDetailsRead: printed ? 'zeke_pdf' : 'not_read' };
  }
  return { ...parsed, fields, source };
}

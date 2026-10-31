'use client';

import Papa from 'papaparse';
import readXlsxFile, { type Row as SheetRow } from 'read-excel-file/universal';

/** A normalized batch row in the shape the batch desk (`/dashboard/batch`)
 *  already understands. Parsing happens entirely in the browser — recipient
 *  data never rides a URL or a network hop from here. */
export type ParsedBatchRow = {
  name: string;
  address: string;
  country: string;
  purpose: string;
  amount: string;
};

export type ParsedBatch = {
  fileName: string;
  rows: ParsedBatchRow[];
  /** Dominant destination country/corridor, best-effort (e.g. "PH"). */
  corridor: string;
};

const HEADER_ALIASES: Record<keyof ParsedBatchRow, string[]> = {
  name: ['name', 'recipient', 'beneficiary', 'payee', 'supplier', 'vendor', 'counterparty', 'to'],
  address: ['address', 'account', 'accountnumber', 'iban', 'wallet', 'recipientaddress', 'bankaccount', 'acct'],
  country: ['country', 'corridor', 'destination', 'currency', 'ccy', 'countrycode'],
  purpose: ['purpose', 'reference', 'memo', 'note', 'description', 'reason', 'invoice'],
  amount: ['amount', 'value', 'total', 'sum', 'usd', 'amountusd', 'pay'],
};

const CURRENCY_TO_COUNTRY: Record<string, string> = {
  PHP: 'PH', IDR: 'ID', SGD: 'SG', MYR: 'MY', VND: 'VN', THB: 'TH', EUR: 'EU', GBP: 'GB', USD: 'PH',
};

function norm(key: string) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Map a raw record's keys onto our columns via alias heuristics. Unknown
 *  columns are ignored; missing ones default sensibly and can be corrected
 *  downstream on the batch desk. */
function mapRecord(record: Record<string, unknown>): ParsedBatchRow | null {
  const lookup = new Map<string, unknown>();
  for (const [k, v] of Object.entries(record)) lookup.set(norm(k), v);

  const pick = (field: keyof ParsedBatchRow) => {
    for (const alias of HEADER_ALIASES[field]) {
      if (lookup.has(alias)) return String(lookup.get(alias) ?? '').trim();
    }
    return '';
  };

  const name = pick('name');
  const address = pick('address');
  // An amount with a currency sign or code, or "20k", is kept as written: the batch desk refuses it
  // (one currency convention, USDC), rather than reading "RM 20k" as 20.
  const amountText = pick('amount');
  const amount = /[a-z$€£¥₱]/i.test(amountText) ? amountText : amountText.replace(/[^0-9.\-]/g, '');
  if (!name && !address && !amount) return null;

  let country = pick('country').toUpperCase();
  if (CURRENCY_TO_COUNTRY[country]) country = CURRENCY_TO_COUNTRY[country];
  if (!country) country = 'PH';

  return {
    name,
    address,
    country: country.slice(0, 2),
    purpose: pick('purpose'),
    amount: amount || '0',
  };
}

function toParsedBatch(fileName: string, records: Array<Record<string, unknown>>): ParsedBatch {
  const rows = records.map(mapRecord).filter((r): r is ParsedBatchRow => r !== null);
  const counts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.country] = (acc[r.country] ?? 0) + 1;
    return acc;
  }, {});
  const corridor = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'PH';
  return { fileName, rows, corridor };
}

/** First row is the header; every later row becomes one record keyed by
 *  it. Empty cells are "" rather than absent so every alias lookup finds a
 *  key, and a Date lands as YYYY-MM-DD — downstream stringifies every value,
 *  and the default Date string is neither sortable nor what a spreadsheet
 *  showed. Rows with no header above a cell are trimmed to the header
 *  width; rows that are entirely empty are dropped, as papaparse does for
 *  CSV via skipEmptyLines. */
function sheetToRecords(rows: SheetRow[]): Record<string, unknown>[] {
  const [header = [], ...body] = rows;
  const keys = header.map((h) => (h == null ? '' : String(h)).trim());
  const records: Record<string, unknown>[] = [];
  for (const row of body) {
    if (row.every((cell) => cell == null || String(cell).trim() === '')) continue;
    const record: Record<string, unknown> = {};
    keys.forEach((key, i) => {
      if (!key) return;
      const cell = row[i];
      record[key] = cell == null ? '' : cell instanceof Date ? cell.toISOString().slice(0, 10) : cell;
    });
    records.push(record);
  }
  return records;
}

export async function parseBatchFile(file: File): Promise<ParsedBatch> {
  const ext = file.name.split('.').pop()?.toLowerCase();

  if (ext === 'csv') {
    return new Promise((resolve, reject) => {
      Papa.parse<Record<string, unknown>>(file, {
        header: true,
        skipEmptyLines: true,
        complete: ({ data }) => resolve(toParsedBatch(file.name, data)),
        error: (err) => reject(err),
      });
    });
  }

  if (ext === 'xlsx') {
    // read-excel-file/universal: pure-JS unzip and XML, takes a Blob or an
    // ArrayBuffer, no DOMParser, no Node built-ins — so the same code path
    // runs in the browser and under `node --test`. It reads .xlsx only; the
    // legacy BIFF .xls format went with SheetJS, which was the one library
    // that could read it and the one that installed from a vendor CDN.
    const [first] = await readXlsxFile(await file.arrayBuffer());
    return toParsedBatch(file.name, sheetToRecords(first?.data ?? []));
  }

  throw new Error('Unsupported file type. Upload a .csv or .xlsx batch file.');
}

const DRAFT_KEY = 'splash.batchDraft';

/** Stash a prepared draft for the batch desk to hydrate. sessionStorage,
 *  not the URL — recipient PII never leaves the browser tab. */
export function stashBatchDraft(batch: ParsedBatch) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(batch));
  } catch {
    // storage may be unavailable (private mode) — caller still navigates.
  }
}

export function takeBatchDraft(): ParsedBatch | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(DRAFT_KEY);
    return JSON.parse(raw) as ParsedBatch;
  } catch {
    return null;
  }
}

/**
 * Client-side preflight screening for batch rows. This is the operator's
 * preview; the server (/api/batches/authorize) is the real gate and re-runs
 * every check. Results are STATES and render with semantic tokens only.
 */
export type ComplianceResult = 'PASS' | 'REVIEW' | 'BLOCK';

export type ComplianceCheck = { label: string; result: ComplianceResult; detail: string };

export type BatchRowInput = { name: string; address: string; country: string; purpose: string; amount: string };

export type BatchRowStatus = 'ready' | 'review' | 'blocked' | 'queued' | 'settled' | 'failed';

export type BatchRow = BatchRowInput & {
  id: string;
  status: BatchRowStatus;
  checks: ComplianceCheck[];
};

export const SUPPORTED_COUNTRIES = new Set(['MY', 'PH', 'ID', 'SG', 'VN', 'TH', 'EU', 'GB']);
const SENTINEL_NAMES = ['sanction', 'blocked', 'pep hit', 'watchlist'];
const REVIEW_THRESHOLD_USD = 5000;

export function strongestResult(checks: ComplianceCheck[]): ComplianceResult {
  if (checks.some((check) => check.result === 'BLOCK')) return 'BLOCK';
  if (checks.some((check) => check.result === 'REVIEW')) return 'REVIEW';
  return 'PASS';
}

function statusFor(result: ComplianceResult): BatchRowStatus {
  if (result === 'PASS') return 'ready';
  if (result === 'REVIEW') return 'review';
  return 'blocked';
}

export function evaluateRow(row: BatchRowInput, duplicateCount: number): ComplianceCheck[] {
  const amount = Number.parseFloat(row.amount || '0');
  const lowerName = String(row.name ?? '').toLowerCase();
  const sentinel = SENTINEL_NAMES.some((term) => lowerName.includes(term));
  return [
    { label: 'Sanctions / PEP', result: sentinel ? 'BLOCK' : 'PASS', detail: sentinel ? 'Potential sanctions or PEP hit' : 'No list match in preflight screen' },
    {
      label: 'KYT amount',
      result: amount > REVIEW_THRESHOLD_USD ? 'REVIEW' : amount > 0 ? 'PASS' : 'BLOCK',
      detail: amount > REVIEW_THRESHOLD_USD ? `Above the ${REVIEW_THRESHOLD_USD.toLocaleString('en-US')} USD single-transfer review threshold` : amount > 0 ? 'Within the single-transfer threshold' : 'Amount must be greater than zero',
    },
    { label: 'Structuring', result: duplicateCount >= 4 ? 'REVIEW' : 'PASS', detail: duplicateCount >= 4 ? 'Same beneficiary appears four or more times in this file' : 'No structuring pattern detected' },
    { label: 'Corridor', result: SUPPORTED_COUNTRIES.has(row.country) ? 'PASS' : 'BLOCK', detail: SUPPORTED_COUNTRIES.has(row.country) ? `${row.country} corridor is enabled` : `${row.country || 'Unknown'} is not an enabled corridor` },
    { label: 'Purpose code', result: row.purpose ? 'PASS' : 'REVIEW', detail: row.purpose ? row.purpose : 'Purpose code required before release' },
  ];
}

export function screenRows(rows: BatchRowInput[]): BatchRow[] {
  const duplicates = rows.reduce<Record<string, number>>((counts, row) => {
    const key = row.address || row.name;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  return rows.map((row, index) => {
    const checks = evaluateRow(row, duplicates[row.address || row.name] ?? 1);
    return { ...row, id: `${index}-${row.address || row.name}`, checks, status: statusFor(strongestResult(checks)) };
  });
}

/** Re-screen a single edited row in the context of the whole file. */
export function rescreen(rows: BatchRow[]): BatchRow[] {
  const screened = screenRows(rows.map(({ name, address, country, purpose, amount }) => ({ name, address, country, purpose, amount })));
  return screened.map((row, index) => ({ ...row, id: rows[index].id }));
}

export const SAMPLE_ROWS: BatchRowInput[] = [
  { name: 'Manila Fulfilment Corp', address: 'PH1234567890', country: 'PH', purpose: 'Vendor invoice', amount: '12000.00' },
  { name: 'Jakarta Supplies PT', address: 'ID9988776655', country: 'ID', purpose: 'Vendor invoice', amount: '8500.00' },
  { name: 'Cebu Logistics Inc', address: 'PH4567891234', country: 'PH', purpose: 'Payroll', amount: '4200.00' },
  { name: 'Surabaya Components PT', address: 'ID5544332211', country: 'ID', purpose: 'Service fee', amount: '3200.00' },
];

export const CSV_HEADER = 'name,address,country,purpose,amount';

export function buildSampleCsv(): string {
  return [CSV_HEADER, ...SAMPLE_ROWS.map((row) => [row.name, row.address, row.country, row.purpose, row.amount].join(','))].join('\n');
}

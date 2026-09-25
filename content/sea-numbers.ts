/**
 * Every number the site shows about the market, the rails, or the rules —
 * each with the source it came from, the URL a reader can open, and the date
 * it was true.
 *
 * Two statuses. `verified` renders everywhere. `needs_verification` renders
 * only outside production, with a badge, so a reviewer sees what is waiting
 * for a human to confirm and a customer never does. Every MyInvois and BIR
 * rule starts as `needs_verification`: a tax-authority phase-in changes, and
 * the person who confirms it against the authority's own page is not this
 * file.
 *
 * The production build fails on a number missing a source, a URL or a date:
 * `scripts/check-numbers.mjs` runs under `npm run lint`, and this module
 * refuses to load in production with a bad entry, so the page that imports
 * it cannot render one.
 */

export type NumberStatus = 'verified' | 'needs_verification';

export type NumberLabel = 'Third-party estimate' | 'Official statistic' | 'Regulatory rule' | 'Splash configuration';

export type SeaNumber = {
  id: string;
  /** The figure as shown, formatted for reading. */
  value: string;
  /** What it means, in one sentence a customer would use. */
  meaning: string;
  /** Who published it. */
  source: string;
  /** Where a reader can check it. https only. */
  sourceUrl: string;
  /** The date the figure was true, ISO. */
  asOf: string;
  label: NumberLabel;
  status: NumberStatus;
};

export const SEA_NUMBERS: SeaNumber[] = [
  {
    id: 'sui-finality',
    value: 'under a second',
    meaning: 'How long the settlement step takes to become final on Sui, the network Splash settles on.',
    source: 'Sui documentation, consensus and finality',
    sourceUrl: 'https://docs.sui.io/concepts/sui-architecture/consensus',
    asOf: '2026-07-18',
    label: 'Third-party estimate',
    status: 'verified',
  },
  {
    id: 'splash-fee-usd-php',
    value: '0.70%',
    meaning: 'What Splash charges to pay out in local currency, USD to PHP and every other corridor, before the exchange rate. No fixed fee.',
    source: 'Splash pricing configuration',
    sourceUrl: 'https://github.com/mega-ideas/latest-splash/blob/main/lib/fx/corridors.ts',
    asOf: '2026-09-26',
    label: 'Splash configuration',
    status: 'verified',
  },
  {
    id: 'live-corridor',
    value: '1',
    meaning: 'Corridor live today, on the Sui testnet: USD to PHP. Others are added only when their rail and controls are ready.',
    source: 'This deployment',
    sourceUrl: 'https://github.com/mega-ideas/latest-splash',
    asOf: '2026-09-23',
    label: 'Splash configuration',
    status: 'verified',
  },
  {
    id: 'ph-cash-remittances-2024',
    value: 'US$34.5 billion',
    meaning: 'Cash remittances into the Philippines in 2024, the market a USD to PHP corridor serves.',
    source: 'Bangko Sentral ng Pilipinas, Overseas Filipinos cash remittances',
    sourceUrl: 'https://www.bsp.gov.ph/SitePages/Statistics/External.aspx',
    asOf: '2025-02-17',
    label: 'Official statistic',
    status: 'needs_verification',
  },
  {
    id: 'rpw-global-average-cost',
    value: '6.5%',
    meaning: 'The global average cost of sending US$200 across a border, across every provider type.',
    source: 'World Bank, Remittance Prices Worldwide',
    sourceUrl: 'https://remittanceprices.worldbank.org/',
    asOf: '2025-03-31',
    label: 'Third-party estimate',
    status: 'needs_verification',
  },
  {
    id: 'myinvois-phase-in',
    value: 'phased from 1 Aug 2024',
    meaning: 'Malaysia e-invoicing (MyInvois) became mandatory in phases by annual turnover, the largest businesses first. Every invoice a Malaysian buyer settles through Splash has to carry the validated record.',
    source: 'LHDN (Inland Revenue Board of Malaysia), e-Invoice guideline',
    sourceUrl: 'https://www.hasil.gov.my/en/e-invoice/',
    asOf: '2025-06-01',
    label: 'Regulatory rule',
    status: 'needs_verification',
  },
  {
    id: 'bir-eis',
    value: 'phased',
    meaning: 'The Philippines is phasing in electronic invoicing and sales reporting (BIR EIS), starting with large taxpayers, exporters and e-commerce. A Philippine supplier paid through Splash keeps a record shaped for it.',
    source: 'Bureau of Internal Revenue (Philippines), Electronic Invoicing/Receipting System',
    sourceUrl: 'https://www.bir.gov.ph/',
    asOf: '2025-06-01',
    label: 'Regulatory rule',
    status: 'needs_verification',
  },
];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Every problem with a set of numbers, as sentences. Empty means complete. */
export function validateSeaNumbers(numbers: SeaNumber[] = SEA_NUMBERS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of numbers) {
    const id = entry.id || '(no id)';
    if (!entry.id) problems.push('an entry has no id');
    if (seen.has(id)) problems.push(`${id}: duplicate id`);
    seen.add(id);
    if (!entry.value?.trim()) problems.push(`${id}: no value`);
    if (!entry.meaning?.trim()) problems.push(`${id}: no meaning`);
    if (!entry.source?.trim()) problems.push(`${id}: no source — who published it?`);
    if (!/^https:\/\/\S+$/.test(entry.sourceUrl ?? '')) problems.push(`${id}: sourceUrl must be an https URL a reader can open`);
    if (!ISO_DATE.test(entry.asOf ?? '') || Number.isNaN(Date.parse(entry.asOf))) {
      problems.push(`${id}: asOf must be an ISO date (the date the figure was true)`);
    }
    if (entry.status !== 'verified' && entry.status !== 'needs_verification') problems.push(`${id}: unknown status`);
  }
  return problems;
}

/** The numbers a given environment may show. Production shows only verified ones. */
export function publishedNumbers(env: string | undefined = process.env.NODE_ENV, numbers: SeaNumber[] = SEA_NUMBERS): SeaNumber[] {
  return env === 'production' ? numbers.filter((n) => n.status === 'verified') : numbers;
}

export function assertSeaNumbersValid(numbers: SeaNumber[] = SEA_NUMBERS): void {
  const problems = validateSeaNumbers(numbers);
  if (problems.length > 0) {
    throw new Error(`content/sea-numbers.ts has ${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  }
}

// Production refuses to load a number without provenance. Development shows
// the problem on the page instead of hiding it behind a crash.
if (process.env.NODE_ENV === 'production') assertSeaNumbersValid();

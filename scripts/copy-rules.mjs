/**
 * The copy rules, with the reason for each.
 *
 * Pure: no filesystem, no process. `scripts/check-copy.mjs` walks the tree
 * and calls `copyViolations` on every file; tests call it on planted text.
 *
 * Surfaces. A reader sees three kinds of file, and a rule applies to the
 * kind it protects:
 *
 *   marketing   — the landing, the trust and working-capital pages, the OG
 *                 image, the landing components, and content/: what a
 *                 stranger reads before signing up. Claims rules AND the
 *                 jargon rule.
 *   customer    — everything else under app/ and components/ except the
 *                 staff console: the signed-in product. Claims rules only —
 *                 the product may say what it does.
 *   staff, engineering — app/admin, components/admin, lib/, scripts/,
 *                 tests/, docs/: no copy rules. An engineering note that
 *                 reasons about a licence is design, not a claim.
 *
 * Every rule scans the whole file text, so JSON-LD objects, alt text and
 * string constants are checked the same as JSX.
 */

/** @typedef {{ pattern: RegExp, reason: string, allow?: RegExp, exceptFiles?: string[] }} CopyRule */

/** @type {CopyRule[]} */
export const CUSTOMER_RULES = [
  {
    pattern: /licensed[- ]partners?/i,
    reason: 'no partner is licensed on our behalf, and the framing was corrected in the truth pass: say "partners of record"',
  },
  {
    pattern: /\blicensed\b/i,
    // "not yet a licensed …", "not-yet-licensed", the claim status
    // 'not-licensed', and "unlicensed" are the negations; nothing else is.
    allow: /\bnot[- ](?:yet[- ])?(?:an?[- ])?licensed\b|\bunlicensed\b/i,
    reason: 'nothing about Splash is licensed; the only sentence allowed to use the word is the negation the Trust page carries',
  },
  {
    pattern: /Splash Financial/i,
    reason: '"Splash Financial" is the name of the trademark holder blocking the mark, and the Labuan entity with that name was never incorporated',
  },
  {
    pattern: /Labuan[^.\n]{0,80}in process|in process[^.\n]{0,80}Labuan/i,
    exceptFiles: ['content/money-path.ts'],
    reason: '"in process" next to a regulator reads as a status the regulator granted; only the locked sentence in content/money-path.ts may say it',
  },
  {
    pattern: /\bBNM\b[^.\n]{0,12}\bMSB\b|Money Services Business/i,
    reason: 'a Malaysian licence nobody has applied for; naming it implies a plan that has not been made',
  },
  {
    pattern: /\bCMSL\b/,
    reason: 'a Singapore capital-markets licence Splash neither holds nor seeks',
  },
  {
    pattern: /e-money licen[cs]e/i,
    reason: 'a Phase 3 licence; naming it now reads as a promise',
  },
  {
    pattern: /\baudited\b/i,
    allow: /sourceUrl|source:/i,
    reason: 'nothing has been audited; the word is allowed only beside the source that says so',
  },
  {
    pattern: /\bearns\b|T-bill rate|yield accrual/i,
    allow: /projection|projected|variable|illustrative/i,
    reason: 'yield copy is a labelled projection at a variable rate, never something a balance "earns"',
  },
];

/** @type {CopyRule[]} */
export const MARKETING_JARGON = [
  { pattern: /\bWalrus\b/, reason: 'protocol jargon on a marketing route: a customer buys a payment record, not a storage network' },
  { pattern: /\bSeal\b/, reason: 'protocol jargon on a marketing route: say "encrypted", not the name of the key server' },
  { pattern: /\bPTBs?\b/, reason: 'protocol jargon on a marketing route: a programmable transaction block is our implementation, not their product' },
  { pattern: /payment intent/i, reason: 'protocol jargon on a marketing route: the customer sends a payment; the intent object is ours' },
  { pattern: /audit spine/i, reason: 'protocol jargon on a marketing route: say "the record" or "the receipt"' },
  { pattern: /on-chain/i, reason: 'protocol jargon on a marketing route: say what it does — settled, recorded, final' },
  { pattern: /\battestation\b/i, reason: 'protocol jargon on a marketing route: say "record" or "proof"' },
];

const MARKETING =
  /^(?:app\/page\.tsx|app\/opengraph-image\.tsx|app\/(?:trust|working-capital)\/.*|components\/landing\/.*|components\/mobile\/.*|components\/IsometricLanding\.tsx|components\/compliance\/TrustCompliance\.tsx|content\/.*)$/;
// app/api/cron/ is operator plumbing: its refusal messages name the licence
// the treasury lacks, which is engineering, not a claim a customer reads.
const EXEMPT = /^(?:app\/admin\/|app\/api\/cron\/|components\/admin\/|lib\/|scripts\/|tests\/|docs\/|experiments\/|move\/)/;

/** @returns {'marketing' | 'customer' | 'exempt'} */
export function surfaceFor(relPath) {
  const path = relPath.replaceAll('\\', '/').replace(/^\.\//, '');
  if (EXEMPT.test(path)) return 'exempt';
  if (MARKETING.test(path)) return 'marketing';
  if (/^(?:app|components)\//.test(path)) return 'customer';
  return 'exempt';
}

/**
 * Every violation in one file's text, with the rule's reason.
 * @returns {Array<{ file: string, line: number, pattern: RegExp, reason: string, excerpt: string }>}
 */
export function copyViolations(relPath, text) {
  const path = relPath.replaceAll('\\', '/').replace(/^\.\//, '');
  const surface = surfaceFor(path);
  if (surface === 'exempt') return [];

  const rules = surface === 'marketing' ? [...CUSTOMER_RULES, ...MARKETING_JARGON] : CUSTOMER_RULES;
  const found = [];
  const lines = text.split(/\r?\n/);
  for (const rule of rules) {
    if (rule.exceptFiles?.includes(path)) continue;
    lines.forEach((line, index) => {
      if (!rule.pattern.test(line)) return;
      if (rule.allow && rule.allow.test(line)) return;
      found.push({ file: path, line: index + 1, pattern: rule.pattern, reason: rule.reason, excerpt: line.trim().slice(0, 100) });
    });
  }
  return found;
}

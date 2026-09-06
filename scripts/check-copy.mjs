import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const roots = ['app', 'components', 'content', 'lib'];
const allowedExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const banned = [
  /we don't hold user money/i,
  /do not hold user money/i,
  /non-custodial/i,
  /200\+ countries/i,
  /guaranteed rate/i,
  /Regulated in Singapore/i,
  /regulated account network/i,
  /5\.20%/i,
  /4\.8% APY/i,
  /4\.8%/i,
  /1\.4%/i,
  /0\.48s/i,
  /2:34/i,
  /8 corridors/i,
  /Sui network live/i,
  // Website-upgrade additions: gasless precision, yield honesty, status honesty.
  /everything is gasless/i,
  /\bzero fees\b/i,
  /same-day/i,
  /0\.6%/,
  /save 62%/i,
  /84,?600/,
  /mainnet (?:live|now)/i,
  // W9.6 claims pass: custody language beyond partner-of-record framing is
  // banned — licensed partners are the system of record for customer funds.
  /segregated custody/i,
  /never commingled/i,
  // Canned compliance VERDICTS. Two responders shipped a determination —
  // "KYB Tier 1 approved, AML clear, no sanctions flags" and "Compliance: all
  // clear" — asserted to every caller, including organisations with no KYB
  // case. Both ran on the path taken exactly when the real system was
  // unreachable, so the fabrication was the fallback.
  //
  // These match the VERDICT, not the subject: describing how screening works
  // is fine and still passes. Claiming an outcome the code did not read is
  // what is banned.
  /KYB Tier 1 approved/i,
  /AML[:\s]+(?:no flags|clear)/i,
  /no sanctions flags/i,
  /compliance:?\s*all clear/i,
  /no AML flags, no compliance issues/i,
];

// Reader-facing surfaces only: app/, components/, content/.
//
// Canon is that no partner is named until its agreement is signed. Four
// counterparties were named on the public /trust page as partners with
// roles of record, and one carried a 2-of-3 key-governance claim the
// codebase contradicts. A name in shipped copy is the claim, whatever the
// column beside it says.
//
// Not applied to lib/: an engineering note reasoning about a future cold
// multisig is design, not a claim, and Phase 7 builds a real 2-of-3
// OwnerCap. A guard that fights the work it is meant to protect gets
// weakened, so it stops at the surfaces a reader actually reads.
//
// SECURITY.md and STATUS.md keep the record of what was removed and why.
const claimSurfaceBanned = [
  /\bBitGo\b/i,
  /\bCoKeeps\b/i,
  /\bGambit\b/i,
  /\bHata\b/i,
  /Coins[.]ph/i,
  // The governance claim itself, independent of who is named beside it.
  /\b2[- ]?of[- ]?3\b/i,
];

// Fixed-APY guard: any "<number>% APY" must be immediately preceded by
// "Variable" (e.g. "Variable 4.1% APY") — a bare fixed figure is banned.
const apyPattern = /\b\d+(\.\d+)?\s*%\s*APY\b/gi;
function apyViolations(text) {
  const found = [];
  for (const match of text.matchAll(apyPattern)) {
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    if (!/variable\s*[·—-]?\s*$/i.test(before)) found.push(match[0]);
  }
  return found;
}

// New-arbitrary-hex guard (app|components only): raw hex literals outside
// this baseline fail CI. Extend deliberately — prefer styles/tokens.css vars.
const allowedHexes = new Set([
  // styles/tokens.css values (usable as literals where var() can't reach)
  '#f6f0ed', '#1f4452', '#326273', '#5c9ead', '#e39774', '#d9a441',
  '#ffffff', '#fbf7f5', '#e5dcd6', '#c9bdb5', '#2e7d6b', '#e4f1ed',
  '#b4690e', '#fbefdd', '#b3402f', '#f9e7e3', '#e7eef1', '#6b7c85', '#edeff0',
  // Baseline snapshot (2026-07-09) of hexes already shipped in app|components
  '#022b33', '#050505', '#073d49', '#0c3e48', '#0d6370', '#111827', '#145d6a',
  '#152138', '#1b2b4a', '#1b3a48', '#1f4350', '#234e5e', '#237284', '#254e5c',
  '#264e5b', '#2b3a67', '#2c5a6b', '#2c5f6f', '#4a8a99', '#4a8b99', '#4a8b9a',
  '#4f9c88', '#6e7781', '#6fb4a0', '#87919a', '#8b6418', '#8fa6d8', '#8fd7c7',
  '#9a4a2d', '#9a6f15', '#9b4e32', '#9d5f43', '#9f5839', '#a7d6df', '#b3881f',
  '#b65f3f', '#bfe6ee', '#c97a56', '#c99a2e', '#cd825f', '#cfe8e0', '#d8fff4',
  '#d9fff6', '#e0b05a', '#e7eef0', '#eaf6f1', '#eaf7f8', '#ede8e4', '#eef4f5',
  '#efc46f', '#f4efe4', '#f4f8fa', '#f8fcfd', '#ffd9c9', '#ffe6a4', '#fffaf6',
  '#fffdf9',
  // Google's brand mark, in components/auth/ZkLoginButton.tsx. These four are
  // fixed by Google's identity guidelines and are not Splash palette: they
  // cannot become tokens, because a token implies we may change them. Inline
  // rather than an <img> so the sign-in button needs no network request to
  // render, and listed here rather than exempting the file, so any OTHER
  // arbitrary hex added to it still fails.
  '#4285f4', '#34a853', '#fbbc05', '#ea4335',
]);
const hexPattern = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
function hexViolations(text) {
  const found = [];
  for (const match of text.matchAll(hexPattern)) {
    if (!allowedHexes.has(match[0].toLowerCase())) found.push(match[0]);
  }
  return found;
}

// Explorer links must never hardcode a digest/object id: any line mentioning
// suiscan/suivision alongside a long 0x literal fails. Dynamic templates
// (`.../tx/${digest}`) and env-fed <OnchainProof/> stay legal.
function explorerLiteralViolations(text) {
  const found = [];
  for (const line of text.split('\n')) {
    if (/suiscan|suivision/i.test(line) && /0x[0-9a-fA-F]{16,}/.test(line)) {
      found.push(line.trim().slice(0, 80));
    }
  }
  return found;
}

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (allowedExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

// W9.0 coral rule: #E39774 (and the --coral token) is brand accent only —
// 0xWal identity and marketing highlights. A line that pairs coral with
// risk/error/warning semantics is a state leak; states use the semantic
// tokens (--ok/--warn/--error/--pending/--info).
const coralRiskContext = /risk|error|danger|warn|blocked|failed|reject|halt|untrusted|review/i;
function coralRiskViolations(text) {
  const found = [];
  for (const line of text.split('\n')) {
    if (!/#E39774|var\(--coral\)/i.test(line)) continue;
    if (coralRiskContext.test(line)) found.push(line.trim().slice(0, 90));
  }
  return found;
}

const violations = [];

// W9.4 money-path guard: the trust panel's locked sentences must stay in
// content/money-path.ts verbatim — removal or paraphrase fails the build.
{
  const MONEY_PATH_FILE = 'content/money-path.ts';
  const REQUIRED_MONEY_PATH_LINES = [
    'Labuan FSA license in process. Splash is not yet a licensed money-services business.',
    'Splash orchestrates — we never hold your funds.',
  ];
  try {
    const moneyPath = await readFile(MONEY_PATH_FILE, 'utf8');
    for (const line of REQUIRED_MONEY_PATH_LINES) {
      if (!moneyPath.includes(line)) {
        violations.push(`${MONEY_PATH_FILE}: required locked sentence missing — "${line}" may not be removed or paraphrased`);
      }
    }
  } catch {
    violations.push(`${MONEY_PATH_FILE}: file missing — the money-path trust config is required (W9.4)`);
  }
}

for (const root of roots) {
  for (const file of await filesUnder(root)) {
    const text = await readFile(file, 'utf8');
    if (/(?:from|import)\s*\(?['"].*experiments[\\/]/.test(text)) {
      violations.push(`${relative('.', file)}: imports experiments into production code`);
    }
    for (const pattern of banned) {
      if (pattern.test(text)) violations.push(`${relative('.', file)}: ${pattern.source}`);
    }
    for (const apy of apyViolations(text)) {
      violations.push(`${relative('.', file)}: fixed APY figure "${apy}" — yield copy must be prefixed with "Variable"`);
    }
    if (root === 'app' || root === 'components' || root === 'content') {
      for (const pattern of claimSurfaceBanned) {
        if (pattern.test(text)) {
          violations.push(`${relative('.', file)}: names an unsigned counterparty or asserts key governance — ${pattern.source}`);
        }
      }
    }
    if (root === 'app' || root === 'components') {
      for (const hex of hexViolations(text)) {
        violations.push(`${relative('.', file)}: new arbitrary hex ${hex} — use styles/tokens.css variables or extend the baseline deliberately`);
      }
      for (const line of coralRiskViolations(text)) {
        violations.push(`${relative('.', file)}: coral used with risk/error semantics — coral is brand accent only; use --ok/--warn/--error/--pending/--info tokens (${line})`);
      }
    }
    for (const line of explorerLiteralViolations(text)) {
      violations.push(`${relative('.', file)}: hardcoded explorer digest — route proof links through components/proof/OnchainProof (${line})`);
    }
  }
}

// ── W2: no float math on money ─────────────────────────────────────────────
//
// A hard failure. `parseFloat('0.10')` is not 0.10, it is the nearest double,
// and a hundred of them sum to 9.999999999999998 — so a batch of a hundred
// ten-cent payouts reconciles a cent short against a ledger that used
// integers, silently and differently depending on row order. lib/money.ts is
// the exact path: parseMinor, formatMinor, applyRate, applyBps, divRound.
//
// Two refinements over the warning this replaces, both found by its own false
// positives once the migration started:
//
//   \b before the callee, because `Number(` matched inside `rateToNumber(`
//   and every other identifier ending in "Number".
//
//   comments skipped, because a comment explaining what the old float code
//   did is documentation, not arithmetic. Only // and /* */ opening lines are
//   skipped; a line of code with a trailing comment is still checked.
const moneyFloatViolations = [];
{
  const moneyRoots = ['lib/server', 'lib/fx'];
  const moneyFloatPattern =
    /\b(?:parseFloat|Number)\s*\(\s*[^)]*(?:amount|Amount|price|Price|fee|Fee|balance|Balance)/;
  for (const root of moneyRoots) {
    for (const file of await filesUnder(root)) {
      const text = await readFile(file, 'utf8');
      let line = 0;
      let inBlockComment = false;
      for (const raw of text.split('\n')) {
        line += 1;
        const trimmed = raw.trim();
        if (inBlockComment) { if (trimmed.includes('*/')) inBlockComment = false; continue; }
        if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlockComment = true; continue; }
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
        if (moneyFloatPattern.test(raw)) {
          moneyFloatViolations.push(
            `${relative('.', file)}:${line} float math on money — use lib/money.ts (bigint minor units)`,
          );
        }
      }
    }
  }
}
violations.push(...moneyFloatViolations);


// USD-first stance: "stablecoin" is fine as a settlement mechanism but must
// never be the headline value in customer-facing components. Flag drift so
// it stays visible; do not fail the build.
const warnings = [];
for (const file of await filesUnder('components')) {
  const text = await readFile(file, 'utf8');
  const total = (text.match(/stablecoin/gi) ?? []).length;
  // Ignore code, not copy: camelCase/Pascal identifiers (StablecoinAsset,
  // stablecoinAssets), property access (.stablecoin…), and the quoted
  // discriminant ('stablecoin'). Flag only standalone prose mentions.
  const identifiers = (text.match(/[.'"]stablecoin|stablecoin[A-Za-z]|Stablecoin/g) ?? []).length;
  const prose = total - identifiers;
  if (prose > 0) warnings.push(`${relative('.', file)}: ${prose} "stablecoin" mention(s) in a component — prefer USD-first copy (settlement mechanic only).`);
}

if (warnings.length > 0) {
  console.warn('⚠ Copy warnings (non-fatal):\n' + warnings.join('\n') + '\n');
}

if (violations.length > 0) {
  console.error('Banned compliance copy found:\n' + violations.join('\n'));
  process.exit(1);
}

console.log('Compliance copy check passed.');

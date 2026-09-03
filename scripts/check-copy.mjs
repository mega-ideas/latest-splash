import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const roots = ['app', 'components', 'lib', 'content'];
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

// ── Unsigned-counterparty guard (A-23) ────────────────────────────────────
// Canon: no partner is named on a customer-facing surface before signature.
// Deliberately PATH-SCOPED to customer-facing roots, because the same strings
// are legitimate elsewhere: `'HATA'` is a live provider union member in
// lib/server/operations.ts, `venue:hata:clearing` is an arbitrary ledger
// account string in tests, and SECURITY.md/STATUS.md record the original
// audit finding on purpose. Scrubbing those would destroy real history.
const claimRoots = ['app', 'components', 'content'];
const unsignedCounterparties = [
  /\bBitGo\b/i,
  /CoKeeps/i,
  /\bGambit\b/i,
  /Hata\s+Global/i,
  /Coins[.]ph/i,
];
// The 2-of-3 governance claim: docs/KEY-POLICY.md lists it as a TARGET and its
// own Gap Log says AdminCap is still a single capability. Asserting it as a
// control in force is a claims defect wherever a customer can read it.
const unearnedGovernance = /\b2[- ]?of[- ]?3\b/i;

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
    if (claimRoots.includes(root)) {
      for (const pattern of unsignedCounterparties) {
        if (pattern.test(text)) {
          violations.push(`${relative('.', file)}: names an unsigned counterparty (${pattern.source}) — canon is partners unnamed until signed`);
        }
      }
      if (unearnedGovernance.test(text)) {
        violations.push(`${relative('.', file)}: claims 2-of-3 key governance — docs/KEY-POLICY.md lists this as a target, and its Gap Log says AdminCap is still a single capability`);
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

// ── Soft warnings (non-fatal) ──────────────────────────────────────────────
// W2 pre-work: float math on money is the debt mainnet cannot carry. Until
// the W2 sweep lands (bigint minor units via lib/money/), WARN on every
// parseFloat/Number(...) touching an amount-named identifier in the money
// paths so no NEW debt lands unnoticed. W2 flips this to a hard failure.
const moneyFloatWarnings = [];
{
  const moneyRoots = ['lib/server', 'lib/fx'];
  const moneyFloatPattern = /(?:parseFloat|Number)\s*\(\s*[^)]*(?:amount|Amount|price|Price|fee|Fee|balance|Balance)/;
  for (const root of moneyRoots) {
    for (const file of await filesUnder(root)) {
      const text = await readFile(file, 'utf8');
      let line = 0;
      for (const raw of text.split('\n')) {
        line += 1;
        if (moneyFloatPattern.test(raw)) {
          moneyFloatWarnings.push(`${relative('.', file)}:${line} float math on a money identifier — migrate to bigint minor units (W2)`);
        }
      }
    }
  }
}
if (moneyFloatWarnings.length > 0) {
  console.warn(`⚠ W2 debt (non-fatal, ${moneyFloatWarnings.length} site(s)):\n` + moneyFloatWarnings.join('\n') + '\n');
}

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

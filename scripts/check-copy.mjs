import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

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

// ── Forbidden claims (v3 canon, docs/claims-audit.md) ─────────────────────
// Roadmap capabilities may never read as live in customer copy; "guaranteed"
// and unfootnoted "instant" are banned; Splash is never "licensed"; the MFCA
// is never a licence. Comment lines are skipped (they are not copy) except
// for the MFCA rule, which is absolute. Each rule carries allow-patterns for
// the legitimate forms (negations, roadmap framing, identifiers).
const ROADMAP_FRAMING =
  /roadmap|subject to licensing|coming capability|planned capability|when the e-money licen[cs]e|phase [12]\b|not live|not a live|offset(?:ting)? (?:model|opportunit)|modeled offset|projection/i;

const forbiddenClaims = [
  {
    id: 'live-capability',
    pattern: /\b(nets|netting|yields|yielding|escrows?|escrowing|discounting)\b/i,
    allow: [
      ROADMAP_FRAMING,
      /market\/yields/,
      /US Treasury yields/i,
      /'NETTING'|NETTING_SETTLE|realized_netting|model\.netting|\bnetting[A-Z]/,
      /^\s*(?:import|export type|type |const OUTBOUND|test: \/)/,
    ],
    message: 'presents a roadmap capability (yield / escrow / netting / discounting) as live — reframe as roadmap or remove',
  },
  {
    id: 'guaranteed',
    pattern: /\bguarantee[ds]?\b/i,
    allow: [
      /\b(?:not|no|never|nothing is|isn't|is not|are not|aren't)\s+(?:a\s+)?(?:cryptographic\s+)?guarantee/i,
      /not guaranteed|never guaranteed/i,
      /"guaranteed"/,
    ],
    message: '"guaranteed" is banned in customer copy (a negation such as "not guaranteed" is fine)',
  },
  {
    id: 'instant',
    pattern: /\binstant(?:ly)?\b/i,
    allow: [
      /illustrative|not instant/i,
      /\binstant\s*[:?]|\.instant\b|instant:\s*(?:true|false)|"instant"|'instant'/,
    ],
    message: '"instant" needs an illustrative footnote or a concrete replacement ("in minutes", "no notice period", "on settlement")',
  },
  {
    id: 'licensed-splash',
    pattern: /Splash is (?:a |an )?(?:fully |now )?licen[cs]ed|licen[cs]ed by (?:the )?(?:Labuan|BNM|BSP|MAS)|Splash holds (?:a|an|its) (?:own )?licen[cs]e/i,
    allow: [/not yet a licensed|not yet licensed|is not a licensed/i],
    message: 'Splash may never be described as licensed',
  },
  {
    id: 'mfca-licence',
    pattern: /MFCA\s+licen[cs]e|licen[cs]e\s+\(?MFCA|under the (?:Labuan )?MFCA licen[cs]e/i,
    allow: [],
    includeComments: true,
    message: 'the MFCA is never a licence — say "MFCA activation" / "no customer funds until MFCA activation"',
  },
];

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|\{\/\*)/;
// Regex literals match the user's own words; they are never rendered.
const REGEX_LITERAL_LINE = /^\s*(?:test|pattern|keywords?):\s*\//;

// Surfaces that are roadmap-framed end to end (RoadmapChip in the hero, the
// "coming capability, subject to licensing" legal line, future tense
// throughout). The live-capability rule does not apply inside them; the
// framing is asserted by the components themselves.
const roadmapFramedPaths = ['app/working-capital/', 'components/supply/'];

function forbiddenClaimViolations(text, relPath) {
  const found = [];
  const lines = text.split('\n');
  const roadmapFramed = roadmapFramedPaths.some((prefix) => relPath.startsWith(prefix));
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const isComment = COMMENT_LINE.test(line);
    if (REGEX_LITERAL_LINE.test(line)) continue;
    for (const rule of forbiddenClaims) {
      if (isComment && !rule.includeComments) continue;
      if (rule.id === 'live-capability' && roadmapFramed) continue;
      if (!rule.pattern.test(line)) continue;
      if (rule.allow.some((allow) => allow.test(line))) continue;
      found.push(`${index + 1}: [${rule.id}] ${rule.message} — ${line.trim().slice(0, 100)}`);
    }
  }
  return found;
}

// ── Palette v2 (docs/design-system.md §1.1) ───────────────────────────────
// Raw hex literals in app|components must come from Palette v2. The v1
// palette (#E39774 coral, #1F4452 ink, #F6F0ED paper, #6FB4A0 mint, and the
// landing's local teal/gold family) is retired from UI and allowed ONLY under
// components/illustrations/. Files that still carry v1 hexes are listed in
// `legacyHexAllowances` and shrink to nothing as each surface migrates; a NEW
// file, or a new v1 hex in an old file, fails here.
const paletteV2 = new Set([
  '#0b2a33', '#163f4a', '#1f7a8c', '#2e96a8', '#5c9ead', '#dceef1',
  '#f7f8f7', '#ffffff', '#eef3f4', '#4a5c64', '#59686f', '#16606e', '#157056', '#8a5809', '#dce3e6', '#e8edef',
  '#1e8f6e', '#ddf3ea', '#b9770e', '#fbefd9', '#b93a32', '#fae3e1',
  // dark mode
  '#071c22', '#0f2c35', '#153845', '#e6eef0', '#9bb0b7', '#7fcbd9', '#5fd3a8', '#e8b04b', '#f08a82',
]);

const illustrationPalette = new Set([
  '#e39774', '#1f4452', '#f6f0ed', '#6fb4a0', '#326273', '#d9a441', '#6b7a83',
  '#0c3e48', '#0d6370', '#083640', '#9fcfc7', '#efc46f', '#c49646', '#fffaf4', '#f8f0e5',
]);

const legacyHexAllowances = {
  'app/admin/(console)/layout.tsx': ['#1f4350', '#326273', '#a7d6df', '#e7eef0', '#eef4f5'],
  'app/admin/(console)/page.tsx': ['#1f4350', '#326273', '#4a8b9a', '#e39774', '#f6f0ed'],
  'app/admin/(console)/transactions/page.tsx': ['#1f4350', '#326273', '#9b4e32', '#e39774', '#f6f0ed'],
  'app/api/funding/sessions/route.ts': ['#0c3e48', '#f6f0ed'],
  'app/dashboard/copilot/page.tsx': ['#0c3e48', '#0d6370', '#1f4452', '#264e5b', '#326273', '#c97a56', '#e39774', '#efc46f', '#f6f0ed'],
  'app/dashboard/customer-service/page.tsx': ['#264e5b', '#326273', '#e39774', '#f6f0ed'],
  'app/dashboard/history/page.tsx': ['#264e5b', '#326273', '#e39774', '#f6f0ed'],
  'app/dashboard/overview/page.tsx': ['#0c3e48', '#1f4452', '#326273', '#4a8a99', '#9a6f15', '#d9a441', '#e39774', '#ede8e4', '#f6f0ed'],
  'app/dashboard/profile/page.tsx': ['#0d6370', '#1f4452', '#264e5b', '#326273', '#9b4e32', '#e39774', '#f6f0ed'],
  'app/dashboard/transfers/page.tsx': ['#326273', '#cd825f', '#e39774'],
  'app/layout.tsx': ['#326273'],
  'app/opengraph-image.tsx': ['#1f4452', '#326273', '#d9a441', '#e5dcd6', '#f6f0ed', '#fbf7f5'],
  'app/providers.tsx': ['#326273', '#f6f0ed'],
  'app/queue/page.tsx': ['#1f4452', '#326273', '#f6f0ed'],
  'app/settings/kyb/page.tsx': ['#326273'],
  'components/DashboardHeader.tsx': ['#1f4452', '#326273', '#e39774', '#f6f0ed'],
  'components/HoverPopup.tsx': ['#326273'],
  'components/KybSettings.tsx': ['#326273', '#cd825f', '#e39774', '#f6f0ed'],
  'components/LiveExchangeTicker.tsx': ['#326273', '#e39774'],
  'components/StatusBadge.tsx': ['#9a6f15', '#d9a441', '#e39774'],
  'components/admin/AdminKybConsole.tsx': ['#1f4350', '#254e5c', '#326273', '#4a8b99', '#9d5f43', '#e39774', '#f6f0ed'],
  'components/admin/AdminLogoutButton.tsx': ['#326273', '#e39774'],
  'components/admin/AdminProfileRequests.tsx': ['#0d6370', '#1f4452', '#326273', '#9b4e32', '#e39774', '#eef4f5', '#f6f0ed'],
  'components/admin/AdminSupportConsole.tsx': ['#1f4350', '#254e5c', '#326273', '#4a8b99', '#cd825f', '#e39774', '#f6f0ed'],
  'components/admin/ComplianceControlForm.tsx': ['#1f4350', '#326273'],
  'components/admin/ContractConfigForm.tsx': ['#1f4350', '#326273', '#f6f0ed'],
  'components/compliance/MoneyPathPanel.tsx': ['#1f4452', '#326273', '#f6f0ed'],
  'components/dashboard/DashPageHeader.tsx': ['#326273'],
  'components/dashboard/DashStat.tsx': ['#0c3e48', '#326273'],
  'components/dashboard/QuickLinksCard.tsx': ['#326273'],
  'components/funding/FundingSelector.tsx': ['#0c3e48', '#326273', '#9f5839', '#bfe6ee', '#e39774', '#eaf7f8', '#f6f0ed', '#f8fcfd'],
  'components/invoices/InvoiceLoop.tsx': ['#0c3e48', '#145d6a', '#1f4452', '#326273', '#6fb4a0', '#8b6418', '#9f5839', '#bfe6ee', '#cd825f', '#d8fff4', '#d9a441', '#e39774', '#f6f0ed', '#f8fcfd', '#ffe6a4'],
  'components/queue/ApprovalQueueBoard.tsx': ['#1f4452', '#326273'],
};

const hexPattern = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-fA-F])/g;
function hexViolations(text, relPath) {
  const found = [];
  const legacy = new Set(legacyHexAllowances[relPath] ?? []);
  const isIllustration = relPath.startsWith('components/illustrations/');
  for (const match of text.matchAll(hexPattern)) {
    const hex = match[0].toLowerCase();
    if (paletteV2.has(hex)) continue;
    if (isIllustration && illustrationPalette.has(hex)) continue;
    if (legacy.has(hex)) continue;
    found.push(match[0]);
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

function posix(file) {
  return relative('.', file).split(sep).join('/');
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

// /trust must carry the not-yet-licensed sentence, rendered by the component
// so no page can crop it away.
{
  const TRUST_FILE = 'components/compliance/TrustCompliance.tsx';
  const REQUIRED_TRUST_SENTENCE = 'Splash is not yet a licensed money-services business.';
  try {
    const trust = await readFile(TRUST_FILE, 'utf8');
    if (!trust.includes(REQUIRED_TRUST_SENTENCE)) {
      violations.push(`${TRUST_FILE}: required sentence missing — "${REQUIRED_TRUST_SENTENCE}"`);
    }
  } catch {
    violations.push(`${TRUST_FILE}: file missing — the trust page body is required`);
  }
}

for (const root of roots) {
  for (const file of await filesUnder(root)) {
    const text = await readFile(file, 'utf8');
    const relPath = posix(file);
    if (/(?:from|import)\s*\(?['"].*experiments[\\/]/.test(text)) {
      violations.push(`${relPath}: imports experiments into production code`);
    }
    for (const pattern of banned) {
      if (pattern.test(text)) violations.push(`${relPath}: ${pattern.source}`);
    }
    for (const apy of apyViolations(text)) {
      violations.push(`${relPath}: fixed APY figure "${apy}" — yield copy must be prefixed with "Variable"`);
    }
    for (const claim of forbiddenClaimViolations(text, relPath)) {
      violations.push(`${relPath}:${claim}`);
    }
    if (root === 'app' || root === 'components') {
      for (const hex of hexViolations(text, relPath)) {
        violations.push(`${relPath}: hex ${hex} is not in Palette v2 — use styles/tokens.css variables (retired v1 hexes are allowed only under components/illustrations/)`);
      }
      for (const line of coralRiskViolations(text)) {
        violations.push(`${relPath}: coral used with risk/error semantics — coral is brand accent only; use --ok/--warn/--error/--pending/--info tokens (${line})`);
      }
    }
    for (const line of explorerLiteralViolations(text)) {
      violations.push(`${relPath}: hardcoded explorer digest — route proof links through components/proof/OnchainProof (${line})`);
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
          moneyFloatWarnings.push(`${posix(file)}:${line} float math on a money identifier — migrate to bigint minor units (W2)`);
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
  if (prose > 0) warnings.push(`${posix(file)}: ${prose} "stablecoin" mention(s) in a component — prefer USD-first copy (settlement mechanic only).`);
}

if (warnings.length > 0) {
  console.warn('⚠ Copy warnings (non-fatal):\n' + warnings.join('\n') + '\n');
}

if (violations.length > 0) {
  console.error('Banned compliance copy found:\n' + violations.join('\n'));
  process.exit(1);
}

console.log('Compliance copy check passed.');

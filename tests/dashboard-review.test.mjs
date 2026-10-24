import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

/**
 * v2 Phase 3, the review of brief 5.1. Each test is one finding:
 *
 * - the "Sui mainnet" labels follow the configured network;
 * - Zeke and the approval copy name pages that still exist, and say
 *   "sample" where they said "demo";
 * - failure states use the error and warning tokens, never the gold that
 *   replaced coral as a brand accent;
 * - the phone drawer is modal: nothing outside it can be clicked, and it
 *   closes (and lets the page scroll) when the window grows past 768px or
 *   the route changes;
 * - quote holds stay reachable from Transfer, and Treasury does not say it
 *   is closed for a licence while the nav calls it open;
 * - the smaller ones: a destructive confirm with a hover state, no seeded
 *   invoice id on a Zeke starter, Wallet titled Wallet, Zeke's handoff
 *   pointing at /dashboard/wallet, and no background grid outside the
 *   landing's Platform section.
 */

const ROOT = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, ROOT), 'utf8');

async function filesUnder(dir, pattern) {
  const out = [];
  for (const name of await readdir(new URL(dir, ROOT))) {
    const path = `${dir}/${name}`;
    if ((await stat(new URL(path, ROOT))).isDirectory()) out.push(...(await filesUnder(path, pattern)));
    else if (pattern.test(name)) out.push(path);
  }
  return out;
}

/* ── The network label ─────────────────────────────────────────────── */

test('the short network label says mainnet only when the client is configured for mainnet', async () => {
  const { networkChip } = await import('../lib/network-label.ts');
  const saved = { server: process.env.SUI_NETWORK, client: process.env.NEXT_PUBLIC_SUI_NETWORK };
  try {
    delete process.env.NEXT_PUBLIC_SUI_NETWORK;
    delete process.env.SUI_NETWORK;
    assert.deepEqual(networkChip(), { label: 'Sui sandbox', live: false }, 'unset is the sandbox, as lib/env.ts defaults');

    process.env.NEXT_PUBLIC_SUI_NETWORK = 'testnet';
    assert.deepEqual(networkChip(), { label: 'Sui sandbox', live: false });
    assert.doesNotMatch(networkChip().label, /testnet/i, 'the banned word stays off customer surfaces');

    // The server-only variable never reaches the browser bundle, so reading
    // it here would render one label on the server and another on hydration.
    process.env.SUI_NETWORK = 'mainnet';
    assert.deepEqual(networkChip(), { label: 'Sui sandbox', live: false });

    process.env.NEXT_PUBLIC_SUI_NETWORK = 'mainnet';
    assert.deepEqual(networkChip(), { label: 'Sui mainnet', live: true });
  } finally {
    for (const [key, value] of [['SUI_NETWORK', saved.server], ['NEXT_PUBLIC_SUI_NETWORK', saved.client]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('the rail chip and the Zeke composer tag come from the configured network', async () => {
  const shell = await source('components/dashboard/DashboardShell.tsx');
  assert.match(shell, /networkChip\(\)/);
  assert.doesNotMatch(shell, />\s*Sui mainnet\s*</, 'no hard-coded mainnet claim on the rail');
  // The green "ok" dot only beside a live network.
  assert.match(shell, /network\.live \?[^:]*--ok/);

  const composer = await source('components/oxwal/OxWalComposer.tsx');
  assert.doesNotMatch(composer, /deskTag = 'Sui mainnet'/);
  assert.match(composer, /networkChip\(\)\.label/);
});

/* ── Zeke and the approval copy ────────────────────────────────────── */

const AGENT_FILES = ['lib/agent/oxwal.ts', 'lib/agent/usdc-handoff.ts', 'lib/agent/x402.ts'];

/** The words a person reads: string and template literals, not comments,
 *  type names or enum values such as 'DEMO' and CONTAINS_DEMO_DATA. */
function sentences(text) {
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const literals = withoutComments.match(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g) ?? [];
  // A sentence has a space in it; an id or an enum value does not.
  return literals.filter((literal) => /\s/.test(literal));
}

test('Zeke names pages that exist and says "sample", not "demo"', async () => {
  const banned = /\bdemo\b|\bDEMO\b|Rate holds|Send USDC page|in Send USDC|Overview( and| page)/;
  const found = [];
  for (const file of AGENT_FILES) {
    for (const sentence of sentences(await source(file))) {
      if (banned.test(sentence)) found.push(`${file}: ${sentence.slice(0, 140)}`);
    }
  }
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n`);
});

test('asked how to hold a rate, Zeke points at Transfer’s review step', async () => {
  const oxwal = await source('lib/agent/oxwal.ts');
  assert.match(oxwal, /hold a rate for 48 hours from Transfer/);
  // The system prompt tells the model what to call non-live data.
  assert.match(oxwal, /say it is sample or modeled data/);
});

test('the approval and invoice copy send people to Wallet, not Send USDC', async () => {
  const approval = await source('components/approvals/ApprovalFlow.tsx');
  assert.doesNotMatch(approval, /Send USDC page/);
  assert.match(approval, /in their Wallet/);

  const invoice = await source('components/invoices/InvoiceLoop.tsx');
  assert.doesNotMatch(invoice, /'LAUNCH_SCOPE' \? 'Send USDC'/, 'the button opens Wallet, so it says so');
  assert.match(invoice, /'LAUNCH_SCOPE' \? 'Open Wallet'/);

  for (const file of ['components/transfer/StepDelivery.tsx', 'lib/server/quote.ts']) {
    assert.doesNotMatch(await source(file), /use Send USDC/, `${file} names the removed page`);
  }
});

test('an evidence chip reads Sample, never DEMO', async () => {
  const { buildActionCardModel } = await import('../lib/agent/action-card.ts');
  const model = buildActionCardModel({
    id: 'p1',
    status: 'PROPOSED',
    approvals: [],
    explain: {
      financialImpact: null,
      requiredApprovers: 1,
      confidence: null,
      evidence: [
        { source: 'fixture.balances', ref: 'b1', trusted: true, status: 'DEMO' },
        { source: 'ledger', ref: 'l1', trusted: true, status: 'LIVE' },
      ],
    },
  });
  assert.deepEqual(model.evidenceRows.map((row) => row.statusText), ['Sample', 'Live']);
  const card = await source('components/oxwal/ActionCard.tsx');
  assert.match(card, /\{item\.statusText\}/);
  assert.doesNotMatch(card, /\{item\.statusLabel\}/);
});

/* ── Failure is not a brand accent ─────────────────────────────────── */

const GOLD = /--gold-(ink|tint|light)|#8b6418|#efc46f|#fdf3dc|#7a5410/i;
const FAILURE = /XCircle|CircleX|CircleAlert|AlertCircle|AlertTriangle|TriangleAlert|\berror\b|Error\b|[Ff]ailed|Not screened|QUARANTINED/;

test('a failure, an error or an unscreened state never takes the gold accent', async () => {
  const files = [
    ...(await filesUnder('app', /\.tsx$/)),
    ...(await filesUnder('components', /\.tsx$/)),
  ].filter((file) => !/^components\/(landing|mobile|supply)\/|IsometricLanding|working-capital/.test(file));
  const found = [];
  for (const file of files) {
    const lines = (await source(file)).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!GOLD.test(line)) return;
      // The failure word may sit on this line or open the element just above.
      const window = lines.slice(Math.max(0, index - 3), index + 2).join('\n');
      if (FAILURE.test(window)) found.push(`${file}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(found, [], `\n  ${found.join('\n  ')}\n`);
});

test('the named failure states use --error, and attention states --warn', async () => {
  const proof = await source('components/SettlementProofDrawer.tsx');
  assert.doesNotMatch(proof, GOLD, 'a proof that did not verify is an error, not a highlight');
  assert.match(proof, /XCircle className="h-4 w-4 text-\[var\(--error\)\]"/);

  const step = await source('components/transfer/StepBeneficiary.tsx');
  assert.match(step, /recipientError \? \(\s*<div[^>]*--error-bg/);

  const recipients = await source('app/dashboard/recipients/page.tsx');
  assert.match(recipients, /screeningVerdict === 'ERROR'\s*\?\s*'[^']*--error-bg/, 'Screening failed is an error');
  assert.match(recipients, /--warn-bg[^']*'\s*}`\}>\s*\{r\.screeningVerdict === 'CLEAR'/, 'Not screened needs attention');
});

/* ── The phone drawer ──────────────────────────────────────────────── */

test('nothing outside the phone drawer can be used while it is open', async () => {
  const shell = await source('components/dashboard/DashboardShell.tsx');
  // The floating Zeke sat above the scrim, clickable beside Log out.
  assert.match(shell, /<div inert=\{mobileOpen\}[^>]*>\s*<FloatingCopilot \/>/);
  assert.match(shell, /<main[^>]*\binert=\{mobileOpen\}/);
});

test('the drawer closes when the window grows past the phone layout or the page changes', async () => {
  const shell = await source('components/dashboard/DashboardShell.tsx');
  assert.match(shell, /matchMedia\('\(min-width: 768px\)'\)/);
  // Open is tied to the page it was opened on, so back and forward close it
  // without an effect that sets state.
  assert.match(shell, /const mobileOpen = openOn === pathname/);
});

/* ── Quote holds and Treasury ──────────────────────────────────────── */

test('active quote holds are listed on Transfer, newest first, expired ones left out', async () => {
  const { activeRateHolds, holdTimeLeft } = await import('../lib/dashboard/rate-holds.ts');
  const now = Date.parse('2026-10-25T12:00:00Z');
  const hold = (id, state, holdUntil, createdAt) => ({ id, corridorCurrency: 'PHP', rate: '56.4', state, holdUntil, createdAt });
  const holds = [
    hold('old', 'ACTIVE', '2026-10-26T10:00:00Z', '2026-10-24T10:00:00Z'),
    hold('new', 'ACTIVE', '2026-10-27T11:00:00Z', '2026-10-25T11:00:00Z'),
    hold('lapsed', 'ACTIVE', '2026-10-25T11:59:59Z', '2026-10-23T11:59:59Z'),
    hold('used', 'EXECUTED', '2026-10-27T00:00:00Z', '2026-10-25T00:00:00Z'),
  ];
  assert.deepEqual(activeRateHolds(holds, now).map((h) => h.id), ['new', 'old']);
  assert.equal(holdTimeLeft('2026-10-26T10:30:00Z', now), '22h 30m');
  assert.equal(holdTimeLeft('2026-10-25T12:00:30Z', now), 'under a minute');

  const page = await source('app/dashboard/transfer/page.tsx');
  assert.match(page, /fetch\('\/api\/rate-holds'\)/, 'the org-scoped list the old page read');
  assert.match(page, /<ActiveRateHolds/);
});

test('Treasury does not say it is waiting for a licence while the nav opens it', async () => {
  const treasury = await source('app/dashboard/treasury/page.tsx');
  assert.doesNotMatch(treasury, /licen[cs]e/i);
});

/* ── The smaller findings ──────────────────────────────────────────── */

test('cancelling a Treasury withdrawal is an error-toned button that reacts to hover', async () => {
  const treasury = await source('app/dashboard/treasury/page.tsx');
  const button = treasury.slice(treasury.lastIndexOf('className', treasury.indexOf("'Yes, cancel'")), treasury.indexOf("'Yes, cancel'"));
  assert.match(button, /bg-\[var\(--error\)\]/);
  assert.match(button, /hover:brightness-90/);
});

test('the shell and header use tokens, not a peach hover or the old gold ink', async () => {
  assert.doesNotMatch(await source('components/DashboardHeader.tsx'), /orange-50/);
  assert.doesNotMatch(await source('components/dashboard/DashboardShell.tsx'), /#8b6418/i);
});

test('no Zeke starter sends a seeded invoice id', async () => {
  const zeke = await source('app/dashboard/zeke/page.tsx');
  assert.doesNotMatch(zeke, /inv_demo|cp_acme/);
  assert.match(zeke, /Review my latest invoice/);
});

test('the Wallet page is titled Wallet, and the unused sidebar signal CSS is gone', async () => {
  const desk = await source('components/stablecoin/SendUsdcDesk.tsx');
  assert.doesNotMatch(desk, /title="Send USDC"/);
  assert.match(desk, /title="Wallet"/);
  assert.doesNotMatch(await source('app/globals.css'), /fintech-sidebar-signal/);
});

test('Zeke hands a USDC transfer to /dashboard/wallet, and both allowlists accept it', async () => {
  assert.match(await source('lib/agent/usdc-handoff.ts'), /href: `\/dashboard\/wallet\?\$\{params\.toString\(\)\}`/);
  assert.match(await source('components/oxwal/ThreadView.tsx'), /startsWith\('\/dashboard\/wallet\?'\)/);
  assert.match(await source('lib/agent/oxwal.ts'), /startsWith\('\/dashboard\/wallet\?'\)/);
});

test('no background grid on the sign-in pages, the operator login or the console (D14)', async () => {
  const css = await source('app/globals.css');
  for (const selector of ['.iso-auth-grid', '.iso-auth-visual::before', '.iso-auth-form-panel', '.admin-login-story', '.admin-login-form-wrap', '.fintech-admin-shell::before']) {
    let from = 0;
    while ((from = css.indexOf(`${selector} {`, from)) !== -1) {
      const rule = css.slice(from, css.indexOf('}', from));
      assert.doesNotMatch(rule, /1px, transparent 1px/, `${selector} draws a grid`);
      from += selector.length;
    }
  }
});

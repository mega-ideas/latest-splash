import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
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
  // "DEMO" in capitals is the truth envelope's status value, which the system
  // prompt has to name for the model to read tool results; what a person is
  // told it means is "sample" (asserted below), and no reply says DEMO label.
  const banned = /\b[Dd]emo\b|DEMO label|Rate holds|Send USDC page|in Send USDC|Overview( and| page)/;
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

  // v2 brief 5.8: the invoice loop (and its Wallet button) became Pay
  // invoices, which names no removed page either.
  const invoice = await source('components/invoices/PayInvoices.tsx');
  assert.doesNotMatch(invoice, /Send USDC/);

  for (const file of ['components/transfer/StepReview.tsx', 'lib/server/quote.ts']) {
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
      financialImpact: { amountIn: '100', currencyIn: 'USD', amountOut: null, currencyOut: null },
      requiredApprovers: 1,
      risk: 'LOW',
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
  const step = await source('components/transfer/StepReview.tsx');
  assert.match(step, /role="alert" className="flex items-start gap-2 rounded-xl border border-\[var\(--error\)\]\/40 bg-\[var\(--error-bg\)\]/, 'a quote that failed is an error');

  // The Recipients page words a recipient's state in lib/recipients-page/view.ts and draws it with the shared pill:
  // 'bad' is the error colour, 'wait' the warning one.
  const recipients = await source('lib/recipients-page/view.ts');
  assert.match(recipients, /verdict === 'ERROR'\s*\?\s*\{ step: 'screening', tone: 'bad'/, 'Screening failed is an error');
  assert.match(recipients, /step: 'screening', tone: 'wait', label: 'Screening not complete'/, 'Not screened needs attention');
  const pill = await source('components/wallet/parts.tsx');
  assert.match(pill, /bad: 'bg-\[var\(--error-bg\)\][^']*--error/);
  assert.match(pill, /wait: 'bg-\[var\(--warn-bg\)\]/);
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

test('a quote hold is shown where it is used, on the review', async () => {
  // The Rate holds page is gone (brief 5.1), and so is the list of holds that Transfer once drew; the hold is shown on the review, from the quote's own expiry.
  const review = await source('components/transfer/StepReview.tsx');
  assert.match(review, /Rate held for/);
  assert.match(review, /Get a new rate/);
});

test('Treasury does not say it is waiting for a licence while the nav opens it', async () => {
  const treasury = await source('app/dashboard/treasury/page.tsx');
  // The word, not the API code custody_not_licensed the page still reads.
  assert.doesNotMatch(treasury, /\blicen[cs]e\b/i);
});

/* ── The smaller findings ──────────────────────────────────────────── */

test('Treasury has no notice withdrawals to cancel: USDY is redeemed from the wallet (brief 5.7)', async () => {
  const treasury = await source('app/dashboard/treasury/page.tsx');
  assert.doesNotMatch(treasury, /'Yes, cancel'|Pending withdrawals|Withdraw on notice/);
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
  const page = await source('components/wallet/WalletPage.tsx');
  assert.doesNotMatch(page, /title="Send USDC"/);
  assert.match(page, /title="Wallet"/);
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

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { buildActionCardModel } from '../lib/agent/action-card.ts';

const now = '2026-07-01T00:00:00.000Z';

function sampleProposal(overrides = {}) {
  return {
    id: 'prop_frontend_1',
    kind: 'PAYMENT',
    status: 'PENDING_APPROVAL',
    tier: 'TIER_0_PROPOSE',
    orgId: 'demo-business',
    corridor: 'MY_PH',
    unsignedTxBytes: 'dW5zaWduZWQ=',
    createdBy: 'OXWAL',
    createdAt: now,
    expiresAt: '2026-07-01T00:15:00.000Z',
    approvals: [{ userId: 'approver-1', role: 'APPROVER', signedAt: now }],
    simulation: {
      ok: true,
      gasSponsored: true,
      simulatedAt: now,
      balanceChanges: [
        { owner: 'org_treasury', coinType: 'USDC', amount: '-5000000000' },
        { owner: 'cp_acme_ph', coinType: 'PHP', amount: '5000000000' },
      ],
    },
    explain: {
      recommendation: 'Prepare verified supplier payout',
      financialImpact: {
        amountOut: '5000000000',
        currencyOut: 'PHP',
        feeBps: 80,
        fxRate: { value: '56.4200', pythPriceId: 'pyth_usdc_usd', observedAt: now },
        nettingSaved: '125000',
      },
      evidence: [
        { source: 'COUNTERPARTY', ref: 'cp_acme_ph', observedAt: now, trusted: true },
        { source: 'INVOICE', ref: 'inv_demo_acme_5000', observedAt: now, trusted: false },
      ],
      confidence: 0.58,
      risk: 'HIGH',
      requiredApprovers: 2,
      reasoningTraceRef: 'walrus_reasoning_frontend',
    },
    ...overrides,
  };
}

test('ActionCard model exposes full proposal anatomy and trust treatment', () => {
  const model = buildActionCardModel(sampleProposal());

  assert.deepEqual(model.impactRows.map((row) => row.label), [
    'Amount in',
    'Amount out',
    'Fee',
    'FX',
    // The frontend is back on the original design, but lib/ was kept, and the
    // claims audit renamed these two so a roadmap capability cannot read as
    // live. Asserting the kept labels, not the retired ones.
    'Projected treasury delta',
    'Modeled offset saving (roadmap)',
  ]);
  assert.equal(model.simulationRows.some((row) => row.label === 'Dry-run' && row.value === 'Matched'), true);
  assert.equal(model.simulationRows.some((row) => row.label.includes('org_treasury')), true);
  assert.equal(model.evidenceRows.some((item) => item.trustLabel === 'Untrusted' && item.tone === 'untrusted'), true);
  assert.equal(model.confidencePercent, 58);
  assert.equal(model.riskTone, 'high');
  assert.equal(model.approverText, '1/2');
  assert.equal(model.primaryActionLabel, 'Sign & approve');
});

test('default dashboard is the streaming 0xWal surface and avoids browser money storage', async () => {
  const page = await readFile(new URL('../app/dashboard/page.tsx', import.meta.url), 'utf8');
  const layout = await readFile(new URL('../app/dashboard/layout.tsx', import.meta.url), 'utf8');
  const queue = await readFile(new URL('../app/queue/page.tsx', import.meta.url), 'utf8');
  const kybSettings = await readFile(new URL('../app/settings/kyb/page.tsx', import.meta.url), 'utf8');
  const forgotPassword = await readFile(new URL('../app/forgot-password/page.tsx', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../components/dashboard/DashboardShell.tsx', import.meta.url), 'utf8');

  assert.match(page, /fetch\('\/api\/oxwal'/);
  assert.match(page, /response\.body\.getReader\(\)/);
  assert.match(page, /<ActionCard key=\{proposal\.id\} proposal=\{proposal\}/);
  assert.match(page, /OxWalComposer/);
  assert.match(page, /What's on the agenda today\?/);
  assert.match(page, /href="\/queue"/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(layout, /export const dynamic = 'force-dynamic'/);
  // The layout must hand the server-resolved session to the shell and render
  // children through it. Matched by intent rather than exact JSX so adding a
  // prop (e.g. the KYB gate state) does not fail a test about the desk surface.
  assert.match(layout, /<DashboardShell[^>]*session=\{session\}/);
  assert.match(layout, /\{children\}<\/DashboardShell>/);
  assert.match(shell, /label: '0xWal',\s+href: '\/dashboard'/);
  assert.match(shell, /href: '\/dashboard\/overview'/);
  assert.match(queue, /export const dynamic = 'force-dynamic'/);
  assert.match(queue, /getCustomerSession/);
  assert.match(queue, /redirect\('\/login'\)/);
  assert.match(kybSettings, /export const dynamic = "force-dynamic"/);
  assert.match(kybSettings, /getCustomerSession/);
  assert.match(kybSettings, /redirect\("\/login"\)/);
  assert.match(forgotPassword, /fetch\('\/api\/auth\/recovery'/);
  assert.match(forgotPassword, /Recovery instructions ready/);
  assert.doesNotMatch(forgotPassword, /setTimeout|Reset link sent|Recovery email sent/);
});

test('ActionCard component names release-gate sections and warning accent', async () => {
  const source = await readFile(new URL('../components/oxwal/ActionCard.tsx', import.meta.url), 'utf8');
  for (const label of [
    'Impact table',
    'Simulation deltas',
    'Evidence',
    'Confidence',
    'Approvers',
    'Reasoning trace',
    'Sign & approve',
    'Send for approval',
    'Reject',
    'Untrusted data',
  ]) {
    assert.equal(source.includes(label), true, `${label} should render in ActionCard`);
  }
  // W9.0 coral rule: risk/warning states use semantic tokens; coral is brand
  // accent only and must NOT appear in ActionCard's state styling.
  assert.match(source, /var\(--warn\)/);
  assert.match(source, /var\(--error\)/);
  assert.doesNotMatch(source, /#E39774/);
});

test('landing keeps restored isometric shell with upgraded truth copy', async () => {
  const landing = await readFile(new URL('../components/IsometricLanding.tsx', import.meta.url), 'utf8');
  const cinematic = await readFile(new URL('../components/landing/SettlementCinematic.tsx', import.meta.url), 'utf8');
  const claims = await readFile(new URL('../content/claims.ts', import.meta.url), 'utf8');
  const copyCheck = await readFile(new URL('../scripts/check-copy.mjs', import.meta.url), 'utf8');
  const ogImage = await readFile(new URL('../app/opengraph-image.tsx', import.meta.url), 'utf8');
  const composer = await readFile(new URL('../components/oxwal/OxWalComposer.tsx', import.meta.url), 'utf8');
  const floating = await readFile(new URL('../components/FloatingCopilot.tsx', import.meta.url), 'utf8');
  // The invoice loop lives inside the Invoices page now (Inspection loop tab).
  const invoiceLoop = await readFile(new URL('../components/invoices/InvoiceLoop.tsx', import.meta.url), 'utf8');

  assert.match(claims, /headline: 'Collect USD\. Pay Southeast Asia\. Keep cash working\.'/);
  // Hero H1 lives in the cinematic hero (visually uppercased by .iso-display).
  assert.match(cinematic, /Move money\./);
  assert.match(cinematic, /Settle everything\./);
  // Hero art is the versioned district raster; bump the version, not the name.
  assert.match(cinematic, /hero-district-v\d+\.png/);
  assert.match(landing, /SettlementCinematic/);
  assert.match(landing, /Five steps\./);
  assert.match(landing, /Working-capital branch/);
  // Early Pay was promoted out of the #operations tool grid into the
  // dedicated roadmap-labeled #supply section (§4.D).
  assert.match(landing, /id="supply"/);
  assert.match(landing, /Your invoices are/);
  assert.doesNotMatch(landing, /Early Pay/);
  assert.match(landing, /One testnet corridor\. Modeled expansion routes\./);
  assert.match(landing, /claims\.footerLegal\.claim/);
  // Composer is now a payment-desk command bar (not a ChatGPT pill): no
  // "High" effort dropdown, a branded "Prepare" action, and a functional
  // file-attach that prepares a batch for human approval.
  assert.match(composer, /Prepare batch/);
  assert.match(composer, /onFilePrepared/);
  assert.doesNotMatch(composer, /priorityLabel|bg-black/);
  assert.match(floating, /OxWalComposer/);
  assert.match(invoiceLoop, /What should 0xWal inspect\?/);
  assert.match(claims, /footerLegal/);
  assert.match(copyCheck, /8 corridors/);
  assert.match(copyCheck, /Sui network live/);
  assert.match(ogImage, /ImageResponse/);
  assert.match(ogImage, /Kuala Lumpur/);
  assert.match(ogImage, /No customer funds/);
  assert.doesNotMatch(landing, /8 corridors|Reach every corridor|Sui network live|toFixed\(/);
});

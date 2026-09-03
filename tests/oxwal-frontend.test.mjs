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

test('the 0xWal desk is the streaming surface and avoids browser money storage', async () => {
  const page = await readFile(new URL('../app/dashboard/oxwal/page.tsx', import.meta.url), 'utf8');
  const layout = await readFile(new URL('../app/dashboard/layout.tsx', import.meta.url), 'utf8');
  const queue = await readFile(new URL('../app/queue/page.tsx', import.meta.url), 'utf8');
  const kybSettings = await readFile(new URL('../app/settings/kyb/page.tsx', import.meta.url), 'utf8');
  const forgotPassword = await readFile(new URL('../app/forgot-password/page.tsx', import.meta.url), 'utf8');
  const shell = await readFile(new URL('../components/dashboard/AppShell.tsx', import.meta.url), 'utf8');

  const client = await readFile(new URL('../lib/oxwal/stream-client.ts', import.meta.url), 'utf8');
  // The desk streams through the resumable client: POST starts a run, a
  // dropped read re-attaches by sequence number, and the page never talks
  // to the API directly.
  assert.match(page, /openOxwalStream/);
  assert.match(client, /'\/api\/oxwal'/);
  assert.match(client, /response\.body\.getReader\(\)/);
  assert.match(client, /\?after=\$\{lastSeq\}/);
  assert.match(page, /<ActionCard key=\{proposal\.id\} proposal=\{proposal\}/);
  assert.match(page, /OxWalComposer/);
  assert.match(page, /What's on the agenda today\?/);
  assert.match(page, /href="\/dashboard\/approvals"/);
  // Read-only in the thread: approval happens in Approvals through the one
  // real path, never from the chat.
  assert.doesNotMatch(page, /\/submit'/);
  assert.doesNotMatch(page, /localStorage|sessionStorage/);
  assert.match(layout, /export const dynamic = 'force-dynamic'/);
  // The layout must hand the server-resolved session to the shell and render
  // children through it. Matched by intent rather than exact JSX so adding a
  // prop (e.g. the KYB gate state) does not fail a test about the desk surface.
  assert.match(layout, /<AppShell[^>]*session=\{session\}/);
  assert.match(layout, /\{children\}<\/AppShell>/);
  // The clearance board is the first screen; the 0xWal desk lives at /dashboard/oxwal.
  assert.match(shell, /label: 'Clearance board', href: '\/dashboard'/);
  assert.match(shell, /label: brand\.agentName, href: '\/dashboard\/oxwal'/);
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

test('landing v2 renders the locked hero, one dark money-flow node, and truthful copy', async () => {
  const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');
  const hero = await read('../components/landing-v2/Hero.tsx');
  const moneyFlow = await read('../components/landing-v2/MoneyFlow.tsx');
  const trust = await read('../components/landing-v2/Trust.tsx');
  const roadmap = await read('../components/landing-v2/RoadmapTeaser.tsx');
  const milestones = await read('../lib/site/roadmap.ts');
  const corridors = await read('../components/landing-v2/Corridors.tsx');
  const landing = await read('../components/landing-v2/LandingV2.tsx');
  const page = await read('../app/page.tsx');
  const claims = await read('../content/claims.ts');
  const copyCheck = await read('../scripts/check-copy.mjs');
  const ogImage = await read('../app/opengraph-image.tsx');
  const composer = await read('../components/oxwal/OxWalComposer.tsx');
  const floating = await read('../components/oxwal/FloatingIndicator.tsx');
  const invoiceLoop = await read('../components/invoices/InvoiceLoop.tsx');

  // The home route renders landing v2; the isometric shell is retired.
  assert.match(page, /LandingV2/);
  assert.doesNotMatch(page, /IsometricLanding/);
  // Locked H1 (brief A3): corridor clause rendered as line two.
  assert.match(hero, /Send USD across Southeast Asia in minutes/);
  assert.match(hero, /starting with the Philippines and Indonesia/);
  assert.match(hero, /Open payment desk/);
  // Money-flow: exactly one dark card (the settlement node), the footnote, generic partners.
  assert.equal((moneyFlow.match(/bg-\[var\(--ink-900\)\]/g) ?? []).length, 1);
  assert.match(moneyFlow, /\*On-chain settlement ~400ms; total delivery time depends on local payout rails\. Illustrative — see pricing\./);
  assert.match(moneyFlow, /Legacy rails: 2–3 days/);
  assert.match(moneyFlow, /Splash: minutes, end to end\*/);
  assert.match(moneyFlow, /partnerLabel/);
  // Roadmap teaser renders the one shared milestone source, which always carries both.
  assert.match(roadmap, /lib\/site\/roadmap/);
  assert.match(milestones, /Mainnet publish · September 2026 \(protocol live, no customer funds\)/);
  assert.match(milestones, /First live corridor operations · October 2026, following MFCA activation/);
  // Trust: design claim, never a licence claim.
  assert.match(trust, /Regulator-ready by design/);
  assert.match(trust, /npm run check:core/);
  assert.doesNotMatch(trust, /Splash is licensed|fully licensed/);
  // Corridors: generic partner labels from the network profile, modeled expansion.
  assert.match(corridors, /Modeled expansion routes\./);
  assert.match(corridors, /getNetworkProfile/);
  // Section order and one responsive tree.
  assert.match(landing, /<Hero \/>[\s\S]*<MoneyFlow \/>[\s\S]*<Trust \/>[\s\S]*<RoadmapTeaser \/>/);
  assert.match(claims, /headline: 'Collect USD\. Pay Southeast Asia\. Keep cash working\.'/);
  assert.match(claims, /footerLegal/);
  // Composer is a payment-desk command bar with a functional file-attach.
  assert.match(composer, /Prepare batch/);
  assert.match(composer, /onFilePrepared/);
  assert.doesNotMatch(composer, /priorityLabel|bg-black/);
  // The floating indicator is a shortcut to the desk, not a second chat.
  assert.match(floating, /ChatComposer/);
  assert.match(floating, /\/dashboard\/oxwal\?prompt=/);
  assert.match(floating, /role="dialog"/);
  assert.match(invoiceLoop, /What should 0xWal inspect\?/);
  assert.match(copyCheck, /8 corridors/);
  assert.match(copyCheck, /Sui network live/);
  assert.match(ogImage, /ImageResponse/);
  assert.match(ogImage, /Kuala Lumpur/);
  assert.match(ogImage, /No customer funds/);
});

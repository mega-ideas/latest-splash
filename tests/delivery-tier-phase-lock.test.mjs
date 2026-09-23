import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The transfer form offered a delivery the next step refuses.
 *
 * StepDelivery never locked SWEEP_ACCOUNT, and locked STORED_BALANCE only by
 * NEXT_PUBLIC_DEMO_MODE / NEXT_PUBLIC_STORED_BALANCE_CORRIDORS. Both hold
 * customer funds, and the Phase 0 custody gate (lib/server/custody-phase.ts,
 * enforced by /api/transfers/authorize and /api/recipients) answers 403
 * custody_not_licensed for both until the custody package is configured. So
 * an operator could choose a tier, press "Review quote", and be refused.
 *
 * The fix routes the form through the gate's own decision: the tier lists,
 * the reason and `deliveryTierOpen()` move to an import-free module both sides
 * share, and the phase reaches the client component from the dashboard layout
 * (`locks.custodyOn`) through the shell.
 *
 * Red before green: on the tree before the fix lib/custody-phase-rules.ts does
 * not exist, StepDelivery never consults the phase, and the shell provides no
 * phase to its pages.
 */

const rules = () => import('../lib/custody-phase-rules.ts');
const gate = () => import('../lib/server/custody-phase.ts');

const CUSTODY_PACKAGE = '0x' + 'cd'.repeat(32);
const TIERS = ['PAYOUT_ONLY', 'SWEEP_ACCOUNT', 'STORED_BALANCE', 'anything-else'];

async function raw(relative) {
  return readFile(new URL(`../${relative}`, import.meta.url), 'utf8');
}

async function source(relative) {
  return (await raw(relative))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/* ── One decision, both sides ──────────────────────────────────────────── */

test('the form and the gate decide a tier with the same function, in both phases', async () => {
  const { deliveryTierOpen } = await rules();
  const { deliveryTierAllowed } = await gate();

  for (const tier of TIERS) {
    assert.equal(deliveryTierOpen(tier, false), deliveryTierAllowed(tier, { custodyPackageId: '' }), `${tier} in Phase 0`);
    assert.equal(deliveryTierOpen(tier, true), deliveryTierAllowed(tier, { custodyPackageId: CUSTODY_PACKAGE }), `${tier} in Phase 2`);
  }

  // What that decision is.
  assert.equal(deliveryTierOpen('PAYOUT_ONLY', false), true, 'a payout is always open');
  assert.equal(deliveryTierOpen('SWEEP_ACCOUNT', false), false, 'SWEEP_ACCOUNT holds funds');
  assert.equal(deliveryTierOpen('STORED_BALANCE', false), false, 'STORED_BALANCE holds funds');
  assert.equal(deliveryTierOpen('SWEEP_ACCOUNT', true), true);
  assert.equal(deliveryTierOpen('STORED_BALANCE', true), true);
  assert.equal(deliveryTierOpen('anything-else', true), false, 'an unknown tier is never open');
});

test('the server gate re-exports the shared lists and reason, and the API wording is unchanged', async () => {
  const shared = await rules();
  const server = await gate();

  assert.equal(server.CUSTODY_DELIVERY_TIERS, shared.CUSTODY_DELIVERY_TIERS);
  assert.equal(server.PHASE0_DELIVERY_TIERS, shared.PHASE0_DELIVERY_TIERS);
  assert.equal(server.CUSTODY_PHASE_REASON, shared.CUSTODY_PHASE_REASON);

  // The 403 body customers already see, byte for byte.
  assert.equal(
    shared.CUSTODY_PHASE_REASON,
    'Holding customer funds — stored balances, sweep accounts and the treasury — is a Phase 2 capability that needs ' +
      'a money-broking licence Splash does not hold yet. Phase 0 pays out only: choose the PAYOUT_ONLY delivery.',
  );
  const body = await server.custodyPhaseResponse().json();
  assert.equal(body.error, shared.CUSTODY_PHASE_REASON);
});

test('the reason the form shows is the gate reason, licence-named, and never says "licensed"', async () => {
  const { CUSTODY_PHASE_WHY, CUSTODY_PHASE_REASON } = await rules();

  assert.ok(CUSTODY_PHASE_REASON.startsWith(`${CUSTODY_PHASE_WHY} `), 'the refusal opens with the sentence the form shows');
  assert.match(CUSTODY_PHASE_WHY, /money-broking licence/i, 'the licence is named');
  assert.match(CUSTODY_PHASE_WHY, /Phase 2/, 'the phase is named');
  assert.match(CUSTODY_PHASE_WHY, /Splash does not hold/i, 'and it is plain that Splash does not hold it');
  assert.doesNotMatch(CUSTODY_PHASE_WHY, /\blicensed\b/i);
});

test('the shared rules import nothing, so a client component can take them', async () => {
  const text = await source('lib/custody-phase-rules.ts');
  assert.doesNotMatch(text, /^\s*import\b/m, 'no import: it ships to the browser');
  assert.doesNotMatch(text, /\brequire\(|node:|contract-config/);
});

/* ── The phase reaches the page ────────────────────────────────────────── */

test('the shell hands its pages the custodyOn the layout resolved, failing closed', async () => {
  const layout = await source('app/dashboard/layout.tsx');
  assert.match(layout, /custodyOn: custodyPhaseEnabled\(\)/, 'the layout still resolves the phase on the server');

  const shell = await source('components/dashboard/DashboardShell.tsx');
  assert.match(
    shell,
    /<CustodyPhaseContext value=\{locks\?\.custodyOn \?\? false\}>\{children\}<\/CustodyPhaseContext>/,
    'the pages render inside the phase the Treasury padlock reads',
  );

  const context = await source('components/dashboard/CustodyPhaseContext.ts');
  assert.match(context, /createContext\(false\)/, 'no provider means Phase 0, the gate default');
});

/* ── StepDelivery ──────────────────────────────────────────────────────── */

test('StepDelivery locks every fund-holding tier through the gate decision, before any env switch', async () => {
  const step = await source('components/transfer/StepDelivery.tsx');
  const { CUSTODY_DELIVERY_TIERS } = await rules();

  assert.doesNotMatch(step, /import\s+(?!type\b)[^;]*from\s+'@\/lib\/server\//, 'no runtime import of a server module');
  assert.match(step, /import \{[^}]*\bdeliveryTierOpen\b[^}]*\} from '@\/lib\/custody-phase-rules'/);
  assert.match(step, /const custodyOn = useCustodyPhaseOn\(\);/);

  for (const tier of CUSTODY_DELIVERY_TIERS) {
    assert.match(step, new RegExp(`tier: '${tier}'`), `${tier} is an option, so the lock below covers it`);
  }

  // The phase lock comes first; the stored-balance corridor switch (which
  // NEXT_PUBLIC_DEMO_MODE turns on) can only add a lock, never lift one.
  assert.match(
    step,
    /if \(!deliveryTierOpen\(tier, custodyOn\)\) return 'custody_phase';\s*if \(tier === 'STORED_BALANCE' && !storedOpen\) return 'corridor';\s*return null;/,
  );
  assert.match(step, /const lock = lockFor\(option\.tier, custodyOn, storedOpen\);/, 'every option goes through it');
  assert.match(step, /disabled=\{lock !== null\}/);
});

test('a locked tier says why in visible text, and a prefilled locked tier is never carried forward', async () => {
  const step = await source('components/transfer/StepDelivery.tsx');

  assert.match(step, /\{CUSTODY_PHASE_WHY\}/, 'the gate reason is rendered, not paraphrased');
  assert.match(step, /id=\{CUSTODY_NOTE_ID\}/);
  assert.match(step, /aria-describedby=\{lock === 'custody_phase' \? CUSTODY_NOTE_ID : undefined\}/, 'the locked cards point at it');
  assert.match(step, /'Locked until Phase 2'/);
  assert.doesNotMatch(step, /\btitle=/, 'no hover-only reason');
  assert.doesNotMatch(await raw('components/transfer/StepDelivery.tsx'), /\blicensed\b/i);

  assert.match(step, /const chosen: RecipientTier = lockFor\(state\.deliveryTier, custodyOn, storedOpen\) \? 'PAYOUT_ONLY' : state\.deliveryTier;/);
  assert.match(step, /const selected = chosen === option\.tier;/);
  assert.match(step, /onClick=\{\(\) => \{ set\(\{ deliveryTier: chosen \}\); next\(\); \}\}/, 'continuing commits the open tier');
});

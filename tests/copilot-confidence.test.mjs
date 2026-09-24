import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * The copilot suggestion cards show a confidence only when something measured
 * it, and never above what was measured.
 *
 * The rule is "State confidence honestly" (lib/agent/oxwal.ts). The cards on
 * /dashboard/copilot broke it four ways:
 * - memory cards floored `1 - distance` at 0.6 and 0.55, so a filler memory
 *   at distance 0.95 (5% similar) read 60%, and labelled that similarity to
 *   the recall query "confidence";
 * - the fallback Smart Treasury card claimed an invented 60%, and pitched a
 *   fund-holding product in Phase 0;
 * - the invoice-batch card claimed an invented 92%, and a saving of
 *   (n - 1) × $23.50 that nothing computed;
 * - the page filled any missing score with `?? 0.6`, and its empty state
 *   said there were "no unpaid invoices or idle balances", when an empty
 *   list only means no corridor had two open invoices and no memory matched:
 *   no balance was ever read;
 * - the memory cards promised a "cheapest corridor", a "pre-open" lock and an
 *   "optimal lock window" that nothing computes, and the behaviour card on the
 *   same page showed the same score as "pattern confidence", with demo
 *   memories at an invented 94% / 91% / 88%.
 * lib/server/copilot.ts also carried forecastFxRate and suggestTreasuryAction,
 * which had no callers: fixed 0.7 / 0.82 values, and an unmeasured formula
 * with a 0.85 floor.
 *
 * Red before green: on the tree before the fix lib/confidence.ts does not
 * exist, memoryRelevance / suggestionsFromMemories / idleCashSuggestion are
 * not exported, and the sources carry the floors and constants above.
 */

// Phase 0, and MemWal unconfigured: recall returns [], nothing is fetched.
delete process.env.SPLASH_CUSTODY_PACKAGE_ID;
delete process.env.MEMWAL_PRIVATE_KEY;
delete process.env.MEMWAL_ACCOUNT_ID;

const format = () => import('../lib/confidence.ts');
const copilot = () => import('../lib/server/copilot.ts');

async function source(relative) {
  return (await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const near = (actual, expected, message) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`);

/* ── The formatter ─────────────────────────────────────────────────────── */

test('a score becomes a whole percent, clamped; no score is no percent', async () => {
  const { confidencePercent } = await format();
  assert.equal(confidencePercent(0.584), 58, 'the rounding tests/oxwal-frontend.test.mjs pins for action cards');
  assert.equal(confidencePercent(0.2), 20);
  assert.equal(confidencePercent(0), 0);
  assert.equal(confidencePercent(1), 100);
  assert.equal(confidencePercent(1.2), 100);
  assert.equal(confidencePercent(-0.1), 0);
  for (const nothing of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, '0.6']) {
    assert.equal(confidencePercent(nothing), null, `${String(nothing)} is not a measured score`);
  }
});

/* ── Memory relevance ──────────────────────────────────────────────────── */

test('memory relevance is 1 - distance, clamped to 0..1, with no floor', async () => {
  const { memoryRelevance } = await copilot();
  near(memoryRelevance(0), 1);
  near(memoryRelevance(0.25), 0.75);
  near(memoryRelevance(0.95), 0.05, 'a 5%-similar memory reads 5%, not 60%');
  near(memoryRelevance(1), 0);
  near(memoryRelevance(1.5), 0, 'past orthogonal: clamped, not negative');
  near(memoryRelevance(2), 0);
  near(memoryRelevance(-0.1), 1, 'float noise below 0 cannot exceed 100%');
  assert.equal(memoryRelevance(Number.NaN), null);
  assert.equal(memoryRelevance(Number.POSITIVE_INFINITY), null);
  assert.equal(memoryRelevance(undefined), null);
});

test('each memory card carries its own measured relevance, and filler makes no card', async () => {
  const { suggestionsFromMemories, MIN_MEMORY_RELEVANCE } = await copilot();
  assert.equal(MIN_MEMORY_RELEVANCE, 0.3, "the MemWal SDK's default minRelevance");

  const [batch] = suggestionsFromMemories([{ text: 'Monthly payroll batch to the Manila team', distance: 0.4 }]);
  assert.equal(batch.type, 'batch');
  near(batch.confidence, 0.6, 'its own 60%, which the old floor would also have shown for 5%');

  const [timing] = suggestionsFromMemories([{ text: 'Pays suppliers in IDR every Friday', distance: 0.65 }]);
  assert.equal(timing.type, 'timing');
  near(timing.confidence, 0.35, 'was Math.max(0.55, …) = 0.55');

  const [close] = suggestionsFromMemories([{ text: 'Payroll batch, first Monday', distance: 0.12 }]);
  near(close.confidence, 0.88, 'a close match keeps its real, higher score');

  // What the floors used to dress up: a 5%- or 10%-similar memory read 60% / 55%.
  assert.deepEqual(suggestionsFromMemories([{ text: 'Monthly payroll batch to the Manila team', distance: 0.95 }]), []);
  assert.deepEqual(suggestionsFromMemories([{ text: 'Pays suppliers in IDR every Friday', distance: 0.9 }]), []);
  assert.deepEqual(suggestionsFromMemories([{ text: 'payroll batch', distance: 0.75 }]), [], 'just under the cutoff');
  assert.equal(suggestionsFromMemories([{ text: 'payroll batch', distance: 0.7 }]).length, 1, 'at the cutoff: kept, as the SDK keeps 1 - distance >= 0.3');

  // The cards offer only what Zeke can do: draft a batch, read a rate.
  assert.match(batch.description, /draft this batch for your approval\?$/);
  assert.match(timing.description, /check the current USD→IDR rate\?$/);
  assert.equal(timing.title, 'Check USD→IDR');
  for (const card of [batch, timing, close]) {
    assert.doesNotMatch(card.description, /cheapest corridor|pre-open|optimal lock window|flag/i, card.title);
  }
  assert.deepEqual(suggestionsFromMemories([{ text: 'payroll batch', distance: Number.NaN }]), [], 'a memory that cannot be scored makes no card');

  assert.deepEqual(suggestionsFromMemories([{ text: 'Lunch with the auditors', distance: 0.1 }]), [], 'no card without a matching pattern');
});

/* ── The fallback card ─────────────────────────────────────────────────── */

test('the Smart Treasury card waits for custody AND treasury execution, and claims no confidence', async () => {
  const { idleCashSuggestion } = await copilot();
  assert.equal(idleCashSuggestion(false, true), null, 'Phase 0: no fund-holding pitch');
  assert.equal(idleCashSuggestion(true, false), null, '/api/treasury refuses to move anything: no "move some over?"');
  assert.equal(idleCashSuggestion(false, false), null);
  const card = idleCashSuggestion(true, true);
  assert.equal(card.type, 'treasury');
  assert.equal(card.confidence, null, 'a canned card has no confidence to state');
  assert.equal(card.requiresAuth, true);
});

test('with memory unavailable, Phase 0 suggests nothing rather than a treasury pitch', async () => {
  const { getCopilotSuggestions } = await copilot();
  assert.deepEqual(await getCopilotSuggestions('patterns'), [], 'the defaults read the phase: this file is Phase 0');
  assert.deepEqual(await getCopilotSuggestions('patterns', true, false), [], 'custody on, execution off');
  const open = await getCopilotSuggestions('patterns', true, true);
  assert.equal(open.length, 1);
  assert.equal(open[0].type, 'treasury');
  assert.equal(open[0].confidence, null);
});

/* ── The sources ───────────────────────────────────────────────────────── */

test('copilot.ts has no confidence floors, no invented constants on the cards, and no dead forecasters', async () => {
  const text = await source('lib/server/copilot.ts');
  assert.doesNotMatch(text, /Math\.max\(0\.(6|55|85|4)\b/, 'no positive floor on a confidence');
  assert.doesNotMatch(text, /forecastFxRate|suggestTreasuryAction/, 'the uncalled forecasters are gone');

  const cards = text.slice(text.indexOf('export function memoryRelevance'));
  assert.ok(cards.length > 0 && cards.includes('export async function getCopilotSuggestions'));
  assert.doesNotMatch(cards, /confidence:\s*\d/, 'every card confidence is measured or null');
  assert.match(cards, /const relevance = memoryRelevance\(m\.distance\);/);
  assert.match(cards, /if \(relevance === null \|\| relevance < MIN_MEMORY_RELEVANCE\) continue;/);
  assert.match(cards, /confidence: relevance,/);
  assert.match(cards, /confidence: null/);
  assert.match(cards, /if \(!custodyOn \|\| !executionOn\) return null;/);
});

test('the invoice-batch card states the fact it follows and invents neither a score, a saving nor a process', async () => {
  const route = await source('app/api/copilot/suggest/route.ts');
  assert.doesNotMatch(route, /0\.92/);
  assert.doesNotMatch(route, /23\.5/);
  assert.doesNotMatch(route, /could save/i);
  assert.doesNotMatch(route, /separate payments|one run|settles? them/i, 'nothing turns invoices into a batch yet');
  assert.match(route, /description: `\$\{invoices\.length\} open invoices are on the USD to \$\{currency\} corridor\.`,/);
  assert.match(route, /confidence: null,/);
});

test('the copilot page labels the score for what it is, and its empty state claims nothing it did not check', async () => {
  const page = await source('app/dashboard/copilot/page.tsx');
  assert.doesNotMatch(page, /\?\?\s*0\.6/, 'no 60% for a missing score');
  assert.match(page, /confidence: confidencePercent\(s\.confidence\)/);
  assert.match(page, /\{suggestion\.confidence !== null && \(/, 'the label renders only with a score');
  assert.match(page, /\{suggestion\.confidence\}% memory match/, 'it measures how closely a memory matched');
  assert.doesNotMatch(page, /% confidence/);
  // An empty list is not evidence of no unpaid invoices (a batch card needs
  // two on one corridor) and no balance was ever read.
  assert.doesNotMatch(page, /no unpaid invoices|idle balances worth/i);
  assert.match(page, /Nothing to suggest right now\. Ask directly in the chat\./);
  assert.doesNotMatch(page, /Read from your invoices and treasury/, 'nothing reads the treasury for these cards');
  assert.match(page, /Drawn from your open invoices and MemWal memory\./);
});

test('the behaviour card on the same page shows the same score, under the same name, and none for demo memories', async () => {
  const route = await source('app/api/memwal/behaviors/route.ts');
  assert.doesNotMatch(route, /0\.94|index \* 0\.03/, 'no invented demo percentages');
  assert.match(route, /const relevance = memoryRelevance\(memory\.distance\);/);
  assert.match(route, /if \(relevance === null \|\| relevance < MIN_MEMORY_RELEVANCE\) return \[\];/);
  assert.match(route, /\(\{ text, confidence: null, demo: true \}\)/);
  assert.doesNotMatch(route, /confidence:\s*\d/);

  const card = await source('components/MemWalBehaviorCard.tsx');
  assert.doesNotMatch(card, /pattern confidence/);
  assert.match(card, /% memory match/);
  assert.match(card, /confidencePercent\(memory\.confidence\) !== null &&/);
});

test('the invoice loop shows a percentage only for a measured score', async () => {
  const loop = await source('components/invoices/InvoiceLoop.tsx');
  assert.doesNotMatch(loop, /Math\.round\(suggestion\.confidence \* 100\)/);
  assert.doesNotMatch(loop, /Math\.round\(extraction\.confidence \* 100\)/);
  assert.match(loop, /confidencePercent\(suggestion\.confidence\)/);
});

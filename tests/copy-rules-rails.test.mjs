/**
 * The copy guard's one exception for the rails list (v2 brief section 6).
 *
 * The landing's partners strip renders only signed partners; until one is
 * signed it shows the rails and standards Splash runs on, and the brief names
 * Walrus among them. The marketing jargon rule refused the word on every
 * marketing file, so the list in content/rails.ts is exempt by name, and only
 * it: the word is still refused everywhere else on the landing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const rules = () => import('../scripts/copy-rules.mjs');

test('the rails list may name Walrus; no other marketing file may', async () => {
  const { copyViolations } = await rules();
  assert.deepEqual(copyViolations('content/rails.ts', "{ name: 'Walrus', role: 'Where receipts are kept' }"), []);
  assert.ok(copyViolations('content/landing-faq.ts', 'Receipts live on Walrus').length > 0);
  assert.ok(copyViolations('components/landing/PartnersRail.tsx', 'Walrus').length > 0);
  assert.ok(copyViolations('components/IsometricLanding.tsx', 'Walrus').length > 0);
  // The exception is for the one word; the rest of the jargon rule still holds there.
  assert.ok(copyViolations('content/rails.ts', 'anchored on-chain').length > 0);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Treasury outside its own page (v2 D9, brief 5.7).
 *
 * Treasury is USDY in the business's own Splash Wallet, redeemed on the Sui
 * market whenever the owners sign. Two surfaces still described the retired
 * custodial Smart Treasury:
 *
 * - The onboarding intent picker marked Treasury "Coming — subject to
 *   licensing" and offered to "register interest". Treasury waits on no
 *   licence and is open in the nav and on its page.
 * - Zeke's answer to a notice-period question said coming out of "Smart
 *   Treasury" takes a 1-3 business-day notice window. A wallet redemption has
 *   no notice period: it is a swap on Sui at the price the market pays then.
 */

async function source(relative) {
  return (await readFile(new URL(`../${relative}`, import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

test('the onboarding intent picker offers Treasury as open, in the business wallet, labelled not Shariah', async () => {
  const text = await source('components/onboarding/IntentPicker.tsx');
  assert.doesNotMatch(text, /licen[cs]/i, 'no licence is cited');
  assert.doesNotMatch(text, /Coming/i, 'Treasury is not "coming"');
  assert.doesNotMatch(text, /register interest/i, 'choosing Treasury is a choice, not a waiting list');
  assert.doesNotMatch(text, /roadmap/, 'no card is marked as a roadmap item');
  assert.doesNotMatch(text, /[—–]/, 'no em or en dash in the copy');
  assert.match(text, /own Splash Wallet/, 'says where the USDY sits');
  assert.match(text, /not Shariah-compliant/, 'labels USDY not Shariah');
  assert.doesNotMatch(text, /#B4690E|#D9A441\]\/10/, 'no orange roadmap chip');
});

async function run(message) {
  const prevGate = process.env.FEATURE_KYB_GATE;
  const prevDb = process.env.DATABASE_URL;
  process.env.FEATURE_KYB_GATE = 'false';
  delete process.env.DATABASE_URL;
  try {
    const { runOxwalAgent } = await import('../lib/agent/oxwal.ts');
    const events = [];
    for await (const event of runOxwalAgent({ forceLocal: true, message, orgId: 'org_surfaces' })) events.push(event);
    return events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  } finally {
    if (prevGate === undefined) delete process.env.FEATURE_KYB_GATE;
    else process.env.FEATURE_KYB_GATE = prevGate;
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
  }
}

test("Zeke's notice-period answer describes a wallet redemption, not the retired Smart Treasury", async () => {
  for (const message of ['Is there a notice period?', 'How long does it take to get my money out?']) {
    const reply = await run(message);
    assert.ok(reply.length > 0, `"${message}" gets an answer`);
    assert.doesNotMatch(reply, /Smart Treasury/, `"${message}": the custodial ledger is retired`);
    assert.doesNotMatch(reply, /business-day|notice window/i, `"${message}": a redemption has no notice window`);
    assert.doesNotMatch(reply, /licen[cs]/i, `"${message}": no licence is cited`);
    assert.match(reply, /no notice period/i, `"${message}": says so`);
    assert.match(reply, /own Splash Wallet/, `"${message}": says where the USDY sits`);
  }
});

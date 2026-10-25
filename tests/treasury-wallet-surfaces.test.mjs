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
 *   no notice period: it is a swap on Sui.
 *
 * The 5.7 review then found:
 * - A bank cash-out question ("get my money out to my bank") got the USDY
 *   redemption answer, which says Splash charges no fee. A bank payout has a
 *   Splash fee and partner fees.
 * - On a server with no swap route, the redemption answer first described a
 *   working swap, then said swaps are not switched on.
 * - The Treasury card promised swapping and redeeming that production refuses,
 *   and left out that the yield is variable and not promised.
 * - The intent buttons were forced onto one line at 13px and overflowed their
 *   cards between 768px and about 876px.
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

test('the Treasury card holds whether or not this server has a swap route, and says the yield is not promised', async () => {
  const text = await source('components/onboarding/IntentPicker.tsx');
  assert.doesNotMatch(text, /\bredeem it\b|Swap idle USDC for USDY/, 'no promise of a swap production refuses');
  assert.match(text, /Hold idle USDC as USDY in your own Splash Wallet/, 'present tense, true with the route off');
  assert.match(text, /variable and not promised/, 'the yield caveat the page and Zeke carry');
});

test('the intent buttons fit their cards at every width: a short visible label at the normal size', async () => {
  const text = await source('components/onboarding/IntentPicker.tsx');
  assert.doesNotMatch(text, /text-\[13px\][^"]*font-semibold text-white|font-semibold text-white[^"]*text-\[13px\]/, 'the button keeps text-sm');
  assert.doesNotMatch(text, /`Choose \$\{title\.toLowerCase\(\)\}`/, 'no long "Choose collect and invoice" label');
  assert.match(text, /sr-only/, 'each button still names its card to a screen reader');
});

test('the intent page has no em or en dash and no licence in what it renders', async () => {
  const text = await source('app/onboarding/intent/page.tsx');
  assert.doesNotMatch(text, /[—–]/, 'no em or en dash');
  assert.doesNotMatch(text, /licen[cs]|Coming soon|testnet/i, 'no licence, no "coming soon", no testnet');
  assert.match(text, /How will you use Splash\?/);
});

async function run(message, env = {}) {
  const keys = ['FEATURE_KYB_GATE', 'DATABASE_URL', 'TREASURY_WALLET_SWAPS', ...Object.keys(env)];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.FEATURE_KYB_GATE = 'false';
  delete process.env.DATABASE_URL;
  delete process.env.TREASURY_WALLET_SWAPS;
  Object.assign(process.env, env);
  try {
    const { runOxwalAgent } = await import('../lib/agent/oxwal.ts');
    const events = [];
    for await (const event of runOxwalAgent({ forceLocal: true, message, orgId: 'org_surfaces' })) events.push(event);
    return events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("Zeke's notice-period answer describes a wallet redemption, not the retired Smart Treasury", async () => {
  for (const message of ['Is there a notice period?', 'How long to redeem USDY?', 'How long does it take to get my money out of Treasury?']) {
    const reply = await run(message);
    assert.ok(reply.length > 0, `"${message}" gets an answer`);
    assert.doesNotMatch(reply, /Smart Treasury/, `"${message}": the custodial ledger is retired`);
    assert.doesNotMatch(reply, /business-day|notice window/i, `"${message}": a redemption has no notice window`);
    assert.doesNotMatch(reply, /licen[cs]/i, `"${message}": no licence is cited`);
    assert.match(reply, /no notice period/i, `"${message}": says so`);
    assert.match(reply, /not Shariah-compliant/, `"${message}": labels USDY not Shariah`);
  }
});

test('a bank cash-out question gets the bank withdrawal answer, never the USDY redemption answer', async () => {
  for (const message of [
    'How long does it take to get my money out to my bank?',
    'How long does it take to get my money out?',
    'How do I cash out to my bank account?',
    'How do I withdraw to my bank?',
  ]) {
    const reply = await run(message);
    assert.ok(reply.length > 0, `"${message}" gets an answer`);
    assert.doesNotMatch(reply, /USDY|no fee on a swap|no notice period/, `"${message}": not the Treasury answer`);
    assert.match(reply, /bank/i, `"${message}": talks about the bank payout`);
    assert.match(reply, /partner/i, `"${message}": the partner's fees are their own line`);
    assert.doesNotMatch(reply, /testnet|licen[cs]/i, `"${message}": copy rules`);
  }
});

test('with no swap route the redemption answer never describes a working swap first', async () => {
  const off = await run('How long to redeem USDY?');
  assert.match(off, /not switched on yet/, 'says swaps are off');
  assert.doesNotMatch(off, /Redeeming USDY is a swap back to USDC/, 'no working redemption promised');
  assert.doesNotMatch(off, /I can't prepare, approve or send/, 'a plain question is not met with the refusal opener');
  assert.doesNotMatch(off, /at the price the market pays then/, 'no awkward copy');
  assert.equal((off.match(/switched on/g) ?? []).length, 1, 'says it once');

  const on = await run('How long to redeem USDY?', { TREASURY_WALLET_SWAPS: 'true', NODE_ENV: 'development' });
  assert.match(on, /Redeeming USDY is a swap back to USDC on Sui/, 'with a route, says how a redemption works');
  assert.match(on, /no Splash fee/i, 'no Splash fee on a swap (A1)');
  assert.doesNotMatch(on, /not switched on/, 'and does not say it is off');
  assert.match(on, /not Shariah-compliant/);
});

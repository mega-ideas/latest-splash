/**
 * A spending rule pays only on Sui, and never hands a coin to the spender.
 *
 * Review finding (High): `splash_spend::pay_intent_cross_chain` returned the
 * business's raw `Coin<USDC>` to the PTB of whoever paid under the rule (a
 * staff member, or Splash's operator), beside a `BridgeObligation` that only
 * a future bridge adapter's code tied to a CCTP burn. The obligation is a
 * splash_core type, so an additive core upgrade could add a function that
 * unpacks it, and the spender keeps the coin. That made the owner alert's
 * "an update cannot add a recipient" false for kind 4.
 *
 * splash_spend publishes immutable and core's app entry points freeze with
 * core, so the fix is structural: no spending-rule path can open or settle a
 * cross-chain intent. Cross-chain payments stay on the owners' multisig
 * (`create_cross_chain_for_wallet`, `confirm_cross_chain_from_business_wallet`),
 * where the coin returned is the owners' own, in their own transaction.
 *
 * A Move test cannot call a function that does not exist, so this is checked
 * on the source.
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const read = (rel) => readFile(new URL(rel, root), 'utf8');

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Every function in a Move source: name, generics, return type and body. */
function functions(code) {
  const out = [];
  const signature = /(^|\n)\s*((?:public(?:\([a-z]+\))?\s+)?(?:entry\s+)?)fun\s+([A-Za-z0-9_]+)\s*(<[^>]*>)?\s*\(/g;
  let match;
  while ((match = signature.exec(code)) !== null) {
    let i = match.index + match[0].length - 1;
    let depth = 0;
    for (; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')' && --depth === 0) break;
    }
    const braceStart = code.indexOf('{', i);
    const returns = code.slice(i + 1, braceStart).replace(/^\s*:\s*/, '').trim();
    let end = braceStart;
    for (let d = 0; end < code.length; end += 1) {
      if (code[end] === '{') d += 1;
      else if (code[end] === '}' && --d === 0) break;
    }
    out.push({
      name: match[3],
      visibility: match[2].trim(),
      generics: match[4] ?? '',
      returns,
      body: code.slice(braceStart, end + 1),
    });
  }
  return out;
}

async function spendSources() {
  const dir = new URL('move/splash_spend/sources/', root);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.move'));
  assert.ok(files.length > 0, 'splash_spend has sources');
  return Promise.all(files.map(async (f) => ({ file: f, code: stripComments(await read(`move/splash_spend/sources/${f}`)) })));
}

test('no splash_spend function returns a Coin or a BridgeObligation', async () => {
  for (const { file, code } of await spendSources()) {
    for (const fn of functions(code)) {
      assert.doesNotMatch(fn.returns, /\bCoin\s*</, `${file}: ${fn.name} returns a Coin (${fn.returns})`);
      assert.doesNotMatch(fn.returns, /\bBridgeObligation\b/, `${file}: ${fn.name} returns a BridgeObligation (${fn.returns})`);
    }
  }
});

test('splash_spend opens and pays only Sui intents', async () => {
  for (const { file, code } of await spendSources()) {
    assert.doesNotMatch(code, /\bpay_intent_cross_chain\b/, `${file} still has pay_intent_cross_chain`);
    assert.doesNotMatch(code, /\bcreate_cross_chain_intent\b/, `${file} still has create_cross_chain_intent`);
    assert.doesNotMatch(code, /payment_intent::\w*cross_chain\w*_(?:for|from)_app\b/, `${file} calls a cross-chain app entry in core`);
  }
});

test('a settlement app reaches exactly two core entries: create_for_app and settle_from_app', async () => {
  const code = stripComments(await read('move/splash_core/sources/payment_intent.move'));
  const appEntries = functions(code)
    .filter((fn) => /compliance_config::assert_settlement_app\s*</.test(fn.body))
    .map((fn) => fn.name)
    .sort();
  assert.deepEqual(appEntries, ['create_for_app', 'settle_from_app']);
  for (const fn of functions(code).filter((f) => appEntries.includes(f.name))) {
    assert.doesNotMatch(fn.returns, /\bCoin\s*<|\bBridgeObligation\b/, `${fn.name} hands out a coin`);
  }
});

test('the owners keep their cross-chain path', async () => {
  const code = stripComments(await read('move/splash_core/sources/payment_intent.move'));
  const names = functions(code).map((fn) => fn.name);
  for (const name of ['create_cross_chain_for_wallet', 'confirm_cross_chain_from_business_wallet', 'discharge_bridge_obligation']) {
    assert.ok(names.includes(name), `${name} is still in payment_intent`);
  }
  const wallet = functions(code).find((fn) => fn.name === 'confirm_cross_chain_from_business_wallet');
  assert.match(wallet.body, /business_account::assert_wallet\s*\(/, 'only the business wallet releases a cross-chain coin');
});

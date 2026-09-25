import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GASLESS_MIN_LEG_MINOR,
  gaslessEligible,
  gaslessEnabled,
  sendNeedsSui,
  SUI_USDC_COIN_TYPE,
} from '../lib/payments/stablecoin-lane.ts';
import {
  describeBuildError,
  explainGaslessRefusal,
  gaslessTransferTransaction,
  isTransientChainError,
} from '../lib/server/stablecoin-chain.ts';

// Gasless USDC transfers (lib/payments/stablecoin-lane.ts, Gas). What the
// network accepts was checked on mainnet with dry runs; these pin the shape
// Splash builds and the rules for when it tries, with no network.

const USDC = SUI_USDC_COIN_TYPE.mainnet;
const SENDER = `0x${'11'.repeat(32)}`;
const TO = `0x${'aa'.repeat(32)}`;
const FEE = `0x${'bb'.repeat(32)}`;
const MAINNET_CHAIN = '4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S';

test('the gasless transaction: send_funds per leg, gas price and budget 0, no gas coins, a two-epoch window', () => {
  const tx = gaslessTransferTransaction(
    { sender: SENDER, coinType: USDC, legs: [{ address: TO, amountMinor: 1_000_000n }, { address: FEE, amountMinor: 50_000n }] },
    { epoch: 1261n, chain: MAINNET_CHAIN, nonce: 7 },
  );
  const data = tx.getData();
  assert.equal(data.sender, SENDER);
  assert.deepEqual(data.gasData, { budget: '0', price: '0', owner: null, payment: [] });
  assert.deepEqual(data.expiration.ValidDuring, {
    minEpoch: '1261', maxEpoch: '1262', minTimestamp: null, maxTimestamp: null, chain: MAINNET_CHAIN, nonce: 7,
  });

  const calls = data.commands.filter((c) => c.MoveCall).map((c) => c.MoveCall);
  assert.equal(calls.length, 2, 'one send per leg');
  for (const call of calls) {
    assert.equal(`${call.module}::${call.function}`, 'balance::send_funds');
    assert.match(call.package, /^0x0+2$/);
    assert.deepEqual(call.typeArguments, [USDC]);
  }
  // The funds come from the sender's USDC as a Balance, resolved at build.
  const intents = data.commands.filter((c) => c.$Intent).map((c) => c.$Intent);
  assert.deepEqual(intents.map((i) => [i.data.balance.toString(), i.data.outputKind]), [['1000000', 'balance'], ['50000', 'balance']]);
  // Nothing else: no transfer of an object, no other call.
  assert.equal(data.commands.length, 4);
});

test('a zero leg adds nothing', () => {
  const tx = gaslessTransferTransaction(
    { sender: SENDER, coinType: USDC, legs: [{ address: TO, amountMinor: 1_000_000n }, { address: FEE, amountMinor: 0n }] },
    { epoch: 5n, chain: MAINNET_CHAIN, nonce: 1 },
  );
  assert.equal(tx.getData().commands.filter((c) => c.MoveCall).length, 1);
});

test('eligible: USDC only, and every leg at or above Sui’s 0.01 floor', () => {
  assert.equal(GASLESS_MIN_LEG_MINOR, 10_000n);
  assert.equal(gaslessEligible(USDC, [{ amountMinor: 1_000_000n }]), true);
  assert.equal(gaslessEligible(USDC, [{ amountMinor: 1_000_000n }, { amountMinor: 10_000n }]), true);
  assert.equal(gaslessEligible(USDC, [{ amountMinor: 1_000_000n }, { amountMinor: 9_999n }]), false, 'a leg under the floor');
  assert.equal(gaslessEligible(USDC, [{ amountMinor: 1_000_000n }, { amountMinor: 0n }]), true, 'a zero leg is not sent');
  assert.equal(gaslessEligible(USDC, []), false);
  assert.equal(gaslessEligible(SUI_USDC_COIN_TYPE.testnet, [{ amountMinor: 1_000_000n }]), false, 'the lane is mainnet USDC');
  assert.equal(gaslessEligible('0x2::sui::SUI', [{ amountMinor: 1_000_000n }]), false);
});

test('gasless is on unless STABLECOIN_GASLESS=off', () => {
  assert.equal(gaslessEnabled({}), true);
  assert.equal(gaslessEnabled({ STABLECOIN_GASLESS: '' }), true);
  assert.equal(gaslessEnabled({ STABLECOIN_GASLESS: 'on' }), true);
  assert.equal(gaslessEnabled({ STABLECOIN_GASLESS: 'off' }), false);
  assert.equal(gaslessEnabled({ STABLECOIN_GASLESS: ' OFF ' }), false);
});

test('refusals: the dust rule is explained; a busy node is told apart from a refusal', () => {
  // The node's words for change under 0.01 USDC (mainnet dry run, 2026-09-26).
  const dust = new Error('Error checking transaction input objects: Invalid withdraw reservation: Invalid gasless withdrawal of coin type USDC. Gasless transactions must either use the entire address balance, or leave at least 10000. Remaining amount would be 5000');
  assert.match(explainGaslessRefusal(dust), /at least 0\.01 USDC/);
  assert.equal(explainGaslessRefusal(new Error('Insufficient balance of USDC for owner 0x1')), null);

  assert.equal(isTransientChainError(new Error('Too Many Requests')), true);
  assert.equal(isTransientChainError(Object.assign(new Error('x'), { code: 'RESOURCE_EXHAUSTED' })), true);
  assert.equal(isTransientChainError(new Error('ValidatorOverloadedRetryAfter { retry_after_secs: 1 }')), true);
  assert.equal(isTransientChainError(dust), false);
  assert.equal(isTransientChainError(new Error('Insufficient balance of USDC')), false);
});

test('build errors read as what to do, and none promises a fee that is not charged', () => {
  assert.match(describeBuildError(new Error('Insufficient balance of 0xdba3::usdc::USDC for owner 0x1. Required: 2, Available: 1')), /does not hold enough USDC/);
  assert.match(describeBuildError(new Error('No valid gas coins found for the transaction.')), /needs a little SUI/);
  assert.doesNotMatch(describeBuildError(new Error('Insufficient balance of 0xdba3::usdc::USDC')), /plus the fee/);
});

test('Zeke’s gas answer follows the switch: no network fee while gasless is on, SUI when it is off', async () => {
  const { runOxwalAgent } = await import('../lib/agent/oxwal.ts');
  const ask = async () => {
    let said = '';
    for await (const event of runOxwalAgent({ forceLocal: true, message: 'who pays gas?' })) if (event.type === 'delta') said += event.text;
    return said;
  };
  const previous = process.env.STABLECOIN_GASLESS;
  try {
    delete process.env.STABLECOIN_GASLESS;
    const on = await ask();
    assert.match(on, /no network fee at all/);
    assert.match(on, /x402/);
    process.env.STABLECOIN_GASLESS = 'off';
    const off = await ask();
    assert.match(off, /pays the Sui network fee in SUI/);
    assert.doesNotMatch(off, /no network fee/);
  } finally {
    if (previous === undefined) delete process.env.STABLECOIN_GASLESS;
    else process.env.STABLECOIN_GASLESS = previous;
  }
});

test('the wallet needs SUI only where gas is paid, and a quote that fell back overrides the switch', () => {
  const base = { x402: false, gaslessOn: true, asCoin: false };
  assert.equal(sendNeedsSui(base), false, 'a wallet transfer, gasless');
  assert.equal(sendNeedsSui({ ...base, quoteGas: 'GASLESS' }), false);
  assert.equal(sendNeedsSui({ ...base, quoteGas: 'SENDER_PAYS' }), true, 'the quote fell back: its word is final');
  assert.equal(sendNeedsSui({ ...base, x402: true }), true, 'x402 always pays gas');
  assert.equal(sendNeedsSui({ ...base, asCoin: true }), true, 'sent as a coin');
  assert.equal(sendNeedsSui({ ...base, gaslessOn: false }), true, 'gasless switched off');
});

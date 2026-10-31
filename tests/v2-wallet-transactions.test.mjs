/**
 * The v2 wallet builders, and the reader that decides what a signer is shown.
 *
 * lib/server/sui-v2-builders.ts builds the PTBs the Business Splash Wallet
 * signs against Phase 1's v2 signatures; lib/wallet/wallet-tx-describe.ts
 * decodes exact bytes into what they do and refuses anything it does not
 * understand (review B10, Phase 0 finding 6); lib/server/wallet-sponsor.ts
 * decides what the gas sponsor will pay for. Offline: no network, no keys
 * beyond fixed test constants.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { toBase58 } from '@mysten/sui/utils';

import { softPasskey } from './fixtures/soft-passkey.mjs';
import { buildBusinessMultisig, registrationArgs } from '../lib/wallet/business-multisig.ts';
import { describeWalletTransaction, WalletTxRefused } from '../lib/wallet/wallet-tx-describe.ts';
import {
  nominateWalletTx,
  payFromWalletTx,
  registerWalletTx,
  rotateWalletTx,
  v2ObjectIdsFromEnv,
  walletMembershipTx,
} from '../lib/server/sui-v2-builders.ts';
import { assertSponsorable, SponsorRefused } from '../lib/server/wallet-sponsor.ts';

const CORE = '0x' + 'c0'.repeat(32);
const ACCOUNT = '0x' + 'ac'.repeat(32);
const CONFIG = '0x' + 'cf'.repeat(32);
const FEES = '0x' + 'fe'.repeat(32);
const REGISTRY = '0x' + 'ee'.repeat(32);
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';
const chain = {
  corePackageId: CORE,
  complianceConfig: { objectId: CONFIG, initialSharedVersion: 3 },
  feeConfig: { objectId: FEES, initialSharedVersion: 4 },
  registry: { objectId: REGISTRY, initialSharedVersion: 5 },
  usdcType: USDC,
};
const account = { objectId: ACCOUNT, initialSharedVersion: 9 };
const expect = { corePackageId: CORE, accountId: ACCOUNT, complianceConfigId: CONFIG, feeConfigId: FEES, registryId: REGISTRY, usdcType: USDC };
const sponsor = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(0x5a)).toSuiAddress();
const gas = { owner: sponsor, price: 1000n, budget: 20_000_000n, epoch: 900n, chain: toBase58(new Uint8Array(32).fill(7)), nonce: 42 };
const members = [softPasskey(), softPasskey(), softPasskey()];
const wallet = buildBusinessMultisig({ members: members.map((k, i) => ({ userId: `u${i}`, publicKey: k.publicKey })) });

/** A transaction built by hand: what a compromised client might hand a signer. */
async function handBuilt(build, sender = wallet.address) {
  const tx = new Transaction();
  build(tx);
  tx.setSender(sender);
  tx.setGasOwner(sponsor);
  tx.setGasPrice(1000);
  tx.setGasBudget(20_000_000);
  tx.setGasPayment([]);
  tx.setExpiration({ ValidDuring: { minEpoch: '900', maxEpoch: '901', minTimestamp: null, maxTimestamp: null, chain: gas.chain, nonce: 1 } });
  return tx.build();
}

test('register_wallet names the multisig the SDK derives, and the reader derives it again from the bytes', async () => {
  const { keys, weights, threshold } = registrationArgs(wallet);
  const bytes = await registerWalletTx(chain, { wallet: wallet.address, account, keys, weights, threshold, singleSignerAck: false, gas });
  const d = describeWalletTransaction(bytes, expect);
  assert.equal(d.sender, wallet.address);
  assert.equal(d.actions[0].type, 'register_wallet');
  assert.equal(d.actions[0].wallet, wallet.address, "the reader's Move-style derivation matches MultiSigPublicKey.toSuiAddress()");
  assert.deepEqual(d.actions[0].members.map((m) => m.address), members.map((m) => m.address));
  assert.equal(d.gas.sponsored, true);
  assert.equal(d.gas.fromAddressBalance, true);
  assert.deepEqual(d.validity, { minEpoch: '900', maxEpoch: '901', nonce: 42 });
});

test('every v2 wallet builder produces bytes the reader accepts for the right account only', async () => {
  const { keys, weights, threshold } = registrationArgs(wallet);
  const all = [
    await nominateWalletTx(chain, { founder: members[0].address, account, wallet: wallet.address, singleSigner: false, gas }),
    await registerWalletTx(chain, { wallet: wallet.address, account, keys, weights, threshold, singleSignerAck: false, gas }),
    await rotateWalletTx(chain, { currentWallet: wallet.address, account, keys: keys.slice(0, 2), weights: [1, 1], threshold: 2, singleSignerAck: false, gas }),
    await walletMembershipTx(chain, { wallet: wallet.address, account, change: 'remove_owner', address: members[2].address, gas }),
  ];
  for (const bytes of all) {
    describeWalletTransaction(bytes, expect);
    assert.throws(() => describeWalletTransaction(bytes, { ...expect, accountId: '0x' + 'ad'.repeat(32) }), (e) => e instanceof WalletTxRefused && e.code === 'wrong_object');
    assert.throws(() => describeWalletTransaction(bytes, { ...expect, corePackageId: '0x' + 'c1'.repeat(32) }), (e) => e.code === 'package_not_allowed');
  }
});

test('a payment reads as payee, amount, asset, the fee bound and the quote deadline', async () => {
  const bytes = await payFromWalletTx(chain, {
    wallet: wallet.address,
    account,
    paymentRef: new Uint8Array(32).fill(1),
    recipient: '0x' + '77'.repeat(32),
    beneficiaryRef: new Uint8Array(),
    amountMinor: 1_000_000_000n,
    targetCurrency: 'USDC',
    fxRateUsdLocal: 1_000_000n,
    commitment: new Uint8Array(32).fill(2),
    kind: 1,
    railCommitment: new Uint8Array(32).fill(3),
    expiresAtMs: 2_000_000_000_000n,
    maxFeeMinor: 2_000_000n,
    settleByMs: 1_900_000_000_000n,
    contentHash: new Uint8Array(32).fill(4),
    walrusBlobId: new TextEncoder().encode('blob'),
    gas,
  });
  const d = describeWalletTransaction(bytes, expect);
  const [withdraw, open, pay] = d.actions;
  assert.equal(withdraw.amountMinor, '1002000000');
  assert.equal(open.recipient, '0x' + '77'.repeat(32));
  assert.equal(open.amountMinor, '1000000000');
  assert.equal(open.asset, USDC);
  assert.equal(open.kind, 1);
  assert.equal(pay.maxFeeMinor, '2000000');
  assert.equal(pay.settleByMs, '1900000000000');
  assert.throws(() => describeWalletTransaction(bytes, { ...expect, feeConfigId: '0x' + 'ff'.repeat(32) }), (e) => e.code === 'wrong_object');
  assert.throws(() => describeWalletTransaction(bytes, { ...expect, usdcType: '0x2::sui::SUI' }), (e) => e.code === 'wrong_asset');
});

test('refused: any address alias command (Phase 0 finding 6)', async () => {
  const bytes = await handBuilt((tx) => {
    tx.moveCall({ target: '0x2::address_alias::enable', arguments: [] });
  });
  assert.throws(() => describeWalletTransaction(bytes, expect), (e) => e instanceof WalletTxRefused && e.code === 'address_alias');
});

test("refused: the gas coin, the sponsor's balance, and transfers of objects", async () => {
  const gasCoin = await handBuilt((tx) => {
    const [c] = tx.splitCoins(tx.gas, [1]);
    tx.transferObjects([c], '0x' + '99'.repeat(32));
  });
  assert.throws(() => describeWalletTransaction(gasCoin, expect), (e) => e.code === 'uses_gas_coin' || e.code === 'command_not_allowed');

  const fromSponsor = await handBuilt((tx) => {
    const [b] = tx.moveCall({ target: '0x2::balance::redeem_funds', typeArguments: ['0x2::sui::SUI'], arguments: [tx.withdrawal({ amount: 5, type: '0x2::sui::SUI', from: 'sponsor' })] });
    tx.moveCall({ target: '0x2::balance::send_funds', typeArguments: ['0x2::sui::SUI'], arguments: [b, tx.pure.address('0x' + '99'.repeat(32))] });
  });
  assert.throws(() => describeWalletTransaction(fromSponsor, expect), (e) => e.code === 'foreign_withdrawal');

  const otherPackage = await handBuilt((tx) => {
    tx.moveCall({ target: `${'0x' + 'ba'.repeat(32)}::drain::all`, arguments: [] });
  });
  assert.throws(() => describeWalletTransaction(otherPackage, expect), (e) => e.code === 'package_not_allowed');

  const otherFramework = await handBuilt((tx) => {
    const coin = tx.objectRef({ objectId: '0x' + '12'.repeat(32), version: 1, digest: toBase58(new Uint8Array(32).fill(2)) });
    tx.moveCall({ target: '0x2::transfer::public_transfer', typeArguments: ['0x2::coin::Coin<0x2::sui::SUI>'], arguments: [coin, tx.pure.address('0x' + '99'.repeat(32))] });
  });
  assert.throws(() => describeWalletTransaction(otherFramework, expect), (e) => e.code === 'command_not_allowed');

  const transferObjects = await handBuilt((tx) => {
    const coin = tx.objectRef({ objectId: '0x' + '12'.repeat(32), version: 1, digest: toBase58(new Uint8Array(32).fill(2)) });
    tx.transferObjects([coin], '0x' + '99'.repeat(32));
  });
  assert.throws(() => describeWalletTransaction(transferObjects, expect), (e) => e.code === 'command_not_allowed');
});

test('the sponsor pays only for its own, capped, address-balance gas, for the named sender', async () => {
  const bytes = await nominateWalletTx(chain, { founder: members[0].address, account, wallet: wallet.address, singleSigner: false, gas });
  const d = describeWalletTransaction(bytes, expect);
  assertSponsorable(d, { sponsor, senders: [members[0].address] });
  assert.throws(() => assertSponsorable(d, { sponsor, senders: [members[1].address] }), (e) => e instanceof SponsorRefused && e.code === 'wrong_sender');
  assert.throws(() => assertSponsorable(d, { sponsor: '0x' + '01'.repeat(32), senders: [members[0].address] }), (e) => e.code === 'not_our_gas');
  assert.throws(() => assertSponsorable(d, { sponsor, senders: [members[0].address], budgetCapMist: 1n }), (e) => e.code === 'budget');
  assert.throws(() => assertSponsorable({ ...d, gas: { ...d.gas, fromAddressBalance: false } }, { sponsor, senders: [members[0].address] }), (e) => e.code === 'gas_coin');
});

test('the hardware 2-of-3 check script combines two device signatures and refuses a foreign one (offline)', async () => {
  const { execFile } = await import('node:child_process');
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { keys, weights, threshold } = registrationArgs(wallet);
  const bytes = await registerWalletTx(chain, { wallet: wallet.address, account, keys, weights, threshold, singleSignerAck: false, gas });
  const sigs = [(await members[2].keypair.signTransaction(bytes)).signature, (await members[0].keypair.signTransaction(bytes)).signature];
  const dir = await mkdtemp(join(tmpdir(), 'splash-hw-'));
  const run = (evidence) =>
    writeFile(join(dir, 'e.json'), JSON.stringify(evidence)).then(
      () => new Promise((resolve) => execFile(process.execPath, ['scripts/wallet-hardware-check.mjs', join(dir, 'e.json')], (error, stdout) => resolve({ code: error ? error.code : 0, stdout }))),
    );
  const base = { publicKeys: members.map((m) => m.publicKey), threshold: 2, transactionBytes: Buffer.from(bytes).toString('base64') };
  const pass = await run({ ...base, signatures: sigs });
  assert.equal(pass.code, 0, pass.stdout);
  assert.match(pass.stdout, new RegExp(wallet.address));
  const stranger = softPasskey();
  const fail = await run({ ...base, signatures: [sigs[0], (await stranger.keypair.signTransaction(bytes)).signature] });
  assert.equal(fail.code, 1);
  assert.match(fail.stdout, /NOT a member/);
});

test('the v2 objects come from the environment or nothing is built', () => {
  assert.equal(v2ObjectIdsFromEnv({}).ok, false);
  const ok = v2ObjectIdsFromEnv({ SPLASH_CORE_PACKAGE_ID: CORE, SPLASH_COMPLIANCE_CONFIG_ID: CONFIG, SPLASH_FEE_CONFIG_ID: FEES, SPLASH_ADDRESS_REGISTRY_ID: REGISTRY });
  assert.equal(ok.ok, true);
  const partial = v2ObjectIdsFromEnv({ SPLASH_CORE_PACKAGE_ID: CORE, SPLASH_PACKAGE_ID: CORE });
  assert.match(partial.reason, /SPLASH_FEE_CONFIG_ID/);
});

test('the v2 builders call only v2 entry points that exist in the Phase 1 Move sources', async () => {
  const source = await readFile(new URL('../lib/server/sui-v2-builders.ts', import.meta.url), 'utf8');
  const targets = [...source.matchAll(/'(business_account|payment_intent|audit_anchor)::(\w+)'/g)].map((m) => [m[1], m[2]]);
  assert.ok(targets.length >= 8);
  for (const [module, fn] of targets) {
    const move = await readFile(new URL(`../move/splash_core/sources/${module}.move`, import.meta.url), 'utf8');
    assert.match(move, new RegExp(`public fun ${fn}(<[^>]*>)?\\(`), `${module}::${fn} is a public v2 function`);
  }
  // The v1 entry points are not reachable from the v2 builders.
  assert.doesNotMatch(source, /create_payment_intent\b|confirm_payment_intent\b|confirm_with_approval\b/);
});

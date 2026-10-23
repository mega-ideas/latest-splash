/**
 * Move and the SDK agree on every business wallet's address.
 *
 * `splash_core::multisig::derive_address` recomputes a Sui multisig address
 * from its members, and `business_account::register_wallet` refuses any sender
 * that does not match. If the Move derivation and the SDK's
 * `MultiSigPublicKey.toSuiAddress()` ever drifted apart, every wallet the
 * dashboard builds would be refused at registration, or worse, the vectors in
 * the Move tests would quietly stop meaning what they claim.
 *
 * So the SDK recomputes every vector in tests/fixtures/multisig-vectors.mjs,
 * and every key, weight, signer address and multisig address it produces must
 * appear, byte for byte, in move/splash_core/tests/multisig_tests.move.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { multisigVectors } from './fixtures/multisig-vectors.mjs';

const MOVE_TESTS = new URL('../move/splash_core/tests/multisig_tests.move', import.meta.url);

/** `0x00ab…` to the 64-hex-digit form Move writes after `@0x`. */
const full = (address) => address.replace(/^0x/, '').padStart(64, '0');

test('the Phase 0 testnet wallet is the first vector', () => {
  const [first] = multisigVectors();
  assert.equal(first.name, 'phase0_passkey_2_of_3');
  assert.equal(first.address, '0xafea5352bb6313c6af89594eac518d24049e5bc6dfd4bbc18a14bf191f82b6b5');
});

test('every SDK vector appears in the Move tests, byte for byte', async () => {
  const move = await readFile(MOVE_TESTS, 'utf8');
  for (const v of multisigVectors()) {
    assert.ok(
      move.includes(`/// ${v.name}\nconst ${v.name.toUpperCase()}: address = @0x${full(v.address)};`) ||
        move.includes(`/// ${v.name}\r\nconst ${v.name.toUpperCase()}: address = @0x${full(v.address)};`),
      `${v.name}: the Move tests do not carry the SDK's address ${v.address}`,
    );
    assert.ok(move.includes(`fun ${v.name}()`), `${v.name}: no Move test checks this vector`);
    for (const m of v.members) {
      assert.ok(move.includes(`x"${m.suiBytesHex}"`), `${v.name}: member ${m.suiBytesHex} is missing`);
      assert.ok(move.includes(`@0x${full(m.signerAddress)}`), `${v.name}: signer address ${m.signerAddress} is missing`);
    }
  }
});

test('each Move vector test passes the weights and threshold the SDK used', async () => {
  const move = await readFile(MOVE_TESTS, 'utf8');
  for (const v of multisigVectors()) {
    const body = move.slice(move.indexOf(`fun ${v.name}()`));
    const call = body.slice(0, body.indexOf('\n}'));
    const weights = `&vector[${v.members.map((m) => m.weight).join(', ')}], ${v.threshold})`;
    assert.ok(call.includes(weights), `${v.name}: expected derive_address(..., ${weights}`);
  }
});

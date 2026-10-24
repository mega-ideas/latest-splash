/**
 * Multisig address test vectors, computed by the TS SDK.
 *
 * `splash_core::multisig` recomputes a business wallet's address in Move from
 * its members' keys, and `register_wallet` refuses a sender that does not
 * match. These vectors are what the SDK's `MultiSigPublicKey.toSuiAddress()`
 * produces for the same members, so Move and the SDK cannot drift apart
 * silently: `tests/multisig-vectors.test.mjs` recomputes every vector here and
 * checks it against the constants in `move/splash_core/tests/multisig_tests.move`.
 *
 * Every key is fixed, and none of them signs anything: the private halves are
 * test constants, never used on any network. The first vector is the 2-of-3
 * passkey wallet the Phase 0 gate signed with on testnet
 * (docs/mainnet-checks-2026-10.md).
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { PasskeyPublicKey } from '@mysten/sui/keypairs/passkey';
import { Secp256k1Keypair } from '@mysten/sui/keypairs/secp256k1';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { fromHex, toHex } from '@mysten/sui/utils';
import { toZkLoginPublicIdentifier } from '@mysten/sui/zklogin';

const PHASE0_PASSKEYS = [
  '0355969b344645e48573e045cdbf4cbb0adb4369d411962cfc8a6ae3c33b8acf16',
  '025cb0f7961afbdc293a3cd22290d86697bcceb402011804a4e72119960f2741f9',
  '0399ca5c2f751fbe57d9e493e174085dee6144965b20fd5895e28902fb1148e04a',
];

const passkey = (hex) => new PasskeyPublicKey(fromHex(hex));
const seed = (byte) => new Uint8Array(32).fill(byte);

/** The schemes Sui accepts as multisig members, one fixed key each. */
export function memberKeys() {
  return {
    ed25519: Ed25519Keypair.fromSecretKey(seed(0x11)).getPublicKey(),
    secp256k1: Secp256k1Keypair.fromSecretKey(seed(0x22)).getPublicKey(),
    secp256r1: Secp256r1Keypair.fromSecretKey(seed(0x33)).getPublicKey(),
    // `legacyAddress: false` is the derivation lib/auth/zklogin.ts uses.
    zklogin: toZkLoginPublicIdentifier(
      123456789012345678901234567890n,
      'https://accounts.google.com',
      { legacyAddress: false },
    ),
    passkeys: PHASE0_PASSKEYS.map(passkey),
  };
}

function vector(name, members, threshold) {
  const multisig = MultiSigPublicKey.fromPublicKeys({
    threshold,
    publicKeys: members.map(({ key, weight }) => ({ publicKey: key, weight })),
  });
  return {
    name,
    threshold,
    members: members.map(({ key, weight }) => ({
      suiBytesHex: toHex(key.toSuiBytes()),
      weight,
      signerAddress: key.toSuiAddress(),
    })),
    address: multisig.toSuiAddress(),
  };
}

export function multisigVectors() {
  const k = memberKeys();
  const [p1, p2, p3] = k.passkeys;
  return [
    vector('phase0_passkey_2_of_3', [
      { key: p1, weight: 1 },
      { key: p2, weight: 1 },
      { key: p3, weight: 1 },
    ], 2),
    vector('mixed_passkey_zklogin_ed25519_2_of_3', [
      { key: p1, weight: 1 },
      { key: k.zklogin, weight: 1 },
      { key: k.ed25519, weight: 1 },
    ], 2),
    vector('passkey_1_of_1', [{ key: p1, weight: 1 }], 1),
    // A 2-of-3 by threshold that one member can meet alone.
    vector('weighted_single_signer_2_1_1', [
      { key: p1, weight: 2 },
      { key: p2, weight: 1 },
      { key: p3, weight: 1 },
    ], 2),
    vector('every_scheme_3_of_5', [
      { key: k.ed25519, weight: 1 },
      { key: k.secp256k1, weight: 1 },
      { key: k.secp256r1, weight: 1 },
      { key: k.zklogin, weight: 1 },
      { key: p1, weight: 1 },
    ], 3),
  ];
}

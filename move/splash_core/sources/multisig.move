/// Multisig — recompute a Sui multisig address from its members, in Move.
///
/// A business's Splash Wallet (D1) is a Sui native multisig address whose
/// members are the owners' passkeys, with zkLogin as the fallback. Splash has
/// no key to it. When the wallet registers itself against a `BusinessAccount`,
/// the account must be able to say WHICH multisig it is — its members, their
/// weights and its threshold — not just "some address that signed". So the
/// registration passes the members, this module recomputes the address the
/// protocol would derive from them, and `business_account` refuses a sender
/// that does not match.
///
/// That match is the proof. The validators only accept a transaction whose
/// sender is this exact hash of these exact members under a multisig signature
/// that meets the threshold, so a sender equal to the recomputed address has
/// demonstrably been signed by a quorum of exactly these keys.
///
/// ─── The derivation ─────────────────────────────────────────────────────────
///
///     address = blake2b256( 0x03
///                        || threshold as u16, little-endian
///                        || for each member: flag || public key bytes || weight as u8 )
///
/// It is what `MultiSigPublicKey.toSuiAddress()` computes in the TS SDK. The
/// vectors in `tests/multisig_tests.move` are produced by the SDK
/// (`tests/fixtures/multisig-vectors.mjs`) and `tests/multisig-vectors.test.mjs`
/// fails the build if the two ever disagree. The first vector is the 2-of-3
/// passkey wallet the Phase 0 gate signed with on testnet.
///
/// A member's own address — the one that signs when that person acts alone, as
/// an owner approving a payout does — is `blake2b256(flag || public key bytes)`.
/// That is how Sui derives a single-key address for every scheme accepted here.
///
/// ─── Why validate at all, when the sender check already proves it ───────────
///
/// For registration the sender check is sufficient on its own. For ROTATION it
/// is not: the new wallet has not signed anything yet, and a configuration the
/// protocol would reject — a threshold no quorum can reach, a duplicate member,
/// a key with the wrong length — would be an address nobody can ever sign for.
/// Every rule below is one of Sui's own `MultiSigPublicKey::new` rules, so this
/// module refuses exactly what the protocol would.
///
/// zkLogin members are accepted in the padded form only (a 32-byte address
/// seed). That is the form the SDK puts into a multisig, and the derivation
/// `lib/auth/zklogin.ts` uses (`legacyAddress: false`). A legacy, unpadded
/// identifier would derive a different multisig address than the one the
/// wallet actually signs as, so it is refused rather than silently mismatched.
module splash_core::multisig;

use sui::address;
use sui::hash;

// ─── Abort codes ───────────────────────────────────────────────────────────
/// No members, or more than Sui allows in one multisig.
const E_BAD_MEMBER_COUNT: u64 = 1200;
/// `keys` and `weights` have different lengths.
const E_LENGTH_MISMATCH: u64 = 1201;
/// A member has weight zero.
const E_ZERO_WEIGHT: u64 = 1202;
/// The threshold is zero.
const E_ZERO_THRESHOLD: u64 = 1203;
/// The weights cannot add up to the threshold, so no quorum can ever sign.
const E_UNREACHABLE_THRESHOLD: u64 = 1204;
/// The same key appears twice.
const E_DUPLICATE_MEMBER: u64 = 1205;
/// A key's first byte is not a scheme Sui accepts in a multisig.
const E_UNKNOWN_SCHEME: u64 = 1206;
/// A key's length is wrong for its scheme.
const E_BAD_KEY_LENGTH: u64 = 1207;
/// The sender is not the multisig these members derive.
const E_NOT_THIS_MULTISIG: u64 = 1208;
/// The multisig lets one member sign alone, so it is not a quorum.
const E_NOT_A_QUORUM: u64 = 1209;

// ─── Constants ─────────────────────────────────────────────────────────────
/// Sui's `MAX_SIGNER_IN_MULTISIG`.
const MAX_MEMBERS: u64 = 10;

const FLAG_ED25519: u8 = 0x00;
const FLAG_SECP256K1: u8 = 0x01;
const FLAG_SECP256R1: u8 = 0x02;
const FLAG_MULTISIG: u8 = 0x03;
const FLAG_ZKLOGIN: u8 = 0x05;
const FLAG_PASSKEY: u8 = 0x06;

/// Flag byte plus a 32-byte Ed25519 key.
const ED25519_KEY_BYTES: u64 = 33;
/// Flag byte plus a 33-byte compressed Secp256k1, Secp256r1 or passkey key.
const COMPRESSED_KEY_BYTES: u64 = 34;
/// A zkLogin identifier: flag, issuer length, issuer, 32-byte address seed.
const ZKLOGIN_SEED_BYTES: u64 = 32;

// ─── The derivation ────────────────────────────────────────────────────────

/// The multisig address of these members under this threshold. Aborts on any
/// configuration Sui would refuse to build.
public fun derive_address(keys: &vector<vector<u8>>, weights: &vector<u8>, threshold: u16): address {
    assert_valid(keys, weights, threshold);

    let mut bytes = vector[FLAG_MULTISIG, ((threshold & 0xff) as u8), ((threshold >> 8) as u8)];
    let mut i = 0;
    while (i < keys.length()) {
        bytes.append(keys[i]);
        bytes.push_back(weights[i]);
        i = i + 1;
    };
    address::from_bytes(hash::blake2b256(&bytes))
}

/// One member's own single-key address: `blake2b256(flag || public key)`.
public fun signer_address(key: &vector<u8>): address {
    assert_key(key);
    address::from_bytes(hash::blake2b256(key))
}

/// Every member's own address, in member order.
public fun signer_addresses(keys: &vector<vector<u8>>): vector<address> {
    let mut out = vector[];
    let mut i = 0;
    while (i < keys.length()) {
        out.push_back(signer_address(&keys[i]));
        i = i + 1;
    };
    out
}

/// True if any ONE member can meet the threshold alone.
///
/// This, not `threshold < 2`, is what "single signer" means. A 2-of-3 whose
/// first member has weight 2 is a 1-of-N in disguise, and D1 allows that only
/// when the business explicitly chooses it.
public fun is_single_signer(weights: &vector<u8>, threshold: u16): bool {
    let mut i = 0;
    while (i < weights.length()) {
        if ((weights[i] as u16) >= threshold) return true;
        i = i + 1;
    };
    false
}

/// The sender is a multisig of these members that no single member can sign
/// for alone.
///
/// Governance acts (registry additions, wrapping and re-homing the upgrade
/// cap) call this, so "never by a single key" is a property the chain checks,
/// not one that rests on where `AdminCap` happens to be held. One caveat it
/// cannot see: a multisig whose quorum has signed `address_alias::add` can be
/// sent for by the aliased key alone (docs/v2/phase1-move-design.md §1).
public fun assert_quorum_sender(
    keys: &vector<vector<u8>>,
    weights: &vector<u8>,
    threshold: u16,
    ctx: &TxContext,
) {
    assert!(derive_address(keys, weights, threshold) == ctx.sender(), E_NOT_THIS_MULTISIG);
    assert!(!is_single_signer(weights, threshold), E_NOT_A_QUORUM);
}

/// Sui's own rules for a multisig, from `MultiSigPublicKey::new`.
public fun assert_valid(keys: &vector<vector<u8>>, weights: &vector<u8>, threshold: u16) {
    let n = keys.length();
    assert!(n >= 1 && n <= MAX_MEMBERS, E_BAD_MEMBER_COUNT);
    assert!(weights.length() == n, E_LENGTH_MISMATCH);
    assert!(threshold > 0, E_ZERO_THRESHOLD);

    // Ten members of weight at most 255 sum to at most 2,550, so u16 holds it.
    let mut total: u16 = 0;
    let mut i = 0;
    while (i < n) {
        assert!(weights[i] > 0, E_ZERO_WEIGHT);
        total = total + (weights[i] as u16);
        assert_key(&keys[i]);
        let mut j = i + 1;
        while (j < n) {
            assert!(keys[i] != keys[j], E_DUPLICATE_MEMBER);
            j = j + 1;
        };
        i = i + 1;
    };
    assert!(total >= threshold, E_UNREACHABLE_THRESHOLD);
}

/// A key is `flag || public key`, with the length its scheme requires.
fun assert_key(key: &vector<u8>) {
    let len = key.length();
    assert!(len > 0, E_BAD_KEY_LENGTH);
    let flag = key[0];
    if (flag == FLAG_ED25519) {
        assert!(len == ED25519_KEY_BYTES, E_BAD_KEY_LENGTH);
    } else if (flag == FLAG_SECP256K1 || flag == FLAG_SECP256R1 || flag == FLAG_PASSKEY) {
        assert!(len == COMPRESSED_KEY_BYTES, E_BAD_KEY_LENGTH);
    } else if (flag == FLAG_ZKLOGIN) {
        // flag (1) || iss_len (1) || iss (iss_len) || address seed (32)
        assert!(len > 2, E_BAD_KEY_LENGTH);
        let iss_len = (key[1] as u64);
        assert!(iss_len > 0, E_BAD_KEY_LENGTH);
        assert!(len == 2 + iss_len + ZKLOGIN_SEED_BYTES, E_BAD_KEY_LENGTH);
    } else {
        abort E_UNKNOWN_SCHEME
    }
}

/// Sui's per-multisig member limit.
public fun max_members(): u64 { MAX_MEMBERS }

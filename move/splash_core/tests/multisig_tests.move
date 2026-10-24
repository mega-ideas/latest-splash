/// `multisig` recomputes the address the protocol derives for a set of members.
///
/// Every vector here is produced by the TS SDK's `MultiSigPublicKey` from
/// `tests/fixtures/multisig-vectors.mjs`, and `tests/multisig-vectors.test.mjs`
/// fails if a key, a weight, a signer address or a multisig address below
/// stops matching what the SDK computes. The first vector is the 2-of-3
/// passkey wallet the Phase 0 gate signed with on testnet.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::multisig_tests;

use splash_core::multisig;
use std::unit_test::assert_eq;

// ─── Members (flag || public key) ───────────────────────────────────────────

const PASSKEY_1: vector<u8> = x"060355969b344645e48573e045cdbf4cbb0adb4369d411962cfc8a6ae3c33b8acf16";
const PASSKEY_2: vector<u8> = x"06025cb0f7961afbdc293a3cd22290d86697bcceb402011804a4e72119960f2741f9";
const PASSKEY_3: vector<u8> = x"060399ca5c2f751fbe57d9e493e174085dee6144965b20fd5895e28902fb1148e04a";
const ZKLOGIN: vector<u8> = x"051b68747470733a2f2f6163636f756e74732e676f6f676c652e636f6d00000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad2";
const ED25519: vector<u8> = x"00d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
const SECP256K1: vector<u8> = x"0102466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27";
const SECP256R1: vector<u8> = x"020351a7580833898ea1b183cbd7350a4099078c6ef1c1e18e970cd7683035f25e7d";

// ─── Each member's own address ─────────────────────────────────────────────

const PASSKEY_1_ADDRESS: address = @0xf22bbbc884a1184c6f3da3fff986c2f05c977e70a142ee8e2550b22a33890253;
const PASSKEY_2_ADDRESS: address = @0xed53becafe1911c288e33fa008d03e86b63131e55e226abe103e47dce34e61fa;
const PASSKEY_3_ADDRESS: address = @0xcfbaedef6b0b04e2fa6e40f6981aa3257e9cdbc097738346e75533f423fff067;
const ZKLOGIN_ADDRESS: address = @0x8c7b637e2e13e728dd412b186e170eb3d5d4031f4cc11883fb14e5487a4eaa1c;
const ED25519_ADDRESS: address = @0x0881c07520943bbf13989b92892093c1b50672156fa5f873c22892701cb2e207;
const SECP256K1_ADDRESS: address = @0xe059fa59fda3d2f6942a7434b7f4fbe1478d6409e858a02e07ebb0e204d14627;
const SECP256R1_ADDRESS: address = @0x5122557a84a87cb35116817c2172c7b1e93c56fa7cb6b71d9d6133e9ce6a06f2;

// ─── Multisig addresses, by vector name ────────────────────────────────────

/// phase0_passkey_2_of_3
const PHASE0_PASSKEY_2_OF_3: address = @0xafea5352bb6313c6af89594eac518d24049e5bc6dfd4bbc18a14bf191f82b6b5;
/// mixed_passkey_zklogin_ed25519_2_of_3
const MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3: address = @0x017a504ea8bd39eba683e035e47a5dd77d14a8b065cea4d313120e7e8c94fca0;
/// passkey_1_of_1
const PASSKEY_1_OF_1: address = @0x542f90eeed1c3562b33c4d81d7daf9571b91497acea2c5c6b6759290a569fe8f;
/// weighted_single_signer_2_1_1
const WEIGHTED_SINGLE_SIGNER_2_1_1: address = @0xe461c942f4635e04fd72371ab24ff27c8eda59582f7a0f054cf2c14f2ad1d350;
/// every_scheme_3_of_5
const EVERY_SCHEME_3_OF_5: address = @0x2b62fd91a32ce61aabd6e5e7443ec1b221d3350ae983a1b56de65c30ae62bc0d;

// ─── The SDK's addresses ───────────────────────────────────────────────────

#[test]
fun phase0_passkey_2_of_3() {
    let keys = vector[PASSKEY_1, PASSKEY_2, PASSKEY_3];
    assert_eq!(multisig::derive_address(&keys, &vector[1, 1, 1], 2), PHASE0_PASSKEY_2_OF_3);
    assert!(!multisig::is_single_signer(&vector[1, 1, 1], 2));
}

#[test]
fun mixed_passkey_zklogin_ed25519_2_of_3() {
    let keys = vector[PASSKEY_1, ZKLOGIN, ED25519];
    assert_eq!(multisig::derive_address(&keys, &vector[1, 1, 1], 2), MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3);
}

#[test]
fun passkey_1_of_1() {
    assert_eq!(multisig::derive_address(&vector[PASSKEY_1], &vector[1], 1), PASSKEY_1_OF_1);
    assert!(multisig::is_single_signer(&vector[1], 1));
}

#[test]
/// Threshold 2 reads as two-person, but member one has weight 2 and signs
/// alone. That is single-signer, and `is_single_signer` must say so.
fun weighted_single_signer_2_1_1() {
    let keys = vector[PASSKEY_1, PASSKEY_2, PASSKEY_3];
    assert_eq!(multisig::derive_address(&keys, &vector[2, 1, 1], 2), WEIGHTED_SINGLE_SIGNER_2_1_1);
    assert!(multisig::is_single_signer(&vector[2, 1, 1], 2));
}

#[test]
fun every_scheme_3_of_5() {
    let keys = vector[ED25519, SECP256K1, SECP256R1, ZKLOGIN, PASSKEY_1];
    assert_eq!(multisig::derive_address(&keys, &vector[1, 1, 1, 1, 1], 3), EVERY_SCHEME_3_OF_5);
}

#[test]
/// The same members in a different order are a different wallet. The address
/// commits to the order, so a registration must pass the members exactly as
/// the wallet was built.
fun member_order_changes_the_address() {
    let reordered = vector[PASSKEY_2, PASSKEY_1, PASSKEY_3];
    assert!(multisig::derive_address(&reordered, &vector[1, 1, 1], 2) != PHASE0_PASSKEY_2_OF_3);
}

#[test]
fun signer_addresses_match_the_sdk() {
    assert_eq!(multisig::signer_address(&PASSKEY_1), PASSKEY_1_ADDRESS);
    assert_eq!(multisig::signer_address(&PASSKEY_2), PASSKEY_2_ADDRESS);
    assert_eq!(multisig::signer_address(&PASSKEY_3), PASSKEY_3_ADDRESS);
    assert_eq!(multisig::signer_address(&ZKLOGIN), ZKLOGIN_ADDRESS);
    assert_eq!(multisig::signer_address(&ED25519), ED25519_ADDRESS);
    assert_eq!(multisig::signer_address(&SECP256K1), SECP256K1_ADDRESS);
    assert_eq!(multisig::signer_address(&SECP256R1), SECP256R1_ADDRESS);
    assert_eq!(
        multisig::signer_addresses(&vector[PASSKEY_1, ZKLOGIN, ED25519]),
        vector[PASSKEY_1_ADDRESS, ZKLOGIN_ADDRESS, ED25519_ADDRESS],
    );
}

#[test]
/// The multisig address is never one of its members' own addresses: the 0x03
/// prefix separates the two derivations.
fun a_1_of_1_wallet_is_not_its_member() {
    assert!(PASSKEY_1_OF_1 != PASSKEY_1_ADDRESS);
}

// ─── Configurations Sui refuses ────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = multisig::E_BAD_MEMBER_COUNT)]
fun no_members_is_refused() {
    multisig::derive_address(&vector[], &vector[], 1);
}

#[test]
#[expected_failure(abort_code = multisig::E_BAD_MEMBER_COUNT)]
fun eleven_members_is_refused() {
    let mut keys = vector[];
    let mut weights = vector[];
    let mut i: u8 = 0;
    while (i < 11) {
        let mut key = ED25519;
        // Change the last byte so every member is distinct.
        let last = key.length() - 1;
        *&mut key[last] = i;
        keys.push_back(key);
        weights.push_back(1);
        i = i + 1;
    };
    multisig::derive_address(&keys, &weights, 1);
}

#[test]
fun ten_members_is_allowed() {
    let mut keys = vector[];
    let mut weights = vector[];
    let mut i: u8 = 0;
    while (i < 10) {
        let mut key = ED25519;
        let last = key.length() - 1;
        *&mut key[last] = i;
        keys.push_back(key);
        weights.push_back(1);
        i = i + 1;
    };
    multisig::derive_address(&keys, &weights, 10);
}

#[test]
#[expected_failure(abort_code = multisig::E_LENGTH_MISMATCH)]
fun weights_must_match_keys() {
    multisig::derive_address(&vector[PASSKEY_1, PASSKEY_2], &vector[1], 1);
}

#[test]
#[expected_failure(abort_code = multisig::E_ZERO_WEIGHT)]
fun a_zero_weight_is_refused() {
    multisig::derive_address(&vector[PASSKEY_1, PASSKEY_2], &vector[1, 0], 1);
}

#[test]
#[expected_failure(abort_code = multisig::E_ZERO_THRESHOLD)]
fun a_zero_threshold_is_refused() {
    multisig::derive_address(&vector[PASSKEY_1], &vector[1], 0);
}

#[test]
#[expected_failure(abort_code = multisig::E_UNREACHABLE_THRESHOLD)]
fun an_unreachable_threshold_is_refused() {
    multisig::derive_address(&vector[PASSKEY_1, PASSKEY_2], &vector[1, 1], 3);
}

#[test]
#[expected_failure(abort_code = multisig::E_DUPLICATE_MEMBER)]
fun a_duplicate_member_is_refused() {
    multisig::derive_address(&vector[PASSKEY_1, PASSKEY_2, PASSKEY_1], &vector[1, 1, 1], 2);
}

#[test]
#[expected_failure(abort_code = multisig::E_UNKNOWN_SCHEME)]
fun a_multisig_member_flag_is_refused() {
    // 0x03 is the multisig flag itself; a multisig cannot be a member.
    let mut key = PASSKEY_1;
    *&mut key[0] = 0x03;
    multisig::derive_address(&vector[key], &vector[1], 1);
}

#[test]
#[expected_failure(abort_code = multisig::E_UNKNOWN_SCHEME)]
fun an_unknown_flag_is_refused() {
    let mut key = PASSKEY_1;
    *&mut key[0] = 0x07;
    multisig::derive_address(&vector[key], &vector[1], 1);
}

#[test]
#[expected_failure(abort_code = multisig::E_BAD_KEY_LENGTH)]
fun a_short_passkey_is_refused() {
    let mut key = PASSKEY_1;
    key.pop_back();
    multisig::derive_address(&vector[key], &vector[1], 1);
}

#[test]
#[expected_failure(abort_code = multisig::E_BAD_KEY_LENGTH)]
fun an_uncompressed_length_ed25519_is_refused() {
    let mut key = ED25519;
    key.push_back(0);
    multisig::derive_address(&vector[key], &vector[1], 1);
}

#[test]
#[expected_failure(abort_code = multisig::E_BAD_KEY_LENGTH)]
/// A legacy zkLogin identifier carries an unpadded seed. The SDK pads it before
/// building a multisig, so the unpadded form would derive the wrong address.
fun an_unpadded_zklogin_seed_is_refused() {
    let mut key = ZKLOGIN;
    // Drop one leading zero byte of the 32-byte seed (offset 2 + 27).
    key.remove(29);
    multisig::derive_address(&vector[key], &vector[1], 1);
}

#[test]
#[expected_failure(abort_code = multisig::E_BAD_KEY_LENGTH)]
fun a_zklogin_with_no_issuer_is_refused() {
    multisig::signer_address(&x"0500");
}

#[test]
#[expected_failure(abort_code = multisig::E_BAD_KEY_LENGTH)]
fun an_empty_key_is_refused() {
    multisig::signer_address(&vector[]);
}

#[test]
fun single_signer_is_about_weight_not_threshold() {
    assert!(multisig::is_single_signer(&vector[1, 1], 1));
    assert!(!multisig::is_single_signer(&vector[1, 1], 2));
    assert!(multisig::is_single_signer(&vector[1, 3, 1], 3));
    assert!(!multisig::is_single_signer(&vector[2, 2, 2], 3));
}

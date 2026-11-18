#[test_only]
#[allow(implicit_const_copy)]
/// B3 (pre-audit, 13 Nov 2026): what `audit_anchor::anchor` accepts. The
/// content hash is a 32-byte digest (`lib/server/payment-record.ts` anchors a
/// sha256) and the Walrus blob id is at most 64 bytes (the app's is the 43
/// bytes of base64url text of a 32-byte id).
module splash_core::anchor_input_tests;

use splash_core::audit_anchor;
use splash_core::business_account::BusinessAccount;
use splash_core::compliance_config::ComplianceConfig;
use splash_core::payment_intent;
use splash_core::v2_harness::{Self as h, USDC};
use sui::clock::Clock;
use sui::coin;
use sui::test_scenario as ts;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";
/// The app's real shape: base64url text of a 32-byte blob id.
const BLOB_43: vector<u8> = b"M4hsZGQ1oCktdzegB6HnI6Mi28S2nqOPHxK-W7_4BUk";
/// Exactly at the bound.
const BLOB_64: vector<u8> = b"0123456789012345678901234567890123456789012345678901234567890123";
/// One byte over it.
const BLOB_65: vector<u8> = b"01234567890123456789012345678901234567890123456789012345678901234";

fun settle_and_anchor(hash: vector<u8>, blob: vector<u8>) {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let mut intent = h::wallet_intent(&mut account, &config, 1, h::amount(), &c, s.ctx());
    let payment = coin::mint_for_testing<USDC>(h::amount(), s.ctx());
    let receipt = h::confirm(&mut intent, &mut account, &config, payment, h::settle_by(&c), &c, s.ctx());
    audit_anchor::anchor(receipt, hash, blob, &c, s.ctx());
    payment_intent::delete_finalized(intent);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    s.end();
}

#[test]
fun a_32_byte_hash_and_the_apps_blob_id_anchor() {
    settle_and_anchor(HASH, BLOB_43);
}

#[test]
fun a_short_test_blob_id_still_anchors() {
    settle_and_anchor(HASH, BLOB);
}

#[test]
fun a_64_byte_blob_id_anchors() {
    settle_and_anchor(HASH, BLOB_64);
}

#[test]
#[expected_failure(abort_code = audit_anchor::E_BAD_HASH_LENGTH)]
fun a_31_byte_hash_is_refused() {
    settle_and_anchor(b"0123456789abcdef0123456789abcde", BLOB);
}

#[test]
#[expected_failure(abort_code = audit_anchor::E_BAD_HASH_LENGTH)]
fun a_33_byte_hash_is_refused() {
    settle_and_anchor(b"0123456789abcdef0123456789abcdef0", BLOB);
}

#[test]
#[expected_failure(abort_code = audit_anchor::E_BAD_HASH_LENGTH)]
fun the_64_characters_of_a_hex_hash_are_refused() {
    // What scripts/e2e-testnet.mjs passed before B3: the hex TEXT of a sha256.
    settle_and_anchor(b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", BLOB);
}

#[test]
#[expected_failure(abort_code = audit_anchor::E_BLOB_TOO_LONG)]
fun a_65_byte_blob_id_is_refused() {
    settle_and_anchor(HASH, BLOB_65);
}

#[test]
#[expected_failure(abort_code = audit_anchor::E_EMPTY_HASH)]
fun an_empty_hash_is_still_refused_as_empty() {
    settle_and_anchor(b"", BLOB);
}

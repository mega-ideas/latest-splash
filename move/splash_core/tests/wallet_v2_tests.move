/// v2 business wallet tests (docs/v2/phase1-move-design.md section 2, brief
/// 3.2 and 3.8, review item A5).
///
/// The business wallet is the owners' Sui multisig. Once it is registered it
/// pays from the business's own address balances, funds spending rules and
/// releases an owner freeze, so the record of WHICH multisig it is must be
/// writable by that multisig alone. These tests are written from the spec,
/// not from the code: the founder names the wallet, the wallet registers
/// itself with members who are all owners, single-signer wallets are chosen
/// by the founder and acknowledged by the wallet, rotation takes two
/// signatures (the old wallet and the new one), and no approver, stranger or
/// `AdminCap` holder has any path in.
///
/// Move tests do not check signatures, so a test acts as a multisig by sending
/// as its address. The code under test is what binds that address to its
/// members, which is exactly what is being tested.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::wallet_v2_tests;

use splash_core::business_account::{Self, BusinessAccount};
use splash_core::multisig;
use splash_core::v2_harness as h;
use std::unit_test::assert_eq;
use sui::test_scenario::{Self as ts, Scenario};

// ─── Members that are not the Phase 0 passkeys ─────────────────────────────
// From `multisig_tests.move`; each vector is pinned against the TS SDK there.

const ED25519: vector<u8> = x"00d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
const ZKLOGIN: vector<u8> = x"051b68747470733a2f2f6163636f756e74732e676f6f676c652e636f6d00000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad2";
const ED25519_ADDRESS: address = @0x0881c07520943bbf13989b92892093c1b50672156fa5f873c22892701cb2e207;
const ZKLOGIN_ADDRESS: address = @0x8c7b637e2e13e728dd412b186e170eb3d5d4031f4cc11883fb14e5487a4eaa1c;

// ─── SDK multisig addresses (multisig_tests.move) ──────────────────────────

/// passkey_1_of_1: PASSKEY_1 alone, weight 1, threshold 1. Its one member is
/// owner 1, the founder.
const PASSKEY_1_OF_1: address = @0x542f90eeed1c3562b33c4d81d7daf9571b91497acea2c5c6b6759290a569fe8f;
/// weighted_single_signer_2_1_1: the three passkeys, weights [2, 1, 1],
/// threshold 2. Reads as two-person; member one signs alone.
const WEIGHTED_SINGLE_SIGNER_2_1_1: address = @0xe461c942f4635e04fd72371ab24ff27c8eda59582f7a0f054cf2c14f2ad1d350;
/// mixed_passkey_zklogin_ed25519_2_of_3: PASSKEY_1, ZKLOGIN, ED25519.
const MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3: address = @0x017a504ea8bd39eba683e035e47a5dd77d14a8b065cea4d313120e7e8c94fca0;

// ─── Parties with no wallet authority ──────────────────────────────────────

const STRANGER: address = @0xBAD;
/// In the account's legacy approver set, and nothing else.
const APPROVER: address = @0xBEEF;
/// Holds `AdminCap`: governance, which can stop an account but must never be
/// able to choose who pays from it.
const GOVERNANCE: address = @0xAD;
/// Reads views. Sends nothing that changes state.
const OBSERVER: address = @0x0B5;

// ─── Member sets ───────────────────────────────────────────────────────────

fun p1(): vector<u8> { h::passkey(0) }
fun p2(): vector<u8> { h::passkey(1) }
fun p3(): vector<u8> { h::passkey(2) }

/// Wallet B: a 2-of-2 of owners 1 and 2. A genuine quorum, and a different
/// address from the harness's 2-of-3.
fun b_keys(): vector<vector<u8>> { vector[p1(), p2()] }
fun b_weights(): vector<u8> { vector[1, 1] }
fun b_threshold(): u16 { 2 }
fun wallet_b(): address { multisig::derive_address(&b_keys(), &b_weights(), b_threshold()) }

/// A distinct Ed25519 member for each `i`, for wallets of many members.
fun ed25519_member(i: u8): vector<u8> {
    let mut key = ED25519;
    let last = key.length() - 1;
    *&mut key[last] = i;
    key
}

/// `n` distinct Ed25519 members, each of weight 1.
fun ed25519_members(n: u8): (vector<vector<u8>>, vector<u8>) {
    let mut keys = vector[];
    let mut weights = vector[];
    let mut i: u8 = 0;
    while (i < n) {
        keys.push_back(ed25519_member(i));
        weights.push_back(1);
        i = i + 1;
    };
    (keys, weights)
}

// ─── One transaction each ──────────────────────────────────────────────────

fun nominate(s: &mut Scenario, by: address, wallet: address, single_signer: bool) {
    s.next_tx(by);
    let mut account = s.take_shared<BusinessAccount>();
    business_account::nominate_wallet(&mut account, wallet, single_signer, s.ctx());
    ts::return_shared(account);
}

fun register(
    s: &mut Scenario,
    by: address,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    single_signer_ack: bool,
) {
    s.next_tx(by);
    let mut account = s.take_shared<BusinessAccount>();
    business_account::register_wallet(&mut account, keys, weights, threshold, single_signer_ack, s.ctx());
    ts::return_shared(account);
}

fun rotate(
    s: &mut Scenario,
    by: address,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    single_signer_ack: bool,
) {
    s.next_tx(by);
    let mut account = s.take_shared<BusinessAccount>();
    business_account::rotate_wallet(&mut account, keys, weights, threshold, single_signer_ack, s.ctx());
    ts::return_shared(account);
}

/// The registered 2-of-3 proposes wallet B.
fun rotate_to_b(s: &mut Scenario) {
    rotate(s, h::wallet(), b_keys(), b_weights(), b_threshold(), false);
}

fun confirm(s: &mut Scenario, by: address) {
    s.next_tx(by);
    let mut account = s.take_shared<BusinessAccount>();
    business_account::confirm_wallet_rotation(&mut account, s.ctx());
    ts::return_shared(account);
}

fun cancel(s: &mut Scenario, by: address) {
    s.next_tx(by);
    let mut account = s.take_shared<BusinessAccount>();
    business_account::cancel_wallet_rotation(&mut account, s.ctx());
    ts::return_shared(account);
}

fun freeze_as(s: &mut Scenario, by: address) {
    s.next_tx(by);
    let mut account = s.take_shared<BusinessAccount>();
    business_account::freeze_account(&mut account, s.ctx());
    ts::return_shared(account);
}

fun unfreeze_as(s: &mut Scenario, by: address) {
    s.next_tx(by);
    let mut account = s.take_shared<BusinessAccount>();
    business_account::unfreeze_account(&mut account, s.ctx());
    ts::return_shared(account);
}

fun admin_freeze(s: &mut Scenario) {
    s.next_tx(GOVERNANCE);
    let mut account = s.take_shared<BusinessAccount>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    business_account::admin_freeze(&admin, &mut account, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(account);
}

fun admin_unfreeze(s: &mut Scenario) {
    s.next_tx(GOVERNANCE);
    let mut account = s.take_shared<BusinessAccount>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    business_account::admin_unfreeze(&admin, &mut account, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(account);
}

/// The founder adds `who` as an owner.
fun add_owner(s: &mut Scenario, who: address) {
    s.next_tx(h::founder());
    let mut account = s.take_shared<BusinessAccount>();
    business_account::add_owner(&mut account, who, s.ctx());
    ts::return_shared(account);
}

/// The founder adds `who` as a legacy approver.
fun add_approver(s: &mut Scenario, who: address) {
    s.next_tx(h::founder());
    let mut account = s.take_shared<BusinessAccount>();
    business_account::add_approver(&mut account, who, s.ctx());
    ts::return_shared(account);
}

/// The shared account, for reading. The caller returns it.
fun take(s: &mut Scenario): BusinessAccount {
    s.next_tx(OBSERVER);
    s.take_shared<BusinessAccount>()
}

fun authority_epoch(s: &mut Scenario): u64 {
    let account = take(s);
    let epoch = business_account::authority_epoch(&account);
    ts::return_shared(account);
    epoch
}

fun owners_123(): vector<address> { vector[h::owner_1(), h::owner_2(), h::owner_3()] }

// ═══ The pinned vectors this file relies on ════════════════════════════════

#[test]
/// Every second wallet below is named by its SDK address. If the derivation
/// drifted, a test could pass against the wrong wallet, so the vectors are
/// re-derived here before anything depends on them.
fun the_second_wallets_are_the_sdk_vectors() {
    assert_eq!(multisig::derive_address(&h::keys(), &h::weights(), h::threshold()), h::wallet());
    assert_eq!(multisig::derive_address(&vector[p1()], &vector[1], 1), PASSKEY_1_OF_1);
    assert_eq!(multisig::derive_address(&h::keys(), &vector[2, 1, 1], 2), WEIGHTED_SINGLE_SIGNER_2_1_1);
    assert_eq!(
        multisig::derive_address(&vector[p1(), ZKLOGIN, ED25519], &vector[1, 1, 1], 2),
        MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3,
    );
    assert_eq!(multisig::signer_addresses(&h::keys()), owners_123());
    assert!(wallet_b() != h::wallet());
}

// ═══ Views before registration ═════════════════════════════════════════════

#[test]
/// A new account has no wallet, no wallet generation and no nomination. The
/// spending rules and the wallet payment path key off these, so "nothing yet"
/// must read as nothing, not as a zero address or a stale value.
fun an_account_starts_with_no_wallet() {
    let mut s = h::setup_without_wallet();
    let account = take(&mut s);
    assert!(!business_account::has_wallet(&account));
    assert_eq!(business_account::wallet_epoch(&account), 0);
    assert_eq!(business_account::wallet_threshold(&account), 0);
    assert_eq!(business_account::wallet_signers(&account), vector<address>[]);
    assert!(!business_account::is_single_signer_wallet(&account));
    assert_eq!(business_account::nominated_wallet(&account), option::none());
    assert!(!business_account::nominated_single_signer(&account));
    assert!(!business_account::has_pending_wallet(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NO_WALLET)]
/// `wallet()` must not return a default address for an account that has no
/// wallet: a caller comparing a sender to it would match @0x0.
fun the_wallet_view_aborts_when_there_is_none() {
    let mut s = h::setup_without_wallet();
    let account = take(&mut s);
    business_account::wallet(&account);
    ts::return_shared(account);
    s.end();
}

// ═══ Nomination: the founder alone names the wallet ════════════════════════

#[test]
/// The founder's nomination fixes both the address and the single-signer
/// choice, and the views show exactly what was chosen.
fun the_founder_nominates_the_wallet() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    let account = take(&mut s);
    assert_eq!(business_account::nominated_wallet(&account), option::some(h::wallet()));
    assert!(!business_account::nominated_single_signer(&account));
    // A nomination is not a registration.
    assert!(!business_account::has_wallet(&account));
    assert_eq!(business_account::wallet_epoch(&account), 0);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_FOUNDER)]
/// R2. If any owner could nominate, one co-owner could nominate a 1-of-1 of
/// their own key, register it first, and hold the only key that can rotate it.
fun a_co_owner_cannot_nominate() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::owner_2(), h::wallet(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_FOUNDER)]
/// A legacy approver releases payouts; it has no say in who the wallet is.
fun an_approver_cannot_nominate() {
    let mut s = h::setup_without_wallet();
    add_approver(&mut s, APPROVER);
    nominate(&mut s, APPROVER, h::wallet(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_FOUNDER)]
/// The account is shared, so anybody can pass it in. Possession of the
/// reference must prove nothing.
fun a_stranger_cannot_nominate() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, STRANGER, h::wallet(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_FOUNDER)]
/// Governance can stop an account. It must not be able to point an account at
/// a wallet it chose.
fun the_admin_cap_holder_cannot_nominate() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, GOVERNANCE, h::wallet(), false);
    s.end();
}

#[test]
/// Re-nominating before registration replaces the earlier choice entirely:
/// the address and the single-signer flag. The replacement is the one that
/// registers.
fun re_nomination_replaces_the_earlier_choice() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    nominate(&mut s, h::founder(), WEIGHTED_SINGLE_SIGNER_2_1_1, true);
    {
        let account = take(&mut s);
        assert_eq!(business_account::nominated_wallet(&account), option::some(WEIGHTED_SINGLE_SIGNER_2_1_1));
        assert!(business_account::nominated_single_signer(&account));
        ts::return_shared(account);
    };
    register(&mut s, WEIGHTED_SINGLE_SIGNER_2_1_1, h::keys(), vector[2, 1, 1], 2, true);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), WEIGHTED_SINGLE_SIGNER_2_1_1);
    assert!(business_account::is_single_signer_wallet(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// The wallet the founder replaced has lost its claim. Otherwise a nomination
/// could never be withdrawn.
fun a_replaced_nomination_cannot_register() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    nominate(&mut s, h::founder(), WEIGHTED_SINGLE_SIGNER_2_1_1, true);
    register(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOMINATION_MISMATCH)]
/// Re-nominating the same address replaces the single-signer choice too. A
/// founder who changes their mind about a 1-of-1 must be able to take that
/// choice back before it registers.
fun re_nomination_withdraws_a_single_signer_choice() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), PASSKEY_1_OF_1, true);
    nominate(&mut s, h::founder(), PASSKEY_1_OF_1, false);
    register(&mut s, PASSKEY_1_OF_1, vector[p1()], vector[1], 1, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_ALREADY_REGISTERED)]
/// After registration the wallet changes only by rotation, which the wallet
/// signs. A founder who could still nominate would be one key replacing the
/// quorum.
fun no_nomination_after_registration() {
    let mut s = h::setup();
    nominate(&mut s, h::founder(), WEIGHTED_SINGLE_SIGNER_2_1_1, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_ALREADY_REGISTERED)]
/// Rotation does not reopen nomination either.
fun no_nomination_after_a_rotation() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    confirm(&mut s, wallet_b());
    nominate(&mut s, h::founder(), h::wallet(), false);
    s.end();
}

#[test]
/// Registration consumes the nomination, so a later read cannot mistake it
/// for an open claim.
fun registration_consumes_the_nomination() {
    let mut s = h::setup();
    let account = take(&mut s);
    assert_eq!(business_account::nominated_wallet(&account), option::none());
    assert!(!business_account::nominated_single_signer(&account));
    ts::return_shared(account);
    s.end();
}

// ═══ Registration: the sender is the nominated, derived multisig ═══════════

#[test]
/// The happy path, and every view the rest of the system reads: the wallet,
/// its threshold, its members' own addresses in member order, its
/// single-signer status and its first generation.
fun the_nominated_2_of_3_registers_and_the_views_describe_it() {
    let mut s = h::setup();
    let account = take(&mut s);
    assert!(business_account::has_wallet(&account));
    assert_eq!(business_account::wallet(&account), h::wallet());
    assert_eq!(business_account::wallet_threshold(&account), 2);
    assert_eq!(business_account::wallet_signers(&account), owners_123());
    assert!(!business_account::is_single_signer_wallet(&account));
    assert_eq!(business_account::wallet_epoch(&account), 1);
    assert!(business_account::is_wallet_signer(&account, h::owner_1()));
    assert!(business_account::is_wallet_signer(&account, h::owner_2()));
    assert!(business_account::is_wallet_signer(&account, h::owner_3()));
    assert!(!business_account::is_wallet_signer(&account, STRANGER));
    // The wallet address itself is not one of its members.
    assert!(!business_account::is_wallet_signer(&account, h::wallet()));
    assert!(!business_account::has_pending_wallet(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
/// R2. Registration is an authority change: it names the people who may give
/// a second approval and who now hold the freeze release. Spending rules copy
/// `wallet_epoch`, so it must move from 0 to 1 here.
fun registration_bumps_wallet_epoch_and_authority_epoch() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    let before = authority_epoch(&mut s);
    register(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), false);
    let account = take(&mut s);
    assert_eq!(business_account::authority_epoch(&account), before + 1);
    assert_eq!(business_account::wallet_epoch(&account), 1);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// Without a nomination, any multisig could claim an account that has no
/// wallet yet, including the legitimate one before the founder has decided.
fun registration_needs_a_nomination() {
    let mut s = h::setup_without_wallet();
    register(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// The R2 attack. Before the founder nominates, a co-owner registers a 1-of-1
/// of their own passkey, acknowledging it as single-signer. The member rule
/// passes (they are an owner) and the derivation passes (they are that
/// multisig). Only the nomination stops them.
fun a_co_owner_cannot_claim_the_account_with_their_own_1_of_1() {
    let mut s = h::setup_without_wallet();
    let theirs = multisig::derive_address(&vector[p2()], &vector[1], 1);
    register(&mut s, theirs, vector[p2()], vector[1], 1, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// The same attack while the founder's nomination is open: the co-owner's
/// wallet is a valid multisig of an owner, but it is not the one nominated.
fun a_co_owner_cannot_jump_an_open_nomination() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    let theirs = multisig::derive_address(&vector[p2()], &vector[1], 1);
    register(&mut s, theirs, vector[p2()], vector[1], 1, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// A stranger who knows the nominated wallet's public members can build the
/// arguments, but cannot be the sender.
fun a_stranger_cannot_register_the_nominated_wallet() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, STRANGER, h::keys(), h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// The founder names the wallet, but registering it needs the wallet's own
/// quorum. One key cannot do both halves.
fun the_founder_alone_cannot_register_the_wallet() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, h::founder(), h::keys(), h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// A legacy approver has no registration path.
fun an_approver_cannot_register_the_wallet() {
    let mut s = h::setup_without_wallet();
    add_approver(&mut s, APPROVER);
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, APPROVER, h::keys(), h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// Holding `AdminCap` confers nothing here: no wallet function takes it, and
/// the holder's address is not the wallet.
fun the_admin_cap_holder_cannot_register_the_wallet() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, GOVERNANCE, h::keys(), h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_NOT_NOMINATED)]
/// A genuine multisig of the owners that the founder did not nominate cannot
/// register, even though its sender and its members agree.
fun an_unnominated_multisig_of_owners_cannot_register() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, WEIGHTED_SINGLE_SIGNER_2_1_1, h::keys(), vector[2, 1, 1], 2, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MISMATCH)]
/// The members passed must derive the sender. Otherwise the account would
/// record a threshold of 3 for a wallet the protocol lets 2 sign for.
fun the_members_must_derive_the_sender() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, h::wallet(), h::keys(), h::weights(), 3, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MISMATCH)]
/// The address commits to member order, so the same three keys in another
/// order are another wallet. The registration must pass them exactly as the
/// wallet was built.
fun member_order_matters() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, h::wallet(), vector[p2(), p1(), p3()], h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MISMATCH)]
/// Weights are part of the address. The 2-of-3 cannot record itself with
/// weights [2, 1, 1], which would misdescribe who can sign alone.
fun member_weights_matter() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, h::wallet(), h::keys(), vector[2, 1, 1], h::threshold(), false);
    s.end();
}

#[test]
/// A wallet built in another member order is a different, equally valid
/// wallet, and its members are recorded in that order.
fun a_wallet_in_another_order_records_its_members_in_that_order() {
    let mut s = h::setup_without_wallet();
    let keys = vector[p2(), p1(), p3()];
    let reordered = multisig::derive_address(&keys, &h::weights(), h::threshold());
    nominate(&mut s, h::founder(), reordered, false);
    register(&mut s, reordered, keys, h::weights(), h::threshold(), false);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), reordered);
    assert_eq!(business_account::wallet_signers(&account), vector[h::owner_2(), h::owner_1(), h::owner_3()]);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_SIGNER_NOT_AN_OWNER)]
/// R2. Every member must be an owner, so the signers are the business's own
/// people (D1). A key nobody at the business holds, such as one of Splash's,
/// cannot be slipped into the quorum, even with the founder's nomination.
fun a_non_owner_member_is_refused() {
    let mut s = h::setup_without_wallet();
    let keys = vector[p1(), p2(), ED25519];
    let wallet = multisig::derive_address(&keys, &h::weights(), h::threshold());
    nominate(&mut s, h::founder(), wallet, false);
    register(&mut s, wallet, keys, h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_SIGNER_NOT_AN_OWNER)]
/// Being a legacy approver is not being an owner. An approver key is exactly
/// the kind of operator-held key D1 keeps out of the wallet.
fun an_approver_member_is_refused() {
    let mut s = h::setup_without_wallet();
    add_approver(&mut s, ED25519_ADDRESS);
    let keys = vector[p1(), p2(), ED25519];
    let wallet = multisig::derive_address(&keys, &h::weights(), h::threshold());
    nominate(&mut s, h::founder(), wallet, false);
    register(&mut s, wallet, keys, h::weights(), h::threshold(), false);
    s.end();
}

#[test]
/// Mixed schemes are fine once every member is an owner: passkey, padded
/// zkLogin and Ed25519 (the SDK's mixed vector). The recorded members are each
/// key's own address, in order.
fun a_mixed_scheme_wallet_of_owners_registers() {
    let mut s = h::setup_without_wallet();
    add_owner(&mut s, ZKLOGIN_ADDRESS);
    add_owner(&mut s, ED25519_ADDRESS);
    nominate(&mut s, h::founder(), MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3, false);
    register(
        &mut s,
        MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3,
        vector[p1(), ZKLOGIN, ED25519],
        vector[1, 1, 1],
        2,
        false,
    );
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3);
    assert_eq!(
        business_account::wallet_signers(&account),
        vector[h::owner_1(), ZKLOGIN_ADDRESS, ED25519_ADDRESS],
    );
    assert!(!business_account::is_single_signer_wallet(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_ALREADY_REGISTERED)]
/// Registration happens once. A second registration by the same wallet must
/// not be a way to rewrite its recorded members or reset anything.
fun registration_happens_only_once() {
    let mut s = h::setup();
    register(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_ALREADY_REGISTERED)]
/// Another wallet cannot register over the first. Only the current wallet can
/// hand the account on, by rotation.
fun a_second_wallet_cannot_register_over_the_first() {
    let mut s = h::setup();
    register(&mut s, WEIGHTED_SINGLE_SIGNER_2_1_1, h::keys(), vector[2, 1, 1], 2, true);
    s.end();
}

// ═══ Single-signer wallets: the founder chose it, the wallet acknowledged ═══

#[test]
/// D1 allows a 1-of-1 only when the business explicitly chooses it. With the
/// founder's choice and the wallet's own acknowledgement, it registers and
/// is recorded as single-signer.
fun a_1_of_1_chosen_and_acknowledged_registers() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), PASSKEY_1_OF_1, true);
    register(&mut s, PASSKEY_1_OF_1, vector[p1()], vector[1], 1, true);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), PASSKEY_1_OF_1);
    assert_eq!(business_account::wallet_threshold(&account), 1);
    assert_eq!(business_account::wallet_signers(&account), vector[h::owner_1()]);
    assert!(business_account::is_single_signer_wallet(&account));
    assert_eq!(business_account::wallet_epoch(&account), 1);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_SINGLE_SIGNER_NOT_ACKNOWLEDGED)]
/// Brief 3.8: 1-of-1 without the acknowledgement aborts, even when the founder
/// chose it. The wallet must say so itself.
fun a_1_of_1_without_the_ack_aborts() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), PASSKEY_1_OF_1, true);
    register(&mut s, PASSKEY_1_OF_1, vector[p1()], vector[1], 1, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOMINATION_MISMATCH)]
/// The wallet's acknowledgement does not replace the founder's choice. A 1-of-1
/// the founder nominated as a quorum wallet is refused.
fun a_1_of_1_the_founder_did_not_choose_aborts() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), PASSKEY_1_OF_1, false);
    register(&mut s, PASSKEY_1_OF_1, vector[p1()], vector[1], 1, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOMINATION_MISMATCH)]
/// Weights [2, 1, 1] under threshold 2 read as two-person, but member one signs
/// alone. Single-signer is about weight, not `threshold < 2`, so a founder who
/// nominated a quorum wallet is not given this one.
fun weights_2_1_1_threshold_2_is_single_signer() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), WEIGHTED_SINGLE_SIGNER_2_1_1, false);
    register(&mut s, WEIGHTED_SINGLE_SIGNER_2_1_1, h::keys(), vector[2, 1, 1], 2, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_SINGLE_SIGNER_NOT_ACKNOWLEDGED)]
/// The disguised single-signer wallet needs the acknowledgement too.
fun weights_2_1_1_without_the_ack_aborts() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), WEIGHTED_SINGLE_SIGNER_2_1_1, true);
    register(&mut s, WEIGHTED_SINGLE_SIGNER_2_1_1, h::keys(), vector[2, 1, 1], 2, false);
    s.end();
}

#[test]
/// Chosen and acknowledged, the weighted wallet registers and is recorded as
/// single-signer even though its threshold is 2.
fun weights_2_1_1_chosen_and_acknowledged_registers() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), WEIGHTED_SINGLE_SIGNER_2_1_1, true);
    register(&mut s, WEIGHTED_SINGLE_SIGNER_2_1_1, h::keys(), vector[2, 1, 1], 2, true);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), WEIGHTED_SINGLE_SIGNER_2_1_1);
    assert_eq!(business_account::wallet_threshold(&account), 2);
    assert!(business_account::is_single_signer_wallet(&account));
    assert_eq!(business_account::wallet_signers(&account), owners_123());
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOMINATION_MISMATCH)]
/// The status must match in both directions. A founder who nominated a
/// single-signer wallet gets exactly that, not a quorum wallet at the same
/// slot, so the founder's recorded choice is never wrong.
fun a_quorum_wallet_nominated_as_single_signer_aborts() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), true);
    register(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), true);
    s.end();
}

#[test]
/// An acknowledgement from a real quorum wallet changes nothing: the status
/// comes from the weights, so the wallet is recorded as a quorum.
fun an_ack_does_not_make_a_quorum_wallet_single_signer() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), h::wallet(), false);
    register(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), true);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), h::wallet());
    assert!(!business_account::is_single_signer_wallet(&account));
    ts::return_shared(account);
    s.end();
}

// ═══ Rotation: proposed by the current wallet ══════════════════════════════

#[test]
/// Rotation takes two steps. While it waits, nothing has changed: the old
/// wallet is still the wallet, with its members, threshold and generation.
/// When the new wallet confirms, it becomes the wallet with its own members,
/// and both epochs move. Owner 3, who is not in wallet B, stops being a
/// wallet signer.
fun rotation_takes_two_steps_and_the_new_wallet_finishes_it() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    let proposed_at = {
        let account = take(&mut s);
        assert_eq!(business_account::wallet(&account), h::wallet());
        assert!(business_account::has_pending_wallet(&account));
        assert_eq!(business_account::pending_wallet(&account), wallet_b());
        assert_eq!(business_account::wallet_epoch(&account), 1);
        assert_eq!(business_account::wallet_threshold(&account), 2);
        assert_eq!(business_account::wallet_signers(&account), owners_123());
        let epoch = business_account::authority_epoch(&account);
        ts::return_shared(account);
        epoch
    };
    confirm(&mut s, wallet_b());
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), wallet_b());
    assert!(!business_account::has_pending_wallet(&account));
    assert_eq!(business_account::wallet_threshold(&account), 2);
    assert_eq!(business_account::wallet_signers(&account), vector[h::owner_1(), h::owner_2()]);
    assert!(!business_account::is_wallet_signer(&account, h::owner_3()));
    assert!(!business_account::is_single_signer_wallet(&account));
    assert_eq!(business_account::wallet_epoch(&account), 2);
    assert_eq!(business_account::authority_epoch(&account), proposed_at + 1);
    ts::return_shared(account);
    s.end();
}

#[test]
/// R2. Rotating A to B and back to A gives the old address back but a new
/// generation (3), so spending rules A had before cannot come back with it.
fun rotating_back_gives_the_old_address_and_a_new_generation() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    confirm(&mut s, wallet_b());
    rotate(&mut s, wallet_b(), h::keys(), h::weights(), h::threshold(), false);
    confirm(&mut s, h::wallet());
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), h::wallet());
    assert_eq!(business_account::wallet_signers(&account), owners_123());
    assert_eq!(business_account::wallet_epoch(&account), 3);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// The founder is one key. Rotating the wallet is the quorum's decision.
fun the_founder_cannot_rotate() {
    let mut s = h::setup();
    rotate(&mut s, h::founder(), b_keys(), b_weights(), b_threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// A stranger cannot propose a wallet for someone else's account.
fun a_stranger_cannot_rotate() {
    let mut s = h::setup();
    rotate(&mut s, STRANGER, b_keys(), b_weights(), b_threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// A legacy approver has no rotation path.
fun an_approver_cannot_rotate() {
    let mut s = h::setup();
    add_approver(&mut s, APPROVER);
    rotate(&mut s, APPROVER, b_keys(), b_weights(), b_threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// Governance holding `AdminCap` cannot move an account to another wallet.
fun the_admin_cap_holder_cannot_rotate() {
    let mut s = h::setup();
    rotate(&mut s, GOVERNANCE, b_keys(), b_weights(), b_threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// A would-be wallet cannot propose itself. Only the current one hands over.
fun a_new_wallet_cannot_propose_itself() {
    let mut s = h::setup();
    rotate(&mut s, wallet_b(), b_keys(), b_weights(), b_threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NO_WALLET)]
/// There is nothing to rotate before a wallet is registered; the first wallet
/// comes only through nomination and registration.
fun rotation_needs_a_registered_wallet() {
    let mut s = h::setup_without_wallet();
    rotate(&mut s, h::wallet(), b_keys(), b_weights(), b_threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_SAME_WALLET)]
/// A rotation to the current wallet would change nothing but would let a
/// "confirmation" bump the generation and kill every spending rule silently.
fun rotation_to_the_same_wallet_aborts() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_ROTATION_PENDING)]
/// One rotation at a time. A second proposal must not quietly replace the one
/// the owners are looking at.
fun a_second_rotation_while_one_is_pending_aborts() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    rotate(&mut s, h::wallet(), h::keys(), vector[1, 1, 1], 3, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_SIGNER_NOT_AN_OWNER)]
/// The member rule holds at rotation as at registration. Without it, the
/// quorum could rotate a non-owner key into the wallet and around D1.
fun new_members_must_be_owners() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), vector[p1(), p2(), ED25519], h::weights(), h::threshold(), false);
    s.end();
}

#[test]
/// Once the new member is an owner, the same rotation goes through, and the
/// pinned mixed-scheme SDK vector confirms it.
fun a_new_member_who_is_an_owner_can_rotate_in() {
    let mut s = h::setup();
    add_owner(&mut s, ZKLOGIN_ADDRESS);
    add_owner(&mut s, ED25519_ADDRESS);
    rotate(&mut s, h::wallet(), vector[p1(), ZKLOGIN, ED25519], vector[1, 1, 1], 2, false);
    confirm(&mut s, MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3);
    assert_eq!(
        business_account::wallet_signers(&account),
        vector[h::owner_1(), ZKLOGIN_ADDRESS, ED25519_ADDRESS],
    );
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_SINGLE_SIGNER_NOT_ACKNOWLEDGED)]
/// Rotating to a 1-of-1 is a single-signer choice and must be acknowledged.
fun rotation_to_a_1_of_1_needs_the_ack() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), vector[p1()], vector[1], 1, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_SINGLE_SIGNER_NOT_ACKNOWLEDGED)]
/// The disguised single-signer wallet needs the acknowledgement at rotation
/// too: a threshold of 2 does not make it a quorum.
fun rotation_to_weights_2_1_1_needs_the_ack() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), h::keys(), vector[2, 1, 1], 2, false);
    s.end();
}

#[test]
/// Acknowledged, the rotation to a 1-of-1 completes and the account records it
/// as single-signer, threshold 1, one member.
fun rotation_to_an_acknowledged_1_of_1() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), vector[p1()], vector[1], 1, true);
    confirm(&mut s, PASSKEY_1_OF_1);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), PASSKEY_1_OF_1);
    assert_eq!(business_account::wallet_threshold(&account), 1);
    assert_eq!(business_account::wallet_signers(&account), vector[h::owner_1()]);
    assert!(business_account::is_single_signer_wallet(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
/// The single-signer flag describes the CURRENT wallet, not the account's
/// history. A business that started on a 1-of-1 and rotates to a 2-of-3 must
/// read as a quorum wallet afterwards, or spending rules and the UI would keep
/// treating it as one-person.
fun rotating_away_from_a_1_of_1_records_a_quorum_wallet() {
    let mut s = h::setup_without_wallet();
    nominate(&mut s, h::founder(), PASSKEY_1_OF_1, true);
    register(&mut s, PASSKEY_1_OF_1, vector[p1()], vector[1], 1, true);
    rotate(&mut s, PASSKEY_1_OF_1, h::keys(), h::weights(), h::threshold(), false);
    confirm(&mut s, h::wallet());
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), h::wallet());
    assert!(!business_account::is_single_signer_wallet(&account));
    assert_eq!(business_account::wallet_threshold(&account), 2);
    assert_eq!(business_account::wallet_signers(&account), owners_123());
    assert_eq!(business_account::wallet_epoch(&account), 2);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NO_PENDING_ROTATION)]
/// `pending_wallet()` must not return a default address when nothing is
/// pending; a caller comparing a sender to it would match @0x0.
fun the_pending_wallet_view_aborts_when_none_is_pending() {
    let mut s = h::setup();
    let account = take(&mut s);
    business_account::pending_wallet(&account);
    ts::return_shared(account);
    s.end();
}

#[test]
/// Boundary of "any one member's weight reaches the threshold": weights
/// [2, 1, 1] under threshold 3 leave the heaviest member one short, so the
/// wallet is a quorum and needs no acknowledgement.
fun a_member_one_weight_short_of_the_threshold_is_not_single_signer() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), h::keys(), vector[2, 1, 1], 3, false);
    let new_wallet = multisig::derive_address(&h::keys(), &vector[2, 1, 1], 3);
    confirm(&mut s, new_wallet);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), new_wallet);
    assert_eq!(business_account::wallet_threshold(&account), 3);
    assert!(!business_account::is_single_signer_wallet(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
/// Boundary: a threshold equal to the sum of the weights (3-of-3) is a wallet
/// a full quorum can sign for, and rotates in.
fun a_threshold_equal_to_the_total_weight_rotates_in() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), h::keys(), vector[1, 1, 1], 3, false);
    let three_of_three = multisig::derive_address(&h::keys(), &vector[1, 1, 1], 3);
    confirm(&mut s, three_of_three);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), three_of_three);
    assert_eq!(business_account::wallet_threshold(&account), 3);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_UNREACHABLE_THRESHOLD)]
/// One over: a threshold no quorum can reach is an address nobody can ever
/// sign for. Rotating into it would lock the account, since only the wallet
/// can rotate the wallet, so it is refused at proposal.
fun a_threshold_one_over_the_total_weight_is_refused() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), h::keys(), vector[1, 1, 1], 4, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_DUPLICATE_MEMBER)]
/// Sui refuses a multisig with a repeated key, so the account must too:
/// otherwise it would record a wallet the protocol cannot build.
fun a_rotation_with_a_duplicate_member_is_refused() {
    let mut s = h::setup();
    rotate(&mut s, h::wallet(), vector[p1(), p2(), p1()], vector[1, 1, 1], 2, false);
    s.end();
}

#[test]
/// Boundary: ten members, Sui's maximum, all of them owners, rotate in.
fun a_ten_member_wallet_of_owners_rotates_in() {
    let mut s = h::setup();
    let (keys, weights) = ed25519_members(10);
    let signers = multisig::signer_addresses(&keys);
    let mut i = 0;
    while (i < signers.length()) {
        add_owner(&mut s, signers[i]);
        i = i + 1;
    };
    let ten = multisig::derive_address(&keys, &weights, 6);
    rotate(&mut s, h::wallet(), keys, weights, 6, false);
    confirm(&mut s, ten);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), ten);
    assert_eq!(business_account::wallet_signers(&account), signers);
    assert_eq!(business_account::wallet_threshold(&account), 6);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_BAD_MEMBER_COUNT)]
/// One over: eleven members is more than Sui allows in one multisig.
fun an_eleven_member_wallet_is_refused() {
    let mut s = h::setup();
    let (keys, weights) = ed25519_members(11);
    rotate(&mut s, h::wallet(), keys, weights, 6, false);
    s.end();
}

#[test]
/// Allowed while the owners have frozen the account: replacing a compromised
/// signer is what the freeze buys time for. The freeze survives the rotation,
/// and the new wallet is the one that can now lift it.
fun rotation_is_allowed_under_an_owner_freeze() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_2());
    rotate_to_b(&mut s);
    confirm(&mut s, wallet_b());
    {
        let account = take(&mut s);
        assert_eq!(business_account::wallet(&account), wallet_b());
        assert!(business_account::frozen_by_owner(&account));
        ts::return_shared(account);
    };
    unfreeze_as(&mut s, wallet_b());
    let account = take(&mut s);
    assert!(!business_account::is_frozen(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
/// A compliance freeze stops rotation. Otherwise a business under a
/// compliance stop could move its account to a fresh set of keys.
fun rotation_is_refused_under_a_compliance_freeze() {
    let mut s = h::setup();
    admin_freeze(&mut s);
    rotate_to_b(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
/// The compliance freeze also stops the second step: a rotation proposed
/// before the stop cannot be completed under it.
fun confirmation_is_refused_under_a_compliance_freeze() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    admin_freeze(&mut s);
    confirm(&mut s, wallet_b());
    s.end();
}

#[test]
/// Lifting the compliance freeze lets the waiting rotation complete.
fun confirmation_after_a_compliance_freeze_is_lifted() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    admin_freeze(&mut s);
    admin_unfreeze(&mut s);
    confirm(&mut s, wallet_b());
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), wallet_b());
    ts::return_shared(account);
    s.end();
}

// ═══ Confirmation: only the pending wallet ═════════════════════════════════

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_PENDING_WALLET)]
/// The old wallet cannot confirm for the new one. Confirmation is the proof
/// that the new members can reach their threshold; only their signature
/// proves it.
fun the_current_wallet_cannot_confirm() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    confirm(&mut s, h::wallet());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_PENDING_WALLET)]
/// The founder cannot confirm a rotation either.
fun the_founder_cannot_confirm() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    confirm(&mut s, h::founder());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_PENDING_WALLET)]
/// Nor a stranger, nor any wallet other than the one proposed.
fun another_wallet_cannot_confirm() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    confirm(&mut s, WEIGHTED_SINGLE_SIGNER_2_1_1);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NO_PENDING_ROTATION)]
/// With nothing proposed, there is nothing to confirm. A wallet cannot take an
/// account by confirming a rotation nobody proposed.
fun confirmation_with_nothing_pending_aborts() {
    let mut s = h::setup();
    confirm(&mut s, wallet_b());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// Until it confirms, the pending wallet holds no wallet authority: it cannot
/// propose a rotation of its own.
fun the_pending_wallet_is_not_yet_the_wallet() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    rotate(&mut s, wallet_b(), h::keys(), vector[1, 1, 1], 3, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// After the rotation the old wallet's authority is gone: it cannot propose
/// another rotation.
fun the_old_wallet_loses_authority_after_rotation() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    confirm(&mut s, wallet_b());
    rotate(&mut s, h::wallet(), h::keys(), vector[1, 1, 1], 3, false);
    s.end();
}

// ═══ Cancellation: only the current wallet ═════════════════════════════════

#[test]
/// The current wallet withdraws a proposal. Nothing about the wallet changes,
/// including its generation, so spending rules keep working.
fun the_current_wallet_cancels_a_rotation() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    cancel(&mut s, h::wallet());
    let account = take(&mut s);
    assert!(!business_account::has_pending_wallet(&account));
    assert_eq!(business_account::wallet(&account), h::wallet());
    assert_eq!(business_account::wallet_signers(&account), owners_123());
    assert_eq!(business_account::wallet_epoch(&account), 1);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NO_PENDING_ROTATION)]
/// A cancelled rotation is dead: the wallet it named cannot confirm it later.
fun a_cancelled_rotation_cannot_be_confirmed() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    cancel(&mut s, h::wallet());
    confirm(&mut s, wallet_b());
    s.end();
}

#[test]
/// After a cancel, the wallet can propose again, and the new proposal is the
/// one that completes.
fun after_a_cancel_a_new_rotation_can_be_proposed() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    cancel(&mut s, h::wallet());
    rotate(&mut s, h::wallet(), h::keys(), vector[2, 1, 1], 2, true);
    confirm(&mut s, WEIGHTED_SINGLE_SIGNER_2_1_1);
    let account = take(&mut s);
    assert_eq!(business_account::wallet(&account), WEIGHTED_SINGLE_SIGNER_2_1_1);
    assert!(business_account::is_single_signer_wallet(&account));
    assert_eq!(business_account::wallet_epoch(&account), 2);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// The pending wallet cannot cancel. Cancelling is the current quorum's
/// decision about its own hand-over.
fun the_pending_wallet_cannot_cancel() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    cancel(&mut s, wallet_b());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// A single owner cannot cancel a rotation the quorum proposed.
fun an_owner_cannot_cancel() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    cancel(&mut s, h::owner_3());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// Governance cannot cancel a rotation either.
fun the_admin_cap_holder_cannot_cancel() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    cancel(&mut s, GOVERNANCE);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NO_PENDING_ROTATION)]
/// Nothing pending, nothing to cancel.
fun cancel_with_nothing_pending_aborts() {
    let mut s = h::setup();
    cancel(&mut s, h::wallet());
    s.end();
}

#[test]
/// Withdrawing a change is always safe, so an owner freeze does not stop it.
fun cancel_is_allowed_under_an_owner_freeze() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    freeze_as(&mut s, h::owner_3());
    cancel(&mut s, h::wallet());
    let account = take(&mut s);
    assert!(!business_account::has_pending_wallet(&account));
    assert!(business_account::frozen_by_owner(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
/// A compliance freeze does not stop a cancel either: under a compliance stop
/// the safest thing the business can do is withdraw a pending hand-over.
fun cancel_is_allowed_under_a_compliance_freeze() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    admin_freeze(&mut s);
    cancel(&mut s, h::wallet());
    let account = take(&mut s);
    assert!(!business_account::has_pending_wallet(&account));
    assert!(business_account::frozen_by_admin(&account));
    ts::return_shared(account);
    s.end();
}

// ═══ Freeze: any owner pulls the brake, only the quorum releases it ════════

#[test]
/// Before a wallet exists, one owner may lift an owner freeze, as in v1. This
/// is the contrast that makes the next tests meaningful.
fun before_a_wallet_an_owner_lifts_an_owner_freeze() {
    let mut s = h::setup_without_wallet();
    freeze_as(&mut s, h::owner_2());
    unfreeze_as(&mut s, h::owner_3());
    let account = take(&mut s);
    assert!(!business_account::is_frozen(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
/// R2. After registration any single owner can still freeze, as the emergency
/// brake, and the freeze bumps the authority epoch so approvals in flight die.
fun after_registration_any_owner_can_still_freeze() {
    let mut s = h::setup();
    let before = authority_epoch(&mut s);
    freeze_as(&mut s, h::owner_3());
    let account = take(&mut s);
    assert!(business_account::frozen_by_owner(&account));
    assert!(!business_account::frozen_by_admin(&account));
    assert_eq!(business_account::authority_epoch(&account), before + 1);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MUST_UNFREEZE)]
/// R2. A single co-owner must not be able to release a brake their colleagues
/// pulled, even one they pulled themselves.
fun after_registration_a_single_owner_cannot_unfreeze() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_2());
    unfreeze_as(&mut s, h::owner_2());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MUST_UNFREEZE)]
/// The founder is one owner for this purpose.
fun after_registration_the_founder_cannot_unfreeze() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_3());
    unfreeze_as(&mut s, h::founder());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MUST_UNFREEZE)]
/// A stranger cannot release the brake.
fun after_registration_a_stranger_cannot_unfreeze() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_3());
    unfreeze_as(&mut s, STRANGER);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MUST_UNFREEZE)]
/// Nor a legacy approver.
fun after_registration_an_approver_cannot_unfreeze() {
    let mut s = h::setup();
    add_approver(&mut s, APPROVER);
    freeze_as(&mut s, h::owner_3());
    unfreeze_as(&mut s, APPROVER);
    s.end();
}

#[test]
/// The wallet, the owners' quorum, lifts the owner freeze, and the release
/// bumps the authority epoch like every other freeze change.
fun the_wallet_lifts_an_owner_freeze() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_2());
    let before = authority_epoch(&mut s);
    unfreeze_as(&mut s, h::wallet());
    let account = take(&mut s);
    assert!(!business_account::is_frozen(&account));
    assert_eq!(business_account::authority_epoch(&account), before + 1);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_FROZEN)]
/// The wallet's release is for the owner freeze only. With only a compliance
/// freeze in place, there is nothing the wallet may lift.
fun the_wallet_cannot_lift_a_compliance_freeze() {
    let mut s = h::setup();
    admin_freeze(&mut s);
    unfreeze_as(&mut s, h::wallet());
    s.end();
}

#[test]
/// With both freezes in place, the wallet lifts its own and the compliance
/// freeze stays: the account is still stopped.
fun the_wallet_lifting_its_freeze_leaves_the_compliance_freeze() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_2());
    admin_freeze(&mut s);
    unfreeze_as(&mut s, h::wallet());
    let account = take(&mut s);
    assert!(!business_account::frozen_by_owner(&account));
    assert!(business_account::frozen_by_admin(&account));
    assert!(business_account::is_frozen(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
/// "Only the quorum can release it." `AdminCap` lifting its own freeze must
/// not lift the owners' brake.
fun the_admin_cap_cannot_lift_an_owner_freeze() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_2());
    admin_freeze(&mut s);
    admin_unfreeze(&mut s);
    let account = take(&mut s);
    assert!(business_account::frozen_by_owner(&account));
    assert!(!business_account::frozen_by_admin(&account));
    assert!(business_account::is_frozen(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MUST_UNFREEZE)]
/// After a rotation the release moves with the wallet: the old wallet cannot
/// lift a freeze any more.
fun after_rotation_the_old_wallet_cannot_unfreeze() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    confirm(&mut s, wallet_b());
    freeze_as(&mut s, h::owner_3());
    unfreeze_as(&mut s, h::wallet());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_WALLET_MUST_UNFREEZE)]
/// While a rotation is pending, the proposed wallet cannot lift a freeze; it
/// is not the wallet until it confirms.
fun the_pending_wallet_cannot_unfreeze() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    freeze_as(&mut s, h::owner_3());
    unfreeze_as(&mut s, wallet_b());
    s.end();
}

#[test]
/// While a rotation is pending, the current wallet still holds the release.
fun the_current_wallet_unfreezes_while_a_rotation_is_pending() {
    let mut s = h::setup();
    rotate_to_b(&mut s);
    freeze_as(&mut s, h::owner_3());
    unfreeze_as(&mut s, h::wallet());
    let account = take(&mut s);
    assert!(!business_account::is_frozen(&account));
    assert!(business_account::has_pending_wallet(&account));
    ts::return_shared(account);
    s.end();
}

// ═══ Every wallet member stays an owner (review follow-up) ═══════════════════

#[test]
#[expected_failure(abort_code = business_account::E_OWNER_IS_A_SIGNER)]
/// A member of the business wallet cannot be removed as an owner. If they
/// could, the wallet would keep a signer who no longer belongs to the
/// business; they are rotated out of the wallet first.
fun a_wallet_signer_cannot_be_removed_as_an_owner() {
    let mut s = h::setup();
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::remove_owner(&mut account, h::owner_3(), s.ctx());
        ts::return_shared(account);
    };
    s.end();
}

#[test]
/// Rotated out of the wallet (to a 2-of-2 of owners 1 and 2), owner 3 can be
/// removed as an owner.
fun after_rotating_them_out_a_former_signer_can_be_removed() {
    let mut s = h::setup();
    let keys = vector[h::passkey(0), h::passkey(1)];
    let b = multisig::derive_address(&keys, &vector[1, 1], 2);
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::rotate_wallet(&mut account, keys, vector[1, 1], 2, false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(b);
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::confirm_wallet_rotation(&mut account, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::remove_owner(&mut account, h::owner_3(), s.ctx());
        assert!(!business_account::is_owner(&account, h::owner_3()));
        ts::return_shared(account);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_OWNER_IS_A_SIGNER)]
/// Nor can an owner named in a rotation still waiting for confirmation be
/// removed: confirming would then make a non-owner a signer.
fun a_member_of_a_pending_rotation_cannot_be_removed() {
    let mut s = h::setup();
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::add_owner(&mut account, ED25519_ADDRESS, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::rotate_wallet(&mut account, vector[h::passkey(0), ED25519], vector[1, 1], 2, false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::remove_owner(&mut account, ED25519_ADDRESS, s.ctx());
        ts::return_shared(account);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_FOUNDER)]
/// A founder who has left the owners no longer speaks for the account and
/// cannot nominate its wallet.
fun a_founder_who_left_cannot_nominate() {
    let mut s = h::setup_without_wallet();
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::remove_owner(&mut account, h::founder(), s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::nominate_wallet(&mut account, h::wallet(), false, s.ctx());
        ts::return_shared(account);
    };
    s.end();
}

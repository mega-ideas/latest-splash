/// Who changes an account's owners once its business wallet exists (v2 Phase
/// 1 review: one owner key could stall the account).
///
/// D1 makes the owners' multisig the authority over the business wallet. So
/// one owner key out of N must not be able to hold the account: re-freeze it
/// faster than the quorum can remove them, sit as a founder nobody can
/// remove, or void every spending-rule approval by moving `authority_epoch`
/// alone. Once a wallet is registered:
///
///   * the wallet adds and removes owners. It may do so under an owner freeze
///     (so one transaction can lift a freeze and remove whoever pulled it, or
///     add a replacement person to rotate in), never under a compliance one;
///   * the wallet may remove the founder too, once the founder is not a
///     current or pending signer;
///   * naming the recovery party is the wallet's, and there is no approver
///     set any more (the legacy path is not in core), so the only epoch
///     change one owner can still make alone is the emergency brake, which
///     every owner keeps.
///
/// Before registration the owner rules are unchanged.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::wallet_membership_tests;

use splash_core::business_account::{Self, BusinessAccount};
use splash_core::multisig;
use splash_core::v2_harness as h;
use std::unit_test::assert_eq;
use sui::test_scenario::{Self as ts, Scenario};

/// From `multisig_tests.move`: an Ed25519 member and its own address. Used as
/// the new person a quorum brings in.
const ED25519: vector<u8> = x"00d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
const ED25519_ADDRESS: address = @0x0881c07520943bbf13989b92892093c1b50672156fa5f873c22892701cb2e207;

const RESCUER: address = @0xEC0;
const GOVERNANCE: address = @0xAD;
const OBSERVER: address = @0x0B5;

// ─── Helpers ───────────────────────────────────────────────────────────────

macro fun act($s: &mut Scenario, $by: address, $f: |&mut BusinessAccount, &mut TxContext|) {
    let s = $s;
    s.next_tx($by);
    let mut account = s.take_shared<BusinessAccount>();
    $f(&mut account, s.ctx());
    ts::return_shared(account);
}

fun read(s: &mut Scenario): BusinessAccount {
    s.next_tx(OBSERVER);
    s.take_shared<BusinessAccount>()
}

fun epoch(s: &mut Scenario): u64 {
    let account = read(s);
    let e = business_account::authority_epoch(&account);
    ts::return_shared(account);
    e
}

fun freeze_as(s: &mut Scenario, by: address) {
    act!(s, by, |a, ctx| business_account::freeze_account(a, ctx));
}

fun admin_freeze(s: &mut Scenario) {
    s.next_tx(GOVERNANCE);
    let mut account = s.take_shared<BusinessAccount>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    business_account::admin_freeze(&admin, &mut account, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(account);
}

/// The 2-of-2 of the passkeys at `i` and `j`.
fun pair(i: u64, j: u64): address {
    multisig::derive_address(&vector[h::passkey(i), h::passkey(j)], &vector[1, 1], 2)
}

/// Owners 1 and 2: owner 3 rotated out.
fun w12(): address { pair(0, 1) }

/// Owners 2 and 3: the founder rotated out.
fun w23(): address { pair(1, 2) }

/// Owners 1 and 2 and the Ed25519 newcomer, 2-of-3.
fun w12e(): address {
    multisig::derive_address(&vector[h::passkey(0), h::passkey(1), ED25519], &vector[1, 1, 1], 2)
}

/// The current wallet `from` proposes the 2-of-2 of passkeys `i` and `j`, and
/// that wallet confirms. Allowed under an owner freeze.
fun rotate_to_pair(s: &mut Scenario, from: address, i: u64, j: u64) {
    let keys = vector[h::passkey(i), h::passkey(j)];
    act!(s, from, |a, ctx| business_account::rotate_wallet(a, keys, vector[1, 1], 2, false, ctx));
    act!(s, pair(i, j), |a, ctx| business_account::confirm_wallet_rotation(a, ctx));
}

/// No wallet yet; the founder adds the Ed25519 newcomer as a fourth owner, who
/// is not a signer of the wallet that then registers.
fun setup_with_a_non_signing_owner(): Scenario {
    let mut s = h::setup_without_wallet();
    act!(&mut s, h::founder(), |a, ctx| business_account::add_owner(a, ED25519_ADDRESS, ctx));
    h::register_wallet(&mut s);
    s
}

// ═══ The quorum can act against one owner key ══════════════════════════════

#[test]
/// Owner 3 pulls the brake. The quorum rotates owner 3 out of the wallet
/// (allowed under an owner freeze), then the new wallet, in ONE transaction,
/// lifts the freeze and removes owner 3. Nothing can run between two commands
/// of one transaction, so owner 3 has no slot to freeze again first, and once
/// removed has no brake left to pull.
fun the_wallet_lifts_a_freeze_and_removes_the_owner_who_pulled_it_in_one_transaction() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_3());
    rotate_to_pair(&mut s, h::wallet(), 0, 1);
    let before = epoch(&mut s);
    act!(&mut s, w12(), |a, ctx| {
        business_account::unfreeze_account(a, ctx);
        business_account::remove_owner(a, h::owner_3(), ctx);
    });
    let account = read(&mut s);
    assert!(!business_account::is_owner(&account, h::owner_3()));
    assert!(!business_account::is_frozen(&account));
    // Both changes are authority changes, and each one bumps.
    assert_eq!(business_account::authority_epoch(&account), before + 2);
    ts::return_shared(account);
    s.end();
}

#[test]
/// Under owner 3's freeze, the wallet adds a replacement person as an owner
/// and proposes a wallet with them in it, in one transaction. The new wallet
/// confirms, then lifts the freeze and removes owner 3. This is what an owner
/// freeze buys time for: replacing a compromised signer.
fun the_wallet_adds_a_replacement_owner_under_an_owner_freeze_and_rotates_them_in() {
    let mut s = h::setup();
    freeze_as(&mut s, h::owner_3());
    act!(&mut s, h::wallet(), |a, ctx| {
        business_account::add_owner(a, ED25519_ADDRESS, ctx);
        business_account::rotate_wallet(
            a, vector[h::passkey(0), h::passkey(1), ED25519], vector[1, 1, 1], 2, false, ctx,
        );
    });
    act!(&mut s, w12e(), |a, ctx| business_account::confirm_wallet_rotation(a, ctx));
    act!(&mut s, w12e(), |a, ctx| {
        business_account::unfreeze_account(a, ctx);
        business_account::remove_owner(a, h::owner_3(), ctx);
    });
    let account = read(&mut s);
    assert_eq!(business_account::wallet(&account), w12e());
    assert_eq!(business_account::owners(&account), vector[h::owner_1(), h::owner_2(), ED25519_ADDRESS]);
    assert!(!business_account::is_frozen(&account));
    ts::return_shared(account);
    s.end();
}

#[test]
/// The wallet adding an owner is an authority change and bumps the epoch.
fun the_wallet_adding_an_owner_bumps_the_authority_epoch() {
    let mut s = h::setup();
    let before = epoch(&mut s);
    act!(&mut s, h::wallet(), |a, ctx| business_account::add_owner(a, ED25519_ADDRESS, ctx));
    let account = read(&mut s);
    assert!(business_account::is_owner(&account, ED25519_ADDRESS));
    assert_eq!(business_account::authority_epoch(&account), before + 1);
    ts::return_shared(account);
    s.end();
}

// ═══ The founder is removable by the wallet, once rotated out ══════════════

#[test]
/// The quorum rotates the founder out of the wallet, and the new wallet
/// removes the founder as an owner, so a founder who keeps re-freezing loses
/// the brake with the membership. `owner()` still names the founder: it is
/// the attribution anchor, not an authority.
fun the_wallet_removes_a_founder_it_rotated_out() {
    let mut s = h::setup();
    rotate_to_pair(&mut s, h::wallet(), 1, 2);
    act!(&mut s, w23(), |a, ctx| business_account::remove_owner(a, h::founder(), ctx));
    let account = read(&mut s);
    assert!(!business_account::is_owner(&account, h::founder()));
    assert_eq!(business_account::owner(&account), h::founder());
    assert_eq!(business_account::owners(&account), vector[h::owner_2(), h::owner_3()]);
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_OWNER_IS_A_SIGNER)]
/// While the founder is a signer, the wallet cannot remove them: the rule for
/// every signer holds for the founder too.
fun the_wallet_cannot_remove_a_founder_who_still_signs() {
    let mut s = h::setup();
    act!(&mut s, h::wallet(), |a, ctx| business_account::remove_owner(a, h::founder(), ctx));
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_OWNER_IS_A_SIGNER)]
/// Nor while the founder is a member of a rotation still waiting to be
/// confirmed.
fun the_wallet_cannot_remove_a_founder_named_in_a_pending_rotation() {
    let mut s = h::setup();
    // The founder is rotated out, then named again in a pending rotation.
    rotate_to_pair(&mut s, h::wallet(), 1, 2);
    act!(&mut s, w23(), |a, ctx| {
        business_account::rotate_wallet(a, vector[h::passkey(0), h::passkey(1)], vector[1, 1], 2, false, ctx);
    });
    act!(&mut s, w23(), |a, ctx| business_account::remove_owner(a, h::founder(), ctx));
    s.end();
}

// ═══ After registration, no single owner changes membership ═══════════════

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// An owner adding an owner alone, even a throwaway address, would move the
/// authority epoch and void every outstanding spending-rule approval.
fun after_registration_an_owner_cannot_add_an_owner() {
    let mut s = h::setup();
    act!(&mut s, h::owner_2(), |a, ctx| business_account::add_owner(a, ED25519_ADDRESS, ctx));
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// Nor can the founder remove an owner alone, as it could before.
fun after_registration_the_founder_cannot_remove_an_owner() {
    let mut s = setup_with_a_non_signing_owner();
    act!(&mut s, h::founder(), |a, ctx| business_account::remove_owner(a, ED25519_ADDRESS, ctx));
    s.end();
}

#[test]
/// The wallet removes an owner who is not a signer.
fun after_registration_the_wallet_removes_a_non_signing_owner() {
    let mut s = setup_with_a_non_signing_owner();
    act!(&mut s, h::wallet(), |a, ctx| business_account::remove_owner(a, ED25519_ADDRESS, ctx));
    let account = read(&mut s);
    assert!(!business_account::is_owner(&account, ED25519_ADDRESS));
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// Naming the recovery party is a membership decision, and it bumps the
/// epoch; after registration it is the wallet's.
fun after_registration_an_owner_cannot_name_the_recovery_party() {
    let mut s = h::setup();
    act!(&mut s, h::owner_2(), |a, ctx| business_account::set_recovery_party(a, RESCUER, ctx));
    s.end();
}

#[test]
/// The wallet names it.
fun after_registration_the_wallet_names_the_recovery_party() {
    let mut s = h::setup();
    act!(&mut s, h::wallet(), |a, ctx| business_account::set_recovery_party(a, RESCUER, ctx));
    let account = read(&mut s);
    assert_eq!(business_account::recovery_party(&account), option::some(RESCUER));
    ts::return_shared(account);
    s.end();
}

#[test]
/// What one owner can still do alone is the emergency brake.
fun after_registration_any_owner_still_pulls_the_brake() {
    let mut s = h::setup();
    let before = epoch(&mut s);
    freeze_as(&mut s, h::owner_3());
    let account = read(&mut s);
    assert!(business_account::frozen_by_owner(&account));
    assert_eq!(business_account::authority_epoch(&account), before + 1);
    ts::return_shared(account);
    s.end();
}

// ═══ A compliance freeze stops the wallet's membership changes ════════════

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
fun the_wallet_cannot_add_an_owner_under_a_compliance_freeze() {
    let mut s = h::setup();
    admin_freeze(&mut s);
    act!(&mut s, h::wallet(), |a, ctx| business_account::add_owner(a, ED25519_ADDRESS, ctx));
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
fun the_wallet_cannot_remove_an_owner_under_a_compliance_freeze() {
    let mut s = setup_with_a_non_signing_owner();
    admin_freeze(&mut s);
    act!(&mut s, h::wallet(), |a, ctx| business_account::remove_owner(a, ED25519_ADDRESS, ctx));
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
fun the_wallet_cannot_name_a_recovery_party_under_a_compliance_freeze() {
    let mut s = h::setup();
    admin_freeze(&mut s);
    act!(&mut s, h::wallet(), |a, ctx| business_account::set_recovery_party(a, RESCUER, ctx));
    s.end();
}

// ═══ Before registration, the owner rules are as they were ════════════════

#[test]
/// Any owner adds an owner.
fun before_registration_any_owner_adds_an_owner() {
    let mut s = h::setup_without_wallet();
    act!(&mut s, h::owner_2(), |a, ctx| business_account::add_owner(a, ED25519_ADDRESS, ctx));
    let account = read(&mut s);
    assert!(business_account::is_owner(&account, ED25519_ADDRESS));
    ts::return_shared(account);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_AN_OWNER)]
/// Only the founder removes the founder.
fun before_registration_only_the_founder_removes_the_founder() {
    let mut s = h::setup_without_wallet();
    act!(&mut s, h::owner_2(), |a, ctx| business_account::remove_owner(a, h::founder(), ctx));
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
/// And membership is still frozen with the account.
fun before_registration_membership_cannot_change_under_an_owner_freeze() {
    let mut s = h::setup_without_wallet();
    freeze_as(&mut s, h::owner_2());
    act!(&mut s, h::founder(), |a, ctx| business_account::add_owner(a, ED25519_ADDRESS, ctx));
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_AN_OWNER)]
/// A nominated wallet that has not registered has no say yet.
fun before_registration_the_nominated_wallet_cannot_add_an_owner() {
    let mut s = h::setup_without_wallet();
    act!(&mut s, h::founder(), |a, ctx| business_account::nominate_wallet(a, h::wallet(), false, ctx));
    act!(&mut s, h::wallet(), |a, ctx| business_account::add_owner(a, ED25519_ADDRESS, ctx));
    s.end();
}

#[test]
/// Any owner still names the recovery party.
fun before_registration_an_owner_names_the_recovery_party() {
    let mut s = h::setup_without_wallet();
    act!(&mut s, h::owner_2(), |a, ctx| business_account::set_recovery_party(a, RESCUER, ctx));
    let account = read(&mut s);
    assert_eq!(business_account::recovery_party(&account), option::some(RESCUER));
    ts::return_shared(account);
    s.end();
}

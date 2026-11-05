/// Who counts as "inside the network" (Amendment A1 §2.3: free between
/// Splash businesses).
///
/// A payment to a registered business wallet is charged as a Splash-business
/// payment: nothing. So the business-wallet registry must hold only the
/// wallets of businesses Splash has verified and compliance has not stopped.
/// Anyone can submit an application, nominate a 1-of-1 of their own key and
/// register it; until KYB is verified that address is an ordinary wallet,
/// and it stops counting again when KYB is revoked or compliance freezes the
/// account.
///
/// What is pinned here:
///
///   * an unverified account's registered wallet is not a business wallet,
///     and a wallet payment to it pays the wallet schedule;
///   * verifying an account that registered first enters its wallet, and a
///     payment to it is then free;
///   * revoking KYB takes the wallet out of the registry;
///   * a compliance freeze takes it out, and lifting the freeze puts it back;
///     an owner freeze does not;
///   * the registry stays exact through every order of verification,
///     revocation, compliance freeze and unfreeze, for an account sharing
///     its wallet with an unverified one, and through an unverified
///     account's rotation.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::business_network_tests;

use splash_core::address_registry::{Self, Registry};
use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::ComplianceConfig;
use splash_core::fee_config::FeeConfig;
use splash_core::multisig;
use splash_core::payment_intent;
use splash_core::v2_harness::{Self as h, USDC};
use std::unit_test::assert_eq;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";
/// A payee's own ed25519 key (flag || key).
const PAYEE_KEY: vector<u8> = x"00d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
/// 5,000 USDC: at 2 bps the wallet schedule charges 1 USDC.
const PRINCIPAL: u64 = 5_000_000_000;
const WALLET_FEE: u64 = 1_000_000;

fun payee_founder(): address { multisig::signer_address(&PAYEE_KEY) }
/// The payee's 1-of-1 of their own key.
fun lone(): address { multisig::derive_address(&vector[PAYEE_KEY], &vector[1], 1) }

fun is_business_wallet(s: &mut Scenario, addr: address): bool {
    s.next_tx(h::owner_1());
    let reg = s.take_shared<Registry>();
    let yes = address_registry::is_business_wallet(&reg, addr);
    ts::return_shared(reg);
    yes
}

/// The harness account, then a second account the payee opens and never
/// gets verified, with the payee's 1-of-1 registered as its wallet. Returns
/// (harness account, payee account).
fun with_unverified_payee(): (Scenario, ID, ID) {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let main_id = ts::most_recent_id_shared<BusinessAccount>().destroy_some();
    s.next_tx(payee_founder());
    {
        let c = s.take_shared<Clock>();
        business_account::submit_application(b"SSM-PAYEE".to_string(), b"bafy-payee".to_string(), &c, s.ctx());
        ts::return_shared(c);
    };
    s.next_tx(payee_founder());
    let payee_id = ts::most_recent_id_shared<BusinessAccount>().destroy_some();
    {
        let mut acct = s.take_shared_by_id<BusinessAccount>(payee_id);
        business_account::nominate_wallet(&mut acct, lone(), true, s.ctx());
        ts::return_shared(acct);
    };
    s.next_tx(lone());
    {
        let mut acct = s.take_shared_by_id<BusinessAccount>(payee_id);
        let mut reg = s.take_shared<Registry>();
        business_account::register_wallet(&mut acct, &mut reg, vector[PAYEE_KEY], vector[1], 1, true, s.ctx());
        assert!(!business_account::is_verified(&acct));
        ts::return_shared(reg);
        ts::return_shared(acct);
    };
    (s, main_id, payee_id)
}

#[test]
/// Registering a wallet does not make an unverified account a Splash
/// business.
fun an_unverified_accounts_wallet_is_not_a_business_wallet() {
    let (mut s, _, _) = with_unverified_payee();
    assert_eq!(is_business_wallet(&mut s, lone()), false);
    s.end();
}

#[test]
/// A verified business paying an unverified account's wallet, declared a
/// wallet payment, pays the wallet schedule: 1 USDC on 5,000.
fun a_wallet_payment_to_an_unverified_accounts_wallet_pays_the_wallet_schedule() {
    let (mut s, main_id, _) = with_unverified_payee();
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(main_id);
        let config = s.take_shared<ComplianceConfig>();
        let fees = s.take_shared<FeeConfig>();
        let reg = s.take_shared<Registry>();
        let c = s.take_shared<Clock>();
        let mut intent = h::wallet_intent_of_kind(
            &mut account, &config, 1, payment_intent::kind_wallet(), lone(), PRINCIPAL, &c, s.ctx(),
        );
        let receipt = payment_intent::confirm_from_business_wallet(
            &mut intent, &mut account, &config, &fees, &reg, h::usdc(PRINCIPAL + WALLET_FEE, s.ctx()),
            WALLET_FEE, h::settle_by(&c), &c, s.ctx(),
        );
        audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
        payment_intent::delete_finalized(intent);
        ts::return_shared(c);
        ts::return_shared(reg);
        ts::return_shared(fees);
        ts::return_shared(config);
        ts::return_shared(account);
    };
    // An ordinary wallet is paid a coin; the fee goes to the fee recipient.
    s.next_tx(lone());
    let paid = s.take_from_address<Coin<USDC>>(lone());
    assert_eq!(coin::value(&paid), PRINCIPAL);
    ts::return_to_address(lone(), paid);
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), WALLET_FEE);
    s.end();
}

#[test]
/// Revoking KYB takes the account's wallet out of the registry.
fun revoking_kyb_takes_the_wallet_out() {
    let mut s = h::setup();
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    s.next_tx(h::owner_1());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        let mut reg = s.take_shared<Registry>();
        business_account::revoke_verification(&admin, &mut account, &mut reg, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(reg);
        ts::return_shared(account);
    };
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    s.end();
}

#[test]
/// A compliance freeze takes the wallet out; lifting it puts it back.
fun an_admin_freeze_takes_the_wallet_out_and_unfreezing_puts_it_back() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        let mut reg = s.take_shared<Registry>();
        business_account::admin_freeze(&admin, &mut account, &mut reg, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(reg);
        ts::return_shared(account);
    };
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    s.next_tx(h::owner_1());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        let mut reg = s.take_shared<Registry>();
        business_account::admin_unfreeze(&admin, &mut account, &mut reg, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(reg);
        ts::return_shared(account);
    };
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    s.end();
}

/// AdminCap, as governance, on the account `id`.
fun as_admin(s: &mut Scenario, id: ID, f: u8) {
    s.next_tx(h::owner_1());
    let mut account = s.take_shared_by_id<BusinessAccount>(id);
    let mut reg = s.take_shared<Registry>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    if (f == 0) business_account::verify_business(&admin, &mut account, &mut reg, 20)
    else if (f == 1) business_account::revoke_verification(&admin, &mut account, &mut reg, s.ctx())
    else if (f == 2) business_account::admin_freeze(&admin, &mut account, &mut reg, s.ctx())
    else business_account::admin_unfreeze(&admin, &mut account, &mut reg, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(reg);
    ts::return_shared(account);
}

fun verify(s: &mut Scenario, id: ID) { as_admin(s, id, 0) }
fun revoke(s: &mut Scenario, id: ID) { as_admin(s, id, 1) }
fun admin_freeze(s: &mut Scenario, id: ID) { as_admin(s, id, 2) }
fun admin_unfreeze(s: &mut Scenario, id: ID) { as_admin(s, id, 3) }

#[test]
/// Verifying an account that registered its wallet first enters the wallet,
/// and a wallet payment to it is then free.
fun verifying_after_registration_enters_the_wallet() {
    let (mut s, main_id, payee_id) = with_unverified_payee();
    verify(&mut s, payee_id);
    assert_eq!(is_business_wallet(&mut s, lone()), true);
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(main_id);
        let config = s.take_shared<ComplianceConfig>();
        let fees = s.take_shared<FeeConfig>();
        let reg = s.take_shared<Registry>();
        let c = s.take_shared<Clock>();
        let mut intent = h::wallet_intent_of_kind(
            &mut account, &config, 1, payment_intent::kind_wallet(), lone(), PRINCIPAL, &c, s.ctx(),
        );
        let receipt = payment_intent::confirm_from_business_wallet(
            &mut intent, &mut account, &config, &fees, &reg, h::usdc(PRINCIPAL, s.ctx()), 0, h::settle_by(&c), &c, s.ctx(),
        );
        audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
        payment_intent::delete_finalized(intent);
        ts::return_shared(c);
        ts::return_shared(reg);
        ts::return_shared(fees);
        ts::return_shared(config);
        ts::return_shared(account);
    };
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(lone()), PRINCIPAL);
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 0);
    s.end();
}

#[test]
/// An owner freeze is the owners' own brake on paying out: the wallet stays
/// a business wallet.
fun an_owner_freeze_keeps_the_wallet_in() {
    let mut s = h::setup();
    s.next_tx(h::owner_2());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::freeze_account(&mut account, s.ctx());
        ts::return_shared(account);
    };
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    s.end();
}

#[test]
/// Revoked, then verified again after remediation: back in. Revoked again:
/// out. A compliance freeze on an unverified account and its lifting change
/// nothing; verifying it while frozen enters nothing until it is lifted.
fun every_kyb_and_compliance_change_keeps_the_registry_exact() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let id = ts::most_recent_id_shared<BusinessAccount>().destroy_some();
    revoke(&mut s, id);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    verify(&mut s, id);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    revoke(&mut s, id);
    admin_freeze(&mut s, id);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    verify(&mut s, id);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    admin_unfreeze(&mut s, id);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    admin_freeze(&mut s, id);
    revoke(&mut s, id);
    admin_unfreeze(&mut s, id);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    s.end();
}

#[test]
/// A second, unverified account registering the same multisig adds nothing:
/// once the verified one is revoked, the address is an ordinary wallet.
fun an_unverified_account_sharing_a_wallet_adds_nothing() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let a = ts::most_recent_id_shared<BusinessAccount>().destroy_some();
    {
        let c = s.take_shared<Clock>();
        business_account::submit_application(b"SSM-B".to_string(), b"bafy-b".to_string(), &c, s.ctx());
        ts::return_shared(c);
    };
    s.next_tx(h::owner_1());
    let b = ts::most_recent_id_shared<BusinessAccount>().destroy_some();
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(b);
        business_account::add_owner(&mut account, h::owner_2(), s.ctx());
        business_account::add_owner(&mut account, h::owner_3(), s.ctx());
        business_account::nominate_wallet(&mut account, h::wallet(), false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(b);
        let mut reg = s.take_shared<Registry>();
        business_account::register_wallet(&mut account, &mut reg, h::keys(), h::weights(), h::threshold(), false, s.ctx());
        ts::return_shared(reg);
        ts::return_shared(account);
    };
    revoke(&mut s, a);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    s.end();
}

/// The 2-of-2 of passkeys 1 and 2.
fun pair(): address { multisig::derive_address(&vector[h::passkey(0), h::passkey(1)], &vector[1, 1], 2) }

#[test]
/// An unverified account rotating its wallet enters neither wallet;
/// verifying it then enters the new one only.
fun an_unverified_accounts_rotation_enters_nothing() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let id = ts::most_recent_id_shared<BusinessAccount>().destroy_some();
    revoke(&mut s, id);
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::rotate_wallet(&mut account, vector[h::passkey(0), h::passkey(1)], vector[1, 1], 2, false, s.ctx());
        ts::return_shared(account);
    };
    h::confirm_rotation(&mut s, pair());
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    assert_eq!(is_business_wallet(&mut s, pair()), false);
    verify(&mut s, id);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    assert_eq!(is_business_wallet(&mut s, pair()), true);
    s.end();
}

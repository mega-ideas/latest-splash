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
///   * revoking KYB takes the wallet out of the registry;
///   * a compliance freeze takes it out, and lifting the freeze puts it back.
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
use sui::test_scenario::{Self as ts, Scenario};

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";
const USD: u64 = 1_000_000;
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
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(lone()), PRINCIPAL);
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
        business_account::revoke_verification(&admin, &mut account, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
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
        business_account::admin_freeze(&admin, &mut account, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    s.next_tx(h::owner_1());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        business_account::admin_unfreeze(&admin, &mut account, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    s.end();
}

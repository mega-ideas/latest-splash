/// The kind of a payment is derived, not declared (Amendment A1 §2.3).
///
/// Written from the amendment. What is pinned here:
///
///   * `derive_kind`, exactly as A1 writes it: a CCTP payment is cross-chain
///     and must say so; a payment to a registered business wallet is a Splash
///     business payment whatever it declared (free inside the network); a
///     payment to a partner deposit address is a bank payout whatever it
///     declared, so it cannot be dodged by declaring a wallet; anything else
///     must declare a wallet or an exchange, so a declared bank payout to an
///     unregistered address, or a declared Splash-business payment to an
///     address that is not a business wallet, aborts;
///   * the business-wallet registry is written by `register_wallet` and by a
///     confirmed rotation, which clears the old wallet, and by nothing else;
///   * the partner deposit-address registry is managed by Splash's ops
///     capability, changes at once, emits an event for every change, and only
///     classifies: it holds no address funds can be sent to.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::address_registry_tests;

use splash_core::address_registry::{Self, Registry, OpsCap};
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::fee_config;
use splash_core::multisig;
use splash_core::v2_harness as h;
use std::unit_test::assert_eq;
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

const PUBLISHER: address = @0x5EED;
const PARTNER: address = @0xBA4C;
const SUPPLIER: address = @0x5011D;
const BUSINESS_WALLET: address = @0xB12B12;
const USD: u64 = 1_000_000;

fun sb(): u8 { fee_config::kind_splash_business() }
fun wallet(): u8 { fee_config::kind_wallet() }
fun exchange(): u8 { fee_config::kind_exchange() }
fun cross_chain(): u8 { fee_config::kind_cross_chain() }
fun bank(): u8 { fee_config::kind_bank_payout() }

/// A registry with one partner deposit address and one business wallet.
fun classified(ctx: &mut TxContext): Registry {
    let mut reg = address_registry::new_for_testing(ctx);
    let cap = address_registry::ops_cap_for_testing(ctx);
    address_registry::add_partner_address(&cap, &mut reg, PARTNER);
    address_registry::add_business_wallet_for_testing(&mut reg, BUSINESS_WALLET);
    address_registry::destroy_ops_cap_for_testing(cap);
    reg
}

fun derive(reg: &Registry, to: address, declared: u8): u8 {
    address_registry::derive_kind(reg, to, declared, false)
}

// ─── Publish ───────────────────────────────────────────────────────────────

#[test]
/// At publish the registry is shared and empty, and the one OpsCap goes to
/// the publisher, for transfer to Splash's ops multisig.
fun publish_shares_an_empty_registry_and_mints_one_ops_cap() {
    let mut s = ts::begin(PUBLISHER);
    address_registry::init_for_testing(s.ctx());
    s.next_tx(PUBLISHER);
    {
        assert!(ts::has_most_recent_for_sender<OpsCap>(&s));
        let reg = s.take_shared<Registry>();
        assert_eq!(address_registry::is_partner_address(&reg, PARTNER), false);
        assert_eq!(address_registry::is_business_wallet(&reg, BUSINESS_WALLET), false);
        ts::return_shared(reg);
    };
    s.end();
}

// ─── derive_kind ───────────────────────────────────────────────────────────

#[test]
/// Through CCTP the kind is cross-chain, and the intent must say so.
fun a_cctp_payment_is_cross_chain() {
    let mut ctx = tx_context::dummy();
    let reg = classified(&mut ctx);
    assert_eq!(address_registry::derive_kind(&reg, SUPPLIER, cross_chain(), true), cross_chain());
    // Even to an address the registry knows: the burn is what is paid for.
    assert_eq!(address_registry::derive_kind(&reg, PARTNER, cross_chain(), true), cross_chain());
    address_registry::destroy_for_testing(reg);
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
fun a_cctp_payment_declared_as_a_wallet_aborts() {
    let mut ctx = tx_context::dummy();
    let reg = classified(&mut ctx);
    address_registry::derive_kind(&reg, SUPPLIER, wallet(), true);
    address_registry::destroy_for_testing(reg);
}

#[test]
/// A business wallet is a Splash business payment, free, whatever was
/// declared.
fun a_business_wallet_is_a_splash_business_payment_whatever_was_declared() {
    let mut ctx = tx_context::dummy();
    let reg = classified(&mut ctx);
    assert_eq!(derive(&reg, BUSINESS_WALLET, sb()), sb());
    assert_eq!(derive(&reg, BUSINESS_WALLET, wallet()), sb());
    assert_eq!(derive(&reg, BUSINESS_WALLET, exchange()), sb());
    assert_eq!(derive(&reg, BUSINESS_WALLET, bank()), sb());
    address_registry::destroy_for_testing(reg);
}

#[test]
/// A partner deposit address is a bank payout whatever was declared: it
/// cannot be dodged by declaring a wallet. A1 §3: 5,000 USDC to a partner
/// address declared WALLET pays the bank fee.
fun a_partner_address_is_a_bank_payout_whatever_was_declared() {
    let mut ctx = tx_context::dummy();
    let reg = classified(&mut ctx);
    assert_eq!(derive(&reg, PARTNER, bank()), bank());
    assert_eq!(derive(&reg, PARTNER, wallet()), bank());
    assert_eq!(derive(&reg, PARTNER, exchange()), bank());
    let cfg = fee_config::new_for_testing(PUBLISHER, &mut ctx);
    let kind = derive(&reg, PARTNER, wallet());
    assert_eq!(fee_config::splash_fee(&cfg, object::id_from_address(@0xB), kind, 5_000 * USD), 10_000_000);
    fee_config::destroy_for_testing(cfg);
    address_registry::destroy_for_testing(reg);
}

#[test]
/// Anything else is what it declared, a wallet or an exchange.
fun any_other_address_is_the_wallet_or_exchange_it_declared() {
    let mut ctx = tx_context::dummy();
    let reg = classified(&mut ctx);
    assert_eq!(derive(&reg, SUPPLIER, wallet()), wallet());
    assert_eq!(derive(&reg, SUPPLIER, exchange()), exchange());
    address_registry::destroy_for_testing(reg);
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// A declared bank payout to an address outside the partner registry aborts.
fun a_declared_bank_payout_to_an_unregistered_address_aborts() {
    let mut ctx = tx_context::dummy();
    let reg = classified(&mut ctx);
    derive(&reg, SUPPLIER, bank());
    address_registry::destroy_for_testing(reg);
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// So does a declared Splash-business payment to an address that is not a
/// business wallet.
fun a_declared_splash_business_payment_to_a_non_business_wallet_aborts() {
    let mut ctx = tx_context::dummy();
    let reg = classified(&mut ctx);
    derive(&reg, SUPPLIER, sb());
    address_registry::destroy_for_testing(reg);
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// A cross-chain kind outside CCTP aborts.
fun a_declared_cross_chain_payment_outside_cctp_aborts() {
    let mut ctx = tx_context::dummy();
    let reg = classified(&mut ctx);
    derive(&reg, SUPPLIER, cross_chain());
    address_registry::destroy_for_testing(reg);
}

// ─── The partner deposit-address registry ──────────────────────────────────

#[test]
/// Ops adds and removes a partner address; each takes effect at once and is
/// evented. After removal the address is an ordinary one again.
fun ops_adds_and_removes_a_partner_address_at_once() {
    let mut s = ts::begin(PUBLISHER);
    address_registry::init_for_testing(s.ctx());
    s.next_tx(PUBLISHER);
    {
        let cap = s.take_from_sender<OpsCap>();
        let mut reg = s.take_shared<Registry>();
        address_registry::add_partner_address(&cap, &mut reg, PARTNER);
        assert_eq!(address_registry::is_partner_address(&reg, PARTNER), true);
        assert_eq!(derive(&reg, PARTNER, wallet()), bank());
        ts::return_shared(reg);
        s.return_to_sender(cap);
    };
    {
        let added = event::events_by_type<address_registry::PartnerAddressAdded>();
        assert_eq!(added.length(), 1);
        assert_eq!(address_registry::unpack_partner_address_added_for_testing(added[0]), PARTNER);
    };
    s.next_tx(PUBLISHER);
    {
        let cap = s.take_from_sender<OpsCap>();
        let mut reg = s.take_shared<Registry>();
        address_registry::remove_partner_address(&cap, &mut reg, PARTNER);
        assert_eq!(address_registry::is_partner_address(&reg, PARTNER), false);
        assert_eq!(derive(&reg, PARTNER, wallet()), wallet());
        ts::return_shared(reg);
        s.return_to_sender(cap);
    };
    {
        let removed = event::events_by_type<address_registry::PartnerAddressRemoved>();
        assert_eq!(removed.length(), 1);
        assert_eq!(address_registry::unpack_partner_address_removed_for_testing(removed[0]), PARTNER);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_ALREADY_A_PARTNER_ADDRESS)]
fun adding_a_partner_address_twice_aborts() {
    let mut ctx = tx_context::dummy();
    let mut reg = classified(&mut ctx);
    let cap = address_registry::ops_cap_for_testing(&mut ctx);
    address_registry::add_partner_address(&cap, &mut reg, PARTNER);
    address_registry::destroy_ops_cap_for_testing(cap);
    address_registry::destroy_for_testing(reg);
}

#[test]
#[expected_failure(abort_code = address_registry::E_NOT_A_PARTNER_ADDRESS)]
fun removing_an_address_that_is_not_a_partner_aborts() {
    let mut ctx = tx_context::dummy();
    let mut reg = classified(&mut ctx);
    let cap = address_registry::ops_cap_for_testing(&mut ctx);
    address_registry::remove_partner_address(&cap, &mut reg, SUPPLIER);
    address_registry::destroy_ops_cap_for_testing(cap);
    address_registry::destroy_for_testing(reg);
}

#[test]
#[expected_failure(abort_code = address_registry::E_INVALID_ADDRESS)]
fun the_zero_address_is_not_a_partner_address() {
    let mut ctx = tx_context::dummy();
    let mut reg = classified(&mut ctx);
    let cap = address_registry::ops_cap_for_testing(&mut ctx);
    address_registry::add_partner_address(&cap, &mut reg, @0x0);
    address_registry::destroy_ops_cap_for_testing(cap);
    address_registry::destroy_for_testing(reg);
}

// ─── The business-wallet registry ──────────────────────────────────────────

fun is_business_wallet(s: &mut Scenario, addr: address): bool {
    s.next_tx(h::owner_1());
    let reg = s.take_shared<Registry>();
    let yes = address_registry::is_business_wallet(&reg, addr);
    ts::return_shared(reg);
    yes
}

#[test]
/// `register_wallet` writes the business wallet into the registry.
fun registering_a_wallet_registers_it_as_a_business_wallet() {
    let mut s = h::setup_without_wallet();
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    h::register_wallet(&mut s);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    s.end();
}

/// The 2-of-2 of passkeys 1 and 2.
fun pair(): address { multisig::derive_address(&vector[h::passkey(0), h::passkey(1)], &vector[1, 1], 2) }

fun propose_pair(s: &mut Scenario) {
    s.next_tx(h::wallet());
    let mut account = s.take_shared<BusinessAccount>();
    business_account::rotate_wallet(&mut account, vector[h::passkey(0), h::passkey(1)], vector[1, 1], 2, false, s.ctx());
    ts::return_shared(account);
}

#[test]
/// A proposed rotation changes nothing; the confirmed one moves the
/// registration from the old wallet to the new.
fun a_confirmed_rotation_moves_the_registration() {
    let mut s = h::setup();
    propose_pair(&mut s);
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    assert_eq!(is_business_wallet(&mut s, pair()), false);
    h::confirm_rotation(&mut s, pair());
    assert_eq!(is_business_wallet(&mut s, h::wallet()), false);
    assert_eq!(is_business_wallet(&mut s, pair()), true);
    s.end();
}

#[test]
/// A cancelled rotation leaves the old wallet registered.
fun a_cancelled_rotation_leaves_the_registration() {
    let mut s = h::setup();
    propose_pair(&mut s);
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::cancel_wallet_rotation(&mut account, s.ctx());
        ts::return_shared(account);
    };
    assert_eq!(is_business_wallet(&mut s, h::wallet()), true);
    assert_eq!(is_business_wallet(&mut s, pair()), false);
    s.end();
}

#[test]
/// Two accounts whose wallet is the same multisig: rotating one away keeps
/// the address registered for the other.
fun a_wallet_shared_by_two_accounts_stays_registered_until_both_rotate_away() {
    let mut ctx = tx_context::dummy();
    let mut reg = address_registry::new_for_testing(&mut ctx);
    address_registry::add_business_wallet_for_testing(&mut reg, BUSINESS_WALLET);
    address_registry::add_business_wallet_for_testing(&mut reg, BUSINESS_WALLET);
    address_registry::remove_business_wallet_for_testing(&mut reg, BUSINESS_WALLET);
    assert_eq!(address_registry::is_business_wallet(&reg, BUSINESS_WALLET), true);
    address_registry::remove_business_wallet_for_testing(&mut reg, BUSINESS_WALLET);
    assert_eq!(address_registry::is_business_wallet(&reg, BUSINESS_WALLET), false);
    address_registry::destroy_for_testing(reg);
}

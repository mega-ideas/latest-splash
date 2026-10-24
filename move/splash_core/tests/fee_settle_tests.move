/// The fee leg at settlement (Amendment A1 §1.2, §2.6, §2.9).
///
/// Written from the amendment. What is pinned here, on every v2 settle path
/// (the wallet's coin and balance paths, the cross-chain path and a
/// settlement app's path):
///
///   * the fee is computed from the DERIVED kind and the principal, never
///     from anything the intent or the PTB says the fee is;
///   * the payer bounds it: `max_fee` is what the UI showed, and a fee above
///     it aborts (EFeeAboveMax), so a schedule raised after the quote was
///     rendered cannot charge the signer more;
///   * the fee leg is split inside Move and sent to `FeeConfig.fee_recipient`;
///     a fee of 0 sends nothing and makes no zero coin, and no FeeCharged is
///     emitted;
///   * the principal reaches the recipient, and every remainder (an
///     overpayment, the unused part of `max_fee`) goes to the account's
///     business wallet, never to the transaction's sender;
///   * a cross-chain payment pays Splash's fee in USDC on Sui, before the
///     burn, and the coin handed to the bridge is exactly the principal;
///   * FeeCharged carries the intent, the business account, the derived kind,
///     the fee and the recipient;
///   * a payment whose derived kind differs from its declared kind is
///     refused (EKindMismatch), on the owners' paths and a settlement app's,
///     except a declared wallet or exchange payment to a registered business
///     wallet, which is free (Sky, 24 Oct, FIXUP 3). So a payment to a
///     partner deposit address is always a declared bank payout, with its
///     floor and its beneficiary.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::fee_settle_tests;

use splash_core::address_registry::{Self, Registry};
use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::fee_config::{Self, FeeConfig, FeeCharged};
use splash_core::multisig;
use splash_core::payment_intent::{Self, PaymentIntent};
use splash_core::v2_harness::{Self as h, USDC};
use std::unit_test::assert_eq;
use sui::balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

/// A settlement app's witness, standing in for `splash_spend::SettleWitness`.
public struct TestApp has drop {}

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";
const USD: u64 = 1_000_000;
const QUOTE_MS: u64 = 300_000;
const U64_MAX: u64 = 18_446_744_073_709_551_615;

/// A payout partner's deposit address, registered by ops.
const PARTNER: address = @0xBA4C;
/// A supplier's own wallet: in no registry.
const SUPPLIER: address = @0x5011D;
const STAFF: address = @0x57AFF;
const MINT_RECIPIENT: address = @0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045;
const SOLANA: u32 = 5;

/// 5,000 USDC: the 1,000-9,999 band, 20 bps on a bank payout: 10 USDC.
const PRINCIPAL: u64 = 5_000_000_000;
const BANK_FEE: u64 = 10_000_000;

const GOV_PASSKEY: vector<u8> = x"060355969b344645e48573e045cdbf4cbb0adb4369d411962cfc8a6ae3c33b8acf16";
const GOV_ZKLOGIN: vector<u8> = x"051b68747470733a2f2f6163636f756e74732e676f6f676c652e636f6d00000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad2";
const GOV_ED25519: vector<u8> = x"00d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";

fun gov_keys(): vector<vector<u8>> { vector[GOV_PASSKEY, GOV_ZKLOGIN, GOV_ED25519] }
fun gov_weights(): vector<u8> { vector[1, 1, 1] }
fun gov(): address { multisig::derive_address(&gov_keys(), &gov_weights(), 2) }

fun wallet_kind(): u8 { payment_intent::kind_wallet() }
fun bank(): u8 { payment_intent::kind_bank_payout() }
fun sb(): u8 { payment_intent::kind_splash_business() }

// ─── Harness ───────────────────────────────────────────────────────────────

/// The harness account with its wallet, and PARTNER registered by ops.
fun setup(): Scenario {
    let mut s = h::setup();
    h::add_partner(&mut s, PARTNER);
    s
}

/// Run `$body` as `$sender` with the shared account, configs, registry and clock.
macro fun tx(
    $s: &mut Scenario,
    $sender: address,
    $body: |&mut BusinessAccount, &ComplianceConfig, &FeeConfig, &Registry, &mut Clock, &mut TxContext|,
) {
    let s = $s;
    s.next_tx($sender);
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let fees = s.take_shared<FeeConfig>();
    let reg = s.take_shared<Registry>();
    let mut c = s.take_shared<Clock>();
    $body(&mut account, &config, &fees, &reg, &mut c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(reg);
    ts::return_shared(fees);
    ts::return_shared(config);
    ts::return_shared(account);
}

fun advance(s: &mut Scenario, ms: u64) {
    s.next_tx(h::owner_1());
    let mut c = s.take_shared<Clock>();
    c.increment_for_testing(ms);
    ts::return_shared(c);
}

/// The wallet opens an intent of `kind` to `to` for `amount`.
fun open(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    kind: u8,
    to: address,
    amount: u64,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    h::wallet_intent_of_kind(account, config, n, kind, to, amount, c, ctx)
}

/// The wallet pays `intent` with a coin of `paid`, bounding the fee by `max_fee`.
fun pay(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    fees: &FeeConfig,
    reg: &Registry,
    paid: u64,
    max_fee: u64,
    c: &Clock,
    ctx: &mut TxContext,
) {
    let payment = h::usdc(paid, ctx);
    let receipt = payment_intent::confirm_from_business_wallet(
        intent, account, config, fees, reg, payment, max_fee, h::settle_by(c), c, ctx,
    );
    audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
}

fun pay_balance(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    fees: &FeeConfig,
    reg: &Registry,
    paid: u64,
    max_fee: u64,
    c: &Clock,
    ctx: &mut TxContext,
) {
    let funds = balance::create_for_testing<USDC>(paid);
    let receipt = payment_intent::confirm_from_business_wallet_balance(
        intent, account, config, fees, reg, funds, max_fee, h::settle_by(c), c, ctx,
    );
    audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
}

/// Open and pay a wallet-made intent in one transaction, then delete it.
fun open_and_pay(s: &mut Scenario, n: u8, kind: u8, to: address, amount: u64, paid: u64, max_fee: u64) {
    tx!(s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = open(account, config, n, kind, to, amount, c, ctx);
        pay(&mut intent, account, config, fees, reg, paid, max_fee, c, ctx);
        payment_intent::delete_finalized(intent);
    });
}

/// The one FeeCharged of the last transaction.
fun charged(): (ID, ID, u8, u64, address) {
    let events = event::events_by_type<FeeCharged>();
    assert_eq!(events.length(), 1);
    fee_config::unpack_fee_charged_for_testing(events[0])
}

fun account_id(s: &mut Scenario): ID {
    s.next_tx(h::owner_1());
    let account = s.take_shared<BusinessAccount>();
    let id = object::id(&account);
    ts::return_shared(account);
    id
}

fun assert_coin_at(s: &mut Scenario, who: address, amount: u64) {
    s.next_tx(who);
    let c = s.take_from_address<Coin<USDC>>(who);
    assert_eq!(coin::value(&c), amount);
    ts::return_to_address(who, c);
}

// ─── The owners' path ──────────────────────────────────────────────────────

#[test]
/// A bank payout to a partner: the principal reaches the partner as a coin,
/// the fee reaches the fee recipient's address balance, and FeeCharged says
/// so. Paid exactly principal + fee, so nothing is left over.
fun the_fee_leg_goes_to_the_fee_recipient_and_the_principal_to_the_recipient() {
    let mut s = setup();
    let business = account_id(&mut s);
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = open(account, config, 1, bank(), PARTNER, PRINCIPAL, c, ctx);
        let intent_id = object::id(&intent);
        pay(&mut intent, account, config, fees, reg, PRINCIPAL + BANK_FEE, BANK_FEE, c, ctx);
        let (id, who, kind, fee, to) = charged();
        assert_eq!(id, intent_id);
        assert_eq!(who, business);
        assert_eq!(kind, bank());
        assert_eq!(fee, BANK_FEE);
        assert_eq!(to, h::fee_recipient());
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), BANK_FEE);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 0);
    assert_coin_at(&mut s, PARTNER, PRINCIPAL);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_FEE_ABOVE_MAX)]
/// A fee above the payer's bound aborts, even when the payment covers it.
fun a_fee_above_max_fee_aborts() {
    let mut s = setup();
    open_and_pay(&mut s, 1, bank(), PARTNER, PRINCIPAL, PRINCIPAL + BANK_FEE, BANK_FEE - 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INSUFFICIENT_PAYMENT)]
/// The payment must cover the principal and the fee.
fun a_payment_short_of_principal_plus_fee_aborts() {
    let mut s = setup();
    open_and_pay(&mut s, 1, bank(), PARTNER, PRINCIPAL, PRINCIPAL + BANK_FEE - 1, BANK_FEE);
    s.end();
}

#[test]
/// An overpayment, and the part of max_fee the fee did not use, go to the
/// account's business wallet's address balance.
fun every_remainder_goes_to_the_business_wallet() {
    let mut s = setup();
    open_and_pay(&mut s, 1, bank(), PARTNER, PRINCIPAL, PRINCIPAL + BANK_FEE + 7 * USD, BANK_FEE + 3 * USD);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 7 * USD);
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), BANK_FEE);
    assert_coin_at(&mut s, PARTNER, PRINCIPAL);
    s.end();
}

#[test]
/// The balance path pays the fee leg the same way.
fun the_balance_path_pays_the_fee_leg() {
    let mut s = setup();
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = open(account, config, 1, bank(), PARTNER, PRINCIPAL, c, ctx);
        pay_balance(&mut intent, account, config, fees, reg, PRINCIPAL + BANK_FEE + USD, BANK_FEE, c, ctx);
        let (_, _, kind, fee, _) = charged();
        assert_eq!(kind, bank());
        assert_eq!(fee, BANK_FEE);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), BANK_FEE);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), USD);
    assert_coin_at(&mut s, PARTNER, PRINCIPAL);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_FEE_ABOVE_MAX)]
fun the_balance_path_refuses_a_fee_above_max_fee() {
    let mut s = setup();
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = open(account, config, 1, bank(), PARTNER, PRINCIPAL, c, ctx);
        pay_balance(&mut intent, account, config, fees, reg, PRINCIPAL + BANK_FEE, BANK_FEE - 1, c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// FIXUP 3: a partner deposit address declared as a wallet is refused, not
/// charged as a bank payout, so it can never skip the bank payout's floor
/// and its beneficiary. The payer offered the bank fee; it still aborts.
fun a_partner_address_declared_as_a_wallet_is_refused() {
    let mut s = setup();
    open_and_pay(&mut s, 1, wallet_kind(), PARTNER, PRINCIPAL, PRINCIPAL + BANK_FEE, BANK_FEE);
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// So is one declared as an exchange.
fun a_partner_address_declared_as_an_exchange_is_refused() {
    let mut s = setup();
    open_and_pay(&mut s, 1, payment_intent::kind_exchange(), PARTNER, PRINCIPAL, PRINCIPAL + BANK_FEE, BANK_FEE);
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// And on the balance path.
fun the_balance_path_refuses_a_partner_address_declared_as_a_wallet() {
    let mut s = setup();
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = open(account, config, 1, wallet_kind(), PARTNER, PRINCIPAL, c, ctx);
        pay_balance(&mut intent, account, config, fees, reg, PRINCIPAL + BANK_FEE, BANK_FEE, c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// A declared bank payout to a registered business wallet is refused rather
/// than settled free: only a declared wallet or exchange payment becomes a
/// Splash-business payment.
fun a_declared_bank_payout_to_a_business_wallet_is_refused() {
    let mut s = setup();
    let other = h::add_business_wallet(&mut s, @0xB12B12);
    open_and_pay(&mut s, 1, bank(), other, PRINCIPAL, PRINCIPAL + BANK_FEE, BANK_FEE);
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// A declared Splash-business payment to a partner deposit address is
/// refused.
fun a_declared_splash_business_payment_to_a_partner_address_is_refused() {
    let mut s = setup();
    open_and_pay(&mut s, 1, sb(), PARTNER, PRINCIPAL, PRINCIPAL + BANK_FEE, BANK_FEE);
    s.end();
}

#[test]
/// The one documented exception: a declared wallet or exchange payment to a
/// registered business wallet is a free Splash-business payment, and so is
/// one declared as a Splash business.
fun a_declared_wallet_exchange_or_splash_business_payment_to_a_business_wallet_is_free() {
    let mut s = setup();
    let other = h::add_business_wallet(&mut s, @0xB12B12);
    open_and_pay(&mut s, 1, payment_intent::kind_exchange(), other, PRINCIPAL, PRINCIPAL, 0);
    open_and_pay(&mut s, 2, wallet_kind(), other, PRINCIPAL, PRINCIPAL, 0);
    open_and_pay(&mut s, 3, sb(), other, PRINCIPAL, PRINCIPAL, 0);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(other), 3 * PRINCIPAL);
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 0);
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// A declared bank payout to an address outside the partner registry aborts.
fun a_declared_bank_payout_to_an_unregistered_address_aborts() {
    let mut s = setup();
    open_and_pay(&mut s, 1, bank(), SUPPLIER, PRINCIPAL, PRINCIPAL + BANK_FEE, BANK_FEE);
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// So does a declared Splash-business payment to an address that is not a
/// business wallet.
fun a_declared_splash_business_payment_to_a_non_business_wallet_aborts() {
    let mut s = setup();
    open_and_pay(&mut s, 1, sb(), SUPPLIER, PRINCIPAL, PRINCIPAL, 0);
    s.end();
}

#[test]
/// A wallet payment: 10,000 USDC at 2 bps pays 2 USDC; 10 USDC pays 1%.
fun a_wallet_payment_pays_the_wallet_schedule() {
    let mut s = setup();
    open_and_pay(&mut s, 1, wallet_kind(), SUPPLIER, 10_000 * USD, 10_000 * USD + 2 * USD, 2 * USD);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 2 * USD);
    open_and_pay(&mut s, 2, wallet_kind(), SUPPLIER, 10 * USD, 10 * USD + 100_000, 100_000);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 2 * USD + 100_000);
    s.end();
}

#[test]
/// A payment to another Splash business is free: no transfer, no zero coin,
/// no FeeCharged. It is credited to the business wallet's address balance,
/// even though it was declared a wallet payment.
fun no_fee_leg_when_the_fee_is_zero() {
    let mut s = setup();
    let other = h::add_business_wallet(&mut s, @0xB12B12);
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = open(account, config, 1, wallet_kind(), other, PRINCIPAL, c, ctx);
        pay(&mut intent, account, config, fees, reg, PRINCIPAL, 0, c, ctx);
        assert_eq!(event::events_by_type<FeeCharged>().length(), 0);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 0);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(h::fee_recipient()));
    assert_eq!(ts::settled_balance<USDC>(other), PRINCIPAL);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(other));
    s.end();
}

#[test]
/// A discount set for this business lowers what it is charged at once.
fun a_discount_lowers_the_fee_charged() {
    let mut s = setup();
    let business = account_id(&mut s);
    h::set_discount(&mut s, business, 10);
    open_and_pay(&mut s, 1, bank(), PARTNER, PRINCIPAL, PRINCIPAL + 5 * USD, 5 * USD);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 5 * USD);
    s.end();
}

#[test]
/// The fee recipient is read from the config at settlement: after a 24-hour
/// change, the fee goes to the new one.
fun the_fee_goes_to_the_current_fee_recipient() {
    let mut s = setup();
    let finance = h::change_fee_recipient(&mut s);
    open_and_pay(&mut s, 1, bank(), PARTNER, PRINCIPAL, PRINCIPAL + BANK_FEE, BANK_FEE);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(finance), BANK_FEE);
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 0);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_FEE_ABOVE_MAX)]
/// A schedule raised between the quote and the payment cannot charge the
/// signer more than the fee they were shown: the payment aborts and needs a
/// fresh quote.
fun a_schedule_raised_after_the_quote_aborts_the_payment() {
    let mut s = setup();
    h::change_schedule(&mut s, bank(), vector[U64_MAX], vector[30], 0, U64_MAX);
    open_and_pay(&mut s, 1, bank(), PARTNER, PRINCIPAL, PRINCIPAL + 15 * USD, BANK_FEE);
    s.end();
}

// ─── Fees are off until the first recipient change (FIXUP 1) ───────────────

#[test]
/// While no fee recipient has been applied, Splash's fees are off: the
/// owners' coin path settles a bank payout with max_fee 0, sends no fee leg,
/// makes no zero coin, emits no FeeCharged, and the whole remainder goes to
/// the business wallet.
fun with_fees_off_the_owners_path_charges_nothing() {
    let mut s = setup();
    h::turn_fees_off(&mut s);
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = open(account, config, 1, bank(), PARTNER, PRINCIPAL, c, ctx);
        pay(&mut intent, account, config, fees, reg, PRINCIPAL + BANK_FEE, 0, c, ctx);
        assert_eq!(event::events_by_type<FeeCharged>().length(), 0);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 0);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(h::fee_recipient()));
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), BANK_FEE);
    assert_coin_at(&mut s, PARTNER, PRINCIPAL);
    s.end();
}

#[test]
/// The balance path and the cross-chain path charge nothing either.
fun with_fees_off_the_balance_and_cross_chain_paths_charge_nothing() {
    let mut s = setup();
    h::turn_fees_off(&mut s);
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = open(account, config, 1, bank(), PARTNER, PRINCIPAL, c, ctx);
        pay_balance(&mut intent, account, config, fees, reg, PRINCIPAL, 0, c, ctx);
        payment_intent::delete_finalized(intent);
        let mut intent = payment_intent::create_cross_chain_for_wallet<USDC>(
            account, config, h::payment_ref(2), SOLANA, MINT_RECIPIENT, PRINCIPAL, h::commitment(), h::rail(),
            50_000, 1_000, c.timestamp_ms() + QUOTE_MS, c, ctx,
        );
        let payment = h::usdc(PRINCIPAL + USD, ctx);
        let (receipt, to_bridge, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
            &mut intent, account, config, fees, reg, payment, 0, h::settle_by(c), c, ctx,
        );
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
        assert_eq!(coin::value(&to_bridge), PRINCIPAL);
        let (_, _, _, _, _, _, _, _) = payment_intent::unpack_bridge_obligation_for_testing(obligation);
        coin::burn_for_testing(to_bridge);
        assert_eq!(event::events_by_type<FeeCharged>().length(), 0);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 0);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), USD);
    s.end();
}

#[test]
/// The first recipient change, applied after its 24 hours, turns the fees
/// on: the next payment pays the schedule's fee to that recipient.
fun the_first_applied_recipient_turns_the_fees_on() {
    let mut s = setup();
    h::turn_fees_off(&mut s);
    open_and_pay(&mut s, 1, bank(), PARTNER, PRINCIPAL, PRINCIPAL, 0);
    let finance = h::change_fee_recipient(&mut s);
    open_and_pay(&mut s, 2, bank(), PARTNER, PRINCIPAL, PRINCIPAL + BANK_FEE, BANK_FEE);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(finance), BANK_FEE);
    s.end();
}

#[test]
/// A settlement app's path charges nothing too, and tells the app the fee
/// was 0; all of max_fee goes back to the business wallet.
fun with_fees_off_the_app_path_charges_nothing() {
    let mut s = setup();
    register_app(&mut s);
    h::turn_fees_off(&mut s);
    let (kind, fee) = app_pays(&mut s, PRINCIPAL + BANK_FEE, BANK_FEE, bank());
    assert_eq!(kind, bank());
    assert_eq!(fee, 0);
    assert_eq!(event::events_by_type<FeeCharged>().length(), 0);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 0);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), BANK_FEE);
    s.end();
}

// ─── Cross-chain ───────────────────────────────────────────────────────────

#[test]
/// A cross-chain payment pays Splash's fee in USDC on Sui before the burn:
/// the coin for the bridge is exactly the principal, the fee is on Sui at
/// the fee recipient, and the change is in the business wallet.
fun the_cross_chain_fee_is_paid_on_sui_before_the_burn() {
    let mut s = setup();
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = payment_intent::create_cross_chain_for_wallet<USDC>(
            account, config, h::payment_ref(1), SOLANA, MINT_RECIPIENT, PRINCIPAL, h::commitment(), h::rail(),
            50_000, 1_000, c.timestamp_ms() + QUOTE_MS, c, ctx,
        );
        let payment = h::usdc(PRINCIPAL + BANK_FEE + USD, ctx);
        let (receipt, to_bridge, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
            &mut intent, account, config, fees, reg, payment, BANK_FEE, h::settle_by(c), c, ctx,
        );
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
        assert_eq!(coin::value(&to_bridge), PRINCIPAL);
        let (_, _, _, amount, _, _, _, _) = payment_intent::unpack_bridge_obligation_for_testing(obligation);
        assert_eq!(amount, PRINCIPAL);
        coin::burn_for_testing(to_bridge);
        let (_, _, kind, fee, _) = charged();
        assert_eq!(kind, payment_intent::kind_cross_chain());
        assert_eq!(fee, BANK_FEE);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), BANK_FEE);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_FEE_ABOVE_MAX)]
fun the_cross_chain_path_refuses_a_fee_above_max_fee() {
    let mut s = setup();
    tx!(&mut s, h::wallet(), |account, config, fees, reg, c, ctx| {
        let mut intent = payment_intent::create_cross_chain_for_wallet<USDC>(
            account, config, h::payment_ref(1), SOLANA, MINT_RECIPIENT, PRINCIPAL, h::commitment(), h::rail(),
            50_000, 1_000, c.timestamp_ms() + QUOTE_MS, c, ctx,
        );
        let payment = h::usdc(PRINCIPAL + BANK_FEE, ctx);
        let (receipt, to_bridge, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
            &mut intent, account, config, fees, reg, payment, BANK_FEE - 1, h::settle_by(c), c, ctx,
        );
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
        let (_, _, _, _, _, _, _, _) = payment_intent::unpack_bridge_obligation_for_testing(obligation);
        coin::burn_for_testing(to_bridge);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

// ─── A settlement app's path ───────────────────────────────────────────────

/// Put TestApp on the settlement-app registry through the 24-hour path.
fun register_app(s: &mut Scenario) {
    let registry = compliance_config::registry_settlement_app();
    s.next_tx(gov());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::propose_addition<TestApp>(&admin, &mut config, registry, gov_keys(), gov_weights(), 2, &c, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
    advance(s, compliance_config::addition_notice_ms());
    s.next_tx(gov());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::activate_addition<TestApp>(&admin, &mut config, registry, gov_keys(), gov_weights(), 2, &c, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
}

/// STAFF opens a bank payout to PARTNER through the app and settles it with
/// `drawn`, bounding the fee by `max_fee`. Returns (derived kind, fee).
fun app_pays(s: &mut Scenario, drawn: u64, max_fee: u64, declared: u8): (u8, u64) {
    s.next_tx(STAFF);
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let fees = s.take_shared<FeeConfig>();
    let reg = s.take_shared<Registry>();
    let c = s.take_shared<Clock>();
    let mut intent = payment_intent::create_for_app<USDC, TestApp>(
        TestApp {}, &mut account, &config, STAFF, h::payment_ref(1), PARTNER, h::beneficiary(), PRINCIPAL,
        b"PHP".to_string(), 56_000_000, h::commitment(), bank(), h::rail(), c.timestamp_ms() + QUOTE_MS, &c, s.ctx(),
    );
    let funds = balance::create_for_testing<USDC>(drawn);
    let (receipt, kind, fee) = payment_intent::settle_from_app<USDC, TestApp>(
        TestApp {}, &mut intent, &mut account, &config, &fees, &reg, declared, funds, max_fee, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    payment_intent::delete_finalized(intent);
    ts::return_shared(c);
    ts::return_shared(reg);
    ts::return_shared(fees);
    ts::return_shared(config);
    ts::return_shared(account);
    (kind, fee)
}

#[test]
/// Under a spending rule the app draws principal + max_fee: the principal
/// reaches the partner, the fee the fee recipient, the unused part of
/// max_fee the business wallet, and the staff sender gets nothing. The app
/// learns the derived kind and the fee charged.
fun the_app_path_returns_the_unused_max_fee_to_the_wallet_not_the_sender() {
    let mut s = setup();
    register_app(&mut s);
    let (kind, fee) = app_pays(&mut s, PRINCIPAL + BANK_FEE + 3 * USD, BANK_FEE + 3 * USD, bank());
    assert_eq!(kind, bank());
    assert_eq!(fee, BANK_FEE);
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), BANK_FEE);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 3 * USD);
    assert_eq!(ts::settled_balance<USDC>(STAFF), 0);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(STAFF));
    assert_coin_at(&mut s, PARTNER, PRINCIPAL);
    s.end();
}

#[test]
/// With the fee exactly max_fee nothing is left over, and nothing is sent to
/// the wallet.
fun the_app_path_with_an_exact_max_fee_leaves_nothing() {
    let mut s = setup();
    register_app(&mut s);
    app_pays(&mut s, PRINCIPAL + BANK_FEE, BANK_FEE, bank());
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 0);
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), BANK_FEE);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_FEE_ABOVE_MAX)]
fun the_app_path_refuses_a_fee_above_max_fee() {
    let mut s = setup();
    register_app(&mut s);
    app_pays(&mut s, PRINCIPAL + BANK_FEE - 1, BANK_FEE - 1, bank());
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_EXACT_AMOUNT_REQUIRED)]
/// The app draws exactly principal + max_fee, no more and no less.
fun the_app_path_requires_exactly_principal_plus_max_fee() {
    let mut s = setup();
    register_app(&mut s);
    app_pays(&mut s, PRINCIPAL + BANK_FEE + 1, BANK_FEE, bank());
    s.end();
}

/// STAFF opens an intent of `kind` to `to` through the app and settles it
/// declaring `declared`, with the bank fee as max_fee.
fun app_pays_kind(s: &mut Scenario, kind: u8, to: address, declared: u8) {
    s.next_tx(STAFF);
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let fees = s.take_shared<FeeConfig>();
    let reg = s.take_shared<Registry>();
    let c = s.take_shared<Clock>();
    let beneficiary = if (kind == bank()) h::beneficiary() else vector[];
    let mut intent = payment_intent::create_for_app<USDC, TestApp>(
        TestApp {}, &mut account, &config, STAFF, h::payment_ref(1), to, beneficiary, PRINCIPAL,
        b"PHP".to_string(), 56_000_000, h::commitment(), kind, h::rail(), c.timestamp_ms() + QUOTE_MS, &c, s.ctx(),
    );
    let funds = balance::create_for_testing<USDC>(PRINCIPAL + BANK_FEE);
    let (receipt, _, _) = payment_intent::settle_from_app<USDC, TestApp>(
        TestApp {}, &mut intent, &mut account, &config, &fees, &reg, declared, funds, BANK_FEE, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    payment_intent::delete_finalized(intent);
    ts::return_shared(c);
    ts::return_shared(reg);
    ts::return_shared(fees);
    ts::return_shared(config);
    ts::return_shared(account);
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// FIXUP 3 on the app path, as splash_spend already refuses it: an intent
/// opened as a wallet payment to a partner deposit address, with a wallet
/// tag, is refused in core too.
fun the_app_path_refuses_a_partner_address_declared_as_a_wallet() {
    let mut s = setup();
    register_app(&mut s);
    app_pays_kind(&mut s, wallet_kind(), PARTNER, wallet_kind());
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// And a bank payout the app declares with a wallet tag: the tag must fit
/// the derived kind as the intent's kind must.
fun the_app_path_refuses_a_tag_that_does_not_fit() {
    let mut s = setup();
    register_app(&mut s);
    app_pays_kind(&mut s, bank(), PARTNER, wallet_kind());
    s.end();
}

#[test]
/// A wallet-tagged payment to a registered business wallet is free on the
/// app path too.
fun the_app_path_pays_a_business_wallet_tagged_a_wallet_free() {
    let mut s = setup();
    register_app(&mut s);
    let other = h::add_business_wallet(&mut s, @0xB12B12);
    app_pays_kind(&mut s, wallet_kind(), other, wallet_kind());
    s.next_tx(h::owner_1());
    assert_eq!(ts::settled_balance<USDC>(other), PRINCIPAL);
    assert_eq!(ts::settled_balance<USDC>(h::fee_recipient()), 0);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), BANK_FEE);
    s.end();
}

#[test]
#[expected_failure(abort_code = address_registry::E_KIND_MISMATCH)]
/// The app's declared tag goes through derive_kind too: a partner address is
/// a bank payout whatever the tag says, and a bank tag needs a partner.
fun the_app_path_derives_the_kind_from_the_registry() {
    let mut s = setup();
    register_app(&mut s);
    h::remove_partner(&mut s, PARTNER);
    app_pays(&mut s, PRINCIPAL + BANK_FEE, BANK_FEE, bank());
    s.end();
}

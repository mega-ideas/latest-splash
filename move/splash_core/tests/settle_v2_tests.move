/// v2 settlement from the business wallet, and the cross-chain obligation.
///
/// Written from docs/v2/phase1-move-design.md (revision 2), section 3: "Settle
/// paths", "Delivery" and "Cross-chain". The owners' multisig is one of the
/// three paths that move a business's money to a third party, so every
/// property below is one a reviewer would otherwise have to take on trust:
/// only the wallet pays, it pays whoever opened the intent, every Splash
/// control still applies (pause, asset registry, KYB, both freezes, tier
/// ceilings, the bank-payout floor, the quote deadline), the money lands in the
/// form the recipient can use, change goes back to the wallet's address
/// balance, and a cross-chain payment cannot leave the transaction except
/// through a registered bridge adapter burning the very coin it was released
/// as.
///
/// Move tests do not check signatures, so a test acts as the multisig by
/// sending as its address (see `v2_harness`).
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::settle_v2_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::cap_registry::CapRegistry;
use splash_core::compliance_config::{Self, ComplianceConfig, ComplianceCap};
use splash_core::multisig;
use splash_core::payment_intent::{Self, PaymentIntent, BridgeObligation};
use splash_core::v2_harness::{Self as h, USDC};
use std::unit_test::assert_eq;
use sui::balance;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ─── Test types ────────────────────────────────────────────────────────────

/// A worthless coin, never on the registry.
public struct SCAM has drop {}
/// A second accepted asset, added through the 24-hour path, so the first can
/// be removed (the last accepted asset cannot be).
public struct USDC_V2 has drop {}
/// A settlement app's witness, registered through the 24-hour path, standing
/// in for `splash_spend::SettleWitness`.
public struct TestApp has drop {}
/// A bridge adapter's witness, standing in for a CCTP V2 adapter.
public struct TestBridge has drop {}
/// A second adapter type that is never registered.
public struct RogueBridge has drop {}

// ─── Constants ─────────────────────────────────────────────────────────────

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";

const USD: u64 = 1_000_000;
const HOUR: u64 = 3_600_000;
const QUOTE_MS: u64 = 300_000;
/// Tier 3's per-transfer ceiling and its daily ceiling: 20,000 USDC.
const TIER_3_CAP: u64 = 20_000_000_000;
/// `payment_intent::E_BELOW_SETTLEMENT_FLOOR`: a bank payout below the larger
/// of 99 USDC and `ComplianceConfig.min_settlement_amount`.
const BELOW_SETTLEMENT_FLOOR: u64 = 434;

/// A staff member, the maker an app vouches for.
const STAFF: address = @0x57AFF;
const STRANGER: address = @0xBADBAD;
/// Kind 3: a supplier's own wallet.
const SUPPLIER_WALLET: address = @0x5011D;
/// Kind 2: another Splash business.
const OTHER_BUSINESS: address = @0xB12B12;
/// Kind 4: an EVM address, left-padded to 32 bytes.
const MINT_RECIPIENT: address = @0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045;
/// CCTP domain 5 (Solana). Anything but 8.
const SOLANA: u32 = 5;
const MAX_FEE: u64 = 50_000;
const MIN_FINALITY: u32 = 1_000;

// The governance multisig (a 2-of-3 of a passkey, a zkLogin and an Ed25519
// key, `multisig_tests::MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3`). Distinct from
// the business wallet on purpose.
const GOV_PASSKEY: vector<u8> = x"060355969b344645e48573e045cdbf4cbb0adb4369d411962cfc8a6ae3c33b8acf16";
const GOV_ZKLOGIN: vector<u8> = x"051b68747470733a2f2f6163636f756e74732e676f6f676c652e636f6d00000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad2";
const GOV_ED25519: vector<u8> = x"00d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";

fun gov_keys(): vector<vector<u8>> { vector[GOV_PASSKEY, GOV_ZKLOGIN, GOV_ED25519] }
fun gov_weights(): vector<u8> { vector[1, 1, 1] }
fun gov(): address { multisig::derive_address(&gov_keys(), &gov_weights(), 2) }

// ─── Harness ───────────────────────────────────────────────────────────────

/// Run `$body` as `$sender` with the shared account, config and clock.
macro fun tx(
    $s: &mut Scenario,
    $sender: address,
    $body: |&mut BusinessAccount, &ComplianceConfig, &mut Clock, &mut TxContext|,
) {
    let s = $s;
    s.next_tx($sender);
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let mut c = s.take_shared<Clock>();
    $body(&mut account, &config, &mut c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
}

/// The same, with the one shared intent as well.
macro fun with_intent(
    $s: &mut Scenario,
    $sender: address,
    $body: |&mut PaymentIntent, &mut BusinessAccount, &ComplianceConfig, &mut Clock, &mut TxContext|,
) {
    let s = $s;
    s.next_tx($sender);
    let mut intent = s.take_shared<PaymentIntent>();
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let mut c = s.take_shared<Clock>();
    $body(&mut intent, &mut account, &config, &mut c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    ts::return_shared(intent);
}

fun advance(s: &mut Scenario, ms: u64) {
    s.next_tx(h::owner_1());
    let mut c = s.take_shared<Clock>();
    c.increment_for_testing(ms);
    ts::return_shared(c);
}

/// Pay from the wallet in a coin of `T`, and anchor the receipt.
fun pay_in<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    paid: u64,
    settle_by: u64,
    c: &Clock,
    ctx: &mut TxContext,
) {
    let payment = coin::mint_for_testing<T>(paid, ctx);
    let receipt = payment_intent::confirm_from_business_wallet(intent, account, config, payment, settle_by, c, ctx);
    audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
}

fun pay(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    paid: u64,
    settle_by: u64,
    c: &Clock,
    ctx: &mut TxContext,
) {
    pay_in<USDC>(intent, account, config, paid, settle_by, c, ctx)
}

/// Pay from the wallet with a `Balance<T>`, standing in for a redeemed
/// funds-withdrawal input, and anchor the receipt.
fun pay_balance_in<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    paid: u64,
    settle_by: u64,
    c: &Clock,
    ctx: &mut TxContext,
) {
    let funds = balance::create_for_testing<T>(paid);
    let receipt = payment_intent::confirm_from_business_wallet_balance(intent, account, config, funds, settle_by, c, ctx);
    audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
}

fun pay_balance(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    paid: u64,
    settle_by: u64,
    c: &Clock,
    ctx: &mut TxContext,
) {
    pay_balance_in<USDC>(intent, account, config, paid, settle_by, c, ctx)
}

/// The wallet opens a cross-chain intent to `MINT_RECIPIENT` on Solana.
fun cross_chain_intent(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    amount: u64,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    payment_intent::create_cross_chain_for_wallet<USDC>(
        account,
        config,
        h::payment_ref(n),
        SOLANA,
        MINT_RECIPIENT,
        amount,
        h::commitment(),
        h::rail(),
        MAX_FEE,
        MIN_FINALITY,
        c.timestamp_ms() + QUOTE_MS,
        c,
        ctx,
    )
}

/// Release a cross-chain intent from the wallet, anchoring the receipt.
/// Returns the coin and the obligation that must leave together.
fun release(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    paid: u64,
    settle_by: u64,
    c: &Clock,
    ctx: &mut TxContext,
): (Coin<USDC>, BridgeObligation) {
    let payment = h::usdc(paid, ctx);
    let (receipt, coin, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
        intent,
        account,
        config,
        payment,
        settle_by,
        c,
        ctx,
    );
    audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
    (coin, obligation)
}

/// Stand in for the adapter's burn where no adapter is under test.
fun burn(coin: Coin<USDC>, obligation: BridgeObligation) {
    let (_, _, _, _, _, _, _, _) = payment_intent::unpack_bridge_obligation_for_testing(obligation);
    coin::burn_for_testing(coin);
}

/// An app-made intent: `TestApp` vouches for `STAFF` as the maker.
fun app_intent(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    kind: u8,
    to: address,
    amount: u64,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    let beneficiary = if (kind == payment_intent::kind_bank_payout()) h::beneficiary() else vector[];
    payment_intent::create_for_app<USDC, TestApp>(
        TestApp {},
        account,
        config,
        STAFF,
        h::payment_ref(n),
        to,
        beneficiary,
        amount,
        b"USDC".to_string(),
        1_000_000,
        h::commitment(),
        kind,
        h::rail(),
        c.timestamp_ms() + QUOTE_MS,
        c,
        ctx,
    )
}

/// The wallet opens an intent and shares it, so a later transaction pays it.
fun open_shared(s: &mut Scenario, n: u8, kind: u8, to: address, amount: u64) {
    tx!(s, h::wallet(), |account, config, c, ctx| {
        let intent = h::wallet_intent_of_kind(account, config, n, kind, to, amount, c, ctx);
        payment_intent::share_intent(intent);
    });
}

/// `sender` pays the shared intent by coin, a quote's life ahead.
fun pay_shared(s: &mut Scenario, sender: address, paid: u64) {
    with_intent!(s, sender, |intent, account, config, c, ctx| {
        pay(intent, account, config, paid, h::settle_by(c), c, ctx);
    });
}

fun pay_shared_from_balance(s: &mut Scenario, sender: address, paid: u64) {
    with_intent!(s, sender, |intent, account, config, c, ctx| {
        pay_balance(intent, account, config, paid, h::settle_by(c), c, ctx);
    });
}

/// Put `T` on `registry` through the 24-hour path: governance proposes, the
/// notice runs, governance activates. Moves the clock on 24 hours.
fun register<T>(s: &mut Scenario, registry: u8) {
    s.next_tx(gov());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::propose_addition<T>(&admin, &mut config, registry, gov_keys(), gov_weights(), 2, &c, s.ctx());
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
        compliance_config::activate_addition<T>(&admin, &mut config, registry, gov_keys(), gov_weights(), 2, &c, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
}

/// Compliance takes `T` off `registry` at once (`ComplianceCap`, held by the
/// publisher, who is owner 1 in the harness).
fun remove<T>(s: &mut Scenario, registry: u8) {
    s.next_tx(h::owner_1());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::remove_registry_entry(&mut config, &cap, &caps, registry, compliance_config::type_string<T>());
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

/// Compliance raises the config's settlement floor to `floor`, leaving every
/// other parameter where it was (`ComplianceCap`, held by owner 1).
fun raise_floor(s: &mut Scenario, floor: u64) {
    s.next_tx(h::owner_1());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    let deviation = compliance_config::max_deviation_ppm(&config);
    let staleness = compliance_config::max_staleness_ms(&config);
    let slippage = compliance_config::max_slippage_bps(&config);
    let depth = compliance_config::min_depth_base_units(&config);
    compliance_config::tighten(&mut config, &cap, &caps, deviation, staleness, slippage, depth, floor);
    assert_eq!(compliance_config::min_settlement_amount(&config), floor);
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

/// Compliance pauses settlement.
fun pause(s: &mut Scenario) {
    s.next_tx(h::owner_1());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::pause(&mut config, &cap, &caps);
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

/// The coin object `who` received, which must be worth `value`.
fun assert_coin_at(s: &mut Scenario, who: address, value: u64) {
    s.next_tx(who);
    let paid = s.take_from_sender<Coin<USDC>>();
    assert_eq!(paid.value(), value);
    s.return_to_sender(paid);
}

// ─── Who may pay ───────────────────────────────────────────────────────────

#[test]
/// The owners' multisig is the approval: its signature is checked by the
/// protocol before this code runs. The payment settles, the intent is
/// CONFIRMED, and the account's day and month are charged with it.
fun the_wallet_pays_its_own_intent_by_coin() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
        assert_eq!(business_account::daily_spent(account, c), h::amount());
        assert_eq!(business_account::monthly_spent(account, c), h::amount());
        payment_intent::delete_finalized(intent);
    });
    assert_coin_at(&mut s, h::recipient(), h::amount());
    s.end();
}

#[test]
/// The balance variant takes exactly what a funds-withdrawal input redeems
/// to. Here the wallet's address balance is real: funded, then withdrawn
/// from, then settled against, with no coin selection. The recipient gets
/// the amount and the wallet's balance falls by it.
fun the_wallet_pays_from_a_redeemed_withdrawal() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    balance::create_for_testing<USDC>(h::amount() + 7).send_funds(h::wallet());
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        assert_eq!(ts::settled_balance<USDC>(h::wallet()), h::amount() + 7);
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        let funds = balance::redeem_funds(ts::withdraw_balance_from_address<USDC>(h::wallet(), h::amount()));
        let receipt = payment_intent::confirm_from_business_wallet_balance(
            &mut intent,
            account,
            config,
            funds,
            h::settle_by(c),
            c,
            ctx,
        );
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
        assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
        assert_eq!(business_account::daily_spent(account, c), h::amount());
        payment_intent::delete_finalized(intent);
    });
    assert_coin_at(&mut s, h::recipient(), h::amount());
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 7);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// The founder is a signer of the wallet, but one signer is not the quorum.
/// A member sending as their own address cannot pay from the wallet path.
fun the_founder_alone_cannot_pay() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    pay_shared(&mut s, h::founder(), h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// A third party holding the shared intent and its own funds cannot push it
/// through the balance path either.
fun a_stranger_cannot_pay_from_the_balance_path() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    pay_shared_from_balance(&mut s, STRANGER, h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NO_WALLET)]
/// An account that has not registered a wallet has no wallet path at all:
/// a legacy intent on it cannot be paid by anyone claiming to be the wallet.
fun an_account_without_a_wallet_has_no_wallet_path() {
    let mut s = h::setup_without_wallet();
    tx!(&mut s, h::founder(), |account, config, c, ctx| {
        payment_intent::create_payment_intent_for_account<USDC>(
            account,
            config,
            h::recipient(),
            h::amount(),
            b"PHP".to_string(),
            56_000_000,
            h::commitment(),
            payment_intent::kind_bank_payout(),
            h::rail(),
            c.timestamp_ms() + QUOTE_MS,
            c,
            ctx,
        );
    });
    pay_shared(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
/// "The sender is the account's wallet, whoever opened the intent." A staff
/// member opened this one under a spending rule (the app vouched for them).
/// The owners pay it themselves: the maker stays the staff member, the event
/// reports the wallet path (1), not the app path, and the recipient is paid.
fun the_wallet_pays_an_intent_an_app_opened() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = app_intent(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount(), c, ctx);
        assert_eq!(payment_intent::sender(&intent), STAFF);
        pay(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
        let confirmed = event::events_by_type<payment_intent::IntentConfirmed>();
        assert_eq!(confirmed.length(), 1);
        let (id, _, _, _, _, status, path, _) = payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
        assert_eq!(id, object::id(&intent));
        assert_eq!(status, payment_intent::status_confirmed());
        assert_eq!(path, payment_intent::path_business_wallet());
        payment_intent::delete_finalized(intent);
    });
    assert_coin_at(&mut s, SUPPLIER_WALLET, h::amount());
    s.end();
}

#[test]
/// Removing an app stops only the staff path; the owners' path keeps
/// working. An intent the app opened before it was removed is still payable
/// by the wallet.
fun the_wallet_still_pays_an_app_made_intent_after_the_app_is_removed() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    tx!(&mut s, STAFF, |account, config, c, ctx| {
        let intent = app_intent(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount(), c, ctx);
        payment_intent::share_intent(intent);
    });
    remove<TestApp>(&mut s, compliance_config::registry_settlement_app());
    pay_shared_from_balance(&mut s, h::wallet(), h::amount());
    assert_coin_at(&mut s, SUPPLIER_WALLET, h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// The staff member who opened an intent cannot pay it through the owners'
/// path. Their only path is their spending rule.
fun the_staff_maker_cannot_use_the_wallet_path() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    tx!(&mut s, STAFF, |account, config, c, ctx| {
        let intent = app_intent(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount(), c, ctx);
        payment_intent::share_intent(intent);
    });
    pay_shared(&mut s, STAFF, h::amount());
    s.end();
}

#[test]
/// Change on an app-made intent goes to the wallet that paid, never to the
/// maker. The staff member gets nothing; the wallet's address balance gets
/// the change.
fun overpay_on_an_app_made_intent_refunds_the_wallet_not_the_maker() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    tx!(&mut s, STAFF, |account, config, c, ctx| {
        let intent = app_intent(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount(), c, ctx);
        payment_intent::share_intent(intent);
    });
    pay_shared(&mut s, h::wallet(), h::amount() + 3 * USD);
    s.next_tx(STAFF);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 3 * USD);
    assert_eq!(ts::settled_balance<USDC>(STAFF), 0);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(STAFF));
    assert_coin_at(&mut s, SUPPLIER_WALLET, h::amount());
    s.end();
}

/// The wallet proposes a 3-of-3 of the same owners; it confirms itself.
/// Returns the new wallet.
fun rotate_to_3_of_3(s: &mut Scenario, confirm: bool): address {
    let new_wallet = multisig::derive_address(&h::keys(), &vector[1, 1, 1], 3);
    tx!(s, h::wallet(), |account, _config, _c, ctx| {
        business_account::rotate_wallet(account, h::keys(), vector[1, 1, 1], 3, false, ctx);
    });
    if (confirm) {
        tx!(s, new_wallet, |account, _config, _c, ctx| {
            business_account::confirm_wallet_rotation(account, ctx);
        });
    };
    new_wallet
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// After a confirmed rotation the old wallet is no one: it cannot pay even
/// the intent it opened itself.
fun a_rotated_out_wallet_cannot_pay() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    rotate_to_3_of_3(&mut s, true);
    pay_shared(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
/// The new wallet pays an intent the old wallet opened, and the change goes
/// to the NEW wallet's address balance, where the account's funds now live.
fun the_new_wallet_pays_what_the_old_one_opened() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    let new_wallet = rotate_to_3_of_3(&mut s, true);
    pay_shared(&mut s, new_wallet, h::amount() + 1);
    s.next_tx(new_wallet);
    assert_eq!(ts::settled_balance<USDC>(new_wallet), 1);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 0);
    assert_coin_at(&mut s, SUPPLIER_WALLET, h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// A rotation the new wallet has not confirmed gives it nothing yet.
fun a_pending_rotation_target_cannot_pay() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    let new_wallet = rotate_to_3_of_3(&mut s, false);
    pay_shared(&mut s, new_wallet, h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_BUSINESS_ACCOUNT)]
/// One multisig can be the wallet of two accounts. It still cannot pay
/// account A's intent while presenting account B, which would charge B's
/// ceilings for A's payment. The intent is bound to the account it opened on.
fun the_same_wallet_cannot_charge_another_account() {
    let mut s = h::setup();
    s.next_tx(h::founder());
    let a = {
        let account = s.take_shared<BusinessAccount>();
        let id = object::id(&account);
        ts::return_shared(account);
        id
    };
    // Account B, in a transaction that touches no other shared object, so the
    // effects name it alone.
    s.next_tx(h::founder());
    {
        let ctx = s.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(h::day());
        business_account::submit_application(b"SSM-202409099999".to_string(), b"bafy-kyb-b".to_string(), &c, ctx);
        c.destroy_for_testing();
    };
    let effects = s.next_tx(h::founder());
    let created = ts::shared(&effects);
    assert_eq!(created.length(), 1);
    let b = created[0];
    {
        let mut account_b = s.take_shared_by_id<BusinessAccount>(b);
        let admin = business_account::admin_cap_for_testing(s.ctx());
        business_account::verify_business(&admin, &mut account_b, 20);
        business_account::add_owner(&mut account_b, h::owner_2(), s.ctx());
        business_account::add_owner(&mut account_b, h::owner_3(), s.ctx());
        business_account::nominate_wallet(&mut account_b, h::wallet(), false, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account_b);
    };
    s.next_tx(h::wallet());
    {
        let mut account_b = s.take_shared_by_id<BusinessAccount>(b);
        business_account::register_wallet(&mut account_b, h::keys(), h::weights(), h::threshold(), false, s.ctx());
        ts::return_shared(account_b);
    };
    s.next_tx(h::wallet());
    {
        let mut account_a = s.take_shared_by_id<BusinessAccount>(a);
        let mut account_b = s.take_shared_by_id<BusinessAccount>(b);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let ctx = s.ctx();
        let mut intent = h::wallet_intent(&mut account_a, &config, 1, h::amount(), &c, ctx);
        pay(&mut intent, &mut account_b, &config, h::amount(), h::settle_by(&c), &c, ctx);
        payment_intent::delete_finalized(intent);
        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(account_b);
        ts::return_shared(account_a);
    };
    s.end();
}

// ─── The quote deadline (`settle_by_ms`) ───────────────────────────────────

#[test]
/// One millisecond before `settle_by_ms` the quote is still good, on both
/// wallet paths.
fun one_ms_before_settle_by_pays() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let settle_by = c.timestamp_ms() + 1;
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay(&mut intent, account, config, h::amount(), settle_by, c, ctx);
        payment_intent::delete_finalized(intent);
        let mut second = h::wallet_intent(account, config, 2, h::amount(), c, ctx);
        pay_balance(&mut second, account, config, h::amount(), settle_by, c, ctx);
        payment_intent::delete_finalized(second);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_SETTLE_BY_PASSED)]
/// At `settle_by_ms` exactly the quote has lapsed. A multisig transaction
/// signed against it cannot be submitted now (A8, B5).
fun at_settle_by_the_coin_path_aborts() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        let settle_by = c.timestamp_ms() + 1_000;
        c.set_for_testing(settle_by);
        pay(&mut intent, account, config, h::amount(), settle_by, c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_SETTLE_BY_PASSED)]
/// The same deadline on the balance path.
fun at_settle_by_the_balance_path_aborts() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        let settle_by = c.timestamp_ms();
        pay_balance(&mut intent, account, config, h::amount(), settle_by, c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_SETTLE_BY_PASSED)]
/// And on the cross-chain path, where the quote fixes the fee ceiling.
fun at_settle_by_the_cross_chain_path_aborts() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        let settle_by = c.timestamp_ms();
        let (coin, obligation) = release(&mut intent, account, config, h::amount(), settle_by, c, ctx);
        burn(coin, obligation);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

// ─── Intent state ──────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = payment_intent::E_NOT_PENDING)]
/// A confirmed intent cannot be paid a second time, even by the wallet,
/// even through the other wallet path.
fun a_paid_intent_cannot_be_paid_again() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        pay_balance(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_NOT_PENDING)]
/// An intent the owners cancelled stays cancelled.
fun a_cancelled_intent_cannot_be_paid() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    with_intent!(&mut s, h::wallet(), |intent, account, _config, c, ctx| {
        payment_intent::cancel_by_wallet(intent, account, c, ctx);
    });
    pay_shared(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_EXPIRED)]
/// At `expires_at` the intent is expired, however late the quote runs.
fun at_expiry_the_intent_cannot_be_paid() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        let expires_at = payment_intent::expires_at(&intent);
        c.set_for_testing(expires_at);
        pay(&mut intent, account, config, h::amount(), expires_at + QUOTE_MS, c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
/// One millisecond before `expires_at` it is still payable.
fun one_ms_before_expiry_the_intent_pays() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        let expires_at = payment_intent::expires_at(&intent);
        c.set_for_testing(expires_at - 1);
        pay(&mut intent, account, config, h::amount(), expires_at, c, ctx);
        assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

// ─── The config: pause and the asset registry ─────────────────────────────

#[test]
#[expected_failure(abort_code = compliance_config::E_SETTLEMENT_PAUSED)]
/// A pause stops the owners' path too: every account-bound settlement checks
/// it.
fun a_pause_stops_the_coin_path() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    pause(&mut s);
    pay_shared(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_SETTLEMENT_PAUSED)]
fun a_pause_stops_the_balance_path() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    pause(&mut s);
    pay_shared_from_balance(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_SETTLEMENT_PAUSED)]
fun a_pause_stops_the_cross_chain_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        payment_intent::share_intent(cross_chain_intent(account, config, 1, h::amount(), c, ctx));
    });
    pause(&mut s);
    with_intent!(&mut s, h::wallet(), |intent, account, config, c, ctx| {
        let (coin, obligation) = release(intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        burn(coin, obligation);
    });
    s.end();
}

#[test]
/// A pause is a halt, not a cancellation: once governance resumes, the same
/// pending intent pays.
fun after_a_resume_the_same_intent_pays() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    pause(&mut s);
    s.next_tx(h::owner_1());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::admin_set_paused(&admin, &mut config, false);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
    };
    pay_shared(&mut s, h::wallet(), h::amount());
    assert_coin_at(&mut s, SUPPLIER_WALLET, h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
/// Removing an asset stops every payment in it, including intents opened
/// before the removal. (A second asset is added first: the last accepted
/// asset cannot be removed.)
fun an_asset_removed_after_creation_cannot_settle_by_coin() {
    let mut s = h::setup();
    register<USDC_V2>(&mut s, compliance_config::registry_asset());
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    remove<USDC>(&mut s, compliance_config::registry_asset());
    pay_shared(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
fun an_asset_removed_after_creation_cannot_settle_from_balance() {
    let mut s = h::setup();
    register<USDC_V2>(&mut s, compliance_config::registry_asset());
    open_shared(&mut s, 1, payment_intent::kind_bank_payout(), h::recipient(), h::amount());
    remove<USDC>(&mut s, compliance_config::registry_asset());
    pay_shared_from_balance(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
fun an_asset_removed_after_creation_cannot_settle_cross_chain() {
    let mut s = h::setup();
    register<USDC_V2>(&mut s, compliance_config::registry_asset());
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        payment_intent::share_intent(cross_chain_intent(account, config, 1, h::amount(), c, ctx));
    });
    remove<USDC>(&mut s, compliance_config::registry_asset());
    with_intent!(&mut s, h::wallet(), |intent, account, config, c, ctx| {
        let (coin, obligation) = release(intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        burn(coin, obligation);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_SETTLEMENT_ASSET)]
/// A USDC intent cannot be discharged in units of a worthless coin: unit
/// counts mean nothing across assets.
fun a_coin_of_another_type_cannot_pay() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay_in<SCAM>(&mut intent, account, config, 1_000 * h::amount(), h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_SETTLEMENT_ASSET)]
/// Being an accepted asset is not enough: an intent settles only in the asset
/// it was opened in, even when another asset is on the registry.
fun another_accepted_asset_cannot_pay_a_usdc_intent() {
    let mut s = h::setup();
    register<USDC_V2>(&mut s, compliance_config::registry_asset());
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay_balance_in<USDC_V2>(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

// ─── The account: freezes and KYB ─────────────────────────────────────────

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
/// Any one owner can pull the brake, and it stops the owners' path through
/// Splash too. (It does not freeze the wallet itself, which only the
/// business controls.)
fun an_owner_freeze_stops_the_wallet_path() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    tx!(&mut s, h::owner_2(), |account, _config, _c, ctx| {
        business_account::freeze_account(account, ctx);
    });
    pay_shared(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
/// A compliance freeze stops it as well, on the balance path.
fun an_admin_freeze_stops_the_balance_path() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_bank_payout(), h::recipient(), h::amount());
    tx!(&mut s, h::owner_1(), |account, _config, _c, ctx| {
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::admin_freeze(&admin, account, ctx);
        business_account::destroy_admin_cap_for_testing(admin);
    });
    pay_shared_from_balance(&mut s, h::wallet(), h::amount());
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_FROZEN)]
/// And it stops a cross-chain release.
fun an_owner_freeze_stops_the_cross_chain_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        payment_intent::share_intent(cross_chain_intent(account, config, 1, h::amount(), c, ctx));
    });
    tx!(&mut s, h::owner_3(), |account, _config, _c, ctx| {
        business_account::freeze_account(account, ctx);
    });
    with_intent!(&mut s, h::wallet(), |intent, account, config, c, ctx| {
        let (coin, obligation) = release(intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        burn(coin, obligation);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_VERIFIED)]
/// An account whose KYB is withdrawn after the intent opened cannot settle it.
fun an_unverified_account_cannot_settle() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount());
    tx!(&mut s, h::owner_1(), |account, _config, _c, ctx| {
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::revoke_verification(&admin, account, ctx);
        business_account::destroy_admin_cap_for_testing(admin);
    });
    pay_shared(&mut s, h::wallet(), h::amount());
    s.end();
}

// ─── Amounts: underpay and overpay ─────────────────────────────────────────

#[test]
#[expected_failure(abort_code = payment_intent::E_INSUFFICIENT_PAYMENT)]
/// One minor unit short is short. No receipt for less than the intent.
fun underpay_by_one_unit_aborts_on_the_coin_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay(&mut intent, account, config, h::amount() - 1, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INSUFFICIENT_PAYMENT)]
fun underpay_by_one_unit_aborts_on_the_balance_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay_balance(&mut intent, account, config, h::amount() - 1, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
/// Change goes to the wallet's ADDRESS BALANCE, where a business wallet keeps
/// its funds (D1), never as a loose coin object. The recipient gets the
/// amount and not a unit more.
fun overpay_by_coin_refunds_the_wallet_address_balance() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay(&mut intent, account, config, h::amount() + 12_345, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::wallet());
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 12_345);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(h::wallet()));
    assert_coin_at(&mut s, h::recipient(), h::amount());
    s.end();
}

#[test]
fun overpay_from_balance_refunds_the_wallet_address_balance() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay_balance(&mut intent, account, config, h::amount() + 9, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::wallet());
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 9);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(h::wallet()));
    assert_coin_at(&mut s, h::recipient(), h::amount());
    s.end();
}

#[test]
/// An exact payment leaves no change: no zero credit, no dust coin.
fun an_exact_payment_from_balance_leaves_no_change() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        pay_balance(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::wallet());
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 0);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(h::wallet()));
    s.end();
}

// ─── Delivery ──────────────────────────────────────────────────────────────

/// Pay a fresh intent of `kind` to `to`, by coin or from balance.
fun deliver(s: &mut Scenario, kind: u8, to: address, from_balance: bool) {
    tx!(s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent_of_kind(account, config, 1, kind, to, h::amount(), c, ctx);
        if (from_balance) pay_balance(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx)
        else pay(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
}

/// A coin object of exactly the amount, and nothing in the address balance.
fun assert_delivered_as_coin(s: &mut Scenario, to: address) {
    assert_coin_at(s, to, h::amount());
    assert_eq!(ts::settled_balance<USDC>(to), 0);
}

/// The address balance credited with exactly the amount, and no coin object.
fun assert_delivered_to_balance(s: &mut Scenario, to: address) {
    s.next_tx(to);
    assert_eq!(ts::settled_balance<USDC>(to), h::amount());
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(to));
}

#[test]
/// A bank payout lands at the partner's deposit address as a `Coin`, which
/// every partner deposit system recognises.
fun a_bank_payout_by_coin_arrives_as_a_coin() {
    let mut s = h::setup();
    deliver(&mut s, payment_intent::kind_bank_payout(), h::recipient(), false);
    assert_delivered_as_coin(&mut s, h::recipient());
    s.end();
}

#[test]
/// The balance path converts to a `Coin` for a bank payout too.
fun a_bank_payout_from_balance_arrives_as_a_coin() {
    let mut s = h::setup();
    deliver(&mut s, payment_intent::kind_bank_payout(), h::recipient(), true);
    assert_delivered_as_coin(&mut s, h::recipient());
    s.end();
}

#[test]
/// A transfer to a wallet or an exchange lands as a `Coin`.
fun a_wallet_transfer_by_coin_arrives_as_a_coin() {
    let mut s = h::setup();
    deliver(&mut s, payment_intent::kind_wallet(), SUPPLIER_WALLET, false);
    assert_delivered_as_coin(&mut s, SUPPLIER_WALLET);
    s.end();
}

#[test]
fun a_wallet_transfer_from_balance_arrives_as_a_coin() {
    let mut s = h::setup();
    deliver(&mut s, payment_intent::kind_wallet(), SUPPLIER_WALLET, true);
    assert_delivered_as_coin(&mut s, SUPPLIER_WALLET);
    s.end();
}

#[test]
/// Another Splash business is credited to its address balance with
/// `send_funds`, because its own spending rules draw from there. No coin
/// object is created.
fun a_splash_business_payment_by_coin_credits_the_address_balance() {
    let mut s = h::setup();
    deliver(&mut s, payment_intent::kind_splash_business(), OTHER_BUSINESS, false);
    assert_delivered_to_balance(&mut s, OTHER_BUSINESS);
    s.end();
}

#[test]
fun a_splash_business_payment_from_balance_credits_the_address_balance() {
    let mut s = h::setup();
    deliver(&mut s, payment_intent::kind_splash_business(), OTHER_BUSINESS, true);
    assert_delivered_to_balance(&mut s, OTHER_BUSINESS);
    s.end();
}

// ─── Events ────────────────────────────────────────────────────────────────

#[test]
/// `IntentConfirmed.path` is 1 on both wallet paths, and the event carries
/// the intent's commitment, rail commitment, asset and kind, and the
/// CONFIRMED status. The anchor that follows reports the same intent.
fun intent_confirmed_reports_the_wallet_path_on_both_paths() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut first = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_splash_business(), OTHER_BUSINESS, h::amount(), c, ctx);
        pay(&mut first, account, config, h::amount(), h::settle_by(c), c, ctx);
        let mut second = h::wallet_intent(account, config, 2, h::amount(), c, ctx);
        pay_balance(&mut second, account, config, h::amount(), h::settle_by(c), c, ctx);

        let confirmed = event::events_by_type<payment_intent::IntentConfirmed>();
        assert_eq!(confirmed.length(), 2);
        let (id, commitment, rail, asset, kind, status, path, at) =
            payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
        assert_eq!(id, object::id(&first));
        assert_eq!(commitment, h::commitment());
        assert_eq!(rail, h::rail());
        assert_eq!(asset, compliance_config::type_string<USDC>());
        assert_eq!(kind, payment_intent::kind_splash_business());
        assert_eq!(status, payment_intent::status_confirmed());
        assert_eq!(path, payment_intent::path_business_wallet());
        assert_eq!(at, c.timestamp_ms());
        let (id, _, _, _, kind, status, path, _) = payment_intent::unpack_intent_confirmed_for_testing(confirmed[1]);
        assert_eq!(id, object::id(&second));
        assert_eq!(kind, payment_intent::kind_bank_payout());
        assert_eq!(status, payment_intent::status_confirmed());
        assert_eq!(path, payment_intent::path_business_wallet());

        let anchored = event::events_by_type<audit_anchor::SettlementAnchored>();
        assert_eq!(anchored.length(), 2);
        let (id, commitment, status, _, _, _) = audit_anchor::unpack_settlement_anchored_for_testing(anchored[1]);
        assert_eq!(id, object::id(&second));
        assert_eq!(commitment, h::commitment());
        assert_eq!(status, payment_intent::status_confirmed());

        payment_intent::delete_finalized(first);
        payment_intent::delete_finalized(second);
    });
    s.end();
}

// ─── Tier ceilings ─────────────────────────────────────────────────────────

#[test]
/// Exactly Tier 3's per-transfer ceiling (20,000 USDC) settles, and fills the
/// day: the daily window is charged by the wallet path.
fun exactly_the_tier_3_per_transfer_cap_settles() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, TIER_3_CAP, c, ctx);
        pay(&mut intent, account, config, TIER_3_CAP, h::settle_by(c), c, ctx);
        assert_eq!(business_account::daily_spent(account, c), TIER_3_CAP);
        assert_eq!(business_account::daily_remaining(account, c), 0);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_OVER_PER_TRANSFER_CAP)]
/// One minor unit over the per-transfer ceiling aborts, with the day empty.
fun one_unit_over_the_tier_3_per_transfer_cap_aborts() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, TIER_3_CAP + 1, c, ctx);
        pay_balance(&mut intent, account, config, TIER_3_CAP + 1, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
/// The ceiling is the account's tier, not a constant of the wallet path: the
/// same 20,000.000001 USDC settles once governance moves the account to
/// Tier 2.
fun the_same_payment_settles_a_tier_up() {
    let mut s = h::setup();
    tx!(&mut s, h::owner_1(), |account, _config, _c, ctx| {
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::set_tier(&admin, account, 2, ctx);
        business_account::destroy_admin_cap_for_testing(admin);
    });
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, TIER_3_CAP + 1, c, ctx);
        pay_balance(&mut intent, account, config, TIER_3_CAP + 1, h::settle_by(c), c, ctx);
        assert_eq!(business_account::daily_spent(account, c), TIER_3_CAP + 1);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_OVER_PER_TRANSFER_CAP)]
/// The cross-chain release is charged against the same ceilings.
fun one_unit_over_the_per_transfer_cap_aborts_cross_chain() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, TIER_3_CAP + 1, c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, TIER_3_CAP + 1, h::settle_by(c), c, ctx);
        burn(coin, obligation);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::spend_window::E_CAP_EXCEEDED)]
/// The daily window is shared by both wallet paths: 15,000 by coin and 5,000
/// from balance fill it, and one more USDC the same day aborts.
fun the_daily_window_counts_both_wallet_paths() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut first = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, 15_000 * USD, c, ctx);
        pay(&mut first, account, config, 15_000 * USD, h::settle_by(c), c, ctx);
        let mut second = h::wallet_intent_of_kind(account, config, 2, payment_intent::kind_splash_business(), OTHER_BUSINESS, 5_000 * USD, c, ctx);
        pay_balance(&mut second, account, config, 5_000 * USD, h::settle_by(c), c, ctx);
        assert_eq!(business_account::daily_spent(account, c), TIER_3_CAP);
        payment_intent::delete_finalized(first);
        payment_intent::delete_finalized(second);
    });
    advance(&mut s, HOUR);
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut third = h::wallet_intent_of_kind(account, config, 3, payment_intent::kind_wallet(), SUPPLIER_WALLET, USD, c, ctx);
        pay(&mut third, account, config, USD, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(third);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::spend_window::E_CAP_EXCEEDED)]
/// A cross-chain release fills the same day as a payment on Sui.
fun the_daily_window_counts_cross_chain_releases() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut first = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, TIER_3_CAP, c, ctx);
        pay(&mut first, account, config, TIER_3_CAP, h::settle_by(c), c, ctx);
        let mut second = cross_chain_intent(account, config, 2, USD, c, ctx);
        let (coin, obligation) = release(&mut second, account, config, USD, h::settle_by(c), c, ctx);
        burn(coin, obligation);
        payment_intent::delete_finalized(first);
        payment_intent::delete_finalized(second);
    });
    s.end();
}

#[test]
/// A full day later the daily room is back, while the month remembers.
fun the_daily_window_returns_after_a_day() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut first = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, TIER_3_CAP, c, ctx);
        pay(&mut first, account, config, TIER_3_CAP, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(first);
    });
    advance(&mut s, h::day());
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut second = h::wallet_intent_of_kind(account, config, 2, payment_intent::kind_wallet(), SUPPLIER_WALLET, TIER_3_CAP, c, ctx);
        pay_balance(&mut second, account, config, TIER_3_CAP, h::settle_by(c), c, ctx);
        assert_eq!(business_account::daily_spent(account, c), TIER_3_CAP);
        assert_eq!(business_account::monthly_spent(account, c), 2 * TIER_3_CAP);
        payment_intent::delete_finalized(second);
    });
    s.end();
}

// ─── The 99 USDC floor: bank payouts only ──────────────────────────────────

#[test]
/// The product minimum for a wallet transfer is 1 USDC, not the bank-payout
/// floor: a 1 USDC transfer to a wallet settles.
fun a_1_usdc_wallet_transfer_settles() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, USD, c, ctx);
        pay(&mut intent, account, config, USD, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    assert_coin_at(&mut s, SUPPLIER_WALLET, USD);
    s.end();
}

#[test]
/// And to another Splash business, from balance.
fun a_1_usdc_splash_business_payment_settles() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_splash_business(), OTHER_BUSINESS, USD, c, ctx);
        pay_balance(&mut intent, account, config, USD, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(OTHER_BUSINESS);
    assert_eq!(ts::settled_balance<USDC>(OTHER_BUSINESS), USD);
    s.end();
}

#[test]
/// And across chains: the floor is for bank payouts only.
fun a_1_usdc_cross_chain_payment_releases() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, USD, c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, USD, h::settle_by(c), c, ctx);
        assert_eq!(coin.value(), USD);
        burn(coin, obligation);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = BELOW_SETTLEMENT_FLOOR, location = splash_core::payment_intent)]
/// A bank payout one minor unit under 99 USDC is refused, and refused when it
/// opens: below 99 USDC the partner's fixed costs exceed the payment, and an
/// intent that could never settle must not claim its payment reference.
fun a_bank_payout_one_unit_under_99_usdc_aborts() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let intent = h::wallet_intent(account, config, 1, 99 * USD - 1, c, ctx);
        payment_intent::share_intent(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = BELOW_SETTLEMENT_FLOOR, location = splash_core::payment_intent)]
/// The floor is about the intent, not the coin: overpaying a bank payout the
/// floor has risen above does not lift it over the floor.
fun overpaying_a_small_bank_payout_does_not_lift_the_floor() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_bank_payout(), h::recipient(), 120 * USD);
    raise_floor(&mut s, 150 * USD);
    pay_shared_from_balance(&mut s, h::wallet(), 200 * USD);
    s.end();
}

// ─── The bank-payout floor follows ComplianceConfig ────────────────────────
//
// The floor of a bank payout is the larger of the 99 USDC platform minimum
// and `ComplianceConfig.min_settlement_amount`, which `ComplianceCap` can
// raise. It is checked when the intent opens and again when it settles, on
// every v2 path. The harness's config floor is 1 USDC, so 99 USDC binds until
// a test raises it.

#[test]
#[expected_failure(abort_code = BELOW_SETTLEMENT_FLOOR, location = splash_core::payment_intent)]
/// Raised to 150 USDC, the compliance floor refuses a 149.999999 USDC bank
/// payout when it opens.
fun a_bank_payout_under_a_raised_compliance_floor_is_refused_at_creation() {
    let mut s = h::setup();
    raise_floor(&mut s, 150 * USD);
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let intent = h::wallet_intent(account, config, 1, 150 * USD - 1, c, ctx);
        payment_intent::share_intent(intent);
    });
    s.end();
}

#[test]
/// At the raised floor exactly, the bank payout opens and settles.
fun a_bank_payout_at_a_raised_compliance_floor_settles() {
    let mut s = h::setup();
    raise_floor(&mut s, 150 * USD);
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, 150 * USD, c, ctx);
        pay(&mut intent, account, config, 150 * USD, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    assert_coin_at(&mut s, h::recipient(), 150 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = BELOW_SETTLEMENT_FLOOR, location = splash_core::payment_intent)]
/// An intent opened before compliance raised the floor no longer settles by
/// coin.
fun a_bank_payout_opened_before_the_floor_rose_cannot_settle_by_coin() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_bank_payout(), h::recipient(), 120 * USD);
    raise_floor(&mut s, 150 * USD);
    pay_shared(&mut s, h::wallet(), 120 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = BELOW_SETTLEMENT_FLOOR, location = splash_core::payment_intent)]
/// Nor from the wallet's address balance.
fun a_bank_payout_opened_before_the_floor_rose_cannot_settle_from_balance() {
    let mut s = h::setup();
    open_shared(&mut s, 1, payment_intent::kind_bank_payout(), h::recipient(), 120 * USD);
    raise_floor(&mut s, 150 * USD);
    pay_shared_from_balance(&mut s, h::wallet(), 120 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = BELOW_SETTLEMENT_FLOOR, location = splash_core::payment_intent)]
/// Nor through a settlement app (a spending rule).
fun a_bank_payout_opened_before_the_floor_rose_cannot_settle_through_an_app() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    tx!(&mut s, STAFF, |account, config, c, ctx| {
        let intent = app_intent(account, config, 1, payment_intent::kind_bank_payout(), h::recipient(), 120 * USD, c, ctx);
        payment_intent::share_intent(intent);
    });
    raise_floor(&mut s, 150 * USD);
    with_intent!(&mut s, STAFF, |intent, account, config, c, ctx| {
        let funds = balance::create_for_testing<USDC>(120 * USD);
        let receipt = payment_intent::settle_from_app<USDC, TestApp>(
            TestApp {}, intent, account, config, funds, h::settle_by(c), c, ctx,
        );
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = BELOW_SETTLEMENT_FLOOR, location = splash_core::payment_intent)]
/// A settlement app cannot open a bank payout under the floor either.
fun an_app_cannot_open_a_bank_payout_under_the_floor() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    tx!(&mut s, STAFF, |account, config, c, ctx| {
        let intent = app_intent(account, config, 1, payment_intent::kind_bank_payout(), h::recipient(), 99 * USD - 1, c, ctx);
        payment_intent::share_intent(intent);
    });
    s.end();
}

#[test]
/// The floor is for bank payouts only: with the compliance floor at 1,000
/// USDC, a 1 USDC wallet transfer still opens and settles.
fun a_raised_compliance_floor_does_not_apply_to_a_wallet_transfer() {
    let mut s = h::setup();
    raise_floor(&mut s, 1_000 * USD);
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, USD, c, ctx);
        pay(&mut intent, account, config, USD, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    assert_coin_at(&mut s, SUPPLIER_WALLET, USD);
    s.end();
}

// ─── A bank payout the tier could never settle does not open ──────────────

#[test]
#[expected_failure(abort_code = business_account::E_OVER_PER_TRANSFER_CAP)]
/// One unit over Tier 3's per-transfer ceiling, a bank payout is refused when
/// it opens, not left to expire with its payment reference claimed.
fun a_bank_payout_over_the_tier_ceiling_is_refused_at_creation() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let intent = h::wallet_intent(account, config, 1, TIER_3_CAP + 1, c, ctx);
        payment_intent::share_intent(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_OVER_PER_TRANSFER_CAP)]
/// The same for an app-made bank payout.
fun an_app_cannot_open_a_bank_payout_over_the_tier_ceiling() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    tx!(&mut s, STAFF, |account, config, c, ctx| {
        let intent = app_intent(account, config, 1, payment_intent::kind_bank_payout(), h::recipient(), TIER_3_CAP + 1, c, ctx);
        payment_intent::share_intent(intent);
    });
    s.end();
}

#[test]
/// At the ceiling exactly, the bank payout opens and settles.
fun a_bank_payout_at_the_tier_ceiling_settles() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, TIER_3_CAP, c, ctx);
        pay(&mut intent, account, config, TIER_3_CAP, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    assert_coin_at(&mut s, h::recipient(), TIER_3_CAP);
    s.end();
}

#[test]
/// Exactly 99 USDC is a bank payout the floor allows.
fun a_bank_payout_of_exactly_99_usdc_settles() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, 99 * USD, c, ctx);
        pay_balance(&mut intent, account, config, 99 * USD, h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    assert_coin_at(&mut s, h::recipient(), 99 * USD);
    s.end();
}

// ─── A cross-chain intent cannot pay an address on Sui ─────────────────────

#[test]
#[expected_failure(abort_code = payment_intent::E_CROSS_CHAIN_ONLY)]
/// A kind-4 intent's recipient is a CCTP `mint_recipient` on another chain,
/// not a Sui address. Paying it by coin would send USDC to the wrong place.
fun a_cross_chain_intent_cannot_take_the_coin_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        pay(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_CROSS_CHAIN_ONLY)]
fun a_cross_chain_intent_cannot_take_the_balance_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        pay_balance(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

// ─── Cross-chain: release ──────────────────────────────────────────────────

#[test]
/// The cross-chain path sends nothing to an address. It returns the receipt,
/// a coin of exactly the amount, and an obligation whose every field is the
/// intent's: the intent, that coin's ID, the asset, the amount, the domain,
/// the mint recipient, the fee ceiling and the finality. The event reports
/// the wallet path and kind 4.
fun cross_chain_release_returns_the_coin_and_a_matching_obligation() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        assert_eq!(payment_intent::kind(&intent), payment_intent::kind_cross_chain_wallet());
        let (coin, obligation) = release(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        assert_eq!(coin.value(), h::amount());
        assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
        assert_eq!(business_account::daily_spent(account, c), h::amount());

        let (intent_id, coin_id, asset, amount, domain, mint_recipient, max_fee, min_finality) =
            payment_intent::unpack_bridge_obligation_for_testing(obligation);
        assert_eq!(intent_id, object::id(&intent));
        assert_eq!(coin_id, object::id(&coin));
        assert_eq!(asset, compliance_config::type_string<USDC>());
        assert_eq!(asset, *payment_intent::settlement_asset(&intent));
        assert_eq!(amount, payment_intent::amount_usd(&intent));
        assert_eq!(domain, SOLANA);
        assert_eq!(domain, payment_intent::destination_domain(&intent));
        assert_eq!(mint_recipient, MINT_RECIPIENT);
        assert_eq!(mint_recipient, payment_intent::recipient(&intent));
        assert_eq!(max_fee, MAX_FEE);
        assert_eq!(max_fee, payment_intent::bridge_max_fee(&intent));
        assert_eq!(min_finality, MIN_FINALITY);
        assert_eq!(min_finality, payment_intent::bridge_min_finality(&intent));

        let confirmed = event::events_by_type<payment_intent::IntentConfirmed>();
        assert_eq!(confirmed.length(), 1);
        let (id, _, _, _, kind, status, path, _) = payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
        assert_eq!(id, object::id(&intent));
        assert_eq!(kind, payment_intent::kind_cross_chain_wallet());
        assert_eq!(status, payment_intent::status_confirmed());
        assert_eq!(path, payment_intent::path_business_wallet());

        coin::burn_for_testing(coin);
        payment_intent::delete_finalized(intent);
    });
    // Nothing reached the mint recipient's Sui address.
    s.next_tx(MINT_RECIPIENT);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(MINT_RECIPIENT));
    assert_eq!(ts::settled_balance<USDC>(MINT_RECIPIENT), 0);
    s.end();
}

#[test]
/// Overpaying a cross-chain release: the coin for the bridge is exactly the
/// amount, and the change goes to the wallet's address balance.
fun cross_chain_overpay_refunds_the_wallet_address_balance() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, h::amount() + 4 * USD, h::settle_by(c), c, ctx);
        assert_eq!(coin.value(), h::amount());
        burn(coin, obligation);
        payment_intent::delete_finalized(intent);
    });
    s.next_tx(h::wallet());
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), 4 * USD);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(h::wallet()));
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INSUFFICIENT_PAYMENT)]
fun cross_chain_underpay_aborts() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, h::amount() - 1, h::settle_by(c), c, ctx);
        burn(coin, obligation);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_SETTLEMENT_ASSET)]
/// The cross-chain path binds the asset too: a coin of another type cannot be
/// released for a USDC intent.
fun cross_chain_in_another_coin_aborts() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        let payment = coin::mint_for_testing<SCAM>(h::amount(), ctx);
        let (receipt, coin, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
            &mut intent,
            account,
            config,
            payment,
            h::settle_by(c),
            c,
            ctx,
        );
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
        let (_, _, _, _, _, _, _, _) = payment_intent::unpack_bridge_obligation_for_testing(obligation);
        coin::burn_for_testing(coin);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// Only the wallet takes the cross-chain path.
fun only_the_wallet_takes_the_cross_chain_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        payment_intent::share_intent(cross_chain_intent(account, config, 1, h::amount(), c, ctx));
    });
    with_intent!(&mut s, h::owner_2(), |intent, account, config, c, ctx| {
        let (coin, obligation) = release(intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        burn(coin, obligation);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_NOT_CROSS_CHAIN)]
/// A wallet transfer on Sui cannot be released as a bridge coin: its
/// recipient is a Sui address and no adapter should burn for it.
fun a_wallet_kind_intent_cannot_take_the_cross_chain_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent_of_kind(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, h::amount(), c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        burn(coin, obligation);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_NOT_CROSS_CHAIN)]
/// Nor can a bank payout.
fun a_bank_payout_cannot_take_the_cross_chain_path() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = h::wallet_intent(account, config, 1, h::amount(), c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        burn(coin, obligation);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

#[test]
/// A cross-chain intent a staff member opened under a spending rule is
/// payable by the owners too, on the wallet path (1).
fun the_wallet_releases_a_cross_chain_intent_an_app_opened() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = payment_intent::create_cross_chain_for_app<USDC, TestApp>(
            TestApp {},
            account,
            config,
            STAFF,
            h::payment_ref(1),
            SOLANA,
            MINT_RECIPIENT,
            h::amount(),
            h::commitment(),
            h::rail(),
            MAX_FEE,
            MIN_FINALITY,
            c.timestamp_ms() + QUOTE_MS,
            c,
            ctx,
        );
        assert_eq!(payment_intent::sender(&intent), STAFF);
        let (coin, obligation) = release(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        let confirmed = event::events_by_type<payment_intent::IntentConfirmed>();
        let (_, _, _, _, _, _, path, _) = payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
        assert_eq!(path, payment_intent::path_business_wallet());
        let (intent_id, coin_id, _, amount, _, _, _, _) = payment_intent::unpack_bridge_obligation_for_testing(obligation);
        assert_eq!(intent_id, object::id(&intent));
        assert_eq!(coin_id, object::id(&coin));
        assert_eq!(amount, h::amount());
        coin::burn_for_testing(coin);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

// ─── Cross-chain: discharge ────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_BRIDGE_ADAPTER)]
/// Phase 1 registers no bridge adapter, so kind 4 cannot settle yet: the
/// obligation is a hot potato and nothing can discharge it.
fun with_no_adapter_registered_the_obligation_cannot_be_discharged() {
    let mut s = h::setup();
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        let (_, _, _, _, _, _) = payment_intent::discharge_bridge_obligation<TestBridge, USDC>(
            TestBridge {},
            config,
            obligation,
            &coin,
        );
        coin::burn_for_testing(coin);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

/// Register `TestBridge` (24 hours), then the wallet opens and releases a
/// cross-chain intent. Runs `$body` with the coin and the obligation.
macro fun with_release(
    $s: &mut Scenario,
    $body: |&mut PaymentIntent, &ComplianceConfig, Coin<USDC>, BridgeObligation, &mut TxContext|,
) {
    let s = $s;
    register<TestBridge>(s, compliance_config::registry_bridge_adapter());
    tx!(s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        $body(&mut intent, config, coin, obligation, ctx);
        payment_intent::delete_finalized(intent);
    });
}

#[test]
/// A registered adapter, handed the very coin the settlement released,
/// discharges the obligation and gets back exactly what it must burn: the
/// intent, the amount, the domain, the recipient, the fee ceiling and the
/// finality, all the intent's own.
fun a_registered_adapter_discharges_with_the_released_coin() {
    let mut s = h::setup();
    with_release!(&mut s, |intent, config, coin, obligation, _ctx| {
        let (intent_id, amount, domain, mint_recipient, max_fee, min_finality) =
            payment_intent::discharge_bridge_obligation<TestBridge, USDC>(TestBridge {}, config, obligation, &coin);
        assert_eq!(intent_id, object::id(intent));
        assert_eq!(amount, payment_intent::amount_usd(intent));
        assert_eq!(amount, coin.value());
        assert_eq!(domain, payment_intent::destination_domain(intent));
        assert_eq!(domain, SOLANA);
        assert_eq!(mint_recipient, payment_intent::recipient(intent));
        assert_eq!(mint_recipient, MINT_RECIPIENT);
        assert_eq!(max_fee, payment_intent::bridge_max_fee(intent));
        assert_eq!(min_finality, payment_intent::bridge_min_finality(intent));
        coin::burn_for_testing(coin);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_BRIDGE_COIN)]
/// The PTB cannot keep the business's coin and burn another of equal value:
/// the obligation names the released coin by ID.
fun a_different_coin_of_equal_value_cannot_discharge() {
    let mut s = h::setup();
    with_release!(&mut s, |_intent, config, coin, obligation, ctx| {
        let decoy = h::usdc(h::amount(), ctx);
        let (_, _, _, _, _, _) =
            payment_intent::discharge_bridge_obligation<TestBridge, USDC>(TestBridge {}, config, obligation, &decoy);
        coin::burn_for_testing(decoy);
        coin::burn_for_testing(coin);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_BRIDGE_COIN)]
/// A coin of a different amount cannot discharge it.
fun a_coin_of_a_different_amount_cannot_discharge() {
    let mut s = h::setup();
    with_release!(&mut s, |_intent, config, coin, obligation, ctx| {
        let decoy = h::usdc(h::amount() - 1, ctx);
        let (_, _, _, _, _, _) =
            payment_intent::discharge_bridge_obligation<TestBridge, USDC>(TestBridge {}, config, obligation, &decoy);
        coin::burn_for_testing(decoy);
        coin::burn_for_testing(coin);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_BRIDGE_COIN)]
/// The released coin itself, with part split off before the burn, keeps its
/// ID but not its value. The skimmed part would stay with the PTB.
fun the_released_coin_with_part_split_off_cannot_discharge() {
    let mut s = h::setup();
    with_release!(&mut s, |_intent, config, coin, obligation, ctx| {
        let mut coin = coin;
        let skimmed = coin.split(1, ctx);
        let (_, _, _, _, _, _) =
            payment_intent::discharge_bridge_obligation<TestBridge, USDC>(TestBridge {}, config, obligation, &coin);
        coin::burn_for_testing(skimmed);
        coin::burn_for_testing(coin);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_BRIDGE_COIN)]
/// Nor topped up: the adapter must burn exactly the obligation's amount.
fun the_released_coin_topped_up_cannot_discharge() {
    let mut s = h::setup();
    with_release!(&mut s, |_intent, config, coin, obligation, ctx| {
        let mut coin = coin;
        coin.join(h::usdc(1, ctx));
        let (_, _, _, _, _, _) =
            payment_intent::discharge_bridge_obligation<TestBridge, USDC>(TestBridge {}, config, obligation, &coin);
        coin::burn_for_testing(coin);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_BRIDGE_COIN)]
/// Two releases in one batch, equal in amount: each obligation discharges
/// only against its own coin, so a PTB cannot swap them and burn one
/// payment's coin for the other's recipient.
fun two_released_coins_cannot_be_swapped_between_obligations() {
    let mut s = h::setup();
    register<TestBridge>(&mut s, compliance_config::registry_bridge_adapter());
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut first = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        let mut second = cross_chain_intent(account, config, 2, h::amount(), c, ctx);
        let (coin_1, obligation_1) = release(&mut first, account, config, h::amount(), h::settle_by(c), c, ctx);
        let (coin_2, obligation_2) = release(&mut second, account, config, h::amount(), h::settle_by(c), c, ctx);
        let (_, _, _, _, _, _) =
            payment_intent::discharge_bridge_obligation<TestBridge, USDC>(TestBridge {}, config, obligation_1, &coin_2);
        let (_, _, _, _, _, _) =
            payment_intent::discharge_bridge_obligation<TestBridge, USDC>(TestBridge {}, config, obligation_2, &coin_1);
        coin::burn_for_testing(coin_1);
        coin::burn_for_testing(coin_2);
        payment_intent::delete_finalized(first);
        payment_intent::delete_finalized(second);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_BRIDGE_ADAPTER)]
/// One registered adapter does not admit another type: only the witness on
/// the registry may discharge.
fun an_unregistered_adapter_cannot_discharge_beside_a_registered_one() {
    let mut s = h::setup();
    with_release!(&mut s, |_intent, config, coin, obligation, _ctx| {
        let (_, _, _, _, _, _) =
            payment_intent::discharge_bridge_obligation<RogueBridge, USDC>(RogueBridge {}, config, obligation, &coin);
        coin::burn_for_testing(coin);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_BRIDGE_ADAPTER)]
/// Removing an adapter is immediate and stops the cross-chain path.
fun a_removed_adapter_cannot_discharge() {
    let mut s = h::setup();
    register<TestBridge>(&mut s, compliance_config::registry_bridge_adapter());
    remove<TestBridge>(&mut s, compliance_config::registry_bridge_adapter());
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = cross_chain_intent(account, config, 1, h::amount(), c, ctx);
        let (coin, obligation) = release(&mut intent, account, config, h::amount(), h::settle_by(c), c, ctx);
        let (_, _, _, _, _, _) =
            payment_intent::discharge_bridge_obligation<TestBridge, USDC>(TestBridge {}, config, obligation, &coin);
        coin::burn_for_testing(coin);
        payment_intent::delete_finalized(intent);
    });
    s.end();
}

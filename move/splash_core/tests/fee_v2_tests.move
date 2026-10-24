/// The fee leg (decision 1, Sky, 24 Oct 2026).
///
/// Splash may take a fee on a payment, as a separate leg in the same
/// transaction: the principal never routes through it. What these tests pin:
///
///   * the fee parameters live on `ComplianceConfig` (the fee address, the
///     most bps an intent may carry, and a cap per payment), start off (no
///     address, 0 bps) and change only through the 24-hour path: the
///     governance quorum proposes, waits 24 hours and activates within seven
///     days; the quorum or the compliance key may cancel;
///   * the fee address is derived on chain from its members and must not be
///     a multisig any one member can sign for alone, so it can never be a
///     lone hot key such as the KMS operator; the bps ceiling is 2%;
///   * an intent records its fee when it opens, rounded down and capped, so
///     the owners see it before they approve and the receipt can show it; a
///     fee needs a configured fee address;
///   * at settlement the fee charged is the lesser of the recorded fee and
///     the fee under the current config, so a later rise never charges more
///     than was shown; it goes to the current fee address, and the principal
///     reaches the recipient exactly as before.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::fee_v2_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::cap_registry::CapRegistry;
use splash_core::compliance_config::{Self, ComplianceConfig, ComplianceCap};
use splash_core::multisig;
use splash_core::payment_intent::{Self, PaymentIntent};
use splash_core::v2_harness::{Self as h, USDC};
use std::bcs;
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
const DAY: u64 = 86_400_000;
const NOTICE: u64 = 86_400_000;
const WINDOW: u64 = 604_800_000;
const QUOTE_MS: u64 = 300_000;
/// Long enough to outlive the 24-hour fee changes some tests make between
/// opening and paying an intent.
const LIFETIME: u64 = 259_200_000;

const STAFF: address = @0x57AFF;
const STRANGER: address = @0xBADBAD;
const SUPPLIER_WALLET: address = @0x5011D;
const OTHER_BUSINESS: address = @0xB12B12;
const MINT_RECIPIENT: address = @0x000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045;
const SOLANA: u32 = 5;

// The governance multisig: a 2-of-3 of a passkey, a zkLogin and an Ed25519
// key (`multisig_tests::MIXED_PASSKEY_ZKLOGIN_ED25519_2_OF_3`).
const GOV_PASSKEY: vector<u8> = x"060355969b344645e48573e045cdbf4cbb0adb4369d411962cfc8a6ae3c33b8acf16";
const GOV_ZKLOGIN: vector<u8> = x"051b68747470733a2f2f6163636f756e74732e676f6f676c652e636f6d00000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad2";
const GOV_ED25519: vector<u8> = x"00d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
/// `multisig_tests::PASSKEY_1_OF_1`: one passkey, threshold 1. A lone key.
const PASSKEY_1_OF_1: address = @0x542f90eeed1c3562b33c4d81d7daf9571b91497acea2c5c6b6759290a569fe8f;

fun gov_keys(): vector<vector<u8>> { vector[GOV_PASSKEY, GOV_ZKLOGIN, GOV_ED25519] }
fun ones(): vector<u8> { vector[1, 1, 1] }
fun gov(): address { multisig::derive_address(&gov_keys(), &ones(), 2) }

/// Splash's finance multisig, as the fee address: the 3-of-3 of the
/// governance keys.
fun fee_keys(): vector<vector<u8>> { gov_keys() }
fun fee_threshold(): u16 { 3 }
fun fee_address(): address { multisig::derive_address(&fee_keys(), &ones(), fee_threshold()) }
/// A second finance multisig: the 3-of-3 of the three passkeys.
fun other_fee_address(): address { multisig::derive_address(&h::keys(), &ones(), 3) }

// ─── Harness ───────────────────────────────────────────────────────────────

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

fun now(s: &mut Scenario): u64 {
    s.next_tx(h::owner_1());
    let c = s.take_shared<Clock>();
    let t = c.timestamp_ms();
    ts::return_shared(c);
    t
}

fun set_time(s: &mut Scenario, ms: u64) {
    s.next_tx(h::owner_1());
    let mut c = s.take_shared<Clock>();
    c.set_for_testing(ms);
    ts::return_shared(c);
}

/// `who`, presenting `keys`/`weights`/`threshold` as itself, proposes the fee
/// address of `fkeys`/`fweights`/`fthreshold` with this ceiling and cap.
fun propose_with(
    s: &mut Scenario,
    who: address,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    fkeys: vector<vector<u8>>,
    fweights: vector<u8>,
    fthreshold: u16,
    bps: u64,
    cap: u64,
) {
    s.next_tx(who);
    let mut config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::propose_fee_change(
        &admin, &mut config, keys, weights, threshold, fkeys, fweights, fthreshold, bps, cap, &c, s.ctx(),
    );
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(c);
    ts::return_shared(config);
}

/// The governance quorum proposes the finance multisig with this ceiling and cap.
fun propose(s: &mut Scenario, bps: u64, cap: u64) {
    propose_with(s, gov(), gov_keys(), ones(), 2, fee_keys(), ones(), fee_threshold(), bps, cap);
}

fun activate_as(s: &mut Scenario, who: address, keys: vector<vector<u8>>, threshold: u16, to: address, bps: u64, cap: u64) {
    s.next_tx(who);
    let mut config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::activate_fee_change(&admin, &mut config, keys, ones(), threshold, to, bps, cap, &c, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(c);
    ts::return_shared(config);
}

fun activate(s: &mut Scenario, to: address, bps: u64, cap: u64) {
    activate_as(s, gov(), gov_keys(), 2, to, bps, cap);
}

/// The whole 24-hour path: propose now, activate exactly at the eta. Moves
/// the clock on 24 hours.
fun set_fee(s: &mut Scenario, bps: u64, cap: u64) {
    propose(s, bps, cap);
    let t = now(s);
    set_time(s, t + NOTICE);
    activate(s, fee_address(), bps, cap);
}

/// The same, to the second finance multisig.
fun set_fee_to_other(s: &mut Scenario, bps: u64, cap: u64) {
    propose_with(s, gov(), gov_keys(), ones(), 2, h::keys(), ones(), 3, bps, cap);
    let t = now(s);
    set_time(s, t + NOTICE);
    activate(s, other_fee_address(), bps, cap);
}

/// The harness's compliance key (owner 1, who created the config) cancels.
fun cancel_by_compliance(s: &mut Scenario) {
    s.next_tx(h::owner_1());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::cancel_fee_change(&mut config, &cap, &caps);
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

fun cancel_by_quorum(s: &mut Scenario) {
    s.next_tx(gov());
    let mut config = s.take_shared<ComplianceConfig>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::admin_cancel_fee_change(&admin, &mut config, gov_keys(), ones(), 2, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(config);
}

/// Put `T` on `registry` through the 24-hour path. Moves the clock on 24 hours.
fun register<T>(s: &mut Scenario, registry: u8) {
    s.next_tx(gov());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::propose_addition<T>(&admin, &mut config, registry, gov_keys(), ones(), 2, &c, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
    let t = now(s);
    set_time(s, t + compliance_config::addition_notice_ms());
    s.next_tx(gov());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::activate_addition<T>(&admin, &mut config, registry, gov_keys(), ones(), 2, &c, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
}

/// The wallet opens an intent of `kind` to `to` carrying `fee_bps`.
fun open(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    kind: u8,
    to: address,
    amount: u64,
    fee_bps: u64,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    let bank = kind == payment_intent::kind_bank_payout();
    payment_intent::create_for_wallet<USDC>(
        account,
        config,
        h::payment_ref(n),
        to,
        if (bank) h::beneficiary() else vector[],
        amount,
        fee_bps,
        if (bank) b"PHP".to_string() else b"USDC".to_string(),
        56_000_000,
        h::commitment(),
        kind,
        h::rail(),
        c.timestamp_ms() + LIFETIME,
        c,
        ctx,
    )
}

/// A wallet transfer (kind 3) to the supplier, opened and shared.
fun open_shared(s: &mut Scenario, amount: u64, fee_bps: u64): ID {
    let mut id = object::id_from_address(@0x0);
    tx!(s, h::wallet(), |account, config, c, ctx| {
        let intent = open(account, config, 1, payment_intent::kind_wallet(), SUPPLIER_WALLET, amount, fee_bps, c, ctx);
        id = object::id(&intent);
        payment_intent::share_intent(intent);
    });
    id
}

fun app_open_shared(s: &mut Scenario, amount: u64, fee_bps: u64): ID {
    let mut id = object::id_from_address(@0x0);
    tx!(s, STAFF, |account, config, c, ctx| {
        let intent = payment_intent::create_for_app<USDC, TestApp>(
            TestApp {},
            account,
            config,
            STAFF,
            h::payment_ref(2),
            SUPPLIER_WALLET,
            vector[],
            amount,
            fee_bps,
            b"USDC".to_string(),
            56_000_000,
            h::commitment(),
            payment_intent::kind_wallet(),
            h::rail(),
            c.timestamp_ms() + LIFETIME,
            c,
            ctx,
        );
        id = object::id(&intent);
        payment_intent::share_intent(intent);
    });
    id
}

/// The wallet pays the shared intent `id` with a coin of `paid`.
fun wallet_pays(s: &mut Scenario, id: ID, paid: u64) {
    s.next_tx(h::wallet());
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let payment = coin::mint_for_testing<USDC>(paid, s.ctx());
    let receipt = payment_intent::confirm_from_business_wallet(
        &mut intent, &mut account, &config, payment, c.timestamp_ms() + QUOTE_MS, &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    ts::return_shared(intent);
}

fun wallet_pays_from_balance(s: &mut Scenario, id: ID, paid: u64) {
    s.next_tx(h::wallet());
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let funds = balance::create_for_testing<USDC>(paid);
    let receipt = payment_intent::confirm_from_business_wallet_balance(
        &mut intent, &mut account, &config, funds, c.timestamp_ms() + QUOTE_MS, &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    ts::return_shared(intent);
}

/// The registered app settles the shared intent `id` with `funds`.
fun app_pays(s: &mut Scenario, id: ID, funds: u64) {
    s.next_tx(STAFF);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let receipt = payment_intent::settle_from_app<USDC, TestApp>(
        TestApp {},
        &mut intent,
        &mut account,
        &config,
        balance::create_for_testing<USDC>(funds),
        c.timestamp_ms() + QUOTE_MS,
        &c,
        s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    ts::return_shared(intent);
}

fun intent_fees(s: &mut Scenario, id: ID): (u64, u64, u64) {
    s.next_tx(h::owner_1());
    let intent = s.take_shared_by_id<PaymentIntent>(id);
    let r = (payment_intent::fee_bps(&intent), payment_intent::fee_minor(&intent), payment_intent::fee_charged_minor(&intent));
    ts::return_shared(intent);
    r
}

fun assert_coin_at(s: &mut Scenario, who: address, value: u64) {
    s.next_tx(who);
    let paid = s.take_from_sender<Coin<USDC>>();
    assert_eq!(paid.value(), value);
    s.return_to_sender(paid);
}

fun settled(s: &mut Scenario, who: address): u64 {
    s.next_tx(who);
    ts::settled_balance<USDC>(who)
}

fun config_address(s: &mut Scenario): address {
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    let a = object::id_address(&config);
    ts::return_shared(config);
    a
}

// ═══ The parameters, and the 24-hour path ══════════════════════════════════

#[test]
/// A new config takes no fee: no address, a 0 bps ceiling, a 0 cap, nothing
/// pending. The ceiling the chain will ever allow is 200 bps (2%).
fun the_fee_starts_off() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    assert!(compliance_config::fee_address(&config).is_none());
    assert_eq!(compliance_config::max_fee_bps(&config), 0);
    assert_eq!(compliance_config::fee_cap_minor(&config), 0);
    assert!(compliance_config::pending_fee_change(&config).is_none());
    assert_eq!(compliance_config::max_fee_bps_ceiling(), 200);
    ts::return_shared(config);
    s.end();
}

#[test]
/// Proposed by the quorum, the change waits 24 hours, then the quorum puts it
/// in force. The address is the one Move derives from the fee members. Each
/// step is evented with Splash's own parameters and nothing of any client's.
fun a_fee_change_takes_effect_after_its_notice() {
    let mut s = h::setup();
    let config_id = config_address(&mut s);
    propose(&mut s, 30, 5 * USD);
    {
        let proposed = event::events_by_type<compliance_config::FeeChangeProposed>();
        assert_eq!(proposed.length(), 1);
        let mut expected = bcs::to_bytes(&config_id);
        expected.append(bcs::to_bytes(&fee_address()));
        expected.append(bcs::to_bytes(&30u64));
        expected.append(bcs::to_bytes(&(5 * USD)));
        expected.append(bcs::to_bytes(&DAY));
        expected.append(bcs::to_bytes(&(DAY + NOTICE)));
        assert_eq!(bcs::to_bytes(&proposed[0]), expected);
    };
    s.next_tx(h::owner_1());
    {
        let config = s.take_shared<ComplianceConfig>();
        // Pending only: nothing is charged on its strength yet.
        assert!(compliance_config::fee_address(&config).is_none());
        assert_eq!(compliance_config::max_fee_bps(&config), 0);
        let p = compliance_config::pending_fee_change(&config).destroy_some();
        assert_eq!(compliance_config::pending_fee_address(&p), fee_address());
        assert_eq!(compliance_config::pending_fee_bps(&p), 30);
        assert_eq!(compliance_config::pending_fee_cap_minor(&p), 5 * USD);
        assert_eq!(compliance_config::pending_fee_eta_ms(&p), DAY + NOTICE);
        ts::return_shared(config);
    };
    set_time(&mut s, DAY + NOTICE);
    activate(&mut s, fee_address(), 30, 5 * USD);
    {
        let activated = event::events_by_type<compliance_config::FeeChangeActivated>();
        assert_eq!(activated.length(), 1);
        let mut expected = bcs::to_bytes(&config_id);
        expected.append(bcs::to_bytes(&fee_address()));
        expected.append(bcs::to_bytes(&30u64));
        expected.append(bcs::to_bytes(&(5 * USD)));
        assert_eq!(bcs::to_bytes(&activated[0]), expected);
    };
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    assert_eq!(compliance_config::fee_address(&config), option::some(fee_address()));
    assert_eq!(compliance_config::max_fee_bps(&config), 30);
    assert_eq!(compliance_config::fee_cap_minor(&config), 5 * USD);
    assert!(compliance_config::pending_fee_change(&config).is_none());
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_FEE_NOTICE_NOT_RUN)]
/// One millisecond before the eta is too early.
fun a_fee_change_cannot_be_activated_early() {
    let mut s = h::setup();
    propose(&mut s, 30, 5 * USD);
    set_time(&mut s, DAY + NOTICE - 1);
    activate(&mut s, fee_address(), 30, 5 * USD);
    s.end();
}

#[test]
/// The last millisecond of the seven-day window still works.
fun a_fee_change_activates_on_the_last_ms_of_its_window() {
    let mut s = h::setup();
    propose(&mut s, 30, 5 * USD);
    set_time(&mut s, DAY + NOTICE + WINDOW - 1);
    activate(&mut s, fee_address(), 30, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_FEE_CHANGE_LAPSED)]
/// Seven days after the notice ran, the change has lapsed: owners stopped
/// watching for it long ago. Propose again.
fun a_fee_change_lapses_seven_days_after_its_notice() {
    let mut s = h::setup();
    propose(&mut s, 30, 5 * USD);
    set_time(&mut s, DAY + NOTICE + WINDOW);
    activate(&mut s, fee_address(), 30, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_THIS_MULTISIG)]
/// The proposer must be the multisig it presents. A stranger holding
/// `AdminCap` and naming the governance keys is not that multisig.
fun a_stranger_cannot_propose_a_fee_change() {
    let mut s = h::setup();
    propose_with(&mut s, STRANGER, gov_keys(), ones(), 2, fee_keys(), ones(), fee_threshold(), 30, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_A_QUORUM)]
/// Nor may a lone key propose, even as its own 1-of-1 multisig.
fun a_single_key_cannot_propose_a_fee_change() {
    let mut s = h::setup();
    propose_with(&mut s, PASSKEY_1_OF_1, vector[h::passkey(0)], vector[1], 1, fee_keys(), ones(), fee_threshold(), 30, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_THIS_MULTISIG)]
/// Activation needs the quorum again: a stranger cannot cash the notice in.
fun a_stranger_cannot_activate_a_fee_change() {
    let mut s = h::setup();
    propose(&mut s, 30, 5 * USD);
    set_time(&mut s, DAY + NOTICE);
    activate_as(&mut s, STRANGER, gov_keys(), 2, fee_address(), 30, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_FEE_ADDRESS_SINGLE_SIGNER)]
/// The fee address may not be a lone key: a 1-of-1 is refused, so the KMS
/// operator, or any one person's key, can never receive the fee.
fun a_one_key_fee_address_is_refused() {
    let mut s = h::setup();
    propose_with(&mut s, gov(), gov_keys(), ones(), 2, vector[h::passkey(0)], vector[1], 1, 30, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_FEE_ADDRESS_SINGLE_SIGNER)]
/// Nor a multisig whose weights let one member sign alone: [2, 1, 1] under
/// threshold 2 is a one-person address.
fun a_disguised_single_signer_fee_address_is_refused() {
    let mut s = h::setup();
    propose_with(&mut s, gov(), gov_keys(), ones(), 2, h::keys(), vector[2, 1, 1], 2, 30, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_FEE_ABOVE_CEILING)]
/// 201 bps is past the 2% ceiling written into the package.
fun a_fee_ceiling_above_two_percent_is_refused() {
    let mut s = h::setup();
    propose(&mut s, 201, 5 * USD);
    s.end();
}

#[test]
/// 200 bps, the ceiling itself, is allowed.
fun a_fee_ceiling_of_exactly_two_percent_is_allowed() {
    let mut s = h::setup();
    set_fee(&mut s, 200, 5 * USD);
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    assert_eq!(compliance_config::max_fee_bps(&config), 200);
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_FEE_CHANGE_MISMATCH)]
/// Activation names what it puts in force. Signers who were shown one change
/// cannot be made to activate another.
fun activation_must_name_the_pending_change() {
    let mut s = h::setup();
    propose(&mut s, 30, 5 * USD);
    set_time(&mut s, DAY + NOTICE);
    activate(&mut s, fee_address(), 40, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_FEE_CHANGE_PENDING)]
/// One change waits at a time. A second proposal is refused until the first
/// is activated or cancelled.
fun a_second_fee_change_waits_for_the_first() {
    let mut s = h::setup();
    propose(&mut s, 30, 5 * USD);
    propose(&mut s, 40, 5 * USD);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NO_FEE_CHANGE)]
/// The compliance key may cancel a pending change (it only stops a change),
/// and a cancelled change cannot be activated.
fun the_compliance_key_cancels_a_fee_change() {
    let mut s = h::setup();
    propose(&mut s, 30, 5 * USD);
    cancel_by_compliance(&mut s);
    {
        let cancelled = event::events_by_type<compliance_config::FeeChangeCancelled>();
        assert_eq!(cancelled.length(), 1);
    };
    set_time(&mut s, DAY + NOTICE);
    activate(&mut s, fee_address(), 30, 5 * USD);
    s.end();
}

#[test]
/// So may the quorum, and cancelling leaves the fee as it was.
fun the_quorum_cancels_a_fee_change() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    propose(&mut s, 60, 5 * USD);
    cancel_by_quorum(&mut s);
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    assert!(compliance_config::pending_fee_change(&config).is_none());
    assert_eq!(compliance_config::max_fee_bps(&config), 30);
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NO_FEE_CHANGE)]
/// There is nothing to cancel when nothing is pending.
fun cancelling_with_nothing_pending_aborts() {
    let mut s = h::setup();
    cancel_by_compliance(&mut s);
    s.end();
}

// ═══ The fee an intent records when it opens ═══════════════════════════════

#[test]
/// The arithmetic: amount × bps ÷ 10,000, rounded DOWN, then capped. Dust
/// rounds to nothing, and a large amount does not overflow.
fun the_fee_rounds_down_and_is_capped() {
    let mut s = h::setup();
    set_fee(&mut s, 200, 5 * USD);
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    // 100.000001 USDC at 30 bps is 0.300000003 USDC: 300,000 minor units.
    assert_eq!(payment_intent::fee_for(&config, 100_000_001, 30), 300_000);
    // 1 unit at 200 bps rounds to nothing; so do 9,999 at 1 bps.
    assert_eq!(payment_intent::fee_for(&config, 1, 200), 0);
    assert_eq!(payment_intent::fee_for(&config, 9_999, 1), 0);
    assert_eq!(payment_intent::fee_for(&config, 10_000, 1), 1);
    // 1,000 USDC at 50 bps would be 5 USDC; the cap is 5 USDC, so 5.
    assert_eq!(payment_intent::fee_for(&config, 1_000 * USD, 50), 5 * USD);
    // 2,000 USDC at 50 bps would be 10 USDC: capped at 5.
    assert_eq!(payment_intent::fee_for(&config, 2_000 * USD, 50), 5 * USD);
    // Zero bps is zero.
    assert_eq!(payment_intent::fee_for(&config, 1_000 * USD, 0), 0);
    // The largest u64 at 200 bps does not overflow (u128 inside); the cap holds.
    assert_eq!(payment_intent::fee_for(&config, 18_446_744_073_709_551_615, 200), 5 * USD);
    ts::return_shared(config);
    s.end();
}

#[test]
/// An intent records its bps and its fee when it opens, so the owners see the
/// fee before they approve, and nothing is charged yet.
fun an_intent_records_its_fee_when_it_opens() {
    let mut s = h::setup();
    set_fee(&mut s, 50, 5 * USD);
    let id = open_shared(&mut s, 100_000_001, 30);
    let (bps, fee, charged) = intent_fees(&mut s, id);
    assert_eq!(bps, 30);
    assert_eq!(fee, 300_000);
    assert_eq!(charged, 0);
    s.end();
}

#[test]
/// The cap applies at opening: 2,000 USDC at 50 bps records 5 USDC, not 10.
fun the_recorded_fee_is_capped() {
    let mut s = h::setup();
    set_fee(&mut s, 50, 5 * USD);
    let id = open_shared(&mut s, 2_000 * USD, 50);
    let (_, fee, _) = intent_fees(&mut s, id);
    assert_eq!(fee, 5 * USD);
    s.end();
}

#[test]
/// With the fee off, an intent at 0 bps opens and records no fee.
fun a_zero_fee_needs_no_fee_address() {
    let mut s = h::setup();
    let id = open_shared(&mut s, 100 * USD, 0);
    let (bps, fee, _) = intent_fees(&mut s, id);
    assert_eq!(bps, 0);
    assert_eq!(fee, 0);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_NO_FEE_ADDRESS)]
/// A fee needs somewhere to go. Before any fee address is configured, an
/// intent carrying a fee is refused when it opens.
fun a_fee_with_no_fee_address_is_refused_at_creation() {
    let mut s = h::setup();
    open_shared(&mut s, 100 * USD, 10);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_FEE_ABOVE_MAX)]
/// The business chooses the fee off chain; the chain bounds it by the
/// config's ceiling.
fun a_fee_above_the_configured_ceiling_is_refused() {
    let mut s = h::setup();
    set_fee(&mut s, 50, 5 * USD);
    open_shared(&mut s, 100 * USD, 51);
    s.end();
}

#[test]
/// A cross-chain intent and an app-made intent record their fee the same way.
fun every_create_records_the_fee() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    set_fee(&mut s, 50, 5 * USD);
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let intent = payment_intent::create_cross_chain_for_wallet<USDC>(
            account,
            config,
            h::payment_ref(9),
            SOLANA,
            MINT_RECIPIENT,
            200 * USD,
            25,
            h::commitment(),
            h::rail(),
            50_000,
            1_000,
            c.timestamp_ms() + QUOTE_MS,
            c,
            ctx,
        );
        assert_eq!(payment_intent::fee_bps(&intent), 25);
        assert_eq!(payment_intent::fee_minor(&intent), 500_000);
        payment_intent::cancel(intent, c, ctx);
    });
    let id = app_open_shared(&mut s, 200 * USD, 10);
    let (bps, fee, _) = intent_fees(&mut s, id);
    assert_eq!(bps, 10);
    assert_eq!(fee, 200_000);
    s.end();
}

// ═══ The fee leg at settlement ═════════════════════════════════════════════

#[test]
/// The wallet pays amount + fee + change by coin. The recipient gets exactly
/// the amount, as a coin, as before; the fee address's balance gets exactly
/// the fee; the change goes back to the wallet's balance.
fun the_fee_leg_goes_to_the_fee_address_and_the_principal_to_the_recipient() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    let id = open_shared(&mut s, 100 * USD, 30);
    wallet_pays(&mut s, id, 100 * USD + 300_000 + 77);
    assert_coin_at(&mut s, SUPPLIER_WALLET, 100 * USD);
    assert_eq!(settled(&mut s, SUPPLIER_WALLET), 0);
    assert_eq!(settled(&mut s, fee_address()), 300_000);
    assert_eq!(settled(&mut s, h::wallet()), 77);
    let (_, fee, charged) = intent_fees(&mut s, id);
    assert_eq!(fee, 300_000);
    assert_eq!(charged, 300_000);
    s.end();
}

#[test]
/// The balance path splits the same way.
fun the_balance_path_pays_the_fee_leg_too() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    let id = open_shared(&mut s, 100 * USD, 30);
    wallet_pays_from_balance(&mut s, id, 100 * USD + 300_000 + 5);
    assert_coin_at(&mut s, SUPPLIER_WALLET, 100 * USD);
    assert_eq!(settled(&mut s, fee_address()), 300_000);
    assert_eq!(settled(&mut s, h::wallet()), 5);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INSUFFICIENT_PAYMENT)]
/// The payment must cover the amount and the fee: one unit short aborts.
fun the_payment_must_cover_amount_and_fee() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    let id = open_shared(&mut s, 100 * USD, 30);
    wallet_pays(&mut s, id, 100 * USD + 300_000 - 1);
    s.end();
}

#[test]
/// A Splash business is still credited to its address balance, and the fee
/// to the fee address's.
fun a_splash_business_payment_carries_a_fee_leg() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = open(account, config, 1, payment_intent::kind_splash_business(), OTHER_BUSINESS, 100 * USD, 30, c, ctx);
        let payment = coin::mint_for_testing<USDC>(100 * USD + 300_000, ctx);
        let receipt = payment_intent::confirm_from_business_wallet(&mut intent, account, config, payment, h::settle_by(c), c, ctx);
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
        payment_intent::delete_finalized(intent);
    });
    assert_eq!(settled(&mut s, OTHER_BUSINESS), 100 * USD);
    assert_eq!(settled(&mut s, fee_address()), 300_000);
    assert_eq!(settled(&mut s, h::wallet()), 0);
    s.end();
}

#[test]
/// A zero fee sends nothing to anyone but the recipient.
fun a_zero_fee_has_no_fee_leg() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    let id = open_shared(&mut s, 100 * USD, 0);
    wallet_pays(&mut s, id, 100 * USD);
    assert_coin_at(&mut s, SUPPLIER_WALLET, 100 * USD);
    assert_eq!(settled(&mut s, fee_address()), 0);
    assert_eq!(settled(&mut s, h::wallet()), 0);
    s.end();
}

#[test]
/// A fee lowered after the intent opened charges the lower fee, and the
/// difference stays with the wallet.
fun a_lowered_fee_charges_less() {
    let mut s = h::setup();
    set_fee(&mut s, 50, 5 * USD);
    let id = open_shared(&mut s, 100 * USD, 50);
    set_fee(&mut s, 20, 5 * USD);
    wallet_pays(&mut s, id, 100 * USD + 500_000);
    assert_coin_at(&mut s, SUPPLIER_WALLET, 100 * USD);
    assert_eq!(settled(&mut s, fee_address()), 200_000);
    assert_eq!(settled(&mut s, h::wallet()), 300_000);
    let (_, fee, charged) = intent_fees(&mut s, id);
    assert_eq!(fee, 500_000);
    assert_eq!(charged, 200_000);
    s.end();
}

#[test]
/// A lowered cap charges less too.
fun a_lowered_cap_charges_less() {
    let mut s = h::setup();
    set_fee(&mut s, 50, 5 * USD);
    let id = open_shared(&mut s, 1_000 * USD, 50);
    set_fee(&mut s, 50, 2 * USD);
    wallet_pays(&mut s, id, 1_000 * USD + 5 * USD);
    assert_eq!(settled(&mut s, fee_address()), 2 * USD);
    assert_eq!(settled(&mut s, h::wallet()), 3 * USD);
    s.end();
}

#[test]
/// A fee raised after the intent opened charges no more than was shown.
fun a_raised_fee_charges_no_more() {
    let mut s = h::setup();
    set_fee(&mut s, 20, 1 * USD);
    let id = open_shared(&mut s, 100 * USD, 20);
    set_fee(&mut s, 200, 50 * USD);
    wallet_pays(&mut s, id, 100 * USD + 200_000);
    assert_eq!(settled(&mut s, fee_address()), 200_000);
    assert_eq!(settled(&mut s, h::wallet()), 0);
    let (_, _, charged) = intent_fees(&mut s, id);
    assert_eq!(charged, 200_000);
    s.end();
}

#[test]
/// The fee goes to the fee address in force at settlement: a finance multisig
/// rotated through the 24-hour path receives it, the retired one does not.
fun the_fee_goes_to_the_current_fee_address() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    let id = open_shared(&mut s, 100 * USD, 30);
    set_fee_to_other(&mut s, 30, 5 * USD);
    wallet_pays(&mut s, id, 100 * USD + 300_000);
    assert_eq!(settled(&mut s, other_fee_address()), 300_000);
    assert_eq!(settled(&mut s, fee_address()), 0);
    s.end();
}

#[test]
/// A settlement app hands over exactly amount + recorded fee (what
/// `splash_spend` draws). The principal reaches the recipient, the fee the
/// fee address, and nothing is left over.
fun the_app_path_pays_the_fee_leg() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    set_fee(&mut s, 30, 5 * USD);
    let id = app_open_shared(&mut s, 100 * USD, 30);
    app_pays(&mut s, id, 100 * USD + 300_000);
    assert_coin_at(&mut s, SUPPLIER_WALLET, 100 * USD);
    assert_eq!(settled(&mut s, fee_address()), 300_000);
    assert_eq!(settled(&mut s, h::wallet()), 0);
    s.end();
}

#[test]
/// On the app path a lowered fee returns the difference to the wallet's
/// address balance, where the allowance drew it from.
fun the_app_path_returns_a_lowered_fee_to_the_wallet() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    set_fee(&mut s, 50, 5 * USD);
    let id = app_open_shared(&mut s, 100 * USD, 50);
    set_fee(&mut s, 10, 5 * USD);
    app_pays(&mut s, id, 100 * USD + 500_000);
    assert_coin_at(&mut s, SUPPLIER_WALLET, 100 * USD);
    assert_eq!(settled(&mut s, fee_address()), 100_000);
    assert_eq!(settled(&mut s, h::wallet()), 400_000);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_EXACT_AMOUNT_REQUIRED)]
/// The app must hand over the fee as well: the amount alone is refused.
fun the_app_path_requires_amount_plus_fee_exactly() {
    let mut s = h::setup();
    register<TestApp>(&mut s, compliance_config::registry_settlement_app());
    set_fee(&mut s, 30, 5 * USD);
    let id = app_open_shared(&mut s, 100 * USD, 30);
    app_pays(&mut s, id, 100 * USD);
    s.end();
}

#[test]
/// A cross-chain settlement releases exactly the amount for the bridge; the
/// fee leg goes to the fee address and the change to the wallet.
fun the_cross_chain_path_pays_the_fee_leg() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    tx!(&mut s, h::wallet(), |account, config, c, ctx| {
        let mut intent = payment_intent::create_cross_chain_for_wallet<USDC>(
            account,
            config,
            h::payment_ref(9),
            SOLANA,
            MINT_RECIPIENT,
            100 * USD,
            30,
            h::commitment(),
            h::rail(),
            50_000,
            1_000,
            c.timestamp_ms() + QUOTE_MS,
            c,
            ctx,
        );
        let payment = coin::mint_for_testing<USDC>(100 * USD + 300_000 + 3, ctx);
        let (receipt, to_bridge, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
            &mut intent, account, config, payment, h::settle_by(c), c, ctx,
        );
        assert_eq!(to_bridge.value(), 100 * USD);
        let (_, coin_id, _, amount, _, _, _, _) = payment_intent::unpack_bridge_obligation_for_testing(obligation);
        assert_eq!(coin_id, object::id(&to_bridge));
        assert_eq!(amount, 100 * USD);
        assert_eq!(payment_intent::fee_charged_minor(&intent), 300_000);
        coin::burn_for_testing(to_bridge);
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
        payment_intent::delete_finalized(intent);
    });
    assert_eq!(settled(&mut s, fee_address()), 300_000);
    assert_eq!(settled(&mut s, h::wallet()), 3);
    s.end();
}

#[test]
/// The confirmation event keeps its shape: it gains no fee or amount field.
fun the_confirmation_event_carries_no_fee() {
    let mut s = h::setup();
    set_fee(&mut s, 30, 5 * USD);
    let id = open_shared(&mut s, 100 * USD, 30);
    wallet_pays(&mut s, id, 100 * USD + 300_000);
    let confirmed = event::events_by_type<payment_intent::IntentConfirmed>();
    assert_eq!(confirmed.length(), 1);
    let (intent_id, commitment, _, _, kind, status, path, _) =
        payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
    assert_eq!(intent_id, id);
    assert_eq!(commitment, h::commitment());
    assert_eq!(kind, payment_intent::kind_wallet());
    assert_eq!(status, 1);
    assert_eq!(path, payment_intent::path_business_wallet());
    s.end();
}

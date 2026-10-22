/// WS3 — service orders: three signatures by three parties.
///
/// Before WS3 the server opened an intent with the operator key and paid it
/// from the operator's own gas coin in the next transaction. Nobody else
/// signed anything: the "approval" was a row in Postgres, and the chain saw
/// one address authorising and paying its own payout. A stolen operator key
/// was therefore a stolen treasury.
///
/// A service order splits that into three parties the chain can tell apart:
///
///   1. a member of the client's business account opens the order
///      (`create_service_order`), in their own wallet;
///   2. a DIFFERENT approver of that account approves it (`approve_payout`),
///      and the approval is transferred to the registered operator;
///   3. the operator settles it (`confirm_with_approval`) with Splash's own
///      coin, for exactly the amount the client opened and the approver saw.
///
/// And once an operator is registered in the `SettlementPolicy`, the old
/// shape — the operator opening its own intent — aborts.
#[test_only]
module splash_core::service_order_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount, PayoutApproval};
use splash_core::payment_intent::{Self, PaymentIntent};
use splash_core::settlement_policy::{Self, SettlementPolicy};
use std::unit_test::assert_eq;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const MAKER: address = @0xA11CE;
const APPROVER: address = @0xBEEF;
const OPERATOR: address = @0x0FE7;
const NEXT_OPERATOR: address = @0x0FE8;
const OUTSIDER: address = @0xDEAD;
const RECIPIENT: address = @0xB0B;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";
const COMMITMENT: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/// 100 USD in six-decimal minor units: over the 99 USD floor, under Tier 3.
const AMOUNT: u64 = 100_000_000;
const DAY: u64 = 86_400_000;

// ─── Harness ───────────────────────────────────────────────────────────────

/// The publish: a shared clock, a shared `SettlementPolicy` with no operator,
/// and a verified business account owned by MAKER with APPROVER approving.
fun publish(): Scenario {
    let mut scenario = ts::begin(MAKER);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(DAY);
        clock::share_for_testing(c);
        settlement_policy::init_for_testing(ctx);
    };
    scenario.next_tx(MAKER);
    {
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::submit_application(
            b"SSM-202401012345".to_string(),
            b"bafy-kyb-cid".to_string(),
            &c,
            ctx,
        );
        ts::return_shared(c);
    };
    scenario.next_tx(MAKER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::verify_business(&admin, &mut account, 20);
        business_account::add_approver(&mut account, APPROVER, ctx);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    scenario
}

/// The cold `AdminCap` registers `who` as the operator.
fun register_operator(scenario: &mut Scenario, who: address) {
    scenario.next_tx(MAKER);
    let mut policy = scenario.take_shared<SettlementPolicy>();
    let ctx = scenario.ctx();
    let admin = business_account::admin_cap_for_testing(ctx);
    settlement_policy::set_operator(&admin, &mut policy, who);
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(policy);
}

/// Published, with OPERATOR registered.
fun setup(): Scenario {
    let mut scenario = publish();
    register_operator(&mut scenario, OPERATOR);
    scenario
}

/// Signature 1: a member of the client's account opens the order.
fun open_order(scenario: &mut Scenario, maker: address, amount: u64) {
    scenario.next_tx(maker);
    let account = scenario.take_shared<BusinessAccount>();
    let policy = scenario.take_shared<SettlementPolicy>();
    let c = scenario.take_shared<Clock>();
    let ctx = scenario.ctx();
    payment_intent::create_service_order<SUI>(
        &account,
        &policy,
        RECIPIENT,
        amount,
        b"PHP".to_string(),
        56_000_000,
        COMMITMENT,
        &c,
        ctx,
    );
    ts::return_shared(c);
    ts::return_shared(policy);
    ts::return_shared(account);
}

/// Signature 2: a different approver approves.
fun approve(scenario: &mut Scenario, approver: address) {
    scenario.next_tx(approver);
    let account = scenario.take_shared<BusinessAccount>();
    let intent = scenario.take_shared<PaymentIntent>();
    let c = scenario.take_shared<Clock>();
    let ctx = scenario.ctx();
    payment_intent::approve_payout(&intent, &account, &c, ctx);
    ts::return_shared(c);
    ts::return_shared(intent);
    ts::return_shared(account);
}

/// Signature 3: `payer` settles with the approval the operator received, from
/// a coin of `coin_value`, and anchors the receipt.
fun settle_as(scenario: &mut Scenario, payer: address, coin_value: u64) {
    scenario.next_tx(payer);
    let mut account = scenario.take_shared<BusinessAccount>();
    let mut intent = scenario.take_shared<PaymentIntent>();
    let c = scenario.take_shared<Clock>();
    let approval = scenario.take_from_address<PayoutApproval>(OPERATOR);
    let ctx = scenario.ctx();
    let payment = coin::mint_for_testing<SUI>(coin_value, ctx);
    let receipt = payment_intent::confirm_with_approval(
        &mut intent,
        &mut account,
        approval,
        payment,
        &c,
        ctx,
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, ctx);
    ts::return_shared(c);
    ts::return_shared(intent);
    ts::return_shared(account);
}

fun advance(scenario: &mut Scenario, by_ms: u64) {
    scenario.next_tx(MAKER);
    let mut c = scenario.take_shared<Clock>();
    c.increment_for_testing(by_ms);
    ts::return_shared(c);
}

// ─── The sequence ──────────────────────────────────────────────────────────

#[test]
/// The whole flow, and the property it exists for: the operator pays exactly
/// what the client opened and a second member approved, no more — an
/// overfunded coin is refunded to the operator, not forwarded — and the
/// approval travelled to the operator, not back to the maker.
///
/// `tests/service-orders.test.mjs` mirrors this sequence against the three
/// TypeScript builders, call for call.
fun operator_pays_what_the_client_approved() {
    let mut scenario = setup();

    open_order(&mut scenario, MAKER, AMOUNT);
    scenario.next_tx(MAKER);
    {
        let intent = scenario.take_shared<PaymentIntent>();
        let policy = scenario.take_shared<SettlementPolicy>();
        // The client opened it; the operator will pay it.
        assert_eq!(payment_intent::sender(&intent), MAKER);
        assert_eq!(payment_intent::payer(&intent), OPERATOR);
        assert!(payment_intent::is_service_order(&intent));
        assert!(payment_intent::is_account_bound(&intent));
        assert_eq!(settlement_policy::operator(&policy), option::some(OPERATOR));
        ts::return_shared(policy);
        ts::return_shared(intent);
    };

    approve(&mut scenario, APPROVER);
    // The approval went to the payer, not to the maker.
    scenario.next_tx(OPERATOR);
    {
        assert!(ts::has_most_recent_for_address<PayoutApproval>(OPERATOR));
        assert!(!ts::has_most_recent_for_address<PayoutApproval>(MAKER));
        let approval = scenario.take_from_address<PayoutApproval>(OPERATOR);
        assert_eq!(business_account::approval_amount(&approval), AMOUNT);
        assert_eq!(business_account::approval_approver(&approval), APPROVER);
        ts::return_to_address(OPERATOR, approval);
    };

    // The operator funds it with more than enough; the contract sends the
    // approved amount and returns the rest.
    settle_as(&mut scenario, OPERATOR, AMOUNT + 7);

    scenario.next_tx(OPERATOR);
    {
        let paid = scenario.take_from_address<Coin<SUI>>(RECIPIENT);
        assert_eq!(coin::value(&paid), AMOUNT);
        ts::return_to_address(RECIPIENT, paid);
        let change = scenario.take_from_address<Coin<SUI>>(OPERATOR);
        assert_eq!(coin::value(&change), 7);
        ts::return_to_address(OPERATOR, change);

        let account = scenario.take_shared<BusinessAccount>();
        let intent = scenario.take_shared<PaymentIntent>();
        let c = scenario.take_shared<Clock>();
        assert_eq!(payment_intent::status(&intent), 1); // CONFIRMED
        // Metered against the client's own ceiling, like any approved payout.
        assert_eq!(business_account::daily_spent(&account, &c), AMOUNT);
        ts::return_shared(c);
        ts::return_shared(intent);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
/// The window the UI shows is the contract's: the intent records its own
/// expiry, and `expiration_window_ms` is the only place the number lives.
fun the_order_carries_its_own_window() {
    let mut scenario = setup();
    open_order(&mut scenario, MAKER, AMOUNT);
    scenario.next_tx(MAKER);
    {
        let intent = scenario.take_shared<PaymentIntent>();
        let c = scenario.take_shared<Clock>();
        assert_eq!(
            payment_intent::expires_at(&intent),
            clock::timestamp_ms(&c) + payment_intent::expiration_window_ms(),
        );
        assert_eq!(payment_intent::created_at(&intent), clock::timestamp_ms(&c));
        ts::return_shared(c);
        ts::return_shared(intent);
    };
    scenario.end();
}

// ─── The server-pays path is closed once an operator is registered ─────────

#[test]
#[expected_failure(abort_code = 421, location = splash_core::payment_intent)]
/// The exact shape `createPaymentIntentOnSui` used to build: the operator
/// opening an unbound intent it will then pay itself.
fun a_registered_operator_cannot_open_its_own_intent() {
    let mut scenario = setup();
    scenario.next_tx(OPERATOR);
    let policy = scenario.take_shared<SettlementPolicy>();
    let c = scenario.take_shared<Clock>();
    let ctx = scenario.ctx();
    payment_intent::create_payment_intent<SUI>(
        &policy,
        RECIPIENT,
        AMOUNT,
        b"PHP".to_string(),
        56_000_000,
        COMMITMENT,
        &c,
        ctx,
    );
    ts::return_shared(c);
    ts::return_shared(policy);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 421, location = splash_core::payment_intent)]
/// `create` returns an owned intent the same PTB can confirm — the same
/// self-authorised payout in one transaction instead of two.
fun a_registered_operator_cannot_use_create_either() {
    let mut scenario = setup();
    scenario.next_tx(OPERATOR);
    let policy = scenario.take_shared<SettlementPolicy>();
    let c = scenario.take_shared<Clock>();
    let ctx = scenario.ctx();
    let intent = payment_intent::create<SUI>(
        &policy,
        RECIPIENT,
        b"counterparty:vendor-001",
        AMOUNT,
        b"USD",
        b"MY-PH",
        b"PHP".to_string(),
        56_000_000,
        COMMITMENT,
        &c,
        ctx,
    );
    payment_intent::cancel(intent, ctx);
    ts::return_shared(c);
    ts::return_shared(policy);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 421, location = splash_core::payment_intent)]
/// Made a member of a tenant, the operator still cannot be the maker of an
/// account-bound intent: it would open and then pay its own payout, with the
/// tenant's approver as the only other party.
fun a_registered_operator_cannot_open_an_account_intent() {
    let mut scenario = setup();
    scenario.next_tx(MAKER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        business_account::add_owner(&mut account, OPERATOR, scenario.ctx());
        ts::return_shared(account);
    };
    scenario.next_tx(OPERATOR);
    let account = scenario.take_shared<BusinessAccount>();
    let policy = scenario.take_shared<SettlementPolicy>();
    let c = scenario.take_shared<Clock>();
    let ctx = scenario.ctx();
    payment_intent::create_payment_intent_for_account<SUI>(
        &account,
        &policy,
        RECIPIENT,
        AMOUNT,
        b"PHP".to_string(),
        56_000_000,
        COMMITMENT,
        &c,
        ctx,
    );
    ts::return_shared(c);
    ts::return_shared(policy);
    ts::return_shared(account);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 421, location = splash_core::payment_intent)]
/// Nor can it open a service order it would pay.
fun the_operator_cannot_open_a_service_order() {
    let mut scenario = setup();
    scenario.next_tx(MAKER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        business_account::add_owner(&mut account, OPERATOR, scenario.ctx());
        ts::return_shared(account);
    };
    open_order(&mut scenario, OPERATOR, AMOUNT);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 423, location = splash_core::payment_intent)]
/// Made an approver, the operator cannot approve what it will pay: the payer
/// is the third party, never the second.
fun the_operator_cannot_approve_what_it_will_pay() {
    let mut scenario = setup();
    scenario.next_tx(MAKER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        business_account::add_approver(&mut account, OPERATOR, scenario.ctx());
        ts::return_shared(account);
    };
    open_order(&mut scenario, MAKER, AMOUNT);
    approve(&mut scenario, OPERATOR);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 422, location = splash_core::payment_intent)]
/// A service order with no registered operator has nobody to pay it, so it
/// is refused rather than opened as an order that can never settle.
fun a_service_order_needs_a_registered_operator() {
    let mut scenario = publish();
    open_order(&mut scenario, MAKER, AMOUNT);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 418, location = splash_core::payment_intent)]
/// Only a member of the account can order a payout from it.
fun a_stranger_cannot_open_a_service_order() {
    let mut scenario = setup();
    open_order(&mut scenario, OUTSIDER, AMOUNT);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 29, location = splash_core::business_account)]
/// Four eyes still holds: the maker cannot approve their own order.
fun the_maker_cannot_approve_their_own_order() {
    let mut scenario = setup();
    scenario.next_tx(MAKER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        business_account::add_approver(&mut account, MAKER, scenario.ctx());
        ts::return_shared(account);
    };
    open_order(&mut scenario, MAKER, AMOUNT);
    approve(&mut scenario, MAKER);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 404, location = splash_core::payment_intent)]
/// The maker cannot settle a service order even holding its approval: the
/// payer the order recorded is the operator.
fun the_maker_cannot_settle_a_service_order() {
    let mut scenario = setup();
    open_order(&mut scenario, MAKER, AMOUNT);
    approve(&mut scenario, APPROVER);
    settle_as(&mut scenario, MAKER, AMOUNT);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 401, location = splash_core::payment_intent)]
/// The five-minute window is real: an order not approved inside it is dead.
fun an_order_past_its_window_cannot_be_approved() {
    let mut scenario = setup();
    open_order(&mut scenario, MAKER, AMOUNT);
    advance(&mut scenario, payment_intent::expiration_window_ms());
    approve(&mut scenario, APPROVER);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 415, location = splash_core::payment_intent)]
/// A service order is account-bound, so the unapproved settle path refuses it.
fun a_service_order_cannot_be_settled_without_an_approval() {
    let mut scenario = setup();
    open_order(&mut scenario, MAKER, AMOUNT);
    scenario.next_tx(OPERATOR);
    let mut intent = scenario.take_shared<PaymentIntent>();
    let c = scenario.take_shared<Clock>();
    let ctx = scenario.ctx();
    let payment = coin::mint_for_testing<SUI>(AMOUNT, ctx);
    let receipt = payment_intent::confirm_payment_intent(&mut intent, payment, &c, ctx);
    audit_anchor::anchor(receipt, HASH, BLOB, &c, ctx);
    ts::return_shared(c);
    ts::return_shared(intent);
    scenario.end();
}

// ─── What stays open ───────────────────────────────────────────────────────

#[test]
/// A payer spending their own coin keeps the unbound path, before and after
/// an operator is registered: the policy closes it to the operator alone.
fun anyone_else_still_pays_their_own_coin() {
    let mut scenario = setup();
    scenario.next_tx(OUTSIDER);
    {
        let policy = scenario.take_shared<SettlementPolicy>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        payment_intent::create_payment_intent<SUI>(
            &policy,
            RECIPIENT,
            AMOUNT,
            b"PHP".to_string(),
            56_000_000,
            COMMITMENT,
            &c,
            ctx,
        );
        ts::return_shared(c);
        ts::return_shared(policy);
    };
    scenario.next_tx(OUTSIDER);
    {
        let intent = scenario.take_shared<PaymentIntent>();
        assert_eq!(payment_intent::payer(&intent), OUTSIDER);
        assert!(!payment_intent::is_service_order(&intent));
        ts::return_shared(intent);
    };
    scenario.end();
}

#[test]
/// Rotation moves the rule with the key: the new operator is refused the
/// server-pays path, and orders opened after the rotation name it as payer.
fun rotating_the_operator_moves_the_rule() {
    let mut scenario = setup();
    register_operator(&mut scenario, NEXT_OPERATOR);
    open_order(&mut scenario, MAKER, AMOUNT);
    scenario.next_tx(MAKER);
    {
        let intent = scenario.take_shared<PaymentIntent>();
        let policy = scenario.take_shared<SettlementPolicy>();
        assert_eq!(payment_intent::payer(&intent), NEXT_OPERATOR);
        assert!(settlement_policy::is_operator(&policy, NEXT_OPERATOR));
        assert!(!settlement_policy::is_operator(&policy, OPERATOR));
        ts::return_shared(policy);
        ts::return_shared(intent);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 1000, location = splash_core::settlement_policy)]
/// The zero address is not an operator: registering it would leave service
/// orders with a payer nobody can sign for.
fun the_zero_address_cannot_be_registered() {
    let mut scenario = publish();
    register_operator(&mut scenario, @0x0);
    scenario.end();
}

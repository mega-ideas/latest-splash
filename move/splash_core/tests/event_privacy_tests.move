/// WS5 — event privacy before the immutable publish.
///
/// What an event carries freezes at publish. These tests pin the shape of
/// every payment lifecycle event: the intent id, the 32-byte commitment the
/// intent was opened with, a status and a timestamp — and, through the
/// test-only unpackers, nothing else. A field added to an event changes an
/// unpacker's return tuple and stops this file compiling, which is the point.
///
/// The commitment is computed off-chain (`lib/evidence/commitment.ts`) as
/// blake2b256(tag || bcs(payload) || salt). Move never sees the payload or the
/// salt; it checks the length and carries the bytes.
#[test_only]
module splash_core::event_privacy_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount, PayoutApproval};
use splash_core::cap_registry;
use splash_core::payment_intent::{Self, PaymentIntent};
use splash_core::receipt_v2;
use std::unit_test::assert_eq;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::event;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const SENDER: address = @0xA11CE;
const RECIPIENT: address = @0xB0B;
const OWNER: address = @0xA11CE;
const APPROVER: address = @0xBEEF;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";

/// Thirty-two bytes, as the off-chain library would produce them.
const COMMITMENT: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
/// Thirty-one bytes: one short.
const SHORT: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddee";
/// Thirty-three bytes: one long.
const LONG: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00";

const AMOUNT: u64 = 1_000;
const DAY: u64 = 86_400_000;
const EXPIRY_WINDOW: u64 = 300_000;

fun new_intent(commitment: vector<u8>, c: &Clock, ctx: &mut TxContext): PaymentIntent {
    payment_intent::create<SUI>(
        RECIPIENT,
        b"counterparty:vendor-001",
        AMOUNT,
        b"USD",
        b"MY-PH",
        b"PHP".to_string(),
        56_000_000,
        commitment,
        c,
        ctx,
    )
}

// ── Length ──────────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 420, location = splash_core::payment_intent)]
/// A 31-byte commitment is refused: Move asserts the length so a truncated
/// or mis-encoded value can never be anchored as if it were a commitment.
fun a_31_byte_commitment_is_refused() {
    let mut scenario = ts::begin(SENDER);
    let ctx = scenario.ctx();
    let c = clock::create_for_testing(ctx);
    let intent = new_intent(SHORT, &c, ctx);
    payment_intent::cancel(intent, ctx);
    c.destroy_for_testing();
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 420, location = splash_core::payment_intent)]
/// A 33-byte commitment is refused for the same reason.
fun a_33_byte_commitment_is_refused() {
    let mut scenario = ts::begin(SENDER);
    let ctx = scenario.ctx();
    let c = clock::create_for_testing(ctx);
    let intent = new_intent(LONG, &c, ctx);
    payment_intent::cancel(intent, ctx);
    c.destroy_for_testing();
    scenario.end();
}

// ── Shape ───────────────────────────────────────────────────────────────────

#[test]
/// Created, confirmed, anchored: every event carries the commitment the intent
/// was opened with, the status the intent is in, and the clock. Nothing about
/// the counterparties, the amount, the currency or the rate leaves the PTB.
fun lifecycle_events_carry_the_commitment_and_nothing_else() {
    let mut scenario = ts::begin(SENDER);
    let ctx = scenario.ctx();
    let mut c = clock::create_for_testing(ctx);
    c.set_for_testing(DAY);

    let mut intent = new_intent(COMMITMENT, &c, ctx);
    assert_eq!(payment_intent::commitment(&intent), COMMITMENT);

    let created = event::events_by_type<payment_intent::IntentCreated>();
    assert_eq!(created.length(), 1);
    let (id, commitment, status, at) = payment_intent::unpack_intent_created_for_testing(created[0]);
    assert_eq!(id, object::id(&intent));
    assert_eq!(commitment, COMMITMENT);
    assert_eq!(status, 0); // STATUS_PENDING
    assert_eq!(at, DAY);

    c.set_for_testing(DAY + 1_000);
    let payment = coin::mint_for_testing<SUI>(AMOUNT, ctx);
    let receipt = payment_intent::confirm_payment_intent(&mut intent, payment, &c, ctx);

    let confirmed = event::events_by_type<payment_intent::IntentConfirmed>();
    assert_eq!(confirmed.length(), 1);
    let (id, commitment, status, at) = payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
    assert_eq!(id, object::id(&intent));
    assert_eq!(commitment, COMMITMENT);
    assert_eq!(status, 1); // STATUS_CONFIRMED
    assert_eq!(at, DAY + 1_000);

    c.set_for_testing(DAY + 2_000);
    audit_anchor::anchor(receipt, HASH, BLOB, &c, ctx);

    let anchored = event::events_by_type<audit_anchor::SettlementAnchored>();
    assert_eq!(anchored.length(), 1);
    let (id, commitment, status, at, content_hash, walrus_blob_id) =
        audit_anchor::unpack_settlement_anchored_for_testing(anchored[0]);
    assert_eq!(id, object::id(&intent));
    assert_eq!(commitment, COMMITMENT);
    assert_eq!(status, 1);
    assert_eq!(at, DAY + 2_000);
    assert_eq!(content_hash, HASH);
    assert_eq!(walrus_blob_id, BLOB);

    payment_intent::delete_finalized(intent);
    c.destroy_for_testing();
    scenario.end();
}

#[test]
/// A cancel by the sender and an expiry by anyone both emit the stored
/// commitment with the status as the reason. The expiry path matters: a
/// stranger who expires an intent holds no salt, so the event can only carry
/// what the intent already holds.
fun cancel_and_expiry_emit_the_stored_commitment() {
    let mut scenario = ts::begin(SENDER);
    let ctx = scenario.ctx();
    let mut c = clock::create_for_testing(ctx);
    c.set_for_testing(DAY);

    let mut cancelled = new_intent(COMMITMENT, &c, ctx);
    payment_intent::cancel_by_sender(&mut cancelled, &c, ctx);
    let events = event::events_by_type<payment_intent::IntentCanceled>();
    assert_eq!(events.length(), 1);
    let (id, commitment, status, at) = payment_intent::unpack_intent_canceled_for_testing(events[0]);
    assert_eq!(id, object::id(&cancelled));
    assert_eq!(commitment, COMMITMENT);
    assert_eq!(status, 3); // STATUS_CANCELED
    assert_eq!(at, DAY);
    payment_intent::delete_finalized(cancelled);

    let mut expired = new_intent(COMMITMENT, &c, ctx);
    c.set_for_testing(DAY + EXPIRY_WINDOW);
    payment_intent::cancel_payment_intent(&mut expired, &c, ctx);
    let events = event::events_by_type<payment_intent::IntentCanceled>();
    assert_eq!(events.length(), 2);
    let (id, commitment, status, at) = payment_intent::unpack_intent_canceled_for_testing(events[1]);
    assert_eq!(id, object::id(&expired));
    assert_eq!(commitment, COMMITMENT);
    assert_eq!(status, 2); // STATUS_EXPIRED
    assert_eq!(at, DAY + EXPIRY_WINDOW);
    payment_intent::delete_finalized(expired);

    c.destroy_for_testing();
    scenario.end();
}

// ── Approvals ───────────────────────────────────────────────────────────────

/// A shared clock, a verified account owned by OWNER with APPROVER approving.
fun account_scenario(): Scenario {
    let mut scenario = ts::begin(OWNER);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(DAY);
        clock::share_for_testing(c);
    };
    scenario.next_tx(OWNER);
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
    scenario.next_tx(OWNER);
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

#[test]
/// The approval and its consumption carry the payment's commitment where the
/// amount used to be. The approver reads the amount off the intent object they
/// are shown; the event stream gets the commitment.
fun approval_events_carry_the_commitment_not_the_amount() {
    let mut scenario = account_scenario();

    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        payment_intent::create_payment_intent_for_account<SUI>(
            &account,
            RECIPIENT,
            AMOUNT,
            b"PHP".to_string(),
            56_000_000,
            COMMITMENT,
            &c,
            ctx,
        );
        ts::return_shared(c);
        ts::return_shared(account);
    };

    scenario.next_tx(APPROVER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let intent = scenario.take_shared<PaymentIntent>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        payment_intent::approve_payout(&intent, &account, &c, ctx);

        let approved = event::events_by_type<business_account::PayoutApproved>();
        assert_eq!(approved.length(), 1);
        let (_approval, account_id, intent_id, approver, maker, commitment, epoch, expires) =
            business_account::unpack_payout_approved_for_testing(approved[0]);
        assert_eq!(account_id, object::id_address(&account));
        assert_eq!(intent_id, object::id(&intent));
        assert_eq!(approver, APPROVER);
        assert_eq!(maker, OWNER);
        assert_eq!(commitment, COMMITMENT);
        assert_eq!(epoch, business_account::authority_epoch(&account));
        assert_eq!(expires, DAY + 900_000);

        ts::return_shared(c);
        ts::return_shared(intent);
        ts::return_shared(account);
    };

    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let mut intent = scenario.take_shared<PaymentIntent>();
        let c = scenario.take_shared<Clock>();
        let approval = scenario.take_from_sender<PayoutApproval>();
        let ctx = scenario.ctx();
        let payment = coin::mint_for_testing<SUI>(AMOUNT, ctx);
        let receipt = payment_intent::confirm_with_approval(&mut intent, &mut account, approval, payment, &c, ctx);
        audit_anchor::anchor(receipt, HASH, BLOB, &c, ctx);

        let consumed = event::events_by_type<business_account::PayoutApprovalConsumed>();
        assert_eq!(consumed.length(), 1);
        let (_approval, account_id, intent_id, approver, commitment, at) =
            business_account::unpack_payout_approval_consumed_for_testing(consumed[0]);
        assert_eq!(account_id, object::id_address(&account));
        assert_eq!(intent_id, object::id(&intent));
        assert_eq!(approver, APPROVER);
        assert_eq!(commitment, COMMITMENT);
        assert_eq!(at, DAY);

        ts::return_shared(c);
        ts::return_shared(intent);
        ts::return_shared(account);
    };
    scenario.end();
}

// ── Receipts ────────────────────────────────────────────────────────────────

#[test]
/// A minted receipt's event carries its commitment, not the counterparties or
/// the amounts, and the minter must supply exactly 32 bytes.
fun receipt_event_carries_a_32_byte_commitment() {
    let mut scenario = ts::begin(SENDER);
    let ctx = scenario.ctx();
    let c = clock::create_for_testing(ctx);
    let registry = cap_registry::new_for_testing(ctx);
    let cap = business_account::anchor_cap_for_testing(ctx);

    receipt_v2::create_receipt(
        &cap,
        &registry,
        b"rcpt-001".to_string(),
        SENDER,
        RECIPIENT,
        AMOUNT,
        b"PHP".to_string(),
        56_000,
        56_000_000,
        COMMITMENT,
        b"digest".to_string(),
        option::none(),
        @0x0,
        &c,
        ctx,
    );
    let issued = event::events_by_type<receipt_v2::ReceiptIssued>();
    assert_eq!(issued.length(), 1);
    let (_object, receipt_id, commitment, _settled_at, tx_digest, _account, minter) =
        receipt_v2::unpack_receipt_issued_for_testing(issued[0]);
    assert_eq!(receipt_id, b"rcpt-001".to_string());
    assert_eq!(commitment, COMMITMENT);
    assert_eq!(tx_digest, b"digest".to_string());
    assert_eq!(minter, SENDER);

    business_account::destroy_anchor_cap(cap);
    cap_registry::share_for_testing(registry);
    c.destroy_for_testing();
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 804, location = splash_core::receipt_v2)]
fun a_receipt_with_a_31_byte_commitment_is_refused() {
    let mut scenario = ts::begin(SENDER);
    let ctx = scenario.ctx();
    let c = clock::create_for_testing(ctx);
    let registry = cap_registry::new_for_testing(ctx);
    let cap = business_account::anchor_cap_for_testing(ctx);

    receipt_v2::create_receipt(
        &cap,
        &registry,
        b"rcpt-001".to_string(),
        SENDER,
        RECIPIENT,
        AMOUNT,
        b"PHP".to_string(),
        56_000,
        56_000_000,
        SHORT,
        b"digest".to_string(),
        option::none(),
        @0x0,
        &c,
        ctx,
    );

    business_account::destroy_anchor_cap(cap);
    cap_registry::share_for_testing(registry);
    c.destroy_for_testing();
    scenario.end();
}

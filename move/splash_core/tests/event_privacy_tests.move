/// WS5 — event privacy before publish.
///
/// What an event carries freezes at publish. These tests pin the shape of
/// every payment lifecycle event: the intent id, the 32-byte commitment the
/// intent was opened with, the v2 rail commitment, settlement asset and kind,
/// a status and a timestamp — and, through the test-only unpackers, nothing
/// else. A field added to an event changes an unpacker's return tuple and
/// stops this file compiling, which is the point.
///
/// The commitment is computed off-chain (`lib/evidence/commitment.ts`) as
/// blake2b256(tag || bcs(payload) || salt). Move never sees the payload or the
/// salt; it checks the length and carries the bytes.
#[test_only]
module splash_core::event_privacy_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::cap_registry;
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::payment_intent::{Self, PaymentIntent};
use splash_core::receipt_v2;
use splash_core::v2_harness::{Self as h, USDC};
use std::unit_test::assert_eq;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::event;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const SENDER: address = @0xA11CE;
const RECIPIENT: address = @0xB0B;

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
/// The rail commitment (`splash:rail:v1`): thirty-two bytes, opaque to Move.
const RAIL_COMMITMENT: vector<u8> = x"ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

/// The wallet opens a bank payout carrying `commitment`.
fun wallet_intent_with(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    commitment: vector<u8>,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    payment_intent::create_for_wallet<USDC>(
        account,
        config,
        h::payment_ref(n),
        RECIPIENT,
        h::beneficiary(),
        h::amount(),
        b"PHP".to_string(),
        56_000_000,
        commitment,
        payment_intent::kind_bank_payout(),
        RAIL_COMMITMENT,
        c.timestamp_ms() + EXPIRY_WINDOW,
        c,
        ctx,
    )
}

/// Run `$body` as the wallet with the shared account, config and clock.
macro fun as_wallet($s: &mut Scenario, $body: |&mut BusinessAccount, &ComplianceConfig, &mut Clock, &mut TxContext|) {
    let s = $s;
    s.next_tx(h::wallet());
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let mut c = s.take_shared<Clock>();
    $body(&mut account, &config, &mut c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
}

// ── Length ──────────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 420, location = splash_core::payment_intent)]
/// A 31-byte commitment is refused: Move asserts the length so a truncated
/// or mis-encoded value can never be anchored as if it were a commitment.
fun a_31_byte_commitment_is_refused() {
    let mut s = h::setup();
    as_wallet!(&mut s, |account, config, c, ctx| {
        let intent = wallet_intent_with(account, config, 1, SHORT, c, ctx);
        payment_intent::cancel(intent, c, ctx);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = 420, location = splash_core::payment_intent)]
/// A 33-byte commitment is refused for the same reason.
fun a_33_byte_commitment_is_refused() {
    let mut s = h::setup();
    as_wallet!(&mut s, |account, config, c, ctx| {
        let intent = wallet_intent_with(account, config, 1, LONG, c, ctx);
        payment_intent::cancel(intent, c, ctx);
    });
    s.end();
}

// ── Shape ───────────────────────────────────────────────────────────────────

#[test]
/// Created, confirmed, anchored: every event carries the commitment the intent
/// was opened with, the status the intent is in, and the clock. Nothing about
/// the counterparties, the amount or the rate leaves the PTB; the settlement
/// asset's type name and the kind are the deliberate v2 additions.
fun lifecycle_events_carry_the_commitment_and_nothing_else() {
    let mut s = h::setup();
    as_wallet!(&mut s, |account, config, c, ctx| {
        let mut intent = wallet_intent_with(account, config, 1, COMMITMENT, c, ctx);
        assert_eq!(payment_intent::commitment(&intent), COMMITMENT);

        let created = event::events_by_type<payment_intent::IntentCreated>();
        assert_eq!(created.length(), 1);
        let (id, commitment, rail, asset, kind, status, expires_at, at) =
            payment_intent::unpack_intent_created_for_testing(created[0]);
        assert_eq!(id, object::id(&intent));
        assert_eq!(commitment, COMMITMENT);
        assert_eq!(rail, RAIL_COMMITMENT);
        assert_eq!(asset, compliance_config::type_string<USDC>());
        assert_eq!(kind, payment_intent::kind_bank_payout());
        assert_eq!(status, 0); // STATUS_PENDING
        assert_eq!(expires_at, DAY + EXPIRY_WINDOW);
        assert_eq!(at, DAY);

        c.set_for_testing(DAY + 1_000);
        let payment = h::usdc(h::amount(), ctx);
        let receipt = h::confirm(
            &mut intent, account, config, payment, DAY + EXPIRY_WINDOW, c, ctx,
        );

        let confirmed = event::events_by_type<payment_intent::IntentConfirmed>();
        assert_eq!(confirmed.length(), 1);
        let (id, commitment, rail, asset, kind, status, path, at) =
            payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
        assert_eq!(id, object::id(&intent));
        assert_eq!(commitment, COMMITMENT);
        assert_eq!(rail, RAIL_COMMITMENT);
        assert_eq!(asset, compliance_config::type_string<USDC>());
        assert_eq!(kind, payment_intent::kind_bank_payout());
        assert_eq!(status, 1); // STATUS_CONFIRMED
        assert_eq!(path, payment_intent::path_business_wallet());
        assert_eq!(at, DAY + 1_000);

        c.set_for_testing(DAY + 2_000);
        audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);

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
    });
    s.end();
}

#[test]
/// A cancel by the maker and an expiry by anyone both emit the stored
/// commitment with the status as the reason. The expiry path matters: a
/// stranger who expires an intent holds no salt, so the event can only carry
/// what the intent already holds.
fun cancel_and_expiry_emit_the_stored_commitment() {
    let mut s = h::setup();
    as_wallet!(&mut s, |account, config, c, ctx| {
        let mut cancelled = wallet_intent_with(account, config, 1, COMMITMENT, c, ctx);
        payment_intent::cancel_by_sender(&mut cancelled, c, ctx);
        let events = event::events_by_type<payment_intent::IntentCanceled>();
        assert_eq!(events.length(), 1);
        let (id, commitment, rail, _asset, _kind, status, at) =
            payment_intent::unpack_intent_canceled_for_testing(events[0]);
        assert_eq!(id, object::id(&cancelled));
        assert_eq!(commitment, COMMITMENT);
        assert_eq!(rail, RAIL_COMMITMENT);
        assert_eq!(status, 3); // STATUS_CANCELED
        assert_eq!(at, DAY);
        payment_intent::delete_finalized(cancelled);

        let mut expired = wallet_intent_with(account, config, 2, COMMITMENT, c, ctx);
        c.set_for_testing(DAY + EXPIRY_WINDOW);
        payment_intent::cancel_payment_intent(&mut expired, c, ctx);
        let events = event::events_by_type<payment_intent::IntentCanceled>();
        assert_eq!(events.length(), 2);
        let (id, commitment, rail, _asset, _kind, status, at) =
            payment_intent::unpack_intent_canceled_for_testing(events[1]);
        assert_eq!(id, object::id(&expired));
        assert_eq!(commitment, COMMITMENT);
        assert_eq!(rail, RAIL_COMMITMENT);
        assert_eq!(status, 2); // STATUS_EXPIRED
        assert_eq!(at, DAY + EXPIRY_WINDOW);
        payment_intent::delete_finalized(expired);
    });
    s.end();
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

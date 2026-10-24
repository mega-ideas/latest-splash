/// splash_core invariant tests.
///
/// These could not exist before the package split: splash_core depended on
/// DeepBook, and the pinned DeepBook rev ships test files that fail to compile
/// against this toolchain, aborting the whole test build before our modules were
/// reached. That is why this repository had 93 lines of Move tests against 16 TS
/// suites. Moving the liquidity guard to splash_custody (where the pooled funds
/// it protects actually live) removed the dependency and unblocked this suite.
///
/// The properties pinned here are the ones the regulatory claim rests on:
/// no receipt without a consumed coin, exactly one receipt consumer, exact
/// refunds, and caps that cannot do each other's jobs.
#[test_only]
module splash_core::core_invariants_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::cap_registry;
use splash_core::compliance_config::ComplianceConfig;
use splash_core::payment_intent;
use splash_core::v2_harness::{Self as h, USDC};
use std::unit_test::assert_eq;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario;

/// A second coin type, used to prove an intent cannot be settled in the wrong
/// asset. Deliberately worthless — that is the whole point.
public struct SCAM has drop {}

const SENDER: address = @0xA11CE;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";

// ── M1: no receipt without a consumed coin ─────────────────────────────────
//
// v2: these properties ran on the unbound path, which is no longer in the
// package (docs/v2/phase1-move-design.md). They are pinned here on the path
// that replaced it for a business's own payments: the business wallet's.

#[test]
/// M1. `create` used to return `(PaymentIntent, SettleReceipt)`, minting the
/// receipt with `settled_at: now` while no `Coin` appeared anywhere in the
/// function. The type asserted a settlement that had not happened, and
/// `audit_anchor` would then anchor that assertion on chain as proof of payment.
///
/// That this test COMPILES is half the assertion: `create_for_wallet` returns
/// exactly one value. Reinstating a receipt mint stops this file building.
fun create_returns_intent_only_and_settles_nothing() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let intent = h::wallet_intent(&mut account, &config, 1, h::amount(), &c, s.ctx());

        assert_eq!(payment_intent::sender(&intent), h::wallet());
        assert_eq!(payment_intent::recipient(&intent), h::recipient());
        assert_eq!(payment_intent::amount_usd(&intent), h::amount());
        // STATUS_PENDING — creating an intent settles nothing.
        assert_eq!(payment_intent::status(&intent), 0);

        payment_intent::cancel(intent, &c, s.ctx());
        test_scenario::return_shared(c);
        test_scenario::return_shared(config);
        test_scenario::return_shared(account);
    };
    s.end();
}

/// Open a bank payout from the wallet and pay it with `paid` units, anchoring
/// the receipt, in one transaction.
fun pay_from_wallet<T>(s: &mut test_scenario::Scenario, paid: u64, hash: vector<u8>, blob: vector<u8>) {
    s.next_tx(h::wallet());
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let ctx = s.ctx();
    let mut intent = h::wallet_intent(&mut account, &config, 1, h::amount(), &c, ctx);
    let payment = coin::mint_for_testing<T>(paid, ctx);
    let receipt = h::confirm(
        &mut intent,
        &mut account,
        &config,
        payment,
        h::settle_by(&c),
        &c,
        ctx,
    );
    assert_eq!(payment_intent::status(&intent), 1); // STATUS_CONFIRMED
    // The ONLY way to dispose of a receipt.
    audit_anchor::anchor(receipt, hash, blob, &c, ctx);
    payment_intent::delete_finalized(intent);
    test_scenario::return_shared(c);
    test_scenario::return_shared(config);
    test_scenario::return_shared(account);
}

#[test]
/// A receipt exists only where a coin was consumed, and the receipt is a hot
/// potato — no `drop`, no `store`, no `key` — so the PTB must anchor it or
/// abort. "Every settlement is anchored" is enforced by the type system.
fun receipt_requires_a_consumed_coin_and_must_be_anchored() {
    let mut s = h::setup();
    pay_from_wallet<USDC>(&mut s, h::amount(), HASH, BLOB);
    s.end();
}

#[test]
#[expected_failure(abort_code = 402, location = splash_core::payment_intent)]
/// Underpayment aborts — no receipt can be minted for less than the intent.
fun underpayment_aborts() {
    let mut s = h::setup();
    pay_from_wallet<USDC>(&mut s, h::amount() - 1, HASH, BLOB);
    s.end();
}

#[test]
/// Overpay goes back EXACTLY: the recipient gets the intent amount and not a
/// unit more, the change lands in the wallet's address balance (where a
/// business wallet keeps its funds, D1), and nothing is stranded in the module.
/// H-03.
fun overpayment_refunded_exactly() {
    let mut s = h::setup();
    pay_from_wallet<USDC>(&mut s, h::amount() + 500, HASH, BLOB);

    s.next_tx(h::recipient());
    {
        let paid = s.take_from_sender<Coin<USDC>>();
        assert_eq!(coin::value(&paid), h::amount());
        s.return_to_sender(paid);
    };
    assert_eq!(test_scenario::settled_balance<USDC>(h::wallet()), 500);
    s.end();
}

#[test]
/// Exact payment leaves no change at all: `destroy_zero` on a provably zero
/// coin, so neither a dust object nor a zero credit is created.
fun exact_payment_creates_no_refund() {
    let mut s = h::setup();
    pay_from_wallet<USDC>(&mut s, h::amount(), HASH, BLOB);
    s.next_tx(h::recipient());
    {
        let paid = s.take_from_sender<Coin<USDC>>();
        assert_eq!(coin::value(&paid), h::amount());
        s.return_to_sender(paid);
    };
    assert_eq!(test_scenario::settled_balance<USDC>(h::wallet()), 0);
    s.next_tx(h::wallet());
    assert!(!test_scenario::has_most_recent_for_sender<Coin<USDC>>(&s));
    s.end();
}

#[test]
#[expected_failure(abort_code = 50, location = splash_core::business_account)]
/// Only the account's wallet may pay from the wallet path (H-02). A third party
/// holding the shared intent cannot push it through, even with its own coin.
fun third_party_cannot_confirm() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let intent = h::wallet_intent(&mut account, &config, 1, h::amount(), &c, s.ctx());
        payment_intent::share_intent(intent);
        test_scenario::return_shared(c);
        test_scenario::return_shared(config);
        test_scenario::return_shared(account);
    };
    s.next_tx(@0xBADBAD);
    {
        let mut account = s.take_shared<BusinessAccount>();
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let mut intent = s.take_shared<payment_intent::PaymentIntent>();
        let ctx = s.ctx();
        let payment = coin::mint_for_testing<USDC>(h::amount(), ctx);
        let receipt = h::confirm(
            &mut intent, &mut account, &config, payment, h::settle_by(&c), &c, ctx,
        );
        audit_anchor::anchor(receipt, HASH, BLOB, &c, ctx);
        test_scenario::return_shared(intent);
        test_scenario::return_shared(c);
        test_scenario::return_shared(config);
        test_scenario::return_shared(account);
    };
    s.end();
}

// ── Anchor validation ──────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 500, location = splash_core::audit_anchor)]
/// An anchor with no content hash is not evidence of anything.
fun anchor_rejects_empty_digest() {
    let mut s = h::setup();
    pay_from_wallet<USDC>(&mut s, h::amount(), b"", BLOB);
    s.end();
}

#[test]
#[expected_failure(abort_code = 502, location = splash_core::audit_anchor)]
/// An anchor pointing at no blob cannot be verified off chain.
fun anchor_rejects_empty_blob() {
    let mut s = h::setup();
    pay_from_wallet<USDC>(&mut s, h::amount(), HASH, b"");
    s.end();
}

#[test]
#[expected_failure(abort_code = 414, location = splash_core::payment_intent)]
/// An intent opened in USDC cannot be discharged with a different coin type.
///
/// This is why every settle path binds the asset rather than just being
/// generic. The only amount check is `coin::value(&payment) >= amount_usd`, and
/// unit counts mean nothing across assets — so an unbound generic would let a
/// payer settle a 100 USDC obligation with 100 units of a worthless token and
/// the recipient would receive exactly that.
fun intent_cannot_be_settled_in_the_wrong_asset() {
    let mut s = h::setup();
    pay_from_wallet<SCAM>(&mut s, 1_000_000_000_000, HASH, BLOB);
    s.end();
}

#[test]
/// The asset the intent records is the asset it settles in, and it is readable
/// on chain so an auditor can confirm the denomination without guessing.
fun settlement_asset_is_recorded_and_matches() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let intent = h::wallet_intent(&mut account, &config, 1, h::amount(), &c, s.ctx());
        assert_eq!(
            *payment_intent::settlement_asset(&intent),
            splash_core::compliance_config::type_string<USDC>(),
        );
        payment_intent::cancel(intent, &c, s.ctx());
        test_scenario::return_shared(c);
        test_scenario::return_shared(config);
        test_scenario::return_shared(account);
    };
    s.end();
}

#[test]
/// Verification is reversible. Without this, an account verified on mainnet is
/// verified forever — `verify_business` asserts `!is_verified` and the package
/// is IMMUTABLE, so a lapsed or hostile business could never be un-verified.
fun verification_can_be_revoked_and_regranted() {
    let mut scenario = test_scenario::begin(SENDER);
    {
        let ctx = scenario.ctx();
        let c = clock::create_for_testing(ctx);
        business_account::submit_application(
            b"SSM-202401012345".to_string(),
            b"bafy-kyb-cid".to_string(),
            &c,
            ctx,
        );
        c.destroy_for_testing();
    };
    scenario.next_tx(SENDER);
    {
        let mut account = scenario.take_shared<business_account::BusinessAccount>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);

        business_account::verify_business(&admin, &mut account, 20);
        assert_eq!(business_account::is_verified(&account), true);

        business_account::revoke_verification(&admin, &mut account, ctx);
        assert_eq!(business_account::is_verified(&account), false);
        // The stale score goes too — leaving it invites a later reader to treat
        // an unverified account as still assessed.
        assert_eq!(business_account::risk_score(&account), 0);

        // And the account can be re-verified after remediation.
        business_account::verify_business(&admin, &mut account, 35);
        assert_eq!(business_account::is_verified(&account), true);
        assert_eq!(business_account::risk_score(&account), 35);

        business_account::destroy_admin_cap_for_testing(admin);
        test_scenario::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 5, location = splash_core::business_account)]
/// Revoking an account that was never verified is a no-op that should fail
/// loudly rather than silently emit a BusinessUnverified event for nothing.
fun revoking_an_unverified_account_aborts() {
    let mut scenario = test_scenario::begin(SENDER);
    {
        let ctx = scenario.ctx();
        let c = clock::create_for_testing(ctx);
        business_account::submit_application(b"SSM-1".to_string(), b"cid".to_string(), &c, ctx);
        c.destroy_for_testing();
    };
    scenario.next_tx(SENDER);
    {
        let mut account = scenario.take_shared<business_account::BusinessAccount>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::revoke_verification(&admin, &mut account, ctx);
        business_account::destroy_admin_cap_for_testing(admin);
        test_scenario::return_shared(account);
    };
    scenario.end();
}

// ── Capability separation (S-10) ───────────────────────────────────────────

#[test]
/// AnchorCap can attest. It cannot move value — and that is enforced by the
/// type system, not by this test: splash_core contains no function that takes
/// an AnchorCap and moves a Coin. There is nothing here to call.
fun anchor_cap_attests_but_moves_no_money() {
    let mut scenario = test_scenario::begin(SENDER);
    let ctx = scenario.ctx();
    let mut c = clock::create_for_testing(ctx);
    c.set_for_testing(1_000_000);

    let cap = business_account::anchor_cap_for_testing(ctx);
    let registry = cap_registry::new_for_testing(ctx);
    audit_anchor::anchor_audit_hash(
        &cap,
        &registry,
        b"audit-hash".to_string(),
        b"anchor-001".to_string(),
        b"walrus-blob".to_string(),
        @0x0,
        &c,
        ctx,
    );
    business_account::destroy_anchor_cap(cap);
    cap_registry::share_for_testing(registry);
    c.destroy_for_testing();
    scenario.end();
}

#[test]
/// A business is unverified until an AdminCap says otherwise. `submit_application`
/// is permissionless (anyone may apply); verification is not.
fun business_is_unverified_until_admin_verifies() {
    let mut scenario = test_scenario::begin(SENDER);
    {
        let ctx = scenario.ctx();
        let c = clock::create_for_testing(ctx);
        business_account::submit_application(
            b"SSM-202401012345".to_string(),
            b"bafy-kyb-cid".to_string(),
            &c,
            ctx,
        );
        c.destroy_for_testing();
    };

    scenario.next_tx(SENDER);
    {
        let mut account = scenario.take_shared<business_account::BusinessAccount>();
        assert_eq!(business_account::is_verified(&account), false);
        assert_eq!(business_account::owner(&account), SENDER);
        // The founder is an owner, and the only one. No business wallet yet,
        // so nothing can be paid from the account until the owners register one.
        assert_eq!(business_account::is_owner(&account, SENDER), true);
        assert_eq!(business_account::owners(&account), vector[SENDER]);
        assert_eq!(business_account::has_wallet(&account), false);

        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::verify_business(&admin, &mut account, 20);
        assert_eq!(business_account::is_verified(&account), true);
        assert_eq!(business_account::risk_score(&account), 20);

        business_account::destroy_admin_cap_for_testing(admin);
        test_scenario::return_shared(account);
    };
    scenario.end();
}

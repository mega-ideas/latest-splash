/// Phase 6 authority tests.
///
/// Every property here is one the product claims in words on the landing page
/// or in the compliance pack — four eyes, revocable access, a stopped account
/// stops, a daily ceiling — and every one of them was previously enforced only
/// by a server the tenant does not control. These tests are the difference
/// between the claim and the control.
#[test_only]
module splash_core::authority_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount, PayoutApproval};
use splash_core::payment_intent::{Self, PaymentIntent};
use std::unit_test::assert_eq;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const OWNER: address = @0xA11CE;
const OWNER2: address = @0xF00D;
const APPROVER: address = @0xBEEF;
const OUTSIDER: address = @0xDEAD;
const RECIPIENT: address = @0xB0B;
const RESCUER: address = @0xCAFE;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";
/// A 32-byte commitment, as lib/evidence/commitment.ts computes it off-chain.
const COMMITMENT: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

const AMOUNT: u64 = 1_000;
const HOUR: u64 = 3_600_000;
const DAY: u64 = 86_400_000;

// ─── Harness ───────────────────────────────────────────────────────────────

/// A shared clock at t=0, a shared account owned by OWNER, verified, with
/// APPROVER in the approver set. This is the state every test starts from.
fun setup(): Scenario {
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

/// Open an account-bound intent for `AMOUNT`, as `maker`.
fun open_intent(scenario: &mut Scenario, maker: address, amount: u64) {
    scenario.next_tx(maker);
    let account = scenario.take_shared<BusinessAccount>();
    let c = scenario.take_shared<Clock>();
    let ctx = scenario.ctx();
    payment_intent::create_payment_intent_for_account<SUI>(
        &account,
        RECIPIENT,
        amount,
        b"PHP".to_string(),
        56_000_000,
        COMMITMENT,
        &c,
        ctx,
    );
    ts::return_shared(c);
    ts::return_shared(account);
}

/// `approver` approves the live intent. The maker and the amount are read off
/// the intent, so there is nothing for a caller to get wrong.
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

/// `maker` settles the live intent with the approval they hold.
fun settle(scenario: &mut Scenario, maker: address, amount: u64) {
    scenario.next_tx(maker);
    let mut account = scenario.take_shared<BusinessAccount>();
    let mut intent = scenario.take_shared<PaymentIntent>();
    let c = scenario.take_shared<Clock>();
    let approval = scenario.take_from_sender<PayoutApproval>();
    let ctx = scenario.ctx();

    let payment = coin::mint_for_testing<SUI>(amount, ctx);
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
    scenario.next_tx(OWNER);
    let mut c = scenario.take_shared<Clock>();
    c.increment_for_testing(by_ms);
    ts::return_shared(c);
}

// ─── The happy path, so the failures below mean something ──────────────────

#[test]
/// Maker opens, a different person approves, maker settles. If this did not
/// pass, every abort test below would pass for the wrong reason.
fun a_maker_and_a_separate_approver_can_move_money() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, AMOUNT);

    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let intent = scenario.take_shared<PaymentIntent>();
        let c = scenario.take_shared<Clock>();
        assert_eq!(payment_intent::status(&intent), 1); // CONFIRMED
        // The payout was metered against the account's own 24h ceiling.
        assert_eq!(business_account::daily_spent(&account, &c), AMOUNT);
        assert_eq!(
            business_account::daily_remaining(&account, &c),
            business_account::default_daily_cap_minor() - AMOUNT,
        );
        ts::return_shared(c);
        ts::return_shared(intent);
        ts::return_shared(account);
    };
    scenario.end();
}

// ─── Four eyes ─────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 29, location = splash_core::business_account)]
/// An approver cannot approve a payment they initiated. The rule is asserted on
/// chain, not in the console — a compromised maker key that also holds approver
/// rights is the single most likely path to an unauthorised payout.
fun an_approver_cannot_release_their_own_payment() {
    let mut scenario = setup();
    // Make APPROVER an owner too, so they are allowed to open an intent.
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::add_owner(&mut account, APPROVER, ctx);
        ts::return_shared(account);
    };
    open_intent(&mut scenario, APPROVER, AMOUNT);
    approve(&mut scenario, APPROVER);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 21, location = splash_core::business_account)]
/// Being an owner does not make you an approver. Separation of duties is a set
/// membership question, not a seniority one.
fun an_owner_who_is_not_an_approver_cannot_approve() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    // OWNER2 is added as an owner but never as an approver.
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::add_owner(&mut account, OWNER2, ctx);
        ts::return_shared(account);
    };
    approve(&mut scenario, OWNER2);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 21, location = splash_core::business_account)]
fun a_stranger_cannot_approve() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, OUTSIDER);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 418, location = splash_core::payment_intent)]
fun a_stranger_cannot_open_an_intent_in_a_tenants_name() {
    let mut scenario = setup();
    open_intent(&mut scenario, OUTSIDER, AMOUNT);
    scenario.end();
}

// ─── Revocation kills work in flight ───────────────────────────────────────

#[test]
#[expected_failure(abort_code = 30, location = splash_core::business_account)]
/// The headline property. An approval already sitting in the maker's wallet
/// dies the moment the approver is removed — the object still exists and is
/// still well-formed, and it is worthless.
fun revoking_an_approver_kills_an_approval_already_in_flight() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, APPROVER);

    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::remove_approver(&mut account, APPROVER, ctx);
        ts::return_shared(account);
    };

    settle(&mut scenario, OWNER, AMOUNT);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 30, location = splash_core::business_account)]
/// And re-granting does not resurrect it.
///
/// This is the case a "is this address currently an approver?" check gets
/// wrong, and it is not hypothetical: revoke-then-regrant is what happens when
/// someone's laptop is replaced, or when an admin removes the wrong row and
/// puts it back. The epoch counter is why it fails — the second change bumps
/// again, so the approval's captured epoch matches neither the before nor the
/// after.
fun revoke_then_regrant_does_not_resurrect_the_approval() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, APPROVER);

    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::remove_approver(&mut account, APPROVER, ctx);
        business_account::add_approver(&mut account, APPROVER, ctx);
        // The approver IS current again. The approval still must not work.
        assert_eq!(business_account::is_approver(&account, APPROVER), true);
        ts::return_shared(account);
    };

    settle(&mut scenario, OWNER, AMOUNT);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 30, location = splash_core::business_account)]
/// An UNRELATED membership change also kills it. Fail-closed and documented:
/// approvals live minutes, and a scheme that tried to decide which changes
/// were "relevant" would be a scheme with an exception list.
fun any_authority_change_kills_an_approval_in_flight() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, APPROVER);

    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::add_owner(&mut account, OWNER2, ctx);
        ts::return_shared(account);
    };

    settle(&mut scenario, OWNER, AMOUNT);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 30, location = splash_core::business_account)]
/// Withdrawing KYB kills approvals too, rather than letting one settle after
/// the account stopped being verified.
fun revoking_verification_kills_an_approval_in_flight() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, APPROVER);

    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::revoke_verification(&admin, &mut account, ctx);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };

    settle(&mut scenario, OWNER, AMOUNT);
    scenario.end();
}

// ─── The approval binds to one payment ─────────────────────────────────────

#[test]
/// The approval's amount is DERIVED from the intent, not supplied alongside
/// it. This is the stronger form of what used to be an equality check: an
/// approver cannot be handed a transaction that approves one invoice while
/// naming another's amount, because the amount is not an argument.
///
/// `consume_approval` still asserts the two match. That assert is now
/// unreachable from outside the package — which is why there is no test that
/// trips it — and it stays as the thing that would catch a future caller of
/// `mint_approval` that does not read from an intent.
fun the_approved_amount_is_read_off_the_intent() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, APPROVER);

    scenario.next_tx(OWNER);
    {
        let intent = scenario.take_shared<PaymentIntent>();
        let approval = scenario.take_from_sender<PayoutApproval>();
        assert_eq!(business_account::approval_amount(&approval), AMOUNT);
        assert_eq!(business_account::approval_intent(&approval), object::id(&intent));
        scenario.return_to_sender(approval);
        ts::return_shared(intent);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 400, location = splash_core::payment_intent)]
/// Approving an intent the maker already cancelled mints authority that can
/// never be used. Refusing is better than leaving a live-looking approval in
/// someone's wallet.
fun a_cancelled_intent_cannot_be_approved() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    scenario.next_tx(OWNER);
    {
        let mut intent = scenario.take_shared<PaymentIntent>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        payment_intent::cancel_by_sender(&mut intent, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(intent);
    };
    approve(&mut scenario, APPROVER);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 415, location = splash_core::payment_intent)]
/// The bypass that would have made all of this decoration. An account-bound
/// intent cannot be settled through the unapproved path.
fun a_bound_intent_cannot_be_settled_without_an_approval() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);

    scenario.next_tx(OWNER);
    {
        let mut intent = scenario.take_shared<PaymentIntent>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        let payment = coin::mint_for_testing<SUI>(AMOUNT, ctx);
        let receipt = payment_intent::confirm_payment_intent(&mut intent, payment, &c, ctx);
        audit_anchor::anchor(receipt, HASH, BLOB, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(intent);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 32, location = splash_core::business_account)]
fun an_expired_approval_cannot_release_anything() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, APPROVER);
    // Past the approval TTL. The intent's own five-minute window is shorter,
    // so this proves the backstop rather than the intent expiry: the intent is
    // checked after the approval, inside `settle`.
    advance(&mut scenario, business_account::approval_ttl_ms() + 1);
    settle(&mut scenario, OWNER, AMOUNT);
    scenario.end();
}

// ─── Freeze ────────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 22, location = splash_core::business_account)]
fun a_frozen_account_cannot_be_approved_from() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::freeze_account(&mut account, ctx);
        ts::return_shared(account);
    };
    approve(&mut scenario, APPROVER);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 30, location = splash_core::business_account)]
/// Frozen after the approval was minted. A stop that only stopped payments
/// nobody had queued would not be a stop.
///
/// It aborts STALE (30) rather than FROZEN (22), and that is worth stating
/// because it looks like the wrong code: freezing bumps the authority epoch,
/// so the approval is already dead by the time the freeze flags are read. The
/// freeze assert in `consume_approval` is therefore a backstop for a future
/// path that forgets to bump, not the thing doing the work here. What matters
/// to the tenant is that the payment does not settle, and it does not.
fun freezing_after_approval_still_stops_the_payment() {
    let mut scenario = setup();
    open_intent(&mut scenario, OWNER, AMOUNT);
    approve(&mut scenario, APPROVER);
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::admin_freeze(&admin, &mut account, ctx);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    settle(&mut scenario, OWNER, AMOUNT);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 23, location = splash_core::business_account)]
/// An owner cannot lift a compliance freeze by lifting their own. Two flags,
/// two authorities — if it were one flag, a frozen tenant would simply unfreeze
/// itself.
fun an_owner_cannot_lift_a_compliance_freeze() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::admin_freeze(&admin, &mut account, ctx);
        business_account::destroy_admin_cap_for_testing(admin);
        assert_eq!(business_account::is_frozen(&account), true);
        // `frozen` (the owner flag) was never set, so this aborts with
        // E_NOT_FROZEN rather than silently clearing the admin one.
        business_account::unfreeze_account(&mut account, ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 22, location = splash_core::business_account)]
/// Membership cannot change while stopped. Otherwise an owner watching a
/// compliance freeze land could line up a fresh approver for the thaw.
fun membership_cannot_change_while_frozen() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::freeze_account(&mut account, ctx);
        business_account::add_approver(&mut account, OUTSIDER, ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
/// But REMOVING an approver still works while frozen. Stripping authority is
/// always safe, and a freeze is exactly when you most want to.
fun an_approver_can_be_removed_while_frozen() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::freeze_account(&mut account, ctx);
        business_account::remove_approver(&mut account, APPROVER, ctx);
        assert_eq!(business_account::is_approver(&account, APPROVER), false);
        ts::return_shared(account);
    };
    scenario.end();
}

// ─── Membership ────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 20, location = splash_core::business_account)]
fun a_stranger_cannot_add_themselves_as_an_owner() {
    let mut scenario = setup();
    scenario.next_tx(OUTSIDER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::add_owner(&mut account, OUTSIDER, ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 24, location = splash_core::business_account)]
/// The last owner cannot remove themselves. An account with no owners has no
/// path back, and `recovery_party` is optional.
fun the_last_owner_cannot_be_removed() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::remove_owner(&mut account, OWNER, ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 20, location = splash_core::business_account)]
/// A co-owner cannot expel the founder.
///
/// This is the difference between a compromised co-owner key being a nuisance
/// and being a complete takeover: remove every other owner, add two addresses
/// you control as approvers, and four eyes is satisfied by two halves of the
/// same person.
fun a_co_owner_cannot_remove_the_founder() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::add_owner(&mut account, OWNER2, ctx);
        ts::return_shared(account);
    };
    scenario.next_tx(OWNER2);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::remove_owner(&mut account, OWNER, ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
/// Co-owners can still be removed by each other, and the founder can still
/// leave under their own signature. The rule pins one address, not the whole
/// membership model.
fun co_owners_remain_removable_and_the_founder_can_leave() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::add_owner(&mut account, OWNER2, ctx);
        business_account::add_owner(&mut account, APPROVER, ctx);
        ts::return_shared(account);
    };
    scenario.next_tx(OWNER2);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        // One co-owner removes another.
        business_account::remove_owner(&mut account, APPROVER, ctx);
        assert_eq!(business_account::is_owner(&account, APPROVER), false);
        ts::return_shared(account);
    };
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        // And the founder resigns under their own signature.
        business_account::remove_owner(&mut account, OWNER, ctx);
        assert_eq!(business_account::is_owner(&account, OWNER), false);
        assert_eq!(business_account::is_owner(&account, OWNER2), true);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
/// Every authority change bumps the epoch. This is the invariant the whole
/// revocation story rests on, so it is asserted directly rather than only
/// through its consequences.
fun every_authority_change_bumps_the_epoch() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        // setup() already did one add_approver.
        let start = business_account::authority_epoch(&account);

        business_account::add_owner(&mut account, OWNER2, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 1);

        business_account::remove_owner(&mut account, OWNER2, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 2);

        business_account::add_approver(&mut account, OUTSIDER, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 3);

        business_account::remove_approver(&mut account, OUTSIDER, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 4);

        business_account::freeze_account(&mut account, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 5);

        business_account::unfreeze_account(&mut account, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 6);

        ts::return_shared(account);
    };
    scenario.end();
}

// ─── Recovery ──────────────────────────────────────────────────────────────

fun nominate_rescuer(scenario: &mut Scenario) {
    scenario.next_tx(OWNER);
    let mut account = scenario.take_shared<BusinessAccount>();
    let ctx = scenario.ctx();
    business_account::set_recovery_party(&mut account, RESCUER, ctx);
    ts::return_shared(account);
}

#[test]
#[expected_failure(abort_code = 35, location = splash_core::business_account)]
/// A recovery party drawn from the existing owners is not a recovery path, it
/// is a second copy of the same failure.
fun the_recovery_party_cannot_be_an_insider() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::set_recovery_party(&mut account, APPROVER, ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 27, location = splash_core::business_account)]
fun only_the_recovery_party_can_request_recovery() {
    let mut scenario = setup();
    nominate_rescuer(&mut scenario);
    scenario.next_tx(OUTSIDER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::request_recovery(&mut account, OUTSIDER, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 40, location = splash_core::business_account)]
/// The 72-hour notice is real. A recovery party who can execute immediately is
/// just a second owner nobody voted for.
fun recovery_cannot_execute_before_the_notice_expires() {
    let mut scenario = setup();
    nominate_rescuer(&mut scenario);
    scenario.next_tx(RESCUER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::request_recovery(&mut account, RESCUER, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    advance(&mut scenario, business_account::recovery_delay_ms() - 1);
    scenario.next_tx(RESCUER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::execute_recovery(&mut account, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 39, location = splash_core::business_account)]
/// An owner cancelling is what makes the notice a defence rather than a
/// countdown.
fun an_owner_can_cancel_a_hostile_recovery() {
    let mut scenario = setup();
    nominate_rescuer(&mut scenario);
    scenario.next_tx(RESCUER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::request_recovery(&mut account, RESCUER, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::cancel_recovery(&mut account, ctx);
        assert_eq!(business_account::has_pending_recovery(&account), false);
        ts::return_shared(account);
    };
    advance(&mut scenario, business_account::recovery_delay_ms() + 1);
    scenario.next_tx(RESCUER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::execute_recovery(&mut account, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
/// A matured recovery ADDS an owner and clears the approvers. It does not
/// remove the existing owners: a hostile rescuer who waits out the notice gets
/// co-ownership, not the company.
fun a_matured_recovery_adds_an_owner_and_clears_approvers() {
    let mut scenario = setup();
    nominate_rescuer(&mut scenario);
    scenario.next_tx(RESCUER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::request_recovery(&mut account, OWNER2, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    advance(&mut scenario, business_account::recovery_delay_ms());
    scenario.next_tx(RESCUER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        let before = business_account::authority_epoch(&account);
        business_account::execute_recovery(&mut account, &c, ctx);

        assert_eq!(business_account::is_owner(&account, OWNER2), true);
        // The original owner survives. Recovery is additive.
        assert_eq!(business_account::is_owner(&account, OWNER), true);
        // Release authority is not inherited across a recovery.
        assert_eq!(business_account::is_approver(&account, APPROVER), false);
        assert_eq!(business_account::authority_epoch(&account), before + 1);

        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

// ─── The 24h ceiling ───────────────────────────────────────────────────────

fun set_cap(scenario: &mut Scenario, cap: u64) {
    scenario.next_tx(OWNER);
    let mut account = scenario.take_shared<BusinessAccount>();
    let ctx = scenario.ctx();
    let admin = business_account::admin_cap_for_testing(ctx);
    business_account::set_daily_cap(&admin, &mut account, cap);
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(account);
}

#[test]
#[expected_failure(abort_code = 201, location = splash_core::daily_limit)]
/// Two payments that each fit, and together do not. The second aborts rather
/// than settling partially — a half-paid payroll is worse than none.
fun the_daily_ceiling_stops_the_second_payment() {
    let mut scenario = setup();
    set_cap(&mut scenario, 1_500);

    open_intent(&mut scenario, OWNER, 1_000);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1_000);

    open_intent(&mut scenario, OWNER, 1_000);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1_000);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 201, location = splash_core::daily_limit)]
/// The tumbling double-spend, denied. Spend the ceiling, wait ONE hour, spend
/// it again — which a `(window_start, spent)` pair with a lazy reset would
/// eventually allow at the boundary and which a sliding window does not.
fun an_hour_later_does_not_reset_the_window() {
    let mut scenario = setup();
    set_cap(&mut scenario, 1_000);

    open_intent(&mut scenario, OWNER, 1_000);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1_000);

    advance(&mut scenario, HOUR);

    open_intent(&mut scenario, OWNER, 1_000);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1_000);
    scenario.end();
}

#[test]
/// A full day later, the allowance is back.
fun the_window_slides_and_capacity_returns() {
    let mut scenario = setup();
    set_cap(&mut scenario, 1_000);

    open_intent(&mut scenario, OWNER, 1_000);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1_000);

    advance(&mut scenario, DAY);

    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        assert_eq!(business_account::daily_spent(&account, &c), 0);
        assert_eq!(business_account::daily_remaining(&account, &c), 1_000);
        ts::return_shared(c);
        ts::return_shared(account);
    };

    open_intent(&mut scenario, OWNER, 1_000);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1_000);
    scenario.end();
}

#[test]
/// Raising the cap does not forgive spend already inside the window, so
/// "raise, drain, lower" moves no more than "raise and drain".
fun raising_the_cap_does_not_forgive_spend_already_made() {
    let mut scenario = setup();
    set_cap(&mut scenario, 1_000);

    open_intent(&mut scenario, OWNER, 1_000);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1_000);

    set_cap(&mut scenario, 5_000);

    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        // Not 5_000. The 1_000 already spent still counts against the window.
        assert_eq!(business_account::daily_spent(&account, &c), 1_000);
        assert_eq!(business_account::daily_remaining(&account, &c), 4_000);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 201, location = splash_core::daily_limit)]
/// Lowering the ceiling BELOW what has already been spent inside the window.
///
/// The window can then hold more than the cap, and `cap - spent` underflows.
/// It failed closed either way — a u64 arithmetic abort is still an abort —
/// but it reported an arithmetic error where the truth was "this account is
/// over its new, lower ceiling", which is the difference between an operator
/// diagnosing it in a minute and in an afternoon.
fun a_ceiling_lowered_under_an_account_reports_the_ceiling() {
    let mut scenario = setup();
    set_cap(&mut scenario, 1_000);

    open_intent(&mut scenario, OWNER, 1_000);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1_000);

    // Now under the spend already made.
    set_cap(&mut scenario, 500);

    open_intent(&mut scenario, OWNER, 1);
    approve(&mut scenario, APPROVER);
    settle(&mut scenario, OWNER, 1);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 25, location = splash_core::business_account)]
/// A recovery that has become moot must not execute.
///
/// If the surviving owners add the nominated address themselves during the
/// 72-hour notice, the account has already been recovered. Letting the rescuer
/// execute anyway would still clear the approver set — so a rescuer who cannot
/// gain anything could at least impose a delayed denial-of-service on an
/// account that never needed rescuing.
fun a_recovery_the_owners_already_performed_cannot_execute() {
    let mut scenario = setup();
    nominate_rescuer(&mut scenario);
    scenario.next_tx(RESCUER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::request_recovery(&mut account, OWNER2, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    // The owners are alive after all, and add the address themselves.
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::add_owner(&mut account, OWNER2, ctx);
        ts::return_shared(account);
    };
    advance(&mut scenario, business_account::recovery_delay_ms());
    scenario.next_tx(RESCUER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        let ctx = scenario.ctx();
        business_account::execute_recovery(&mut account, &c, ctx);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
/// The default ceiling is USD 1,000 expressed in six-decimal minor units. A
/// cap written as `1_000` would be a tenth of a cent — a limit that reads like
/// a limit and is a brick.
fun the_default_ceiling_is_scaled_not_whole_currency() {
    assert_eq!(business_account::default_daily_cap_minor(), 1_000_000_000);
}

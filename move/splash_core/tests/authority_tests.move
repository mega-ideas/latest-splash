/// Phase 6 authority tests, on the v2 core.
///
/// Every property here is one the product claims in words on the landing page
/// or in the compliance pack — revocable access, a stopped account stops, a
/// daily ceiling — and every one of them was previously enforced only by a
/// server the tenant does not control. These tests are the difference between
/// the claim and the control.
///
/// The legacy approver set, and with it the four-eyes tests that used it, is
/// gone from core (decision 3). The owners' second approval lives in
/// `splash_spend` and is tested there. The ceilings below are charged on the
/// owners' wallet path, the one payment path core itself has.
#[test_only]
module splash_core::authority_tests;

use splash_core::address_registry;
use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::cap_registry;
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::payment_intent;
use splash_core::spend_window;
use splash_core::v2_harness as h;
use std::unit_test::assert_eq;
use sui::clock::{Self, Clock};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const OWNER: address = @0xA11CE;
const OWNER2: address = @0xF00D;
const OWNER3: address = @0xBEEF;
const OUTSIDER: address = @0xDEAD;
const RESCUER: address = @0xCAFE;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";

const USD: u64 = 1_000_000;
const HOUR: u64 = 3_600_000;
const DAY: u64 = 86_400_000;

// ─── Harness ───────────────────────────────────────────────────────────────

/// A shared clock at day one, a shared account owned by OWNER, verified, and
/// the config. No business wallet: membership, freezes and recovery work the
/// same before one exists, and they are what these tests are about.
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
        let mut areg = address_registry::new_for_testing(ctx);
        business_account::verify_business(&admin, &mut account, &mut areg, 20);
        address_registry::destroy_for_testing(areg);
        let registry = cap_registry::new_for_testing(ctx);
        compliance_config::create<SUI>(
            compliance_config::ticket_for_testing(ctx),
            &admin,
            &registry,
            5_000,
            60_000,
            50,
            1_000_000,
            1_000_000,
            vector[object::id_from_address(@0xF001)],
            ctx,
        );
        cap_registry::share_for_testing(registry);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    scenario
}

/// The ceilings tests' account: `v2_harness::setup`, a verified Tier 3
/// account whose 2-of-3 business wallet is registered.
fun paying_setup(): Scenario {
    h::setup()
}

/// The wallet opens a bank payout for `amount` under reference `n` and pays
/// it in the same transaction, then anchors and deletes it.
fun pay(scenario: &mut Scenario, n: u8, amount: u64) {
    scenario.next_tx(h::wallet());
    let mut account = scenario.take_shared<BusinessAccount>();
    let config = scenario.take_shared<ComplianceConfig>();
    let c = scenario.take_shared<Clock>();
    let mut intent = h::wallet_intent(&mut account, &config, n, amount, &c, scenario.ctx());
    let payment = h::usdc(amount, scenario.ctx());
    let receipt = h::confirm(
        &mut intent,
        &mut account,
        &config,
        payment,
        h::settle_by(&c),
        &c,
        scenario.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, scenario.ctx());
    payment_intent::delete_finalized(intent);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
}

fun advance(scenario: &mut Scenario, by_ms: u64) {
    scenario.next_tx(OWNER);
    let mut c = scenario.take_shared<Clock>();
    c.increment_for_testing(by_ms);
    ts::return_shared(c);
}

#[test]
/// One wallet payment is metered against the account's own 24h and 30-day
/// ceilings. If this did not pass, every ceiling test below would pass for
/// the wrong reason.
fun a_wallet_payment_is_charged_to_the_ceilings() {
    let mut scenario = paying_setup();
    pay(&mut scenario, 1, 100 * USD);
    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        assert_eq!(business_account::daily_spent(&account, &c), 100 * USD);
        assert_eq!(
            business_account::daily_remaining(&account, &c),
            business_account::daily_cap_minor(&account) - 100 * USD,
        );
        assert_eq!(business_account::monthly_spent(&account, &c), 100 * USD);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

// ─── Freeze ────────────────────────────────────────────────────────────────

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
        let mut areg = address_registry::new_for_testing(ctx);
        business_account::admin_freeze(&admin, &mut account, &mut areg, ctx);
        address_registry::destroy_for_testing(areg);
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
/// compliance freeze land could line up a fresh owner for the thaw.
fun membership_cannot_change_while_frozen() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::freeze_account(&mut account, ctx);
        business_account::add_owner(&mut account, OUTSIDER, ctx);
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
/// and being a complete takeover: with every other owner and the founder gone,
/// nobody is left who can nominate the business wallet, and the intruder holds
/// the account.
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
        business_account::add_owner(&mut account, OWNER3, ctx);
        ts::return_shared(account);
    };
    scenario.next_tx(OWNER2);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        // One co-owner removes another.
        business_account::remove_owner(&mut account, OWNER3, ctx);
        assert_eq!(business_account::is_owner(&account, OWNER3), false);
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
        let start = business_account::authority_epoch(&account);

        business_account::add_owner(&mut account, OWNER2, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 1);

        business_account::remove_owner(&mut account, OWNER2, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 2);

        business_account::set_recovery_party(&mut account, RESCUER, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 3);

        business_account::freeze_account(&mut account, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 4);

        business_account::unfreeze_account(&mut account, ctx);
        assert_eq!(business_account::authority_epoch(&account), start + 5);

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
        business_account::add_owner(&mut account, OWNER2, ctx);
        business_account::set_recovery_party(&mut account, OWNER2, ctx);
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
/// A matured recovery ADDS an owner and moves the authority epoch. It does not
/// remove the existing owners: a hostile rescuer who waits out the notice gets
/// co-ownership, not the company.
fun a_matured_recovery_adds_an_owner() {
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
        // Approvals given before it do not survive a recovery.
        assert_eq!(business_account::authority_epoch(&account), before + 1);

        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

/// Move the account to a tier. Every ceiling comes with it.
fun set_tier(scenario: &mut Scenario, tier: u8) {
    scenario.next_tx(OWNER);
    let mut account = scenario.take_shared<BusinessAccount>();
    let ctx = scenario.ctx();
    let admin = business_account::admin_cap_for_testing(ctx);
    business_account::set_tier(&admin, &mut account, tier, ctx);
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(account);
}

// ─── Tiers, and the three ceilings each one grants ─────────────────────────
//
//   Tier 3   per transfer     20,000     daily     20,000    monthly    500,000
//   Tier 2   per transfer    200,000     daily    200,000    monthly  5,000,000
//   Tier 1   per transfer  1,000,000     daily  unlimited    monthly  unlimited

#[test]
/// A new account starts at the bottom. An account nobody has assessed gets the
/// limits of an account nobody has assessed.
fun a_new_account_starts_at_tier_three() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        assert_eq!(business_account::tier(&account), 3);
        assert_eq!(business_account::tier(&account), business_account::starting_tier());
        assert_eq!(business_account::per_transfer_cap_minor(&account), 20_000 * USD);
        assert_eq!(business_account::daily_cap_minor(&account), 20_000 * USD);
        assert_eq!(business_account::monthly_cap_minor(&account), 500_000 * USD);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
/// The custodian moves a tier, and every ceiling moves with it. One decision,
/// not three fields somebody could set inconsistently.
fun a_tier_carries_all_three_ceilings() {
    let mut scenario = setup();
    set_tier(&mut scenario, 2);
    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        assert_eq!(business_account::tier(&account), 2);
        assert_eq!(business_account::per_transfer_cap_minor(&account), 200_000 * USD);
        assert_eq!(business_account::daily_cap_minor(&account), 200_000 * USD);
        assert_eq!(business_account::monthly_cap_minor(&account), 5_000_000 * USD);
        ts::return_shared(account);
    };
    set_tier(&mut scenario, 1);
    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        assert_eq!(business_account::per_transfer_cap_minor(&account), 1_000_000 * USD);
        // Unlimited is the rolling windows, not the single transfer. Tier 1
        // still cannot move more than a million dollars in one go.
        assert_eq!(business_account::daily_cap_minor(&account), spend_window::unlimited());
        assert_eq!(business_account::monthly_cap_minor(&account), spend_window::unlimited());
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 44, location = splash_core::business_account)]
fun there_is_no_tier_four() {
    let mut scenario = setup();
    set_tier(&mut scenario, 4);
    scenario.end();
}

// ─── The floor ─────────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = payment_intent::E_BELOW_SETTLEMENT_FLOOR)]
/// Below 99 USD the fixed costs of settling, anchoring and screening exceed a
/// bank payout, and the partners' own corridor minimums start there. The v2
/// floor (434) refuses it when the intent opens; `charge_payout`'s own 99 USD
/// check (43) is the second line and is never lower.
fun a_payout_below_the_floor_is_refused() {
    let mut scenario = paying_setup();
    pay(&mut scenario, 1, 98 * USD);
    scenario.end();
}

#[test]
/// And exactly the floor is allowed. An off-by-one here is a support ticket.
fun a_payout_at_the_floor_is_allowed() {
    let mut scenario = paying_setup();
    assert_eq!(business_account::min_transfer_minor(), 99 * USD);
    pay(&mut scenario, 2, 99 * USD);
    scenario.end();
}

// ─── Per transfer ──────────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 42, location = splash_core::business_account)]
/// One payment larger than the tier allows, even with the day and month empty.
/// Checked first and with its own code, so "why was this refused?" is not a
/// guess between three ceilings.
fun a_single_payout_over_the_tier_ceiling_is_refused() {
    let mut scenario = paying_setup();
    pay(&mut scenario, 3, 20_001 * USD);
    scenario.end();
}

#[test]
/// The same payment at Tier 2, which permits it.
fun the_same_payout_passes_a_tier_up() {
    let mut scenario = paying_setup();
    set_tier(&mut scenario, 2);
    pay(&mut scenario, 4, 20_001 * USD);
    scenario.end();
}

// ─── The daily window ──────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 201, location = splash_core::spend_window)]
/// Two payments that each fit and together do not. The second aborts rather
/// than settling partially — a half-paid payroll is worse than none.
fun the_daily_ceiling_stops_the_second_payment() {
    let mut scenario = paying_setup();
    pay(&mut scenario, 5, 15_000 * USD);

    pay(&mut scenario, 6, 15_000 * USD);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 201, location = splash_core::spend_window)]
/// The tumbling double-spend, denied. Spend the ceiling, wait ONE hour, spend
/// it again — which a `(window_start, spent)` pair with a lazy reset would
/// eventually allow at the boundary and which a sliding window does not.
fun an_hour_later_does_not_reset_the_day() {
    let mut scenario = paying_setup();
    pay(&mut scenario, 7, 20_000 * USD);

    advance(&mut scenario, HOUR);

    pay(&mut scenario, 8, 99 * USD);
    scenario.end();
}

#[test]
/// A full day later, the daily allowance is back.
fun the_daily_window_slides_and_capacity_returns() {
    let mut scenario = paying_setup();
    pay(&mut scenario, 9, 20_000 * USD);

    advance(&mut scenario, DAY);

    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        assert_eq!(business_account::daily_spent(&account, &c), 0);
        assert_eq!(business_account::daily_remaining(&account, &c), 20_000 * USD);
        // The month has NOT forgotten it.
        assert_eq!(business_account::monthly_spent(&account, &c), 20_000 * USD);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

// ─── The monthly window ────────────────────────────────────────────────────

#[test]
#[expected_failure(abort_code = 201, location = splash_core::spend_window)]
/// The month binds even when every single day is inside its own limit. This is
/// the ceiling the daily one cannot express: 20k a day for 26 days is 520k,
/// which Tier 3 does not permit.
fun the_monthly_ceiling_binds_across_days() {
    let mut scenario = paying_setup();
    let mut day: u8 = 0;
    // 25 days at the daily ceiling is exactly 500,000 — the monthly cap.
    while (day < 25) {
        pay(&mut scenario, 100 + day, 20_000 * USD);
        advance(&mut scenario, DAY);
        day = day + 1;
    };
    // The 26th day is inside the DAILY limit and past the monthly one.
    pay(&mut scenario, 11, 99 * USD);
    scenario.end();
}

#[test]
/// Thirty days on, the month has rolled and capacity returns.
fun the_monthly_window_slides_too() {
    let mut scenario = paying_setup();
    pay(&mut scenario, 12, 20_000 * USD);

    advance(&mut scenario, 30 * DAY);

    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        assert_eq!(business_account::monthly_spent(&account, &c), 0);
        assert_eq!(business_account::monthly_remaining(&account, &c), 500_000 * USD);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
/// Raising a tier does not forgive spend already inside either window, so
/// "raise, drain, lower" moves no more than "raise and drain" would.
fun a_tier_upgrade_does_not_forgive_spend_already_made() {
    let mut scenario = paying_setup();
    pay(&mut scenario, 13, 20_000 * USD);

    set_tier(&mut scenario, 2);

    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let c = scenario.take_shared<Clock>();
        // Not the full 200,000 — the 20,000 already spent still counts.
        assert_eq!(business_account::daily_spent(&account, &c), 20_000 * USD);
        assert_eq!(business_account::daily_remaining(&account, &c), 180_000 * USD);
        assert_eq!(business_account::monthly_spent(&account, &c), 20_000 * USD);
        ts::return_shared(c);
        ts::return_shared(account);
    };
    scenario.end();
}

// ─── Asking for more ───────────────────────────────────────────────────────

#[test]
/// A request records that a tenant asked. It changes nothing — a function that
/// let a tenant move their own ceiling, even by one step, even with a delay,
/// would be a self-service limit raise wearing a request's clothing.
fun a_limit_increase_request_changes_no_ceiling() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::request_limit_increase(&account, 2, b"Payroll grew to 300 staff", ctx);
        // Same tier, same ceilings, on the way out.
        assert_eq!(business_account::tier(&account), 3);
        assert_eq!(business_account::daily_cap_minor(&account), 20_000 * USD);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 20, location = splash_core::business_account)]
fun only_an_owner_can_ask_for_more() {
    let mut scenario = setup();
    scenario.next_tx(OUTSIDER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::request_limit_increase(&account, 2, b"please", ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 44, location = splash_core::business_account)]
/// Asking to move DOWN a number is asking for more, because the tiers descend
/// as the limits rise. Asking for the tier you already hold is not a request.
fun a_request_must_actually_be_an_increase() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::request_limit_increase(&account, 3, b"same tier", ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 22, location = splash_core::business_account)]
/// A stopped account is not in a position to be asking for more room.
fun a_frozen_account_cannot_ask_for_more() {
    let mut scenario = setup();
    scenario.next_tx(OWNER);
    {
        let mut account = scenario.take_shared<BusinessAccount>();
        let ctx = scenario.ctx();
        business_account::freeze_account(&mut account, ctx);
        business_account::request_limit_increase(&account, 2, b"please", ctx);
        ts::return_shared(account);
    };
    scenario.end();
}

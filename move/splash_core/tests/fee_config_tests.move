/// Splash's fee (Amendment A1 §2.1–2.5, §2.10): the computation, the launch
/// schedule, and the only ways the schedule, the fee recipient and a
/// business's discount change.
///
/// Written from the amendment, not from the code. What is pinned here:
///
///   * `splash_fee` follows A1 §2.4 in its exact order: the tier is chosen by
///     the principal (upper bounds exclusive, else the last tier), a
///     business's discount only lowers the rate, the rate is applied with
///     floor rounding in u128, then the kind's minimum and maximum, and last
///     the 100 bps ceiling, which beats the minimum. Nothing aborts.
///   * the launch schedule of §2.2 is the default at publish, and the §3
///     vectors come out of it to the unit;
///   * a schedule or a fee recipient changes only by a proposal that waits
///     24 hours; applying early aborts; a proposal is validated when it is
///     made (1-8 tiers, uppers strictly ascending and ending at u64::MAX,
///     every rate at most 100 bps, min <= max, a known kind, a recipient
///     that is not 0x0);
///   * a discount applies at once, is at most 100 bps, and can never make a
///     business pay more than the schedule;
///   * a test-only constructor can store rates above the ceiling, for
///     splash_spend's own ceiling test, and even then `splash_fee` returns no
///     more than 1% of the principal.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::fee_config_tests;

use splash_core::fee_config::{Self, FeeConfig, FeeAdminCap};
use std::unit_test::assert_eq;
use sui::clock::{Self, Clock};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

const PUBLISHER: address = @0x5EED;
const FINANCE: address = @0xF1A4CE;
const GOVERNANCE: address = @0x6000;
const DAY: u64 = 86_400_000;
const U64_MAX: u64 = 18_446_744_073_709_551_615;
const USD: u64 = 1_000_000;

fun business(): ID { object::id_from_address(@0xB12) }
fun other_business(): ID { object::id_from_address(@0xB13) }

fun sb(): u8 { fee_config::kind_splash_business() }
fun wallet(): u8 { fee_config::kind_wallet() }
fun exchange(): u8 { fee_config::kind_exchange() }
fun cross_chain(): u8 { fee_config::kind_cross_chain() }
fun bank(): u8 { fee_config::kind_bank_payout() }

/// The launch schedule's five bands, as upper bounds.
fun bands(): vector<u64> { vector[1_000_000_000, 10_000_000_000, 50_000_000_000, 100_000_000_000, U64_MAX] }

/// A fresh config at the launch schedule, paying `FINANCE`, outside a scenario.
fun fresh(ctx: &mut TxContext): FeeConfig { fee_config::new_for_testing(FINANCE, ctx) }

fun fee(cfg: &FeeConfig, kind: u8, principal: u64): u64 {
    fee_config::splash_fee(cfg, business(), kind, principal)
}

/// Publish the module: the config is shared and the cap goes to the publisher.
fun published(): Scenario {
    let mut s = ts::begin(PUBLISHER);
    {
        fee_config::init_for_testing(s.ctx());
        let mut c = clock::create_for_testing(s.ctx());
        c.set_for_testing(DAY);
        clock::share_for_testing(c);
    };
    s.next_tx(PUBLISHER);
    s
}

/// `published`, with the fees on, paying `FINANCE`, for tests about the
/// schedule or a discount rather than the recipient.
fun published_fees_on(): Scenario {
    let mut s = published();
    let mut cfg = s.take_shared<FeeConfig>();
    fee_config::set_fee_recipient_for_testing(&mut cfg, FINANCE);
    ts::return_shared(cfg);
    s
}

/// Run `$body` as the cap holder, with the shared config and clock.
macro fun gov($s: &mut Scenario, $body: |&FeeAdminCap, &mut FeeConfig, &mut Clock|) {
    let s = $s;
    s.next_tx(PUBLISHER);
    let cap = s.take_from_sender<FeeAdminCap>();
    let mut cfg = s.take_shared<FeeConfig>();
    let mut c = s.take_shared<Clock>();
    $body(&cap, &mut cfg, &mut c);
    ts::return_shared(c);
    ts::return_shared(cfg);
    s.return_to_sender(cap);
}

// ─── Publish ───────────────────────────────────────────────────────────────

#[test]
/// At publish the config is shared at the launch schedule with NO fee
/// recipient, so Splash's fees are off (FIXUP 1, below), and the one
/// FeeAdminCap goes to the publisher, to be transferred to the governance
/// multisig. Nothing pays the publisher.
fun publish_shares_the_launch_schedule_and_mints_one_cap() {
    let mut s = published();
    {
        assert!(ts::has_most_recent_for_sender<FeeAdminCap>(&s));
        let cfg = s.take_shared<FeeConfig>();
        assert_eq!(fee_config::fee_recipient(&cfg), option::none());
        assert_eq!(fee_config::fees_on(&cfg), false);
        assert_eq!(fee_config::tier_count(&cfg, bank()), 5);
        assert_eq!(fee_config::has_pending_recipient(&cfg), false);
        let mut k = 0;
        while (k < 5) {
            assert_eq!(fee_config::has_pending_schedule(&cfg, k), false);
            k = k + 1;
        };
        ts::return_shared(cfg);
    };
    s.end();
}

#[test]
/// The constants A1 writes down.
fun the_constants_are_a1s() {
    assert_eq!(fee_config::fee_ceiling_bps(), 100);
    assert_eq!(fee_config::bps_denom(), 10_000);
    assert_eq!(fee_config::fee_notice_ms(), DAY);
    assert_eq!(fee_config::max_tiers(), 8);
    assert_eq!(sb(), 0);
    assert_eq!(wallet(), 1);
    assert_eq!(exchange(), 2);
    assert_eq!(cross_chain(), 3);
    assert_eq!(bank(), 4);
}

#[test]
/// The launch schedule of A1 §2.2, tier by tier.
fun the_launch_schedule_is_a1s() {
    let mut ctx = tx_context::dummy();
    let cfg = fresh(&mut ctx);
    // Splash business: free.
    assert_eq!(fee_config::tier_count(&cfg, sb()), 1);
    assert_eq!(fee_config::tier_upper_minor(&cfg, sb(), 0), U64_MAX);
    assert_eq!(fee_config::tier_bps(&cfg, sb(), 0), 0);
    assert_eq!(fee_config::schedule_min_minor(&cfg, sb()), 0);
    assert_eq!(fee_config::schedule_max_minor(&cfg, sb()), 0);
    // Wallet: 2 bps, at least 0.25 USDC, at most 5 USDC.
    assert_eq!(fee_config::tier_count(&cfg, wallet()), 1);
    assert_eq!(fee_config::tier_upper_minor(&cfg, wallet(), 0), U64_MAX);
    assert_eq!(fee_config::tier_bps(&cfg, wallet(), 0), 2);
    assert_eq!(fee_config::schedule_min_minor(&cfg, wallet()), 250_000);
    assert_eq!(fee_config::schedule_max_minor(&cfg, wallet()), 5_000_000);
    // Exchange, cross-chain and bank: five bands.
    let rates = vector[
        vector[15, 12, 10, 7, 5],
        vector[30, 20, 12, 7, 5],
        vector[30, 20, 12, 7, 5],
    ];
    let kinds = vector[exchange(), cross_chain(), bank()];
    let mut k = 0;
    while (k < 3) {
        let kind = kinds[k];
        assert_eq!(fee_config::tier_count(&cfg, kind), 5);
        let mut i = 0;
        while (i < 5) {
            assert_eq!(fee_config::tier_upper_minor(&cfg, kind, i), bands()[i]);
            assert_eq!(fee_config::tier_bps(&cfg, kind, i), rates[k][i]);
            i = i + 1;
        };
        assert_eq!(fee_config::schedule_min_minor(&cfg, kind), 0);
        assert_eq!(fee_config::schedule_max_minor(&cfg, kind), U64_MAX);
        k = k + 1;
    };
    fee_config::destroy_for_testing(cfg);
}

// ─── The §3 vectors ────────────────────────────────────────────────────────

/// BANK and CROSS_CHAIN share the rows of A1 §3.
fun assert_bank_rows(cfg: &FeeConfig, kind: u8) {
    assert_eq!(fee(cfg, kind, 999_999_999), 2_999_999);
    assert_eq!(fee(cfg, kind, 1_000_000_000), 2_000_000);
    assert_eq!(fee(cfg, kind, 9_999_999_999), 19_999_999);
    assert_eq!(fee(cfg, kind, 10_000_000_000), 12_000_000);
    assert_eq!(fee(cfg, kind, 49_999_999_999), 59_999_999);
    assert_eq!(fee(cfg, kind, 50_000_000_000), 35_000_000);
    assert_eq!(fee(cfg, kind, 99_999_999_999), 69_999_999);
    assert_eq!(fee(cfg, kind, 100_000_000_000), 50_000_000);
}

#[test]
fun bank_vectors() {
    let mut ctx = tx_context::dummy();
    let cfg = fresh(&mut ctx);
    assert_bank_rows(&cfg, bank());
    fee_config::destroy_for_testing(cfg);
}

#[test]
fun cross_chain_vectors_are_the_bank_rows() {
    let mut ctx = tx_context::dummy();
    let cfg = fresh(&mut ctx);
    assert_bank_rows(&cfg, cross_chain());
    fee_config::destroy_for_testing(cfg);
}

#[test]
fun exchange_vectors() {
    let mut ctx = tx_context::dummy();
    let cfg = fresh(&mut ctx);
    assert_eq!(fee(&cfg, exchange(), 999_999_999), 1_499_999);
    assert_eq!(fee(&cfg, exchange(), 1_000 * USD), 1_200_000);
    assert_eq!(fee(&cfg, exchange(), 10_000 * USD), 10_000_000);
    assert_eq!(fee(&cfg, exchange(), 50_000 * USD), 35_000_000);
    assert_eq!(fee(&cfg, exchange(), 100_000 * USD), 50_000_000);
    fee_config::destroy_for_testing(cfg);
}

#[test]
/// A wallet payment: 2 bps, at least 0.25 USDC, at most 5 USDC, and never
/// more than 1%, so a payment under 25 USDC pays 1% and nothing aborts.
fun wallet_vectors() {
    let mut ctx = tx_context::dummy();
    let cfg = fresh(&mut ctx);
    assert_eq!(fee(&cfg, wallet(), 10 * USD), 100_000); // the ceiling beats the minimum
    assert_eq!(fee(&cfg, wallet(), 25 * USD), 250_000);
    assert_eq!(fee(&cfg, wallet(), 1_250 * USD), 250_000); // the minimum's boundary
    assert_eq!(fee(&cfg, wallet(), 10_000 * USD), 2_000_000);
    assert_eq!(fee(&cfg, wallet(), 25_000 * USD), 5_000_000); // the maximum's boundary
    assert_eq!(fee(&cfg, wallet(), 1_000_000 * USD), 5_000_000); // clamped to the maximum
    fee_config::destroy_for_testing(cfg);
}

#[test]
fun splash_business_is_free() {
    let mut ctx = tx_context::dummy();
    let cfg = fresh(&mut ctx);
    assert_eq!(fee(&cfg, sb(), 50_000 * USD), 0);
    assert_eq!(fee(&cfg, sb(), U64_MAX), 0);
    fee_config::destroy_for_testing(cfg);
}

#[test]
/// BANK 5,000 with a 10 bps discount: the 20 bps band less 10.
fun a_discount_lowers_the_rate() {
    let mut ctx = tx_context::dummy();
    let mut cfg = fresh(&mut ctx);
    let cap = fee_config::fee_admin_cap_for_testing(&mut ctx);
    assert_eq!(fee(&cfg, bank(), 5_000 * USD), 10_000_000);
    fee_config::set_discount(&cap, &mut cfg, business(), 10);
    assert_eq!(fee_config::discount_bps(&cfg, business()), 10);
    assert_eq!(fee(&cfg, bank(), 5_000 * USD), 5_000_000);
    // Another business is not discounted.
    assert_eq!(fee_config::splash_fee(&cfg, other_business(), bank(), 5_000 * USD), 10_000_000);
    fee_config::destroy_fee_admin_cap_for_testing(cap);
    fee_config::destroy_for_testing(cfg);
}

#[test]
/// Edges: nothing aborts, from 0 to u64::MAX on every kind, and no fee is
/// ever above 1% of the principal.
fun splash_fee_never_aborts_and_never_passes_the_ceiling() {
    let mut ctx = tx_context::dummy();
    let cfg = fresh(&mut ctx);
    let principals = vector[0, 1, 99, 100, 10_000, 999_999, 1_000_000, 24_999_999, U64_MAX - 1, U64_MAX];
    let mut k = 0;
    while (k < 5) {
        let mut i = 0;
        while (i < principals.length()) {
            let p = principals[i];
            let f = fee(&cfg, k, p);
            assert!(f <= fee_config::mul_div_floor(p, 100, 10_000));
            i = i + 1;
        };
        k = k + 1;
    };
    assert_eq!(fee(&cfg, bank(), 0), 0);
    assert_eq!(fee(&cfg, wallet(), 99), 0);
    // u64::MAX picks the last tier: 5 bps, floored.
    assert_eq!(fee(&cfg, bank(), U64_MAX), 9_223_372_036_854_775);
    fee_config::destroy_for_testing(cfg);
}

#[test]
/// mul_div_floor works in u128 and rounds down.
fun mul_div_floor_rounds_down_in_u128() {
    assert_eq!(fee_config::mul_div_floor(999_999_999, 30, 10_000), 2_999_999);
    assert_eq!(fee_config::mul_div_floor(U64_MAX, 10_000, 10_000), U64_MAX);
    assert_eq!(fee_config::mul_div_floor(U64_MAX, 100, 10_000), 184_467_440_737_095_516);
    assert_eq!(fee_config::mul_div_floor(1, 9_999, 10_000), 0);
    assert_eq!(fee_config::mul_div_floor(0, 100, 10_000), 0);
}

// ─── Proposing and applying a schedule ─────────────────────────────────────

#[test]
/// A schedule change waits 24 hours: applying a millisecond before its eta
/// aborts (next test), and at the eta it applies and is what splash_fee uses.
fun a_schedule_applies_after_24_hours() {
    let mut s = published_fees_on();
    gov!(&mut s, |cap, cfg, c| {
        fee_config::propose_schedule(cap, cfg, bank(), vector[U64_MAX], vector[25], 0, U64_MAX, c);
        assert_eq!(fee_config::has_pending_schedule(cfg, bank()), true);
        assert_eq!(fee_config::pending_schedule_eta_ms(cfg, bank()), 2 * DAY);
        // Nothing has changed yet.
        assert_eq!(fee(cfg, bank(), 5_000 * USD), 10_000_000);
    });
    {
        let proposed = event::events_by_type<fee_config::FeeScheduleProposed>();
        assert_eq!(proposed.length(), 1);
        let (kind, uppers, rates, min, max, eta) = fee_config::unpack_fee_schedule_proposed_for_testing(proposed[0]);
        assert_eq!(kind, bank());
        assert_eq!(uppers, vector[U64_MAX]);
        assert_eq!(rates, vector[25]);
        assert_eq!(min, 0);
        assert_eq!(max, U64_MAX);
        assert_eq!(eta, 2 * DAY);
    };
    gov!(&mut s, |cap, cfg, c| {
        c.set_for_testing(2 * DAY);
        fee_config::apply_schedule(cap, cfg, bank(), c);
        assert_eq!(fee_config::has_pending_schedule(cfg, bank()), false);
        assert_eq!(fee_config::tier_count(cfg, bank()), 1);
        assert_eq!(fee(cfg, bank(), 5_000 * USD), 12_500_000);
        // Other kinds are untouched.
        assert_eq!(fee(cfg, cross_chain(), 5_000 * USD), 10_000_000);
    });
    {
        let applied = event::events_by_type<fee_config::FeeScheduleApplied>();
        assert_eq!(applied.length(), 1);
        assert_eq!(fee_config::unpack_fee_schedule_applied_for_testing(applied[0]), bank());
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = fee_config::E_FEE_PROPOSAL_NOT_READY)]
fun applying_a_schedule_before_24_hours_aborts() {
    let mut s = published();
    gov!(&mut s, |cap, cfg, c| {
        fee_config::propose_schedule(cap, cfg, bank(), vector[U64_MAX], vector[25], 0, U64_MAX, c);
        c.set_for_testing(2 * DAY - 1);
        fee_config::apply_schedule(cap, cfg, bank(), c);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = fee_config::E_NO_FEE_PROPOSAL)]
fun applying_a_schedule_with_nothing_proposed_aborts() {
    let mut s = published();
    gov!(&mut s, |cap, cfg, c| {
        c.set_for_testing(10 * DAY);
        fee_config::apply_schedule(cap, cfg, wallet(), c);
    });
    s.end();
}

#[test]
/// A second proposal for the same kind replaces the first and starts its own
/// 24 hours, so no change is ever applied with less notice than it gave.
fun a_new_proposal_replaces_the_pending_one_and_restarts_the_notice() {
    let mut s = published_fees_on();
    gov!(&mut s, |cap, cfg, c| {
        fee_config::propose_schedule(cap, cfg, bank(), vector[U64_MAX], vector[25], 0, U64_MAX, c);
        c.set_for_testing(DAY + DAY / 2);
        fee_config::propose_schedule(cap, cfg, bank(), vector[U64_MAX], vector[40], 0, U64_MAX, c);
        assert_eq!(fee_config::pending_schedule_eta_ms(cfg, bank()), DAY + DAY / 2 + DAY);
        c.set_for_testing(DAY + DAY / 2 + DAY);
        fee_config::apply_schedule(cap, cfg, bank(), c);
        assert_eq!(fee(cfg, bank(), 5_000 * USD), 20_000_000);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = fee_config::E_FEE_PROPOSAL_NOT_READY)]
fun a_replaced_proposal_cannot_apply_at_the_first_eta() {
    let mut s = published();
    gov!(&mut s, |cap, cfg, c| {
        fee_config::propose_schedule(cap, cfg, bank(), vector[U64_MAX], vector[25], 0, U64_MAX, c);
        c.set_for_testing(DAY + DAY / 2);
        fee_config::propose_schedule(cap, cfg, bank(), vector[U64_MAX], vector[40], 0, U64_MAX, c);
        c.set_for_testing(2 * DAY);
        fee_config::apply_schedule(cap, cfg, bank(), c);
    });
    s.end();
}

#[test]
/// A rate of exactly 100 bps, and eight tiers, are allowed.
fun the_ceiling_rate_and_eight_tiers_are_allowed() {
    let mut ctx = tx_context::dummy();
    let mut cfg = fresh(&mut ctx);
    let cap = fee_config::fee_admin_cap_for_testing(&mut ctx);
    let c = clock::create_for_testing(&mut ctx);
    fee_config::propose_schedule(
        &cap,
        &mut cfg,
        exchange(),
        vector[1, 2, 3, 4, 5, 6, 7, U64_MAX],
        vector[100, 90, 80, 70, 60, 50, 40, 30],
        0,
        U64_MAX,
        &c,
    );
    assert_eq!(fee_config::has_pending_schedule(&cfg, exchange()), true);
    clock::destroy_for_testing(c);
    fee_config::destroy_fee_admin_cap_for_testing(cap);
    fee_config::destroy_for_testing(cfg);
}

/// Propose a schedule outside a scenario, for the validation tests.
fun try_propose(kind: u8, uppers: vector<u64>, rates: vector<u64>, min: u64, max: u64) {
    let mut ctx = tx_context::dummy();
    let mut cfg = fresh(&mut ctx);
    let cap = fee_config::fee_admin_cap_for_testing(&mut ctx);
    let c = clock::create_for_testing(&mut ctx);
    fee_config::propose_schedule(&cap, &mut cfg, kind, uppers, rates, min, max, &c);
    clock::destroy_for_testing(c);
    fee_config::destroy_fee_admin_cap_for_testing(cap);
    fee_config::destroy_for_testing(cfg);
}

#[test]
#[expected_failure(abort_code = fee_config::E_FEE_ABOVE_CEILING)]
/// Any rate of 101 bps aborts, wherever it sits.
fun a_proposal_with_a_rate_of_101_aborts() {
    try_propose(bank(), bands(), vector[30, 20, 101, 7, 5], 0, U64_MAX);
}

#[test]
#[expected_failure(abort_code = fee_config::E_FEE_ABOVE_CEILING)]
fun a_single_tier_of_101_aborts() {
    try_propose(wallet(), vector[U64_MAX], vector[101], 0, 0);
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_SCHEDULE)]
fun a_non_ascending_tier_list_aborts() {
    try_propose(bank(), vector[10_000_000_000, 1_000_000_000, U64_MAX], vector[30, 20, 5], 0, U64_MAX);
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_SCHEDULE)]
/// Strictly ascending: two equal uppers abort.
fun two_equal_uppers_abort() {
    try_propose(bank(), vector[1_000_000_000, 1_000_000_000, U64_MAX], vector[30, 20, 5], 0, U64_MAX);
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_SCHEDULE)]
/// The last upper is u64::MAX, so every principal has a tier.
fun a_last_upper_below_u64_max_aborts() {
    try_propose(bank(), vector[1_000_000_000, U64_MAX - 1], vector[30, 20], 0, U64_MAX);
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_SCHEDULE)]
fun no_tiers_aborts() {
    try_propose(bank(), vector[], vector[], 0, U64_MAX);
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_SCHEDULE)]
fun nine_tiers_abort() {
    try_propose(bank(), vector[1, 2, 3, 4, 5, 6, 7, 8, U64_MAX], vector[9, 8, 7, 6, 5, 4, 3, 2, 1], 0, U64_MAX);
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_SCHEDULE)]
fun uppers_and_rates_of_different_lengths_abort() {
    try_propose(bank(), vector[1_000_000_000, U64_MAX], vector[30], 0, U64_MAX);
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_SCHEDULE)]
fun a_minimum_above_the_maximum_aborts() {
    try_propose(wallet(), vector[U64_MAX], vector[2], 5_000_001, 5_000_000);
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_SCHEDULE)]
fun an_unknown_kind_aborts() {
    try_propose(5, vector[U64_MAX], vector[2], 0, 0);
}

// ─── Fees are off until the first recipient change (FIXUP 1) ───────────────

#[test]
/// Sky, 24 Oct (FIXUP 1): at publish Splash's fees are OFF. With no fee
/// recipient applied, `splash_fee` is 0 on every kind and principal, so
/// every settle path charges 0 and sends no fee leg. A proposal alone does
/// not turn them on; the first recipient change, once its 24 hours have run
/// and it is applied, does, and from then on the schedule applies.
fun fees_are_off_until_the_first_recipient_change_is_applied() {
    let mut s = published();
    gov!(&mut s, |cap, cfg, c| {
        let mut k = 0;
        while (k < 5) {
            assert_eq!(fee(cfg, k, 5_000 * USD), 0);
            assert_eq!(fee(cfg, k, U64_MAX), 0);
            k = k + 1;
        };
        // A schedule change still waits its 24 hours, and still charges
        // nothing while there is no recipient.
        fee_config::propose_schedule(cap, cfg, bank(), vector[U64_MAX], vector[25], 0, U64_MAX, c);
        fee_config::propose_fee_recipient(cap, cfg, FINANCE, c);
        assert_eq!(fee_config::fees_on(cfg), false);
        assert_eq!(fee(cfg, bank(), 5_000 * USD), 0);
        c.set_for_testing(2 * DAY - 1);
        assert_eq!(fee(cfg, bank(), 5_000 * USD), 0);
        c.set_for_testing(2 * DAY);
        fee_config::apply_schedule(cap, cfg, bank(), c);
        // Applied schedule, still no recipient: still nothing.
        assert_eq!(fee(cfg, bank(), 5_000 * USD), 0);
        fee_config::apply_fee_recipient(cap, cfg, c);
        assert_eq!(fee_config::fees_on(cfg), true);
        assert_eq!(fee(cfg, bank(), 5_000 * USD), 12_500_000);
        assert_eq!(fee(cfg, wallet(), 10_000 * USD), 2_000_000);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = fee_config::E_UNKNOWN_KIND)]
/// An unknown kind still aborts while fees are off: the kind is checked
/// before the recipient.
fun an_unknown_kind_aborts_while_fees_are_off() {
    let mut s = published();
    gov!(&mut s, |_cap, cfg, _c| {
        fee(cfg, 5, 5_000 * USD);
    });
    s.end();
}

// ─── The fee recipient ─────────────────────────────────────────────────────

#[test]
/// The fee recipient changes after 24 hours, and the change is evented both
/// times.
fun the_fee_recipient_changes_after_24_hours() {
    let mut s = published();
    gov!(&mut s, |cap, cfg, c| {
        fee_config::propose_fee_recipient(cap, cfg, FINANCE, c);
        assert_eq!(fee_config::has_pending_recipient(cfg), true);
        assert_eq!(fee_config::pending_recipient(cfg), FINANCE);
        assert_eq!(fee_config::pending_recipient_eta_ms(cfg), 2 * DAY);
        assert_eq!(fee_config::fee_recipient(cfg), option::none());
    });
    {
        let proposed = event::events_by_type<fee_config::FeeRecipientProposed>();
        assert_eq!(proposed.length(), 1);
        let (recipient, eta) = fee_config::unpack_fee_recipient_proposed_for_testing(proposed[0]);
        assert_eq!(recipient, FINANCE);
        assert_eq!(eta, 2 * DAY);
    };
    gov!(&mut s, |cap, cfg, c| {
        c.set_for_testing(2 * DAY);
        fee_config::apply_fee_recipient(cap, cfg, c);
        assert_eq!(fee_config::fee_recipient(cfg), option::some(FINANCE));
        assert_eq!(fee_config::has_pending_recipient(cfg), false);
    });
    {
        let applied = event::events_by_type<fee_config::FeeRecipientApplied>();
        assert_eq!(applied.length(), 1);
        assert_eq!(fee_config::unpack_fee_recipient_applied_for_testing(applied[0]), FINANCE);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = fee_config::E_FEE_PROPOSAL_NOT_READY)]
fun applying_the_fee_recipient_before_24_hours_aborts() {
    let mut s = published();
    gov!(&mut s, |cap, cfg, c| {
        fee_config::propose_fee_recipient(cap, cfg, FINANCE, c);
        c.set_for_testing(2 * DAY - 1);
        fee_config::apply_fee_recipient(cap, cfg, c);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = fee_config::E_NO_FEE_PROPOSAL)]
fun applying_a_fee_recipient_with_nothing_proposed_aborts() {
    let mut s = published();
    gov!(&mut s, |cap, cfg, c| {
        c.set_for_testing(10 * DAY);
        fee_config::apply_fee_recipient(cap, cfg, c);
    });
    s.end();
}

#[test]
#[expected_failure(abort_code = fee_config::E_INVALID_FEE_RECIPIENT)]
fun the_zero_address_cannot_be_the_fee_recipient() {
    let mut ctx = tx_context::dummy();
    let mut cfg = fresh(&mut ctx);
    let cap = fee_config::fee_admin_cap_for_testing(&mut ctx);
    let c = clock::create_for_testing(&mut ctx);
    fee_config::propose_fee_recipient(&cap, &mut cfg, @0x0, &c);
    clock::destroy_for_testing(c);
    fee_config::destroy_fee_admin_cap_for_testing(cap);
    fee_config::destroy_for_testing(cfg);
}

#[test]
/// The cap moves to the governance multisig like any object with `store`,
/// and works there.
fun the_cap_works_from_the_governance_multisig() {
    let mut s = published();
    {
        let cap = s.take_from_sender<FeeAdminCap>();
        transfer::public_transfer(cap, GOVERNANCE);
    };
    s.next_tx(GOVERNANCE);
    {
        let cap = s.take_from_sender<FeeAdminCap>();
        let mut cfg = s.take_shared<FeeConfig>();
        let c = s.take_shared<Clock>();
        fee_config::propose_fee_recipient(&cap, &mut cfg, FINANCE, &c);
        ts::return_shared(c);
        ts::return_shared(cfg);
        s.return_to_sender(cap);
    };
    s.end();
}

// ─── Discounts ─────────────────────────────────────────────────────────────

#[test]
/// A discount applies at once and is evented. One larger than the tier's
/// rate takes the rate to 0, never below, and the kind's minimum and the
/// ceiling still apply after it, so it never makes a business pay more.
fun a_discount_applies_at_once_and_only_lowers() {
    let mut s = published_fees_on();
    gov!(&mut s, |cap, cfg, _c| {
        fee_config::set_discount(cap, cfg, business(), 100);
        assert_eq!(fee(cfg, bank(), 5_000 * USD), 0);
        assert_eq!(fee(cfg, exchange(), 100_000 * USD), 0);
        // The wallet minimum is not a rate: it still applies, under the ceiling.
        assert_eq!(fee(cfg, wallet(), 10_000 * USD), 250_000);
        assert_eq!(fee(cfg, wallet(), 10 * USD), 100_000);
        let mut k = 0;
        while (k < 5) {
            let p = 7_777 * USD;
            assert!(fee(cfg, k, p) <= fee_config::splash_fee(cfg, other_business(), k, p));
            k = k + 1;
        };
    });
    {
        let set = event::events_by_type<fee_config::FeeDiscountSet>();
        assert_eq!(set.length(), 1);
        let (who, discount) = fee_config::unpack_fee_discount_set_for_testing(set[0]);
        assert_eq!(who, business());
        assert_eq!(discount, 100);
    };
    s.end();
}

#[test]
/// A discount of 0 clears it.
fun a_zero_discount_clears_it() {
    let mut ctx = tx_context::dummy();
    let mut cfg = fresh(&mut ctx);
    let cap = fee_config::fee_admin_cap_for_testing(&mut ctx);
    fee_config::set_discount(&cap, &mut cfg, business(), 10);
    fee_config::set_discount(&cap, &mut cfg, business(), 0);
    assert_eq!(fee_config::discount_bps(&cfg, business()), 0);
    assert_eq!(fee(&cfg, bank(), 5_000 * USD), 10_000_000);
    // Clearing what was never set is a no-op, not an abort.
    fee_config::set_discount(&cap, &mut cfg, other_business(), 0);
    fee_config::destroy_fee_admin_cap_for_testing(cap);
    fee_config::destroy_for_testing(cfg);
}

#[test]
#[expected_failure(abort_code = fee_config::E_FEE_ABOVE_CEILING)]
fun a_discount_above_100_bps_aborts() {
    let mut ctx = tx_context::dummy();
    let mut cfg = fresh(&mut ctx);
    let cap = fee_config::fee_admin_cap_for_testing(&mut ctx);
    fee_config::set_discount(&cap, &mut cfg, business(), 101);
    fee_config::destroy_fee_admin_cap_for_testing(cap);
    fee_config::destroy_for_testing(cfg);
}

// ─── The test-only constructor ─────────────────────────────────────────────

#[test]
/// The unchecked test constructor stores a rate above the ceiling (for
/// splash_spend's own ceiling test), and splash_fee still charges no more
/// than 1%.
fun an_unchecked_schedule_above_the_ceiling_is_still_capped_by_splash_fee() {
    let mut ctx = tx_context::dummy();
    let mut cfg = fresh(&mut ctx);
    fee_config::set_schedule_unchecked_for_testing(&mut cfg, bank(), vector[U64_MAX], vector[300], 0, U64_MAX);
    assert_eq!(fee_config::tier_bps(&cfg, bank(), 0), 300);
    assert_eq!(fee(&cfg, bank(), 5_000 * USD), 50_000_000);
    fee_config::destroy_for_testing(cfg);
}

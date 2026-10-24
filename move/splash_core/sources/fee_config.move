/// FeeConfig — Splash's fee, computed on chain (Amendment A1 §2).
///
/// ─── What the fee is ────────────────────────────────────────────────────────
///
/// No intent carries a fee. The fee on a payment is computed here, at
/// settlement, from two things only: the payment's KIND, which the chain
/// derives (`address_registry::derive_kind`), and its PRINCIPAL. Each kind has
/// a schedule: one to eight tiers, chosen by the principal (upper bounds
/// exclusive), each with a rate in basis points, and a minimum and a maximum
/// fee. `splash_fee` applies them in A1 §2.4's exact order, with floor
/// rounding, which favours the payer, and a ceiling written into the package:
/// no fee is ever more than `FEE_CEILING_BPS` (100 bps, 1%) of the principal,
/// and the ceiling beats the minimum. Nothing in it aborts.
///
/// Partner and Circle fees are not here. They come from the partner's or
/// Circle's own quote, are shown as their own lines, and Splash does not
/// collect or mark them up.
///
/// ─── How it changes ─────────────────────────────────────────────────────────
///
/// One shared `FeeConfig`, created at publish with the launch schedule of A1
/// §2.2 and NO fee recipient. One `FeeAdminCap`, minted at publish for
/// transfer to the 2-of-3 governance multisig.
///
/// Splash's fees are OFF until the first fee recipient change has been
/// applied through the 24-hour path (Sky, 24 Oct). While no recipient has
/// been applied, `splash_fee` itself returns 0 for every kind and principal,
/// so every settle path, and splash_spend, which calls the same function,
/// charges 0, sends no fee leg and emits no FeeCharged; the payer's whole
/// `max_fee` comes back to the business wallet. Nothing is ever paid to the
/// publisher. Once a recipient has been applied there is always one: a later
/// change replaces it, and nothing clears it.
///
/// A schedule or the fee recipient changes only by a proposal that waits 24
/// hours (`FEE_NOTICE_MS`) and is then applied within seven days
/// (`FEE_APPLY_WINDOW_MS`); applying early aborts, and so does applying
/// after the window, when the proposal has lapsed and must be made again. A
/// new proposal for the same thing replaces the pending one and starts its
/// own 24 hours, so nothing is ever applied with less notice than it gave,
/// nor long after it. A pending proposal, lapsed or not, can be withdrawn
/// (`cancel_schedule_proposal`, `cancel_fee_recipient_proposal`), which
/// empties its slot and changes nothing in force. Every proposal is
/// validated when it is made, and every proposal, application and
/// withdrawal is an event owners are alerted to.
///
/// The one immediate change is a business's discount (`set_discount`), at
/// most 100 bps. A discount only lowers the rate the schedule gives, never
/// below zero, and the kind's minimum and the ceiling still apply after it,
/// so it can never make a business pay more than the published schedule.
///
/// ─── What does not change ───────────────────────────────────────────────────
///
/// There is no version gate here, on purpose. splash_spend publishes
/// immutable and stays linked to the splash_core version it was published
/// against, so it runs that version's `splash_fee` for ever: the ALGORITHM is
/// frozen at first publish, and only the schedule DATA changes later. A gate
/// would make those calls abort.
///
/// This module is NOT compliance_config, and the fee is not a compliance
/// parameter: compliance_config's ComplianceCap can only tighten, and that
/// guard (check:compliance) stays true because no fee lives there.
///
/// The fee leg itself (`take_fee`) is split inside Move by the settle paths
/// in `payment_intent`, to the recipient read from here, never from a PTB
/// argument. FeeConfig holds no value: the fee is sent on in the same call.
module splash_core::fee_config;

use splash_core::multisig;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

// ─── Abort codes (1300-block) ──────────────────────────────────────────────
/// A proposed schedule is malformed: not 1-8 tiers, uppers not strictly
/// ascending or not ending at u64::MAX, uppers and rates of different
/// lengths, a minimum above the maximum, or a kind outside 0-4.
const E_INVALID_SCHEDULE: u64 = 1300;
/// A proposed rate, or a discount, is above `FEE_CEILING_BPS`.
const E_FEE_ABOVE_CEILING: u64 = 1301;
/// The 24-hour notice for this proposal has not run yet.
const E_FEE_PROPOSAL_NOT_READY: u64 = 1302;
/// There is no pending proposal to apply.
const E_NO_FEE_PROPOSAL: u64 = 1303;
/// The proposed fee recipient is a multisig that one member can sign for
/// alone (a lone key, or a member whose weight meets the threshold).
const E_INVALID_FEE_RECIPIENT: u64 = 1304;
/// The kind is outside 0-4.
const E_UNKNOWN_KIND: u64 = 1305;
/// The proposal's window closed seven days after its 24-hour notice ran.
/// Propose it again, so owners are alerted again.
const E_FEE_PROPOSAL_LAPSED: u64 = 1306;

// ─── Constants ─────────────────────────────────────────────────────────────
/// The most any fee may be, in basis points of the principal: 1%. Written
/// into the package; no schedule can exceed it, and `splash_fee` clamps to it.
const FEE_CEILING_BPS: u64 = 100;
const BPS_DENOM: u64 = 10_000;
/// Every schedule and recipient change gives this much notice: 24 hours.
const FEE_NOTICE_MS: u64 = 86_400_000;
/// After its notice, a proposal must be applied within seven days or it
/// lapses, as a registry addition and a package upgrade do. One alert
/// cannot be cashed in months later, once owners have stopped watching.
const FEE_APPLY_WINDOW_MS: u64 = 604_800_000;
const MAX_TIERS: u64 = 8;
const U64_MAX: u64 = 18_446_744_073_709_551_615;

// ─── Kinds (A1). The schedule is indexed by them. ──────────────────────────
/// Another Splash business: a registered business wallet. Free.
const KIND_SPLASH_BUSINESS: u8 = 0;
/// A wallet on Sui.
const KIND_WALLET: u8 = 1;
/// A supported exchange's deposit address on Sui.
const KIND_EXCHANGE: u8 = 2;
/// USDC burned through CCTP to another chain.
const KIND_CROSS_CHAIN: u8 = 3;
/// A payout partner's deposit address, for a bank beneficiary.
const KIND_BANK_PAYOUT: u8 = 4;
const KIND_COUNT: u8 = 5;

// ─── Types ─────────────────────────────────────────────────────────────────

/// One tier: principals below `upper_minor` (and at or above the previous
/// tier's) pay `bps`.
public struct Tier has copy, drop, store {
    upper_minor: u64,
    bps: u64,
}

public struct Schedule has copy, drop, store {
    tiers: vector<Tier>,
    min_minor: u64,
    max_minor: u64,
}

public struct PendingSchedule has copy, drop, store {
    schedule: Schedule,
    eta_ms: u64,
}

public struct PendingRecipient has copy, drop, store {
    recipient: address,
    eta_ms: u64,
}

public struct FeeConfig has key {
    id: UID,
    /// One per kind, indexed by kind.
    schedules: vector<Schedule>,
    /// Where every fee leg is sent: the Splash finance multisig, never the
    /// KMS operator; `propose_fee_recipient` derives it from the multisig's
    /// members and refuses one a single member can sign for. None at publish, and while it is none Splash's fees are
    /// off (`splash_fee` is 0). It becomes some only through
    /// `apply_fee_recipient`, after 24 hours' notice.
    fee_recipient: Option<address>,
    /// Per business account: basis points taken off the schedule's rate.
    discounts: Table<ID, u16>,
    /// One slot per kind.
    pending_schedules: vector<Option<PendingSchedule>>,
    pending_recipient: Option<PendingRecipient>,
}

/// The authority to propose and apply schedule and recipient changes and to
/// set discounts. Minted once, at publish; `store` so it can be transferred
/// to the governance multisig.
public struct FeeAdminCap has key, store {
    id: UID,
}

// ─── Events (A1 §2.9) ──────────────────────────────────────────────────────

/// A fee leg was paid. The fee is Splash revenue; the principal is not here
/// (see docs/commitments.md).
public struct FeeCharged has copy, drop {
    intent_id: ID,
    business: ID,
    derived_kind: u8,
    fee: u64,
    fee_recipient: address,
}

public struct FeeScheduleProposed has copy, drop {
    kind: u8,
    tiers: vector<Tier>,
    min_minor: u64,
    max_minor: u64,
    eta: u64,
}

public struct FeeScheduleApplied has copy, drop {
    kind: u8,
}

public struct FeeRecipientProposed has copy, drop {
    recipient: address,
    eta: u64,
}

public struct FeeRecipientApplied has copy, drop {
    recipient: address,
}

/// A pending schedule proposal was withdrawn; the schedule in force is
/// unchanged.
public struct FeeScheduleProposalCancelled has copy, drop {
    kind: u8,
    eta: u64,
}

/// The pending fee recipient proposal was withdrawn; the recipient in force,
/// or none, is unchanged.
public struct FeeRecipientProposalCancelled has copy, drop {
    eta: u64,
}

public struct FeeDiscountSet has copy, drop {
    business: ID,
    discount_bps: u16,
}

// ─── Publish ───────────────────────────────────────────────────────────────

/// Share the one FeeConfig at the launch schedule with no fee recipient, so
/// Splash's fees are off until the first 24-hour recipient change is applied,
/// and mint the one FeeAdminCap to the publisher, for transfer to the
/// governance multisig.
fun init(ctx: &mut TxContext) {
    transfer::share_object(new(launch_schedules(), ctx));
    transfer::transfer(FeeAdminCap { id: object::new(ctx) }, ctx.sender());
}

fun new(schedules: vector<Schedule>, ctx: &mut TxContext): FeeConfig {
    FeeConfig {
        id: object::new(ctx),
        schedules,
        fee_recipient: option::none(),
        discounts: table::new(ctx),
        pending_schedules: vector[option::none(), option::none(), option::none(), option::none(), option::none()],
        pending_recipient: option::none(),
    }
}

/// A1 §2.2, in USDC minor units (6 decimals). Each is validated, so the
/// launch schedule obeys the rules every later one must.
fun launch_schedules(): vector<Schedule> {
    let bands = vector[1_000_000_000, 10_000_000_000, 50_000_000_000, 100_000_000_000, U64_MAX];
    let s = vector[
        // Splash business: free inside the network.
        build(KIND_SPLASH_BUSINESS, vector[U64_MAX], vector[0], 0, 0),
        // Wallet: 0.02%, at least 0.25 USDC, at most 5 USDC.
        build(KIND_WALLET, vector[U64_MAX], vector[2], 250_000, 5_000_000),
        // Exchange: 0.15 / 0.12 / 0.10 / 0.07 / 0.05%.
        build(KIND_EXCHANGE, bands, vector[15, 12, 10, 7, 5], 0, U64_MAX),
        // Cross-chain and bank: 0.30 / 0.20 / 0.12 / 0.07 / 0.05%.
        build(KIND_CROSS_CHAIN, bands, vector[30, 20, 12, 7, 5], 0, U64_MAX),
        build(KIND_BANK_PAYOUT, bands, vector[30, 20, 12, 7, 5], 0, U64_MAX),
    ];
    s
}

/// Build a schedule from parallel vectors, and validate it.
fun build(kind: u8, uppers: vector<u64>, rates: vector<u64>, min_minor: u64, max_minor: u64): Schedule {
    assert!(kind < KIND_COUNT, E_INVALID_SCHEDULE);
    let n = uppers.length();
    assert!(n >= 1 && n <= MAX_TIERS, E_INVALID_SCHEDULE);
    assert!(rates.length() == n, E_INVALID_SCHEDULE);
    let mut tiers = vector[];
    let mut i = 0;
    while (i < n) {
        assert!(rates[i] <= FEE_CEILING_BPS, E_FEE_ABOVE_CEILING);
        if (i > 0) assert!(uppers[i - 1] < uppers[i], E_INVALID_SCHEDULE);
        tiers.push_back(Tier { upper_minor: uppers[i], bps: rates[i] });
        i = i + 1;
    };
    assert!(uppers[n - 1] == U64_MAX, E_INVALID_SCHEDULE);
    assert!(min_minor <= max_minor, E_INVALID_SCHEDULE);
    Schedule { tiers, min_minor, max_minor }
}

// ─── The computation (A1 §2.4) ─────────────────────────────────────────────

/// Splash's fee on `principal` of `kind` for the business account `business`.
///
/// 0 while Splash's fees are off: no fee recipient has been applied yet.
///
/// Otherwise, in this order: the tier's rate (the first tier whose upper
/// bound is above the principal, else the last), less the business's
/// discount, floored at 0; the principal times that rate over 10,000, rounded
/// down in u128; raised to the kind's minimum and lowered to its maximum; and
/// lowered last to the ceiling, 1% of the principal, which beats the minimum.
/// A wallet payment under 25 USDC therefore pays 1% rather than 0.25 USDC.
/// Nothing aborts but an unknown kind, which is checked first, fees on or off.
public fun splash_fee(cfg: &FeeConfig, business: ID, kind: u8, principal: u64): u64 {
    let s = schedule(cfg, kind);
    if (cfg.fee_recipient.is_none()) return 0;
    let mut bps = tier_bps_of(s, principal);
    let discount = discount_bps(cfg, business) as u64;
    bps = bps - if (discount < bps) discount else bps;
    let mut fee = mul_div_floor(principal, bps, BPS_DENOM);
    if (fee < s.min_minor) fee = s.min_minor;
    if (fee > s.max_minor) fee = s.max_minor;
    let ceiling = mul_div_floor(principal, FEE_CEILING_BPS, BPS_DENOM);
    if (fee > ceiling) fee = ceiling;
    fee
}

/// `a * b / d`, rounded down, in u128. With `b <= d` the result is at most
/// `a`, so it always fits; it aborts only if it would not fit a u64.
public fun mul_div_floor(a: u64, b: u64, d: u64): u64 {
    (((a as u128) * (b as u128)) / (d as u128)) as u64
}

fun schedule(cfg: &FeeConfig, kind: u8): &Schedule {
    assert!(kind < KIND_COUNT, E_UNKNOWN_KIND);
    &cfg.schedules[kind as u64]
}

fun tier_bps_of(s: &Schedule, principal: u64): u64 {
    let n = s.tiers.length();
    let mut i = 0;
    while (i < n) {
        if (principal < s.tiers[i].upper_minor) return s.tiers[i].bps;
        i = i + 1;
    };
    s.tiers[n - 1].bps
}

// ─── The fee leg ───────────────────────────────────────────────────────────

/// Split `fee` out of `funds` and send it to the fee recipient's address
/// balance, and record it. Nothing at all when the fee is 0: no transfer and
/// no zero coin. A fee is 0 whenever there is no recipient (`splash_fee`);
/// should one ever reach here without a recipient, it is left in `funds`,
/// which every caller returns to the business wallet. `public(package)`: only
/// core's settle paths pay a fee leg, and they read the recipient from here,
/// never from a PTB argument.
public(package) fun take_fee<T>(
    cfg: &FeeConfig,
    funds: &mut Balance<T>,
    fee: u64,
    intent_id: ID,
    business: ID,
    derived_kind: u8,
) {
    if (fee == 0 || cfg.fee_recipient.is_none()) return;
    let fee_recipient = *cfg.fee_recipient.borrow();
    balance::send_funds(funds.split(fee), fee_recipient);
    event::emit(FeeCharged { intent_id, business, derived_kind, fee, fee_recipient });
}

// ─── Changes: 24 hours' notice ─────────────────────────────────────────────

/// Propose a new schedule for `kind`: `uppers` and `rates` in parallel, one
/// entry per tier. Validated now; applicable by `apply_schedule` 24 hours
/// from now. Replaces any proposal already pending for this kind.
public fun propose_schedule(
    _: &FeeAdminCap,
    cfg: &mut FeeConfig,
    kind: u8,
    uppers: vector<u64>,
    rates: vector<u64>,
    min_minor: u64,
    max_minor: u64,
    clock: &Clock,
) {
    let schedule = build(kind, uppers, rates, min_minor, max_minor);
    let eta = clock.timestamp_ms() + FEE_NOTICE_MS;
    let tiers = schedule.tiers;
    *&mut cfg.pending_schedules[kind as u64] = option::some(PendingSchedule { schedule, eta_ms: eta });
    event::emit(FeeScheduleProposed { kind, tiers, min_minor, max_minor, eta });
}

/// Put the schedule proposed for `kind` into force, once its notice has run
/// and before its window closes, seven days later. A lapsed proposal never
/// applies: propose it again, or withdraw it (`cancel_schedule_proposal`).
public fun apply_schedule(_: &FeeAdminCap, cfg: &mut FeeConfig, kind: u8, clock: &Clock) {
    assert!(kind < KIND_COUNT, E_UNKNOWN_KIND);
    let slot = &mut cfg.pending_schedules[kind as u64];
    assert!(slot.is_some(), E_NO_FEE_PROPOSAL);
    let now = clock.timestamp_ms();
    assert!(now >= slot.borrow().eta_ms, E_FEE_PROPOSAL_NOT_READY);
    assert!(now < slot.borrow().eta_ms + FEE_APPLY_WINDOW_MS, E_FEE_PROPOSAL_LAPSED);
    let PendingSchedule { schedule, eta_ms: _ } = slot.extract();
    *&mut cfg.schedules[kind as u64] = schedule;
    event::emit(FeeScheduleApplied { kind });
}

/// Propose a new fee recipient, applicable 24 hours from now. Replaces any
/// recipient proposal already pending.
///
/// The recipient is proven to be a multisig (Sky, 24 Oct; stricter than A1):
/// the proposal names its members' keys (`flag || public key`), their
/// weights and its threshold, and the address is derived from them here
/// (`multisig::derive_address`), never typed in. A configuration Sui would
/// refuse to build aborts with multisig's own code, and a multisig any ONE
/// member can sign for alone (`multisig::is_single_signer`: a 1-of-1, a
/// 1-of-N, or a member whose weight meets the threshold) aborts with
/// E_INVALID_FEE_RECIPIENT. So the fee recipient can never be a lone key,
/// such as the KMS operator. Who the members are is still for the go-live
/// ceremony to check: the chain only knows that no single one of them can
/// move the fees.
public fun propose_fee_recipient(
    _: &FeeAdminCap,
    cfg: &mut FeeConfig,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    clock: &Clock,
) {
    let recipient = multisig::derive_address(&keys, &weights, threshold);
    assert!(!multisig::is_single_signer(&weights, threshold), E_INVALID_FEE_RECIPIENT);
    let eta = clock.timestamp_ms() + FEE_NOTICE_MS;
    cfg.pending_recipient = option::some(PendingRecipient { recipient, eta_ms: eta });
    event::emit(FeeRecipientProposed { recipient, eta });
}

/// Put the proposed fee recipient into force, once its notice has run and
/// before its window closes, seven days later. The first time, this turns
/// Splash's fees on.
public fun apply_fee_recipient(_: &FeeAdminCap, cfg: &mut FeeConfig, clock: &Clock) {
    assert!(cfg.pending_recipient.is_some(), E_NO_FEE_PROPOSAL);
    let now = clock.timestamp_ms();
    assert!(now >= cfg.pending_recipient.borrow().eta_ms, E_FEE_PROPOSAL_NOT_READY);
    assert!(now < cfg.pending_recipient.borrow().eta_ms + FEE_APPLY_WINDOW_MS, E_FEE_PROPOSAL_LAPSED);
    let PendingRecipient { recipient, eta_ms: _ } = cfg.pending_recipient.extract();
    cfg.fee_recipient = option::some(recipient);
    event::emit(FeeRecipientApplied { recipient });
}

// ─── Withdrawing a proposal ────────────────────────────────────────────────

/// Withdraw the schedule proposal pending for `kind`, lapsed or not. It
/// empties the slot and nothing else: the schedule in force is unchanged,
/// so this needs no notice. Aborts if nothing is pending for the kind.
public fun cancel_schedule_proposal(_: &FeeAdminCap, cfg: &mut FeeConfig, kind: u8) {
    assert!(kind < KIND_COUNT, E_UNKNOWN_KIND);
    let slot = &mut cfg.pending_schedules[kind as u64];
    assert!(slot.is_some(), E_NO_FEE_PROPOSAL);
    let PendingSchedule { schedule: _, eta_ms } = slot.extract();
    event::emit(FeeScheduleProposalCancelled { kind, eta: eta_ms });
}

/// Withdraw the pending fee recipient proposal, lapsed or not. The
/// recipient in force, or none while the fees are off, is unchanged.
/// Aborts if nothing is pending.
public fun cancel_fee_recipient_proposal(_: &FeeAdminCap, cfg: &mut FeeConfig) {
    assert!(cfg.pending_recipient.is_some(), E_NO_FEE_PROPOSAL);
    let PendingRecipient { recipient: _, eta_ms } = cfg.pending_recipient.extract();
    event::emit(FeeRecipientProposalCancelled { eta: eta_ms });
}

// ─── The one immediate change: a discount ──────────────────────────────────

/// Set the discount, in basis points, a business account gets off the
/// schedule's rate; 0 clears it. Immediate, at most `FEE_CEILING_BPS`. A
/// discount only lowers the rate, never below zero, and the kind's minimum
/// and the ceiling still apply after it, so it cannot make a business pay
/// more than the published schedule.
public fun set_discount(_: &FeeAdminCap, cfg: &mut FeeConfig, business: ID, discount_bps: u16) {
    assert!((discount_bps as u64) <= FEE_CEILING_BPS, E_FEE_ABOVE_CEILING);
    if (cfg.discounts.contains(business)) {
        let _ = cfg.discounts.remove(business);
    };
    if (discount_bps > 0) cfg.discounts.add(business, discount_bps);
    event::emit(FeeDiscountSet { business, discount_bps });
}

// ─── Views ─────────────────────────────────────────────────────────────────

/// The fee recipient in force; none while Splash's fees are off.
public fun fee_recipient(cfg: &FeeConfig): Option<address> { cfg.fee_recipient }
/// False until the first fee recipient change has been applied; while it is
/// false every fee is 0.
public fun fees_on(cfg: &FeeConfig): bool { cfg.fee_recipient.is_some() }
public fun discount_bps(cfg: &FeeConfig, business: ID): u16 {
    if (cfg.discounts.contains(business)) *cfg.discounts.borrow(business) else 0
}
public fun tier_count(cfg: &FeeConfig, kind: u8): u64 { schedule(cfg, kind).tiers.length() }
public fun tier_upper_minor(cfg: &FeeConfig, kind: u8, i: u64): u64 { schedule(cfg, kind).tiers[i].upper_minor }
public fun tier_bps(cfg: &FeeConfig, kind: u8, i: u64): u64 { schedule(cfg, kind).tiers[i].bps }
public fun schedule_min_minor(cfg: &FeeConfig, kind: u8): u64 { schedule(cfg, kind).min_minor }
public fun schedule_max_minor(cfg: &FeeConfig, kind: u8): u64 { schedule(cfg, kind).max_minor }
/// The schedule's rate for `principal` of `kind`, before any discount.
public fun rate_bps(cfg: &FeeConfig, kind: u8, principal: u64): u64 { tier_bps_of(schedule(cfg, kind), principal) }
public fun has_pending_schedule(cfg: &FeeConfig, kind: u8): bool {
    assert!(kind < KIND_COUNT, E_UNKNOWN_KIND);
    cfg.pending_schedules[kind as u64].is_some()
}
public fun pending_schedule_eta_ms(cfg: &FeeConfig, kind: u8): u64 {
    assert!(has_pending_schedule(cfg, kind), E_NO_FEE_PROPOSAL);
    cfg.pending_schedules[kind as u64].borrow().eta_ms
}
public fun has_pending_recipient(cfg: &FeeConfig): bool { cfg.pending_recipient.is_some() }
public fun pending_recipient(cfg: &FeeConfig): address {
    assert!(cfg.pending_recipient.is_some(), E_NO_FEE_PROPOSAL);
    cfg.pending_recipient.borrow().recipient
}
public fun pending_recipient_eta_ms(cfg: &FeeConfig): u64 {
    assert!(cfg.pending_recipient.is_some(), E_NO_FEE_PROPOSAL);
    cfg.pending_recipient.borrow().eta_ms
}

public fun fee_ceiling_bps(): u64 { FEE_CEILING_BPS }
public fun bps_denom(): u64 { BPS_DENOM }
public fun fee_notice_ms(): u64 { FEE_NOTICE_MS }
public fun fee_apply_window_ms(): u64 { FEE_APPLY_WINDOW_MS }
public fun max_tiers(): u64 { MAX_TIERS }

public fun kind_splash_business(): u8 { KIND_SPLASH_BUSINESS }
public fun kind_wallet(): u8 { KIND_WALLET }
public fun kind_exchange(): u8 { KIND_EXCHANGE }
public fun kind_cross_chain(): u8 { KIND_CROSS_CHAIN }
public fun kind_bank_payout(): u8 { KIND_BANK_PAYOUT }
public fun kind_count(): u8 { KIND_COUNT }

// ─── Test-only ─────────────────────────────────────────────────────────────

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }

/// A config at the launch schedule paying `fee_recipient`, as if its first
/// recipient change had been applied, so its fees are on. Not shared.
#[test_only]
public fun new_for_testing(fee_recipient: address, ctx: &mut TxContext): FeeConfig {
    let mut cfg = new(launch_schedules(), ctx);
    cfg.fee_recipient = option::some(fee_recipient);
    cfg
}

/// A config that charges nothing on any kind, for tests that are not about
/// the fee.
#[test_only]
public fun zero_for_testing(fee_recipient: address, ctx: &mut TxContext): FeeConfig {
    let mut schedules = vector[];
    let mut k = 0;
    while (k < KIND_COUNT) {
        schedules.push_back(build(k, vector[U64_MAX], vector[0], 0, 0));
        k = k + 1;
    };
    let mut cfg = new(schedules, ctx);
    cfg.fee_recipient = option::some(fee_recipient);
    cfg
}

/// Put a config back in its state at publish: no fee recipient applied, so
/// its fees are off. The schedules are untouched.
#[test_only]
public fun clear_fee_recipient_for_testing(cfg: &mut FeeConfig) { cfg.fee_recipient = option::none() }

/// Set the fee recipient without the 24-hour path, turning the fees on, for
/// tests about something else (the schedule, a discount).
#[test_only]
public fun set_fee_recipient_for_testing(cfg: &mut FeeConfig, recipient: address) {
    cfg.fee_recipient = option::some(recipient)
}

/// Store a schedule WITHOUT validating it: rates above the ceiling, any
/// order. Only for testing that splash_spend's own ceiling check holds even
/// when the stored data does not (A1 §3).
#[test_only]
public fun set_schedule_unchecked_for_testing(
    cfg: &mut FeeConfig,
    kind: u8,
    uppers: vector<u64>,
    rates: vector<u64>,
    min_minor: u64,
    max_minor: u64,
) {
    let mut tiers = vector[];
    let mut i = 0;
    while (i < uppers.length()) {
        tiers.push_back(Tier { upper_minor: uppers[i], bps: rates[i] });
        i = i + 1;
    };
    *&mut cfg.schedules[kind as u64] = Schedule { tiers, min_minor, max_minor };
}

#[test_only]
public fun share_for_testing(cfg: FeeConfig) { transfer::share_object(cfg) }

#[test_only]
public fun destroy_for_testing(cfg: FeeConfig) {
    let FeeConfig { id, schedules: _, fee_recipient: _, discounts, pending_schedules: _, pending_recipient: _ } = cfg;
    discounts.drop();
    id.delete();
}

#[test_only]
public fun fee_admin_cap_for_testing(ctx: &mut TxContext): FeeAdminCap { FeeAdminCap { id: object::new(ctx) } }

#[test_only]
public fun destroy_fee_admin_cap_for_testing(cap: FeeAdminCap) {
    let FeeAdminCap { id } = cap;
    id.delete();
}

#[test_only]
public fun unpack_fee_charged_for_testing(e: FeeCharged): (ID, ID, u8, u64, address) {
    let FeeCharged { intent_id, business, derived_kind, fee, fee_recipient } = e;
    (intent_id, business, derived_kind, fee, fee_recipient)
}

/// The tiers come back as parallel vectors, uppers then rates.
#[test_only]
public fun unpack_fee_schedule_proposed_for_testing(
    e: FeeScheduleProposed,
): (u8, vector<u64>, vector<u64>, u64, u64, u64) {
    let FeeScheduleProposed { kind, tiers, min_minor, max_minor, eta } = e;
    let mut uppers = vector[];
    let mut rates = vector[];
    let mut i = 0;
    while (i < tiers.length()) {
        uppers.push_back(tiers[i].upper_minor);
        rates.push_back(tiers[i].bps);
        i = i + 1;
    };
    (kind, uppers, rates, min_minor, max_minor, eta)
}

#[test_only]
public fun unpack_fee_schedule_applied_for_testing(e: FeeScheduleApplied): u8 {
    let FeeScheduleApplied { kind } = e;
    kind
}

#[test_only]
public fun unpack_fee_recipient_proposed_for_testing(e: FeeRecipientProposed): (address, u64) {
    let FeeRecipientProposed { recipient, eta } = e;
    (recipient, eta)
}

#[test_only]
public fun unpack_fee_recipient_applied_for_testing(e: FeeRecipientApplied): address {
    let FeeRecipientApplied { recipient } = e;
    recipient
}

#[test_only]
public fun unpack_fee_schedule_proposal_cancelled_for_testing(e: FeeScheduleProposalCancelled): (u8, u64) {
    let FeeScheduleProposalCancelled { kind, eta } = e;
    (kind, eta)
}

#[test_only]
public fun unpack_fee_recipient_proposal_cancelled_for_testing(e: FeeRecipientProposalCancelled): u64 {
    let FeeRecipientProposalCancelled { eta } = e;
    eta
}

#[test_only]
public fun unpack_fee_discount_set_for_testing(e: FeeDiscountSet): (ID, u16) {
    let FeeDiscountSet { business, discount_bps } = e;
    (business, discount_bps)
}

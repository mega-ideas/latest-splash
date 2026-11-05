/// The 24-hour upgrade delay (docs/v2/phase1-move-design.md section 6).
///
/// Written from the spec. The properties pinned here: only the governance
/// multisig itself, a real quorum, can wrap core's cap, and it keeps the
/// wrapper; the cap must be unused and ends up no looser than additive; no
/// upgrade runs inside 24 hours of its announcement or more than seven days
/// after the notice ran; the upgrade that runs is the one announced, once; the
/// wrapper moves only to another quorum multisig, behind the same notice; and
/// taking power away (dependency-only, immutable) needs no notice at all.
///
/// Governance is the Phase 0 2-of-3 passkey multisig from `v2_harness`. Move
/// tests do not check signatures, so a test acts as a multisig by sending as
/// its address. What the chain would check (that the sender is the address
/// these members derive) is exactly what the code under test asserts.
///
/// Events are checked field by field through their BCS encoding: a struct's
/// BCS is its fields' BCS in order, so the expected bytes are built from the
/// values the spec says each event must carry.
#[test_only]
#[allow(implicit_const_copy)]
module splash_upgrade_delay::upgrade_delay_tests;

use splash_core::v2_harness as h;
use splash_upgrade_delay::upgrade_delay::{
    Self,
    DelayedUpgradeCap,
    CapWrapped,
    UpgradeProposed,
    UpgradeAuthorized,
    UpgradeCancelled,
    UpgradeCommitted,
    OwnerChangeProposed,
    OwnerChangeCancelled,
    OwnerChanged,
    MadeImmutable
};
use std::bcs;
use std::unit_test::{assert_eq, destroy};
use sui::clock::{Self, Clock};
use sui::event;
use sui::package::{Self, UpgradeCap};
use sui::test_scenario::{Self as ts, Scenario};

// ─── Actors ────────────────────────────────────────────────────────────────

const PUBLISHER: address = @0xA;
const STRANGER: address = @0xBAD;

// Members from the SDK vectors in splash_core's `multisig_tests`.
const ZKLOGIN: vector<u8> = x"051b68747470733a2f2f6163636f756e74732e676f6f676c652e636f6d00000000000000000000000000000000000000018ee90ff6c373e0ee4e3f0ad2";
const ED25519: vector<u8> = x"00d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";

/// mixed_passkey_zklogin_ed25519_2_of_3: the new governance multisig.
const NEW_GOVERNANCE: address = @0x017a504ea8bd39eba683e035e47a5dd77d14a8b065cea4d313120e7e8c94fca0;
/// passkey_1_of_1: one key, signs alone.
const PASSKEY_1_OF_1: address = @0x542f90eeed1c3562b33c4d81d7daf9571b91497acea2c5c6b6759290a569fe8f;
/// weighted_single_signer_2_1_1: reads as 2-of-3, member one signs alone.
const WEIGHTED_SINGLE_SIGNER_2_1_1: address = @0xe461c942f4635e04fd72371ab24ff27c8eda59582f7a0f054cf2c14f2ad1d350;

// ─── Values ────────────────────────────────────────────────────────────────

const DIGEST: vector<u8> = x"1111111111111111111111111111111111111111111111111111111111111111";
const OTHER_DIGEST: vector<u8> = x"2222222222222222222222222222222222222222222222222222222222222222";
const DIGEST_31: vector<u8> = x"11111111111111111111111111111111111111111111111111111111111111";
const DIGEST_33: vector<u8> = x"111111111111111111111111111111111111111111111111111111111111111111";

/// The spec's numbers, written out rather than read from the module, so a
/// change to either constant fails here.
const DAY_MS: u64 = 86_400_000;
const WEEK_MS: u64 = 604_800_000;
const START_MS: u64 = 1_000_000;

const COMPATIBLE: u8 = 0;
const ADDITIVE: u8 = 128;
const DEP_ONLY: u8 = 192;

fun package_id(): ID { object::id_from_address(@0xC0DE) }

fun other_package_id(): ID { object::id_from_address(@0xD00D) }

fun new_keys(): vector<vector<u8>> { vector[h::passkey(0), ZKLOGIN, ED25519] }

// ─── Set-up ────────────────────────────────────────────────────────────────

/// A clock at `START_MS` and a scenario whose first sender is `sender`.
fun begin(sender: address): (Scenario, Clock) {
    let mut s = ts::begin(sender);
    let mut clock = clock::create_for_testing(s.ctx());
    clock.set_for_testing(START_MS);
    (s, clock)
}

/// The publisher publishes and transfers the raw cap to governance.
fun publish_to_governance(s: &mut Scenario) {
    s.next_tx(PUBLISHER);
    let cap = package::test_publish(package_id(), s.ctx());
    transfer::public_transfer(cap, h::wallet());
}

/// Governance takes the cap it was sent and wraps it, signing as itself.
fun governance_wraps(s: &mut Scenario) {
    s.next_tx(h::wallet());
    let cap = s.take_from_sender<UpgradeCap>();
    upgrade_delay::wrap(cap, h::keys(), h::weights(), h::threshold(), s.ctx());
}

/// The whole deployment: publish, hand to governance, wrap. The scenario is
/// left at a fresh transaction sent by governance.
fun setup(): (Scenario, Clock) {
    let (mut s, clock) = begin(PUBLISHER);
    publish_to_governance(&mut s);
    governance_wraps(&mut s);
    s.next_tx(h::wallet());
    (s, clock)
}

/// Wrap a cap governance holds in its own hands (already restricted or used).
fun wrap_cap(s: &mut Scenario, cap: UpgradeCap) {
    upgrade_delay::wrap(cap, h::keys(), h::weights(), h::threshold(), s.ctx());
    s.next_tx(h::wallet());
}

/// Propose, wait out exactly the notice, authorise, run, commit.
fun upgrade_once(w: &mut DelayedUpgradeCap, clock: &mut Clock, digest: vector<u8>) {
    upgrade_delay::propose(w, digest, clock);
    clock.increment_for_testing(DAY_MS);
    let ticket = upgrade_delay::authorize_upgrade(w, digest, clock);
    upgrade_delay::commit_upgrade(w, package::test_upgrade(ticket));
}

/// Authorise and run the upgrade; aborts wherever `authorize_upgrade` does.
fun try_authorize(w: &mut DelayedUpgradeCap, digest: vector<u8>, clock: &Clock) {
    let ticket = upgrade_delay::authorize_upgrade(w, digest, clock);
    upgrade_delay::commit_upgrade(w, package::test_upgrade(ticket));
}

fun finish(s: Scenario, clock: Clock) {
    clock.destroy_for_testing();
    s.end();
}

/// Concatenate BCS-encoded fields into the expected encoding of a struct.
fun fields(parts: vector<vector<u8>>): vector<u8> {
    let mut out = vector[];
    parts.do!(|p| out.append(p));
    out
}

// ═══ Wrapping ══════════════════════════════════════════════════════════════

#[test]
/// The spec's deployment order: the publisher transfers the cap to the
/// governance multisig, and the multisig wraps it as itself. The wrapper stays
/// with the multisig that signed, so there is no owner argument a typo could
/// strand the cap behind, and the publisher keeps nothing.
fun governance_wraps_the_cap_and_keeps_the_wrapper() {
    let (mut s, clock) = setup();
    let w = s.take_from_sender<DelayedUpgradeCap>();
    assert_eq!(upgrade_delay::package_id(&w), package_id());
    assert_eq!(upgrade_delay::version(&w), 1);
    assert!(!upgrade_delay::has_pending(&w));
    assert!(!upgrade_delay::has_pending_owner(&w));
    s.return_to_sender(w);

    s.next_tx(PUBLISHER);
    assert!(!ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));
    assert!(!ts::has_most_recent_for_sender<UpgradeCap>(&s));
    s.next_tx(h::wallet());
    // The raw cap is inside the wrapper now, not loose in governance's hands.
    assert!(!ts::has_most_recent_for_sender<UpgradeCap>(&s));
    finish(s, clock);
}

#[test]
/// "Set the core upgrade policy to additive before wrapping" is done inside
/// `wrap`, not trusted to have happened. A fresh cap is compatible.
fun wrapping_makes_a_compatible_cap_additive() {
    let (mut s, clock) = setup();
    let w = s.take_from_sender<DelayedUpgradeCap>();
    assert_eq!(upgrade_delay::policy(&w), package::additive_policy());
    assert_eq!(upgrade_delay::policy(&w), ADDITIVE);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// A cap that is already additive is left additive.
fun an_additive_cap_stays_additive() {
    let (mut s, clock) = begin(h::wallet());
    let mut cap = package::test_publish(package_id(), s.ctx());
    package::only_additive_upgrades(&mut cap);
    wrap_cap(&mut s, cap);
    let w = s.take_from_sender<DelayedUpgradeCap>();
    assert_eq!(upgrade_delay::policy(&w), ADDITIVE);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// `wrap` only tightens. A cap already restricted to dependency upgrades must
/// not be loosened to additive.
fun a_dependency_only_cap_stays_dependency_only() {
    let (mut s, clock) = begin(h::wallet());
    let mut cap = package::test_publish(package_id(), s.ctx());
    package::only_dep_upgrades(&mut cap);
    wrap_cap(&mut s, cap);
    let w = s.take_from_sender<DelayedUpgradeCap>();
    assert_eq!(upgrade_delay::policy(&w), package::dep_only_policy());
    assert_eq!(upgrade_delay::policy(&w), DEP_ONLY);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The wrap is public record: which wrapper, which package, who holds it and
/// under what policy. The backend learns the canonical wrapper ID from here.
fun wrapping_emits_cap_wrapped_naming_governance() {
    let (mut s, clock) = begin(PUBLISHER);
    publish_to_governance(&mut s);
    governance_wraps(&mut s);
    let events = event::events_by_type<CapWrapped>();
    assert_eq!(events.length(), 1);
    let got = bcs::to_bytes(&events[0]);

    s.next_tx(h::wallet());
    let w = s.take_from_sender<DelayedUpgradeCap>();
    let expected = fields(vector[
        bcs::to_bytes(&object::id(&w)),
        bcs::to_bytes(&package_id()),
        bcs::to_bytes(&h::wallet()),
        bcs::to_bytes(&ADDITIVE),
    ]);
    assert_eq!(got, expected);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = splash_core::multisig::E_NOT_THIS_MULTISIG)]
/// The publisher holding the cap cannot wrap it on governance's behalf by
/// quoting governance's members: the sender must BE the multisig.
fun the_publisher_cannot_wrap_by_quoting_governances_keys() {
    let (mut s, clock) = begin(PUBLISHER);
    let cap = package::test_publish(package_id(), s.ctx());
    upgrade_delay::wrap(cap, h::keys(), h::weights(), h::threshold(), s.ctx());
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = splash_core::multisig::E_NOT_THIS_MULTISIG)]
/// One member of governance, signing alone with their own key, is not the
/// multisig and cannot wrap as it.
fun one_member_cannot_wrap_as_the_multisig() {
    let (mut s, clock) = begin(h::owner_1());
    let cap = package::test_publish(package_id(), s.ctx());
    upgrade_delay::wrap(cap, h::keys(), h::weights(), h::threshold(), s.ctx());
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = splash_core::multisig::E_NOT_THIS_MULTISIG)]
/// Keys that do not derive the sender are refused, even when they are the
/// right members in the wrong order: the address commits to the order.
fun keys_that_do_not_derive_the_sender_are_refused() {
    let (mut s, clock) = begin(h::wallet());
    let cap = package::test_publish(package_id(), s.ctx());
    let reordered = vector[h::passkey(1), h::passkey(0), h::passkey(2)];
    upgrade_delay::wrap(cap, reordered, h::weights(), h::threshold(), s.ctx());
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = splash_core::multisig::E_NOT_THIS_MULTISIG)]
/// A different threshold over the same members is a different multisig.
/// Governance cannot pass 1-of-3 to make itself look like something else.
fun a_different_threshold_does_not_derive_the_sender() {
    let (mut s, clock) = begin(h::wallet());
    let cap = package::test_publish(package_id(), s.ctx());
    upgrade_delay::wrap(cap, h::keys(), h::weights(), 3, s.ctx());
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = splash_core::multisig::E_NOT_A_QUORUM)]
/// A 1-of-1 "multisig" derives correctly but is one key. The cap that can
/// upgrade core must never be held by a single key.
fun a_single_signer_sender_cannot_wrap() {
    let (mut s, clock) = begin(PASSKEY_1_OF_1);
    let cap = package::test_publish(package_id(), s.ctx());
    upgrade_delay::wrap(cap, vector[h::passkey(0)], vector[1], 1, s.ctx());
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = splash_core::multisig::E_NOT_A_QUORUM)]
/// Threshold 2 with weights [2, 1, 1] reads as two-person but member one signs
/// alone. Single-signer is any one weight reaching the threshold.
fun a_disguised_single_signer_sender_cannot_wrap() {
    let (mut s, clock) = begin(WEIGHTED_SINGLE_SIGNER_2_1_1);
    let cap = package::test_publish(package_id(), s.ctx());
    upgrade_delay::wrap(cap, h::keys(), vector[2, 1, 1], 2, s.ctx());
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_CAP_ALREADY_USED)]
/// The cap must still be at version 1, so the wrapper's history is the
/// package's whole history and `wrap` cannot take over a cap someone already
/// upgraded with outside the delay.
fun a_used_cap_cannot_be_wrapped() {
    let (mut s, clock) = begin(h::wallet());
    let mut cap = package::test_publish(package_id(), s.ctx());
    let ticket = package::authorize_upgrade(&mut cap, package::compatible_policy(), DIGEST);
    package::commit_upgrade(&mut cap, package::test_upgrade(ticket));
    assert_eq!(package::version(&cap), 2);
    upgrade_delay::wrap(cap, h::keys(), h::weights(), h::threshold(), s.ctx());
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_UPGRADE_IN_PROGRESS)]
/// A cap with an outstanding ticket is mid-upgrade. Wrapping it would let the
/// ticket's upgrade run with no notice, then commit into the wrapper.
fun a_cap_mid_upgrade_cannot_be_wrapped() {
    let (mut s, clock) = begin(h::wallet());
    let mut cap = package::test_publish(package_id(), s.ctx());
    let ticket = package::authorize_upgrade(&mut cap, package::compatible_policy(), DIGEST);
    upgrade_delay::wrap(cap, h::keys(), h::weights(), h::threshold(), s.ctx());
    destroy(ticket);
    finish(s, clock);
}

// ═══ Proposing ═════════════════════════════════════════════════════════════

#[test]
/// The spec's numbers: 24 hours of notice, then a seven-day window.
fun the_notice_is_24_hours_and_the_window_7_days() {
    assert_eq!(upgrade_delay::delay_ms(), DAY_MS);
    assert_eq!(upgrade_delay::window_ms(), WEEK_MS);
}

#[test]
/// `UpgradeProposed` is the event every business owner is alerted to. It must
/// name the wrapper and package (so the backend can filter out fakes), the
/// digest (so the build can be checked), when it was proposed, the earliest
/// moment it can run, and the policy it will run under.
fun proposing_emits_the_event_owners_are_alerted_to() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    let events = event::events_by_type<UpgradeProposed>();
    assert_eq!(events.length(), 1);
    let (wrapper_id, package, digest, proposed_at_ms, eta_ms, policy) =
        upgrade_delay::unpack_upgrade_proposed_for_testing(events[0]);
    assert_eq!(wrapper_id, object::id(&w));
    assert_eq!(package, package_id());
    assert_eq!(digest, DIGEST);
    assert_eq!(proposed_at_ms, START_MS);
    assert_eq!(eta_ms, START_MS + DAY_MS);
    assert_eq!(policy, ADDITIVE);

    assert!(upgrade_delay::has_pending(&w));
    assert_eq!(upgrade_delay::pending_digest(&w), DIGEST);
    assert_eq!(upgrade_delay::pending_eta_ms(&w), START_MS + DAY_MS);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The proposal persists across transactions: proposing in one and reading in
/// the next shows the same digest and eta.
fun a_proposal_persists_between_transactions() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    s.next_tx(h::wallet());
    let w = s.take_from_sender<DelayedUpgradeCap>();
    assert!(upgrade_delay::has_pending(&w));
    assert_eq!(upgrade_delay::pending_digest(&w), DIGEST);
    assert_eq!(upgrade_delay::pending_eta_ms(&w), START_MS + DAY_MS);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_BAD_DIGEST)]
/// A digest is exactly 32 bytes. One short is refused.
fun a_31_byte_digest_is_refused() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST_31, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_BAD_DIGEST)]
/// One long is refused too.
fun a_33_byte_digest_is_refused() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST_33, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_BAD_DIGEST)]
/// An empty digest would announce nothing owners could check a build against.
fun an_empty_digest_is_refused() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, vector[], &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_ALREADY_PROPOSED)]
/// No second pending proposal. Replacing the digest under an older notice
/// would let a different build run sooner than 24 hours after owners heard of
/// it.
fun a_second_proposal_cannot_replace_the_first() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    upgrade_delay::propose(&mut w, OTHER_DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_ALREADY_PROPOSED)]
/// Proposing the same digest again is still a second proposal, and would
/// otherwise silently restart or overwrite the notice owners were given.
fun re_proposing_the_same_digest_is_refused() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS);
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_ALREADY_PROPOSED)]
/// A lapsed proposal is still pending until it is cancelled, so the cancel
/// (and its event) is always on record before the next proposal.
fun a_lapsed_proposal_must_be_cancelled_before_a_new_one() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS + WEEK_MS);
    upgrade_delay::propose(&mut w, OTHER_DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_UPGRADE_IN_PROGRESS)]
/// Between authorise and commit the cap has no package to upgrade. A proposal
/// then would announce an upgrade of nothing.
fun no_proposal_can_be_made_mid_upgrade() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS);
    let ticket = upgrade_delay::authorize_upgrade(&mut w, DIGEST, &clock);
    upgrade_delay::propose(&mut w, OTHER_DIGEST, &clock);
    upgrade_delay::commit_upgrade(&mut w, package::test_upgrade(ticket));
    s.return_to_sender(w);
    finish(s, clock);
}

// ═══ Authorising ═══════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = upgrade_delay::E_TOO_EARLY)]
/// Brief 3.8: an upgrade before 24 hours aborts. Immediately is the extreme.
fun authorising_immediately_aborts() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    try_authorize(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_TOO_EARLY)]
/// One millisecond before the notice has run is still too early.
fun authorising_one_millisecond_early_aborts() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS - 1);
    try_authorize(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// At exactly 24 hours the upgrade runs. The ticket carries the announced
/// digest (so the validators check the bytecode owners were told about) and
/// the stored additive policy (never a looser one), for core's package.
fun after_exactly_24_hours_the_upgrade_runs_with_the_stored_policy() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS);
    let ticket = upgrade_delay::authorize_upgrade(&mut w, DIGEST, &clock);
    assert_eq!(package::ticket_policy(&ticket), ADDITIVE);
    assert_eq!(*package::ticket_digest(&ticket), DIGEST);
    assert_eq!(package::ticket_package(&ticket), package_id());
    assert!(!upgrade_delay::has_pending(&w));
    let receipt = package::test_upgrade(ticket);
    let new_package = package::receipt_package(&receipt);
    upgrade_delay::commit_upgrade(&mut w, receipt);
    assert_eq!(upgrade_delay::version(&w), 2);
    // The live version moves; the identity every event uses does not.
    assert_eq!(upgrade_delay::latest_package_id(&w), new_package);
    assert_eq!(upgrade_delay::package_id(&w), package_id());
    assert_eq!(upgrade_delay::policy(&w), ADDITIVE);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The notice and the authorisation can be different transactions, days
/// apart, as they will be in practice.
fun the_upgrade_runs_in_a_later_transaction() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    clock.increment_for_testing(3 * DAY_MS);
    s.next_tx(h::wallet());
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    try_authorize(&mut w, DIGEST, &clock);
    assert_eq!(upgrade_delay::version(&w), 2);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The window's last millisecond: seven days after the notice ran, less one,
/// still authorises.
fun the_last_millisecond_of_the_window_still_authorises() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS + WEEK_MS - 1);
    try_authorize(&mut w, DIGEST, &clock);
    assert_eq!(upgrade_delay::version(&w), 2);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_PROPOSAL_LAPSED)]
/// Seven days after the notice ran, the proposal has lapsed. An old alert
/// owners have forgotten cannot be cashed in weeks later.
fun at_seven_days_past_the_notice_the_proposal_has_lapsed() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS + WEEK_MS);
    try_authorize(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_PROPOSAL_LAPSED)]
/// Long after the window, still lapsed.
fun a_month_later_the_proposal_has_lapsed() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(30 * DAY_MS);
    try_authorize(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_DIGEST_MISMATCH)]
/// Only the announced digest can be authorised, however long the wait.
fun only_the_announced_digest_can_be_authorised() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS);
    try_authorize(&mut w, OTHER_DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_NOTHING_PROPOSED)]
/// No notice, no upgrade.
fun authorising_with_nothing_proposed_aborts() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    try_authorize(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_NOTHING_PROPOSED)]
/// One notice buys one upgrade. A second upgrade with the same digest needs a
/// fresh proposal and a fresh 24 hours.
fun one_notice_buys_one_upgrade() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_once(&mut w, &mut clock, DIGEST);
    try_authorize(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_TOO_EARLY)]
/// The second upgrade gets its own full notice: the first one's elapsed time
/// does not carry over.
fun a_second_upgrade_needs_its_own_full_notice() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_once(&mut w, &mut clock, DIGEST);
    upgrade_delay::propose(&mut w, OTHER_DIGEST, &clock);
    clock.increment_for_testing(DAY_MS - 1);
    try_authorize(&mut w, OTHER_DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The wrapper keeps working across upgrades: a second proposal, after its own
/// notice, upgrades again, still under the additive policy.
fun two_upgrades_in_sequence_each_with_notice() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_once(&mut w, &mut clock, DIGEST);
    let v2_package = upgrade_delay::latest_package_id(&w);
    upgrade_delay::propose(&mut w, OTHER_DIGEST, &clock);
    clock.increment_for_testing(DAY_MS);
    let ticket = upgrade_delay::authorize_upgrade(&mut w, OTHER_DIGEST, &clock);
    assert_eq!(package::ticket_package(&ticket), v2_package);
    assert_eq!(package::ticket_policy(&ticket), ADDITIVE);
    upgrade_delay::commit_upgrade(&mut w, package::test_upgrade(ticket));
    assert_eq!(upgrade_delay::version(&w), 3);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// Owners are alerted again when the upgrade is actually authorised:
/// `UpgradeAuthorized` names the wrapper, the package, the digest and the
/// policy the ticket carries.
fun authorising_emits_upgrade_authorized() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS);
    let ticket = upgrade_delay::authorize_upgrade(&mut w, DIGEST, &clock);
    let events = event::events_by_type<UpgradeAuthorized>();
    assert_eq!(events.length(), 1);
    let expected = fields(vector[
        bcs::to_bytes(&object::id(&w)),
        bcs::to_bytes(&package_id()),
        bcs::to_bytes(&DIGEST),
        bcs::to_bytes(&ADDITIVE),
    ]);
    assert_eq!(bcs::to_bytes(&events[0]), expected);
    upgrade_delay::commit_upgrade(&mut w, package::test_upgrade(ticket));
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// Committing records the new version: `UpgradeCommitted` names the wrapper,
/// the package by its original id, the package version now live, and the
/// version number.
fun committing_emits_upgrade_committed() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS);
    let ticket = upgrade_delay::authorize_upgrade(&mut w, DIGEST, &clock);
    let receipt = package::test_upgrade(ticket);
    let new_package = package::receipt_package(&receipt);
    upgrade_delay::commit_upgrade(&mut w, receipt);
    let events = event::events_by_type<UpgradeCommitted>();
    assert_eq!(events.length(), 1);
    let expected = fields(vector[
        bcs::to_bytes(&object::id(&w)),
        bcs::to_bytes(&package_id()),
        bcs::to_bytes(&new_package),
        bcs::to_bytes(&2u64),
    ]);
    assert_eq!(bcs::to_bytes(&events[0]), expected);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = sui::package::EWrongUpgradeCap)]
/// A receipt from some other package's upgrade cannot be committed into the
/// wrapper: the wrapper's version only moves for upgrades it authorised.
fun a_receipt_from_another_cap_cannot_be_committed() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    let mut other = package::test_publish(other_package_id(), s.ctx());
    let ticket = package::authorize_upgrade(&mut other, COMPATIBLE, DIGEST);
    upgrade_delay::commit_upgrade(&mut w, package::test_upgrade(ticket));
    destroy(other);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// Section 7: the backend filters `UpgradeProposed` and `UpgradeAuthorized` to
/// the canonical wrapper ID and core's ORIGINAL package ID. After the first
/// upgrade, the next proposal must still carry an ID that filter accepts, or
/// every alert after the first upgrade is dropped as unrecognised and owners
/// get no notice of it.
fun a_proposal_after_an_upgrade_still_names_cores_original_package() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_once(&mut w, &mut clock, DIGEST);
    s.return_to_sender(w);

    s.next_tx(h::wallet());
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, OTHER_DIGEST, &clock);
    let events = event::events_by_type<UpgradeProposed>();
    assert_eq!(events.length(), 1);
    let (wrapper_id, package, _, _, _, _) = upgrade_delay::unpack_upgrade_proposed_for_testing(
        events[0],
    );
    assert_eq!(wrapper_id, object::id(&w));
    assert_eq!(package, package_id());
    upgrade_delay::cancel(&mut w);
    s.return_to_sender(w);
    finish(s, clock);
}

// ═══ Cancelling ════════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = upgrade_delay::E_NOTHING_PROPOSED)]
/// There is nothing to cancel before a proposal.
fun cancelling_nothing_aborts() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::cancel(&mut w);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// Cancelling withdraws the proposal and says so publicly, so owners alerted
/// to it learn it will not run.
fun cancelling_withdraws_the_proposal_and_emits_upgrade_cancelled() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    upgrade_delay::cancel(&mut w);
    assert!(!upgrade_delay::has_pending(&w));
    let events = event::events_by_type<UpgradeCancelled>();
    assert_eq!(events.length(), 1);
    let expected = fields(vector[
        bcs::to_bytes(&object::id(&w)),
        bcs::to_bytes(&package_id()),
        bcs::to_bytes(&DIGEST),
    ]);
    assert_eq!(bcs::to_bytes(&events[0]), expected);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_NOTHING_PROPOSED)]
/// A cancelled proposal cannot be authorised once its old eta arrives.
fun a_cancelled_proposal_cannot_be_authorised() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    upgrade_delay::cancel(&mut w);
    clock.increment_for_testing(DAY_MS);
    try_authorize(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_TOO_EARLY)]
/// Cancelling and re-proposing restarts the clock. A cancel cannot be used to
/// slip a different digest in under an older notice.
fun re_proposing_restarts_the_full_delay() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS - 10);
    upgrade_delay::cancel(&mut w);
    upgrade_delay::propose(&mut w, OTHER_DIGEST, &clock);
    clock.increment_for_testing(10);
    try_authorize(&mut w, OTHER_DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The re-proposal runs after its own full 24 hours, and its eta is measured
/// from the re-proposal, not from the first.
fun a_re_proposal_runs_after_its_own_full_delay() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS - 10);
    upgrade_delay::cancel(&mut w);
    upgrade_delay::propose(&mut w, OTHER_DIGEST, &clock);
    assert_eq!(upgrade_delay::pending_eta_ms(&w), START_MS + DAY_MS - 10 + DAY_MS);
    clock.increment_for_testing(DAY_MS);
    try_authorize(&mut w, OTHER_DIGEST, &clock);
    assert_eq!(upgrade_delay::version(&w), 2);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// A lapsed proposal can be cancelled and proposed again. Owners are alerted
/// again, and the new notice runs in full before the upgrade can.
fun a_lapsed_proposal_can_be_cancelled_and_proposed_again() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS + WEEK_MS);
    upgrade_delay::cancel(&mut w);
    assert!(!upgrade_delay::has_pending(&w));
    let relaunch = clock.timestamp_ms();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    assert_eq!(upgrade_delay::pending_eta_ms(&w), relaunch + DAY_MS);
    assert_eq!(event::events_by_type<UpgradeProposed>().length(), 2);
    clock.increment_for_testing(DAY_MS);
    try_authorize(&mut w, DIGEST, &clock);
    assert_eq!(upgrade_delay::version(&w), 2);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_TOO_EARLY)]
/// The proposal made again after a lapse still has to wait its own 24 hours.
fun a_re_proposal_after_a_lapse_waits_its_own_notice() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    clock.increment_for_testing(DAY_MS + WEEK_MS);
    upgrade_delay::cancel(&mut w);
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    try_authorize(&mut w, DIGEST, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

// ═══ Moving to a new governance multisig ═══════════════════════════════════

#[test]
/// Governance can rotate to a new quorum multisig, named by its members. The
/// pending owner is the address those members derive, and the announcement is
/// an event, with the same 24-hour eta as an upgrade.
fun governance_can_announce_a_move_to_a_quorum_multisig() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    assert!(upgrade_delay::has_pending_owner(&w));
    assert_eq!(upgrade_delay::pending_owner(&w), NEW_GOVERNANCE);
    let events = event::events_by_type<OwnerChangeProposed>();
    assert_eq!(events.length(), 1);
    let expected = fields(vector[
        bcs::to_bytes(&object::id(&w)),
        bcs::to_bytes(&NEW_GOVERNANCE),
        bcs::to_bytes(&(START_MS + DAY_MS)),
    ]);
    assert_eq!(bcs::to_bytes(&events[0]), expected);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_INVALID_OWNER)]
/// The new owner must not be single-signer. A 1-of-1 would put core's upgrade
/// power behind one key.
fun a_single_signer_new_owner_is_refused() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, vector[h::passkey(0)], vector[1], 1, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_INVALID_OWNER)]
/// Weights [2, 1, 1] at threshold 2 let member one sign alone: refused too.
fun a_disguised_single_signer_new_owner_is_refused() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, h::keys(), vector[2, 1, 1], 2, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = splash_core::multisig::E_UNREACHABLE_THRESHOLD)]
/// A threshold the weights cannot reach is an address nobody can ever sign
/// for. Moving the wrapper there would end upgrades and the owner-change path
/// with no notice that this was what happened.
fun a_new_owner_no_quorum_can_sign_for_is_refused() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 4, &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = splash_core::multisig::E_DUPLICATE_MEMBER)]
/// A configuration Sui would refuse to build is refused here as well: the
/// same key twice is not a real 2-of-2.
fun a_new_owner_with_a_duplicate_member_is_refused() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(
        &mut w,
        vector[h::passkey(0), h::passkey(0)],
        vector[1, 1],
        2,
        &clock,
    );
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_ALREADY_PROPOSED)]
/// One owner change at a time. A second announcement cannot replace the
/// first under its older notice.
fun a_second_owner_change_cannot_replace_the_first() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    upgrade_delay::propose_owner_change(&mut w, h::keys(), h::weights(), h::threshold(), &clock);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_TOO_EARLY)]
/// The move gives the same 24-hour notice as an upgrade, because whoever holds
/// the wrapper can upgrade. One millisecond short is too early.
fun completing_an_owner_change_one_millisecond_early_aborts() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS - 1);
    upgrade_delay::complete_owner_change(w, &clock);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_TOO_EARLY)]
/// Completing in the same moment as the announcement is refused.
fun completing_an_owner_change_immediately_aborts() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    upgrade_delay::complete_owner_change(w, &clock);
    finish(s, clock);
}

#[test]
/// At exactly 24 hours the same wrapper moves to the new owner, the pending
/// change is cleared, `OwnerChanged` is emitted, and the old owner no longer
/// has it.
fun at_24_hours_the_wrapper_moves_to_the_new_owner() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    let wrapper_id = object::id(&w);
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS);
    upgrade_delay::complete_owner_change(w, &clock);
    let events = event::events_by_type<OwnerChanged>();
    assert_eq!(events.length(), 1);
    let expected = fields(vector[bcs::to_bytes(&wrapper_id), bcs::to_bytes(&NEW_GOVERNANCE)]);
    assert_eq!(bcs::to_bytes(&events[0]), expected);

    s.next_tx(h::wallet());
    assert!(!ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));

    s.next_tx(NEW_GOVERNANCE);
    let w = s.take_from_sender<DelayedUpgradeCap>();
    assert_eq!(object::id(&w), wrapper_id);
    assert!(!upgrade_delay::has_pending_owner(&w));
    assert_eq!(upgrade_delay::package_id(&w), package_id());
    assert_eq!(upgrade_delay::policy(&w), ADDITIVE);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = sui::test_scenario::EEmptyInventory)]
/// Once moved, the old governance multisig cannot bring the wrapper into a
/// transaction: the protocol only admits an owned object for its owner.
fun the_old_owner_cannot_take_the_wrapper_after_the_move() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS);
    upgrade_delay::complete_owner_change(w, &clock);
    s.next_tx(h::wallet());
    let w = s.take_from_sender<DelayedUpgradeCap>();
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The new owner holds full governance: it can announce and run an upgrade
/// under the same notice.
fun the_new_owner_can_upgrade_under_the_same_notice() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS);
    upgrade_delay::complete_owner_change(w, &clock);

    s.next_tx(NEW_GOVERNANCE);
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_once(&mut w, &mut clock, DIGEST);
    assert_eq!(upgrade_delay::version(&w), 2);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The owner-change window's last millisecond still completes.
fun the_last_millisecond_of_the_owner_change_window_still_completes() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS + WEEK_MS - 1);
    upgrade_delay::complete_owner_change(w, &clock);
    s.next_tx(NEW_GOVERNANCE);
    assert!(ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_PROPOSAL_LAPSED)]
/// Seven days after its notice ran, an owner change has lapsed, the same
/// window as an upgrade.
fun an_owner_change_lapses_seven_days_after_its_notice() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS + WEEK_MS);
    upgrade_delay::complete_owner_change(w, &clock);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_NOTHING_PROPOSED)]
/// No announcement, no move.
fun completing_with_no_owner_change_aborts() {
    let (mut s, clock) = setup();
    let w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::complete_owner_change(w, &clock);
    finish(s, clock);
}

#[test]
/// Cancelling an owner change keeps the wrapper where it is and says so
/// publicly.
fun cancelling_an_owner_change_keeps_the_wrapper() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    upgrade_delay::cancel_owner_change(&mut w);
    assert!(!upgrade_delay::has_pending_owner(&w));
    let events = event::events_by_type<OwnerChangeCancelled>();
    assert_eq!(events.length(), 1);
    let expected = fields(vector[bcs::to_bytes(&object::id(&w)), bcs::to_bytes(&NEW_GOVERNANCE)]);
    assert_eq!(bcs::to_bytes(&events[0]), expected);
    s.return_to_sender(w);

    s.next_tx(h::wallet());
    assert!(ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_NOTHING_PROPOSED)]
/// A cancelled owner change cannot be completed when its old eta arrives.
fun a_cancelled_owner_change_cannot_complete() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    upgrade_delay::cancel_owner_change(&mut w);
    clock.increment_for_testing(DAY_MS);
    upgrade_delay::complete_owner_change(w, &clock);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_NOTHING_PROPOSED)]
/// There is no owner change to cancel before one is announced.
fun cancelling_no_owner_change_aborts() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::cancel_owner_change(&mut w);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = upgrade_delay::E_TOO_EARLY)]
/// Cancelling and announcing a different new owner restarts the notice. The
/// cancel cannot slip a different owner in under the older announcement.
fun re_proposing_an_owner_change_restarts_the_notice() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS - 10);
    upgrade_delay::cancel_owner_change(&mut w);
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 3, &clock);
    clock.increment_for_testing(10);
    upgrade_delay::complete_owner_change(w, &clock);
    finish(s, clock);
}

#[test]
/// A lapsed owner change can be cancelled and announced again, and the new
/// announcement completes after its own full notice.
fun a_lapsed_owner_change_can_be_cancelled_and_proposed_again() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS + WEEK_MS);
    upgrade_delay::cancel_owner_change(&mut w);
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    clock.increment_for_testing(DAY_MS);
    upgrade_delay::complete_owner_change(w, &clock);
    s.next_tx(NEW_GOVERNANCE);
    assert!(ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));
    finish(s, clock);
}

// ═══ Who can reach the wrapper ═════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = sui::test_scenario::EEmptyInventory)]
/// An owned object only enters a transaction its owner signed. A stranger
/// cannot take governance's wrapper, so cannot propose, authorise, cancel or
/// move it.
fun a_stranger_cannot_take_the_wrapper() {
    let (mut s, clock) = setup();
    s.next_tx(STRANGER);
    let w = s.take_from_sender<DelayedUpgradeCap>();
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = sui::test_scenario::EEmptyInventory)]
/// One member of governance, alone, does not hold the wrapper either.
fun a_single_member_cannot_take_the_wrapper() {
    let (mut s, clock) = setup();
    s.next_tx(h::owner_1());
    let w = s.take_from_sender<DelayedUpgradeCap>();
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
#[expected_failure(abort_code = sui::test_scenario::EEmptyInventory)]
/// The announced new owner holds nothing until the notice has run and the
/// move is completed.
fun the_announced_owner_has_nothing_before_the_move() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    s.return_to_sender(w);
    clock.increment_for_testing(DAY_MS);
    s.next_tx(NEW_GOVERNANCE);
    let w = s.take_from_sender<DelayedUpgradeCap>();
    s.return_to_sender(w);
    finish(s, clock);
}

// ═══ Taking power away (no notice) ═════════════════════════════════════════

#[test]
/// Restricting to dependency upgrades only removes power, so it needs no
/// notice and runs with nothing proposed.
fun restricting_to_dependency_upgrades_needs_no_notice() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::only_dep_upgrades(&mut w);
    assert_eq!(upgrade_delay::policy(&w), DEP_ONLY);
    assert!(!upgrade_delay::has_pending(&w));
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// The ticket carries the policy stored when it is authorised. Tightening
/// after a proposal was announced makes that upgrade run dependency-only.
fun tightening_after_a_proposal_tightens_its_ticket() {
    let (mut s, mut clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    upgrade_delay::only_dep_upgrades(&mut w);
    clock.increment_for_testing(DAY_MS);
    let ticket = upgrade_delay::authorize_upgrade(&mut w, DIGEST, &clock);
    assert_eq!(package::ticket_policy(&ticket), DEP_ONLY);
    upgrade_delay::commit_upgrade(&mut w, package::test_upgrade(ticket));
    assert_eq!(upgrade_delay::policy(&w), DEP_ONLY);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// A proposal on a dependency-only wrapper announces the dependency-only
/// policy, so owners are told the truth about what can change.
fun a_proposal_on_a_dependency_only_wrapper_announces_that_policy() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::only_dep_upgrades(&mut w);
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    let events = event::events_by_type<UpgradeProposed>();
    let (_, _, _, _, _, policy) = upgrade_delay::unpack_upgrade_proposed_for_testing(events[0]);
    assert_eq!(policy, DEP_ONLY);
    s.return_to_sender(w);
    finish(s, clock);
}

#[test]
/// Making the package immutable needs no notice. The wrapper is gone, so no
/// one holds upgrade power over core again, and `MadeImmutable` says so.
fun making_immutable_needs_no_notice() {
    let (mut s, clock) = setup();
    let w = s.take_from_sender<DelayedUpgradeCap>();
    let wrapper_id = object::id(&w);
    upgrade_delay::make_immutable(w);
    let events = event::events_by_type<MadeImmutable>();
    assert_eq!(events.length(), 1);
    let expected = fields(vector[bcs::to_bytes(&wrapper_id), bcs::to_bytes(&package_id())]);
    assert_eq!(bcs::to_bytes(&events[0]), expected);
    s.next_tx(h::wallet());
    assert!(!ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));
    assert!(!ts::has_most_recent_for_sender<UpgradeCap>(&s));
    finish(s, clock);
}

#[test]
/// Ending upgrades works even with an upgrade and an owner change pending: a
/// pending announcement cannot be used to block governance from giving the
/// power up.
fun making_immutable_works_with_announcements_pending() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::propose(&mut w, DIGEST, &clock);
    upgrade_delay::propose_owner_change(&mut w, new_keys(), vector[1, 1, 1], 2, &clock);
    upgrade_delay::make_immutable(w);
    s.next_tx(h::wallet());
    assert!(!ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));
    s.next_tx(NEW_GOVERNANCE);
    assert!(!ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));
    finish(s, clock);
}

#[test]
/// A dependency-only wrapper can still be made immutable: power only goes one
/// way.
fun a_dependency_only_wrapper_can_still_be_made_immutable() {
    let (mut s, clock) = setup();
    let mut w = s.take_from_sender<DelayedUpgradeCap>();
    upgrade_delay::only_dep_upgrades(&mut w);
    upgrade_delay::make_immutable(w);
    s.next_tx(h::wallet());
    assert!(!ts::has_most_recent_for_sender<DelayedUpgradeCap>(&s));
    finish(s, clock);
}

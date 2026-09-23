/// CapRegistry — break-glass for a capability that is lost or stolen.
///
/// ─── The problem Phase 6 created ────────────────────────────────────────────
///
/// Phase 6 deleted `mint_attestation_cap`, which took an `AdminCap` and an
/// arbitrary address and created attestation authority from nothing, any number
/// of times. That was right: authority created from nothing is the inverse of
/// every other rule in this package.
///
/// It left two holes, both stated honestly at the time and neither fixable
/// without this module:
///
///   * A LOST `AnchorCap` bricks anchoring permanently. Rotation is
///     one-in-one-out, so with no old cap to consume there is no replacement,
///     and `splash_core` publishes immutable.
///   * A STOLEN cap cannot be clawed back. `destroy_anchor_cap` is callable by
///     the holder, and a thief simply never calls it. The old comment offered
///     "off-chain rejection of anchors bearing the retired cap id", which is
///     not a control — it is a hope about what every future consumer will
///     remember to check.
///
/// ─── The mechanism ─────────────────────────────────────────────────────────
///
/// Every revocable capability carries a GENERATION, and this shared registry
/// holds the current one. A capability whose generation is not the registry's
/// is dead — not deprecated, not discouraged: every function that accepts one
/// asserts against the registry, and `scripts/check-cap-generations.mjs` fails
/// the build if a new consumer forgets to.
///
/// `AdminCap` can bump a generation. Doing so mints exactly one replacement and
/// kills every outstanding cap of that kind in the same transaction. So it
/// answers both holes with one lever, and it does NOT restore what Phase 6
/// removed: there is still never a second concurrent holder, because the bump
/// that creates the new cap is the same bump that kills the old.
///
/// ─── Why there is no timelock ───────────────────────────────────────────────
///
/// Every other emergency lever in this repository is delayed — `splash_meter`
/// makes a relaxation wait 48 hours, `business_account` makes a recovery wait
/// 72. It would be easy to add a third delay here and it would be theatre.
///
/// A delay protects against the holder of the lever abusing it. Ask what
/// `AdminCap` gains by rotating these two caps against their holders' wishes:
///
///   * `AnchorCap` attests and moves no value. `AdminCap` taking it over gains
///     the ability to write anchors it could already cause to be written.
///   * `ComplianceCap` only tightens, and `AdminCap` can already do everything
///     it does — `admin_set_parameters`, `admin_set_paused`, `admin_allow_pool`
///     are strictly larger powers held by the same key.
///
/// So the delay would buy nothing, and it would COST the thing this module
/// exists for: a stolen cap must die now, not in two days, and a thief given a
/// cancellation window would use it. The property that actually needs
/// protecting — no duplicate live capability — is enforced by the generation
/// itself, not by making the operator wait.
///
/// ─── What this deliberately does not cover ─────────────────────────────────
///
/// `AdminCap` and `TreasuryCap` have no generation. They are `store`
/// capabilities held by multisig addresses, not by servers, so "lost" means a
/// quorum of hardware failed simultaneously; and `AdminCap` is the key that
/// arms every break-glass here, so it cannot be the subject of one without
/// something above it to hold the lever. Their recovery is the key ceremony,
/// which is a human procedure and belongs in the runbook.
module splash_core::cap_registry;

use sui::clock::{Self, Clock};
use sui::event;

// ─── Abort codes (210-block, reserved for cap_registry) ─────────────────────
/// The capability presented is from a superseded generation. It was revoked by
/// a break-glass rotation and is permanently dead.
const E_STALE_GENERATION: u64 = 210;
const E_UNKNOWN_KIND: u64 = 211;
const E_INVALID_HOLDER: u64 = 212;
/// `execute` called with nothing armed, or armed for a different capability.
const E_NOTHING_ARMED: u64 = 213;
/// The ninety-second window closed. Arm it again.
const E_ARM_EXPIRED: u64 = 214;
/// Something is already armed and has not yet expired.
const E_ALREADY_ARMED: u64 = 215;

/// Capability kinds that can be revoked. Deliberately a closed set of `u8`
/// rather than a generic map: a registry that can name arbitrary kinds is a
/// registry whose contents nobody can enumerate by reading the source.
const KIND_ANCHOR: u8 = 0;
const KIND_COMPLIANCE: u8 = 1;

/// How long an armed break-glass stays executable: ninety seconds.
///
/// Not a notice period — a COMMIT WINDOW, and the distinction is the whole
/// design. The reasoning that ruled out a long delay still holds: a thief given
/// hours to notice and react would use them, and `AdminCap` gains nothing by
/// rotating a capability that moves no value.
///
/// What a window of this length buys is different and worth having. Revocation
/// becomes two deliberate transactions instead of one, so a misclick, a stale
/// script or a fat-fingered object id cannot kill a live operational capability
/// on its own. Ninety seconds is long enough to sign a second transaction from
/// a hardware wallet and far too short to be a window a thief could use.
///
/// If it lapses the arming is dead and the operator arms again. Nothing is left
/// half-done, because the generation moves only in `bump`.
const ARM_WINDOW_MS: u64 = 90_000;

/// The generation every capability is minted at when the package publishes.
/// `business_account::init` and `cap_registry::init` both hardcode it, and they
/// run in the same transaction — there is no ordering by which one could read
/// the other. A test asserts they agree.
const GENESIS: u64 = 0;

/// A break-glass that has been armed and not yet executed.
///
/// `drop` so re-arming after an expiry is a plain overwrite rather than a
/// two-step teardown.
public struct ArmedBreakGlass has store, drop {
    kind: u8,
    holder: address,
    reason: vector<u8>,
    armed_by: address,
    armed_at_ms: u64,
    expires_at_ms: u64,
}

public struct CapRegistry has key {
    id: UID,
    anchor_generation: u64,
    compliance_generation: u64,
    /// At most one at a time. Arming a second while the first is live would
    /// make "what is about to be revoked?" a question with two answers.
    armed: Option<ArmedBreakGlass>,
}

/// Emitted on every revocation. Security-critical, and the loudest event this
/// package produces: it means an operational capability was killed. Off-chain
/// monitoring should alert on any rotation it did not itself initiate.
/// Emitted when a revocation is armed. The operator has ninety seconds.
public struct BreakGlassArmed has copy, drop {
    registry_id: address,
    kind: u8,
    holder: address,
    reason: vector<u8>,
    armed_by: address,
    expires_at_ms: u64,
}

/// Emitted when an arming lapses or is abandoned without revoking anything.
public struct BreakGlassCleared has copy, drop {
    registry_id: address,
    kind: u8,
    armed_by: address,
    expired: bool,
}

public struct CapabilityRevoked has copy, drop {
    registry_id: address,
    kind: u8,
    previous_generation: u64,
    generation: u64,
    holder: address,
    /// Free text, recorded so the chain carries the operator's own reason —
    /// `b"lost"`, `b"suspected compromise"`, a ticket reference. Not parsed.
    reason: vector<u8>,
    revoked_by: address,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(CapRegistry {
        id: object::new(ctx),
        anchor_generation: GENESIS,
        compliance_generation: GENESIS,
        armed: option::none(),
    });
}

// ─── Reads, called on every use of a revocable capability ──────────────────

public fun anchor_generation(registry: &CapRegistry): u64 { registry.anchor_generation }
public fun compliance_generation(registry: &CapRegistry): u64 { registry.compliance_generation }
public fun genesis(): u64 { GENESIS }
public fun kind_anchor(): u8 { KIND_ANCHOR }
public fun kind_compliance(): u8 { KIND_COMPLIANCE }

/// Abort unless `generation` is the live one for `kind`.
///
/// The whole module reduces to this call. A capability object is not authority
/// on its own — possession plus a current generation is.
public fun assert_current(registry: &CapRegistry, kind: u8, generation: u64) {
    assert!(kind == KIND_ANCHOR || kind == KIND_COMPLIANCE, E_UNKNOWN_KIND);
    let live = if (kind == KIND_ANCHOR) registry.anchor_generation
        else registry.compliance_generation;
    assert!(generation == live, E_STALE_GENERATION);
}

public fun is_current(registry: &CapRegistry, kind: u8, generation: u64): bool {
    if (kind == KIND_ANCHOR) generation == registry.anchor_generation
    else if (kind == KIND_COMPLIANCE) generation == registry.compliance_generation
    else false
}

// ─── The lever ─────────────────────────────────────────────────────────────

/// Bump a generation, killing every outstanding capability of that kind.
///
/// `public(package)` on purpose. The generation and the replacement capability
/// must move together — a bump without a mint leaves the kind unusable, and a
/// mint without a bump is the arbitrary minting Phase 6 deleted. Exposing this
/// publicly would let those two halves be called separately, so the only
/// callers are `business_account::break_glass_anchor_cap` and
/// `compliance_config::break_glass_compliance_cap`, each of which does both in
/// one transaction.
/// Arm a revocation. Nothing is revoked yet.
///
/// `public(package)`, called by `business_account::arm_break_glass_anchor_cap`
/// and its compliance twin, so the two halves of a rotation cannot drift apart.
public(package) fun arm(
    registry: &mut CapRegistry,
    kind: u8,
    holder: address,
    reason: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(kind == KIND_ANCHOR || kind == KIND_COMPLIANCE, E_UNKNOWN_KIND);
    assert!(holder != @0x0, E_INVALID_HOLDER);

    let now = clock::timestamp_ms(clock);
    // An EXPIRED arming is not "already armed" — it is nothing, and the operator
    // is entitled to arm again without an extra clearing step.
    if (registry.armed.is_some() && now < registry.armed.borrow().expires_at_ms) {
        abort E_ALREADY_ARMED
    };

    let expires_at_ms = now + ARM_WINDOW_MS;
    registry.armed = option::some(ArmedBreakGlass {
        kind,
        holder,
        reason,
        armed_by: tx_context::sender(ctx),
        armed_at_ms: now,
        expires_at_ms,
    });

    event::emit(BreakGlassArmed {
        registry_id: object::uid_to_address(&registry.id),
        kind,
        holder,
        reason,
        armed_by: tx_context::sender(ctx),
        expires_at_ms,
    });
}

/// Consume the arming and bump the generation, inside the window.
///
/// The holder and the reason come from the ARMING, not from this call. A second
/// transaction that could name a different destination would make the first one
/// decorative.
public(package) fun bump(
    registry: &mut CapRegistry,
    kind: u8,
    clock: &Clock,
    ctx: &TxContext,
): (u64, address) {
    assert!(kind == KIND_ANCHOR || kind == KIND_COMPLIANCE, E_UNKNOWN_KIND);
    assert!(registry.armed.is_some(), E_NOTHING_ARMED);
    assert!(registry.armed.borrow().kind == kind, E_NOTHING_ARMED);

    let now = clock::timestamp_ms(clock);
    if (now >= registry.armed.borrow().expires_at_ms) {
        // Clear it on the way out, so the operator's next `arm` is a plain arm
        // rather than a puzzle about why the registry says something is pending.
        let dead = registry.armed.extract();
        event::emit(BreakGlassCleared {
            registry_id: object::uid_to_address(&registry.id),
            kind: dead.kind,
            armed_by: dead.armed_by,
            expired: true,
        });
        abort E_ARM_EXPIRED
    };

    let armed = registry.armed.extract();
    let holder = armed.holder;
    let reason = armed.reason;

    let previous = if (kind == KIND_ANCHOR) registry.anchor_generation
        else registry.compliance_generation;
    let next = previous + 1;
    if (kind == KIND_ANCHOR) {
        registry.anchor_generation = next;
    } else {
        registry.compliance_generation = next;
    };

    event::emit(CapabilityRevoked {
        registry_id: object::uid_to_address(&registry.id),
        kind,
        previous_generation: previous,
        generation: next,
        holder,
        reason,
        revoked_by: tx_context::sender(ctx),
    });

    (next, holder)
}

/// Abandon an arming before it is used or expires.
public(package) fun disarm(registry: &mut CapRegistry, ctx: &TxContext) {
    assert!(registry.armed.is_some(), E_NOTHING_ARMED);
    let dead = registry.armed.extract();
    event::emit(BreakGlassCleared {
        registry_id: object::uid_to_address(&registry.id),
        kind: dead.kind,
        armed_by: tx_context::sender(ctx),
        expired: false,
    });
}

// ─── Views on the armed state ───────────────────────────────────────────────

public fun is_armed(registry: &CapRegistry, clock: &Clock): bool {
    registry.armed.is_some() && clock::timestamp_ms(clock) < registry.armed.borrow().expires_at_ms
}
public fun armed_kind(registry: &CapRegistry): u8 { registry.armed.borrow().kind }
public fun armed_holder(registry: &CapRegistry): address { registry.armed.borrow().holder }
public fun armed_expires_at_ms(registry: &CapRegistry): u64 {
    registry.armed.borrow().expires_at_ms
}
public fun arm_window_ms(): u64 { ARM_WINDOW_MS }

#[test_only]
public fun new_for_testing(ctx: &mut TxContext): CapRegistry {
    CapRegistry {
        id: object::new(ctx),
        anchor_generation: GENESIS,
        compliance_generation: GENESIS,
        armed: option::none(),
    }
}

#[test_only]
public fun share_for_testing(registry: CapRegistry) {
    transfer::share_object(registry);
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}

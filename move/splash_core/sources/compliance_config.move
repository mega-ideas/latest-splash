/// Shared settlement risk controls with a dedicated operator capability.
///
/// The capability pattern follows OpenZeppelin's Sui architecture guidance:
/// privileged authority is represented by an owned, unforgeable object while
/// the bounded configuration remains a shared object usable in PTBs.
module splash_core::compliance_config;

use splash_core::business_account::AdminCap;
use splash_core::cap_registry::{Self, CapRegistry};
use sui::clock::Clock;
use sui::event;
use sui::vec_set::{Self, VecSet};

const MAX_DEVIATION_PPM: u64 = 10_000;
const MAX_STALENESS_MS: u64 = 600_000;
const MAX_SLIPPAGE_BPS: u64 = 1_000;
/// Upper bound on the DeepBook pool whitelist. `VecSet` membership is a linear
/// scan, so this keeps the hot-path guard's gas cost constant-ish and bounded.
/// One pool per settled corridor is the expected shape; 8 is generous.
const MAX_ALLOWED_POOLS: u64 = 8;

const E_INVALID_CONFIG: u64 = 350;
const E_INVALID_CAP: u64 = 351;
const E_SETTLEMENT_PAUSED: u64 = 352;
/// The `Pool` passed to the liquidity guard is not on the whitelist (S-12).
const E_POOL_NOT_ALLOWED: u64 = 353;
/// Whitelist would exceed `MAX_ALLOWED_POOLS`.
const E_TOO_MANY_POOLS: u64 = 354;
/// Whitelist would be left empty, which bricks every settlement path. Use
/// `set_paused` for an intentional halt; swap pools by adding before removing.
const E_POOL_LIST_EMPTY: u64 = 355;
/// A `ComplianceCap` call tried to LOOSEN a parameter. Relaxations are
/// `AdminCap`-gated; see the note on the cap.
const E_NOT_A_TIGHTENING: u64 = 356;

public struct ComplianceConfig has key {
    id: UID,
    max_deviation_ppm: u64,
    max_staleness_ms: u64,
    max_slippage_bps: u64,
    min_depth_base_units: u64,
    /// Minimum gross settlement size, in the settled coin's MINOR UNITS.
    /// Configurable rather than a constant because the unit depends on the
    /// coin: $100 is 100_000_000 for 6-decimal USDC but a different figure for
    /// any other decimals. Zero is rejected by `assert_valid`, so the floor can
    /// never be silently disabled.
    min_settlement_amount: u64,
    /// S-12 fix. Object IDs of the DeepBook pools the liquidity guard is
    /// allowed to read. Without this, `assert_deepbook_liquidity` trusts a
    /// caller-supplied `Pool` — and DeepBook pools are permissionlessly
    /// creatable, so an attacker (or a compromised operator holding `AdminCap`)
    /// could stand up a pool, seed it with their own liquidity, and satisfy the
    /// depth and slippage checks trivially while draining the shared
    /// `SettlementPool` through `settle_batch`. The guard is only meaningful if
    /// the venue it measures is one the protocol chose.
    allowed_deepbook_pools: VecSet<ID>,
    paused: bool,
}

/// ComplianceCap — SUBTRACTIVE authority, and subtractive BY TYPE.
///
/// Every function in this package that takes `&ComplianceCap` can only make
/// the controls stricter: lower the tolerated peg deviation, staleness or
/// slippage; raise the required depth or the settlement floor; remove a venue;
/// pause. There is no function taking this cap that loosens anything, and
/// `scripts/check-compliance-subtractive.mjs` fails the build if one appears.
///
/// The property matters because the compliance key lives closer to people and
/// to process than the cold multisig does. Whoever holds it can stop money
/// moving and can never make it easier to move — so it can be handed to a
/// compliance function without handing over a way to widen the controls, and a
/// compromise of it is a denial-of-service, never a loosening.
///
/// Loosening — raising a tolerance, adding a venue, unpausing — is `AdminCap`,
/// which is the cold 2-of-3 multisig.
///
/// Phase 7 added the generation. A lost `ComplianceCap` is not a brick —
/// `AdminCap` can do everything this cap does — so break-glass here is about
/// REVOCATION, not recovery: a stolen compliance key can pause settlement
/// repeatedly, and until Phase 7 nothing could take it back.
public struct ComplianceCap has key {
    id: UID,
    config_id: ID,
    generation: u64,
}

public struct ComplianceConfigUpdated has copy, drop {
    config_id: address,
    max_deviation_ppm: u64,
    max_staleness_ms: u64,
    max_slippage_bps: u64,
    min_depth_base_units: u64,
    min_settlement_amount: u64,
    allowed_deepbook_pools: vector<ID>,
    paused: bool,
}

/// Emitted on every whitelist mutation. Security-critical: off-chain monitoring
/// should alert on any pool it did not itself authorize.
public struct DeepbookPoolAllowed has copy, drop {
    config_id: address,
    pool_id: ID,
}

public struct DeepbookPoolDisallowed has copy, drop {
    config_id: address,
    pool_id: ID,
}

/// Create the shared controls once after a fresh package publish.
///
/// `allowed_deepbook_pools` must name at least one pool: the config is useless
/// without a venue, and defaulting to "empty means allow everything" is exactly
/// the failure S-12 describes. Duplicate IDs abort (`vec_set::from_keys`).
public fun create(
    _admin: &AdminCap,
    registry: &CapRegistry,
    max_deviation_ppm: u64,
    max_staleness_ms: u64,
    max_slippage_bps: u64,
    min_depth_base_units: u64,
    min_settlement_amount: u64,
    allowed_deepbook_pools: vector<ID>,
    ctx: &mut TxContext,
) {
    assert_valid(max_deviation_ppm, max_staleness_ms, max_slippage_bps, min_depth_base_units, min_settlement_amount);
    assert!(!allowed_deepbook_pools.is_empty(), E_POOL_LIST_EMPTY);
    assert!(allowed_deepbook_pools.length() <= MAX_ALLOWED_POOLS, E_TOO_MANY_POOLS);

    let config = ComplianceConfig {
        id: object::new(ctx),
        max_deviation_ppm,
        max_staleness_ms,
        max_slippage_bps,
        min_depth_base_units,
        min_settlement_amount,
        allowed_deepbook_pools: vec_set::from_keys(allowed_deepbook_pools),
        paused: false,
    };
    let config_id = object::id(&config);
    let cap = ComplianceCap {
        id: object::new(ctx),
        config_id,
        generation: cap_registry::compliance_generation(registry),
    };
    transfer::share_object(config);
    transfer::transfer(cap, ctx.sender());
}

/// Tighten the numeric risk parameters. Every argument must be at least as
/// strict as what is stored, or the call aborts.
///
/// "Stricter" differs per field and the asymmetry is the whole point:
/// tolerances (deviation, staleness, slippage) may only go DOWN, requirements
/// (depth, settlement floor) may only go UP. Passing the current value is
/// allowed, so tightening one field does not force a caller to restate the
/// others exactly.
///
/// The pool whitelist is deliberately not settable here — it moves only
/// through `admin_allow_pool` / `disallow_pool`, so every venue change emits
/// its own event instead of hiding inside a threshold tweak.
public fun tighten(
    config: &mut ComplianceConfig,
    cap: &ComplianceCap,
    registry: &CapRegistry,
    max_deviation_ppm: u64,
    max_staleness_ms: u64,
    max_slippage_bps: u64,
    min_depth_base_units: u64,
    min_settlement_amount: u64,
) {
    assert_compliance_cap(registry, cap);
    assert!(cap.config_id == object::id(config), E_INVALID_CAP);
    assert_valid(max_deviation_ppm, max_staleness_ms, max_slippage_bps, min_depth_base_units, min_settlement_amount);

    assert!(max_deviation_ppm <= config.max_deviation_ppm, E_NOT_A_TIGHTENING);
    assert!(max_staleness_ms <= config.max_staleness_ms, E_NOT_A_TIGHTENING);
    assert!(max_slippage_bps <= config.max_slippage_bps, E_NOT_A_TIGHTENING);
    assert!(min_depth_base_units >= config.min_depth_base_units, E_NOT_A_TIGHTENING);
    assert!(min_settlement_amount >= config.min_settlement_amount, E_NOT_A_TIGHTENING);

    config.max_deviation_ppm = max_deviation_ppm;
    config.max_staleness_ms = max_staleness_ms;
    config.max_slippage_bps = max_slippage_bps;
    config.min_depth_base_units = min_depth_base_units;
    config.min_settlement_amount = min_settlement_amount;
    emit_update(config);
}

/// Relax the numeric risk parameters. `AdminCap` — the cold multisig — because
/// this is the only direction that can make money easier to move.
///
/// It accepts a tightening too. Splitting "relax" from "set" would mean a
/// mixed change (one tolerance up, one down) needed two transactions and left
/// the config in an intermediate state between them.
public fun admin_set_parameters(
    _admin: &AdminCap,
    config: &mut ComplianceConfig,
    max_deviation_ppm: u64,
    max_staleness_ms: u64,
    max_slippage_bps: u64,
    min_depth_base_units: u64,
    min_settlement_amount: u64,
) {
    assert_valid(max_deviation_ppm, max_staleness_ms, max_slippage_bps, min_depth_base_units, min_settlement_amount);
    config.max_deviation_ppm = max_deviation_ppm;
    config.max_staleness_ms = max_staleness_ms;
    config.max_slippage_bps = max_slippage_bps;
    config.min_depth_base_units = min_depth_base_units;
    config.min_settlement_amount = min_settlement_amount;
    emit_update(config);
}

/// Rotate the operator capability to a new custodian. `ComplianceCap` has no
/// `store` ability, so without this function the cap could never leave the
/// address that created the config (audit fix S-03: key rotation).
public fun transfer_cap(cap: ComplianceCap, recipient: address) {
    transfer::transfer(cap, recipient);
}

/// Add a DeepBook venue to the whitelist (S-12). Aborts on a duplicate, so a
/// replayed call cannot silently succeed.
///
/// `AdminCap`, not `ComplianceCap`: adding a venue is the single most
/// consequential loosening in this file. S-12 is precisely the attack where
/// someone stands up their own pool, seeds it with their own liquidity and
/// satisfies the depth and slippage guards trivially — so the power to name a
/// venue belongs with the cold multisig, not with the key that is allowed to
/// stop things.
public fun admin_allow_pool(_admin: &AdminCap, config: &mut ComplianceConfig, pool_id: ID) {
    assert!(config.allowed_deepbook_pools.length() < MAX_ALLOWED_POOLS, E_TOO_MANY_POOLS);
    config.allowed_deepbook_pools.insert(pool_id);

    event::emit(DeepbookPoolAllowed { config_id: object::id_address(config), pool_id });
    emit_update(config);
}

/// Remove a venue. The last entry cannot be removed: an empty whitelist would
/// abort every settlement, which is `set_paused`'s job and should not be
/// reachable by accident. To swap venues, `allow_pool` the new one first.
public fun disallow_pool(
    config: &mut ComplianceConfig,
    cap: &ComplianceCap,
    registry: &CapRegistry,
    pool_id: ID,
) {
    assert_compliance_cap(registry, cap);
    assert!(cap.config_id == object::id(config), E_INVALID_CAP);
    assert!(config.allowed_deepbook_pools.length() > 1, E_POOL_LIST_EMPTY);
    // `vec_set::remove` aborts if absent, so a typo'd ID fails loudly.
    config.allowed_deepbook_pools.remove(&pool_id);

    event::emit(DeepbookPoolDisallowed { config_id: object::id_address(config), pool_id });
    emit_update(config);
}

/// Halt settlement. One direction only — `ComplianceCap` cannot resume,
/// because resuming is a loosening and this cap does not loosen. Resuming is
/// `admin_set_paused`.
public fun pause(config: &mut ComplianceConfig, cap: &ComplianceCap, registry: &CapRegistry) {
    assert_compliance_cap(registry, cap);
    assert!(cap.config_id == object::id(config), E_INVALID_CAP);
    config.paused = true;
    emit_update(config);
}

/// Pause or resume, AdminCap-gated. Since Phase 6 this is also the ONLY way to
/// resume: `pause` is one-directional.
///
/// MUST ship before the immutable publish. `pause` is `ComplianceCap`-only;
/// `ComplianceCap` is `key` with no `store`, is minted once by `create`, and can
/// move only via `transfer_cap` called BY ITS HOLDER. There is no recovery path.
/// In an immutable package, losing that cap while `paused == true` deadlocks
/// `assert_pegged` — and therefore every settlement path — permanently, with no
/// way back.
///
/// Yes, this weakens the two-key pause: `AdminCap` can now unpause unilaterally.
/// That is the smaller harm. A permanent, unrecoverable liveness brick is
/// strictly worse than a cold-multisig quorum being able to resume, and
/// everything downstream of an unpause is still gated by the peg, the DeepBook
/// guard, the minimum and the venue whitelist.
public fun admin_set_paused(_admin: &AdminCap, config: &mut ComplianceConfig, paused: bool) {
    config.paused = paused;
    emit_update(config);
}

/// BREAK-GLASS. Revoke every outstanding `ComplianceCap` and mint one
/// replacement, bound to `config`.
///
/// Unlike the anchor cap, losing this one bricks nothing — `AdminCap` already
/// holds strictly larger versions of everything it does. This exists for the
/// other half: a compliance key believed compromised could, until now, pause
/// settlement as often as it liked forever, and `transfer_cap` is callable only
/// BY ITS HOLDER, so there was no way to take it back.
public fun arm_break_glass_compliance_cap(
    _admin: &AdminCap,
    registry: &mut CapRegistry,
    holder: address,
    reason: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    cap_registry::arm(registry, cap_registry::kind_compliance(), holder, reason, clock, ctx);
}

/// Execute an armed compliance-cap revocation, inside the ninety-second window.
public fun execute_break_glass_compliance_cap(
    _admin: &AdminCap,
    registry: &mut CapRegistry,
    config: &ComplianceConfig,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (generation, holder) =
        cap_registry::bump(registry, cap_registry::kind_compliance(), clock, ctx);
    transfer::transfer(
        ComplianceCap { id: object::new(ctx), config_id: object::id(config), generation },
        holder,
    );
}

/// The check every consumer of a `ComplianceCap` must make. Enforced by
/// `scripts/check-cap-generations.mjs`.
public fun assert_compliance_cap(registry: &CapRegistry, cap: &ComplianceCap) {
    cap_registry::assert_current(registry, cap_registry::kind_compliance(), cap.generation);
}

public fun compliance_cap_generation(cap: &ComplianceCap): u64 { cap.generation }

public fun assert_active(config: &ComplianceConfig) {
    assert!(!config.paused, E_SETTLEMENT_PAUSED);
}

/// Hot-path guard called by `peg_monitor::assert_deepbook_liquidity` before it
/// reads a single field off the pool (S-12).
public fun assert_pool_allowed(config: &ComplianceConfig, pool_id: ID) {
    assert!(config.allowed_deepbook_pools.contains(&pool_id), E_POOL_NOT_ALLOWED);
}

public fun max_deviation_ppm(config: &ComplianceConfig): u64 { config.max_deviation_ppm }
public fun max_staleness_ms(config: &ComplianceConfig): u64 { config.max_staleness_ms }
public fun max_slippage_bps(config: &ComplianceConfig): u64 { config.max_slippage_bps }
public fun min_depth_base_units(config: &ComplianceConfig): u64 { config.min_depth_base_units }
public fun min_settlement_amount(config: &ComplianceConfig): u64 { config.min_settlement_amount }
public fun paused(config: &ComplianceConfig): bool { config.paused }

public fun is_pool_allowed(config: &ComplianceConfig, pool_id: ID): bool {
    config.allowed_deepbook_pools.contains(&pool_id)
}

public fun allowed_deepbook_pools(config: &ComplianceConfig): vector<ID> {
    *config.allowed_deepbook_pools.keys()
}

fun assert_valid(
    max_deviation_ppm: u64,
    max_staleness_ms: u64,
    max_slippage_bps: u64,
    min_depth_base_units: u64,
    min_settlement_amount: u64,
) {
    assert!(max_deviation_ppm > 0 && max_deviation_ppm <= MAX_DEVIATION_PPM, E_INVALID_CONFIG);
    assert!(max_staleness_ms > 0 && max_staleness_ms <= MAX_STALENESS_MS, E_INVALID_CONFIG);
    assert!(max_slippage_bps > 0 && max_slippage_bps <= MAX_SLIPPAGE_BPS, E_INVALID_CONFIG);
    assert!(min_depth_base_units > 0, E_INVALID_CONFIG);
    // A zero floor would disable the minimum entirely — reject it.
    assert!(min_settlement_amount > 0, E_INVALID_CONFIG);
}

fun emit_update(config: &ComplianceConfig) {
    event::emit(ComplianceConfigUpdated {
        config_id: object::id_address(config),
        max_deviation_ppm: config.max_deviation_ppm,
        max_staleness_ms: config.max_staleness_ms,
        max_slippage_bps: config.max_slippage_bps,
        min_depth_base_units: config.min_depth_base_units,
        min_settlement_amount: config.min_settlement_amount,
        allowed_deepbook_pools: *config.allowed_deepbook_pools.keys(),
        paused: config.paused,
    });
}

/// Public read of the whitelist ceiling so off-chain tooling can validate a
/// proposed pool set before submitting a transaction.
public fun max_allowed_pools(): u64 { MAX_ALLOWED_POOLS }

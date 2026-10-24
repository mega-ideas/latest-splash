/// Shared settlement risk controls with a dedicated operator capability.
///
/// The capability pattern follows OpenZeppelin's Sui architecture guidance:
/// privileged authority is represented by an owned, unforgeable object while
/// the bounded configuration remains a shared object usable in PTBs.
module splash_core::compliance_config;

use splash_core::business_account::AdminCap;
use splash_core::cap_registry::{Self, CapRegistry};
use splash_core::multisig;
use std::string::String;
use std::type_name;
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

/// The notice an addition to any v2 registry must give before it takes
/// effect: the same 24 hours `splash_upgrade_delay` gives a package upgrade.
const ADDITION_NOTICE_MS: u64 = 86_400_000;
/// After its notice, an addition must be activated within seven days or it
/// lapses. One alert cannot be cashed in months later, once owners have
/// stopped watching.
const ADDITION_WINDOW_MS: u64 = 604_800_000;
/// Each registry is a short list scanned on the payment path.
const MAX_REGISTRY_ENTRIES: u64 = 8;
const MAX_PENDING_ADDITIONS: u64 = 8;

const REGISTRY_ASSET: u8 = 1;
const REGISTRY_SETTLEMENT_APP: u8 = 2;
const REGISTRY_BRIDGE_ADAPTER: u8 = 3;

/// The most any intent may ever be charged, in basis points: 2%. Written into
/// the package, so no governance change can raise `max_fee_bps` past it.
const MAX_FEE_BPS_CEILING: u64 = 200;

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

// ─── v2 registries (D11) ───────────────────────────────────────────────────
/// The asset is not on the accepted-asset registry.
const E_ASSET_NOT_ACCEPTED: u64 = 357;
/// The witness is not a registered settlement app.
const E_NOT_A_SETTLEMENT_APP: u64 = 358;
/// The witness is not a registered bridge adapter.
const E_NOT_A_BRIDGE_ADAPTER: u64 = 359;
/// Registry kind is not 1 (asset), 2 (settlement app) or 3 (bridge adapter).
const E_UNKNOWN_REGISTRY: u64 = 360;
/// The type is already on that registry.
const E_ALREADY_REGISTERED: u64 = 361;
/// The same addition is already waiting out its notice.
const E_ALREADY_PROPOSED: u64 = 362;
/// There is no such pending addition.
const E_NOT_PROPOSED: u64 = 363;
/// The 24-hour notice for this addition has not run yet.
const E_NOTICE_NOT_RUN: u64 = 364;
/// The type is not on that registry, so there is nothing to remove.
const E_NOT_REGISTERED: u64 = 365;
/// A registry, or the list of pending additions, is full.
const E_REGISTRY_FULL: u64 = 366;
/// The addition's window closed seven days after its notice ran. Propose it
/// again, so owners are alerted again.
const E_ADDITION_LAPSED: u64 = 367;
/// Removing the last accepted asset would stop every payment until a 24-hour
/// addition runs. Use `pause` to halt.
const E_LAST_ASSET: u64 = 368;
// 369 is retired with the legacy approval path's one-way switch
// (E_LEGACY_DISABLED, raised only by the earlier v2 testnet package).

// ─── The fee (decision 1) ──────────────────────────────────────────────────
/// The proposed `max_fee_bps` is above `MAX_FEE_BPS_CEILING` (2%).
const E_FEE_ABOVE_CEILING: u64 = 370;
/// The proposed fee address is a multisig one member can sign for alone.
const E_FEE_ADDRESS_SINGLE_SIGNER: u64 = 371;
/// A fee change is already waiting. Activate or cancel it first.
const E_FEE_CHANGE_PENDING: u64 = 372;
/// There is no pending fee change to activate or cancel.
const E_NO_FEE_CHANGE: u64 = 373;
/// The 24-hour notice for the fee change has not run yet.
const E_FEE_NOTICE_NOT_RUN: u64 = 374;
/// The fee change's window closed seven days after its notice ran.
const E_FEE_CHANGE_LAPSED: u64 = 375;
/// The activation names a different fee change from the one pending.
const E_FEE_CHANGE_MISMATCH: u64 = 376;

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
    ///
    /// On the v2 paths it is the floor of a BANK PAYOUT (kind 1), together
    /// with the 99 USDC platform minimum: whichever is larger, checked when
    /// the intent opens and again when it settles (`payment_intent`). Wallet,
    /// Splash-business and cross-chain payments have no floor.
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
    /// v2 (D6, D11). The coin types a payment may settle in, as
    /// `type_name::with_defining_ids` strings. Seeded with native USDC.
    accepted_assets: VecSet<String>,
    /// v2 (D11). Witness types allowed to open and settle intents on a
    /// business's behalf — `splash_spend`'s `SettleWitness`, once registered.
    settlement_apps: VecSet<String>,
    /// v2. Witness types allowed to discharge a `BridgeObligation`, i.e. to
    /// burn a cross-chain payment through CCTP. Empty until the CCTP V2
    /// adapter ships.
    bridge_adapters: VecSet<String>,
    /// Additions waiting out their 24-hour notice.
    pending_additions: vector<PendingAddition>,
    /// Decision 1. Where Splash's fee leg is paid: a Splash finance multisig,
    /// derived on chain from its members and never one any member can sign
    /// for alone. `none` until the first fee change activates. Read at
    /// settlement; never a PTB argument.
    fee_address: Option<address>,
    /// The most an intent may carry, in basis points, at most
    /// `MAX_FEE_BPS_CEILING`. 0 at creation: the fee starts off.
    max_fee_bps: u64,
    /// The most one payment's fee may be, in the asset's minor units.
    fee_cap_minor: u64,
    /// A fee change waiting out its 24-hour notice. One at a time.
    pending_fee_change: Option<PendingFeeChange>,
}

/// The single right to create the config, minted once at publish.
///
/// Every money path takes `&ComplianceConfig`, and the PTB author chooses
/// which object to pass. If a second config could exist, a staff member could
/// pass the unpaused one, or one that accepts another asset, and every pause,
/// removal and 24-hour addition on the real one would stop nothing. With one
/// ticket and no way to mint another, there is exactly one config.
public struct ConfigTicket has key {
    id: UID,
}

/// An addition to one of the v2 registries, announced and not yet in force.
public struct PendingFeeChange has store, drop, copy {
    fee_address: address,
    max_fee_bps: u64,
    fee_cap_minor: u64,
    proposed_at_ms: u64,
    eta_ms: u64,
}

public struct PendingAddition has store, drop, copy {
    registry: u8,
    type_name: String,
    proposed_at_ms: u64,
    eta_ms: u64,
}

/// ComplianceCap — SUBTRACTIVE authority, and subtractive BY TYPE.
///
/// Every function in this package that takes `&ComplianceCap` can only make
/// the controls stricter: lower the tolerated peg deviation, staleness or
/// slippage; raise the required depth or the settlement floor; remove a venue
/// or a registry entry; withdraw a pending registry addition or fee change;
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

/// An addition to a v2 registry was announced. The backend alerts every
/// business owner: a new asset, a new app that may move money under spending
/// rules, or a new bridge adapter is 24 hours away.
public struct RegistryAdditionProposed has copy, drop {
    config_id: address,
    registry: u8,
    type_name: String,
    proposed_at_ms: u64,
    eta_ms: u64,
}

public struct RegistryAdditionActivated has copy, drop {
    config_id: address,
    registry: u8,
    type_name: String,
}

public struct RegistryAdditionCancelled has copy, drop {
    config_id: address,
    registry: u8,
    type_name: String,
}

public struct RegistryEntryRemoved has copy, drop {
    config_id: address,
    registry: u8,
    type_name: String,
}

/// A change to Splash's fee parameters was announced. These are Splash's own
/// terms (where the fee goes, the most bps an intent may carry, the cap per
/// payment), never any client's payment.
public struct FeeChangeProposed has copy, drop {
    config_id: address,
    fee_address: address,
    max_fee_bps: u64,
    fee_cap_minor: u64,
    proposed_at_ms: u64,
    eta_ms: u64,
}

public struct FeeChangeActivated has copy, drop {
    config_id: address,
    fee_address: address,
    max_fee_bps: u64,
    fee_cap_minor: u64,
}

public struct FeeChangeCancelled has copy, drop {
    config_id: address,
    fee_address: address,
    max_fee_bps: u64,
    fee_cap_minor: u64,
}

/// Mint the one `ConfigTicket`, to the publisher.
fun init(ctx: &mut TxContext) {
    transfer::transfer(ConfigTicket { id: object::new(ctx) }, ctx.sender());
}

/// Create the shared controls, once, consuming the publish's `ConfigTicket`.
///
/// `allowed_deepbook_pools` must name at least one pool: the config is useless
/// without a venue, and defaulting to "empty means allow everything" is exactly
/// the failure S-12 describes. Duplicate IDs abort (`vec_set::from_keys`).
///
/// `SettlementAsset` seeds the accepted-asset registry. Bootstrap passes
/// native USDC on the network being bootstrapped (D6: one payment asset). It
/// is a type argument rather than a constant because the USDC type differs
/// between testnet and mainnet. Every later addition gives 24 hours' notice.
public fun create<SettlementAsset>(
    ticket: ConfigTicket,
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
    let ConfigTicket { id } = ticket;
    id.delete();
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
        accepted_assets: vec_set::singleton(type_string<SettlementAsset>()),
        settlement_apps: vec_set::empty(),
        bridge_adapters: vec_set::empty(),
        pending_additions: vector[],
        // The fee starts off: nowhere to send it, and no intent may carry one.
        fee_address: option::none(),
        max_fee_bps: 0,
        fee_cap_minor: 0,
        pending_fee_change: option::none(),
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
/// `assert_active` — and therefore every settlement path — permanently, with no
/// way back.
///
/// Yes, this weakens the two-key pause: `AdminCap` can now unpause unilaterally.
/// That is the smaller harm. A permanent, unrecoverable liveness brick is
/// strictly worse than a cold-multisig quorum being able to resume, and
/// everything downstream of an unpause is still gated by the asset registry,
/// the bank-payout floor and each account's own KYB, freezes and ceilings.
public fun admin_set_paused(_admin: &AdminCap, config: &mut ComplianceConfig, paused: bool) {
    config.paused = paused;
    emit_update(config);
}

/// BREAK-GLASS, step one of two: arm a revocation of every outstanding
/// `ComplianceCap`. Nothing is revoked until `execute_break_glass_compliance_cap`
/// runs inside the ninety-second window and mints one replacement, bound to
/// `config`.
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

// ─── v2 registries: additions give 24 hours' notice, removals are immediate ─
//
// Three short lists decide what the v2 money paths will accept: the coin a
// payment settles in, the app allowed to settle under a business's spending
// rules, and the adapter allowed to burn a cross-chain payment. Each one is a
// way to make money easier to move, so adding to any of them is the cold
// multisig's act (`AdminCap`) AND gives every business owner 24 hours to see
// it coming and revoke their allowances. Taking something off a list can only
// stop money moving, so it is immediate, and `ComplianceCap` may do it.
//
// Activation needs `AdminCap` a second time. An announced addition does not
// switch itself on; governance signs again after the notice has run, and
// within seven days of it, or the addition lapses.
//
// Both steps also prove on chain that the sender is a multisig no single
// member can sign for (`multisig::assert_quorum_sender`), so "never by a
// single key" does not rest on where `AdminCap` happens to be held.

/// Announce an addition of `T` to `registry`. It can be activated no sooner
/// than 24 hours from now, and no later than eight days from now.
public fun propose_addition<T>(
    _admin: &AdminCap,
    config: &mut ComplianceConfig,
    registry: u8,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    clock: &Clock,
    ctx: &TxContext,
) {
    multisig::assert_quorum_sender(&keys, &weights, threshold, ctx);
    let name = type_string<T>();
    assert!(!registry_set(config, registry).contains(&name), E_ALREADY_REGISTERED);
    assert!(find_pending(config, registry, &name).is_none(), E_ALREADY_PROPOSED);
    assert!(config.pending_additions.length() < MAX_PENDING_ADDITIONS, E_REGISTRY_FULL);

    let now = clock.timestamp_ms();
    let eta_ms = now + ADDITION_NOTICE_MS;
    config.pending_additions.push_back(PendingAddition {
        registry,
        type_name: name,
        proposed_at_ms: now,
        eta_ms,
    });
    event::emit(RegistryAdditionProposed {
        config_id: object::id_address(config),
        registry,
        type_name: name,
        proposed_at_ms: now,
        eta_ms,
    });
}

/// Put an announced addition into force, once its notice has run and before
/// its window closes.
public fun activate_addition<T>(
    _admin: &AdminCap,
    config: &mut ComplianceConfig,
    registry: u8,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    clock: &Clock,
    ctx: &TxContext,
) {
    multisig::assert_quorum_sender(&keys, &weights, threshold, ctx);
    let name = type_string<T>();
    let at = find_pending(config, registry, &name);
    assert!(at.is_some(), E_NOT_PROPOSED);
    let index = at.destroy_some();
    let now = clock.timestamp_ms();
    let eta_ms = config.pending_additions[index].eta_ms;
    assert!(now >= eta_ms, E_NOTICE_NOT_RUN);
    assert!(now < eta_ms + ADDITION_WINDOW_MS, E_ADDITION_LAPSED);
    assert!(registry_set(config, registry).length() < MAX_REGISTRY_ENTRIES, E_REGISTRY_FULL);

    config.pending_additions.remove(index);
    registry_set_mut(config, registry).insert(name);
    event::emit(RegistryAdditionActivated { config_id: object::id_address(config), registry, type_name: name });
}

/// Withdraw an announced addition. Subtractive: it stops a loosening.
public fun cancel_registry_addition(
    config: &mut ComplianceConfig,
    cap: &ComplianceCap,
    registry_caps: &CapRegistry,
    registry: u8,
    type_name: String,
) {
    assert_compliance_cap(registry_caps, cap);
    assert!(cap.config_id == object::id(config), E_INVALID_CAP);
    // Written out here, not in a helper, so check-compliance-subtractive sees
    // the removal in the body of the function that takes the cap.
    let at = find_pending(config, registry, &type_name);
    assert!(at.is_some(), E_NOT_PROPOSED);
    config.pending_additions.remove(at.destroy_some());
    event::emit(RegistryAdditionCancelled { config_id: object::id_address(config), registry, type_name });
}

/// The same withdrawal, by the cold multisig.
public fun admin_cancel_registry_addition(
    _admin: &AdminCap,
    config: &mut ComplianceConfig,
    registry: u8,
    type_name: String,
) {
    drop_pending(config, registry, type_name);
}

/// Take a type off a registry, at once. Subtractive: removing the asset stops
/// every payment in it, including intents already open; removing an app or an
/// adapter stops it settling anything.
public fun remove_registry_entry(
    config: &mut ComplianceConfig,
    cap: &ComplianceCap,
    registry_caps: &CapRegistry,
    registry: u8,
    type_name: String,
) {
    assert_compliance_cap(registry_caps, cap);
    assert!(cap.config_id == object::id(config), E_INVALID_CAP);
    // Written out here, not in a helper, so check-compliance-subtractive sees
    // the removal in the body of the function that takes the cap.
    assert!(registry_set(config, registry).contains(&type_name), E_NOT_REGISTERED);
    if (registry == REGISTRY_ASSET) {
        assert!(config.accepted_assets.length() > 1, E_LAST_ASSET);
    };
    registry_set_mut(config, registry).remove(&type_name);
    event::emit(RegistryEntryRemoved { config_id: object::id_address(config), registry, type_name });
}

/// The same removal, by the cold multisig.
public fun admin_remove_registry_entry(
    _admin: &AdminCap,
    config: &mut ComplianceConfig,
    registry: u8,
    type_name: String,
) {
    drop_entry(config, registry, type_name);
}

// ─── The fee (decision 1): every change gives 24 hours' notice ─────────────
//
// Splash may take a fee on a payment, as its own leg in the same transaction;
// the principal never passes through it. Each intent records its fee when it
// opens (`payment_intent`), bounded by the parameters here, so the owners see
// it before they approve. At settlement it is charged at no more than that,
// to the fee address in force then.
//
// The parameters are where the fee goes and how large it may be, so they
// change like a registry addition: the governance quorum proposes, every
// change waits 24 hours, and the quorum activates it within seven days or it
// lapses. Lowering the fee follows the same path; there is no fast path in
// either direction. Withdrawing a pending change only stops a change, so the
// compliance key may do it too.

/// Announce a fee change: the fee address `fee_keys`/`fee_weights`/
/// `fee_threshold` derive, the most bps an intent may carry, and the cap per
/// payment. The sender is the governance quorum (`keys`/`weights`/
/// `threshold`, which must derive it and not be single-signer).
///
/// The fee address is derived here from its members, never taken as a bare
/// address, and must not be a multisig any one member can sign for alone, so
/// a lone hot key such as the KMS operator can never receive the fee.
public fun propose_fee_change(
    _admin: &AdminCap,
    config: &mut ComplianceConfig,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    fee_keys: vector<vector<u8>>,
    fee_weights: vector<u8>,
    fee_threshold: u16,
    max_fee_bps: u64,
    fee_cap_minor: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    multisig::assert_quorum_sender(&keys, &weights, threshold, ctx);
    assert!(max_fee_bps <= MAX_FEE_BPS_CEILING, E_FEE_ABOVE_CEILING);
    let fee_address = multisig::derive_address(&fee_keys, &fee_weights, fee_threshold);
    assert!(!multisig::is_single_signer(&fee_weights, fee_threshold), E_FEE_ADDRESS_SINGLE_SIGNER);
    assert!(config.pending_fee_change.is_none(), E_FEE_CHANGE_PENDING);

    let now = clock.timestamp_ms();
    let eta_ms = now + ADDITION_NOTICE_MS;
    config.pending_fee_change = option::some(PendingFeeChange {
        fee_address,
        max_fee_bps,
        fee_cap_minor,
        proposed_at_ms: now,
        eta_ms,
    });
    event::emit(FeeChangeProposed {
        config_id: object::id_address(config),
        fee_address,
        max_fee_bps,
        fee_cap_minor,
        proposed_at_ms: now,
        eta_ms,
    });
}

/// Put the pending fee change into force, once its notice has run and before
/// its window closes. The quorum signs again, and names the change it is
/// activating, so a signed activation cannot apply some other change.
public fun activate_fee_change(
    _admin: &AdminCap,
    config: &mut ComplianceConfig,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    fee_address: address,
    max_fee_bps: u64,
    fee_cap_minor: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    multisig::assert_quorum_sender(&keys, &weights, threshold, ctx);
    assert!(config.pending_fee_change.is_some(), E_NO_FEE_CHANGE);
    let pending = *config.pending_fee_change.borrow();
    assert!(
        pending.fee_address == fee_address && pending.max_fee_bps == max_fee_bps && pending.fee_cap_minor == fee_cap_minor,
        E_FEE_CHANGE_MISMATCH,
    );
    let now = clock.timestamp_ms();
    assert!(now >= pending.eta_ms, E_FEE_NOTICE_NOT_RUN);
    assert!(now < pending.eta_ms + ADDITION_WINDOW_MS, E_FEE_CHANGE_LAPSED);

    let PendingFeeChange { fee_address, max_fee_bps, fee_cap_minor, proposed_at_ms: _, eta_ms: _ } =
        config.pending_fee_change.extract();
    config.fee_address = option::some(fee_address);
    config.max_fee_bps = max_fee_bps;
    config.fee_cap_minor = fee_cap_minor;
    event::emit(FeeChangeActivated { config_id: object::id_address(config), fee_address, max_fee_bps, fee_cap_minor });
}

/// Withdraw the pending fee change. Subtractive: it stops a change and makes
/// none, so the compliance key may do it.
public fun cancel_fee_change(config: &mut ComplianceConfig, cap: &ComplianceCap, registry_caps: &CapRegistry) {
    assert_compliance_cap(registry_caps, cap);
    assert!(cap.config_id == object::id(config), E_INVALID_CAP);
    // Written out here, not in a helper, so check-compliance-subtractive sees
    // the withdrawal in the body of the function that takes the cap.
    assert!(config.pending_fee_change.is_some(), E_NO_FEE_CHANGE);
    let PendingFeeChange { fee_address, max_fee_bps, fee_cap_minor, proposed_at_ms: _, eta_ms: _ } =
        config.pending_fee_change.extract();
    event::emit(FeeChangeCancelled { config_id: object::id_address(config), fee_address, max_fee_bps, fee_cap_minor });
}

/// The same withdrawal, by the governance quorum.
public fun admin_cancel_fee_change(
    _admin: &AdminCap,
    config: &mut ComplianceConfig,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    ctx: &TxContext,
) {
    multisig::assert_quorum_sender(&keys, &weights, threshold, ctx);
    assert!(config.pending_fee_change.is_some(), E_NO_FEE_CHANGE);
    let PendingFeeChange { fee_address, max_fee_bps, fee_cap_minor, proposed_at_ms: _, eta_ms: _ } =
        config.pending_fee_change.extract();
    event::emit(FeeChangeCancelled { config_id: object::id_address(config), fee_address, max_fee_bps, fee_cap_minor });
}

/// Where the fee leg is paid now. `none` until the first fee change activates.
public fun fee_address(config: &ComplianceConfig): Option<address> { config.fee_address }
public fun max_fee_bps(config: &ComplianceConfig): u64 { config.max_fee_bps }
public fun fee_cap_minor(config: &ComplianceConfig): u64 { config.fee_cap_minor }
public fun pending_fee_change(config: &ComplianceConfig): Option<PendingFeeChange> { config.pending_fee_change }
public fun pending_fee_address(p: &PendingFeeChange): address { p.fee_address }
public fun pending_fee_bps(p: &PendingFeeChange): u64 { p.max_fee_bps }
public fun pending_fee_cap_minor(p: &PendingFeeChange): u64 { p.fee_cap_minor }
public fun pending_fee_eta_ms(p: &PendingFeeChange): u64 { p.eta_ms }
public fun max_fee_bps_ceiling(): u64 { MAX_FEE_BPS_CEILING }

public fun addition_window_ms(): u64 { ADDITION_WINDOW_MS }

fun drop_pending(config: &mut ComplianceConfig, registry: u8, type_name: String) {
    let at = find_pending(config, registry, &type_name);
    assert!(at.is_some(), E_NOT_PROPOSED);
    config.pending_additions.remove(at.destroy_some());
    event::emit(RegistryAdditionCancelled { config_id: object::id_address(config), registry, type_name });
}

fun drop_entry(config: &mut ComplianceConfig, registry: u8, type_name: String) {
    assert!(registry_set(config, registry).contains(&type_name), E_NOT_REGISTERED);
    // An empty asset list would stop every payment until a 24-hour addition
    // ran, which no one can reverse sooner. `pause` halts, and AdminCap lifts
    // a pause at once.
    if (registry == REGISTRY_ASSET) {
        assert!(config.accepted_assets.length() > 1, E_LAST_ASSET);
    };
    registry_set_mut(config, registry).remove(&type_name);
    event::emit(RegistryEntryRemoved { config_id: object::id_address(config), registry, type_name });
}

fun find_pending(config: &ComplianceConfig, registry: u8, name: &String): Option<u64> {
    let mut i = 0;
    while (i < config.pending_additions.length()) {
        let p = &config.pending_additions[i];
        if (p.registry == registry && &p.type_name == name) return option::some(i);
        i = i + 1;
    };
    option::none()
}

fun registry_set(config: &ComplianceConfig, registry: u8): &VecSet<String> {
    if (registry == REGISTRY_ASSET) &config.accepted_assets
    else if (registry == REGISTRY_SETTLEMENT_APP) &config.settlement_apps
    else if (registry == REGISTRY_BRIDGE_ADAPTER) &config.bridge_adapters
    else abort E_UNKNOWN_REGISTRY
}

fun registry_set_mut(config: &mut ComplianceConfig, registry: u8): &mut VecSet<String> {
    if (registry == REGISTRY_ASSET) &mut config.accepted_assets
    else if (registry == REGISTRY_SETTLEMENT_APP) &mut config.settlement_apps
    else if (registry == REGISTRY_BRIDGE_ADAPTER) &mut config.bridge_adapters
    else abort E_UNKNOWN_REGISTRY
}

/// The registry string for a type: what intents store as `settlement_asset`.
public fun type_string<T>(): String {
    type_name::with_defining_ids<T>().into_string().to_string()
}

/// Hot-path guard: the asset an intent settles in is accepted right now.
public fun assert_asset_accepted(config: &ComplianceConfig, asset: &String) {
    assert!(config.accepted_assets.contains(asset), E_ASSET_NOT_ACCEPTED);
}

/// Hot-path guard: `W` is a registered settlement app.
public fun assert_settlement_app<W>(config: &ComplianceConfig) {
    assert!(config.settlement_apps.contains(&type_string<W>()), E_NOT_A_SETTLEMENT_APP);
}

/// Hot-path guard: `W` is a registered bridge adapter.
public fun assert_bridge_adapter<W>(config: &ComplianceConfig) {
    assert!(config.bridge_adapters.contains(&type_string<W>()), E_NOT_A_BRIDGE_ADAPTER);
}

public fun is_asset_accepted(config: &ComplianceConfig, asset: &String): bool {
    config.accepted_assets.contains(asset)
}
public fun accepted_assets(config: &ComplianceConfig): vector<String> { *config.accepted_assets.keys() }
public fun settlement_apps(config: &ComplianceConfig): vector<String> { *config.settlement_apps.keys() }
public fun bridge_adapters(config: &ComplianceConfig): vector<String> { *config.bridge_adapters.keys() }
public fun pending_additions(config: &ComplianceConfig): vector<PendingAddition> { config.pending_additions }
public fun pending_registry(p: &PendingAddition): u8 { p.registry }
public fun pending_type_name(p: &PendingAddition): String { p.type_name }
public fun pending_eta_ms(p: &PendingAddition): u64 { p.eta_ms }
public fun registry_asset(): u8 { REGISTRY_ASSET }
public fun registry_settlement_app(): u8 { REGISTRY_SETTLEMENT_APP }
public fun registry_bridge_adapter(): u8 { REGISTRY_BRIDGE_ADAPTER }
public fun addition_notice_ms(): u64 { ADDITION_NOTICE_MS }

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

#[test_only]
/// Tests build a config without the publish's `init`. Production has exactly
/// the one ticket `init` mints.
public fun ticket_for_testing(ctx: &mut TxContext): ConfigTicket {
    ConfigTicket { id: object::new(ctx) }
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}

/// Peg monitor — on-chain enforcement of stablecoin peg health.
///
/// `PegState` is a shared object updated periodically by the operator (off-chain
/// daemon reads Pyth Hermes and writes the freshest USDC/USDT deviations on
/// chain). `assert_pegged` aborts the PTB if either deviation exceeds 30 bps OR
/// the state is older than `MAX_STALENESS_MS`.
///
/// Who calls it: `splash_custody`'s pooled settlement, retired from the mainnet
/// path, and nothing else. No v2 payment path in `splash_core`, `splash_spend`
/// or `splash_upgrade_delay` reads `PegState`, so the peg tolerances in
/// `ComplianceConfig` constrain no v2 payout. The peg check D6 asks for belongs
/// to converting funding in another asset to USDC, which happens off chain.
///
/// Net effect on the custody path: even if the off-chain authorize layer is
/// bypassed (compromised sponsor key, direct CLI call with a verified
/// BusinessAccount, etc.), funds cannot leave the settlement pool on a broken
/// peg.
module splash_core::peg_monitor;

// NOTE: `assert_deepbook_liquidity` used to live here. It moved to
// `splash_custody::liquidity_guard` because it exists to protect POOLED funds —
// and pools only exist in the custody package. Keeping it here would have forced
// splash_core to depend on DeepBook, which (a) is a dependency the mainnet
// package does not need, and (b) made `sui move test` impossible: the pinned
// DeepBook rev ships test files that fail to compile against this toolchain,
// aborting the whole test build before our modules are reached. Moving it out
// unblocked the entire splash_core test suite.

use splash_core::business_account::{Self, AdminCap, AnchorCap};
use splash_core::cap_registry::CapRegistry;
use splash_core::compliance_config::{Self, ComplianceConfig};
use sui::clock::{Self, Clock};
use sui::event;

/// 30 bps = 0.30% = 3,000 ppm — matches what off-chain `lib/server/pyth.ts` uses.
const MAX_DEVIATION_PPM: u64 = 3_000;
const E_PEG_BROKEN_USDC:         u64 = 300;
const E_PEG_BROKEN_USDT:         u64 = 301;
const E_PEG_STALE:               u64 = 302;
const E_TIMESTAMP_REGRESSION:    u64 = 303;


public struct PegState has key {
    id: UID,
    /// |usdc_price - 1.0| × 1_000_000  (parts per million)
    usdc_deviation_ppm: u64,
    /// |usdt_price - 1.0| × 1_000_000
    usdt_deviation_ppm: u64,
    /// Clock timestamp_ms of the last update.
    last_update_ms: u64,
    /// Monotonic counter of updates pushed.
    update_count: u64,
}

public struct PegUpdated has copy, drop {
    state_id: address,
    sequence: u64,
    usdc_deviation_ppm: u64,
    usdt_deviation_ppm: u64,
    timestamp_ms: u64,
}

/// Bootstrap: admin creates the shared PegState. Call once after publish.
///
/// H-05 fix: initialize deviations *above* MAX_DEVIATION_PPM so any
/// `assert_pegged` call before the first real `update_peg` aborts with
/// `E_PEG_BROKEN_USDC`. Previously this struct was initialized with
/// deviation=0 + a fresh timestamp, which let settlements proceed against
/// zero peg data for up to 60 seconds before the operator daemon had ever
/// pushed a real Pyth reading. Now: the operator MUST push at least one
/// real reading before settlements can fire.
public fun init_peg_state(_admin: &AdminCap, clock: &Clock, ctx: &mut TxContext) {
    let state = PegState {
        id: object::new(ctx),
        // One ppm above the max — fails `assert_pegged` until first real update.
        usdc_deviation_ppm: MAX_DEVIATION_PPM + 1,
        usdt_deviation_ppm: MAX_DEVIATION_PPM + 1,
        last_update_ms: clock::timestamp_ms(clock),
        update_count: 0,
    };
    transfer::share_object(state);
}

/// Operator pushes a fresh Hermes-derived peg reading. AnchorCap-gated
/// (cap split S-10): a peg reading is an attestation about the outside world,
/// not a movement of value, so the hot operator key can push it while money
/// authority stays offline in the cold multisig.
///
/// L-06 fix: assert the new timestamp is strictly newer than the stored
/// one (allowing equality on the first update from genesis) to guard
/// against clock regression bugs or replay-style races.
public fun update_peg(
    state: &mut PegState,
    cap: &AnchorCap,
    registry: &CapRegistry,
    usdc_deviation_ppm: u64,
    usdt_deviation_ppm: u64,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    // The hottest path in the package — roughly 2,880 signatures a day from an
    // internet-facing host, which is precisely why the cap must be revocable.
    business_account::assert_anchor_cap(registry, cap);
    let now = clock::timestamp_ms(clock);
    // First update from genesis (update_count == 0) is allowed to equal
    // the init timestamp; subsequent updates must strictly advance.
    if (state.update_count > 0) {
        assert!(now > state.last_update_ms, E_TIMESTAMP_REGRESSION);
    };

    state.usdc_deviation_ppm = usdc_deviation_ppm;
    state.usdt_deviation_ppm = usdt_deviation_ppm;
    state.last_update_ms = now;
    state.update_count = state.update_count + 1;

    event::emit(PegUpdated {
        state_id: object::id_address(state),
        sequence: state.update_count,
        usdc_deviation_ppm,
        usdt_deviation_ppm,
        timestamp_ms: now,
    });
}

/// Hot-path check called from settle_payment / settle_batch.
/// Aborts the PTB if peg is broken OR state is stale.
public fun assert_pegged(state: &PegState, config: &ComplianceConfig, clock: &Clock) {
    compliance_config::assert_active(config);
    let now = clock::timestamp_ms(clock);
    let age = if (now > state.last_update_ms) { now - state.last_update_ms } else { 0 };
    assert!(age <= compliance_config::max_staleness_ms(config), E_PEG_STALE);
    assert!(state.usdc_deviation_ppm <= compliance_config::max_deviation_ppm(config), E_PEG_BROKEN_USDC);
    assert!(state.usdt_deviation_ppm <= compliance_config::max_deviation_ppm(config), E_PEG_BROKEN_USDT);
}

// ── views ────────────────────────────────────────────────────────────────
public fun usdc_deviation_ppm(state: &PegState): u64 { state.usdc_deviation_ppm }
public fun usdt_deviation_ppm(state: &PegState): u64 { state.usdt_deviation_ppm }
public fun last_update_ms(state: &PegState):    u64 { state.last_update_ms }
public fun update_count(state: &PegState):      u64 { state.update_count }

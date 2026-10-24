/// ComplianceCap is subtractive by type.
///
/// `scripts/check-compliance-subtractive.mjs` proves that no function taking
/// `&ComplianceCap` can loosen anything — it reads the signatures, so it
/// catches a loosening function that nobody thought to write a test for. These
/// tests prove the other half: that the functions which DO take it behave the
/// way the capability's documentation claims.
#[test_only]
module splash_core::compliance_tests;

use splash_core::business_account;
use splash_core::cap_registry::{Self, CapRegistry};
use splash_core::compliance_config::{Self, ComplianceConfig, ComplianceCap};
use std::unit_test::assert_eq;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const ADMIN: address = @0xA11CE;

const DEVIATION: u64 = 5_000;
const STALENESS: u64 = 300_000;
const SLIPPAGE: u64 = 500;
const DEPTH: u64 = 1_000_000;
const FLOOR: u64 = 100_000_000;

fun pool_a(): ID { object::id_from_address(@0xF001) }
fun pool_b(): ID { object::id_from_address(@0xF002) }

fun setup(): Scenario {
    let mut scenario = ts::begin(ADMIN);
    {
        let ctx = scenario.ctx();
        cap_registry::init_for_testing(ctx);
        let admin = business_account::admin_cap_for_testing(ctx);
        let registry = cap_registry::new_for_testing(ctx);
        compliance_config::create<SUI>(
        compliance_config::ticket_for_testing(ctx),
            &admin,
            &registry,
            DEVIATION,
            STALENESS,
            SLIPPAGE,
            DEPTH,
            FLOOR,
            vector[pool_a()],
            ctx,
        );
        business_account::destroy_admin_cap_for_testing(admin);
        cap_registry::share_for_testing(registry);
    };
    scenario
}

#[test]
/// Tolerances down, requirements up. Both directions of "stricter" in one call.
fun tightening_in_every_direction_is_allowed() {
    let mut scenario = setup();
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<ComplianceCap>();
        let registry = scenario.take_shared<CapRegistry>();

        compliance_config::tighten(
            &mut config,
            &cap,
            &registry,
            DEVIATION - 1_000,   // tolerance down
            STALENESS - 100_000, // tolerance down
            SLIPPAGE - 100,      // tolerance down
            DEPTH + 500_000,     // requirement up
            FLOOR + 1,           // requirement up
        );

        assert_eq!(compliance_config::max_deviation_ppm(&config), DEVIATION - 1_000);
        assert_eq!(compliance_config::min_depth_base_units(&config), DEPTH + 500_000);

        scenario.return_to_sender(cap);
        ts::return_shared(registry);
        ts::return_shared(config);
    };
    scenario.end();
}

#[test]
/// Restating the current values is a no-op, not an abort. Otherwise tightening
/// one field would force a caller to restate the other four exactly, and a
/// caller who gets that wrong loosens something by accident.
fun restating_the_current_values_is_allowed() {
    let mut scenario = setup();
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<ComplianceCap>();
        let registry = scenario.take_shared<CapRegistry>();
        compliance_config::tighten(&mut config, &cap, &registry, DEVIATION, STALENESS, SLIPPAGE, DEPTH, FLOOR);
        assert_eq!(compliance_config::max_slippage_bps(&config), SLIPPAGE);
        scenario.return_to_sender(cap);
        ts::return_shared(registry);
        ts::return_shared(config);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 356, location = splash_core::compliance_config)]
/// Raising a tolerance is a loosening, and the compliance key does not loosen.
fun raising_a_tolerance_aborts() {
    let mut scenario = setup();
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<ComplianceCap>();
        let registry = scenario.take_shared<CapRegistry>();
        compliance_config::tighten(
            &mut config,
            &cap,
            &registry,
            DEVIATION,
            STALENESS,
            SLIPPAGE + 100, // more slippage tolerated
            DEPTH,
            FLOOR,
        );
        scenario.return_to_sender(cap);
        ts::return_shared(registry);
        ts::return_shared(config);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 356, location = splash_core::compliance_config)]
/// Lowering a requirement is the same loosening wearing the other sign.
fun lowering_a_requirement_aborts() {
    let mut scenario = setup();
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<ComplianceCap>();
        let registry = scenario.take_shared<CapRegistry>();
        compliance_config::tighten(
            &mut config,
            &cap,
            &registry,
            DEVIATION,
            STALENESS,
            SLIPPAGE,
            DEPTH,
            FLOOR - 1, // a smaller settlement floor lets more through
        );
        scenario.return_to_sender(cap);
        ts::return_shared(registry);
        ts::return_shared(config);
    };
    scenario.end();
}

#[test]
/// The cold multisig can move parameters in either direction — including back
/// out of a tightening the compliance key applied.
fun the_admin_cap_can_relax_what_the_compliance_cap_tightened() {
    let mut scenario = setup();
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<ComplianceCap>();
        let registry = scenario.take_shared<CapRegistry>();
        compliance_config::tighten(&mut config, &cap, &registry, DEVIATION, STALENESS, 100, DEPTH, FLOOR);
        assert_eq!(compliance_config::max_slippage_bps(&config), 100);
        scenario.return_to_sender(cap);
        ts::return_shared(registry);
        ts::return_shared(config);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        compliance_config::admin_set_parameters(
            &admin,
            &mut config,
            DEVIATION,
            STALENESS,
            SLIPPAGE,
            DEPTH,
            FLOOR,
        );
        assert_eq!(compliance_config::max_slippage_bps(&config), SLIPPAGE);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
    };
    scenario.end();
}

#[test]
/// Pause is one-directional. `ComplianceCap` can stop settlement; only
/// `AdminCap` can start it again — and the absence of a `ComplianceCap`
/// unpause is a compile-time fact, not a runtime check, which is why this test
/// can only demonstrate the half that exists.
fun the_compliance_cap_can_halt_but_only_the_admin_cap_resumes() {
    let mut scenario = setup();
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<ComplianceCap>();
        let registry = scenario.take_shared<CapRegistry>();
        compliance_config::pause(&mut config, &cap, &registry);
        assert_eq!(compliance_config::paused(&config), true);
        scenario.return_to_sender(cap);
        ts::return_shared(registry);
        ts::return_shared(config);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        compliance_config::admin_set_paused(&admin, &mut config, false);
        assert_eq!(compliance_config::paused(&config), false);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
    };
    scenario.end();
}

#[test]
/// Adding a venue is `AdminCap`. S-12 is exactly the attack where someone
/// stands up their own pool and satisfies the depth and slippage guards
/// trivially, so naming a venue is not a compliance-key power.
fun venues_are_added_by_admin_and_removed_by_compliance() {
    let mut scenario = setup();
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        compliance_config::admin_allow_pool(&admin, &mut config, pool_b());
        assert_eq!(compliance_config::is_pool_allowed(&config, pool_b()), true);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
    };
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<ComplianceCap>();
        let registry = scenario.take_shared<CapRegistry>();
        compliance_config::disallow_pool(&mut config, &cap, &registry, pool_b());
        assert_eq!(compliance_config::is_pool_allowed(&config, pool_b()), false);
        // The last venue still cannot be removed — an empty whitelist bricks
        // every settlement path, which is `pause`'s job and should not be
        // reachable by accident.
        assert_eq!(compliance_config::is_pool_allowed(&config, pool_a()), true);
        scenario.return_to_sender(cap);
        ts::return_shared(registry);
        ts::return_shared(config);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 355, location = splash_core::compliance_config)]
fun the_last_venue_cannot_be_removed() {
    let mut scenario = setup();
    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<ComplianceConfig>();
        let cap = scenario.take_from_sender<ComplianceCap>();
        let registry = scenario.take_shared<CapRegistry>();
        compliance_config::disallow_pool(&mut config, &cap, &registry, pool_a());
        scenario.return_to_sender(cap);
        ts::return_shared(registry);
        ts::return_shared(config);
    };
    scenario.end();
}

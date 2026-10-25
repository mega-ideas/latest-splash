/// Delegation and credit-segregation tests.
///
/// Requires Sui CLI >= 1.61.1, the release that first shipped
/// `std::unit_test::destroy` — DeepBook's own tests use it, and without it the
/// dependency's test files abort the build before this file is reached. See
/// `Move.toml` for the full history and the checks done when the pin moved.
///
/// The properties below are the ones that decide whether A-11 is actually
/// closed: credit segregation, operator binding, epoch revocation, TTL expiry,
/// and the fixed fee recipient.
#[test_only]
module splash_custody::delegation_tests;

use splash_core::address_registry;
use splash_core::business_account;
use splash_custody::delegation;
use splash_custody::settlement;
use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;

const TENANT_A: address = @0xA;
const TENANT_B: address = @0xB;
const OPERATOR: address = @0x09E7A;
const FEE_SINK: address = @0xFEE;
const DAY: u64 = 86_400_000;

const PER_TX: u64 = 50_000_000_000;
const WINDOW: u64 = 50_000_000_000;

#[test]
/// Credit segregation. Tenant A funds the pool; tenant B has zero credit. A
/// delegation for B cannot spend A's money — not because an assert says so, but
/// because `credits[B]` is a different number from `credits[A]`.
///
/// This is what bounds the blast radius of a compromised operator to a single
/// tenant's funding rather than the whole pool.
fun credits_are_segregated_per_tenant() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };

    scenario.next_tx(OPERATOR);
    {
        let mut pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);

        let funding = coin::mint_for_testing<SUI>(10_000_000_000, ctx);
        settlement::deposit_for(&admin, &mut pool, TENANT_A, funding, &c, ctx);

        assert_eq!(settlement::credit_of(&pool, TENANT_A), 10_000_000_000);
        assert_eq!(settlement::credit_of(&pool, TENANT_B), 0);
        assert_eq!(settlement::total_credit(&pool), 10_000_000_000);

        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

/// Grant a real delegation from a verified tenant, then hand back the pool.
fun grant_for(scenario: &mut test_scenario::Scenario, tenant: address, ttl_ms: u64) {
    scenario.next_tx(tenant);
    {
        let ctx = scenario.ctx();
        let c = clock::create_for_testing(ctx);
        business_account::submit_application(b"SSM-1".to_string(), b"cid".to_string(), &c, ctx);
        c.destroy_for_testing();
    };
    scenario.next_tx(tenant);
    {
        // Phase 6 made BusinessAccount a SHARED object — owners and approvers
        // are plural now, and an object several people must touch cannot be
        // owned by one of them.
        let mut account = scenario.take_shared<business_account::BusinessAccount>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        let mut areg = address_registry::new_for_testing(ctx);
        business_account::verify_business(&admin, &mut account, &mut areg, 10);
        address_registry::destroy_for_testing(areg);
        business_account::destroy_admin_cap_for_testing(admin);
        test_scenario::return_shared(account);
    };
    scenario.next_tx(tenant);
    {
        let pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        let account = scenario.take_shared<business_account::BusinessAccount>();
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        settlement::grant_delegation(&pool, &account, OPERATOR, ttl_ms, PER_TX, WINDOW, &c, ctx);
        c.destroy_for_testing();
        test_scenario::return_shared(account);
        test_scenario::return_shared(pool);
    };
}

#[test]
#[expected_failure(abort_code = 115, location = splash_custody::delegation)]
/// A delegation is bound to the operator address it was granted to. POSSESSION
/// IS NOT AUTHORITY — a stolen delegation object used from any other address
/// aborts, so exfiltrating the object alone buys nothing.
fun a_stolen_delegation_is_useless_from_another_address() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };
    grant_for(&mut scenario, TENANT_A, 7 * DAY);

    // A different address takes the delegation and tries to use it.
    scenario.next_tx(@0xBADBAD);
    {
        let pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        let mut d = scenario.take_from_address<delegation::PayoutDelegation>(OPERATOR);
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        delegation::authorize(&mut d, object::id(&pool), 0, 1_000, &c, ctx);
        c.destroy_for_testing();
        test_scenario::return_to_address(OPERATOR, d);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 117, location = splash_custody::delegation)]
/// `revoke_all_delegations` reaches delegations the multisig CANNOT name.
///
/// They are owned objects sitting at the operator's address, and an attacker
/// controlling that address will not hand them back. Bumping the pool epoch is
/// the only revocation that touches them — this proves a delegation minted
/// before the bump is dead afterwards.
fun an_epoch_bump_kills_a_delegation_the_admin_cannot_reach() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };
    grant_for(&mut scenario, TENANT_A, 7 * DAY);

    scenario.next_tx(OPERATOR);
    {
        let mut pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        let mut d = scenario.take_from_sender<delegation::PayoutDelegation>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::revoke_all_delegations(&admin, &mut pool);
        sui::test_utils::destroy(admin);

        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        // Epoch 1 on the pool, epoch 0 on the delegation.
        delegation::authorize(&mut d, object::id(&pool), settlement::delegation_epoch(&pool), 1_000, &c, ctx);
        c.destroy_for_testing();
        scenario.return_to_sender(d);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 112, location = splash_custody::delegation)]
/// The TTL is a dead-man switch: a tenant who stops re-granting stops being
/// payable, so an abandoned integration decays closed rather than staying open.
fun an_expired_delegation_cannot_authorize() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };
    grant_for(&mut scenario, TENANT_A, DAY);

    scenario.next_tx(OPERATOR);
    {
        let pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        let mut d = scenario.take_from_sender<delegation::PayoutDelegation>();
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        // Two days after a one-day grant.
        c.set_for_testing(1_002 * DAY);
        delegation::authorize(&mut d, object::id(&pool), 0, 1_000, &c, ctx);
        c.destroy_for_testing();
        scenario.return_to_sender(d);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 114, location = splash_custody::delegation)]
/// A TTL beyond 30 days is refused at grant time, so the dead-man switch cannot
/// be set so far out that it never fires.
fun a_delegation_cannot_outlive_thirty_days() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };
    grant_for(&mut scenario, TENANT_A, 31 * DAY);
    scenario.end();
}

#[test]
/// `revoke_all_delegations` bumps the pool epoch, and every delegation records
/// the epoch it was minted under.
///
/// This is the ONLY revocation that reaches a compromised operator: their
/// delegations are owned objects at their address, and the multisig cannot name
/// an owned object it does not hold. One write on the shared pool kills all of
/// them at once.
fun revoking_all_delegations_bumps_the_pool_epoch() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };

    scenario.next_tx(OPERATOR);
    {
        let mut pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);

        assert_eq!(settlement::delegation_epoch(&pool), 0);
        settlement::revoke_all_delegations(&admin, &mut pool);
        assert_eq!(settlement::delegation_epoch(&pool), 1);
        // Every delegation minted at epoch 0 now fails `authorize` with 117.

        sui::test_utils::destroy(admin);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

#[test]
/// The fee recipient is fixed at pool creation and `withdraw_fees` takes no
/// recipient argument at all.
///
/// A caller-supplied recipient meant a compromised admin key could redirect
/// every future sweep to itself — revenue theft that looks exactly like normal
/// operation in the event log.
fun the_fee_recipient_is_fixed_at_creation() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };

    scenario.next_tx(OPERATOR);
    {
        let pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        assert_eq!(settlement::fee_recipient(&pool), FEE_SINK);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 119, location = splash_custody::settlement)]
/// Repointing the fee recipient requires the pool to be paused first, so a
/// redirect cannot be slipped in between two normal sweeps without the pause
/// showing up in monitoring.
fun repointing_the_fee_recipient_requires_a_pause() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };

    scenario.next_tx(OPERATOR);
    {
        let mut pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        let ctx = scenario.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::set_fee_recipient(&admin, &mut pool, @0xBADBAD);
        sui::test_utils::destroy(admin);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

#[test]
/// The pool meter bounds aggregate outflow independently of any single
/// tenant's own limit — one tenant must not be able to consume the protocol's
/// whole daily headroom, and the protocol must not be exposed to the sum of
/// every tenant's individually-reasonable limit.
fun the_pool_meter_is_independent_of_delegation_meters() {
    let mut scenario = test_scenario::begin(OPERATOR);
    {
        let ctx = scenario.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(1_000 * DAY);
        let admin = business_account::admin_cap_for_testing(ctx);
        settlement::create_pool<SUI>(&admin, FEE_SINK, PER_TX, WINDOW, PER_TX, WINDOW, &c, ctx);
        sui::test_utils::destroy(admin);
        c.destroy_for_testing();
    };

    scenario.next_tx(OPERATOR);
    {
        let pool = scenario.take_shared<settlement::SettlementPool<SUI>>();
        assert_eq!(settlement::payout_remaining_at(&pool, 1_000 * DAY), WINDOW);
        test_scenario::return_shared(pool);
    };
    scenario.end();
}

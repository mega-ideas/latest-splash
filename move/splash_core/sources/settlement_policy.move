/// SettlementPolicy — which address pays out Splash's own capital (WS3).
///
/// Before WS3 nothing on chain said who the operator was. The server opened an
/// intent with its key and paid it from its own gas coin in the next
/// transaction, and to the chain that was an ordinary payer settling its own
/// obligation: one address authorising and funding its own payout, with no
/// client signature and no approver anywhere. A stolen operator key was a
/// stolen treasury, bounded only by what that key held.
///
/// This object names the operator, and `payment_intent` reads it:
///
///   * a service order (`payment_intent::create_service_order`) records the
///     registered operator as its payer, so the approval travels to the
///     operator and only the operator can settle it — after a member of the
///     client's account opened it and a different approver approved it;
///   * once an operator is registered, the operator can no longer OPEN any
///     intent (`E_OPERATOR_NEEDS_SERVICE_ORDER`), so the self-authorised shape
///     is gone rather than discouraged.
///
/// Shared, because every intent creator must be able to read it, and
/// `AdminCap`-gated, because naming who spends Splash's capital is a
/// governance decision for the cold multisig, not something a hot server may
/// change about itself.
///
/// There is deliberately no `clear_operator`. Clearing the operator would
/// reopen the server-pays path for whoever held the key, so the policy only
/// ever moves forward: unset at publish, then registered, then rotated.
module splash_core::settlement_policy;

use splash_core::business_account::AdminCap;
use sui::event;

// ─── Abort codes ───────────────────────────────────────────────────────────
/// The operator was given as 0x0: service orders would record a payer that
/// nobody can sign for, and every one of them would expire unsettled.
const E_INVALID_OPERATOR: u64 = 1000;

/// Shared at publish with no operator. Until `set_operator` runs, service
/// orders refuse to open (`payment_intent::E_NO_OPERATOR`) and the unbound
/// paths behave exactly as before WS3.
public struct SettlementPolicy has key {
    id: UID,
    operator: Option<address>,
}

/// Every registration and rotation. Security-critical: off-chain monitoring
/// should alert on any change it did not initiate, because the new address is
/// the one that settles every service order opened from here on.
public struct OperatorChanged has copy, drop {
    policy_id: ID,
    previous: Option<address>,
    operator: address,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(SettlementPolicy { id: object::new(ctx), operator: option::none() });
}

/// Register or rotate the operator. Cold `AdminCap` only.
///
/// Rotation does not touch orders already open: each recorded its payer when
/// it was opened, and the five-minute window means the old operator's orders
/// are gone within minutes. Rotating to retire a compromised key is therefore
/// "rotate, then let the window close", and the old key can only ever have
/// paid out its own coin to a recipient the client chose and an approver saw.
public fun set_operator(_: &AdminCap, policy: &mut SettlementPolicy, operator: address) {
    assert!(operator != @0x0, E_INVALID_OPERATOR);
    let previous = policy.operator;
    policy.operator = option::some(operator);
    event::emit(OperatorChanged { policy_id: object::id(policy), previous, operator });
}

// ─── Views ─────────────────────────────────────────────────────────────────

public fun operator(policy: &SettlementPolicy): Option<address> { policy.operator }
public fun has_operator(policy: &SettlementPolicy): bool { policy.operator.is_some() }

/// True only for the registered operator; false for everyone while none is.
public fun is_operator(policy: &SettlementPolicy, who: address): bool {
    policy.operator.is_some() && *policy.operator.borrow() == who
}

// ─── Test helpers ──────────────────────────────────────────────────────────

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}

/// An unshared policy with no operator, for tests that only need to pass one.
#[test_only]
public fun new_for_testing(ctx: &mut TxContext): SettlementPolicy {
    SettlementPolicy { id: object::new(ctx), operator: option::none() }
}

#[test_only]
public fun destroy_for_testing(policy: SettlementPolicy) {
    let SettlementPolicy { id, operator: _ } = policy;
    id.delete();
}

#[test_only]
public fun unpack_operator_changed_for_testing(e: OperatorChanged): (ID, Option<address>, address) {
    let OperatorChanged { policy_id, previous, operator } = e;
    (policy_id, previous, operator)
}

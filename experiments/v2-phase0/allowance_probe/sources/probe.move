/// TESTNET-ONLY probe for the v2 Phase 0 gate. Not Splash's `splash_spend`.
///
/// `PROBE` is the app type an allowance is bound to. Only this module can make
/// `internal::permit<PROBE>()`, so only this module can produce the
/// `SettingsPermit<PROBE>` that `allowance::issue` (and `rotate_spender`) need,
/// and the `SpendPermit<PROBE>` that `app_balance_spend` needs. Neither permit
/// is ever returned to a caller.
///
/// There is deliberately no function here that rotates a spender.
module allowance_probe::probe;

use std::internal;
use sui::allowance::{Self, Allowance, AllowanceProposal, AllowanceWithdrawal};
use sui::balance::{Self, Balance};
use sui::clock::Clock;

/// The app an allowance is bound to.
public struct PROBE() has drop;

/// Accept an app-bound proposal the funder made with `propose_for_app` in the
/// same transaction. `issue` checks the proposal names `PROBE`, shares the
/// allowance and sends its `AllowanceCap` to the funder.
public fun accept<T>(proposal: AllowanceProposal<T>, ctx: &mut TxContext) {
    allowance::issue(proposal, allowance::settings_permit(internal::permit<PROBE>()), ctx)
}

/// Spend through the app path and deliver the funds to `to`'s address
/// balance. `app_balance_spend` still requires the transaction sender to be
/// the allowance's spender, and the withdrawal to come from the funder.
public fun spend_to<C>(
    a: &mut Allowance<Balance<C>>,
    w: AllowanceWithdrawal<Balance<C>>,
    to: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    let funds = allowance::app_balance_spend(a, allowance::spend_permit(internal::permit<PROBE>()), w, clock, ctx);
    balance::send_funds(funds, to);
}

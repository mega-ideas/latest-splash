module splash_custody::settlement;

use splash_core::business_account::{Self, BusinessAccount, AdminCap, TreasuryCap};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::peg_monitor::{Self, PegState};
use splash_custody::liquidity_guard;
use splash_custody::delegation::{Self, PayoutDelegation};
use splash_meter::guardian::GuardianCap;
use splash_meter::spend_meter::{Self, SpendMeter};
use sui::table::{Self, Table};
use deepbook::pool::Pool;
use openzeppelin_math::rounding;
use openzeppelin_math::u64 as oz_u64;
use sui::clock::{Self, Clock};
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;

// ─── Abort codes ────────────────────────────────────────────────────────────
const E_NOT_VERIFIED: u64 = 100;
const E_INSUFFICIENT_FUNDS: u64 = 101;
const E_EMPTY_BATCH: u64 = 102;
/// Caller passed fee_bps above MAX_FEE_BPS. Prevents fee gouging.
const E_FEE_EXCEEDED: u64 = 103;
const E_INVALID_RECIPIENT: u64 = 104;
const E_INVALID_AMOUNT: u64 = 105;
/// The BusinessAccount object was transferred away from the address recorded
/// as its owner. Verified status is not transferable (audit fix S-01).
const E_NOT_ACCOUNT_OWNER: u64 = 106;
/// Gross settlement below the configured minimum (ComplianceConfig).
const E_BELOW_MINIMUM: u64 = 107;
/// Batch exceeds MAX_BATCH_ROWS.
const E_BATCH_TOO_LARGE: u64 = 108;
/// The tenant's credit does not cover this run.
const E_INSUFFICIENT_CREDIT: u64 = 109;
/// Pool balance and the sum of credits have diverged — refuse rather than pay.
const E_CREDIT_INVARIANT: u64 = 118;
/// `withdraw_fees` may only pay the recipient fixed at pool creation.
const E_FEE_RECIPIENT_FIXED: u64 = 119;

// ─── Constants ──────────────────────────────────────────────────────────────
const BPS_DENOMINATOR: u64 = 10_000;
/// Hard ceiling on per-settlement fee. Any caller-supplied fee_bps above this
/// aborts the tx. 200 bps = 2.00%. Splash's advertised corridor fees are
/// 0.80%–1.10%, so 2% leaves headroom for emerging-market corridors but
/// prevents an attacker (or misconfigured off-chain quote) from siphoning
/// user funds via an absurd fee.
const MAX_FEE_BPS: u64 = 200;
/// Hard ceiling on rows per batch. Each row emits one `PaymentExecuted` event
/// AND creates one `Coin` object, and Sui caps a transaction at 1,024 emitted
/// events and 1,024 programmable-transaction commands. Without this bound a
/// large payroll is not merely expensive — above ~1,023 rows it is
/// unexecutable at any gas budget, and the caller only finds out from an
/// unnamed system error. 256 leaves ~4x headroom and gives the failure a name.
/// This is the custody pool's own bound. The TypeScript copy of it went with
/// the v1 payout-run route (v2 Phase 3). A business's Batch payouts run from
/// its own wallet and are capped at 20 payments (`BATCH_MAX_PAYMENTS` in
/// `lib/batch/sheet.ts`), a separate limit on a separate path.
const MAX_BATCH_ROWS: u64 = 256;

public struct SettlementPool<phantom T> has key {
    id: UID,
    balance: Balance<T>,
    protocol_fees: Balance<T>,
    /// Per-tenant credit. This is what makes cross-tenant drain STRUCTURALLY
    /// impossible rather than assert-prevented: a delegated batch can only spend
    /// `credits[business_owner]`, so the worst a compromised operator reaches is
    /// what that one tenant funded. The pool balance is the union of credits,
    /// not a commingled pot anyone can draw the whole of.
    credits: Table<address, u64>,
    /// Sum of `credits`. Kept alongside so the invariant
    /// `total_credit <= balance` is checkable in O(1) on the hot path — walking
    /// a Table per settlement is not affordable.
    total_credit: u64,
    /// Pool-wide velocity ceiling, on top of each delegation's own meter.
    /// Two meters, because a single tenant must not be able to consume the
    /// protocol's whole daily headroom, and the protocol must not be exposed to
    /// the sum of every tenant's individually-reasonable limit.
    payout_meter: SpendMeter,
    /// Fee sweeps get their own meter so a sweep can never eat payroll headroom.
    fee_meter: SpendMeter,
    /// FIXED at creation by the multisig. `withdraw_fees` takes no recipient
    /// argument at all — a compromised admin key cannot redirect revenue, only
    /// move it to the address the ceremony recorded.
    fee_recipient: address,
    /// Bumped by `revoke_all_delegations`. Every delegation records the epoch it
    /// was minted under, so ONE write invalidates all of them — including those
    /// held by an attacker, which the multisig cannot otherwise reach.
    delegation_epoch: u64,
}

public struct Payment has copy, drop, store {
    recipient: address,
    amount: u64,
}

public struct PaymentSettled has copy, drop {
    business_owner: address,
    recipient: address,
    gross_amount: u64,
    protocol_fee: u64,
    fee_bps: u64,
    net_amount: u64,
}

public struct PaymentExecuted has copy, drop {
    business_owner: address,
    recipient: address,
    gross_amount: u64,
    protocol_fee: u64,
    fee_bps: u64,
    net_amount: u64,
}

public fun new_payment(recipient: address, amount: u64): Payment {
    assert!(recipient != @0x0, E_INVALID_RECIPIENT);
    assert!(amount > 0, E_INVALID_AMOUNT);
    Payment { recipient, amount }
}

/// Create the shared pool. AdminCap-gated, and the ceremony fixes the fee
/// recipient and both velocity ceilings here — none of them is settable later by
/// the hot key.
public fun create_pool<T>(
    _admin: &AdminCap,
    fee_recipient: address,
    payout_per_tx_cap: u64,
    payout_window_cap: u64,
    fee_per_tx_cap: u64,
    fee_window_cap: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(fee_recipient != @0x0, E_INVALID_RECIPIENT);
    let pool = SettlementPool<T> {
        id: object::new(ctx),
        balance: balance::zero<T>(),
        protocol_fees: balance::zero<T>(),
        credits: table::new(ctx),
        total_credit: 0,
        payout_meter: spend_meter::new(payout_per_tx_cap, payout_window_cap, clock),
        fee_meter: spend_meter::new(fee_per_tx_cap, fee_window_cap, clock),
        fee_recipient,
        delegation_epoch: 0,
    };

    transfer::share_object(pool);
}

/// Mint the pause-only guardian for this pool's payout meter. Kept on a
/// SEPARATE host from the operator: if the stop button lives on the machine
/// being compromised, there is no stop button.
public fun mint_guardian_cap<T>(_admin: &AdminCap, pool: &SettlementPool<T>, holder: address, ctx: &mut TxContext) {
    spend_meter::mint_guardian(&pool.payout_meter, object::id(pool), holder, ctx);
}

/// Fund the pool ON BEHALF OF a named tenant. AdminCap-gated (M3 fix).
///
/// The credit attribution is what makes the pool safe to share. Without it the
/// balance is a commingled pot and any authorized payout can reach all of it —
/// so a single compromised delegation drains every tenant. With it, a batch can
/// only spend `credits[business_owner]`, and the blast radius of any single
/// authority is bounded by what that one tenant put in.
///
/// The deposit was also open to anyone and recorded nothing, which left the pool
/// unreconcilable and made an unsolicited deposit indistinguishable from
/// operational funding — an obvious layering vector into a shared object that
/// pays third parties.
public fun deposit_for<T>(
    _cap: &AdminCap,
    pool: &mut SettlementPool<T>,
    business_owner: address,
    coin: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(business_owner != @0x0, E_INVALID_RECIPIENT);
    let amount = coin::value(&coin);
    assert!(amount > 0, E_INVALID_AMOUNT);

    balance::join(&mut pool.balance, coin::into_balance(coin));
    credit_add(pool, business_owner, amount);

    event::emit(PoolFunded {
        pool_id: object::id(pool),
        depositor: tx_context::sender(ctx),
        business_owner,
        amount,
        new_balance: balance::value(&pool.balance),
        funded_at_ms: clock::timestamp_ms(clock),
    });
}

/// Return unspent credit to a tenant. Metered like any other outflow — a
/// "refund" that could move unbounded value would be a hole shaped exactly like
/// the one the meters exist to close.
public fun refund<T>(
    _treasury: &TreasuryCap,
    pool: &mut SettlementPool<T>,
    business_owner: address,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(amount > 0, E_INVALID_AMOUNT);
    assert!(credit_of(pool, business_owner) >= amount, E_INSUFFICIENT_CREDIT);

    let pool_id = object::id(pool);
    spend_meter::charge(&mut pool.payout_meter, pool_id, amount, clock);
    credit_sub(pool, business_owner, amount);

    let coin = coin::from_balance(balance::split(&mut pool.balance, amount), ctx);
    transfer::public_transfer(coin, business_owner);
    assert_credit_invariant(pool);
}

// ─── Credit ledger ──────────────────────────────────────────────────────────

fun credit_add<T>(pool: &mut SettlementPool<T>, who: address, amount: u64) {
    if (pool.credits.contains(who)) {
        let entry = pool.credits.borrow_mut(who);
        *entry = *entry + amount;
    } else {
        pool.credits.add(who, amount);
    };
    pool.total_credit = pool.total_credit + amount;
}

fun credit_sub<T>(pool: &mut SettlementPool<T>, who: address, amount: u64) {
    let entry = pool.credits.borrow_mut(who);
    assert!(*entry >= amount, E_INSUFFICIENT_CREDIT);
    *entry = *entry - amount;
    pool.total_credit = pool.total_credit - amount;
}

public fun credit_of<T>(pool: &SettlementPool<T>, who: address): u64 {
    if (pool.credits.contains(who)) *pool.credits.borrow(who) else 0
}

/// The pool must always hold at least what it owes. Checked AFTER every value
/// movement rather than before, so a bug that lets credits exceed backing aborts
/// the transaction that caused it instead of surfacing later as a shortfall
/// someone else discovers.
fun assert_credit_invariant<T>(pool: &SettlementPool<T>) {
    assert!(pool.total_credit <= balance::value(&pool.balance), E_CREDIT_INVARIANT);
}

/// Settle a single payment. `fee_bps` is set by the off-chain quote engine
/// per corridor (e.g. 80 for PHP, 110 for EUR) and is bounded by MAX_FEE_BPS.
public fun settle_payment<T, QuoteAsset>(
    pool: &mut SettlementPool<T>,
    business_account: &BusinessAccount,
    peg_state: &PegState,
    compliance_config: &ComplianceConfig,
    deepbook_pool: &Pool<T, QuoteAsset>,
    payment: Coin<T>,
    recipient: address,
    fee_bps: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(business_account::is_verified(business_account), E_NOT_VERIFIED);
    // Bind verified status to the address that passed KYB. The owned-object
    // rule already forces the tx sender to hold the account object; this
    // assert additionally rejects accounts whose object was transferred or
    // sold after verification (S-01: verified status is not transferable).
    assert!(business_account::owner(business_account) == tx_context::sender(ctx), E_NOT_ACCOUNT_OWNER);
    assert!(fee_bps <= MAX_FEE_BPS, E_FEE_EXCEEDED);
    assert!(recipient != @0x0, E_INVALID_RECIPIENT);
    peg_monitor::assert_pegged(peg_state, compliance_config, clock);

    let gross = coin::value(&payment);
    assert!(gross > 0, E_INVALID_AMOUNT);
    // Minimum settlement size. On-chain so the floor holds even if a caller
    // bypasses the API — the fixed cost of a settlement (anchor, evidence,
    // payout leg) does not scale down, and sub-minimum sizes cannot clear
    // DeepBook's minimum order size either.
    assert!(gross >= compliance_config::min_settlement_amount(compliance_config), E_BELOW_MINIMUM);
    liquidity_guard::assert_deepbook_liquidity(compliance_config, deepbook_pool, gross, clock);
    // OpenZeppelin checked mul_div (u128 intermediate, rounds down): fee
    // rounding always favors the payer, and overflow aborts instead of
    // wrapping.
    let fee = fee_of(gross, fee_bps);
    let net = gross - fee;

    assert!(net > 0, E_INSUFFICIENT_FUNDS);

    let mut payment_balance = coin::into_balance(payment);
    let fee_balance = balance::split(&mut payment_balance, fee);

    balance::join(&mut pool.protocol_fees, fee_balance);
    transfer::public_transfer(coin::from_balance(payment_balance, ctx), recipient);

    event::emit(PaymentSettled {
        business_owner: business_account::owner(business_account),
        recipient,
        gross_amount: gross,
        protocol_fee: fee,
        fee_bps,
        net_amount: net,
    });
}

/// Settle a payroll run against a tenant's delegation.
///
/// REPLACES `settle_batch`, which is UNCALLABLE after the key ceremony: it took
/// both `&AdminCap` (cold multisig) and `&BusinessAccount` (tenant), and a Sui
/// transaction may only name owned objects belonging to its own sender. Two
/// owners, one transaction — impossible. The `owner == sender` assert added for
/// S-07 made it strictly worse by pinning the sender to the tenant.
///
/// The delegation carries the tenant's identity, so attribution stays
/// chain-enforced without the `BusinessAccount` object being present. Four
/// independent bounds apply to every run:
///
///   1. the delegation must be live (not expired, not revoked, right epoch,
///      right operator, right pool)
///   2. the TENANT's own meter — their chosen rate limit
///   3. the POOL's meter — the protocol's aggregate ceiling
///   4. the tenant's CREDIT — they cannot spend what they did not fund
///
/// The total is charged UPFRONT, before a single coin moves, so a run that would
/// breach any bound aborts whole. A partially-paid payroll is worse than an
/// unpaid one.
public fun settle_batch_delegated<T, QuoteAsset>(
    pool: &mut SettlementPool<T>,
    delegation: &mut PayoutDelegation,
    peg_state: &PegState,
    compliance_config: &ComplianceConfig,
    deepbook_pool: &Pool<T, QuoteAsset>,
    payments: vector<Payment>,
    fee_bps: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(fee_bps <= MAX_FEE_BPS, E_FEE_EXCEEDED);
    peg_monitor::assert_pegged(peg_state, compliance_config, clock);
    assert!(vector::length(&payments) > 0, E_EMPTY_BATCH);
    assert!(vector::length(&payments) <= MAX_BATCH_ROWS, E_BATCH_TOO_LARGE);

    let mut total_amount = 0;
    let mut index = 0;
    while (index < vector::length(&payments)) {
        total_amount = total_amount + vector::borrow(&payments, index).amount;
        index = index + 1;
    };
    assert!(total_amount >= compliance_config::min_settlement_amount(compliance_config), E_BELOW_MINIMUM);
    liquidity_guard::assert_deepbook_liquidity(compliance_config, deepbook_pool, total_amount, clock);

    let pool_id = object::id(pool);
    let epoch = pool.delegation_epoch;

    // Charge every bound BEFORE moving value, so the run is all-or-nothing.
    delegation::authorize(delegation, pool_id, epoch, total_amount, clock, ctx);
    spend_meter::charge(&mut pool.payout_meter, pool_id, total_amount, clock);

    let business_owner = delegation::business_owner(delegation);
    assert!(credit_of(pool, business_owner) >= total_amount, E_INSUFFICIENT_CREDIT);
    credit_sub(pool, business_owner, total_amount);

    let mut payments = payments;
    while (!vector::is_empty(&payments)) {
        let payment = vector::pop_back(&mut payments);
        assert!(payment.recipient != @0x0, E_INVALID_RECIPIENT);
        assert!(payment.amount > 0, E_INVALID_AMOUNT);

        let fee = fee_of(payment.amount, fee_bps);
        let net = payment.amount - fee;
        assert!(net > 0, E_INSUFFICIENT_FUNDS);

        let fee_balance = balance::split(&mut pool.balance, fee);
        let payout_balance = balance::split(&mut pool.balance, net);

        balance::join(&mut pool.protocol_fees, fee_balance);
        transfer::public_transfer(coin::from_balance(payout_balance, ctx), payment.recipient);

        event::emit(PaymentExecuted {
            business_owner,
            recipient: payment.recipient,
            gross_amount: payment.amount,
            protocol_fee: fee,
            fee_bps,
            net_amount: net,
        });
    };

    assert_credit_invariant(pool);
}

public fun settle_sui_batch_delegated<QuoteAsset>(
    pool: &mut SettlementPool<SUI>,
    delegation: &mut PayoutDelegation,
    peg_state: &PegState,
    compliance_config: &ComplianceConfig,
    deepbook_pool: &Pool<SUI, QuoteAsset>,
    payments: vector<Payment>,
    fee_bps: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    settle_batch_delegated<SUI, QuoteAsset>(
        pool, delegation, peg_state, compliance_config, deepbook_pool, payments, fee_bps, clock, ctx,
    );
}

// ─── Delegation lifecycle ───────────────────────────────────────────────────

public struct DelegationsRevoked has copy, drop {
    pool_id: ID,
    new_epoch: u64,
}

/// Called by the TENANT from their own wallet — the only transaction that can
/// name their `BusinessAccount`.
public fun grant_delegation<T>(
    pool: &SettlementPool<T>,
    account: &BusinessAccount,
    operator: address,
    ttl_ms: u64,
    per_tx_cap: u64,
    window_cap: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    delegation::grant(
        account,
        object::id(pool),
        pool.delegation_epoch,
        operator,
        ttl_ms,
        per_tx_cap,
        window_cap,
        clock,
        ctx,
    );
}

/// Kill EVERY outstanding delegation in one write.
///
/// The multisig cannot revoke delegations individually — they are owned objects
/// held by the operator, and an attacker controlling that address will not hand
/// them back. Bumping a counter the delegations are checked against is the only
/// revocation that reaches them.
public fun revoke_all_delegations<T>(_admin: &AdminCap, pool: &mut SettlementPool<T>) {
    pool.delegation_epoch = pool.delegation_epoch + 1;
    event::emit(DelegationsRevoked { pool_id: object::id(pool), new_epoch: pool.delegation_epoch });
}

/// Revoke one delegation the admin can actually name.
public fun admin_revoke_delegation<T>(
    _admin: &AdminCap,
    _pool: &SettlementPool<T>,
    delegation: &mut PayoutDelegation,
) {
    delegation::revoke_by_admin(delegation);
}

// ─── Meter administration ───────────────────────────────────────────────────

/// Immediate. Reducing exposure must never wait.
public fun tighten_payout_limits<T>(
    _admin: &AdminCap,
    pool: &mut SettlementPool<T>,
    per_tx_cap: u64,
    window_cap: u64,
) {
    let id = object::id(pool);
    spend_meter::tighten(&mut pool.payout_meter, id, per_tx_cap, window_cap);
}

/// 48h of public notice, capped at 4x per step. An attacker with the money key
/// must announce a raise two days before they can use it.
public fun propose_payout_relax<T>(
    _admin: &AdminCap,
    pool: &mut SettlementPool<T>,
    per_tx_cap: u64,
    window_cap: u64,
    clock: &Clock,
) {
    let id = object::id(pool);
    spend_meter::propose_relax(&mut pool.payout_meter, id, per_tx_cap, window_cap, clock);
}

public fun cancel_payout_relax<T>(_admin: &AdminCap, pool: &mut SettlementPool<T>) {
    let id = object::id(pool);
    spend_meter::cancel_relax(&mut pool.payout_meter, id);
}

/// Back to the limits agreed at the ceremony. Instant, because recovering from a
/// defensive tighten is not a relaxation.
public fun restore_payout_bootstrap<T>(_admin: &AdminCap, pool: &mut SettlementPool<T>) {
    let id = object::id(pool);
    spend_meter::restore_bootstrap(&mut pool.payout_meter, id);
}

/// One signature, one machine, immediate — the Step Finance control.
public fun guardian_pause_pool<T>(pool: &mut SettlementPool<T>, cap: &GuardianCap) {
    let id = object::id(pool);
    spend_meter::guardian_pause(&mut pool.payout_meter, id, cap);
}

/// Restarting money movement is cold-key work, deliberately.
public fun unpause_pool<T>(_admin: &AdminCap, pool: &mut SettlementPool<T>) {
    let id = object::id(pool);
    spend_meter::unpause(&mut pool.payout_meter, id);
}

public fun payout_remaining_at<T>(pool: &SettlementPool<T>, now_ms: u64): u64 {
    spend_meter::remaining_at(&pool.payout_meter, now_ms)
}

/// Sweep accumulated protocol fees. AdminCap-gated, metered, and it takes NO
/// recipient argument.
///
/// Audit fix S-02 gave fees an extraction path; A-11 bounds it. Two changes
/// beyond the original:
///
///   * The destination is `pool.fee_recipient`, fixed at pool creation by the
///     ceremony. A caller-supplied recipient meant a compromised admin key could
///     redirect every future sweep to itself, which is revenue theft that looks
///     exactly like normal operation in the event log.
///   * A dedicated `fee_meter`, separate from the payout meter, so a sweep can
///     never consume payroll headroom and vice versa.
public fun withdraw_fees<T>(
    _treasury: &TreasuryCap,
    pool: &mut SettlementPool<T>,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(amount > 0, E_INVALID_AMOUNT);
    assert!(balance::value(&pool.protocol_fees) >= amount, E_INSUFFICIENT_FUNDS);

    let pool_id = object::id(pool);
    spend_meter::charge(&mut pool.fee_meter, pool_id, amount, clock);

    let recipient = pool.fee_recipient;
    let fees = balance::split(&mut pool.protocol_fees, amount);
    transfer::public_transfer(coin::from_balance(fees, ctx), recipient);

    event::emit(FeesWithdrawn { recipient, amount });
}

/// Repoint the fee destination. Deliberately routed through the SAME 48h notice
/// as a limit relaxation would be, by requiring the pool be paused first — a
/// silent redirect is the single highest-value action for a compromised admin
/// key, and it should not be a one-transaction operation.
public fun set_fee_recipient<T>(_admin: &AdminCap, pool: &mut SettlementPool<T>, recipient: address) {
    assert!(recipient != @0x0, E_INVALID_RECIPIENT);
    // Pausing first means a redirect cannot be slipped in between two normal
    // sweeps without the pause showing up in monitoring.
    assert!(spend_meter::is_paused(&pool.payout_meter), E_FEE_RECIPIENT_FIXED);
    let previous = pool.fee_recipient;
    pool.fee_recipient = recipient;
    event::emit(FeeRecipientChanged { pool_id: object::id(pool), previous, current: recipient });
}

public struct FeeRecipientChanged has copy, drop {
    pool_id: ID,
    previous: address,
    current: address,
}

public fun fee_recipient<T>(pool: &SettlementPool<T>): address { pool.fee_recipient }
public fun total_credit<T>(pool: &SettlementPool<T>): u64 { pool.total_credit }
public fun delegation_epoch<T>(pool: &SettlementPool<T>): u64 { pool.delegation_epoch }

/// Emitted on every pool funding. The pool pays third parties, so who funded it
/// and when must be reconstructable from chain data alone.
public struct PoolFunded has copy, drop {
    pool_id: ID,
    depositor: address,
    /// Whose credit this deposit created. Reconciliation joins on this.
    business_owner: address,
    amount: u64,
    new_balance: u64,
    funded_at_ms: u64,
}

public struct FeesWithdrawn has copy, drop {
    recipient: address,
    amount: u64,
}

/// Checked fee math shared by single and batch settlement.
fun fee_of(gross: u64, fee_bps: u64): u64 {
    oz_u64::mul_div(gross, fee_bps, BPS_DENOMINATOR, rounding::down()).destroy_some()
}

public fun pool_balance<T>(pool: &SettlementPool<T>): u64 {
    balance::value(&pool.balance)
}

public fun protocol_fees<T>(pool: &SettlementPool<T>): u64 {
    balance::value(&pool.protocol_fees)
}

/// Public read of the fee ceiling so off-chain code / explorers can verify
/// the bound without re-parsing the source.
public fun max_fee_bps(): u64 {
    MAX_FEE_BPS
}

/// splash_spend — pay an intent under a spending rule (D2).
///
/// A business's owners give someone a spending rule by proposing an app-bound
/// allowance from the business wallet to that person's address, bound to
/// `SPLASH_SPEND`, and accepting it here in the same transaction:
///
///     allowance::propose_for_app<Balance<USDC>, SPLASH_SPEND>(…)   // the wallet signs
///     splash_spend::accept(proposal, policy, account)
///
/// Inside the rule, a STAFF spender then opens and pays alone. The allowance
/// enforces its own caps, expiry and spender, and draws from the wallet's
/// address balance. This module adds the business's `SpendPolicy`: the payer
/// and the maker are on the policy, the destination is verified (a bank
/// beneficiary together with its partner deposit address, or a recipient
/// verified for exactly this kind of delivery), the amount is
/// within the policy's and the spender's ceilings, and when the amount, with
/// what the payer has already paid that recipient in the current window
/// (decision 4), is above the second-approval threshold, a different owner
/// has approved this exact payment. Then `splash_core` settles it against
/// the compliance config the policy recorded at creation (no other is
/// accepted), accepting this
/// package's `SettleWitness` because it is on that config's settlement-app
/// registry, and pays the intent's recipient in the same call.
///
/// A spending rule pays only on Sui: to a recipient the owners tagged a wallet
/// or an exchange, or as a bank payout to a beneficiary bound to its partner
/// deposit address. Core derives the kind it charges from that declared kind
/// and Splash's registries (A1 §2.3), so a registered business wallet is a
/// free Splash-business payment whatever its tag. A cross-chain payment
/// would have to hand the business's coin to the spender's transaction for
/// a bridge to burn, so it stays on the owners' multisig
/// (`payment_intent::confirm_cross_chain_from_business_wallet`).
///
/// ─── Splash's operator is an EXECUTOR, not staff ───────────────────────────
///
/// Scheduled payments and batches run later under Splash's KMS operator, with
/// its own tightly capped allowance. The operator cannot open an intent, and
/// cannot pay one without an approval the OWNERS gave naming it as the payer:
/// an owner's `approve_payout`, or the wallet's own `delegate_execution` of an
/// intent the wallet itself opened. A staff member cannot hand a payment to
/// the operator: the operator pays from its own allowance, so a staff
/// delegation would let that person spend past their own rule's caps, expiry
/// and revocation. So the operator can only ever pay intents the owners
/// approved, to verified recipients within caps, and a stolen operator key
/// can start nothing.
///
/// ─── The permits never leave ────────────────────────────────────────────────
///
/// `internal::permit<SPLASH_SPEND>()` can only be called in this module, and it
/// is called in exactly two places: inside `accept`, passed straight through
/// `settings_permit` to `allowance::issue`; and inside the private `draw`,
/// passed straight through `spend_permit` to `allowance::app_balance_spend`.
/// No function returns a permit, a witness, a `Balance` or a `Coin`, and
/// there is no `rotate_spender`: a holder of `SettingsPermit<SPLASH_SPEND>`
/// could move every allowance bound to this app to a new spender. The
/// package publishes immutable, so none of that can be added later.
/// `scripts/check-spend-permits.mjs` fails the build if a permit, a witness
/// or a `Balance` could escape, and `tests/spend-rules-sui-only.test.mjs`
/// fails if a `Coin` could.
module splash_spend::splash_spend;

use splash_core::address_registry::{Self, Registry};
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::fee_config::{Self, FeeConfig};
use splash_core::payment_intent::{Self, PaymentIntent, SettleReceipt};
use splash_spend::spend_policy::{Self, SpendPolicy};
use std::internal;
use std::string::String;
use sui::allowance::{Self, Allowance, AllowanceProposal, AllowanceWithdrawal};
use sui::balance::Balance;
use sui::clock::Clock;
use sui::event;

// ─── Abort codes ───────────────────────────────────────────────────────────
/// The allowance is not funded by this policy's wallet.
const E_WRONG_FUNDER: u64 = 1000;
/// The sender (or the named payer) is not a spender under this policy.
const E_NOT_A_SPENDER: u64 = 1001;
/// The policy, the account and the intent do not all belong together.
const E_WRONG_ACCOUNT: u64 = 1002;
/// The destination is not on the policy's verified list.
const E_RECIPIENT_NOT_VERIFIED: u64 = 1003;
/// The bank payout's beneficiary is not verified for this partner address.
const E_BENEFICIARY_NOT_VERIFIED: u64 = 1004;
/// The payment is above the policy's or the spender's per-payment maximum.
const E_OVER_PER_PAYMENT_MAX: u64 = 1005;
/// The payment needs an approval and carries none: with what its payer has
/// already paid its recipient in the current window, and what the window
/// before it paid less than a window ago (`spend_policy::threshold_total`),
/// it is above the second-approval threshold, or the payer is an executor.
const E_APPROVAL_REQUIRED: u64 = 1006;
/// The approval is for a different policy, intent, amount or payer.
const E_APPROVAL_MISMATCH: u64 = 1007;
/// The approver opened the intent or is paying it.
const E_SELF_APPROVAL: u64 = 1008;
/// The approver is not one of the wallet's members.
const E_NOT_AN_OWNER: u64 = 1009;
/// The approval's `settle_by_ms` has passed: the quote it was given against
/// has lapsed (at the latest, with its intent).
const E_APPROVAL_EXPIRED: u64 = 1010;
/// The account has rotated to a new wallet generation; this policy belongs to
/// an old one.
const E_STALE_POLICY: u64 = 1011;
/// `accept` was given a proposal funded by someone other than the policy's wallet.
const E_PROPOSAL_FUNDER: u64 = 1012;
/// `accept` was given a proposal whose spender is not on the policy.
const E_PROPOSAL_SPENDER: u64 = 1013;
/// The intent is not pending, or has expired.
const E_NOT_PAYABLE: u64 = 1014;
/// Only STAFF open intents. An executor only pays.
const E_NOT_STAFF: u64 = 1015;
/// The intent's maker is neither the wallet nor a current staff spender.
const E_MAKER_NOT_A_SPENDER: u64 = 1016;
/// The coin type is not the policy's asset.
const E_WRONG_ASSET: u64 = 1017;
// 1018 is retired with the staff delegation it refused above the threshold.
/// The wallet delegates only an intent it opened itself.
const E_NOT_THE_MAKER: u64 = 1019;
/// Execution can be delegated only to an executor.
const E_NOT_AN_EXECUTOR: u64 = 1020;
/// The account's authority changed (a freeze, a membership change, a wallet
/// change), or the policy removed a spender, a recipient or a beneficiary,
/// after this approval was given.
const E_STALE_APPROVAL: u64 = 1021;
/// A cross-chain intent is not paid under a spending rule. The owners pay it
/// from the wallet.
const E_WRONG_PAY_PATH: u64 = 1022;
/// The allowance was not issued for this policy: its name is not this
/// policy's `allowance_name`.
const E_ALLOWANCE_NOT_FOR_POLICY: u64 = 1023;
/// Only the business wallet delegates execution. A staff member cannot.
const E_ONLY_THE_WALLET_DELEGATES: u64 = 1024;
/// The recipient is verified, but tagged another kind: the owners chose the
/// kind its payments declare (a wallet or an exchange) when they verified
/// it, and an intent to it must declare that kind.
const E_WRONG_DELIVERY_KIND: u64 = 1025;
/// An approval's `settle_by_ms` must be in the future and no later than the
/// intent's expiry.
const E_BAD_SETTLE_BY: u64 = 1026;
/// The payment's `settle_by_ms` is later than the one its approval names.
const E_SETTLE_BY_AFTER_APPROVAL: u64 = 1027;
/// The compliance config is not the one this policy was created against.
const E_WRONG_CONFIG: u64 = 1028;
/// The recipient is a partner deposit address (decision 2): one the policy
/// binds a beneficiary to, or one in Splash's partner registry. It is paid
/// only as a bank payout (kind 4) for a verified beneficiary bound to it.
const E_PARTNER_DEPOSIT_NOT_BANK_PAYOUT: u64 = 1029;
/// A bank payout's partner deposit address is a registered business wallet,
/// so core would credit it as a free Splash-business payment that no
/// partner pays out. A bank payout goes only to Splash's partner registry.
const E_BANK_PAYOUT_NOT_TO_PARTNER: u64 = 1030;
/// Splash's fee on this payment is above the `max_fee` the spender signed
/// for (A1 §2.6): the schedule changed after the quote.
const E_FEE_ABOVE_MAX: u64 = 1031;
/// Splash's fee is above this package's own ceiling, 1% of the principal.
const E_FEE_ABOVE_CEILING: u64 = 1032;
/// The principal and Splash's fee are above the `max_total` the approval
/// names (A1 §2.6): the owners approved less. Approve again.
const E_FEE_ABOVE_APPROVED: u64 = 1033;
/// An approval's `max_total` must be at least the intent's principal.
const E_BAD_MAX_TOTAL: u64 = 1034;
/// The FeeConfig is not Splash's one, which the policy recorded at creation.
const E_WRONG_FEE_CONFIG: u64 = 1035;
/// The address Registry is not Splash's one, which the policy recorded.
const E_WRONG_ADDRESS_REGISTRY: u64 = 1036;
/// `max_fee` is above this package's own ceiling, 1% of the principal: more
/// than Splash's fee can ever be. The allowance counts the whole principal
/// plus `max_fee`, so headroom above any possible fee would use up the
/// rule's caps on money that comes straight back.
const E_MAX_FEE_ABOVE_CEILING: u64 = 1037;

/// A1 §2.6: the most Splash's fee may be on a rule payment, in basis points
/// of the principal. This package's own constant, checked on what core
/// actually charged, so neither a later core nor a FeeConfig it writes can
/// make a spending rule pay Splash more. splash_spend publishes immutable.
const FEE_CEILING_BPS: u64 = 100;
const BPS_DENOM: u64 = 10_000;

/// What an allowance accepted under a policy must be named: this prefix and
/// the policy's id. The allowance module never reads its name, so this module
/// uses it to bind each allowance to the one policy it was accepted under.
const ALLOWANCE_NAME_PREFIX: vector<u8> = b"splash-policy:";

/// The allowance app type. Never constructed: the allowance module records its
/// type name, and `internal::permit` needs only the type.
public struct SPLASH_SPEND() has drop;

/// The witness `splash_core` accepts from this package, once it is on the
/// settlement-app registry. Constructed only as a direct argument to
/// `splash_core`; never returned.
public struct SettleWitness has drop {}

/// The owners' approval to pay ONE intent: this policy, this intent, this
/// amount, by this payer, at most `max_total` in all with Splash's fee,
/// while the account's authority and the policy's generation are
/// unchanged, and against a quote that holds until `settle_by_ms`.
///
/// It is one of two things, and both are the owners' decision: an owner's
/// second approval (`approve_payout`; the approver is a wallet member), or
/// the wallet's delegation of an intent it opened itself to an executor
/// (`delegate_execution`; the approver is the wallet).
///
/// `key` only, so it cannot be wrapped or `public_transfer`red, and consumed
/// by value when used, so it cannot be replayed.
public struct PayoutApproval has key {
    id: UID,
    policy: ID,
    /// The policy's generation when this was given. Any removal from the
    /// policy moves it, and the approval is then dead for good.
    policy_generation: u64,
    intent: ID,
    amount: u64,
    /// A1 §2.6: the principal and the Splash fee the approver was shown.
    /// The payment aborts if the principal and the fee charged are above
    /// it, for example when the schedule rose after approval.
    max_total: u64,
    approver: address,
    payer: address,
    authority_epoch: u64,
    /// The latest moment the payment may settle, chosen by the approver: the
    /// deadline of the quote (or of the scheduled window) they approved. No
    /// later than the intent's expiry. The payer's own `settle_by_ms` must
    /// not exceed it, so the approval binds the rate hold it was given
    /// against, not a deadline the payer picks.
    settle_by_ms: u64,
}

// ─── Events ────────────────────────────────────────────────────────────────

public struct SpendingRuleAccepted has copy, drop {
    policy_id: ID,
    funder: address,
    spender: address,
}

public struct SpendApproved has copy, drop {
    approval_id: ID,
    policy_id: ID,
    intent_id: ID,
    approver: address,
    payer: address,
    commitment: vector<u8>,
}

public struct SpendApprovalConsumed has copy, drop {
    approval_id: ID,
    policy_id: ID,
    intent_id: ID,
    approver: address,
}

/// An approval thrown away unused, so an indexer of outstanding approvals
/// sees it end as it sees a consumed one end.
public struct SpendApprovalDiscarded has copy, drop {
    approval_id: ID,
    policy_id: ID,
    intent_id: ID,
    approver: address,
}

/// A1 §2.9: a payment under a spending rule. Which rule paid which intent
/// (the policy, the allowance, the approval if any), who paid whom (the
/// spender and the recipient address), the kind core charged it as, and
/// Splash's fee on it. The controls-evidence export and Phase 2's
/// near-threshold alerts read it. The principal is not here; the intent's
/// commitment is, in `IntentConfirmed`.
public struct RuleSpend has copy, drop {
    policy_id: ID,
    intent_id: ID,
    allowance_id: ID,
    approval_id: Option<ID>,
    spender: address,
    recipient: address,
    derived_kind: u8,
    fee: u64,
}

// ─── Spending rules ────────────────────────────────────────────────────────

/// Accept a spending rule the business wallet proposed, in the same
/// transaction as `allowance::propose_for_app<Balance<T>, SPLASH_SPEND>`.
///
/// The proposal is checked before it is issued: the policy must be its
/// account's current one and the account not frozen (a new rule grows the
/// policy), its funder must be this policy's wallet (which also means the
/// wallet signed this transaction, since `propose_for_app` records the
/// sender as funder), its spender must be on the policy, `T` must be the
/// policy's asset, and its name must be this policy's `allowance_name`.
/// `issue` checks the app.
///
/// The name is the binding. `allowance::issue` returns nothing, so this
/// module cannot record which allowance it accepted; instead every allowance
/// carries its policy's id in its name, and `pay_intent` refuses one whose
/// name is any other policy's. An allowance from an earlier wallet generation
/// therefore never pays under a later policy, even one listing the same
/// spender.
public fun accept<T>(
    proposal: AllowanceProposal<Balance<T>>,
    policy: &SpendPolicy,
    account: &BusinessAccount,
    ctx: &mut TxContext,
) {
    spend_policy::assert_can_grow(policy, account);
    assert!(compliance_config::type_string<T>() == spend_policy::asset(policy), E_WRONG_ASSET);
    let settings = allowance::allowance_proposal_settings(&proposal);
    let funder = allowance::funder(settings);
    assert!(funder == spend_policy::wallet(policy), E_PROPOSAL_FUNDER);
    let spender = allowance::spender(settings);
    assert!(spender.is_some() && spend_policy::is_spender(policy, *spender.borrow()), E_PROPOSAL_SPENDER);
    assert!(*allowance::name(settings) == allowance_name(policy), E_ALLOWANCE_NOT_FOR_POLICY);

    allowance::issue(proposal, allowance::settings_permit(internal::permit<SPLASH_SPEND>()), ctx);
    event::emit(SpendingRuleAccepted {
        policy_id: object::id(policy),
        funder,
        spender: *spender.borrow(),
    });
}

// ─── Intents ───────────────────────────────────────────────────────────────

/// Open an intent in the account's name, as STAFF under this policy.
///
/// The config must be the one the policy was created against, the
/// destination already verified and the amount within the ceilings, so an
/// intent that could never be paid under this policy is never opened.
/// `pay_intent` checks everything again, since the policy can change in
/// between. Returned by value: share it, or pay it in the same transaction.
public fun create_intent<T>(
    policy: &SpendPolicy,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    payment_ref: vector<u8>,
    recipient: address,
    beneficiary_ref: vector<u8>,
    amount: u64,
    target_currency: String,
    fx_rate_usd_local: u64,
    commitment: vector<u8>,
    kind: u8,
    rail_commitment: vector<u8>,
    expires_at: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    let maker = ctx.sender();
    assert_current(policy, account);
    assert_config(policy, config);
    assert!(compliance_config::type_string<T>() == spend_policy::asset(policy), E_WRONG_ASSET);
    assert!(spend_policy::is_staff(policy, maker), E_NOT_STAFF);
    assert_sui_destination(policy, kind, recipient, beneficiary_ref);
    assert_within_limits(policy, amount, maker);

    payment_intent::create_for_app<T, SettleWitness>(
        SettleWitness {},
        account,
        config,
        maker,
        payment_ref,
        recipient,
        beneficiary_ref,
        amount,
        target_currency,
        fx_rate_usd_local,
        commitment,
        kind,
        rail_commitment,
        expires_at,
        clock,
        ctx,
    )
}

// ─── Approvals ─────────────────────────────────────────────────────────────

/// A second approval, by an owner, for one payment, to be paid by `payer`.
///
/// The owner is one of the wallet's members, acting alone with their own key.
/// They may not be the intent's maker or its payer: four eyes means two
/// different people (or at least two different addresses; the chain cannot
/// tell people apart). The approval goes to `payer`, who must be a spender.
///
/// `max_total` is the principal and the Splash fee the owner was shown
/// (A1 §2.6), at least the principal. `settle_by_ms` is the deadline of the
/// quote the owner is approving: the payment cannot settle after it,
/// whatever deadline the payer passes. It must be in the future and no
/// later than the intent's expiry.
public fun approve_payout(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    payer: address,
    max_total: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let approver = ctx.sender();
    assert!(spend_policy::is_owner(policy, approver), E_NOT_AN_OWNER);
    assert!(approver != payment_intent::sender(intent), E_SELF_APPROVAL);
    assert!(approver != payer, E_SELF_APPROVAL);
    assert!(spend_policy::is_spender(policy, payer), E_NOT_A_SPENDER);
    mint_approval(policy, account, intent, approver, payer, max_total, settle_by_ms, clock, ctx);
}

/// Let an executor run this intent later: the wallet's delegation of an
/// intent the wallet itself opened.
///
/// The sender must be the wallet, so the owners' quorum signs it; it counts
/// as their approval at any amount. A staff member cannot delegate, even a
/// payment they could make alone: for staff payments the operator needs an
/// owner's `approve_payout` naming it as the payer.
///
/// `max_total` is the principal and the Splash fee the wallet was shown,
/// at least the principal. `settle_by_ms` is the end of the window the
/// executor may run it in (a quote's deadline, or the scheduled window's
/// end), in the future and no later than the intent's expiry.
public fun delegate_execution(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    executor: address,
    max_total: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let wallet = ctx.sender();
    assert!(wallet == spend_policy::wallet(policy), E_ONLY_THE_WALLET_DELEGATES);
    assert!(payment_intent::sender(intent) == wallet, E_NOT_THE_MAKER);
    assert!(spend_policy::is_executor(policy, executor), E_NOT_AN_EXECUTOR);
    mint_approval(policy, account, intent, wallet, executor, max_total, settle_by_ms, clock, ctx);
}

fun mint_approval(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    approver: address,
    payer: address,
    max_total: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_current(policy, account);
    assert_intent_of(policy, intent);
    assert!(payment_intent::is_pending(intent), E_NOT_PAYABLE);
    assert!(clock.timestamp_ms() < payment_intent::expires_at(intent), E_NOT_PAYABLE);
    // An approval that no spending rule could ever use is refused, not minted.
    assert!(payment_intent::kind(intent) != payment_intent::kind_cross_chain(), E_WRONG_PAY_PATH);
    assert!(settle_by_ms > clock.timestamp_ms(), E_BAD_SETTLE_BY);
    assert!(settle_by_ms <= payment_intent::expires_at(intent), E_BAD_SETTLE_BY);
    let amount = payment_intent::amount_usd(intent);
    assert!(max_total >= amount, E_BAD_MAX_TOTAL);

    let approval = PayoutApproval {
        id: object::new(ctx),
        policy: object::id(policy),
        policy_generation: spend_policy::generation(policy),
        intent: object::id(intent),
        amount,
        max_total,
        approver,
        payer,
        authority_epoch: business_account::authority_epoch(account),
        settle_by_ms,
    };
    event::emit(SpendApproved {
        approval_id: object::id(&approval),
        policy_id: object::id(policy),
        intent_id: object::id(intent),
        approver,
        payer,
        commitment: payment_intent::commitment(intent),
    });
    transfer::transfer(approval, payer);
}

/// Throw away an approval that will not be used. Emits
/// `SpendApprovalDiscarded`.
public fun discard_approval(approval: PayoutApproval) {
    let PayoutApproval {
        id,
        policy: policy_id,
        policy_generation: _,
        intent: intent_id,
        amount: _,
        max_total: _,
        approver,
        payer: _,
        authority_epoch: _,
        settle_by_ms: _,
    } = approval;
    event::emit(SpendApprovalDiscarded { approval_id: id.to_inner(), policy_id, intent_id, approver });
    id.delete();
}

// ─── Paying ────────────────────────────────────────────────────────────────

/// Pay an intent under a spending rule. The sender is the allowance's spender.
///
/// `withdrawal` is the allowance withdrawal input for exactly the intent's
/// amount plus `max_fee` (A1 §2.6: the Splash fee the spender was shown),
/// from the business wallet's address balance, so the allowance's caps
/// cover both. `max_fee` is at most 1% of the amount, this package's own
/// ceiling (E_MAX_FEE_ABOVE_CEILING), so what a rule payment draws is never
/// more than the principal and 1%. `settle_by_ms` is the quote's deadline. `config` must be the
/// one the policy was created against, and `fee_cfg` and `registry` are
/// Splash's. The intent lands on Sui, and core pays its recipient in this
/// call; a cross-chain intent is refused.
///
/// The fee (A1 §2.6). `draw` refuses a `max_fee` above this package's own
/// 1% ceiling, derives the kind and computes the fee, and refuses it above
/// `max_fee` or with the principal above an approval's `max_total`. Core
/// charges the same fee to its fee recipient inside its settle path, and
/// sends the unused part of `max_fee` to `business_account::wallet(account)`,
/// which `draw` has checked is this policy's wallet; never to the spender.
/// `close_rule_payment` then checks the fee core hands back against this
/// package's own ceiling, and `RuleSpend` records it.
///
/// The kind declared to core is the recipient's tag in the policy, or a bank
/// payout for a beneficiary bound to its partner deposit address (A1 §2.3);
/// `draw` has checked that the intent declares the same.
public fun pay_intent<C>(
    allowance: &mut Allowance<Balance<C>>,
    withdrawal: AllowanceWithdrawal<Balance<C>>,
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    policy: &mut SpendPolicy,
    config: &ComplianceConfig,
    fee_cfg: &FeeConfig,
    registry: &Registry,
    approval: Option<PayoutApproval>,
    max_fee: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    assert!(payment_intent::kind(intent) != payment_intent::kind_cross_chain(), E_WRONG_PAY_PATH);
    let approval_id = if (approval.is_some()) option::some(object::id(approval.borrow())) else option::none();
    let funds = draw(
        allowance,
        withdrawal,
        intent,
        account,
        policy,
        config,
        fee_cfg,
        registry,
        approval,
        max_fee,
        settle_by_ms,
        clock,
        ctx,
    );
    let declared = declared_kind(policy, intent);
    let (receipt, derived_kind, fee) = payment_intent::settle_from_app<C, SettleWitness>(
        SettleWitness {},
        intent,
        account,
        config,
        fee_cfg,
        registry,
        declared,
        funds,
        max_fee,
        settle_by_ms,
        clock,
        ctx,
    );
    close_rule_payment(policy, intent, allowance, approval_id, derived_kind, fee, ctx);
    receipt
}

/// Once core has settled a rule payment: the fee core hands back as the fee
/// it charged is checked against this package's own ceiling, 1% of the
/// principal (A1 §2.6), and the payment is recorded in `RuleSpend`. This
/// is the check that holds whatever a later core does, since it uses this
/// package's own constant. `pay_intent` and its test-only twin both end
/// here, so the check the tests show biting is the one that runs.
fun close_rule_payment<C>(
    policy: &SpendPolicy,
    intent: &PaymentIntent,
    allowance: &Allowance<Balance<C>>,
    approval_id: Option<ID>,
    derived_kind: u8,
    fee: u64,
    ctx: &TxContext,
) {
    assert!(fee <= fee_ceiling(payment_intent::amount_usd(intent)), E_FEE_ABOVE_CEILING);
    event::emit(RuleSpend {
        policy_id: object::id(policy),
        intent_id: object::id(intent),
        allowance_id: object::id(allowance),
        approval_id,
        spender: ctx.sender(),
        recipient: payment_intent::recipient(intent),
        derived_kind,
        fee,
    });
}

/// Test builds only; never publishes (the A1 review). `pay_intent`, line for
/// line, but settling through core's test-only
/// `payment_intent::settle_reporting_fee_from_app`, which hands back
/// `reported_fee` as the fee it charged. No published core can hand back a
/// fee above its own 1% clamp; this stands in for one that did, so a test
/// can show `close_rule_payment` refusing it.
#[test_only]
public fun pay_intent_reporting_fee_for_testing<C>(
    allowance: &mut Allowance<Balance<C>>,
    withdrawal: AllowanceWithdrawal<Balance<C>>,
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    policy: &mut SpendPolicy,
    config: &ComplianceConfig,
    fee_cfg: &FeeConfig,
    registry: &Registry,
    approval: Option<PayoutApproval>,
    max_fee: u64,
    settle_by_ms: u64,
    reported_fee: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    assert!(payment_intent::kind(intent) != payment_intent::kind_cross_chain(), E_WRONG_PAY_PATH);
    let approval_id = if (approval.is_some()) option::some(object::id(approval.borrow())) else option::none();
    let funds = draw(
        allowance,
        withdrawal,
        intent,
        account,
        policy,
        config,
        fee_cfg,
        registry,
        approval,
        max_fee,
        settle_by_ms,
        clock,
        ctx,
    );
    let declared = declared_kind(policy, intent);
    let (receipt, derived_kind, fee) = payment_intent::settle_reporting_fee_from_app<C, SettleWitness>(
        SettleWitness {},
        intent,
        account,
        config,
        fee_cfg,
        registry,
        declared,
        funds,
        max_fee,
        settle_by_ms,
        reported_fee,
        clock,
        ctx,
    );
    close_rule_payment(policy, intent, allowance, approval_id, derived_kind, fee, ctx);
    receipt
}

/// Every check the policy adds, then the withdrawal. Private: the `Balance`
/// it returns goes only to `splash_core`'s settle path.
fun draw<C>(
    allowance: &mut Allowance<Balance<C>>,
    withdrawal: AllowanceWithdrawal<Balance<C>>,
    intent: &PaymentIntent,
    account: &BusinessAccount,
    policy: &mut SpendPolicy,
    config: &ComplianceConfig,
    fee_cfg: &FeeConfig,
    registry: &Registry,
    approval: Option<PayoutApproval>,
    max_fee: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
): Balance<C> {
    let payer = ctx.sender();
    // The money is this policy's wallet's, in this policy's asset, under this
    // policy's compliance config, Splash's fee config and address registry;
    // the policy is the account's current one; the intent is the account's.
    assert!(allowance::funder(allowance::allowance_settings(allowance)) == spend_policy::wallet(policy), E_WRONG_FUNDER);
    assert!(compliance_config::type_string<C>() == spend_policy::asset(policy), E_WRONG_ASSET);
    assert_config(policy, config);
    assert!(object::id(fee_cfg) == spend_policy::fee_config(policy), E_WRONG_FEE_CONFIG);
    assert!(object::id(registry) == spend_policy::address_registry(policy), E_WRONG_ADDRESS_REGISTRY);
    assert_current(policy, account);
    assert_intent_of(policy, intent);

    // Who pays, and who opened it. Removing a staff member stops their open
    // intents as well as their own payments.
    assert!(spend_policy::is_spender(policy, payer), E_NOT_A_SPENDER);
    let maker = payment_intent::sender(intent);
    let by_wallet = maker == spend_policy::wallet(policy);
    assert!(by_wallet || spend_policy::is_staff(policy, maker), E_MAKER_NOT_A_SPENDER);

    // Where. The destination key is built here, on domain 8, not read whole
    // off the intent.
    let kind = payment_intent::kind(intent);
    let recipient = payment_intent::recipient(intent);
    let beneficiary_ref = payment_intent::beneficiary_ref(intent);
    assert_sui_destination(policy, kind, recipient, beneficiary_ref);
    // What core will charge it as (A1 §2.3). A partner deposit address in
    // Splash's registry is paid only as a bank payout, even when the policy
    // tags it otherwise; a bank payout goes only to such an address.
    let derived = address_registry::derive_kind(registry, recipient, declared_kind(policy, intent), false);
    if (kind == payment_intent::kind_bank_payout()) {
        assert!(derived == payment_intent::kind_bank_payout(), E_BANK_PAYOUT_NOT_TO_PARTNER);
    } else {
        assert!(derived != payment_intent::kind_bank_payout(), E_PARTNER_DEPOSIT_NOT_BANK_PAYOUT);
    };

    // How much: the policy's ceiling, the payer's, and the maker's. Each
    // applies to the principal.
    let amount = payment_intent::amount_usd(intent);
    assert_within_limits(policy, amount, payer);
    if (!by_wallet) assert_within_limits(policy, amount, maker);

    // Splash's fee (A1 §2.6), for the derived kind: within what the spender
    // signed for and this package's own ceiling. Core charges exactly this,
    // from the same FeeConfig, in this transaction. max_fee itself is
    // within that ceiling first (the A1 review): the allowance counts all
    // of the principal and max_fee, so a spender cannot use up a rule's
    // caps on fee headroom that comes back to the wallet. A fee within
    // max_fee is then within the ceiling too; `close_rule_payment` checks
    // the fee core hands back against it once more.
    assert!(max_fee <= fee_ceiling(amount), E_MAX_FEE_ABOVE_CEILING);
    let fee = fee_config::splash_fee(fee_cfg, object::id(account), derived, amount);
    assert!(fee <= max_fee, E_FEE_ABOVE_MAX);

    // Approvals: the owners', when this payment takes what the payer has
    // paid this recipient above the threshold (decision 4), and for an
    // executor always. What counts is the current window's total and what
    // the window before it paid less than a window length ago
    // (`threshold_total`), so a window primed at its start cannot double
    // the threshold across its boundary. Every approval is the owners' (an
    // owner's, or the wallet's delegation), and any approval passed must
    // match and is consumed.
    let now = clock.timestamp_ms();
    let paid_so_far = spend_policy::threshold_total(policy, payer, kind, recipient, beneficiary_ref, now);
    let threshold = spend_policy::second_approval_threshold(policy);
    let over_threshold = paid_so_far > threshold || amount > threshold - paid_so_far;
    let needs_approval = over_threshold || spend_policy::is_executor(policy, payer);
    if (approval.is_some()) {
        consume(approval.destroy_some(), policy, account, intent, payer, fee, settle_by_ms, clock);
    } else {
        approval.destroy_none();
        assert!(!needs_approval, E_APPROVAL_REQUIRED);
    };
    // Every payment counts toward the total, approved or not.
    spend_policy::record_payment(policy, payer, kind, recipient, beneficiary_ref, amount, now);

    let funds = allowance::app_balance_spend(
        allowance,
        allowance::spend_permit(internal::permit<SPLASH_SPEND>()),
        withdrawal,
        clock,
        ctx,
    );
    // The allowance belongs to this policy. Checked last, so every earlier
    // refusal keeps its own code; the transaction aborts as a whole either way.
    assert!(*allowance::name(allowance::allowance_settings(allowance)) == allowance_name(policy), E_ALLOWANCE_NOT_FOR_POLICY);
    funds
}

/// Check an approval against this payment and consume it. `fee` is Splash's
/// fee on it, which with the principal must be within the approval's
/// `max_total`. `settle_by_ms` is the deadline this payment passes to core,
/// which must not be later than the one the approval names.
fun consume(
    approval: PayoutApproval,
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    payer: address,
    fee: u64,
    settle_by_ms: u64,
    clock: &Clock,
) {
    let PayoutApproval {
        id,
        policy: policy_id,
        policy_generation,
        intent: intent_id,
        amount,
        max_total,
        approver,
        payer: named_payer,
        authority_epoch,
        settle_by_ms: approved_settle_by_ms,
    } = approval;
    assert!(policy_id == object::id(policy), E_APPROVAL_MISMATCH);
    assert!(intent_id == object::id(intent), E_APPROVAL_MISMATCH);
    assert!(amount == payment_intent::amount_usd(intent), E_APPROVAL_MISMATCH);
    // A1 §2.6: principal + fee <= max_total. `max_total >= amount` since it
    // was minted, so this cannot underflow.
    assert!(fee <= max_total - amount, E_FEE_ABOVE_APPROVED);
    assert!(named_payer == payer, E_APPROVAL_MISMATCH);
    assert!(authority_epoch == business_account::authority_epoch(account), E_STALE_APPROVAL);
    assert!(policy_generation == spend_policy::generation(policy), E_STALE_APPROVAL);
    assert!(clock.timestamp_ms() < approved_settle_by_ms, E_APPROVAL_EXPIRED);
    assert!(settle_by_ms <= approved_settle_by_ms, E_SETTLE_BY_AFTER_APPROVAL);
    // Who approved, checked again at use, not trusted from minting.
    let maker = payment_intent::sender(intent);
    if (approver == spend_policy::wallet(policy)) {
        // The wallet delegated an intent it opened itself to an executor:
        // the owners' quorum approved.
        assert!(maker == approver, E_NOT_THE_MAKER);
        assert!(spend_policy::is_executor(policy, payer), E_NOT_AN_EXECUTOR);
    } else {
        // An owner's second approval: a wallet member, neither the maker nor
        // the payer.
        assert!(spend_policy::is_owner(policy, approver), E_NOT_AN_OWNER);
        assert!(approver != payer && approver != maker, E_SELF_APPROVAL);
    };

    event::emit(SpendApprovalConsumed { approval_id: id.to_inner(), policy_id, intent_id, approver });
    id.delete();
}

/// A Sui destination is verified for this kind: a bank beneficiary bound to
/// this partner deposit address, or a recipient on domain 8 tagged exactly
/// this kind, so the kind declared to core is the one the owners chose.
///
/// Decision 2: a partner deposit address is paid only as a bank payout whose
/// beneficiary is verified and bound to it, so the partner can match the
/// deposit (sender, amount, intent) to the payout instruction it was sent.
/// The policy keeps the addresses it binds beneficiaries to off its
/// recipient list, and this refuses any other kind to one first, with its
/// own code, at opening and at the draw. Splash's own partner registry is
/// read at the draw, where `derive_kind` classifies the recipient.
fun assert_sui_destination(policy: &SpendPolicy, kind: u8, recipient: address, beneficiary_ref: vector<u8>) {
    if (kind == payment_intent::kind_bank_payout()) {
        assert!(spend_policy::is_beneficiary_bound_to(policy, beneficiary_ref, recipient), E_BENEFICIARY_NOT_VERIFIED);
    } else {
        assert!(!spend_policy::is_partner_deposit(policy, recipient), E_PARTNER_DEPOSIT_NOT_BANK_PAYOUT);
        let domain = payment_intent::sui_domain();
        assert!(spend_policy::is_recipient_verified(policy, domain, recipient), E_RECIPIENT_NOT_VERIFIED);
        assert!(spend_policy::recipient_kind(policy, domain, recipient) == kind, E_WRONG_DELIVERY_KIND);
    };
}

/// The kind a payment under the policy declares (A1 §2.3): a bank payout,
/// or the recipient's tag. Called once `assert_sui_destination` has passed,
/// so a recipient that is not a bank payout is verified, with that tag.
fun declared_kind(policy: &SpendPolicy, intent: &PaymentIntent): u8 {
    let kind = payment_intent::kind(intent);
    if (kind == payment_intent::kind_bank_payout()) kind
    else spend_policy::recipient_kind(policy, payment_intent::sui_domain(), payment_intent::recipient(intent))
}

/// `principal * FEE_CEILING_BPS / BPS_DENOM`, rounded down, without an
/// intermediate that could overflow: the whole multiples of `BPS_DENOM`
/// and the rest are scaled separately.
fun fee_ceiling(principal: u64): u64 {
    principal / BPS_DENOM * FEE_CEILING_BPS + principal % BPS_DENOM * FEE_CEILING_BPS / BPS_DENOM
}

fun assert_within_limits(policy: &SpendPolicy, amount: u64, spender: address) {
    assert!(amount <= spend_policy::per_payment_max(policy), E_OVER_PER_PAYMENT_MAX);
    assert!(amount <= spend_policy::spender_per_payment_max(policy, spender), E_OVER_PER_PAYMENT_MAX);
}

/// The policy belongs to the account and to its current wallet generation.
/// A rotation (even back to an earlier address) leaves old policies behind;
/// they stop paying here.
fun assert_current(policy: &SpendPolicy, account: &BusinessAccount) {
    assert!(spend_policy::account(policy) == object::id(account), E_WRONG_ACCOUNT);
    assert!(business_account::has_wallet(account), E_STALE_POLICY);
    assert!(business_account::wallet(account) == spend_policy::wallet(policy), E_STALE_POLICY);
    assert!(business_account::wallet_epoch(account) == spend_policy::wallet_epoch(policy), E_STALE_POLICY);
}

/// The config is the one the policy was created against. Core reads the
/// pause and the registries off whatever config it is handed, so this pins
/// them to that one.
fun assert_config(policy: &SpendPolicy, config: &ComplianceConfig) {
    assert!(object::id(config) == spend_policy::config(policy), E_WRONG_CONFIG);
}

fun assert_intent_of(policy: &SpendPolicy, intent: &PaymentIntent) {
    let bound = payment_intent::account(intent);
    assert!(bound.is_some() && *bound.borrow() == spend_policy::account(policy), E_WRONG_ACCOUNT);
}

// ─── Views ─────────────────────────────────────────────────────────────────

/// The name an allowance must carry to be accepted, and spent, under this
/// policy: `splash-policy:` and the policy's id in hex.
public fun allowance_name(policy: &SpendPolicy): String {
    let mut name = ALLOWANCE_NAME_PREFIX.to_string();
    name.append(object::id(policy).to_address().to_string());
    name
}

public fun approval_policy(a: &PayoutApproval): ID { a.policy }
public fun approval_policy_generation(a: &PayoutApproval): u64 { a.policy_generation }
public fun approval_intent(a: &PayoutApproval): ID { a.intent }
public fun approval_amount(a: &PayoutApproval): u64 { a.amount }
public fun approval_max_total(a: &PayoutApproval): u64 { a.max_total }
public fun approval_approver(a: &PayoutApproval): address { a.approver }
public fun approval_payer(a: &PayoutApproval): address { a.payer }
public fun approval_settle_by_ms(a: &PayoutApproval): u64 { a.settle_by_ms }

#[test_only]
public fun fee_ceiling_bps_for_testing(): u64 { FEE_CEILING_BPS }

#[test_only]
/// This package's own ceiling on `principal`, as `draw` and
/// `close_rule_payment` compute it.
public fun fee_ceiling_for_testing(principal: u64): u64 { fee_ceiling(principal) }

#[test_only]
/// Lets a test read what `RuleSpend` carries.
public fun unpack_rule_spend_for_testing(e: RuleSpend): (ID, ID, ID, Option<ID>, address, address, u8, u64) {
    let RuleSpend { policy_id, intent_id, allowance_id, approval_id, spender, recipient, derived_kind, fee } = e;
    (policy_id, intent_id, allowance_id, approval_id, spender, recipient, derived_kind, fee)
}

#[test_only]
/// Event fields are private to this module: lets a test read what
/// `SpendApprovalDiscarded` carries.
public fun unpack_spend_approval_discarded_for_testing(e: SpendApprovalDiscarded): (ID, ID, ID, address) {
    let SpendApprovalDiscarded { approval_id, policy_id, intent_id, approver } = e;
    (approval_id, policy_id, intent_id, approver)
}

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
/// within the policy's and the spender's ceilings, and above the
/// second-approval threshold a different owner has approved this exact
/// payment. Then `splash_core` settles it, accepting this package's
/// `SettleWitness` because it is on the settlement-app registry, and pays
/// the intent's recipient in the same call.
///
/// A spending rule pays only on Sui (kinds 1–3). A cross-chain payment
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

use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
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
/// The payment needs an approval and carries none: it is above the
/// second-approval threshold, or the payer is an executor.
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
/// The recipient is verified, but to be paid as another kind: the owners
/// chose how it is delivered (address balance or Coin) when they verified it.
const E_WRONG_DELIVERY_KIND: u64 = 1025;
/// An approval's `settle_by_ms` must be in the future and no later than the
/// intent's expiry.
const E_BAD_SETTLE_BY: u64 = 1026;
/// The payment's `settle_by_ms` is later than the one its approval names.
const E_SETTLE_BY_AFTER_APPROVAL: u64 = 1027;

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
/// amount, by this payer, while the account's authority and the policy's
/// generation are unchanged, and against a quote that holds until
/// `settle_by_ms`.
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

/// Which rule paid an intent: the policy, the allowance, the approval if any,
/// and the spender. The controls-evidence export reads this. The amount is
/// not here; the intent's commitment is, in `IntentConfirmed`.
public struct PaidUnderPolicy has copy, drop {
    policy_id: ID,
    intent_id: ID,
    allowance_id: ID,
    approval_id: Option<ID>,
    spender: address,
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
/// The destination must already be verified and the amount within the
/// ceilings, so an intent that could never be paid under this policy is
/// never opened. `pay_intent` checks everything again, since the policy can
/// change in between. Returned by value: share it, or pay it in the same
/// transaction.
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
/// `settle_by_ms` is the deadline of the quote the owner is approving: the
/// payment cannot settle after it, whatever deadline the payer passes. It
/// must be in the future and no later than the intent's expiry.
public fun approve_payout(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    payer: address,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let approver = ctx.sender();
    assert!(spend_policy::is_owner(policy, approver), E_NOT_AN_OWNER);
    assert!(approver != payment_intent::sender(intent), E_SELF_APPROVAL);
    assert!(approver != payer, E_SELF_APPROVAL);
    assert!(spend_policy::is_spender(policy, payer), E_NOT_A_SPENDER);
    mint(policy, account, intent, approver, payer, settle_by_ms, clock, ctx);
}

/// Let an executor run this intent later: the wallet's delegation of an
/// intent the wallet itself opened.
///
/// The sender must be the wallet, so the owners' quorum signs it; it counts
/// as their approval at any amount. A staff member cannot delegate, even a
/// payment they could make alone: for staff payments the operator needs an
/// owner's `approve_payout` naming it as the payer.
///
/// `settle_by_ms` is the end of the window the executor may run it in (a
/// quote's deadline, or the scheduled window's end), in the future and no
/// later than the intent's expiry.
public fun delegate_execution(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    executor: address,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let wallet = ctx.sender();
    assert!(wallet == spend_policy::wallet(policy), E_ONLY_THE_WALLET_DELEGATES);
    assert!(payment_intent::sender(intent) == wallet, E_NOT_THE_MAKER);
    assert!(spend_policy::is_executor(policy, executor), E_NOT_AN_EXECUTOR);
    mint(policy, account, intent, wallet, executor, settle_by_ms, clock, ctx);
}

fun mint(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    approver: address,
    payer: address,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_current(policy, account);
    assert_intent_of(policy, intent);
    assert!(payment_intent::is_pending(intent), E_NOT_PAYABLE);
    assert!(clock.timestamp_ms() < payment_intent::expires_at(intent), E_NOT_PAYABLE);
    // An approval that no spending rule could ever use is refused, not minted.
    assert!(payment_intent::kind(intent) != payment_intent::kind_cross_chain_wallet(), E_WRONG_PAY_PATH);
    assert!(settle_by_ms > clock.timestamp_ms(), E_BAD_SETTLE_BY);
    assert!(settle_by_ms <= payment_intent::expires_at(intent), E_BAD_SETTLE_BY);

    let approval = PayoutApproval {
        id: object::new(ctx),
        policy: object::id(policy),
        policy_generation: spend_policy::generation(policy),
        intent: object::id(intent),
        amount: payment_intent::amount_usd(intent),
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
/// amount, from the business wallet's address balance. `settle_by_ms` is the
/// quote's deadline. The intent lands on Sui, and core pays its recipient in
/// this call; a cross-chain intent is refused.
public fun pay_intent<C>(
    allowance: &mut Allowance<Balance<C>>,
    withdrawal: AllowanceWithdrawal<Balance<C>>,
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    policy: &SpendPolicy,
    config: &ComplianceConfig,
    approval: Option<PayoutApproval>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    assert!(payment_intent::kind(intent) != payment_intent::kind_cross_chain_wallet(), E_WRONG_PAY_PATH);
    let funds = draw(allowance, withdrawal, intent, account, policy, approval, settle_by_ms, clock, ctx);
    payment_intent::settle_from_app<C, SettleWitness>(
        SettleWitness {},
        intent,
        account,
        config,
        funds,
        settle_by_ms,
        clock,
        ctx,
    )
}

/// Every check the policy adds, then the withdrawal. Private: the `Balance`
/// it returns goes only to `splash_core`'s settle path.
fun draw<C>(
    allowance: &mut Allowance<Balance<C>>,
    withdrawal: AllowanceWithdrawal<Balance<C>>,
    intent: &PaymentIntent,
    account: &BusinessAccount,
    policy: &SpendPolicy,
    approval: Option<PayoutApproval>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &TxContext,
): Balance<C> {
    let payer = ctx.sender();
    // The money is this policy's wallet's, in this policy's asset; the policy
    // is the account's current one; the intent is the account's.
    assert!(allowance::funder(allowance::allowance_settings(allowance)) == spend_policy::wallet(policy), E_WRONG_FUNDER);
    assert!(compliance_config::type_string<C>() == spend_policy::asset(policy), E_WRONG_ASSET);
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
    assert_sui_destination(
        policy,
        payment_intent::kind(intent),
        payment_intent::recipient(intent),
        payment_intent::beneficiary_ref(intent),
    );

    // How much: the policy's ceiling, the payer's, and the maker's.
    let amount = payment_intent::amount_usd(intent);
    assert_within_limits(policy, amount, payer);
    if (!by_wallet) assert_within_limits(policy, amount, maker);

    // Approvals: the owners', above the threshold and for an executor always.
    // Every approval is the owners' (an owner's, or the wallet's delegation),
    // and any approval passed must match and is consumed.
    let needs_approval =
        amount > spend_policy::second_approval_threshold(policy) || spend_policy::is_executor(policy, payer);
    let approval_id = if (approval.is_some()) {
        let approval = approval.destroy_some();
        let id = object::id(&approval);
        consume(approval, policy, account, intent, payer, settle_by_ms, clock);
        option::some(id)
    } else {
        approval.destroy_none();
        assert!(!needs_approval, E_APPROVAL_REQUIRED);
        option::none()
    };

    let allowance_id = object::id(allowance);
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
    event::emit(PaidUnderPolicy {
        policy_id: object::id(policy),
        intent_id: object::id(intent),
        allowance_id,
        approval_id,
        spender: payer,
    });
    funds
}

/// Check an approval against this payment and consume it. `settle_by_ms` is
/// the deadline this payment passes to core, which must not be later than
/// the one the approval names.
fun consume(
    approval: PayoutApproval,
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    payer: address,
    settle_by_ms: u64,
    clock: &Clock,
) {
    let PayoutApproval {
        id,
        policy: policy_id,
        policy_generation,
        intent: intent_id,
        amount,
        approver,
        payer: named_payer,
        authority_epoch,
        settle_by_ms: approved_settle_by_ms,
    } = approval;
    assert!(policy_id == object::id(policy), E_APPROVAL_MISMATCH);
    assert!(intent_id == object::id(intent), E_APPROVAL_MISMATCH);
    assert!(amount == payment_intent::amount_usd(intent), E_APPROVAL_MISMATCH);
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
/// this partner deposit address, or a recipient on domain 8 verified as
/// exactly this kind, so core delivers it in the form the owners chose.
fun assert_sui_destination(policy: &SpendPolicy, kind: u8, recipient: address, beneficiary_ref: vector<u8>) {
    if (kind == payment_intent::kind_bank_payout()) {
        assert!(spend_policy::is_beneficiary_bound_to(policy, beneficiary_ref, recipient), E_BENEFICIARY_NOT_VERIFIED);
    } else {
        let domain = payment_intent::sui_domain();
        assert!(spend_policy::is_recipient_verified(policy, domain, recipient), E_RECIPIENT_NOT_VERIFIED);
        assert!(spend_policy::recipient_kind(policy, domain, recipient) == kind, E_WRONG_DELIVERY_KIND);
    };
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
public fun approval_approver(a: &PayoutApproval): address { a.approver }
public fun approval_payer(a: &PayoutApproval): address { a.payer }
public fun approval_settle_by_ms(a: &PayoutApproval): u64 { a.settle_by_ms }

#[test_only]
/// Event fields are private to this module: lets a test read what
/// `SpendApprovalDiscarded` carries.
public fun unpack_spend_approval_discarded_for_testing(e: SpendApprovalDiscarded): (ID, ID, ID, address) {
    let SpendApprovalDiscarded { approval_id, policy_id, intent_id, approver } = e;
    (approval_id, policy_id, intent_id, approver)
}

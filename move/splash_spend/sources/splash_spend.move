/// splash_spend — pay an intent under a spending rule (D2).
///
/// A business's owners give someone a spending rule by proposing an app-bound
/// allowance from the business wallet to that person's address, bound to
/// `SPLASH_SPEND`, and accepting it here in the same transaction:
///
///     allowance::propose_for_app<Balance<USDC>, SPLASH_SPEND>(…)   // the wallet signs
///     splash_spend::accept(proposal, policy)
///
/// Inside the rule, a STAFF spender then opens and pays alone. The allowance
/// enforces its own caps, expiry and spender, and draws from the wallet's
/// address balance. This module adds the business's `SpendPolicy`: the payer
/// and the maker are on the policy, the destination is verified (a bank
/// beneficiary together with its partner deposit address), the amount is
/// within the policy's and the spender's ceilings, and above the
/// second-approval threshold a different owner has approved this exact
/// payment. Then `splash_core` settles it, accepting this package's
/// `SettleWitness` because it is on the settlement-app registry.
///
/// ─── Splash's operator is an EXECUTOR, not staff ───────────────────────────
///
/// Scheduled payments and batches run later under Splash's KMS operator, with
/// its own tightly capped allowance. The operator cannot open an intent, and
/// cannot pay one without an approval naming it as the payer: an owner's
/// approval, or the maker's own delegation (for an amount the maker could
/// have paid alone). So the operator can only ever pay approved intents to
/// verified recipients within caps, and a stolen operator key can start
/// nothing.
///
/// ─── The permits never leave ────────────────────────────────────────────────
///
/// `internal::permit<SPLASH_SPEND>()` can only be called in this module, and it
/// is called in exactly two places: inside `accept`, passed straight through
/// `settings_permit` to `allowance::issue`; and inside the private `draw`,
/// passed straight through `spend_permit` to `allowance::app_balance_spend`.
/// No function returns a permit, a witness or a `Balance`, and there is no
/// `rotate_spender`: a holder of `SettingsPermit<SPLASH_SPEND>` could move
/// every allowance bound to this app to a new spender. The package publishes
/// immutable, so none of that can be added later. `scripts/check-spend-
/// permits.mjs` fails the build if any of it stops being true.
module splash_spend::splash_spend;

use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::payment_intent::{Self, BridgeObligation, PaymentIntent, SettleReceipt};
use splash_spend::spend_policy::{Self, SpendPolicy};
use std::internal;
use std::string::String;
use sui::allowance::{Self, Allowance, AllowanceProposal, AllowanceWithdrawal};
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::Coin;
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
/// The approval has expired with its intent.
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
/// Above the threshold, the approval must be an owner's, not a delegation.
const E_OWNER_APPROVAL_REQUIRED: u64 = 1018;
/// Only the intent's maker can delegate its execution.
const E_NOT_THE_MAKER: u64 = 1019;
/// Execution can be delegated only to an executor.
const E_NOT_AN_EXECUTOR: u64 = 1020;
/// The account's authority changed (a freeze, a membership change, a wallet
/// change) after this approval was given.
const E_STALE_APPROVAL: u64 = 1021;
/// A cross-chain intent goes through `pay_intent_cross_chain`, and only it.
const E_WRONG_PAY_PATH: u64 = 1022;
/// The allowance was not issued for this policy: its name is not this
/// policy's `allowance_name`.
const E_ALLOWANCE_NOT_FOR_POLICY: u64 = 1023;

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

/// Approval to pay ONE intent: this policy, this intent, this amount, by this
/// payer, while the account's authority is unchanged and the intent is open.
///
/// `owner_approval` is true for an owner's second approval, and for a
/// delegation by the wallet itself. It is false for a staff maker's
/// delegation of their own payment to an executor, which authorises the
/// executor only for an amount the maker could have paid alone.
///
/// `key` only, so it cannot be wrapped or `public_transfer`red, and consumed
/// by value when used, so it cannot be replayed.
public struct PayoutApproval has key {
    id: UID,
    policy: ID,
    intent: ID,
    amount: u64,
    approver: address,
    payer: address,
    owner_approval: bool,
    authority_epoch: u64,
    expires_at_ms: u64,
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
    owner_approval: bool,
    commitment: vector<u8>,
}

public struct SpendApprovalConsumed has copy, drop {
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
/// The proposal is checked before it is issued: its funder must be this
/// policy's wallet (which also means the wallet signed this transaction, since
/// `propose_for_app` records the sender as funder), its spender must be on
/// the policy, `T` must be the policy's asset, and its name must be this
/// policy's `allowance_name`. `issue` checks the app.
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
    ctx: &mut TxContext,
) {
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

/// Open a cross-chain intent in the account's name, as STAFF.
public fun create_cross_chain_intent<T>(
    policy: &SpendPolicy,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    payment_ref: vector<u8>,
    destination_domain: u32,
    mint_recipient: address,
    amount: u64,
    commitment: vector<u8>,
    rail_commitment: vector<u8>,
    bridge_max_fee: u64,
    bridge_min_finality: u32,
    expires_at: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    let maker = ctx.sender();
    assert_current(policy, account);
    assert!(compliance_config::type_string<T>() == spend_policy::asset(policy), E_WRONG_ASSET);
    assert!(spend_policy::is_staff(policy, maker), E_NOT_STAFF);
    assert!(destination_domain != payment_intent::sui_domain(), E_RECIPIENT_NOT_VERIFIED);
    assert!(spend_policy::is_recipient_verified(policy, destination_domain, mint_recipient), E_RECIPIENT_NOT_VERIFIED);
    assert_within_limits(policy, amount, maker);

    payment_intent::create_cross_chain_for_app<T, SettleWitness>(
        SettleWitness {},
        account,
        config,
        maker,
        payment_ref,
        destination_domain,
        mint_recipient,
        amount,
        commitment,
        rail_commitment,
        bridge_max_fee,
        bridge_min_finality,
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
public fun approve_payout(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    payer: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let approver = ctx.sender();
    assert!(spend_policy::is_owner(policy, approver), E_NOT_AN_OWNER);
    assert!(approver != payment_intent::sender(intent), E_SELF_APPROVAL);
    assert!(approver != payer, E_SELF_APPROVAL);
    assert!(spend_policy::is_spender(policy, payer), E_NOT_A_SPENDER);
    mint(policy, account, intent, approver, payer, true, clock, ctx);
}

/// Let an executor run this intent later: the maker's own delegation.
///
/// A staff maker can delegate a payment they could have made alone; it does
/// not count as a second approval. A delegation by the wallet (the owners'
/// quorum, as maker) counts as an owner approval at any amount.
public fun delegate_execution(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    executor: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let maker = ctx.sender();
    assert!(maker == payment_intent::sender(intent), E_NOT_THE_MAKER);
    let by_wallet = maker == spend_policy::wallet(policy);
    assert!(by_wallet || spend_policy::is_staff(policy, maker), E_MAKER_NOT_A_SPENDER);
    assert!(spend_policy::is_executor(policy, executor), E_NOT_AN_EXECUTOR);
    mint(policy, account, intent, maker, executor, by_wallet, clock, ctx);
}

fun mint(
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    approver: address,
    payer: address,
    owner_approval: bool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_current(policy, account);
    assert_intent_of(policy, intent);
    assert!(payment_intent::is_pending(intent), E_NOT_PAYABLE);
    assert!(clock.timestamp_ms() < payment_intent::expires_at(intent), E_NOT_PAYABLE);

    let approval = PayoutApproval {
        id: object::new(ctx),
        policy: object::id(policy),
        intent: object::id(intent),
        amount: payment_intent::amount_usd(intent),
        approver,
        payer,
        owner_approval,
        authority_epoch: business_account::authority_epoch(account),
        expires_at_ms: payment_intent::expires_at(intent),
    };
    event::emit(SpendApproved {
        approval_id: object::id(&approval),
        policy_id: object::id(policy),
        intent_id: object::id(intent),
        approver,
        payer,
        owner_approval,
        commitment: payment_intent::commitment(intent),
    });
    transfer::transfer(approval, payer);
}

/// Throw away an approval that will not be used.
public fun discard_approval(approval: PayoutApproval) {
    let PayoutApproval {
        id,
        policy: _,
        intent: _,
        amount: _,
        approver: _,
        payer: _,
        owner_approval: _,
        authority_epoch: _,
        expires_at_ms: _,
    } = approval;
    id.delete();
}

// ─── Paying ────────────────────────────────────────────────────────────────

/// Pay an intent under a spending rule. The sender is the allowance's spender.
///
/// `withdrawal` is the allowance withdrawal input for exactly the intent's
/// amount, from the business wallet's address balance. `settle_by_ms` is the
/// quote's deadline.
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
    let funds = draw(allowance, withdrawal, intent, account, policy, approval, clock, ctx);
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

/// Pay a cross-chain intent under a spending rule. The coin comes back beside
/// the obligation naming it, which a registered bridge adapter must discharge
/// in the same transaction by burning that coin through CCTP to the intent's
/// domain and recipient.
public fun pay_intent_cross_chain<C>(
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
): (SettleReceipt, Coin<C>, BridgeObligation) {
    assert!(payment_intent::kind(intent) == payment_intent::kind_cross_chain_wallet(), E_WRONG_PAY_PATH);
    let funds = draw(allowance, withdrawal, intent, account, policy, approval, clock, ctx);
    payment_intent::settle_cross_chain_from_app<C, SettleWitness>(
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

    // Where. The destination key is built here, not read whole off the intent.
    let kind = payment_intent::kind(intent);
    if (kind == payment_intent::kind_cross_chain_wallet()) {
        let domain = payment_intent::destination_domain(intent);
        assert!(domain != payment_intent::sui_domain(), E_RECIPIENT_NOT_VERIFIED);
        assert!(spend_policy::is_recipient_verified(policy, domain, payment_intent::recipient(intent)), E_RECIPIENT_NOT_VERIFIED);
    } else {
        assert_sui_destination(policy, kind, payment_intent::recipient(intent), payment_intent::beneficiary_ref(intent));
    };

    // How much: the policy's ceiling, the payer's, and the maker's.
    let amount = payment_intent::amount_usd(intent);
    assert_within_limits(policy, amount, payer);
    if (!by_wallet) assert_within_limits(policy, amount, maker);

    // Approvals. Above the threshold, an owner's. For an executor, always one.
    let needs_owner = amount > spend_policy::second_approval_threshold(policy);
    let needs_any = needs_owner || spend_policy::is_executor(policy, payer);
    let approval_id = if (approval.is_some()) {
        let approval = approval.destroy_some();
        let id = object::id(&approval);
        let owner_approval = consume(approval, policy, account, intent, payer, clock);
        assert!(!needs_owner || owner_approval, E_OWNER_APPROVAL_REQUIRED);
        option::some(id)
    } else {
        approval.destroy_none();
        assert!(!needs_any, E_APPROVAL_REQUIRED);
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

/// Check an approval against this payment and consume it. Returns whether it
/// was an owner approval.
fun consume(
    approval: PayoutApproval,
    policy: &SpendPolicy,
    account: &BusinessAccount,
    intent: &PaymentIntent,
    payer: address,
    clock: &Clock,
): bool {
    let PayoutApproval {
        id,
        policy: policy_id,
        intent: intent_id,
        amount,
        approver,
        payer: named_payer,
        owner_approval,
        authority_epoch,
        expires_at_ms,
    } = approval;
    assert!(policy_id == object::id(policy), E_APPROVAL_MISMATCH);
    assert!(intent_id == object::id(intent), E_APPROVAL_MISMATCH);
    assert!(amount == payment_intent::amount_usd(intent), E_APPROVAL_MISMATCH);
    assert!(named_payer == payer, E_APPROVAL_MISMATCH);
    assert!(authority_epoch == business_account::authority_epoch(account), E_STALE_APPROVAL);
    assert!(clock.timestamp_ms() < expires_at_ms, E_APPROVAL_EXPIRED);
    // Checked again at use, not trusted from minting.
    let maker = payment_intent::sender(intent);
    if (approver == spend_policy::wallet(policy)) {
        // The wallet delegated its own intent: the quorum itself approved.
        assert!(owner_approval && maker == approver, E_APPROVAL_MISMATCH);
    } else if (owner_approval) {
        assert!(spend_policy::is_owner(policy, approver), E_NOT_AN_OWNER);
        assert!(approver != payer && approver != maker, E_SELF_APPROVAL);
    } else {
        // A staff maker's delegation to an executor.
        assert!(approver == maker && spend_policy::is_staff(policy, maker), E_NOT_THE_MAKER);
        assert!(spend_policy::is_executor(policy, payer), E_NOT_AN_EXECUTOR);
    };

    event::emit(SpendApprovalConsumed { approval_id: id.to_inner(), policy_id, intent_id, approver });
    id.delete();
    owner_approval
}

/// A Sui destination is verified for this kind: a bank beneficiary bound to
/// this partner deposit address, or a verified recipient on domain 8.
fun assert_sui_destination(policy: &SpendPolicy, kind: u8, recipient: address, beneficiary_ref: vector<u8>) {
    if (kind == payment_intent::kind_bank_payout()) {
        assert!(spend_policy::is_beneficiary_bound_to(policy, beneficiary_ref, recipient), E_BENEFICIARY_NOT_VERIFIED);
    } else {
        assert!(spend_policy::is_recipient_verified(policy, payment_intent::sui_domain(), recipient), E_RECIPIENT_NOT_VERIFIED);
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
public fun approval_intent(a: &PayoutApproval): ID { a.intent }
public fun approval_amount(a: &PayoutApproval): u64 { a.amount }
public fun approval_approver(a: &PayoutApproval): address { a.approver }
public fun approval_payer(a: &PayoutApproval): address { a.payer }
public fun approval_is_owner_approval(a: &PayoutApproval): bool { a.owner_approval }
public fun approval_expires_at_ms(a: &PayoutApproval): u64 { a.expires_at_ms }

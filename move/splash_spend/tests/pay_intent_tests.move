/// splash_spend: opening intents, approving them and paying them under a
/// spending rule.
///
/// Written from docs/v2/phase1-move-design.md §5 (revision 2) and
/// SPLASH_SUI_V2_PROMPT.md §3.8, not from the code. Every money-moving check
/// `pay_intent` claims to make is attacked here: who pays, who opened the
/// intent, where the money goes, how much, which approval, which policy,
/// which allowance, which asset, which path, and when.
///
/// The fixture is the harness's verified account and 2-of-3 wallet, with
/// `SettleWitness` put on the settlement-app registry through the real
/// 24-hour path, one `SpendPolicy` for the wallet's first generation, and
/// three app-bound allowances from the wallet's address balance: a senior
/// STAFF member, a JUNIOR staff member with a low ceiling, and Splash's KMS
/// operator as EXECUTOR. Move tests do not check signatures, so a test acts
/// as the multisig, an owner or a spender simply by sending as its address.
#[test_only]
#[allow(implicit_const_copy)]
module splash_spend::pay_intent_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::multisig;
use splash_core::payment_intent::{Self, IntentConfirmed, PaymentIntent};
use splash_core::v2_harness::{Self as h, USDC};
use splash_spend::splash_spend::{
    Self,
    PaidUnderPolicy,
    PayoutApproval,
    SPLASH_SPEND,
    SettleWitness,
    SpendApprovalConsumed
};
use splash_spend::spend_policy::{Self, PolicyRegistry, SpendPolicy};
use std::unit_test::assert_eq;
use sui::allowance::{Self, Allowance};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::test_scenario::{Self as ts, Scenario, TransactionEffects};

/// A second coin type: the policy pays in USDC and nothing else.
public struct OTHER has drop {}

// ─── People and places ─────────────────────────────────────────────────────

/// A senior staff spender: opens and pays, up to the policy's maximum.
const STAFF: address = @0x57AFF;
/// A junior staff spender with a low ceiling of their own.
const JUNIOR: address = @0x7A1;
/// Splash's KMS operator: pays only, and only with an approval naming it.
const EXECUTOR: address = @0xE0E0;
const STRANGER: address = @0xBAD;
/// A supplier's verified wallet (kind 3).
const SUPPLIER: address = @0x5099;
/// Another Splash business, verified (kind 2).
const BUSINESS: address = @0xB12;
/// A verified Sui recipient that is NOT the beneficiary's partner address.
const OTHER_PARTNER: address = @0x9A2;
/// Never verified anywhere.
const UNLISTED: address = @0x0FF;
/// A left-padded EVM address, verified on domain 0 only.
const EVM_RECIPIENT: address = @0xE7E7;
const ETH_DOMAIN: u32 = 0;
const SUI_DOMAIN: u32 = 8;

// ─── Amounts (USDC minor units, 6 decimals) ────────────────────────────────

/// 500 USDC: under every ceiling and the threshold.
const PAY: u64 = 500_000_000;
/// The policy's per-payment maximum: 15,000 USDC.
const POLICY_MAX: u64 = 15_000_000_000;
const STAFF_MAX: u64 = 15_000_000_000;
/// The junior's own ceiling: 1,000 USDC.
const JUNIOR_MAX: u64 = 1_000_000_000;
const EXECUTOR_MAX: u64 = 15_000_000_000;
/// D2's default second-approval threshold: 10,000 USDC.
const THRESHOLD: u64 = 10_000_000_000;
/// What the wallet holds in its address balance: 100,000 USDC.
const FUNDS: u64 = 100_000_000_000;
/// Each allowance's lifetime cap: 50,000 USDC.
const ALLOWANCE_CAP: u256 = 50_000_000_000;
const BRIDGE_FEE: u64 = 1_000_000;
const BRIDGE_FINALITY: u32 = 1000;

/// A staff intent lives one day.
const INTENT_LIFE: u64 = 86_400_000;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";

/// The objects every test refers to.
public struct Fx has copy, drop {
    account: ID,
    policy: ID,
    /// STAFF's allowance.
    staff: ID,
    /// JUNIOR's allowance.
    junior: ID,
    /// EXECUTOR's allowance.
    executor: ID,
}

// ─── Fixture ───────────────────────────────────────────────────────────────

fun setup(): (Scenario, Fx) {
    setup_with(false)
}

/// The harness account and wallet; `SettleWitness` registered as a
/// settlement app through the 24-hour path (and `OTHER` accepted as an asset
/// when `accept_other`); the wallet's policy with its spenders and verified
/// destinations; the wallet's address balance funded; one allowance each for
/// STAFF, JUNIOR and EXECUTOR.
fun setup_with(accept_other: bool): (Scenario, Fx) {
    let mut s = h::setup();

    // Governance announces the additions. The harness 2-of-3 is a valid
    // non-single-signer quorum sender.
    s.next_tx(h::wallet());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::propose_addition<SettleWitness>(
            &admin,
            &mut config,
            compliance_config::registry_settlement_app(),
            h::keys(),
            h::weights(),
            h::threshold(),
            &c,
            s.ctx(),
        );
        if (accept_other) {
            compliance_config::propose_addition<OTHER>(
                &admin,
                &mut config,
                compliance_config::registry_asset(),
                h::keys(),
                h::weights(),
                h::threshold(),
                &c,
                s.ctx(),
            );
        };
        business_account::destroy_admin_cap_for_testing(admin);
        spend_policy::init_for_testing(s.ctx());
        ts::return_shared(c);
        ts::return_shared(config);
    };

    // 24 hours later, governance activates them.
    s.next_tx(h::wallet());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let mut c = s.take_shared<Clock>();
        c.increment_for_testing(compliance_config::addition_notice_ms());
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::activate_addition<SettleWitness>(
            &admin,
            &mut config,
            compliance_config::registry_settlement_app(),
            h::keys(),
            h::weights(),
            h::threshold(),
            &c,
            s.ctx(),
        );
        if (accept_other) {
            compliance_config::activate_addition<OTHER>(
                &admin,
                &mut config,
                compliance_config::registry_asset(),
                h::keys(),
                h::weights(),
                h::threshold(),
                &c,
                s.ctx(),
            );
        };
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };

    // The wallet creates its policy and is funded.
    s.next_tx(h::wallet());
    let account_id;
    let policy_id;
    {
        let mut registry = s.take_shared<PolicyRegistry>();
        let account = s.take_shared<BusinessAccount>();
        account_id = object::id(&account);
        policy_id =
            spend_policy::create_policy<USDC>(
                &mut registry,
                &account,
                h::keys(),
                h::weights(),
                h::threshold(),
                POLICY_MAX,
                s.ctx(),
            );
        balance::create_for_testing<USDC>(FUNDS).send_funds(h::wallet());
        ts::return_shared(account);
        ts::return_shared(registry);
    };

    // The wallet lists who may spend and where.
    s.next_tx(h::wallet());
    {
        let mut policy = s.take_shared_by_id<SpendPolicy>(policy_id);
        let ctx = s.ctx();
        policy.add_spender(STAFF, spend_policy::role_staff(), STAFF_MAX, ctx);
        policy.add_spender(JUNIOR, spend_policy::role_staff(), JUNIOR_MAX, ctx);
        policy.add_spender(EXECUTOR, spend_policy::role_executor(), EXECUTOR_MAX, ctx);
        policy.verify_recipient(SUI_DOMAIN, SUPPLIER, ctx);
        policy.verify_recipient(SUI_DOMAIN, BUSINESS, ctx);
        policy.verify_recipient(SUI_DOMAIN, OTHER_PARTNER, ctx);
        // The bank beneficiary is bound to the harness's partner deposit address.
        policy.verify_beneficiary(h::beneficiary(), h::recipient(), ctx);
        ts::return_shared(policy);
    };

    let staff = grant(&mut s, policy_id, STAFF, ALLOWANCE_CAP);
    let junior = grant(&mut s, policy_id, JUNIOR, ALLOWANCE_CAP);
    let executor = grant(&mut s, policy_id, EXECUTOR, ALLOWANCE_CAP);
    (s, Fx { account: account_id, policy: policy_id, staff, junior, executor })
}

/// The wallet proposes an app-bound allowance to `spender` and `splash_spend`
/// accepts it, in one transaction. Returns the new allowance's ID.
fun grant(s: &mut Scenario, policy: ID, spender: address, lifetime_cap: u256): ID {
    s.next_tx(h::wallet());
    {
        let policy = s.take_shared_by_id<SpendPolicy>(policy);
        let proposal = allowance::propose_for_app<Balance<USDC>, SPLASH_SPEND>(
            splash_spend::allowance_name(&policy),
            spender,
            option::some(lifetime_cap),
            option::none(),
            option::some(std::u64::max_value!()),
            option::none(),
            s.ctx(),
        );
        splash_spend::accept(proposal, &policy, s.ctx());
        ts::return_shared(policy);
    };
    let effects = s.next_tx(h::wallet());
    new_shared(&effects)
}

/// The one object the last transaction both created and shared.
fun new_shared(effects: &TransactionEffects): ID {
    let created = effects.created();
    let mut found = option::none();
    effects.shared().do!(|id| if (created.contains(&id)) {
        assert!(found.is_none());
        found.fill(id);
    });
    found.destroy_some()
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/// `maker` opens an intent through `splash_spend::create_intent` and shares it.
fun open(s: &mut Scenario, fx: &Fx, maker: address, n: u8, kind: u8, to: address, amount: u64): ID {
    s.next_tx(maker);
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let intent = create_now<USDC>(&policy, &mut account, &config, n, kind, to, amount, &c, s.ctx());
    let id = object::id(&intent);
    payment_intent::share_intent(intent);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    ts::return_shared(policy);
    id
}

fun create_now<T>(
    policy: &SpendPolicy,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    kind: u8,
    to: address,
    amount: u64,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    let bank = kind == payment_intent::kind_bank_payout();
    splash_spend::create_intent<T>(
        policy,
        account,
        config,
        h::payment_ref(n),
        to,
        if (bank) h::beneficiary() else vector[],
        amount,
        if (bank) b"PHP".to_string() else b"USDC".to_string(),
        if (bank) 56_000_000 else 1_000_000,
        h::commitment(),
        kind,
        h::rail(),
        c.timestamp_ms() + INTENT_LIFE,
        c,
        ctx,
    )
}

/// The wallet opens a cross-chain intent to `to` on `domain` and shares it.
/// Only the wallet can: no spending-rule path opens one.
fun open_cross_chain_by_wallet(s: &mut Scenario, fx: &Fx, n: u8, domain: u32, to: address, amount: u64): ID {
    s.next_tx(h::wallet());
    let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let intent = payment_intent::create_cross_chain_for_wallet<USDC>(
        &mut account,
        &config,
        h::payment_ref(n),
        domain,
        to,
        amount,
        h::commitment(),
        h::rail(),
        BRIDGE_FEE,
        BRIDGE_FINALITY,
        c.timestamp_ms() + INTENT_LIFE,
        &c,
        s.ctx(),
    );
    let id = object::id(&intent);
    payment_intent::share_intent(intent);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    id
}

/// The wallet opens a Sui intent of `kind` to `to` and shares it. A bank
/// payout carries the harness's beneficiary.
fun open_by_wallet(s: &mut Scenario, fx: &Fx, n: u8, kind: u8, to: address, amount: u64): ID {
    s.next_tx(h::wallet());
    let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let intent = h::wallet_intent_of_kind(&mut account, &config, n, kind, to, amount, &c, s.ctx());
    let id = object::id(&intent);
    payment_intent::share_intent(intent);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    id
}

/// `owner` gives the second approval for `intent`, to be paid by `payer`.
fun approve(s: &mut Scenario, fx: &Fx, owner: address, intent: ID, payer: address) {
    s.next_tx(owner);
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let account = s.take_shared_by_id<BusinessAccount>(fx.account);
    let intent = s.take_shared_by_id<PaymentIntent>(intent);
    let c = s.take_shared<Clock>();
    splash_spend::approve_payout(&policy, &account, &intent, payer, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(intent);
    ts::return_shared(account);
    ts::return_shared(policy);
}

/// `sender` delegates the execution of `intent` to `executor`. Only the
/// wallet can, and only for an intent it opened.
fun delegate(s: &mut Scenario, fx: &Fx, sender: address, intent: ID, executor: address) {
    s.next_tx(sender);
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let account = s.take_shared_by_id<BusinessAccount>(fx.account);
    let intent = s.take_shared_by_id<PaymentIntent>(intent);
    let c = s.take_shared<Clock>();
    splash_spend::delegate_execution(&policy, &account, &intent, executor, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(intent);
    ts::return_shared(account);
    ts::return_shared(policy);
}

/// `payer` pays the shared intent under allowance `alw`, passing the
/// approval it holds when `with_approval`.
fun pay(s: &mut Scenario, fx: &Fx, payer: address, alw: ID, intent: ID, with_approval: bool) {
    s.next_tx(payer);
    let approval = if (with_approval) option::some(s.take_from_sender<PayoutApproval>()) else option::none();
    pay_in_tx(s, fx.account, fx.policy, alw, intent, approval);
}

/// In the current transaction: pay the shared intent under `alw`, drawing
/// exactly its amount from the wallet's address balance.
fun pay_in_tx(s: &mut Scenario, account: ID, policy: ID, alw: ID, intent: ID, approval: Option<PayoutApproval>) {
    let mut allowance = s.take_shared_by_id<Allowance<Balance<USDC>>>(alw);
    let mut intent = s.take_shared_by_id<PaymentIntent>(intent);
    let mut account = s.take_shared_by_id<BusinessAccount>(account);
    let policy = s.take_shared_by_id<SpendPolicy>(policy);
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let amount = payment_intent::amount_usd(&intent);
    pay_objects(
        &mut allowance,
        &mut intent,
        &mut account,
        &policy,
        &config,
        approval,
        h::wallet(),
        amount,
        h::settle_by(&c),
        &c,
        s.ctx(),
    );
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(policy);
    ts::return_shared(account);
    ts::return_shared(intent);
    ts::return_shared(allowance);
}

/// `pay_intent` with a withdrawal of `drawn` from `from`'s address balance,
/// then the receipt anchored, as the PTB must.
fun pay_objects(
    alw: &mut Allowance<Balance<USDC>>,
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    policy: &SpendPolicy,
    config: &ComplianceConfig,
    approval: Option<PayoutApproval>,
    from: address,
    drawn: u64,
    settle_by_ms: u64,
    c: &Clock,
    ctx: &mut TxContext,
) {
    let withdrawal = allowance::new_withdrawal_for_testing(
        object::id(alw),
        ts::withdraw_balance_from_address<USDC>(from, drawn),
    );
    let receipt = splash_spend::pay_intent(alw, withdrawal, intent, account, policy, config, approval, settle_by_ms, c, ctx);
    audit_anchor::anchor(receipt, HASH, BLOB, c, ctx);
}

/// The wallet signs a transaction on its policy; the caller returns it.
fun wallet_policy(s: &mut Scenario, fx: &Fx): SpendPolicy {
    s.next_tx(h::wallet());
    s.take_shared_by_id<SpendPolicy>(fx.policy)
}

fun advance(s: &mut Scenario, ms: u64) {
    s.next_tx(STRANGER);
    let mut c = s.take_shared<Clock>();
    c.increment_for_testing(ms);
    ts::return_shared(c);
}

fun intent_status(s: &mut Scenario, intent: ID): u8 {
    s.next_tx(STRANGER);
    let i = s.take_shared_by_id<PaymentIntent>(intent);
    let status = payment_intent::status(&i);
    ts::return_shared(i);
    status
}

/// The coin `who` received, by value.
fun coin_received(s: &mut Scenario, who: address): u64 {
    s.next_tx(who);
    let paid = s.take_from_sender<Coin<USDC>>();
    let value = paid.value();
    s.return_to_sender(paid);
    value
}

/// A second wallet generation: a 2-of-2 of owners 1 and 2.
fun b_keys(): vector<vector<u8>> { vector[h::passkey(0), h::passkey(1)] }

fun b_weights(): vector<u8> { vector[1, 1] }

fun wallet_b(): address { multisig::derive_address(&b_keys(), &b_weights(), 2) }

/// `from`, the current wallet, rotates to the members given; the new wallet
/// confirms.
fun rotate(s: &mut Scenario, fx: &Fx, from: address, keys: vector<vector<u8>>, weights: vector<u8>, threshold: u16) {
    let to = multisig::derive_address(&keys, &weights, threshold);
    s.next_tx(from);
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        business_account::rotate_wallet(&mut account, keys, weights, threshold, false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(to);
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        business_account::confirm_wallet_rotation(&mut account, s.ctx());
        ts::return_shared(account);
    };
}

/// A second verified business with the same people and the same 2-of-3
/// wallet, and its own policy listing STAFF and SUPPLIER exactly like the
/// first. Only the account differs. Returns (account, policy).
fun second_business(s: &mut Scenario): (ID, ID) {
    s.next_tx(h::owner_1());
    {
        let c = s.take_shared<Clock>();
        business_account::submit_application(b"SSM-202409099999".to_string(), b"bafy-kyb-2".to_string(), &c, s.ctx());
        ts::return_shared(c);
    };
    let effects = s.next_tx(h::owner_1());
    let account2 = new_shared(&effects);
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(account2);
        let admin = business_account::admin_cap_for_testing(s.ctx());
        business_account::verify_business(&admin, &mut account, 20);
        business_account::destroy_admin_cap_for_testing(admin);
        business_account::add_owner(&mut account, h::owner_2(), s.ctx());
        business_account::add_owner(&mut account, h::owner_3(), s.ctx());
        business_account::nominate_wallet(&mut account, h::wallet(), false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(account2);
        business_account::register_wallet(&mut account, h::keys(), h::weights(), h::threshold(), false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(h::wallet());
    let policy2;
    {
        let mut registry = s.take_shared<PolicyRegistry>();
        let account = s.take_shared_by_id<BusinessAccount>(account2);
        policy2 =
            spend_policy::create_policy<USDC>(
                &mut registry,
                &account,
                h::keys(),
                h::weights(),
                h::threshold(),
                POLICY_MAX,
                s.ctx(),
            );
        ts::return_shared(account);
        ts::return_shared(registry);
    };
    s.next_tx(h::wallet());
    {
        let mut policy = s.take_shared_by_id<SpendPolicy>(policy2);
        policy.add_spender(STAFF, spend_policy::role_staff(), STAFF_MAX, s.ctx());
        policy.verify_recipient(SUI_DOMAIN, SUPPLIER, s.ctx());
        ts::return_shared(policy);
    };
    (account2, policy2)
}

// ═══ The happy paths ═══════════════════════════════════════════════════════

#[test]
/// The basic spending rule: a staff member pays a verified supplier below the
/// threshold, alone. The supplier gets a Coin (kind 3), the intent is
/// CONFIRMED on path 2 (settlement app), `PaidUnderPolicy` says which rule
/// paid it, the allowance's running spend goes up by exactly the amount, and
/// the money left the business wallet's own address balance and nowhere else.
fun staff_pays_a_verified_wallet_below_the_threshold() {
    let (mut s, fx) = setup();
    let intent_id = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(STAFF);
    {
        let mut alw = s.take_shared_by_id<Allowance<Balance<USDC>>>(fx.staff);
        let mut intent = s.take_shared_by_id<PaymentIntent>(intent_id);
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        assert_eq!(allowance::allowance_current_spend(&alw), 0);
        assert_eq!(spend_policy::second_approval_threshold(&policy), THRESHOLD);

        pay_objects(
            &mut alw,
            &mut intent,
            &mut account,
            &policy,
            &config,
            option::none(),
            h::wallet(),
            PAY,
            h::settle_by(&c),
            &c,
            s.ctx(),
        );

        assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
        assert_eq!(allowance::allowance_current_spend(&alw), PAY as u256);
        let confirmed = event::events_by_type<IntentConfirmed>();
        assert_eq!(confirmed.length(), 1);
        let (id, commitment, rail, asset, kind, status, path, _) =
            payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
        assert_eq!(id, intent_id);
        assert_eq!(commitment, h::commitment());
        assert_eq!(rail, h::rail());
        assert_eq!(asset, compliance_config::type_string<USDC>());
        assert_eq!(kind, payment_intent::kind_wallet());
        assert_eq!(status, payment_intent::status_confirmed());
        assert_eq!(path, payment_intent::path_settlement_app());
        assert_eq!(event::events_by_type<PaidUnderPolicy>().length(), 1);
        // No approval was involved.
        assert_eq!(event::events_by_type<SpendApprovalConsumed>().length(), 0);

        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(policy);
        ts::return_shared(account);
        ts::return_shared(intent);
        ts::return_shared(alw);
    };
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    assert_eq!(ts::settled_balance<USDC>(h::wallet()), FUNDS - PAY);
    s.end();
}

#[test]
/// R2: create returns the intent by value, so one transaction can open,
/// pay, anchor and delete it, and the staff member signs once. The payment
/// reference stays claimed after the intent is deleted.
fun staff_creates_and_pays_in_the_same_transaction() {
    let (mut s, fx) = setup();
    s.next_tx(STAFF);
    {
        let mut alw = s.take_shared_by_id<Allowance<Balance<USDC>>>(fx.staff);
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let mut intent = create_now<USDC>(
            &policy,
            &mut account,
            &config,
            1,
            payment_intent::kind_wallet(),
            SUPPLIER,
            PAY,
            &c,
            s.ctx(),
        );
        assert_eq!(payment_intent::sender(&intent), STAFF);
        pay_objects(
            &mut alw,
            &mut intent,
            &mut account,
            &policy,
            &config,
            option::none(),
            h::wallet(),
            PAY,
            h::settle_by(&c),
            &c,
            s.ctx(),
        );
        assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
        payment_intent::delete_finalized(intent);
        assert!(payment_intent::payment_ref_used(&account, h::payment_ref(1)));
        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(policy);
        ts::return_shared(account);
        ts::return_shared(alw);
    };
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    s.end();
}

#[test]
/// A bank payout to a verified beneficiary goes to the one partner deposit
/// address that beneficiary is bound to, as a Coin.
fun staff_pays_a_bank_payout_to_the_bound_partner_address() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_bank_payout(), h::recipient(), PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    assert_eq!(intent_status(&mut s, intent), payment_intent::status_confirmed());
    assert_eq!(coin_received(&mut s, h::recipient()), PAY);
    s.end();
}

#[test]
/// Kind 2, another Splash business, is credited to its address balance,
/// where its own spending rules draw from; no Coin object is sent.
fun a_splash_business_is_credited_to_its_address_balance() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_splash_business(), BUSINESS, PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.next_tx(BUSINESS);
    assert_eq!(ts::settled_balance<USDC>(BUSINESS), PAY);
    assert!(!ts::has_most_recent_for_address<Coin<USDC>>(BUSINESS));
    s.end();
}

#[test]
/// The maker may be the wallet itself: staff can pay an intent the owners
/// opened, under the policy's checks.
fun staff_pays_an_intent_the_wallet_opened() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    s.end();
}

#[test]
/// The payer must be a spender and the maker current staff; they need not be
/// the same person. A junior pays a senior's intent within the junior's own
/// ceiling.
fun one_staff_member_pays_another_staff_members_intent() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay(&mut s, &fx, JUNIOR, fx.junior, intent, false);
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    s.end();
}

// ═══ Destinations ══════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_RECIPIENT_NOT_VERIFIED)]
/// Staff cannot even open an intent to an address the wallet never verified.
fun staff_cannot_open_an_intent_to_an_unlisted_recipient() {
    let (mut s, fx) = setup();
    open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), UNLISTED, PAY);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_RECIPIENT_NOT_VERIFIED)]
/// The wallet may open an intent to anyone; that does not let a spending
/// rule pay it. Paying re-checks the destination against the policy.
fun staff_cannot_pay_an_unlisted_recipient() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), UNLISTED, PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_RECIPIENT_NOT_VERIFIED)]
/// The policy can change between open and pay. Removing a recipient stops
/// its open intents at once.
fun removing_a_recipient_stops_its_open_intents() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    let mut p = wallet_policy(&mut s, &fx);
    p.remove_recipient(SUI_DOMAIN, SUPPLIER, s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_BENEFICIARY_NOT_VERIFIED)]
/// R2: a verified beneficiary cannot be paired with any other verified
/// address. OTHER_PARTNER is on the recipient list, but the beneficiary is
/// bound to a different partner deposit address, so staff cannot open it.
fun staff_cannot_open_a_bank_payout_to_a_partner_the_beneficiary_is_not_bound_to() {
    let (mut s, fx) = setup();
    open(&mut s, &fx, STAFF, 1, payment_intent::kind_bank_payout(), OTHER_PARTNER, PAY);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_BENEFICIARY_NOT_VERIFIED)]
/// The same mismatched pair, opened by the wallet: paying it under the
/// policy aborts, because the binding is checked again at pay time.
fun staff_cannot_pay_a_bank_payout_to_a_partner_the_beneficiary_is_not_bound_to() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_bank_payout(), OTHER_PARTNER, PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_BENEFICIARY_NOT_VERIFIED)]
/// Removing a beneficiary stops its open bank payouts.
fun removing_a_beneficiary_stops_its_open_bank_payouts() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_bank_payout(), h::recipient(), PAY);
    let mut p = wallet_policy(&mut s, &fx);
    p.remove_beneficiary(h::beneficiary(), s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_RECIPIENT_NOT_VERIFIED)]
/// A partner deposit address is verified only for its beneficiary's bank
/// payouts. It is not a wallet recipient (kinds 2–3), so a plain transfer to
/// it under the policy aborts.
fun a_partner_deposit_address_is_not_a_wallet_recipient() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), h::recipient(), PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}


// ═══ Amounts ═══════════════════════════════════════════════════════════════

#[test]
/// "Above the threshold" means strictly above: exactly 10,000 USDC is still
/// a payment one staff member may make alone.
fun exactly_at_the_threshold_needs_no_approval() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    assert_eq!(coin_received(&mut s, SUPPLIER), THRESHOLD);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_REQUIRED)]
/// One minor unit above the threshold, a payment needs a second owner's
/// approval, and without one it aborts.
fun one_unit_above_the_threshold_without_approval_aborts() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_REQUIRED)]
/// The owners opening an intent is not a second approval of a staff
/// member's payment of it: above the threshold, staff paying a wallet-made
/// intent still needs an owner approval (or the wallet's delegation).
fun a_wallet_made_intent_above_the_threshold_still_needs_an_approval() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_REQUIRED)]
/// The threshold is read at pay time. Lowering it below an open intent's
/// amount makes that intent need an approval.
fun lowering_the_threshold_applies_to_open_intents() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    let mut p = wallet_policy(&mut s, &fx);
    p.set_limits(POLICY_MAX, PAY - 1, s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
/// Above the threshold with an owner's approval, the payment goes through.
/// The approval reaches the payer, names exactly this payment, and is
/// consumed by the payment: it no longer exists afterwards.
fun above_the_threshold_with_an_owner_approval_passes() {
    let (mut s, fx) = setup();
    let amount = THRESHOLD + 1;
    let intent_id = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, amount);
    approve(&mut s, &fx, h::owner_2(), intent_id, STAFF);

    s.next_tx(STAFF);
    {
        let approval = s.take_from_sender<PayoutApproval>();
        assert_eq!(splash_spend::approval_policy(&approval), fx.policy);
        assert_eq!(splash_spend::approval_intent(&approval), intent_id);
        assert_eq!(splash_spend::approval_amount(&approval), amount);
        assert_eq!(splash_spend::approval_approver(&approval), h::owner_2());
        assert_eq!(splash_spend::approval_payer(&approval), STAFF);
        // It carries the intent's expiry: opened at day 2, for one day.
        assert_eq!(splash_spend::approval_expires_at_ms(&approval), 2 * h::day() + INTENT_LIFE);
        pay_in_tx(&mut s, fx.account, fx.policy, fx.staff, intent_id, option::some(approval));
        assert_eq!(event::events_by_type<SpendApprovalConsumed>().length(), 1);
        assert_eq!(event::events_by_type<PaidUnderPolicy>().length(), 1);
    };
    s.next_tx(STAFF);
    assert!(ts::ids_for_address<PayoutApproval>(STAFF).is_empty());
    assert_eq!(coin_received(&mut s, SUPPLIER), amount);
    s.end();
}

#[test]
/// Exactly the policy's maximum, with the approval it needs, is payable.
fun exactly_the_policy_maximum_with_approval_passes() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, POLICY_MAX);
    approve(&mut s, &fx, h::owner_3(), intent, STAFF);
    pay(&mut s, &fx, STAFF, fx.staff, intent, true);
    assert_eq!(coin_received(&mut s, SUPPLIER), POLICY_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_OVER_PER_PAYMENT_MAX)]
/// Staff cannot open an intent one unit above the policy's maximum.
fun staff_cannot_open_above_the_policy_maximum() {
    let (mut s, fx) = setup();
    open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, POLICY_MAX + 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_OVER_PER_PAYMENT_MAX)]
/// The policy's maximum is a ceiling no approval lifts: a wallet-made intent
/// one unit above it cannot be paid under the policy even with an owner's
/// approval. The owners can still pay it themselves.
fun no_approval_lifts_the_policy_maximum() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, POLICY_MAX + 1);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    pay(&mut s, &fx, STAFF, fx.staff, intent, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_OVER_PER_PAYMENT_MAX)]
/// The maximum is read at pay time: lowering it below an open intent stops
/// that intent.
fun lowering_the_policy_maximum_applies_to_open_intents() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    let mut p = wallet_policy(&mut s, &fx);
    p.set_limits(PAY - 1, THRESHOLD, s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
/// A spender may pay exactly their own ceiling.
fun a_spender_may_pay_exactly_their_own_maximum() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, JUNIOR_MAX);
    pay(&mut s, &fx, JUNIOR, fx.junior, intent, false);
    assert_eq!(coin_received(&mut s, SUPPLIER), JUNIOR_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_OVER_PER_PAYMENT_MAX)]
/// A spender cannot open an intent one unit above their own ceiling, though
/// it is far under the policy's.
fun a_spender_cannot_open_above_their_own_maximum() {
    let (mut s, fx) = setup();
    open(&mut s, &fx, JUNIOR, 1, payment_intent::kind_wallet(), SUPPLIER, JUNIOR_MAX + 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_OVER_PER_PAYMENT_MAX)]
/// Nor pay one: the payer's own ceiling binds whoever opened the intent.
fun a_spender_cannot_pay_above_their_own_maximum() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, JUNIOR_MAX + 1);
    pay(&mut s, &fx, JUNIOR, fx.junior, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_OVER_PER_PAYMENT_MAX)]
/// The checks run in the spec's order: the amount (step 5) before the
/// approvals (step 6). An intent over the maximum and over the threshold,
/// with no approval, is refused for its amount.
fun the_amount_is_checked_before_the_approvals() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, POLICY_MAX + 1);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_MAKER_NOT_A_SPENDER)]
/// And who opened it (step 3) before where it goes (step 4): with both the
/// maker and the recipient removed, the intent is refused for its maker.
fun the_maker_is_checked_before_the_destination() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    let mut p = wallet_policy(&mut s, &fx);
    p.remove_spender(STAFF, s.ctx());
    p.remove_recipient(SUI_DOMAIN, SUPPLIER, s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, JUNIOR, fx.junior, intent, false);
    s.end();
}

// ═══ Asset ═════════════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_ASSET)]
/// R2: the policy pays in USDC only. Staff cannot open an intent in any other
/// coin type under it.
fun staff_cannot_open_an_intent_in_another_asset() {
    let (mut s, fx) = setup_with(true);
    s.next_tx(STAFF);
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let intent = create_now<OTHER>(&policy, &mut account, &config, 1, payment_intent::kind_wallet(), SUPPLIER, PAY, &c, s.ctx());
    payment_intent::share_intent(intent);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    ts::return_shared(policy);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_ASSET)]
/// A spending rule in another coin cannot be accepted under a USDC policy.
fun an_allowance_in_another_asset_cannot_be_accepted() {
    let (mut s, fx) = setup();
    s.next_tx(h::wallet());
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let proposal = allowance::propose_for_app<Balance<OTHER>, SPLASH_SPEND>(
        splash_spend::allowance_name(&policy),
        STAFF,
        option::some(ALLOWANCE_CAP),
        option::none(),
        option::some(std::u64::max_value!()),
        option::none(),
        s.ctx(),
    );
    splash_spend::accept(proposal, &policy, s.ctx());
    ts::return_shared(policy);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_ASSET)]
/// `C` must be the policy's asset. Even with an allowance the wallet really
/// funded, drawing another coin type under the policy aborts.
fun paying_in_another_asset_aborts() {
    let (mut s, fx) = setup();
    let intent_id = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::wallet());
    {
        allowance::new<Balance<OTHER>>(
            b"other".to_string(),
            STAFF,
            option::some(ALLOWANCE_CAP),
            option::none(),
            option::some(std::u64::max_value!()),
            option::none(),
            s.ctx(),
        );
        balance::create_for_testing<OTHER>(FUNDS).send_funds(h::wallet());
    };
    let effects = s.next_tx(STAFF);
    let other_alw = new_shared(&effects);
    {
        let mut alw = s.take_shared_by_id<Allowance<Balance<OTHER>>>(other_alw);
        let mut intent = s.take_shared_by_id<PaymentIntent>(intent_id);
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let w = allowance::new_withdrawal_for_testing(other_alw, ts::withdraw_balance_from_address<OTHER>(h::wallet(), PAY));
        let receipt = splash_spend::pay_intent(
            &mut alw,
            w,
            &mut intent,
            &mut account,
            &policy,
            &config,
            option::none(),
            h::settle_by(&c),
            &c,
            s.ctx(),
        );
        audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(policy);
        ts::return_shared(account);
        ts::return_shared(intent);
        ts::return_shared(alw);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::payment_intent::E_WRONG_SETTLEMENT_ASSET)]
/// The type-name binding holds through the policy: an intent the wallet
/// opened in another (accepted) asset cannot be discharged with USDC drawn
/// under the rule.
fun an_intent_in_another_asset_cannot_be_paid_in_usdc() {
    let (mut s, fx) = setup_with(true);
    s.next_tx(h::wallet());
    let intent_id;
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let intent = payment_intent::create_for_wallet<OTHER>(
            &mut account,
            &config,
            h::payment_ref(1),
            SUPPLIER,
            vector[],
            PAY,
            b"USDC".to_string(),
            1_000_000,
            h::commitment(),
            payment_intent::kind_wallet(),
            h::rail(),
            c.timestamp_ms() + INTENT_LIFE,
            &c,
            s.ctx(),
        );
        intent_id = object::id(&intent);
        payment_intent::share_intent(intent);
        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(account);
    };
    pay(&mut s, &fx, STAFF, fx.staff, intent_id, false);
    s.end();
}

// ═══ Account and policy ════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_ACCOUNT)]
/// A policy of another business cannot be used for this one, even when the
/// two businesses share a wallet and list the same spender and recipient.
fun a_policy_of_another_business_cannot_pay_this_ones_intent() {
    let (mut s, fx) = setup();
    let (_account2, policy2) = second_business(&mut s);
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(STAFF);
    pay_in_tx(&mut s, fx.account, policy2, fx.staff, intent, option::none());
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_ACCOUNT)]
/// An intent bound to another account cannot be paid under this policy and
/// account, however consistent the policy and account are with each other.
fun an_intent_of_another_business_cannot_be_paid() {
    let (mut s, fx) = setup();
    let (account2, policy2) = second_business(&mut s);
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(STAFF);
    pay_in_tx(&mut s, account2, policy2, fx.staff, intent, option::none());
    s.end();
}

// ═══ Allowances and funders ════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_FUNDER)]
/// The money must be the business wallet's. An allowance some owner funded
/// from their own address cannot pay the business's intent under its policy.
fun an_allowance_from_another_funder_aborts() {
    let (mut s, fx) = setup();
    let intent_id = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::owner_2());
    {
        allowance::new<Balance<USDC>>(
            b"mine".to_string(),
            STAFF,
            option::some(ALLOWANCE_CAP),
            option::none(),
            option::some(std::u64::max_value!()),
            option::none(),
            s.ctx(),
        );
        balance::create_for_testing<USDC>(FUNDS).send_funds(h::owner_2());
    };
    let effects = s.next_tx(STAFF);
    let foreign = new_shared(&effects);
    {
        let mut alw = s.take_shared_by_id<Allowance<Balance<USDC>>>(foreign);
        let mut intent = s.take_shared_by_id<PaymentIntent>(intent_id);
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        pay_objects(
            &mut alw,
            &mut intent,
            &mut account,
            &policy,
            &config,
            option::none(),
            h::owner_2(),
            PAY,
            h::settle_by(&c),
            &c,
            s.ctx(),
        );
        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(policy);
        ts::return_shared(account);
        ts::return_shared(intent);
        ts::return_shared(alw);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_PROPOSAL_FUNDER)]
/// Nor can such an allowance be bound to this app: `accept` refuses a
/// proposal funded by anyone but the policy's wallet.
fun a_proposal_from_another_funder_cannot_be_accepted() {
    let (mut s, fx) = setup();
    s.next_tx(h::owner_2());
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let proposal = allowance::propose_for_app<Balance<USDC>, SPLASH_SPEND>(
        splash_spend::allowance_name(&policy),
        STAFF,
        option::some(ALLOWANCE_CAP),
        option::none(),
        option::some(std::u64::max_value!()),
        option::none(),
        s.ctx(),
    );
    splash_spend::accept(proposal, &policy, s.ctx());
    ts::return_shared(policy);
    s.end();
}

#[test]
#[expected_failure(abort_code = sui::allowance::EWrongApp)]
/// Only an allowance bound to `SPLASH_SPEND` can be drawn here. A plain
/// allowance from the wallet to the same staff member does not become a
/// spending rule.
fun an_allowance_not_bound_to_the_app_cannot_be_drawn() {
    let (mut s, fx) = setup();
    let intent_id = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::wallet());
    allowance::new<Balance<USDC>>(
        b"plain".to_string(),
        STAFF,
        option::some(ALLOWANCE_CAP),
        option::none(),
        option::some(std::u64::max_value!()),
        option::none(),
        s.ctx(),
    );
    let effects = s.next_tx(STAFF);
    let plain = new_shared(&effects);
    pay_in_tx(&mut s, fx.account, fx.policy, plain, intent_id, option::none());
    s.end();
}

#[test]
#[expected_failure(abort_code = sui::allowance::ENotSpender)]
/// The payer must be the allowance's own spender: STAFF cannot draw on
/// JUNIOR's rule.
fun a_spender_cannot_draw_on_another_spenders_allowance() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay(&mut s, &fx, STAFF, fx.junior, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = sui::allowance::EExceedsLifetimeCap)]
/// The allowance's own lifetime cap is enforced by the framework, whatever
/// the policy allows: a second payment past the cap aborts.
fun spending_beyond_the_allowance_lifetime_cap_aborts() {
    let (mut s, fx) = setup();
    let small = grant(&mut s, fx.policy, STAFF, (PAY as u256) + (PAY as u256) / 2);
    let first = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    let second = open(&mut s, &fx, STAFF, 2, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay(&mut s, &fx, STAFF, small, first, false);
    pay(&mut s, &fx, STAFF, small, second, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = sui::allowance::EWrongFunder)]
/// The withdrawal must come from the funder's own address balance: a
/// withdrawal reserved from someone else's balance cannot be drawn under the
/// wallet's allowance.
fun a_withdrawal_from_another_address_cannot_be_drawn() {
    let (mut s, fx) = setup();
    let intent_id = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::owner_2());
    balance::create_for_testing<USDC>(FUNDS).send_funds(h::owner_2());
    s.next_tx(STAFF);
    {
        let mut alw = s.take_shared_by_id<Allowance<Balance<USDC>>>(fx.staff);
        let mut intent = s.take_shared_by_id<PaymentIntent>(intent_id);
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        pay_objects(
            &mut alw,
            &mut intent,
            &mut account,
            &policy,
            &config,
            option::none(),
            h::owner_2(),
            PAY,
            h::settle_by(&c),
            &c,
            s.ctx(),
        );
        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(policy);
        ts::return_shared(account);
        ts::return_shared(intent);
        ts::return_shared(alw);
    };
    s.end();
}

/// Pay STAFF's intent drawing `drawn` rather than the intent's amount.
fun pay_drawing(s: &mut Scenario, fx: &Fx, intent_id: ID, drawn: u64) {
    s.next_tx(STAFF);
    let mut alw = s.take_shared_by_id<Allowance<Balance<USDC>>>(fx.staff);
    let mut intent = s.take_shared_by_id<PaymentIntent>(intent_id);
    let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    pay_objects(
        &mut alw,
        &mut intent,
        &mut account,
        &policy,
        &config,
        option::none(),
        h::wallet(),
        drawn,
        h::settle_by(&c),
        &c,
        s.ctx(),
    );
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(policy);
    ts::return_shared(account);
    ts::return_shared(intent);
    ts::return_shared(alw);
}

#[test]
#[expected_failure(abort_code = splash_core::payment_intent::E_EXACT_AMOUNT_REQUIRED)]
/// Allowance money is drawn for exactly the intent: drawing one unit more
/// aborts, since there is nowhere to refund it without moving it twice.
fun drawing_one_unit_more_than_the_intent_aborts() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay_drawing(&mut s, &fx, intent, PAY + 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::payment_intent::E_EXACT_AMOUNT_REQUIRED)]
/// And one unit less cannot settle it.
fun drawing_one_unit_less_than_the_intent_aborts() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay_drawing(&mut s, &fx, intent, PAY - 1);
    s.end();
}

// ═══ Second approvals ══════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_SELF_APPROVAL)]
/// Four eyes means two people. An owner who is also staff opens an intent
/// above the threshold, and cannot then give it the second approval.
fun the_maker_cannot_approve_their_own_intent() {
    let (mut s, fx) = setup();
    let mut p = wallet_policy(&mut s, &fx);
    p.add_spender(h::owner_2(), spend_policy::role_staff(), STAFF_MAX, s.ctx());
    ts::return_shared(p);
    let intent = open(&mut s, &fx, h::owner_2(), 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_SELF_APPROVAL)]
/// Nor can an owner who is a spender approve a payment they will make
/// themselves.
fun the_payer_cannot_approve_their_own_payment() {
    let (mut s, fx) = setup();
    let mut p = wallet_policy(&mut s, &fx);
    p.add_spender(h::owner_3(), spend_policy::role_staff(), STAFF_MAX, s.ctx());
    ts::return_shared(p);
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_3(), intent, h::owner_3());
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_ONLY_THE_WALLET_DELEGATES)]
/// An owner who opened an intent above the threshold cannot get round the
/// four-eyes rule by delegating it to the executor: an owner who is staff
/// opens as staff, and staff cannot delegate at all.
fun an_owner_maker_cannot_self_approve_by_delegating() {
    let (mut s, fx) = setup();
    let mut p = wallet_policy(&mut s, &fx);
    p.add_spender(h::owner_2(), spend_policy::role_staff(), STAFF_MAX, s.ctx());
    ts::return_shared(p);
    let intent = open(&mut s, &fx, h::owner_2(), 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    delegate(&mut s, &fx, h::owner_2(), intent, EXECUTOR);
    pay(&mut s, &fx, EXECUTOR, fx.executor, intent, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_AN_OWNER)]
/// Only an owner (a member of the wallet) gives a second approval. Another
/// staff member cannot.
fun a_non_owner_cannot_approve() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, JUNIOR, intent, STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_A_SPENDER)]
/// An approval names a payer who is a spender. It cannot be issued to an
/// address the policy does not list.
fun an_approval_cannot_name_a_non_spender_as_payer() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_2(), intent, STRANGER);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_MISMATCH)]
/// An approval is for one intent and its amount. The approval for a
/// 10,000.000001 USDC intent cannot pay a different 10,000.000002 USDC one.
fun an_approval_for_another_intent_and_amount_aborts() {
    let (mut s, fx) = setup();
    let approved = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    let other = open(&mut s, &fx, STAFF, 2, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 2);
    approve(&mut s, &fx, h::owner_2(), approved, STAFF);
    pay(&mut s, &fx, STAFF, fx.staff, other, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_MISMATCH)]
/// An approval is for one payer. Approval objects are owned, but suppose one
/// reaches another spender: the executor presenting STAFF's approval is
/// refused.
fun an_approval_for_another_payer_aborts() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    s.next_tx(EXECUTOR);
    let approval = ts::take_from_address<PayoutApproval>(&s, STAFF);
    pay_in_tx(&mut s, fx.account, fx.policy, fx.executor, intent, option::some(approval));
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_MISMATCH)]
/// "Any approval passed must match." Below the threshold a staff payment
/// needs none, but passing one for a different intent still aborts.
fun a_mismatched_approval_aborts_even_when_none_is_needed() {
    let (mut s, fx) = setup();
    let approved = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    let small = open(&mut s, &fx, STAFF, 2, payment_intent::kind_wallet(), SUPPLIER, PAY);
    approve(&mut s, &fx, h::owner_2(), approved, STAFF);
    pay(&mut s, &fx, STAFF, fx.staff, small, true);
    s.end();
}

#[test]
/// A matching approval passed where none was needed is consumed with the
/// payment, not left lying about.
fun a_matching_approval_is_consumed_even_when_none_is_needed() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    pay(&mut s, &fx, STAFF, fx.staff, intent, true);
    s.next_tx(STAFF);
    assert!(ts::ids_for_address<PayoutApproval>(STAFF).is_empty());
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_PAYABLE)]
/// A consumed approval cannot be replayed, and a paid intent cannot be
/// approved again: after the payment the approval is gone, and a fresh
/// approval for the same (now confirmed) intent cannot be minted.
fun a_consumed_approval_is_gone_and_a_paid_intent_cannot_be_approved_again() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    pay(&mut s, &fx, STAFF, fx.staff, intent, true);
    s.next_tx(STAFF);
    assert!(ts::ids_for_address<PayoutApproval>(STAFF).is_empty());
    assert_eq!(intent_status(&mut s, intent), payment_intent::status_confirmed());
    approve(&mut s, &fx, h::owner_3(), intent, STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::payment_intent::E_NOT_PENDING)]
/// The same intent cannot be paid twice under the rule: the second attempt
/// aborts because the intent is no longer pending.
fun paying_the_same_intent_twice_aborts() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_STALE_APPROVAL)]
/// An approval dies when the account's authority moves. An owner freezes
/// and the wallet lifts the freeze: the approval given before is stale.
fun an_approval_given_before_a_freeze_and_thaw_is_stale() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    s.next_tx(h::owner_1());
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        business_account::freeze_account(&mut account, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        business_account::unfreeze_account(&mut account, s.ctx());
        ts::return_shared(account);
    };
    pay(&mut s, &fx, STAFF, fx.staff, intent, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::business_account::E_FROZEN)]
/// A freeze stops every Splash path, including staff allowances.
fun a_frozen_account_cannot_pay_under_a_spending_rule() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::owner_3());
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        business_account::freeze_account(&mut account, s.ctx());
        ts::return_shared(account);
    };
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_EXPIRED)]
/// An approval expires with its intent: at exactly `expires_at` it can no
/// longer be used.
fun an_approval_cannot_be_used_at_its_expiry() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    advance(&mut s, INTENT_LIFE);
    pay(&mut s, &fx, STAFF, fx.staff, intent, true);
    s.end();
}

#[test]
/// One millisecond before the expiry, the same approval still pays.
fun an_approval_pays_one_millisecond_before_its_expiry() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    advance(&mut s, INTENT_LIFE - 1);
    pay(&mut s, &fx, STAFF, fx.staff, intent, true);
    assert_eq!(coin_received(&mut s, SUPPLIER), THRESHOLD + 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_PAYABLE)]
/// An expired intent cannot be approved.
fun an_expired_intent_cannot_be_approved() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    advance(&mut s, INTENT_LIFE);
    approve(&mut s, &fx, h::owner_2(), intent, STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::payment_intent::E_EXPIRED)]
/// An expired intent cannot be paid under the rule, approval or not.
fun an_expired_intent_cannot_be_paid() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    advance(&mut s, INTENT_LIFE);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

// ═══ The executor ══════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_STAFF)]
/// A stolen operator key can start nothing: the executor cannot open an
/// intent.
fun the_executor_cannot_open_an_intent() {
    let (mut s, fx) = setup();
    open(&mut s, &fx, EXECUTOR, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_STAFF)]
/// Nor can anyone off the policy.
fun a_stranger_cannot_open_an_intent() {
    let (mut s, fx) = setup();
    open(&mut s, &fx, STRANGER, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_REQUIRED)]
/// R2: an executor always needs an approval, even far below the threshold.
fun the_executor_cannot_pay_without_an_approval_below_the_threshold() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay(&mut s, &fx, EXECUTOR, fx.executor, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_APPROVAL_REQUIRED)]
/// Including for an intent the wallet itself opened.
fun the_executor_cannot_pay_a_wallet_intent_without_an_approval() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay(&mut s, &fx, EXECUTOR, fx.executor, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_ONLY_THE_WALLET_DELEGATES)]
/// Review A3: a staff maker cannot hand their own payment to the executor,
/// even one they could have made alone. The executor pays from its own
/// allowance, so a staff delegation would let the staff member spend past
/// their own rule's caps, expiry and revocation.
fun a_staff_maker_cannot_delegate_their_payment_to_the_executor() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD);
    delegate(&mut s, &fx, STAFF, intent, EXECUTOR);
    s.end();
}

/// A staff member with a 1,000 USDC rule for life, and a ceiling to match.
const TINY: address = @0x71AE;
const TINY_CAP: u256 = 1_000_000_000;
const TINY_PAY: u64 = 1_000_000_000;

/// The wallet lists TINY as staff and grants TINY's own rule.
fun add_tiny(s: &mut Scenario, fx: &Fx): ID {
    let mut p = wallet_policy(s, fx);
    p.add_spender(TINY, spend_policy::role_staff(), TINY_PAY, s.ctx());
    ts::return_shared(p);
    grant(s, fx.policy, TINY, TINY_CAP)
}

/// What allowance `alw` has spent so far.
fun alw_spend(s: &mut Scenario, alw: ID): u256 {
    s.next_tx(STRANGER);
    let a = s.take_shared_by_id<Allowance<Balance<USDC>>>(alw);
    let v = allowance::allowance_current_spend(&a);
    ts::return_shared(a);
    v
}

#[test]
#[expected_failure(abort_code = sui::allowance::EExceedsLifetimeCap)]
/// The control for the next test: TINY cannot pay a second 1,000 USDC under
/// its own 1,000 USDC rule.
fun a_staff_member_cannot_pay_past_their_own_lifetime_cap() {
    let (mut s, fx) = setup();
    let tiny = add_tiny(&mut s, &fx);
    let first = open(&mut s, &fx, TINY, 41, payment_intent::kind_wallet(), SUPPLIER, TINY_PAY);
    pay(&mut s, &fx, TINY, tiny, first, false);
    let second = open(&mut s, &fx, TINY, 42, payment_intent::kind_wallet(), SUPPLIER, TINY_PAY);
    pay(&mut s, &fx, TINY, tiny, second, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_ONLY_THE_WALLET_DELEGATES)]
/// Review A3, the reviewer's proof: with its own rule used up, TINY opened
/// another payment and handed it to the executor, which paid it from ITS
/// allowance, five times over. TINY's rule was never charged. Now the
/// hand-over itself is refused.
fun a_staff_member_cannot_pay_past_their_own_cap_through_the_executor() {
    let (mut s, fx) = setup();
    let tiny = add_tiny(&mut s, &fx);
    let first = open(&mut s, &fx, TINY, 41, payment_intent::kind_wallet(), SUPPLIER, TINY_PAY);
    pay(&mut s, &fx, TINY, tiny, first, false);
    assert_eq!(alw_spend(&mut s, tiny), TINY_CAP);
    let next = open(&mut s, &fx, TINY, 50, payment_intent::kind_wallet(), SUPPLIER, TINY_PAY);
    delegate(&mut s, &fx, TINY, next, EXECUTOR);
    pay(&mut s, &fx, EXECUTOR, fx.executor, next, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_ONLY_THE_WALLET_DELEGATES)]
/// Review A3: the owners revoke JUNIOR's rule (D2's "revoke the allowance"),
/// but JUNIOR is still listed as staff. JUNIOR must not keep paying by
/// handing each payment to the executor.
fun a_staff_member_whose_rule_is_revoked_cannot_pay_through_the_executor() {
    let (mut s, fx) = setup();
    s.next_tx(h::wallet());
    {
        let ids = ts::ids_for_sender<allowance::AllowanceCap<Balance<USDC>>>(&s);
        let mut found = false;
        ids.do!(|id| {
            let cap = s.take_from_sender_by_id<allowance::AllowanceCap<Balance<USDC>>>(id);
            if (!found && allowance::allowance_cap_allowance(&cap) == fx.junior) {
                found = true;
                let alw = s.take_shared_by_id<Allowance<Balance<USDC>>>(fx.junior);
                allowance::revoke(cap, alw);
            } else {
                s.return_to_sender(cap);
            };
        });
        assert!(found);
    };
    let intent = open(&mut s, &fx, JUNIOR, 60, payment_intent::kind_wallet(), SUPPLIER, PAY);
    delegate(&mut s, &fx, JUNIOR, intent, EXECUTOR);
    pay(&mut s, &fx, EXECUTOR, fx.executor, intent, true);
    s.end();
}

#[test]
/// With an owner's approval naming it, the executor pays above the
/// threshold.
fun the_executor_pays_above_the_threshold_with_an_owner_approval() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    approve(&mut s, &fx, h::owner_2(), intent, EXECUTOR);
    pay(&mut s, &fx, EXECUTOR, fx.executor, intent, true);
    assert_eq!(coin_received(&mut s, SUPPLIER), THRESHOLD + 1);
    s.end();
}

#[test]
/// A staff member's payment reaches the executor only through an owner's
/// approval, at any amount. The executor's own allowance is charged, by
/// exactly the payment, and the maker's is not touched: the owners approved
/// this one payment, so it does not count against the maker's rule.
fun the_executor_pays_a_staff_intent_below_the_threshold_with_an_owner_approval() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    approve(&mut s, &fx, h::owner_3(), intent, EXECUTOR);
    pay(&mut s, &fx, EXECUTOR, fx.executor, intent, true);
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    assert_eq!(alw_spend(&mut s, fx.executor), PAY as u256);
    assert_eq!(alw_spend(&mut s, fx.staff), 0);
    s.end();
}

#[test]
/// The wallet's delegation of an intent it opened itself is the owners'
/// approval: the quorum opened the intent and handed it to the executor, at
/// any amount. The approval names the wallet as approver and the executor
/// as payer.
fun the_wallets_delegation_of_its_own_intent_pays_at_any_amount() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    delegate(&mut s, &fx, h::wallet(), intent, EXECUTOR);
    s.next_tx(EXECUTOR);
    {
        let approval = s.take_from_sender<PayoutApproval>();
        assert_eq!(splash_spend::approval_approver(&approval), h::wallet());
        assert_eq!(splash_spend::approval_payer(&approval), EXECUTOR);
        pay_in_tx(&mut s, fx.account, fx.policy, fx.executor, intent, option::some(approval));
    };
    s.next_tx(EXECUTOR);
    assert!(ts::ids_for_address<PayoutApproval>(EXECUTOR).is_empty());
    assert_eq!(coin_received(&mut s, SUPPLIER), THRESHOLD + 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_THE_MAKER)]
/// The wallet delegates only what it opened itself. A staff member's intent
/// reaches the executor through an owner's approval, which is four-eyes and
/// names the payment, not through the wallet's delegation.
fun the_wallet_cannot_delegate_an_intent_staff_opened() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    delegate(&mut s, &fx, h::wallet(), intent, EXECUTOR);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_ONLY_THE_WALLET_DELEGATES)]
/// Only the wallet delegates. Another staff member cannot delegate an
/// intent either.
fun another_staff_member_cannot_delegate_an_intent() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    delegate(&mut s, &fx, JUNIOR, intent, EXECUTOR);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_ONLY_THE_WALLET_DELEGATES)]
/// Nor can staff delegate an intent the wallet opened, which would turn a
/// staff key into the owners' approval.
fun staff_cannot_delegate_an_intent_the_wallet_opened() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, THRESHOLD + 1);
    delegate(&mut s, &fx, STAFF, intent, EXECUTOR);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_AN_EXECUTOR)]
/// A delegation goes to an executor only, not to a staff member.
fun delegating_to_a_staff_member_aborts() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    delegate(&mut s, &fx, h::wallet(), intent, JUNIOR);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_AN_EXECUTOR)]
/// And not to an address off the policy.
fun delegating_to_a_stranger_aborts() {
    let (mut s, fx) = setup();
    let intent = open_by_wallet(&mut s, &fx, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    delegate(&mut s, &fx, h::wallet(), intent, STRANGER);
    s.end();
}

// ═══ Removing people ═══════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_MAKER_NOT_A_SPENDER)]
/// R2: removing a staff member kills their open intents. Another spender
/// cannot pay what the removed maker opened.
fun removing_the_maker_stops_another_spender_paying_their_intent() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    let mut p = wallet_policy(&mut s, &fx);
    p.remove_spender(STAFF, s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, JUNIOR, fx.junior, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_MAKER_NOT_A_SPENDER)]
/// Including through an owner's approval naming the executor, given before
/// the maker was removed.
fun removing_the_maker_kills_an_approval_naming_the_executor() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    approve(&mut s, &fx, h::owner_2(), intent, EXECUTOR);
    let mut p = wallet_policy(&mut s, &fx);
    p.remove_spender(STAFF, s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, EXECUTOR, fx.executor, intent, true);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_MAKER_NOT_A_SPENDER)]
/// The maker must be current STAFF, not merely a spender: demoting the maker
/// to executor also kills their open intents.
fun demoting_the_maker_to_executor_stops_their_intents() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    let mut p = wallet_policy(&mut s, &fx);
    p.remove_spender(STAFF, s.ctx());
    p.add_spender(STAFF, spend_policy::role_executor(), STAFF_MAX, s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, JUNIOR, fx.junior, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_A_SPENDER)]
/// A removed spender cannot pay, though their allowance still exists: the
/// policy stops them at once, without waiting for a revoke.
fun a_removed_payer_cannot_pay() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    let mut p = wallet_policy(&mut s, &fx);
    p.remove_spender(STAFF, s.ctx());
    ts::return_shared(p);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_NOT_STAFF)]
/// Nor open a new intent.
fun a_removed_spender_cannot_open_an_intent() {
    let (mut s, fx) = setup();
    let mut p = wallet_policy(&mut s, &fx);
    p.remove_spender(STAFF, s.ctx());
    ts::return_shared(p);
    open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.end();
}

// ═══ Stale policies ════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_STALE_POLICY)]
/// R2: rotating the wallet leaves its policy behind. After A rotates to B
/// and B confirms, A's policy stops paying, though A's allowance still
/// names A as funder.
fun a_rotation_stales_the_old_wallets_policy() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    rotate(&mut s, &fx, h::wallet(), b_keys(), b_weights(), 2);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_STALE_POLICY)]
/// A rotation from A to B and back to A gives the old address back, but not
/// the old rules: the wallet generation differs.
fun rotating_back_to_the_same_address_does_not_revive_the_policy() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    rotate(&mut s, &fx, h::wallet(), b_keys(), b_weights(), 2);
    rotate(&mut s, &fx, wallet_b(), h::keys(), h::weights(), h::threshold());
    s.next_tx(STRANGER);
    {
        let account = s.take_shared_by_id<BusinessAccount>(fx.account);
        assert_eq!(business_account::wallet(&account), h::wallet());
        ts::return_shared(account);
    };
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_STALE_POLICY)]
/// Nor can a stale policy open new intents.
fun a_stale_policy_cannot_open_intents() {
    let (mut s, fx) = setup();
    rotate(&mut s, &fx, h::wallet(), b_keys(), b_weights(), 2);
    rotate(&mut s, &fx, wallet_b(), h::keys(), h::weights(), h::threshold());
    open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.end();
}

#[test]
/// Only a CONFIRMED rotation moves the generation. A rotation that is merely
/// proposed leaves the current policy paying.
fun a_proposed_rotation_does_not_stale_the_policy() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        business_account::rotate_wallet(&mut account, b_keys(), b_weights(), 2, false, s.ctx());
        ts::return_shared(account);
    };
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    s.end();
}

#[test]
/// After A to B and back to A, the wallet makes a new policy for the new
/// generation, and spending resumes under it.
fun a_new_policy_for_the_new_generation_pays() {
    let (mut s, fx) = setup();
    rotate(&mut s, &fx, h::wallet(), b_keys(), b_weights(), 2);
    rotate(&mut s, &fx, wallet_b(), h::keys(), h::weights(), h::threshold());
    s.next_tx(h::wallet());
    let policy3;
    {
        let mut registry = s.take_shared<PolicyRegistry>();
        let account = s.take_shared_by_id<BusinessAccount>(fx.account);
        policy3 =
            spend_policy::create_policy<USDC>(
                &mut registry,
                &account,
                h::keys(),
                h::weights(),
                h::threshold(),
                POLICY_MAX,
                s.ctx(),
            );
        ts::return_shared(account);
        ts::return_shared(registry);
    };
    s.next_tx(h::wallet());
    {
        let mut policy = s.take_shared_by_id<SpendPolicy>(policy3);
        policy.add_spender(STAFF, spend_policy::role_staff(), STAFF_MAX, s.ctx());
        policy.verify_recipient(SUI_DOMAIN, SUPPLIER, s.ctx());
        ts::return_shared(policy);
    };
    let alw = grant(&mut s, policy3, STAFF, ALLOWANCE_CAP);
    let fx3 = Fx { account: fx.account, policy: policy3, staff: alw, junior: fx.junior, executor: fx.executor };
    let intent = open(&mut s, &fx3, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay(&mut s, &fx3, STAFF, alw, intent, false);
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    s.end();
}

// ═══ Paths ═════════════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_PAY_PATH)]
/// Review A2-A4: a spending rule pays only on Sui. A cross-chain intent the
/// wallet opened, to a recipient no policy can verify, cannot be paid under
/// a rule: there is no spending-rule path that hands the business's coin to
/// a bridge. The owners pay it from the wallet.
fun a_cross_chain_intent_cannot_be_paid_under_a_spending_rule() {
    let (mut s, fx) = setup();
    let intent = open_cross_chain_by_wallet(&mut s, &fx, 1, ETH_DOMAIN, EVM_RECIPIENT, PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_PAY_PATH)]
/// Not even to a supplier the policy verified on Sui: the intent's domain,
/// not the address, decides.
fun a_cross_chain_intent_to_a_verified_sui_address_cannot_be_paid_under_a_spending_rule() {
    let (mut s, fx) = setup();
    let intent = open_cross_chain_by_wallet(&mut s, &fx, 1, ETH_DOMAIN, SUPPLIER, PAY);
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_PAY_PATH)]
/// Nor can an owner approve one for the executor: an approval no spending
/// rule could ever use is refused, not minted.
fun a_cross_chain_intent_cannot_be_approved_for_a_spending_rule() {
    let (mut s, fx) = setup();
    let intent = open_cross_chain_by_wallet(&mut s, &fx, 1, ETH_DOMAIN, EVM_RECIPIENT, PAY);
    approve(&mut s, &fx, h::owner_2(), intent, EXECUTOR);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_PAY_PATH)]
/// And the wallet cannot delegate one to the executor.
fun a_cross_chain_intent_cannot_be_delegated_to_the_executor() {
    let (mut s, fx) = setup();
    let intent = open_cross_chain_by_wallet(&mut s, &fx, 1, ETH_DOMAIN, EVM_RECIPIENT, PAY);
    delegate(&mut s, &fx, h::wallet(), intent, EXECUTOR);
    s.end();
}

#[test]
/// The owners' own path still pays it: the wallet releases the exact coin
/// beside the obligation naming it, in the owners' own transaction. (This
/// test stands in for the bridge adapter's burn.)
fun the_wallet_still_pays_a_cross_chain_intent_itself() {
    let (mut s, fx) = setup();
    let intent_id = open_cross_chain_by_wallet(&mut s, &fx, 1, ETH_DOMAIN, EVM_RECIPIENT, PAY);
    s.next_tx(h::wallet());
    {
        let mut intent = s.take_shared_by_id<PaymentIntent>(intent_id);
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let (receipt, coin, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
            &mut intent,
            &mut account,
            &config,
            h::usdc(PAY, s.ctx()),
            h::settle_by(&c),
            &c,
            s.ctx(),
        );
        audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
        let (o_intent, o_coin, _, o_amount, o_domain, o_recipient, _, _) =
            payment_intent::unpack_bridge_obligation_for_testing(obligation);
        assert_eq!(o_intent, intent_id);
        assert_eq!(o_coin, object::id(&coin));
        assert_eq!(o_amount, PAY);
        assert_eq!(o_domain, ETH_DOMAIN);
        assert_eq!(o_recipient, EVM_RECIPIENT);
        assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
        coin.burn_for_testing();
        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(account);
        ts::return_shared(intent);
    };
    s.end();
}

// ═══ The quote, and the registry ═══════════════════════════════════════════

/// STAFF pays the intent with `settle_by_ms` set `ahead` ms from now.
fun pay_with_settle_by(s: &mut Scenario, fx: &Fx, intent_id: ID, ahead: u64) {
    s.next_tx(STAFF);
    let mut alw = s.take_shared_by_id<Allowance<Balance<USDC>>>(fx.staff);
    let mut intent = s.take_shared_by_id<PaymentIntent>(intent_id);
    let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    pay_objects(
        &mut alw,
        &mut intent,
        &mut account,
        &policy,
        &config,
        option::none(),
        h::wallet(),
        PAY,
        c.timestamp_ms() + ahead,
        &c,
        s.ctx(),
    );
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(policy);
    ts::return_shared(account);
    ts::return_shared(intent);
    ts::return_shared(alw);
}

#[test]
#[expected_failure(abort_code = splash_core::payment_intent::E_SETTLE_BY_PASSED)]
/// A payment signed against a quote cannot land after the quote lapsed:
/// `settle_by_ms` equal to now is already too late.
fun a_payment_after_its_settle_by_aborts() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay_with_settle_by(&mut s, &fx, intent, 0);
    s.end();
}

#[test]
/// One millisecond before `settle_by_ms`, it lands.
fun a_payment_one_millisecond_before_its_settle_by_passes() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    pay_with_settle_by(&mut s, &fx, intent, 1);
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::compliance_config::E_NOT_A_SETTLEMENT_APP)]
/// Removing the app from the registry is immediate and stops the staff
/// path, including intents already open under it.
fun removing_the_settlement_app_stops_spending_rules() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::wallet());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::admin_remove_registry_entry(
            &admin,
            &mut config,
            compliance_config::registry_settlement_app(),
            compliance_config::type_string<SettleWitness>(),
        );
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
    };
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
/// While the owners' own path keeps working: the wallet pays the staff
/// member's open intent itself after the app is removed.
fun removing_the_settlement_app_leaves_the_owners_path_working() {
    let (mut s, fx) = setup();
    let intent_id = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::wallet());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::admin_remove_registry_entry(
            &admin,
            &mut config,
            compliance_config::registry_settlement_app(),
            compliance_config::type_string<SettleWitness>(),
        );
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
    };
    s.next_tx(h::wallet());
    {
        let mut intent = s.take_shared_by_id<PaymentIntent>(intent_id);
        let mut account = s.take_shared_by_id<BusinessAccount>(fx.account);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let receipt = payment_intent::confirm_from_business_wallet(
            &mut intent,
            &mut account,
            &config,
            h::usdc(PAY, s.ctx()),
            h::settle_by(&c),
            &c,
            s.ctx(),
        );
        audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
        ts::return_shared(c);
        ts::return_shared(config);
        ts::return_shared(account);
        ts::return_shared(intent);
    };
    assert_eq!(coin_received(&mut s, SUPPLIER), PAY);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_core::compliance_config::E_SETTLEMENT_PAUSED)]
/// A paused config stops spending rules too.
fun a_paused_config_stops_spending_rules() {
    let (mut s, fx) = setup();
    let intent = open(&mut s, &fx, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    s.next_tx(h::wallet());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::admin_set_paused(&admin, &mut config, true);
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
    };
    pay(&mut s, &fx, STAFF, fx.staff, intent, false);
    s.end();
}

// ═══ Each allowance belongs to the policy that accepted it ═══════════════════

#[test]
#[expected_failure(abort_code = splash_spend::E_ALLOWANCE_NOT_FOR_POLICY)]
/// After A to B and back to A, an allowance the generation-1 policy accepted
/// is still funded by A, and the new generation-3 policy lists the same staff
/// member again. It still cannot pay under the new policy: its name binds it
/// to the policy that accepted it. The business re-issues allowances for the
/// new generation deliberately; the old ones do not come back.
fun an_old_generations_allowance_does_not_pay_under_a_new_policy() {
    let (mut s, fx) = setup();
    rotate(&mut s, &fx, h::wallet(), b_keys(), b_weights(), 2);
    rotate(&mut s, &fx, wallet_b(), h::keys(), h::weights(), h::threshold());
    s.next_tx(h::wallet());
    let policy3;
    {
        let mut registry = s.take_shared<PolicyRegistry>();
        let account = s.take_shared_by_id<BusinessAccount>(fx.account);
        policy3 =
            spend_policy::create_policy<USDC>(&mut registry, &account, h::keys(), h::weights(), h::threshold(), POLICY_MAX, s.ctx());
        ts::return_shared(account);
        ts::return_shared(registry);
    };
    s.next_tx(h::wallet());
    {
        let mut policy = s.take_shared_by_id<SpendPolicy>(policy3);
        policy.add_spender(STAFF, spend_policy::role_staff(), STAFF_MAX, s.ctx());
        policy.verify_recipient(SUI_DOMAIN, SUPPLIER, s.ctx());
        ts::return_shared(policy);
    };
    let fx3 = Fx { account: fx.account, policy: policy3, staff: fx.staff, junior: fx.junior, executor: fx.executor };
    let intent = open(&mut s, &fx3, STAFF, 1, payment_intent::kind_wallet(), SUPPLIER, PAY);
    // fx.staff: the generation-1 allowance.
    pay(&mut s, &fx3, STAFF, fx.staff, intent, false);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_ALLOWANCE_NOT_FOR_POLICY)]
/// A spending rule must carry its policy's name to be accepted at all.
fun a_proposal_not_named_for_the_policy_cannot_be_accepted() {
    let (mut s, fx) = setup();
    s.next_tx(h::wallet());
    let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
    let proposal = allowance::propose_for_app<Balance<USDC>, SPLASH_SPEND>(
        b"spending rule".to_string(),
        STAFF,
        option::some(ALLOWANCE_CAP),
        option::none(),
        option::some(std::u64::max_value!()),
        option::none(),
        s.ctx(),
    );
    splash_spend::accept(proposal, &policy, s.ctx());
    ts::return_shared(policy);
    s.end();
}

#[test]
/// The required name is `splash-policy:` and the policy's id in hex, so the
/// dashboard can compute it before proposing.
fun the_allowance_name_is_the_policy_id() {
    let (mut s, fx) = setup();
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(fx.policy);
        let mut expected = b"splash-policy:".to_string();
        expected.append(fx.policy.to_address().to_string());
        assert_eq!(splash_spend::allowance_name(&policy), expected);
        ts::return_shared(policy);
    };
    s.end();
}

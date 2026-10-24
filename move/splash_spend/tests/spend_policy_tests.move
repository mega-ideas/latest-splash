/// `spend_policy` and `splash_spend::accept`, written from the spec
/// (docs/v2/phase1-move-design.md section 5, revision 2), not from the code.
///
/// The policy is the business's own rulebook for spending under its
/// allowances: who may spend, where, how much, and above what amount a second
/// owner must approve. The spec promises three things about it. Only the
/// business wallet, the owners' multisig, can change it. There is exactly one
/// per account and wallet generation, so a spender cannot pick a looser one
/// and a rotation leaves the old one behind. And a spending rule (an
/// app-bound allowance) is issued only for a spender the policy lists, funded
/// by the policy's wallet, in the policy's asset. Each test pins one piece of
/// that promise, including the things the spec says must be impossible.
///
/// Move tests do not check signatures: a test acts as a multisig by sending as
/// its address, which is exactly what the code under test asserts against.
#[test_only]
#[allow(implicit_const_copy)]
module splash_spend::spend_policy_tests;

use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::multisig;
use splash_core::payment_intent;
use splash_core::v2_harness::{Self as h, USDC};
use splash_spend::spend_policy::{Self, PolicyChanged, PolicyCreated, PolicyRegistry, SpendPolicy};
use splash_spend::splash_spend::{Self, SettleWitness, SpendingRuleAccepted, SPLASH_SPEND};
use std::type_name;
use std::unit_test::assert_eq;
use sui::allowance::{Self, Allowance, AllowanceCap, AllowanceProposal};
use sui::balance::Balance;
use sui::clock::Clock;
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

/// A second coin type. The policy pays in USDC only (D6), so a rule in this
/// type must never be issued.
public struct USDT has drop {}

/// Some other app's allowance type. A proposal bound to it is not a Splash
/// spending rule.
public struct OTHER_APP() has drop;

const STAFF: address = @0x57AFF;
const STAFF_2: address = @0x57AFF2;
/// Splash's KMS operator.
const EXECUTOR: address = @0xE8EC;
const STRANGER: address = @0xBAD;
const SUPPLIER: address = @0x5099;
/// A payout partner's deposit address on Sui.
const PARTNER: address = @0xDE90;
const OTHER_PARTNER: address = @0xDE91;
/// An account owner who is not a member of the wallet.
const FOURTH_OWNER: address = @0xF04;

/// 50,000 USDC.
const POLICY_MAX: u64 = 50_000_000_000;
/// 2,000 USDC.
const STAFF_MAX: u64 = 2_000_000_000;
/// D2: 10,000 USDC in minor units (6 decimals).
const TEN_THOUSAND_USDC: u64 = 10_000_000_000;

/// CCTP domains.
const SUI: u32 = 8;
const ETHEREUM: u32 = 0;
const SOLANA: u32 = 5;

const BENEFICIARY_A: vector<u8> = x"a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const BENEFICIARY_B: vector<u8> = x"b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const SHORT_COMMITMENT: vector<u8> = x"c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const LONG_COMMITMENT: vector<u8> = x"d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4";

/// The spending rule's own limits: 1,000 USDC for life, 31 days.
const RULE_CAP: u256 = 1_000_000_000;
const RULE_EXPIRY_MS: u64 = 2_678_400_000;

/// Weights for a 2-of-2.
const THRESHOLD_B: u16 = 2;

// ─── Set-up ─────────────────────────────────────────────────────────────────

/// `v2_harness::setup()` (account, 2-of-3 wallet, config, clock), then the
/// `PolicyRegistry` shared as it is at publish.
fun begin(): Scenario {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    spend_policy::init_for_testing(s.ctx());
    s
}

/// `begin()`, then the wallet creates the policy. Returns its ID.
fun begin_with_policy(): (Scenario, ID) {
    let mut s = begin();
    let id = create(&mut s);
    (s, id)
}

/// The wallet creates the account's policy with its own keys.
fun create(s: &mut Scenario): ID {
    create_as(s, h::wallet(), h::keys(), h::weights(), h::threshold(), POLICY_MAX)
}

/// `sender` creates a USDC policy for the (only) account with these members.
fun create_as(
    s: &mut Scenario,
    sender: address,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
    per_payment_max: u64,
): ID {
    s.next_tx(sender);
    let mut registry = s.take_shared<PolicyRegistry>();
    let account = s.take_shared<BusinessAccount>();
    let id = spend_policy::create_policy<USDC>(
        &mut registry,
        &account,
        keys,
        weights,
        threshold,
        per_payment_max,
        s.ctx(),
    );
    ts::return_shared(account);
    ts::return_shared(registry);
    id
}

/// `sender` creates a USDC policy for the account `account_id`.
fun create_for(
    s: &mut Scenario,
    account_id: ID,
    sender: address,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
): ID {
    s.next_tx(sender);
    let mut registry = s.take_shared<PolicyRegistry>();
    let account = s.take_shared_by_id<BusinessAccount>(account_id);
    let id = spend_policy::create_policy<USDC>(
        &mut registry,
        &account,
        keys,
        weights,
        threshold,
        POLICY_MAX,
        s.ctx(),
    );
    ts::return_shared(account);
    ts::return_shared(registry);
    id
}

/// A second wallet whose members are owners: the 2-of-2 of passkeys 1 and 2.
fun keys_b(): vector<vector<u8>> { vector[h::passkey(0), h::passkey(1)] }
fun weights_b(): vector<u8> { vector[1, 1] }
fun wallet_b(): address { multisig::derive_address(&keys_b(), &weights_b(), THRESHOLD_B) }

/// `from` proposes the wallet these members derive, and it confirms itself.
/// Returns the new wallet.
fun rotate(s: &mut Scenario, from: address, keys: vector<vector<u8>>, weights: vector<u8>, threshold: u16): address {
    let to = multisig::derive_address(&keys, &weights, threshold);
    s.next_tx(from);
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::rotate_wallet(&mut account, keys, weights, threshold, false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(to);
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::confirm_wallet_rotation(&mut account, s.ctx());
        ts::return_shared(account);
    };
    to
}

/// The wallet rotates to `wallet_b()`.
fun rotate_to_b(s: &mut Scenario): address {
    rotate(s, h::wallet(), keys_b(), weights_b(), THRESHOLD_B)
}

/// A second business, founded by owner 3 with owner 2 added, whose own
/// 2-of-2 of passkeys 2 and 3 is registered. Returns (the first account's ID,
/// the second account's ID, the second account's wallet).
fun add_second_business(s: &mut Scenario): (ID, ID, address) {
    s.next_tx(h::owner_3());
    let first = {
        let account = s.take_shared<BusinessAccount>();
        let id = object::id(&account);
        ts::return_shared(account);
        id
    };
    {
        let c = s.take_shared<Clock>();
        business_account::submit_application(b"SSM-202402026789".to_string(), b"bafy-kyb-2".to_string(), &c, s.ctx());
        ts::return_shared(c);
    };
    let fx = s.next_tx(h::owner_3());
    // The application created exactly one object: the second account.
    let created = ts::created(&fx);
    assert_eq!(created.length(), 1);
    let second = created[0];
    let keys_c = vector[h::passkey(1), h::passkey(2)];
    let wallet_c = multisig::derive_address(&keys_c, &vector[1, 1], 2);
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(second);
        business_account::add_owner(&mut account, h::owner_2(), s.ctx());
        business_account::nominate_wallet(&mut account, wallet_c, false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(wallet_c);
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(second);
        business_account::register_wallet(&mut account, keys_c, vector[1, 1], 2, false, s.ctx());
        ts::return_shared(account);
    };
    (first, second, wallet_c)
}

/// Put `splash_spend`'s settlement witness on the settlement-app registry
/// through the 24-hour path, signed by a 3-of-3 governance multisig.
fun register_settle_witness(s: &mut Scenario) {
    let gov = multisig::derive_address(&h::keys(), &h::weights(), 3);
    s.next_tx(gov);
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
            3,
            &c,
            s.ctx(),
        );
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
    s.next_tx(gov);
    {
        let mut c = s.take_shared<Clock>();
        c.increment_for_testing(h::day());
        let mut config = s.take_shared<ComplianceConfig>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::activate_addition<SettleWitness>(
            &admin,
            &mut config,
            compliance_config::registry_settlement_app(),
            h::keys(),
            h::weights(),
            3,
            &c,
            s.ctx(),
        );
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
        ts::return_shared(c);
    };
}

// ─── Mutations, as a given sender ──────────────────────────────────────────

fun add_spender_as(s: &mut Scenario, id: ID, sender: address, spender: address, role: u8, max: u64) {
    s.next_tx(sender);
    let mut policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::add_spender(&mut policy, spender, role, max, s.ctx());
    ts::return_shared(policy);
}

fun remove_spender_as(s: &mut Scenario, id: ID, sender: address, spender: address) {
    s.next_tx(sender);
    let mut policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::remove_spender(&mut policy, spender, s.ctx());
    ts::return_shared(policy);
}

/// `sender` verifies `addr` on `domain` as a wallet recipient (kind 3).
fun verify_recipient_as(s: &mut Scenario, id: ID, sender: address, domain: u32, addr: address) {
    verify_recipient_kind_as(s, id, sender, domain, addr, payment_intent::kind_wallet());
}

fun verify_recipient_kind_as(s: &mut Scenario, id: ID, sender: address, domain: u32, addr: address, kind: u8) {
    s.next_tx(sender);
    let mut policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::verify_recipient(&mut policy, domain, addr, kind, s.ctx());
    ts::return_shared(policy);
}

fun remove_recipient_as(s: &mut Scenario, id: ID, sender: address, domain: u32, addr: address) {
    s.next_tx(sender);
    let mut policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::remove_recipient(&mut policy, domain, addr, s.ctx());
    ts::return_shared(policy);
}

fun verify_beneficiary_as(s: &mut Scenario, id: ID, sender: address, commitment: vector<u8>, partner: address) {
    s.next_tx(sender);
    let mut policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::verify_beneficiary(&mut policy, commitment, partner, s.ctx());
    ts::return_shared(policy);
}

fun remove_beneficiary_as(s: &mut Scenario, id: ID, sender: address, commitment: vector<u8>) {
    s.next_tx(sender);
    let mut policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::remove_beneficiary(&mut policy, commitment, s.ctx());
    ts::return_shared(policy);
}

fun set_limits_as(s: &mut Scenario, id: ID, sender: address, per_payment_max: u64, threshold: u64) {
    s.next_tx(sender);
    let mut policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::set_limits(&mut policy, per_payment_max, threshold, s.ctx());
    ts::return_shared(policy);
}

/// The wallet lists STAFF (staff, 2,000 USDC) and EXECUTOR (executor, 50,000).
fun staff_up(s: &mut Scenario, id: ID, wallet: address) {
    add_spender_as(s, id, wallet, STAFF, spend_policy::role_staff(), STAFF_MAX);
    add_spender_as(s, id, wallet, EXECUTOR, spend_policy::role_executor(), POLICY_MAX);
}

/// Distinct, non-zero spender addresses for filling the list.
fun filler(i: u64): address { sui::address::from_u256(0x10000 + (i as u256)) }

/// The wallet adds `n` staff spenders in one transaction.
fun fill_spenders(s: &mut Scenario, id: ID, n: u64) {
    s.next_tx(h::wallet());
    let mut policy = s.take_shared_by_id<SpendPolicy>(id);
    let mut i = 0;
    while (i < n) {
        spend_policy::add_spender(&mut policy, filler(i), spend_policy::role_staff(), STAFF_MAX, s.ctx());
        i = i + 1;
    };
    ts::return_shared(policy);
}

// ─── Spending rules ────────────────────────────────────────────────────────

/// A Splash spending rule for `spender`, in `T`, funded by the sender.
fun propose<T>(spender: address, name: std::string::String, ctx: &TxContext): AllowanceProposal<Balance<T>> {
    allowance::propose_for_app<Balance<T>, SPLASH_SPEND>(
        name,
        spender,
        option::some(RULE_CAP),
        option::none(),
        option::some(RULE_EXPIRY_MS),
        option::none(),
        ctx,
    )
}

/// `funder` proposes a USDC rule for `spender` and accepts it under the
/// policy `id`, in one transaction, as the spec requires.
fun accept_as(s: &mut Scenario, id: ID, funder: address, spender: address) {
    s.next_tx(funder);
    let policy = s.take_shared_by_id<SpendPolicy>(id);
    let proposal = propose<USDC>(spender, splash_spend::allowance_name(&policy), s.ctx());
    splash_spend::accept(proposal, &policy, s.ctx());
    ts::return_shared(policy);
}

/// STAFF opens a 100 USDC bank payout under the policy `id`, to the harness
/// beneficiary at the harness recipient, and cancels it again.
fun staff_opens_intent(s: &mut Scenario, id: ID) {
    s.next_tx(STAFF);
    let policy = s.take_shared_by_id<SpendPolicy>(id);
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let intent = splash_spend::create_intent<USDC>(
        &policy,
        &mut account,
        &config,
        h::payment_ref(1),
        h::recipient(),
        h::beneficiary(),
        h::amount(),
        b"PHP".to_string(),
        56_000_000,
        h::commitment(),
        payment_intent::kind_bank_payout(),
        h::rail(),
        h::settle_by(&c),
        &c,
        s.ctx(),
    );
    assert_eq!(payment_intent::sender(&intent), STAFF);
    payment_intent::cancel(intent, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    ts::return_shared(policy);
}

/// A policy with STAFF listed and the harness beneficiary bound to the
/// harness recipient: everything `staff_opens_intent` needs except currency.
fun ready_for_staff(s: &mut Scenario, id: ID) {
    add_spender_as(s, id, h::wallet(), STAFF, spend_policy::role_staff(), STAFF_MAX);
    verify_beneficiary_as(s, id, h::wallet(), h::beneficiary(), h::recipient());
}

// ════════════════════════════════════════════════════════════════════════════
// Creation
// ════════════════════════════════════════════════════════════════════════════

#[test]
/// The policy copies in what it is: the account, the wallet that created it,
/// the wallet generation, the asset it pays in, and the owners derived from
/// the keys that derive the wallet. Nothing is listed yet, and the limits are
/// the ones given plus the D2 default threshold. The ID returned is the
/// shared object's, and one `PolicyCreated` is emitted.
fun create_policy_records_wallet_generation_asset_and_owners() {
    let mut s = begin();
    s.next_tx(h::wallet());
    let id = {
        let mut registry = s.take_shared<PolicyRegistry>();
        let account = s.take_shared<BusinessAccount>();
        let before = event::events_by_type<PolicyCreated>().length();
        let id = spend_policy::create_policy<USDC>(
            &mut registry,
            &account,
            h::keys(),
            h::weights(),
            h::threshold(),
            POLICY_MAX,
            s.ctx(),
        );
        assert_eq!(event::events_by_type<PolicyCreated>().length(), before + 1);
        ts::return_shared(account);
        ts::return_shared(registry);
        id
    };
    s.next_tx(STRANGER);
    {
        let account = s.take_shared<BusinessAccount>();
        let policy = s.take_shared<SpendPolicy>();
        assert_eq!(object::id(&policy), id);
        assert_eq!(spend_policy::account(&policy), object::id(&account));
        assert_eq!(spend_policy::wallet(&policy), h::wallet());
        assert_eq!(spend_policy::wallet_epoch(&policy), business_account::wallet_epoch(&account));
        assert_eq!(spend_policy::wallet_epoch(&policy), 1);
        assert_eq!(spend_policy::asset(&policy), compliance_config::type_string<USDC>());
        assert_eq!(spend_policy::owners(&policy), vector[h::owner_1(), h::owner_2(), h::owner_3()]);
        assert!(spend_policy::is_owner(&policy, h::owner_1()));
        assert!(spend_policy::is_owner(&policy, h::owner_2()));
        assert!(spend_policy::is_owner(&policy, h::owner_3()));
        // The wallet itself is not one of its members.
        assert!(!spend_policy::is_owner(&policy, h::wallet()));
        assert!(!spend_policy::is_owner(&policy, STRANGER));
        assert_eq!(spend_policy::per_payment_max(&policy), POLICY_MAX);
        assert_eq!(spend_policy::spender_count(&policy), 0);
        assert_eq!(spend_policy::recipient_count(&policy), 0);
        assert_eq!(spend_policy::beneficiary_count(&policy), 0);
        ts::return_shared(policy);
        ts::return_shared(account);
    };
    s.end();
}

#[test]
/// D2: above 10,000 USDC a payment needs a second owner approval, unless the
/// owners change it. A new policy must start at exactly that, in USDC minor
/// units, not at zero (every payment) or at the maximum (none).
fun default_second_approval_threshold_is_ten_thousand_usdc() {
    let (mut s, id) = begin_with_policy();
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::second_approval_threshold(&policy), TEN_THOUSAND_USDC);
        assert_eq!(spend_policy::default_second_approval_threshold(), 10_000_000_000);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
/// Who may give a second approval is the wallet's members, derived from the
/// keys, not whoever is an account owner. An owner who is not a signer is not
/// a policy owner, before or after creation: the list is copied in once and
/// never read back from core's mutable state.
fun owners_come_from_the_wallet_keys_not_from_the_account() {
    let mut s = begin();
    // Once the wallet is registered, the wallet adds owners.
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::add_owner(&mut account, FOURTH_OWNER, s.ctx());
        ts::return_shared(account);
    };
    let id = create(&mut s);
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::add_owner(&mut account, STRANGER, s.ctx());
        assert!(business_account::is_owner(&account, FOURTH_OWNER));
        ts::return_shared(account);
    };
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::owners(&policy).length(), 3);
        assert!(!spend_policy::is_owner(&policy, FOURTH_OWNER));
        assert!(!spend_policy::is_owner(&policy, STRANGER));
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_WALLET_MISMATCH)]
/// The same members in another order derive another address. Keys that do not
/// derive the sender must not be accepted as the wallet's members, or the
/// owner list could be anything.
fun create_policy_with_keys_in_the_wrong_order_aborts() {
    let mut s = begin();
    let reordered = vector[h::passkey(1), h::passkey(0), h::passkey(2)];
    create_as(&mut s, h::wallet(), reordered, h::weights(), h::threshold(), POLICY_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_WALLET_MISMATCH)]
/// The threshold is part of the wallet's identity too: a 3-of-3 of the right
/// keys is not the 2-of-3 that signed.
fun create_policy_with_the_wrong_threshold_aborts() {
    let mut s = begin();
    create_as(&mut s, h::wallet(), h::keys(), h::weights(), 3, POLICY_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_WALLET_MISMATCH)]
/// One owner (here the founder) presenting the wallet's real keys is still
/// one key. Only the multisig itself may create the policy.
fun create_policy_by_an_owner_alone_aborts() {
    let mut s = begin();
    create_as(&mut s, h::owner_1(), h::keys(), h::weights(), h::threshold(), POLICY_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_WALLET_MISMATCH)]
/// A genuine multisig of two owners, whose keys derive the sender, is still
/// not the account's registered wallet. Deriving the sender is not enough.
fun create_policy_by_an_unregistered_multisig_of_owners_aborts() {
    let mut s = begin();
    create_as(&mut s, wallet_b(), keys_b(), weights_b(), THRESHOLD_B, POLICY_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_WALLET_MISMATCH)]
/// The founder's nomination is not a registration: until the wallet has
/// registered itself, the account has no wallet and no policy can exist.
fun create_policy_for_an_account_with_no_wallet_aborts() {
    let mut s = h::setup_without_wallet();
    s.next_tx(h::owner_1());
    spend_policy::init_for_testing(s.ctx());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::nominate_wallet(&mut account, h::wallet(), false, s.ctx());
        ts::return_shared(account);
    };
    create(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_WALLET_MISMATCH)]
/// A proposed rotation is not yet the wallet. The pending wallet must not be
/// able to claim the current generation's one policy before it confirms.
fun pending_rotation_wallet_cannot_create_a_policy() {
    let mut s = begin();
    s.next_tx(h::wallet());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::rotate_wallet(&mut account, keys_b(), weights_b(), THRESHOLD_B, false, s.ctx());
        ts::return_shared(account);
    };
    create_as(&mut s, wallet_b(), keys_b(), weights_b(), THRESHOLD_B, POLICY_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_BAD_LIMIT)]
/// A per-payment maximum of zero would refuse every payment; it is refused.
fun create_policy_with_zero_per_payment_max_aborts() {
    let mut s = begin();
    create_as(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), 0);
    s.end();
}

#[test]
/// The boundary: one minor unit is the smallest allowed maximum.
fun create_policy_with_one_unit_per_payment_max_succeeds() {
    let mut s = begin();
    let id = create_as(&mut s, h::wallet(), h::keys(), h::weights(), h::threshold(), 1);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::per_payment_max(&policy), 1);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = sui::derived_object::EObjectAlreadyExists)]
/// One policy per account and wallet generation. A second one would let a
/// spender listed on both pick the looser, and a "replaced" policy would stay
/// live.
fun second_policy_for_the_same_generation_aborts() {
    let (mut s, _) = begin_with_policy();
    create(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = sui::derived_object::EObjectAlreadyExists)]
/// Changing the asset or the limits does not make a second policy a different
/// one: the slot is the (account, generation), whatever the policy says.
fun second_policy_in_another_asset_for_the_same_generation_aborts() {
    let (mut s, _) = begin_with_policy();
    s.next_tx(h::wallet());
    let mut registry = s.take_shared<PolicyRegistry>();
    let account = s.take_shared<BusinessAccount>();
    spend_policy::create_policy<USDT>(
        &mut registry,
        &account,
        h::keys(),
        h::weights(),
        h::threshold(),
        POLICY_MAX * 2,
        s.ctx(),
    );
    ts::return_shared(account);
    ts::return_shared(registry);
    s.end();
}

#[test]
#[expected_failure(abort_code = 1063, location = spend_policy)]
/// Review A4: the asset is fixed at creation, and the (account, generation)
/// slot is single-use. A policy in a coin type the compliance config does
/// not accept would make spending rules impossible for the whole wallet
/// generation, so it is refused before the slot is claimed.
fun a_policy_in_an_asset_the_config_does_not_accept_cannot_be_created() {
    let mut s = begin();
    s.next_tx(h::wallet());
    let mut registry = s.take_shared<PolicyRegistry>();
    let account = s.take_shared<BusinessAccount>();
    spend_policy::create_policy<USDT>(
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
    s.end();
}

#[test]
/// The slot is per account: two businesses in their first wallet generation
/// each get their own policy, bound to their own account and wallet.
fun each_account_has_its_own_policy_for_the_same_generation() {
    let mut s = begin();
    let (first, second, wallet_c) = add_second_business(&mut s);
    let p1 = create_for(&mut s, first, h::wallet(), h::keys(), h::weights(), h::threshold());
    let p2 = create_for(&mut s, second, wallet_c, vector[h::passkey(1), h::passkey(2)], vector[1, 1], 2);
    assert!(p1 != p2);
    s.next_tx(STRANGER);
    {
        let a = s.take_shared_by_id<SpendPolicy>(p1);
        let b = s.take_shared_by_id<SpendPolicy>(p2);
        assert_eq!(spend_policy::account(&a), first);
        assert_eq!(spend_policy::account(&b), second);
        assert_eq!(spend_policy::wallet_epoch(&a), 1);
        assert_eq!(spend_policy::wallet_epoch(&b), 1);
        assert_eq!(spend_policy::wallet(&b), wallet_c);
        assert_eq!(spend_policy::owners(&b), vector[h::owner_2(), h::owner_3()]);
        ts::return_shared(b);
        ts::return_shared(a);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_WALLET_MISMATCH)]
/// One business's wallet cannot create (and so squat on) another business's
/// policy, even with its own valid keys.
fun wallet_cannot_create_a_policy_for_another_account() {
    let mut s = begin();
    let (_, second, _) = add_second_business(&mut s);
    create_for(&mut s, second, h::wallet(), h::keys(), h::weights(), h::threshold());
    s.end();
}

// ════════════════════════════════════════════════════════════════════════════
// Wallet rotation
// ════════════════════════════════════════════════════════════════════════════

#[test]
/// A rotation moves the account to a new generation, so the new wallet can
/// create its own policy, with owners derived from ITS keys. The old policy
/// is left exactly as it was and no longer matches the account.
fun rotation_lets_the_new_wallet_create_a_new_policy() {
    let (mut s, old_id) = begin_with_policy();
    let b = rotate_to_b(&mut s);
    let new_id = create_as(&mut s, b, keys_b(), weights_b(), THRESHOLD_B, POLICY_MAX);
    assert!(new_id != old_id);
    s.next_tx(STRANGER);
    {
        let account = s.take_shared<BusinessAccount>();
        let old = s.take_shared_by_id<SpendPolicy>(old_id);
        let current = s.take_shared_by_id<SpendPolicy>(new_id);
        assert_eq!(business_account::wallet_epoch(&account), 2);
        assert_eq!(spend_policy::wallet(&current), b);
        assert_eq!(spend_policy::wallet_epoch(&current), 2);
        assert_eq!(spend_policy::account(&current), object::id(&account));
        assert_eq!(spend_policy::owners(&current), vector[h::owner_1(), h::owner_2()]);
        assert!(!spend_policy::is_owner(&current, h::owner_3()));
        // The old one is stale: wrong wallet, wrong generation.
        assert_eq!(spend_policy::wallet(&old), h::wallet());
        assert_eq!(spend_policy::wallet_epoch(&old), 1);
        assert!(spend_policy::wallet(&old) != business_account::wallet(&account));
        assert!(spend_policy::wallet_epoch(&old) != business_account::wallet_epoch(&account));
        ts::return_shared(current);
        ts::return_shared(old);
        ts::return_shared(account);
    };
    s.end();
}

#[test]
/// Rotating A to B and back to A gives the old address back, but not the old
/// rules: A creates a fresh policy for generation 3, with none of the
/// spenders, recipients or beneficiaries it had in generation 1.
fun rotating_back_gives_the_old_address_a_fresh_policy() {
    let (mut s, first_id) = begin_with_policy();
    staff_up(&mut s, first_id, h::wallet());
    verify_recipient_as(&mut s, first_id, h::wallet(), SUI, SUPPLIER);
    verify_beneficiary_as(&mut s, first_id, h::wallet(), BENEFICIARY_A, PARTNER);
    let b = rotate_to_b(&mut s);
    rotate(&mut s, b, h::keys(), h::weights(), h::threshold());
    let third_id = create(&mut s);
    assert!(third_id != first_id);
    s.next_tx(STRANGER);
    {
        let account = s.take_shared<BusinessAccount>();
        let first = s.take_shared_by_id<SpendPolicy>(first_id);
        let third = s.take_shared_by_id<SpendPolicy>(third_id);
        assert_eq!(business_account::wallet(&account), h::wallet());
        assert_eq!(business_account::wallet_epoch(&account), 3);
        assert_eq!(spend_policy::wallet(&third), h::wallet());
        assert_eq!(spend_policy::wallet_epoch(&third), 3);
        assert!(!spend_policy::is_spender(&third, STAFF));
        assert!(!spend_policy::is_spender(&third, EXECUTOR));
        assert!(!spend_policy::is_recipient_verified(&third, SUI, SUPPLIER));
        assert!(!spend_policy::is_beneficiary_bound_to(&third, BENEFICIARY_A, PARTNER));
        assert_eq!(spend_policy::spender_count(&third), 0);
        // Same address, old generation: still stale.
        assert_eq!(spend_policy::wallet(&first), business_account::wallet(&account));
        assert_eq!(spend_policy::wallet_epoch(&first), 1);
        ts::return_shared(third);
        ts::return_shared(first);
        ts::return_shared(account);
    };
    s.end();
}

#[test]
/// The control for the two stale-policy tests below: under the CURRENT
/// policy, a listed staff member opens a bank payout to a bound beneficiary.
fun current_policy_lets_staff_open_an_intent() {
    let (mut s, id) = begin_with_policy();
    register_settle_witness(&mut s);
    ready_for_staff(&mut s, id);
    staff_opens_intent(&mut s, id);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_STALE_POLICY)]
/// After a rotation the old policy stops working, even with its staff and
/// beneficiary still listed. Otherwise rotating away from a compromised
/// signer would leave every rule it set up alive.
fun stale_policy_after_rotation_cannot_open_intents() {
    let (mut s, id) = begin_with_policy();
    register_settle_witness(&mut s);
    ready_for_staff(&mut s, id);
    rotate_to_b(&mut s);
    staff_opens_intent(&mut s, id);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_STALE_POLICY)]
/// R2: rotating A to B and back to A must not revive A's generation-1 policy,
/// although its wallet address matches the account's again.
fun rotating_back_does_not_revive_the_old_policy() {
    let (mut s, id) = begin_with_policy();
    register_settle_witness(&mut s);
    ready_for_staff(&mut s, id);
    let b = rotate_to_b(&mut s);
    rotate(&mut s, b, h::keys(), h::weights(), h::threshold());
    staff_opens_intent(&mut s, id);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// The wallet the business rotated away from (say, because a signer was
/// compromised) must not be able to change the new wallet's policy.
fun old_wallet_cannot_change_the_new_policy() {
    let (mut s, _) = begin_with_policy();
    let b = rotate_to_b(&mut s);
    let new_id = create_as(&mut s, b, keys_b(), weights_b(), THRESHOLD_B, POLICY_MAX);
    add_spender_as(&mut s, new_id, h::wallet(), STRANGER, spend_policy::role_staff(), POLICY_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_PROPOSAL_FUNDER)]
/// The new policy refuses a spending rule funded by the old wallet, even for
/// a spender it lists: its rules spend the new wallet's money only.
fun new_policy_refuses_a_rule_funded_by_the_old_wallet() {
    let (mut s, _) = begin_with_policy();
    let b = rotate_to_b(&mut s);
    let new_id = create_as(&mut s, b, keys_b(), weights_b(), THRESHOLD_B, POLICY_MAX);
    add_spender_as(&mut s, new_id, b, STAFF, spend_policy::role_staff(), STAFF_MAX);
    accept_as(&mut s, new_id, h::wallet(), STAFF);
    s.end();
}

// ════════════════════════════════════════════════════════════════════════════
// Every mutation is the wallet's alone
// ════════════════════════════════════════════════════════════════════════════

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// The founder alone cannot add a spender: who may spend is an owners'
/// decision, made by the multisig.
fun add_spender_by_the_founder_alone_aborts() {
    let (mut s, id) = begin_with_policy();
    add_spender_as(&mut s, id, h::owner_1(), STAFF, spend_policy::role_staff(), STAFF_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// A staff spender cannot list an accomplice.
fun add_spender_by_a_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    add_spender_as(&mut s, id, STAFF, STAFF_2, spend_policy::role_staff(), POLICY_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// One owner cannot remove a spender on their own either: removal is a policy
/// change like any other.
fun remove_spender_by_an_owner_alone_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    remove_spender_as(&mut s, id, h::owner_2(), STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// A stranger cannot strip the business's spenders.
fun remove_spender_by_a_stranger_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    remove_spender_as(&mut s, id, STRANGER, STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// D11: the verified-recipient list is changed only by the business
/// multisig, never by one owner.
fun verify_recipient_by_an_owner_alone_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::owner_3(), SUI, SUPPLIER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// Splash's operator, an executor on the policy, cannot add a destination.
/// If it could, a stolen operator key could pay itself.
fun verify_recipient_by_the_executor_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    verify_recipient_as(&mut s, id, EXECUTOR, SUI, EXECUTOR);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// Removing a verified recipient is a policy change; one owner cannot do it.
fun remove_recipient_by_an_owner_alone_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::wallet(), SUI, SUPPLIER);
    remove_recipient_as(&mut s, id, h::owner_1(), SUI, SUPPLIER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// A stranger cannot cut off the business's suppliers.
fun remove_recipient_by_a_stranger_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::wallet(), SUI, SUPPLIER);
    remove_recipient_as(&mut s, id, STRANGER, SUI, SUPPLIER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// Binding a bank beneficiary to a partner address is the multisig's act,
/// not one owner's.
fun verify_beneficiary_by_an_owner_alone_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::owner_2(), BENEFICIARY_A, PARTNER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// A staff spender cannot bind a beneficiary of their own choosing.
fun verify_beneficiary_by_a_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    verify_beneficiary_as(&mut s, id, STAFF, BENEFICIARY_A, STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// Unbinding a beneficiary is a policy change; one owner cannot do it.
fun remove_beneficiary_by_an_owner_alone_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, PARTNER);
    remove_beneficiary_as(&mut s, id, h::owner_3(), BENEFICIARY_A);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// A stranger cannot unbind the business's beneficiaries.
fun remove_beneficiary_by_a_stranger_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, PARTNER);
    remove_beneficiary_as(&mut s, id, STRANGER, BENEFICIARY_A);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// D2: the second-approval threshold is editable by the owners, which means
/// by their multisig. One owner cannot raise it alone.
fun set_limits_by_an_owner_alone_aborts() {
    let (mut s, id) = begin_with_policy();
    set_limits_as(&mut s, id, h::owner_1(), POLICY_MAX, std::u64::max_value!());
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// A spender cannot raise their own ceiling or switch off the second
/// approval.
fun set_limits_by_a_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    set_limits_as(&mut s, id, STAFF, POLICY_MAX * 10, std::u64::max_value!());
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_THE_WALLET)]
/// A stranger cannot change the limits, up or down.
fun set_limits_by_a_stranger_aborts() {
    let (mut s, id) = begin_with_policy();
    set_limits_as(&mut s, id, STRANGER, 1, 0);
    s.end();
}

// ════════════════════════════════════════════════════════════════════════════
// Spenders
// ════════════════════════════════════════════════════════════════════════════

#[test]
/// A spender is STAFF (opens and pays) or EXECUTOR (only pays), never both,
/// each with its own per-payment ceiling. Being an owner, or the wallet, does
/// not make an address a spender.
fun roles_are_staff_or_executor() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert!(spend_policy::role_staff() != spend_policy::role_executor());
        assert!(spend_policy::is_spender(&policy, STAFF));
        assert!(spend_policy::is_staff(&policy, STAFF));
        assert!(!spend_policy::is_executor(&policy, STAFF));
        assert!(spend_policy::is_spender(&policy, EXECUTOR));
        assert!(spend_policy::is_executor(&policy, EXECUTOR));
        assert!(!spend_policy::is_staff(&policy, EXECUTOR));
        assert!(!spend_policy::is_spender(&policy, STRANGER));
        assert!(!spend_policy::is_staff(&policy, STRANGER));
        assert!(!spend_policy::is_executor(&policy, STRANGER));
        assert!(!spend_policy::is_spender(&policy, h::owner_1()));
        assert!(!spend_policy::is_spender(&policy, h::wallet()));
        assert_eq!(spend_policy::spender_per_payment_max(&policy, STAFF), STAFF_MAX);
        assert_eq!(spend_policy::spender_per_payment_max(&policy, EXECUTOR), POLICY_MAX);
        assert_eq!(spend_policy::spender_count(&policy), 2);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
/// Removing a spender takes them off at once, and the slot is free: the same
/// address can come back later, in another role.
fun remove_spender_then_add_back_in_another_role() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    remove_spender_as(&mut s, id, h::wallet(), STAFF);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert!(!spend_policy::is_spender(&policy, STAFF));
        assert!(!spend_policy::is_staff(&policy, STAFF));
        assert!(spend_policy::is_executor(&policy, EXECUTOR));
        assert_eq!(spend_policy::spender_count(&policy), 1);
        ts::return_shared(policy);
    };
    add_spender_as(&mut s, id, h::wallet(), STAFF, spend_policy::role_executor(), 1);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert!(spend_policy::is_executor(&policy, STAFF));
        assert!(!spend_policy::is_staff(&policy, STAFF));
        assert_eq!(spend_policy::spender_per_payment_max(&policy, STAFF), 1);
        assert_eq!(spend_policy::spender_count(&policy), 2);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_A_SPENDER)]
/// Removing an address that is not a spender is an error, not a silent no-op
/// that would let the dashboard believe a removal happened.
fun remove_spender_who_is_not_listed_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    remove_spender_as(&mut s, id, h::wallet(), STRANGER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_A_SPENDER)]
/// A non-spender has no ceiling: asking for one aborts rather than returning
/// zero or the policy's maximum.
fun spender_ceiling_of_a_non_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    s.next_tx(STRANGER);
    let policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::spender_per_payment_max(&policy, STRANGER);
    ts::return_shared(policy);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_INVALID_ADDRESS)]
/// The zero address is nobody; listing it is refused.
fun add_spender_zero_address_aborts() {
    let (mut s, id) = begin_with_policy();
    add_spender_as(&mut s, id, h::wallet(), @0x0, spend_policy::role_staff(), STAFF_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_INVALID_ADDRESS)]
/// The wallet pays through its own path. Listed as a spender it would be
/// treated as staff under its own policy; refused.
fun add_spender_the_wallet_itself_aborts() {
    let (mut s, id) = begin_with_policy();
    add_spender_as(&mut s, id, h::wallet(), h::wallet(), spend_policy::role_staff(), STAFF_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_UNKNOWN_ROLE)]
/// Role 0 is neither STAFF nor EXECUTOR.
fun add_spender_role_zero_aborts() {
    let (mut s, id) = begin_with_policy();
    add_spender_as(&mut s, id, h::wallet(), STAFF, 0, STAFF_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_UNKNOWN_ROLE)]
/// Role 3, one past EXECUTOR, is unknown. An unknown role would be a spender
/// that is neither staff nor executor, which no check below expects.
fun add_spender_role_three_aborts() {
    let (mut s, id) = begin_with_policy();
    add_spender_as(&mut s, id, h::wallet(), STAFF, 3, STAFF_MAX);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_BAD_LIMIT)]
/// A spender whose ceiling is zero could never pay; refused.
fun add_spender_zero_per_payment_max_aborts() {
    let (mut s, id) = begin_with_policy();
    add_spender_as(&mut s, id, h::wallet(), STAFF, spend_policy::role_staff(), 0);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_ALREADY_A_SPENDER)]
/// Adding an existing spender again, even in another role with another
/// ceiling, must not quietly change their role or limit. Change is remove
/// then add.
fun add_spender_twice_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    add_spender_as(&mut s, id, h::wallet(), STAFF, spend_policy::role_executor(), POLICY_MAX);
    s.end();
}

#[test]
/// The boundary: exactly 64 spenders fit.
fun sixty_four_spenders_fit() {
    let (mut s, id) = begin_with_policy();
    assert_eq!(spend_policy::max_spenders(), 64);
    fill_spenders(&mut s, id, 64);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::spender_count(&policy), 64);
        assert!(spend_policy::is_staff(&policy, filler(0)));
        assert!(spend_policy::is_staff(&policy, filler(63)));
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_TOO_MANY_SPENDERS)]
/// One over: the 65th spender is refused, so the list stays bounded.
fun sixty_fifth_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    fill_spenders(&mut s, id, 64);
    add_spender_as(&mut s, id, h::wallet(), STAFF, spend_policy::role_staff(), STAFF_MAX);
    s.end();
}

#[test]
/// The cap counts current spenders, not additions ever made: at 64, removing
/// one frees a place.
fun removing_a_spender_at_the_cap_frees_a_place() {
    let (mut s, id) = begin_with_policy();
    fill_spenders(&mut s, id, 64);
    remove_spender_as(&mut s, id, h::wallet(), filler(10));
    add_spender_as(&mut s, id, h::wallet(), STAFF, spend_policy::role_staff(), STAFF_MAX);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::spender_count(&policy), 64);
        assert!(spend_policy::is_staff(&policy, STAFF));
        assert!(!spend_policy::is_spender(&policy, filler(10)));
        ts::return_shared(policy);
    };
    s.end();
}

// ════════════════════════════════════════════════════════════════════════════
// Recipients (kinds 2-3, on Sui)
// ════════════════════════════════════════════════════════════════════════════

#[test]
/// A recipient is a destination: a CCTP domain AND an address, and only Sui
/// (8) can be verified. Verifying an address on Sui verifies nothing on
/// Solana or Ethereum, and removing it leaves the list empty.
fun recipients_are_keyed_by_domain_and_address_on_sui_only() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::wallet(), SUI, SUPPLIER);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert!(spend_policy::is_recipient_verified(&policy, SUI, SUPPLIER));
        assert!(!spend_policy::is_recipient_verified(&policy, SOLANA, SUPPLIER));
        assert!(!spend_policy::is_recipient_verified(&policy, ETHEREUM, SUPPLIER));
        assert!(!spend_policy::is_recipient_verified(&policy, SUI, STRANGER));
        assert_eq!(spend_policy::recipient_count(&policy), 1);
        ts::return_shared(policy);
    };
    remove_recipient_as(&mut s, id, h::wallet(), SUI, SUPPLIER);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert!(!spend_policy::is_recipient_verified(&policy, SUI, SUPPLIER));
        assert_eq!(spend_policy::recipient_count(&policy), 0);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_ON_SUI)]
/// Review A2-A4: a spending rule pays only on Sui. A recipient on another
/// chain could only be paid by handing the business's raw coin to the
/// spender's transaction, so the policy refuses to verify one at all.
/// Cross-chain payments stay on the owners' multisig.
fun a_recipient_on_another_domain_cannot_be_verified() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::wallet(), ETHEREUM, SUPPLIER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_ON_SUI)]
/// Solana neither.
fun a_recipient_on_solana_cannot_be_verified() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::wallet(), SOLANA, SUPPLIER);
    s.end();
}

#[test]
/// Review A1/A3/A10: the owners choose how a recipient is paid when they
/// verify it, and the policy records it: a Splash business (2), credited to
/// its address balance, or a wallet (3), sent a Coin.
fun verify_recipient_records_the_kind_the_owners_chose() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_kind_as(&mut s, id, h::wallet(), SUI, SUPPLIER, payment_intent::kind_wallet());
    verify_recipient_kind_as(&mut s, id, h::wallet(), SUI, PARTNER, payment_intent::kind_splash_business());
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::recipient_kind(&policy, SUI, SUPPLIER), payment_intent::kind_wallet());
        assert_eq!(spend_policy::recipient_kind(&policy, SUI, PARTNER), payment_intent::kind_splash_business());
        assert_eq!(spend_policy::recipient_count(&policy), 2);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_ALREADY_VERIFIED)]
/// One address, one kind: it cannot be verified a second time under the
/// other kind, which would let a spender pick again. Changing it is remove
/// then verify.
fun a_recipient_cannot_be_verified_under_a_second_kind() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_kind_as(&mut s, id, h::wallet(), SUI, SUPPLIER, payment_intent::kind_wallet());
    verify_recipient_kind_as(&mut s, id, h::wallet(), SUI, SUPPLIER, payment_intent::kind_splash_business());
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_BAD_KIND)]
/// A bank payout is not a plain recipient: its partner deposit address is
/// bound to a beneficiary with `verify_beneficiary`.
fun a_recipient_cannot_be_verified_as_a_bank_payout() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_kind_as(&mut s, id, h::wallet(), SUI, PARTNER, payment_intent::kind_bank_payout());
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_BAD_KIND)]
/// Nor as a cross-chain wallet, which no spending rule pays.
fun a_recipient_cannot_be_verified_as_cross_chain() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_kind_as(&mut s, id, h::wallet(), SUI, SUPPLIER, payment_intent::kind_cross_chain_wallet());
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_BAD_KIND)]
/// Zero is never a kind.
fun a_recipient_cannot_be_verified_as_kind_zero() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_kind_as(&mut s, id, h::wallet(), SUI, SUPPLIER, 0);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_VERIFIED)]
/// An address that is not verified has no kind: asking aborts rather than
/// answering with one.
fun the_kind_of_an_unverified_recipient_aborts() {
    let (mut s, id) = begin_with_policy();
    s.next_tx(STRANGER);
    let policy = s.take_shared_by_id<SpendPolicy>(id);
    spend_policy::recipient_kind(&policy, SUI, SUPPLIER);
    ts::return_shared(policy);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_ALREADY_VERIFIED)]
/// Verifying the same destination twice is refused, so the count stays true.
fun verify_recipient_twice_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::wallet(), SUI, SUPPLIER);
    verify_recipient_as(&mut s, id, h::wallet(), SUI, SUPPLIER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_INVALID_ADDRESS)]
/// The zero address is not a recipient on any domain.
fun verify_recipient_zero_address_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::wallet(), ETHEREUM, @0x0);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_VERIFIED)]
/// Removing the address on a domain it was never verified on is an error:
/// the wallet must not believe it removed the Sui entry when it did not.
fun remove_recipient_on_another_domain_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_recipient_as(&mut s, id, h::wallet(), SUI, SUPPLIER);
    remove_recipient_as(&mut s, id, h::wallet(), SOLANA, SUPPLIER);
    s.end();
}

// ════════════════════════════════════════════════════════════════════════════
// Beneficiaries (kind 1)
// ════════════════════════════════════════════════════════════════════════════

#[test]
/// R2: a bank beneficiary is bound to the ONE partner deposit address allowed
/// to receive its payouts. It is not bound to any other address, not even a
/// verified recipient, and the binding does not make the partner address a
/// verified wallet recipient either.
fun verify_beneficiary_binds_one_partner_address() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, PARTNER);
    verify_recipient_as(&mut s, id, h::wallet(), SUI, OTHER_PARTNER);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert!(spend_policy::is_beneficiary_bound_to(&policy, BENEFICIARY_A, PARTNER));
        assert!(!spend_policy::is_beneficiary_bound_to(&policy, BENEFICIARY_A, OTHER_PARTNER));
        assert!(!spend_policy::is_beneficiary_bound_to(&policy, BENEFICIARY_B, PARTNER));
        assert!(!spend_policy::is_recipient_verified(&policy, SUI, PARTNER));
        assert_eq!(spend_policy::beneficiary_count(&policy), 1);
        assert_eq!(spend_policy::recipient_count(&policy), 1);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_ALREADY_VERIFIED)]
/// A verified beneficiary cannot then be paired with another address: the
/// second binding is refused rather than added or overwriting the first.
fun verify_beneficiary_again_with_another_address_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, PARTNER);
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, OTHER_PARTNER);
    s.end();
}

#[test]
/// Moving a beneficiary to a new partner address is remove then verify, both
/// by the wallet, and afterwards only the new address is bound.
fun remove_then_verify_rebinds_a_beneficiary() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, PARTNER);
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_B, PARTNER);
    remove_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert!(!spend_policy::is_beneficiary_bound_to(&policy, BENEFICIARY_A, PARTNER));
        assert!(spend_policy::is_beneficiary_bound_to(&policy, BENEFICIARY_B, PARTNER));
        assert_eq!(spend_policy::beneficiary_count(&policy), 1);
        ts::return_shared(policy);
    };
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, OTHER_PARTNER);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert!(spend_policy::is_beneficiary_bound_to(&policy, BENEFICIARY_A, OTHER_PARTNER));
        assert!(!spend_policy::is_beneficiary_bound_to(&policy, BENEFICIARY_A, PARTNER));
        assert_eq!(spend_policy::beneficiary_count(&policy), 2);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_BAD_BENEFICIARY)]
/// A beneficiary is named by its 32-byte commitment. 31 bytes is not one.
fun verify_beneficiary_31_byte_commitment_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), SHORT_COMMITMENT, PARTNER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_BAD_BENEFICIARY)]
/// Nor is 33 bytes: the length is exact on both sides.
fun verify_beneficiary_33_byte_commitment_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), LONG_COMMITMENT, PARTNER);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_INVALID_ADDRESS)]
/// A beneficiary bound to the zero address could never be paid; refused.
fun verify_beneficiary_zero_partner_address_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, @0x0);
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_NOT_VERIFIED)]
/// Removing a beneficiary that was never verified is an error.
fun remove_beneficiary_not_verified_aborts() {
    let (mut s, id) = begin_with_policy();
    verify_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_A, PARTNER);
    remove_beneficiary_as(&mut s, id, h::wallet(), BENEFICIARY_B);
    s.end();
}

// ════════════════════════════════════════════════════════════════════════════
// Limits
// ════════════════════════════════════════════════════════════════════════════

#[test]
/// The wallet sets both limits. A threshold of zero is allowed and means every
/// payment needs a second approval; the boundaries of both are stored as
/// given.
fun set_limits_stores_both_limits() {
    let (mut s, id) = begin_with_policy();
    set_limits_as(&mut s, id, h::wallet(), 1, 0);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::per_payment_max(&policy), 1);
        assert_eq!(spend_policy::second_approval_threshold(&policy), 0);
        ts::return_shared(policy);
    };
    set_limits_as(&mut s, id, h::wallet(), std::u64::max_value!(), TEN_THOUSAND_USDC + 1);
    s.next_tx(STRANGER);
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::per_payment_max(&policy), std::u64::max_value!());
        assert_eq!(spend_policy::second_approval_threshold(&policy), TEN_THOUSAND_USDC + 1);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = spend_policy::E_BAD_LIMIT)]
/// A per-payment maximum of zero is refused here as at creation.
fun set_limits_zero_per_payment_max_aborts() {
    let (mut s, id) = begin_with_policy();
    set_limits_as(&mut s, id, h::wallet(), 0, TEN_THOUSAND_USDC);
    s.end();
}

// ════════════════════════════════════════════════════════════════════════════
// Events
// ════════════════════════════════════════════════════════════════════════════

/// The number of `PolicyChanged` events so far in this transaction.
fun changes(): u64 { event::events_by_type<PolicyChanged>().length() }

#[test]
/// Every change to the policy is observable: each of the seven mutations
/// emits exactly one `PolicyChanged`, so the backend can alert owners and the
/// controls export can show when the rules changed.
fun every_mutation_emits_one_policy_changed() {
    let (mut s, id) = begin_with_policy();
    s.next_tx(h::wallet());
    {
        let mut policy = s.take_shared_by_id<SpendPolicy>(id);
        let n = changes();
        spend_policy::add_spender(&mut policy, STAFF, spend_policy::role_staff(), STAFF_MAX, s.ctx());
        assert_eq!(changes(), n + 1);
        spend_policy::remove_spender(&mut policy, STAFF, s.ctx());
        assert_eq!(changes(), n + 2);
        spend_policy::verify_recipient(&mut policy, SUI, SUPPLIER, payment_intent::kind_wallet(), s.ctx());
        assert_eq!(changes(), n + 3);
        spend_policy::remove_recipient(&mut policy, SUI, SUPPLIER, s.ctx());
        assert_eq!(changes(), n + 4);
        spend_policy::verify_beneficiary(&mut policy, BENEFICIARY_A, PARTNER, s.ctx());
        assert_eq!(changes(), n + 5);
        spend_policy::remove_beneficiary(&mut policy, BENEFICIARY_A, s.ctx());
        assert_eq!(changes(), n + 6);
        spend_policy::set_limits(&mut policy, POLICY_MAX, TEN_THOUSAND_USDC, s.ctx());
        assert_eq!(changes(), n + 7);
        ts::return_shared(policy);
    };
    s.end();
}

#[test]
/// Each removal moves the policy's generation by one, which retires every
/// approval given before it. Additions and limit changes do not move it.
fun every_removal_and_only_a_removal_moves_the_generation() {
    let (mut s, id) = begin_with_policy();
    s.next_tx(h::wallet());
    {
        let mut policy = s.take_shared_by_id<SpendPolicy>(id);
        assert_eq!(spend_policy::generation(&policy), 0);
        spend_policy::add_spender(&mut policy, STAFF, spend_policy::role_staff(), STAFF_MAX, s.ctx());
        spend_policy::verify_recipient(&mut policy, SUI, SUPPLIER, payment_intent::kind_wallet(), s.ctx());
        spend_policy::verify_beneficiary(&mut policy, BENEFICIARY_A, PARTNER, s.ctx());
        spend_policy::set_limits(&mut policy, POLICY_MAX, 0, s.ctx());
        assert_eq!(spend_policy::generation(&policy), 0);
        spend_policy::remove_spender(&mut policy, STAFF, s.ctx());
        assert_eq!(spend_policy::generation(&policy), 1);
        spend_policy::remove_recipient(&mut policy, SUI, SUPPLIER, s.ctx());
        assert_eq!(spend_policy::generation(&policy), 2);
        spend_policy::remove_beneficiary(&mut policy, BENEFICIARY_A, s.ctx());
        assert_eq!(spend_policy::generation(&policy), 3);
        ts::return_shared(policy);
    };
    s.end();
}

// ════════════════════════════════════════════════════════════════════════════
// accept: issuing a spending rule
// ════════════════════════════════════════════════════════════════════════════

#[test]
/// D2: the wallet proposes an app-bound allowance to a listed staff member
/// and `accept` issues it in the same transaction. The rule is shared, draws
/// on the wallet, names the staff member as spender and SPLASH_SPEND as its
/// app, keeps its own caps, and its revocation cap goes to the wallet.
fun accept_issues_a_rule_funded_by_the_wallet_for_a_listed_spender() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    s.next_tx(h::wallet());
    {
        let policy = s.take_shared_by_id<SpendPolicy>(id);
        let before = event::events_by_type<SpendingRuleAccepted>().length();
        let proposal = propose<USDC>(STAFF, splash_spend::allowance_name(&policy), s.ctx());
        splash_spend::accept(proposal, &policy, s.ctx());
        assert_eq!(event::events_by_type<SpendingRuleAccepted>().length(), before + 1);
        ts::return_shared(policy);
    };
    s.next_tx(STRANGER);
    {
        let rule = s.take_shared<Allowance<Balance<USDC>>>();
        let settings = allowance::allowance_settings(&rule);
        assert_eq!(allowance::funder(settings), h::wallet());
        assert_eq!(allowance::spender(settings), option::some(STAFF));
        assert_eq!(allowance::app(settings), option::some(type_name::with_defining_ids<SPLASH_SPEND>()));
        assert_eq!(allowance::lifetime_cap(settings), option::some(RULE_CAP));
        assert_eq!(allowance::expiration_timestamp_ms(settings), option::some(RULE_EXPIRY_MS));
        assert_eq!(allowance::allowance_current_spend(&rule), 0);
        ts::return_shared(rule);
    };
    // The business, not the spender, holds the means to revoke the rule.
    assert!(ts::has_most_recent_for_address<AllowanceCap<Balance<USDC>>>(h::wallet()));
    assert!(!ts::has_most_recent_for_address<AllowanceCap<Balance<USDC>>>(STAFF));
    s.end();
}

#[test]
/// Splash's operator gets its own, separate rule the same way: an executor is
/// a listed spender too.
fun accept_issues_a_rule_for_an_executor() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    accept_as(&mut s, id, h::wallet(), EXECUTOR);
    s.next_tx(STRANGER);
    {
        let rule = s.take_shared<Allowance<Balance<USDC>>>();
        let settings = allowance::allowance_settings(&rule);
        assert_eq!(allowance::funder(settings), h::wallet());
        assert_eq!(allowance::spender(settings), option::some(EXECUTOR));
        ts::return_shared(rule);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_PROPOSAL_FUNDER)]
/// A rule funded by one owner's own address is not the business's money
/// under the business's rules. Only the policy's wallet may fund one.
fun accept_a_proposal_funded_by_an_owner_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    accept_as(&mut s, id, h::owner_1(), STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_PROPOSAL_FUNDER)]
/// A spender funding a rule to themselves would get a Splash rule, carrying
/// the policy's name, over money that is not the business's.
fun accept_a_proposal_funded_by_the_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    accept_as(&mut s, id, STAFF, STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_PROPOSAL_SPENDER)]
/// Even the wallet cannot issue a rule to someone the policy does not list.
fun accept_a_proposal_for_an_unlisted_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    accept_as(&mut s, id, h::wallet(), STRANGER);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_PROPOSAL_SPENDER)]
/// A spender who has been removed is unlisted: no new rule for them.
fun accept_a_proposal_for_a_removed_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    remove_spender_as(&mut s, id, h::wallet(), STAFF);
    accept_as(&mut s, id, h::wallet(), STAFF);
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_PROPOSAL_SPENDER)]
/// The wallet cannot be its own spender: it cannot be listed, so no rule can
/// name it.
fun accept_a_proposal_naming_the_wallet_as_spender_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    accept_as(&mut s, id, h::wallet(), h::wallet());
    s.end();
}

#[test]
#[expected_failure(abort_code = splash_spend::E_WRONG_ASSET)]
/// R2: the policy pays in USDC only. A rule in another coin type is refused
/// at issue, not left to fail at payment.
fun accept_a_proposal_in_another_coin_type_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    s.next_tx(h::wallet());
    let policy = s.take_shared_by_id<SpendPolicy>(id);
    let proposal = propose<USDT>(STAFF, splash_spend::allowance_name(&policy), s.ctx());
    splash_spend::accept(proposal, &policy, s.ctx());
    ts::return_shared(policy);
    s.end();
}

#[test]
#[expected_failure(abort_code = sui::allowance::EWrongApp)]
/// `accept` issues only rules bound to SPLASH_SPEND. A proposal bound to
/// another app, even funded by the wallet for a listed spender, is not a
/// Splash spending rule and must not be issued under Splash's permit.
fun accept_a_proposal_bound_to_another_app_aborts() {
    let (mut s, id) = begin_with_policy();
    staff_up(&mut s, id, h::wallet());
    s.next_tx(h::wallet());
    let policy = s.take_shared_by_id<SpendPolicy>(id);
    let proposal = allowance::propose_for_app<Balance<USDC>, OTHER_APP>(
        splash_spend::allowance_name(&policy),
        STAFF,
        option::some(RULE_CAP),
        option::none(),
        option::some(RULE_EXPIRY_MS),
        option::none(),
        s.ctx(),
    );
    splash_spend::accept(proposal, &policy, s.ctx());
    ts::return_shared(policy);
    s.end();
}

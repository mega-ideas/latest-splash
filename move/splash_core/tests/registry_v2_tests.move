/// v2 registries (`compliance_config`, design spec section 4).
///
/// Three short lists decide what the v2 money paths accept: the coin a payment
/// settles in, the app allowed to settle under a business's spending rules,
/// and the adapter allowed to burn a cross-chain payment. Adding to any of
/// them makes money easier to move, so the spec demands an `AdminCap`, a
/// sender that is a real quorum multisig, 24 hours' notice and a seven-day
/// window. Taking something off can only stop money, so it is immediate under
/// either cap, except that the last accepted asset stays.
///
/// These tests are written from the spec. Each event check compares the BCS
/// bytes of the emitted event with the bytes of the fields the spec names, so
/// a wrong config id, registry kind, type name or time fails here.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::registry_v2_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::cap_registry::{Self, CapRegistry};
use splash_core::compliance_config::{Self, ComplianceConfig, ComplianceCap, ConfigTicket, PendingAddition};
use splash_core::multisig;
use splash_core::payment_intent::{Self, PaymentIntent};
use splash_core::v2_harness::{Self as h, USDC};
use std::bcs;
use std::string::String;
use std::type_name;
use std::unit_test::assert_eq;
use sui::clock::Clock;
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

// ─── Types the registries are asked to accept ──────────────────────────────

/// A second coin type, as if governance were adding one.
public struct EURC has drop {}
/// A settlement-app witness, standing in for `splash_spend::SettleWitness`.
public struct SpendWitness has drop {}
/// A bridge-adapter witness, standing in for a CCTP V2 adapter.
public struct CctpAdapter has drop {}

// Nine distinct types for the bounds.
public struct M1 has drop {}
public struct M2 has drop {}
public struct M3 has drop {}
public struct M4 has drop {}
public struct M5 has drop {}
public struct M6 has drop {}
public struct M7 has drop {}
public struct M8 has drop {}
public struct M9 has drop {}

// ─── Addresses ─────────────────────────────────────────────────────────────

const PUBLISHER: address = @0xA11CE;
const STRANGER: address = @0x5757;
const NEW_HOLDER: address = @0xC0FFEE;
/// `multisig_tests::PASSKEY_1_OF_1`: passkey 1 alone, threshold 1 (SDK vector).
const PASSKEY_1_OF_1: address = @0x542f90eeed1c3562b33c4d81d7daf9571b91497acea2c5c6b6759290a569fe8f;
/// `multisig_tests::WEIGHTED_SINGLE_SIGNER_2_1_1`: weights [2,1,1], threshold 2.
const WEIGHTED_2_1_1: address = @0xe461c942f4635e04fd72371ab24ff27c8eda59582f7a0f054cf2c14f2ad1d350;

// ─── Time ──────────────────────────────────────────────────────────────────

/// The harness clock starts here, and every first proposal is made here.
const DAY: u64 = 86_400_000;
/// 24 hours' notice.
const NOTICE: u64 = 86_400_000;
/// Seven days after the notice has run.
const WINDOW: u64 = 604_800_000;
/// The eta of a proposal made at `DAY`: `DAY + NOTICE`.
const ETA: u64 = 172_800_000;
const HOUR: u64 = 3_600_000;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";

// ─── Helpers ───────────────────────────────────────────────────────────────

fun asset(): u8 { compliance_config::registry_asset() }
fun app(): u8 { compliance_config::registry_settlement_app() }
fun adapter(): u8 { compliance_config::registry_bridge_adapter() }
fun name<T>(): String { compliance_config::type_string<T>() }

/// `who` proposes `T` for `registry`, presenting these members as itself.
fun propose_with<T>(
    s: &mut Scenario,
    who: address,
    registry: u8,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
) {
    s.next_tx(who);
    let mut config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::propose_addition<T>(&admin, &mut config, registry, keys, weights, threshold, &c, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(c);
    ts::return_shared(config);
}

/// The 2-of-3 proposes.
fun propose<T>(s: &mut Scenario, registry: u8) {
    propose_with<T>(s, h::wallet(), registry, h::keys(), h::weights(), h::threshold());
}

fun activate_with<T>(
    s: &mut Scenario,
    who: address,
    registry: u8,
    keys: vector<vector<u8>>,
    weights: vector<u8>,
    threshold: u16,
) {
    s.next_tx(who);
    let mut config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::activate_addition<T>(&admin, &mut config, registry, keys, weights, threshold, &c, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(c);
    ts::return_shared(config);
}

/// The 2-of-3 activates.
fun activate<T>(s: &mut Scenario, registry: u8) {
    activate_with<T>(s, h::wallet(), registry, h::keys(), h::weights(), h::threshold());
}

fun set_time(s: &mut Scenario, ms: u64) {
    s.next_tx(h::owner_1());
    let mut c = s.take_shared<Clock>();
    c.set_for_testing(ms);
    ts::return_shared(c);
}

/// Propose `T` at the current time and activate it exactly at its eta.
fun add<T>(s: &mut Scenario, registry: u8) {
    propose<T>(s, registry);
    s.next_tx(h::owner_1());
    let c = s.take_shared<Clock>();
    let now = c.timestamp_ms();
    ts::return_shared(c);
    set_time(s, now + NOTICE);
    activate<T>(s, registry);
}

/// The harness's compliance key (held by owner 1, who created the config)
/// cancels a pending addition.
fun cancel_by_compliance(s: &mut Scenario, registry: u8, type_name: String) {
    s.next_tx(h::owner_1());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::cancel_registry_addition(&mut config, &cap, &caps, registry, type_name);
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

fun cancel_by_admin(s: &mut Scenario, registry: u8, type_name: String) {
    s.next_tx(h::owner_1());
    let mut config = s.take_shared<ComplianceConfig>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::admin_cancel_registry_addition(&admin, &mut config, registry, type_name);
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(config);
}

fun remove_by_compliance(s: &mut Scenario, registry: u8, type_name: String) {
    s.next_tx(h::owner_1());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::remove_registry_entry(&mut config, &cap, &caps, registry, type_name);
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

fun remove_by_admin(s: &mut Scenario, registry: u8, type_name: String) {
    s.next_tx(h::owner_1());
    let mut config = s.take_shared<ComplianceConfig>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::admin_remove_registry_entry(&admin, &mut config, registry, type_name);
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(config);
}

/// Break-glass the compliance cap: owner 1's cap dies, `NEW_HOLDER` gets the
/// replacement.
fun revoke_compliance_cap(s: &mut Scenario) {
    s.next_tx(PUBLISHER);
    let mut caps = s.take_shared<CapRegistry>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::arm_break_glass_compliance_cap(&admin, &mut caps, NEW_HOLDER, b"suspected compromise", &c, s.ctx());
    compliance_config::execute_break_glass_compliance_cap(&admin, &mut caps, &config, &c, s.ctx());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(caps);
}

/// A second config, built from a test-only ticket, whose compliance cap goes
/// to `STRANGER`. Returns the id of the harness's (canonical) config.
fun second_config(s: &mut Scenario): ID {
    s.next_tx(STRANGER);
    let canonical = ts::most_recent_id_shared<ComplianceConfig>().destroy_some();
    let caps = s.take_shared<CapRegistry>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::create<USDC>(
        compliance_config::ticket_for_testing(s.ctx()),
        &admin,
        &caps,
        5_000,
        60_000,
        50,
        1_000_000,
        1_000_000,
        vector[object::id_from_address(@0xF001)],
        s.ctx(),
    );
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(caps);
    canonical
}

fun config_address(s: &mut Scenario): address {
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    let a = object::id_address(&config);
    ts::return_shared(config);
    a
}

fun assets(s: &mut Scenario): vector<String> {
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    let v = compliance_config::accepted_assets(&config);
    ts::return_shared(config);
    v
}

fun apps(s: &mut Scenario): vector<String> {
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    let v = compliance_config::settlement_apps(&config);
    ts::return_shared(config);
    v
}

fun adapters(s: &mut Scenario): vector<String> {
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    let v = compliance_config::bridge_adapters(&config);
    ts::return_shared(config);
    v
}

fun pending(s: &mut Scenario): vector<PendingAddition> {
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    let v = compliance_config::pending_additions(&config);
    ts::return_shared(config);
    v
}

/// BCS of `{ config_id, registry, type_name }`: the shape of the Activated,
/// Cancelled and EntryRemoved events.
fun entry_bcs(config_id: address, registry: u8, type_name: String): vector<u8> {
    let mut b = bcs::to_bytes(&config_id);
    b.append(bcs::to_bytes(&registry));
    b.append(bcs::to_bytes(&type_name));
    b
}

/// BCS of `RegistryAdditionProposed`.
fun proposed_bcs(config_id: address, registry: u8, type_name: String, at: u64, eta: u64): vector<u8> {
    let mut b = entry_bcs(config_id, registry, type_name);
    b.append(bcs::to_bytes(&at));
    b.append(bcs::to_bytes(&eta));
    b
}

/// The app opens a bank payout for owner 2, vouched for by `SpendWitness`.
fun app_intent(s: &mut Scenario, n: u8) {
    s.next_tx(h::owner_2());
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let intent = payment_intent::create_for_app<USDC, SpendWitness>(
        SpendWitness {},
        &mut account,
        &config,
        h::owner_2(),
        h::payment_ref(n),
        h::recipient(),
        h::beneficiary(),
        h::amount(),
        0,
        b"PHP".to_string(),
        56_000_000,
        h::commitment(),
        payment_intent::kind_bank_payout(),
        h::rail(),
        c.timestamp_ms() + 300_000,
        &c,
        s.ctx(),
    );
    payment_intent::share_intent(intent);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
}

/// The wallet opens and shares a bank payout.
fun open_wallet_intent(s: &mut Scenario, n: u8) {
    s.next_tx(h::wallet());
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let intent = h::wallet_intent(&mut account, &config, n, h::amount(), &c, s.ctx());
    payment_intent::share_intent(intent);
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
}

/// The wallet pays the shared intent from a coin and anchors the receipt.
fun pay_shared_intent_from_wallet(s: &mut Scenario) {
    s.next_tx(h::wallet());
    let mut intent = s.take_shared<PaymentIntent>();
    let mut account = s.take_shared<BusinessAccount>();
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    let payment = h::usdc(h::amount(), s.ctx());
    let receipt = payment_intent::confirm_from_business_wallet(
        &mut intent, &mut account, &config, payment, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
    ts::return_shared(intent);
}

// ═══ Exactly one config ═════════════════════════════════════════════════════

#[test]
/// The publish mints exactly one `ConfigTicket`, to the publisher and nobody
/// else. With one ticket there can be one config, so a PTB author can never
/// pass a config that is unpaused or more lenient than the real one.
fun init_mints_exactly_one_ticket_to_the_publisher() {
    let mut s = ts::begin(PUBLISHER);
    compliance_config::init_for_testing(s.ctx());
    s.next_tx(PUBLISHER);
    assert_eq!(ts::ids_for_address<ConfigTicket>(PUBLISHER).length(), 1);
    assert_eq!(ts::ids_for_address<ConfigTicket>(STRANGER).length(), 0);
    assert!(!ts::has_most_recent_shared<ComplianceConfig>());
    s.end();
}

#[test]
/// `create` consumes the ticket: it is deleted in the same transaction, the
/// publisher holds none afterwards, and the transaction shares exactly one
/// config. A second `create` would need a second ticket, and outside tests
/// none can be minted.
fun create_consumes_the_only_ticket() {
    let mut s = ts::begin(PUBLISHER);
    compliance_config::init_for_testing(s.ctx());
    cap_registry::init_for_testing(s.ctx());
    s.next_tx(PUBLISHER);
    let ticket = s.take_from_sender<ConfigTicket>();
    let ticket_id = object::id(&ticket);
    let caps = s.take_shared<CapRegistry>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::create<USDC>(
        ticket,
        &admin,
        &caps,
        5_000,
        60_000,
        50,
        1_000_000,
        1_000_000,
        vector[object::id_from_address(@0xF001)],
        s.ctx(),
    );
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(caps);

    let effects = s.next_tx(PUBLISHER);
    assert!(ts::deleted(&effects).contains(&ticket_id));
    // One new shared object, the config; the other entry is the cap registry
    // this transaction borrowed and returned.
    let config_id = ts::most_recent_id_shared<ComplianceConfig>().destroy_some();
    let caps_id = ts::most_recent_id_shared<CapRegistry>().destroy_some();
    let shared = ts::shared(&effects);
    assert_eq!(shared.length(), 2);
    assert!(shared.contains(&config_id));
    assert!(shared.contains(&caps_id));
    assert_eq!(ts::ids_for_address<ConfigTicket>(PUBLISHER).length(), 0);
    assert!(!ts::has_most_recent_for_address<ConfigTicket>(PUBLISHER));
    assert!(ts::has_most_recent_shared<ComplianceConfig>());
    // The creator receives the compliance key for this config, at the live
    // generation.
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    assert_eq!(compliance_config::compliance_cap_generation(&cap), cap_registry::compliance_generation(&caps));
    ts::return_shared(caps);
    s.return_to_sender(cap);
    s.end();
}

#[test]
/// `create<T>` seeds the accepted-asset registry with exactly `T` and nothing
/// else; the app and adapter registries and the pending list start empty,
/// and settlement is not paused.
fun create_seeds_accepted_assets_with_exactly_t() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    assert_eq!(compliance_config::accepted_assets(&config), vector[name<USDC>()]);
    assert_eq!(compliance_config::settlement_apps(&config), vector[]);
    assert_eq!(compliance_config::bridge_adapters(&config), vector[]);
    assert_eq!(compliance_config::pending_additions(&config).length(), 0);
    assert_eq!(compliance_config::paused(&config), false);
    assert!(compliance_config::is_asset_accepted(&config, &name<USDC>()));
    assert!(!compliance_config::is_asset_accepted(&config, &name<EURC>()));
    compliance_config::assert_asset_accepted(&config, &name<USDC>());
    ts::return_shared(config);
    s.end();
}

#[test]
/// Entries are `type_name::with_defining_ids` strings, the same string an
/// intent stores as `settlement_asset`. A different encoding would let the
/// registry and the intents disagree about which coin is accepted.
fun entries_are_with_defining_ids_strings() {
    let expected = type_name::with_defining_ids<USDC>().into_string().to_string();
    assert_eq!(compliance_config::type_string<USDC>(), expected);
    let mut s = h::setup();
    assert_eq!(assets(&mut s), vector[expected]);
    s.end();
}

#[test]
/// The registry kinds and the two time constants are the spec's: asset 1,
/// settlement app 2, bridge adapter 3; 24 hours' notice; a seven-day window.
/// The backend decodes events with these numbers.
fun registry_kinds_and_windows_are_the_specs() {
    assert_eq!(compliance_config::registry_asset(), 1);
    assert_eq!(compliance_config::registry_settlement_app(), 2);
    assert_eq!(compliance_config::registry_bridge_adapter(), 3);
    assert_eq!(compliance_config::addition_notice_ms(), NOTICE);
    assert_eq!(compliance_config::addition_window_ms(), WINDOW);
}

// ═══ Who may propose and activate ═══════════════════════════════════════════

#[test]
/// The 2-of-3 multisig, presenting its own members, proposes. The proposal is
/// recorded with an eta exactly 24 hours out, and `RegistryAdditionProposed`
/// carries the canonical config id, the registry, the type, the time and the
/// eta: everything the backend needs to alert every owner.
fun a_quorum_multisig_proposes_and_the_event_carries_every_field() {
    let mut s = h::setup();
    let cfg = config_address(&mut s);
    propose<EURC>(&mut s, asset());
    let events = event::events_by_type<compliance_config::RegistryAdditionProposed>();
    assert_eq!(events.length(), 1);
    assert_eq!(bcs::to_bytes(&events[0]), proposed_bcs(cfg, asset(), name<EURC>(), DAY, ETA));

    let p = pending(&mut s);
    assert_eq!(p.length(), 1);
    assert_eq!(compliance_config::pending_registry(&p[0]), asset());
    assert_eq!(compliance_config::pending_type_name(&p[0]), name<EURC>());
    assert_eq!(compliance_config::pending_eta_ms(&p[0]), ETA);
    // Announced is not in force.
    assert_eq!(assets(&mut s), vector[name<USDC>()]);
    s.end();
}

#[test]
/// Any multisig that no single member can sign for is a quorum, not only the
/// 2-of-3: a 3-of-3 of the same passkeys proposes too.
fun a_3_of_3_multisig_also_proposes() {
    let mut s = h::setup();
    let three_of_three = multisig::derive_address(&h::keys(), &h::weights(), 3);
    propose_with<EURC>(&mut s, three_of_three, asset(), h::keys(), h::weights(), 3);
    assert_eq!(pending(&mut s).length(), 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_A_QUORUM)]
/// A 1-of-1 multisig is the multisig its keys derive, but one key signs for
/// it. "Never by a single key" must be checked on chain, so it is refused.
fun a_1_of_1_multisig_cannot_propose() {
    let mut s = h::setup();
    propose_with<EURC>(&mut s, PASSKEY_1_OF_1, asset(), vector[h::passkey(0)], vector[1], 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_A_QUORUM)]
/// Threshold 2 with weights [2,1,1] reads as two-person, but member one signs
/// alone. Single-signer is about weight, so this is refused too.
fun a_disguised_single_signer_cannot_propose() {
    let mut s = h::setup();
    propose_with<EURC>(&mut s, WEIGHTED_2_1_1, asset(), h::keys(), vector[2, 1, 1], 2);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_THIS_MULTISIG)]
/// One owner signing as themselves, presenting their own key as a 1-of-1: the
/// key derives the 1-of-1 multisig, not the owner's own address, so the
/// sender is not the multisig the keys describe.
fun a_single_key_sender_cannot_propose_as_itself() {
    let mut s = h::setup();
    propose_with<EURC>(&mut s, h::owner_1(), asset(), vector[h::passkey(0)], vector[1], 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_THIS_MULTISIG)]
/// One member presenting the whole 2-of-3 is not the 2-of-3. Holding the
/// public keys proves nothing; only the sender address proves a quorum
/// signed.
fun a_member_presenting_the_quorums_keys_cannot_propose() {
    let mut s = h::setup();
    propose_with<EURC>(&mut s, h::owner_2(), asset(), h::keys(), h::weights(), h::threshold());
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_THIS_MULTISIG)]
/// The right keys in the wrong order derive another address.
fun keys_that_do_not_derive_the_sender_cannot_propose() {
    let mut s = h::setup();
    let reordered = vector[h::passkey(1), h::passkey(0), h::passkey(2)];
    propose_with<EURC>(&mut s, h::wallet(), asset(), reordered, h::weights(), h::threshold());
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_THIS_MULTISIG)]
/// The right keys under a different threshold derive another address, so a
/// sender cannot overstate its own threshold.
fun a_wrong_threshold_cannot_propose() {
    let mut s = h::setup();
    propose_with<EURC>(&mut s, h::wallet(), asset(), h::keys(), h::weights(), 3);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_A_QUORUM)]
/// Activation has the same requirement: a 1-of-1 cannot switch on what a
/// quorum announced.
fun a_1_of_1_multisig_cannot_activate() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    set_time(&mut s, ETA);
    activate_with<EURC>(&mut s, PASSKEY_1_OF_1, asset(), vector[h::passkey(0)], vector[1], 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_A_QUORUM)]
/// Nor can a disguised single signer.
fun a_disguised_single_signer_cannot_activate() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    set_time(&mut s, ETA);
    activate_with<EURC>(&mut s, WEIGHTED_2_1_1, asset(), h::keys(), vector[2, 1, 1], 2);
    s.end();
}

#[test]
#[expected_failure(abort_code = multisig::E_NOT_THIS_MULTISIG)]
/// Nor a sender whose presented keys do not derive it.
fun keys_that_do_not_derive_the_sender_cannot_activate() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    set_time(&mut s, ETA);
    activate_with<EURC>(&mut s, h::owner_3(), asset(), h::keys(), h::weights(), h::threshold());
    s.end();
}

// ═══ The notice and the window ══════════════════════════════════════════════

#[test]
/// Exactly at eta the notice has run: activation succeeds, the type is in
/// force, the proposal leaves the pending list, and
/// `RegistryAdditionActivated` names the config, registry and type.
fun activation_exactly_at_eta_succeeds() {
    let mut s = h::setup();
    let cfg = config_address(&mut s);
    propose<EURC>(&mut s, asset());
    set_time(&mut s, ETA);
    activate<EURC>(&mut s, asset());
    let events = event::events_by_type<compliance_config::RegistryAdditionActivated>();
    assert_eq!(events.length(), 1);
    assert_eq!(bcs::to_bytes(&events[0]), entry_bcs(cfg, asset(), name<EURC>()));
    assert_eq!(event::events_by_type<compliance_config::RegistryAdditionProposed>().length(), 0);

    assert_eq!(assets(&mut s), vector[name<USDC>(), name<EURC>()]);
    assert_eq!(pending(&mut s).length(), 0);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOTICE_NOT_RUN)]
/// One millisecond before eta the notice has not run.
fun activation_one_ms_before_eta_aborts() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    set_time(&mut s, ETA - 1);
    activate<EURC>(&mut s, asset());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOTICE_NOT_RUN)]
/// Proposing and activating at the same instant gives no notice at all.
fun activation_at_the_proposal_time_aborts() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    activate<EURC>(&mut s, asset());
    s.end();
}

#[test]
/// The last millisecond of the window, seven days after eta less one, still
/// activates.
fun activation_on_the_last_ms_of_the_window_succeeds() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    set_time(&mut s, ETA + WINDOW - 1);
    activate<SpendWitness>(&mut s, app());
    assert_eq!(apps(&mut s), vector[name<SpendWitness>()]);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ADDITION_LAPSED)]
/// Exactly seven days after eta the addition has lapsed. A stale alert cannot
/// be cashed in once owners have stopped watching.
fun activation_seven_days_after_eta_aborts() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    set_time(&mut s, ETA + WINDOW);
    activate<SpendWitness>(&mut s, app());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ADDITION_LAPSED)]
/// Long after the window, still lapsed.
fun activation_months_later_aborts() {
    let mut s = h::setup();
    propose<CctpAdapter>(&mut s, adapter());
    set_time(&mut s, ETA + 90 * DAY);
    activate<CctpAdapter>(&mut s, adapter());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
/// An announced addition does not switch itself on when its notice runs.
/// Past eta and inside the window, the asset is still refused until
/// governance signs the activation.
fun an_addition_is_not_in_force_until_activated() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    set_time(&mut s, ETA + HOUR);
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    compliance_config::assert_asset_accepted(&config, &name<EURC>());
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOTICE_NOT_RUN)]
/// Each addition waits out its own notice. Another addition's notice having
/// run says nothing about this one.
fun each_addition_waits_out_its_own_notice() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    set_time(&mut s, DAY + 12 * HOUR);
    propose<SpendWitness>(&mut s, app());
    set_time(&mut s, ETA);
    activate<EURC>(&mut s, asset());
    // SpendWitness's eta is ETA + 12 h.
    activate<SpendWitness>(&mut s, app());
    s.end();
}

#[test]
/// Activating one addition leaves the others pending, with their own etas.
fun activating_one_addition_leaves_the_others_pending() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    set_time(&mut s, DAY + HOUR);
    propose<SpendWitness>(&mut s, app());
    set_time(&mut s, ETA + HOUR);
    activate<SpendWitness>(&mut s, app());

    let p = pending(&mut s);
    assert_eq!(p.length(), 1);
    assert_eq!(compliance_config::pending_type_name(&p[0]), name<EURC>());
    assert_eq!(compliance_config::pending_registry(&p[0]), asset());
    assert_eq!(compliance_config::pending_eta_ms(&p[0]), ETA);
    assert_eq!(apps(&mut s), vector[name<SpendWitness>()]);
    assert_eq!(assets(&mut s), vector[name<USDC>()]);

    activate<EURC>(&mut s, asset());
    assert_eq!(assets(&mut s), vector[name<USDC>(), name<EURC>()]);
    assert_eq!(pending(&mut s).length(), 0);
    s.end();
}

#[test]
/// After a lapse, the way back is a fresh proposal: owners are alerted again
/// and the full 24 hours run again from the new proposal.
fun a_lapsed_addition_can_be_withdrawn_and_proposed_afresh() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    let later = ETA + WINDOW;
    set_time(&mut s, later);
    cancel_by_admin(&mut s, asset(), name<EURC>());
    let cfg = config_address(&mut s);
    propose<EURC>(&mut s, asset());
    let events = event::events_by_type<compliance_config::RegistryAdditionProposed>();
    assert_eq!(events.length(), 1);
    assert_eq!(bcs::to_bytes(&events[0]), proposed_bcs(cfg, asset(), name<EURC>(), later, later + NOTICE));
    set_time(&mut s, later + NOTICE);
    activate<EURC>(&mut s, asset());
    assert_eq!(assets(&mut s), vector[name<USDC>(), name<EURC>()]);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOTICE_NOT_RUN)]
/// The re-proposal waits the full notice, counted from itself.
fun a_re_proposal_waits_a_fresh_notice() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    let later = ETA + WINDOW;
    set_time(&mut s, later);
    cancel_by_admin(&mut s, asset(), name<EURC>());
    propose<EURC>(&mut s, asset());
    set_time(&mut s, later + NOTICE - 1);
    activate<EURC>(&mut s, asset());
    s.end();
}

// ═══ What cannot be proposed or activated ═══════════════════════════════════

#[test]
#[expected_failure(abort_code = compliance_config::E_ALREADY_PROPOSED)]
/// A second proposal of the same type to the same registry aborts, so a
/// replayed proposal cannot reset or duplicate the notice.
fun a_duplicate_proposal_aborts() {
    let mut s = h::setup();
    propose<EURC>(&mut s, asset());
    set_time(&mut s, DAY + HOUR);
    propose<EURC>(&mut s, asset());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ALREADY_REGISTERED)]
/// The seeded asset is already accepted, so proposing it aborts.
fun proposing_the_seeded_asset_aborts() {
    let mut s = h::setup();
    propose<USDC>(&mut s, asset());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ALREADY_REGISTERED)]
/// An activated app is registered, so proposing it again aborts.
fun proposing_an_activated_entry_aborts() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    propose<SpendWitness>(&mut s, app());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_UNKNOWN_REGISTRY)]
/// There are three registries. Kind 4 is not one of them.
fun registry_kind_4_is_refused() {
    let mut s = h::setup();
    propose<EURC>(&mut s, 4);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_UNKNOWN_REGISTRY)]
/// Nor is kind 0, below the range.
fun registry_kind_0_is_refused() {
    let mut s = h::setup();
    propose<EURC>(&mut s, 0);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_PROPOSED)]
/// Nothing can be activated that was never announced.
fun activating_an_unannounced_type_aborts() {
    let mut s = h::setup();
    set_time(&mut s, ETA);
    activate<SpendWitness>(&mut s, app());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_PROPOSED)]
/// An announcement is for one registry. Owners alerted to a new asset must not
/// find the same type activated as a settlement app.
fun an_announcement_cannot_be_activated_in_another_registry() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    set_time(&mut s, ETA);
    activate<SpendWitness>(&mut s, adapter());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_PROPOSED)]
/// Activation consumes the announcement: it cannot be activated twice, for
/// example after a removal.
fun an_announcement_activates_once() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    remove_by_admin(&mut s, app(), name<SpendWitness>());
    activate<SpendWitness>(&mut s, app());
    s.end();
}

// ═══ Bounds ═════════════════════════════════════════════════════════════════

#[test]
/// Eight additions can wait at once, across registries.
fun eight_pending_additions_fit() {
    let mut s = h::setup();
    propose<M1>(&mut s, asset());
    propose<M2>(&mut s, asset());
    propose<M3>(&mut s, app());
    propose<M4>(&mut s, app());
    propose<M5>(&mut s, app());
    propose<M6>(&mut s, adapter());
    propose<M7>(&mut s, adapter());
    propose<M8>(&mut s, adapter());
    assert_eq!(pending(&mut s).length(), 8);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_REGISTRY_FULL)]
/// The ninth aborts: the pending list is bounded.
fun a_ninth_pending_addition_aborts() {
    let mut s = h::setup();
    propose<M1>(&mut s, asset());
    propose<M2>(&mut s, asset());
    propose<M3>(&mut s, app());
    propose<M4>(&mut s, app());
    propose<M5>(&mut s, app());
    propose<M6>(&mut s, adapter());
    propose<M7>(&mut s, adapter());
    propose<M8>(&mut s, adapter());
    propose<M9>(&mut s, app());
    s.end();
}

#[test]
/// Withdrawing an addition frees its slot.
fun cancelling_frees_a_pending_slot() {
    let mut s = h::setup();
    propose<M1>(&mut s, app());
    propose<M2>(&mut s, app());
    propose<M3>(&mut s, app());
    propose<M4>(&mut s, app());
    propose<M5>(&mut s, app());
    propose<M6>(&mut s, app());
    propose<M7>(&mut s, app());
    propose<M8>(&mut s, app());
    cancel_by_compliance(&mut s, app(), name<M4>());
    propose<M9>(&mut s, app());
    let p = pending(&mut s);
    assert_eq!(p.length(), 8);
    let mut i = 0;
    while (i < p.length()) {
        assert!(compliance_config::pending_type_name(&p[i]) != name<M4>());
        i = i + 1;
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_REGISTRY_FULL)]
/// A registry is a short list scanned on the payment path. Eight apps fit;
/// activating a ninth aborts.
fun a_registry_holds_at_most_eight_entries() {
    let mut s = h::setup();
    propose<M1>(&mut s, app());
    propose<M2>(&mut s, app());
    propose<M3>(&mut s, app());
    propose<M4>(&mut s, app());
    propose<M5>(&mut s, app());
    propose<M6>(&mut s, app());
    propose<M7>(&mut s, app());
    propose<M8>(&mut s, app());
    set_time(&mut s, ETA);
    activate<M1>(&mut s, app());
    activate<M2>(&mut s, app());
    activate<M3>(&mut s, app());
    activate<M4>(&mut s, app());
    activate<M5>(&mut s, app());
    activate<M6>(&mut s, app());
    activate<M7>(&mut s, app());
    activate<M8>(&mut s, app());
    assert_eq!(apps(&mut s).length(), 8);
    propose<M9>(&mut s, app());
    set_time(&mut s, ETA + NOTICE);
    activate<M9>(&mut s, app());
    s.end();
}

// ═══ Each registry does its job ═════════════════════════════════════════════

#[test]
/// Asset registry: an activated coin passes `assert_asset_accepted`.
fun an_activated_asset_is_accepted() {
    let mut s = h::setup();
    add<EURC>(&mut s, asset());
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    compliance_config::assert_asset_accepted(&config, &name<EURC>());
    compliance_config::assert_asset_accepted(&config, &name<USDC>());
    assert!(compliance_config::is_asset_accepted(&config, &name<EURC>()));
    ts::return_shared(config);
    s.end();
}

#[test]
/// Settlement-app registry: an activated witness passes
/// `assert_settlement_app`, and lands in no other registry.
fun an_activated_app_is_a_settlement_app_and_nothing_else() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    compliance_config::assert_settlement_app<SpendWitness>(&config);
    assert_eq!(compliance_config::settlement_apps(&config), vector[name<SpendWitness>()]);
    assert_eq!(compliance_config::bridge_adapters(&config), vector[]);
    assert_eq!(compliance_config::accepted_assets(&config), vector[name<USDC>()]);
    ts::return_shared(config);
    s.end();
}

#[test]
/// Bridge-adapter registry: an activated adapter passes
/// `assert_bridge_adapter`, and lands in no other registry.
fun an_activated_adapter_is_a_bridge_adapter_and_nothing_else() {
    let mut s = h::setup();
    add<CctpAdapter>(&mut s, adapter());
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    compliance_config::assert_bridge_adapter<CctpAdapter>(&config);
    assert_eq!(compliance_config::bridge_adapters(&config), vector[name<CctpAdapter>()]);
    assert_eq!(compliance_config::settlement_apps(&config), vector[]);
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
/// A coin never added is refused.
fun an_unaccepted_asset_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    compliance_config::assert_asset_accepted(&config, &name<EURC>());
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_SETTLEMENT_APP)]
/// At bootstrap no app is registered, so no staff path can settle.
fun no_settlement_app_is_registered_at_bootstrap() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    compliance_config::assert_settlement_app<SpendWitness>(&config);
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_BRIDGE_ADAPTER)]
/// At bootstrap no bridge adapter is registered, so kind 4 cannot settle
/// (spec section 3: "No bridge adapter is registered in Phase 1").
fun no_bridge_adapter_is_registered_at_bootstrap() {
    let mut s = h::setup();
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    compliance_config::assert_bridge_adapter<CctpAdapter>(&config);
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_BRIDGE_ADAPTER)]
/// A registered settlement app is not thereby a bridge adapter.
fun a_settlement_app_is_not_a_bridge_adapter() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    s.next_tx(h::owner_1());
    let config = s.take_shared<ComplianceConfig>();
    compliance_config::assert_bridge_adapter<SpendWitness>(&config);
    ts::return_shared(config);
    s.end();
}

#[test]
/// The registry gates the real path: once `SpendWitness` is a settlement app,
/// `create_for_app` accepts it.
fun a_registered_app_opens_intents() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    app_intent(&mut s, 1);
    s.next_tx(h::owner_1());
    assert!(ts::has_most_recent_shared<PaymentIntent>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_SETTLEMENT_APP)]
/// And an app that was never registered cannot open an intent at all.
fun an_unregistered_app_cannot_open_intents() {
    let mut s = h::setup();
    app_intent(&mut s, 1);
    s.end();
}

// ═══ Cancelling a pending addition ══════════════════════════════════════════

#[test]
/// `ComplianceCap` withdraws an announced addition at once, and
/// `RegistryAdditionCancelled` names the config, registry and type.
fun compliance_cap_cancels_a_pending_addition() {
    let mut s = h::setup();
    let cfg = config_address(&mut s);
    propose<SpendWitness>(&mut s, app());
    cancel_by_compliance(&mut s, app(), name<SpendWitness>());
    let events = event::events_by_type<compliance_config::RegistryAdditionCancelled>();
    assert_eq!(events.length(), 1);
    assert_eq!(bcs::to_bytes(&events[0]), entry_bcs(cfg, app(), name<SpendWitness>()));
    assert_eq!(pending(&mut s).length(), 0);
    s.end();
}

#[test]
/// `AdminCap` withdraws one too, with the same event.
fun admin_cap_cancels_a_pending_addition() {
    let mut s = h::setup();
    let cfg = config_address(&mut s);
    propose<CctpAdapter>(&mut s, adapter());
    cancel_by_admin(&mut s, adapter(), name<CctpAdapter>());
    let events = event::events_by_type<compliance_config::RegistryAdditionCancelled>();
    assert_eq!(events.length(), 1);
    assert_eq!(bcs::to_bytes(&events[0]), entry_bcs(cfg, adapter(), name<CctpAdapter>()));
    assert_eq!(pending(&mut s).length(), 0);
    s.end();
}

#[test]
/// A cancel works up to the last moment: after the notice has run and before
/// governance activates, the compliance key can still stop the addition.
fun a_pending_addition_can_be_cancelled_after_its_notice_has_run() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    propose<CctpAdapter>(&mut s, adapter());
    set_time(&mut s, ETA + WINDOW - 1);
    cancel_by_compliance(&mut s, app(), name<SpendWitness>());
    let p = pending(&mut s);
    assert_eq!(p.length(), 1);
    assert_eq!(compliance_config::pending_type_name(&p[0]), name<CctpAdapter>());
    assert_eq!(apps(&mut s), vector[]);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_PROPOSED)]
/// A cancelled addition cannot be activated when its eta comes.
fun a_cancelled_addition_cannot_be_activated() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    cancel_by_compliance(&mut s, app(), name<SpendWitness>());
    set_time(&mut s, ETA);
    activate<SpendWitness>(&mut s, app());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_PROPOSED)]
/// Cancelling nothing aborts (compliance key), so a typo fails loudly.
fun compliance_cap_cancelling_nothing_aborts() {
    let mut s = h::setup();
    cancel_by_compliance(&mut s, app(), name<SpendWitness>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_PROPOSED)]
/// Cancelling nothing aborts (cold multisig).
fun admin_cap_cancelling_nothing_aborts() {
    let mut s = h::setup();
    cancel_by_admin(&mut s, adapter(), name<CctpAdapter>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_PROPOSED)]
/// A cancel names the registry too: withdrawing the type from the wrong
/// registry does not touch the real announcement.
fun cancelling_in_the_wrong_registry_aborts() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    cancel_by_compliance(&mut s, adapter(), name<SpendWitness>());
    s.end();
}

#[test]
#[expected_failure(abort_code = cap_registry::E_STALE_GENERATION)]
/// A compliance key revoked by break-glass cannot cancel. A stolen key must
/// not keep the power to interfere with governance.
fun a_revoked_compliance_cap_cannot_cancel() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    revoke_compliance_cap(&mut s);
    cancel_by_compliance(&mut s, app(), name<SpendWitness>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_INVALID_CAP)]
/// A compliance key bound to another config is refused here.
fun a_cap_for_another_config_cannot_cancel() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    let canonical = second_config(&mut s);
    s.next_tx(STRANGER);
    let mut config = s.take_shared_by_id<ComplianceConfig>(canonical);
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::cancel_registry_addition(&mut config, &cap, &caps, app(), name<SpendWitness>());
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
    s.end();
}

// ═══ Removing an entry ══════════════════════════════════════════════════════

#[test]
/// `ComplianceCap` removes an app at once, with no notice, and
/// `RegistryEntryRemoved` names the config, registry and type.
fun compliance_cap_removes_an_entry_at_once() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    let cfg = config_address(&mut s);
    remove_by_compliance(&mut s, app(), name<SpendWitness>());
    let events = event::events_by_type<compliance_config::RegistryEntryRemoved>();
    assert_eq!(events.length(), 1);
    assert_eq!(bcs::to_bytes(&events[0]), entry_bcs(cfg, app(), name<SpendWitness>()));
    assert_eq!(apps(&mut s), vector[]);
    s.end();
}

#[test]
/// `AdminCap` removes an adapter at once, with the same event.
fun admin_cap_removes_an_entry_at_once() {
    let mut s = h::setup();
    add<CctpAdapter>(&mut s, adapter());
    let cfg = config_address(&mut s);
    remove_by_admin(&mut s, adapter(), name<CctpAdapter>());
    let events = event::events_by_type<compliance_config::RegistryEntryRemoved>();
    assert_eq!(events.length(), 1);
    assert_eq!(bcs::to_bytes(&events[0]), entry_bcs(cfg, adapter(), name<CctpAdapter>()));
    assert_eq!(adapters(&mut s), vector[]);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_SETTLEMENT_APP)]
/// A removed app stops at once: it can no longer open intents.
fun a_removed_app_can_no_longer_open_intents() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    remove_by_compliance(&mut s, app(), name<SpendWitness>());
    app_intent(&mut s, 1);
    s.end();
}

#[test]
/// Removing an app stops only the staff path. The owners' own path keeps
/// working, so a compliance removal never locks a business out of its money.
fun removing_an_app_leaves_the_owners_path_working() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    remove_by_compliance(&mut s, app(), name<SpendWitness>());
    open_wallet_intent(&mut s, 1);
    pay_shared_intent_from_wallet(&mut s);
    s.next_tx(h::owner_1());
    let intent = s.take_shared<PaymentIntent>();
    assert_eq!(payment_intent::status(&intent), payment_intent::status_confirmed());
    ts::return_shared(intent);
    s.end();
}

#[test]
/// With a second asset accepted, the seeded one can be removed at once,
/// leaving exactly the other.
fun with_two_assets_either_can_be_removed() {
    let mut s = h::setup();
    add<EURC>(&mut s, asset());
    remove_by_compliance(&mut s, asset(), name<USDC>());
    assert_eq!(assets(&mut s), vector[name<EURC>()]);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
/// Removing an asset stops every payment in it, including an intent opened
/// while it was still accepted.
fun removing_an_asset_stops_an_intent_already_open() {
    let mut s = h::setup();
    add<EURC>(&mut s, asset());
    open_wallet_intent(&mut s, 1);
    remove_by_admin(&mut s, asset(), name<USDC>());
    pay_shared_intent_from_wallet(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_LAST_ASSET)]
/// The last accepted asset cannot be removed by the compliance key; `pause`
/// is the halt. Otherwise one key could stop every payment for 24 hours with
/// nothing able to reverse it sooner.
fun compliance_cap_cannot_remove_the_last_asset() {
    let mut s = h::setup();
    remove_by_compliance(&mut s, asset(), name<USDC>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_LAST_ASSET)]
/// Nor by the cold multisig.
fun admin_cap_cannot_remove_the_last_asset() {
    let mut s = h::setup();
    remove_by_admin(&mut s, asset(), name<USDC>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_LAST_ASSET)]
/// Two assets, one removed: the survivor is now the last and stays.
fun the_survivor_of_two_assets_cannot_be_removed() {
    let mut s = h::setup();
    add<EURC>(&mut s, asset());
    remove_by_compliance(&mut s, asset(), name<USDC>());
    remove_by_admin(&mut s, asset(), name<EURC>());
    s.end();
}

#[test]
/// Apps and adapters have no such floor: the last one can go, because the
/// owners' path does not depend on them.
fun the_last_app_and_adapter_can_be_removed() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    add<CctpAdapter>(&mut s, adapter());
    remove_by_compliance(&mut s, app(), name<SpendWitness>());
    remove_by_compliance(&mut s, adapter(), name<CctpAdapter>());
    assert_eq!(apps(&mut s), vector[]);
    assert_eq!(adapters(&mut s), vector[]);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_REGISTERED)]
/// Removing an entry that is not there aborts (compliance key).
fun compliance_cap_removing_an_unregistered_entry_aborts() {
    let mut s = h::setup();
    remove_by_compliance(&mut s, app(), name<SpendWitness>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_REGISTERED)]
/// Removing an entry that is not there aborts (cold multisig).
fun admin_cap_removing_an_unregistered_entry_aborts() {
    let mut s = h::setup();
    remove_by_admin(&mut s, asset(), name<EURC>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_REGISTERED)]
/// A pending addition is not an entry: removing it aborts, and withdrawing it
/// is the cancel.
fun a_pending_addition_is_not_removable_as_an_entry() {
    let mut s = h::setup();
    propose<SpendWitness>(&mut s, app());
    remove_by_compliance(&mut s, app(), name<SpendWitness>());
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_UNKNOWN_REGISTRY)]
/// Removal from a registry that does not exist aborts.
fun removal_from_an_unknown_registry_aborts() {
    let mut s = h::setup();
    remove_by_admin(&mut s, 4, name<USDC>());
    s.end();
}

#[test]
#[expected_failure(abort_code = cap_registry::E_STALE_GENERATION)]
/// A revoked compliance key cannot remove an entry.
fun a_revoked_compliance_cap_cannot_remove() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    revoke_compliance_cap(&mut s);
    remove_by_compliance(&mut s, app(), name<SpendWitness>());
    s.end();
}

#[test]
/// The replacement key removes, so the refusal above is the generation and
/// not something else.
fun the_replacement_compliance_cap_removes() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    revoke_compliance_cap(&mut s);
    s.next_tx(NEW_HOLDER);
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::remove_registry_entry(&mut config, &cap, &caps, app(), name<SpendWitness>());
    assert_eq!(compliance_config::settlement_apps(&config), vector[]);
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_INVALID_CAP)]
/// A compliance key bound to another config cannot remove from this one.
fun a_cap_for_another_config_cannot_remove() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    let canonical = second_config(&mut s);
    s.next_tx(STRANGER);
    let mut config = s.take_shared_by_id<ComplianceConfig>(canonical);
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::remove_registry_entry(&mut config, &cap, &caps, app(), name<SpendWitness>());
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOTICE_NOT_RUN)]
/// Re-adding a removed entry takes the full 24 hours again.
fun re_adding_a_removed_entry_takes_the_full_notice() {
    let mut s = h::setup();
    add<SpendWitness>(&mut s, app());
    remove_by_compliance(&mut s, app(), name<SpendWitness>());
    propose<SpendWitness>(&mut s, app());
    // `add` activated at ETA, so this proposal was made at ETA.
    set_time(&mut s, ETA + NOTICE - 1);
    activate<SpendWitness>(&mut s, app());
    s.end();
}

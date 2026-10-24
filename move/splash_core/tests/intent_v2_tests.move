/// v2 intent creation, and the closing of the legacy path.
///
/// Written from docs/v2/phase1-move-design.md (revision 2), section 3 and
/// "The money paths", not from the code. What is pinned here:
///
///   * an intent lives `now < expires_at <= now + 30 days`, and at
///     `expires_at` exactly it is expired, for settlement and for anyone
///     expiring it;
///   * kinds 1 to 3 land on Sui (domain 8), kind 4 only through a cross-chain
///     create and never on domain 8, and nothing else is a kind;
///   * a bank payout names a 32-byte beneficiary commitment and no other kind
///     names one; the rail commitment and the payment reference are 32 bytes;
///   * one payment reference opens one intent per account, for ever, even
///     after that intent is settled and deleted;
///   * only the wallet, or a settlement app that took the 24-hour path, opens
///     a v2 intent, and only for a payable account in an accepted asset;
///   * the legacy approval path closes for an account that registers a
///     wallet, closes for everyone when its one-way switch is turned off, and
///     honours the pause and the asset registry.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::intent_v2_tests;

use splash_core::audit_anchor;
use splash_core::business_account::{Self, BusinessAccount, PayoutApproval};
use splash_core::cap_registry::CapRegistry;
use splash_core::compliance_config::{Self, ComplianceConfig, ComplianceCap};
use splash_core::multisig;
use splash_core::payment_intent::{Self, PaymentIntent};
use splash_core::v2_harness::{Self as h, USDC};
use std::unit_test::assert_eq;
use sui::balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::derived_object;
use sui::event;
use sui::test_scenario::{Self as ts, Scenario};

/// A settlement app's witness. Only this module can make one, as only
/// `splash_spend` can make its `SettleWitness`.
public struct TestApp has drop {}

/// A second app, never registered.
public struct OtherApp has drop {}

/// A second asset, so the first one can be removed (the last cannot).
public struct SCAM has drop {}

/// A staff spender a registered app vouches for.
const STAFF: address = @0x57AFF;
/// A legacy approver.
const APPROVER: address = @0xA99;
const STRANGER: address = @0xBADBAD;
/// CCTP's 32-byte mint recipient on another chain.
const MINT_RECIPIENT: address = @0xE7E7;
/// CCTP domain 6 (Base): anything but Sui's 8.
const BASE_DOMAIN: u32 = 6;
const BRIDGE_FEE: u64 = 1_000;
const BRIDGE_FINALITY: u32 = 1_000;
const FX: u64 = 56_000_000;

const FIVE_MINUTES: u64 = 300_000;
const DAY: u64 = 86_400_000;
const THIRTY_DAYS: u64 = 2_592_000_000;

const STATUS_PENDING: u8 = 0;
const STATUS_CONFIRMED: u8 = 1;
const STATUS_EXPIRED: u8 = 2;
const STATUS_CANCELED: u8 = 3;

const HASH: vector<u8> = b"0123456789abcdef0123456789abcdef";
const BLOB: vector<u8> = b"walrus-blob-id";
const BYTES_31: vector<u8> = x"11111111111111111111111111111111111111111111111111111111111111";
const BYTES_33: vector<u8> = x"111111111111111111111111111111111111111111111111111111111111111111";

// ─── Harness ───────────────────────────────────────────────────────────────

/// Everything a v2 create takes that a test varies.
public struct Draft has copy, drop {
    payment_ref: vector<u8>,
    beneficiary_ref: vector<u8>,
    commitment: vector<u8>,
    kind: u8,
    rail: vector<u8>,
    expires_at: u64,
}

/// A bank payout of `h::amount()` to `h::recipient()`, five minutes from now.
fun bank(n: u8, c: &Clock): Draft {
    Draft {
        payment_ref: h::payment_ref(n),
        beneficiary_ref: h::beneficiary(),
        commitment: h::commitment(),
        kind: payment_intent::kind_bank_payout(),
        rail: h::rail(),
        expires_at: c.timestamp_ms() + FIVE_MINUTES,
    }
}

/// Any kind, with a beneficiary only on a bank payout.
fun of_kind(n: u8, kind: u8, c: &Clock): Draft {
    let mut d = bank(n, c);
    d.kind = kind;
    if (kind != payment_intent::kind_bank_payout()) d.beneficiary_ref = vector[];
    d
}

fun by_wallet(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    d: Draft,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    payment_intent::create_for_wallet<USDC>(
        account,
        config,
        d.payment_ref,
        h::recipient(),
        d.beneficiary_ref,
        h::amount(),
        b"PHP".to_string(),
        FX,
        d.commitment,
        d.kind,
        d.rail,
        d.expires_at,
        c,
        ctx,
    )
}

fun by_app(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    maker: address,
    d: Draft,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    payment_intent::create_for_app<USDC, TestApp>(
        TestApp {},
        account,
        config,
        maker,
        d.payment_ref,
        h::recipient(),
        d.beneficiary_ref,
        h::amount(),
        b"PHP".to_string(),
        FX,
        d.commitment,
        d.kind,
        d.rail,
        d.expires_at,
        c,
        ctx,
    )
}

fun cross_chain_by_wallet(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    domain: u32,
    expires_at: u64,
    c: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    payment_intent::create_cross_chain_for_wallet<USDC>(
        account,
        config,
        h::payment_ref(n),
        domain,
        MINT_RECIPIENT,
        h::amount(),
        h::commitment(),
        h::rail(),
        BRIDGE_FEE,
        BRIDGE_FINALITY,
        expires_at,
        c,
        ctx,
    )
}

fun take(s: &Scenario): (BusinessAccount, ComplianceConfig, Clock) {
    (s.take_shared<BusinessAccount>(), s.take_shared<ComplianceConfig>(), s.take_shared<Clock>())
}

fun give(account: BusinessAccount, config: ComplianceConfig, c: Clock) {
    ts::return_shared(c);
    ts::return_shared(config);
    ts::return_shared(account);
}

fun advance(s: &mut Scenario, by_ms: u64) {
    s.next_tx(h::founder());
    let mut c = s.take_shared<Clock>();
    c.increment_for_testing(by_ms);
    ts::return_shared(c);
}

/// The wallet opens bank payout `n` and shares it. Returns its id.
fun wallet_opens(s: &mut Scenario, n: u8): ID {
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(s);
    let intent = by_wallet(&mut account, &config, bank(n, &c), &c, s.ctx());
    let id = object::id(&intent);
    payment_intent::share_intent(intent);
    give(account, config, c);
    id
}

/// STAFF opens bank payout `n` through the registered app and shares it.
fun staff_opens(s: &mut Scenario, n: u8): ID {
    s.next_tx(STAFF);
    let (mut account, config, c) = take(s);
    let intent = by_app(&mut account, &config, STAFF, bank(n, &c), &c, s.ctx());
    let id = object::id(&intent);
    payment_intent::share_intent(intent);
    give(account, config, c);
    id
}

/// The wallet pays the shared intent `id` from a coin, and anchors it.
fun wallet_pays(s: &mut Scenario, id: ID) {
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let payment = h::usdc(h::amount(), s.ctx());
    let receipt = payment_intent::confirm_from_business_wallet(
        &mut intent, &mut account, &config, payment, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
}

/// Put `X` on `registry` the only way there is: proposed by the governance
/// quorum (the harness 2-of-3, which no one member can sign for), 24 hours'
/// notice, then activated by the quorum again.
fun register<X>(s: &mut Scenario, registry: u8) {
    s.next_tx(h::wallet());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::propose_addition<X>(
            &admin, &mut config, registry, h::keys(), h::weights(), h::threshold(), &c, s.ctx(),
        );
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
    advance(s, compliance_config::addition_notice_ms());
    s.next_tx(h::wallet());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::activate_addition<X>(
            &admin, &mut config, registry, h::keys(), h::weights(), h::threshold(), &c, s.ctx(),
        );
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
}

fun register_app(s: &mut Scenario) {
    register<TestApp>(s, compliance_config::registry_settlement_app());
}

/// The compliance key takes `X` off `registry` (immediate, subtractive).
fun compliance_removes<X>(s: &mut Scenario, registry: u8) {
    s.next_tx(h::founder());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::remove_registry_entry(&mut config, &cap, &caps, registry, compliance_config::type_string<X>());
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

/// The cold multisig takes `X` off `registry`.
fun admin_removes<X>(s: &mut Scenario, registry: u8) {
    s.next_tx(h::founder());
    let mut config = s.take_shared<ComplianceConfig>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::admin_remove_registry_entry(&admin, &mut config, registry, compliance_config::type_string<X>());
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(config);
}

fun compliance_pauses(s: &mut Scenario) {
    s.next_tx(h::founder());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::pause(&mut config, &cap, &caps);
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

fun compliance_disables_legacy(s: &mut Scenario) {
    s.next_tx(h::founder());
    let mut config = s.take_shared<ComplianceConfig>();
    let cap = s.take_from_sender<ComplianceCap>();
    let caps = s.take_shared<CapRegistry>();
    compliance_config::disable_legacy(&mut config, &cap, &caps);
    ts::return_shared(caps);
    s.return_to_sender(cap);
    ts::return_shared(config);
}

fun admin_disables_legacy(s: &mut Scenario) {
    s.next_tx(h::founder());
    let mut config = s.take_shared<ComplianceConfig>();
    let admin = business_account::admin_cap_for_testing(s.ctx());
    compliance_config::admin_disable_legacy(&admin, &mut config);
    business_account::destroy_admin_cap_for_testing(admin);
    ts::return_shared(config);
}

/// A second verified account with the same three owners, whose wallet is the
/// 3-of-3 of the same passkeys: a different business wallet. Returns
/// (account A, account B, wallet B).
fun second_account(s: &mut Scenario): (ID, ID, address) {
    s.next_tx(h::founder());
    let a = ts::most_recent_id_shared<BusinessAccount>().destroy_some();
    let wallet_b = multisig::derive_address(&h::keys(), &h::weights(), 3);
    {
        let c = s.take_shared<Clock>();
        business_account::submit_application(b"SSM-B".to_string(), b"bafy-kyb-b".to_string(), &c, s.ctx());
        ts::return_shared(c);
    };
    s.next_tx(h::founder());
    let b = ts::most_recent_id_shared<BusinessAccount>().destroy_some();
    assert!(a != b);
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(b);
        let admin = business_account::admin_cap_for_testing(s.ctx());
        business_account::verify_business(&admin, &mut account, 20);
        business_account::add_owner(&mut account, h::owner_2(), s.ctx());
        business_account::add_owner(&mut account, h::owner_3(), s.ctx());
        business_account::nominate_wallet(&mut account, wallet_b, false, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    s.next_tx(wallet_b);
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(b);
        business_account::register_wallet(&mut account, h::keys(), h::weights(), 3, false, s.ctx());
        assert_eq!(business_account::wallet(&account), wallet_b);
        ts::return_shared(account);
    };
    (a, b, wallet_b)
}

/// The wallet proposes rotating to the 3-of-3 of the same passkeys. Returns
/// the new wallet, not yet confirmed.
fun propose_rotation(s: &mut Scenario): address {
    let new_wallet = multisig::derive_address(&h::keys(), &h::weights(), 3);
    s.next_tx(h::wallet());
    let mut account = s.take_shared<BusinessAccount>();
    business_account::rotate_wallet(&mut account, h::keys(), h::weights(), 3, false, s.ctx());
    ts::return_shared(account);
    new_wallet
}

fun confirm_rotation(s: &mut Scenario, new_wallet: address) {
    s.next_tx(new_wallet);
    let mut account = s.take_shared<BusinessAccount>();
    business_account::confirm_wallet_rotation(&mut account, s.ctx());
    assert_eq!(business_account::wallet(&account), new_wallet);
    ts::return_shared(account);
}

// ─── Legacy harness ────────────────────────────────────────────────────────

/// No wallet yet, and APPROVER in the approver set.
fun legacy_setup(): Scenario {
    let mut s = h::setup_without_wallet();
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::add_approver(&mut account, APPROVER, s.ctx());
        ts::return_shared(account);
    };
    s
}

/// The founder opens a legacy intent of `kind`, expiring at `now + lifetime`.
fun legacy_open(s: &mut Scenario, kind: u8, lifetime: u64) {
    s.next_tx(h::founder());
    let (account, config, c) = take(s);
    payment_intent::create_payment_intent_for_account<USDC>(
        &account,
        &config,
        h::recipient(),
        h::amount(),
        b"PHP".to_string(),
        FX,
        h::commitment(),
        kind,
        h::rail(),
        c.timestamp_ms() + lifetime,
        &c,
        s.ctx(),
    );
    give(account, config, c);
}

fun legacy_open_bank(s: &mut Scenario) {
    legacy_open(s, payment_intent::kind_bank_payout(), FIVE_MINUTES);
}

fun legacy_approve(s: &mut Scenario) {
    s.next_tx(APPROVER);
    let (account, config, c) = take(s);
    let intent = s.take_shared<PaymentIntent>();
    payment_intent::approve_payout(&intent, &account, &config, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
}

fun legacy_confirm(s: &mut Scenario) {
    s.next_tx(h::founder());
    let (mut account, config, c) = take(s);
    let mut intent = s.take_shared<PaymentIntent>();
    let approval = s.take_from_sender<PayoutApproval>();
    let payment = h::usdc(h::amount(), s.ctx());
    let receipt = payment_intent::confirm_with_approval(
        &mut intent, &mut account, &config, approval, payment, &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
}

// ═══ Lifetime at creation: now < expires_at <= now + 30 days ═══════════════

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_EXPIRY)]
/// An intent that expires the moment it is made could never be paid, and
/// "expired" means `now >= expires_at`, so `expires_at == now` is already dead.
fun expires_at_equal_to_now_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.expires_at = c.timestamp_ms();
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_EXPIRY)]
/// A deadline in the past is a mis-built transaction, not an intent.
fun expires_at_in_the_past_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.expires_at = c.timestamp_ms() - 1;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
/// The shortest lifetime there is: one millisecond. It is pending, not yet
/// expired, and `IntentCreated` carries the deadline the owners signed, so an
/// indexer need not read the intent to know when it lapses.
fun expires_at_one_ms_ahead_is_accepted() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let now = c.timestamp_ms();
    let mut d = bank(1, &c);
    d.expires_at = now + 1;
    let intent = by_wallet(&mut account, &config, d, &c, s.ctx());
    assert_eq!(payment_intent::expires_at(&intent), now + 1);
    assert_eq!(payment_intent::status(&intent), STATUS_PENDING);
    assert!(!payment_intent::is_expired(&intent, &c));

    let created = event::events_by_type<payment_intent::IntentCreated>();
    assert_eq!(created.length(), 1);
    let (intent_id, commitment, rail, asset, kind, status, expires_at_ms, timestamp_ms) =
        payment_intent::unpack_intent_created_for_testing(created[0]);
    assert_eq!(intent_id, object::id(&intent));
    assert_eq!(commitment, h::commitment());
    assert_eq!(rail, h::rail());
    assert_eq!(asset, compliance_config::type_string<USDC>());
    assert_eq!(kind, payment_intent::kind_bank_payout());
    assert_eq!(status, STATUS_PENDING);
    assert_eq!(expires_at_ms, now + 1);
    assert_eq!(timestamp_ms, now);

    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
/// Thirty days is the ceiling (D11) and it is inclusive: an invoice due in
/// exactly thirty days can be opened today.
fun expires_at_exactly_thirty_days_ahead_is_accepted() {
    let mut s = h::setup();
    assert_eq!(payment_intent::max_intent_lifetime_ms(), THIRTY_DAYS);
    assert_eq!(THIRTY_DAYS, 30 * DAY);
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.expires_at = c.timestamp_ms() + THIRTY_DAYS;
    let intent = by_wallet(&mut account, &config, d, &c, s.ctx());
    assert_eq!(payment_intent::expires_at(&intent), c.timestamp_ms() + THIRTY_DAYS);
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_EXPIRY)]
/// One millisecond past thirty days is over the ceiling. Without it, a
/// staff-opened intent could sit payable for years after anyone remembered it.
fun expires_at_thirty_days_and_one_ms_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.expires_at = c.timestamp_ms() + THIRTY_DAYS + 1;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_EXPIRY)]
/// The largest deadline there is must fail the ceiling by name, not by an
/// arithmetic overflow, and must never wrap around into an accepted value.
fun expires_at_u64_max_is_refused_by_name() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.expires_at = 0xFFFFFFFFFFFFFFFF;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_EXPIRY)]
/// The ceiling holds on the cross-chain wallet create too.
fun cross_chain_wallet_create_enforces_the_thirty_day_ceiling() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let expires_at = c.timestamp_ms() + THIRTY_DAYS + 1;
    let intent = cross_chain_by_wallet(&mut account, &config, 1, BASE_DOMAIN, expires_at, &c, s.ctx());
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_EXPIRY)]
/// The ceiling holds on the app path, where staff open intents the owners did
/// not sign: staff cannot leave a payable intent open longer than the owners
/// could.
fun app_create_enforces_the_thirty_day_ceiling() {
    let mut s = h::setup();
    register_app(&mut s);
    s.next_tx(STAFF);
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.expires_at = c.timestamp_ms() + THIRTY_DAYS + 1;
    payment_intent::share_intent(by_app(&mut account, &config, STAFF, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_EXPIRY)]
/// The legacy create obeys the same ceiling: the 5-minute constant it used to
/// hard-code is gone, and a caller-chosen deadline must not exceed 30 days.
fun legacy_create_enforces_the_thirty_day_ceiling() {
    let mut s = legacy_setup();
    legacy_open(&mut s, payment_intent::kind_bank_payout(), THIRTY_DAYS + 1);
    s.end();
}

#[test]
/// The legacy create accepts the ceiling itself.
fun legacy_create_accepts_exactly_thirty_days() {
    let mut s = legacy_setup();
    legacy_open(&mut s, payment_intent::kind_bank_payout(), THIRTY_DAYS);
    s.next_tx(h::founder());
    {
        let intent = s.take_shared<PaymentIntent>();
        let c = s.take_shared<Clock>();
        assert_eq!(payment_intent::expires_at(&intent), c.timestamp_ms() + THIRTY_DAYS);
        // A legacy intent carries no v2 payment reference.
        assert_eq!(payment_intent::payment_ref(&intent), vector[]);
        ts::return_shared(c);
        ts::return_shared(intent);
    };
    s.end();
}

// ═══ Lifetime at settlement: at expires_at the intent is expired ═══════════

#[test]
/// One millisecond before the deadline the wallet can still pay. Without this
/// the refusals below could pass because nothing ever settles.
fun wallet_settles_one_ms_before_expiry() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    advance(&mut s, FIVE_MINUTES - 1);
    wallet_pays(&mut s, id);
    s.next_tx(h::wallet());
    {
        let intent = s.take_shared_by_id<PaymentIntent>(id);
        assert_eq!(payment_intent::status(&intent), STATUS_CONFIRMED);
        ts::return_shared(intent);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_EXPIRED)]
/// At `expires_at` exactly the intent is expired. A deadline that still paid
/// at the deadline would be one millisecond longer than the owners signed.
fun wallet_coin_settle_at_exactly_expires_at_is_refused() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    advance(&mut s, FIVE_MINUTES);
    wallet_pays(&mut s, id);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_EXPIRED)]
/// The address-balance form of the wallet path has the same boundary.
fun wallet_balance_settle_at_exactly_expires_at_is_refused() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    advance(&mut s, FIVE_MINUTES);
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let funds = balance::create_for_testing<USDC>(h::amount());
    let receipt = payment_intent::confirm_from_business_wallet_balance(
        &mut intent, &mut account, &config, funds, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
/// The app path pays one millisecond before the deadline, so the refusal at
/// the deadline below means something.
fun app_settles_one_ms_before_expiry() {
    let mut s = h::setup();
    register_app(&mut s);
    let id = staff_opens(&mut s, 1);
    advance(&mut s, FIVE_MINUTES - 1);
    s.next_tx(STAFF);
    let (mut account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let funds = balance::create_for_testing<USDC>(h::amount());
    let receipt = payment_intent::settle_from_app<USDC, TestApp>(
        TestApp {}, &mut intent, &mut account, &config, funds, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    assert_eq!(payment_intent::status(&intent), STATUS_CONFIRMED);
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_EXPIRED)]
/// A spending rule cannot pay an intent at its deadline either.
fun app_settle_at_exactly_expires_at_is_refused() {
    let mut s = h::setup();
    register_app(&mut s);
    let id = staff_opens(&mut s, 1);
    advance(&mut s, FIVE_MINUTES);
    s.next_tx(STAFF);
    let (mut account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let funds = balance::create_for_testing<USDC>(h::amount());
    let receipt = payment_intent::settle_from_app<USDC, TestApp>(
        TestApp {}, &mut intent, &mut account, &config, funds, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_CROSS_CHAIN_ONLY)]
/// A settlement app cannot settle a cross-chain intent the wallet opened:
/// its one settle path pays an address on Sui, and no app path hands a coin
/// back for a bridge. Cross-chain intents are the owners' to pay.
fun an_app_cannot_settle_a_cross_chain_intent() {
    let mut s = h::setup();
    register_app(&mut s);
    s.next_tx(h::wallet());
    let id;
    {
        let (mut account, config, c) = take(&s);
        let expires_at = c.timestamp_ms() + FIVE_MINUTES;
        let intent = cross_chain_by_wallet(&mut account, &config, 1, BASE_DOMAIN, expires_at, &c, s.ctx());
        id = object::id(&intent);
        payment_intent::share_intent(intent);
        give(account, config, c);
    };
    s.next_tx(STAFF);
    let (mut account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let funds = balance::create_for_testing<USDC>(h::amount());
    let receipt = payment_intent::settle_from_app<USDC, TestApp>(
        TestApp {}, &mut intent, &mut account, &config, funds, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_EXPIRED)]
/// Nor can the wallet release a cross-chain payment at its deadline.
fun cross_chain_settle_at_exactly_expires_at_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let id;
    {
        let (mut account, config, c) = take(&s);
        let expires_at = c.timestamp_ms() + FIVE_MINUTES;
        let intent = cross_chain_by_wallet(&mut account, &config, 1, BASE_DOMAIN, expires_at, &c, s.ctx());
        id = object::id(&intent);
        payment_intent::share_intent(intent);
        give(account, config, c);
    };
    advance(&mut s, FIVE_MINUTES);
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let payment = h::usdc(h::amount(), s.ctx());
    let (receipt, to_bridge, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
        &mut intent, &mut account, &config, payment, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    let (_, _, _, _, _, _, _, _) = payment_intent::unpack_bridge_obligation_for_testing(obligation);
    coin::burn_for_testing(to_bridge);
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_EXPIRED)]
/// The legacy path has the same boundary, with a still-valid approval in hand.
fun legacy_confirm_at_exactly_expires_at_is_refused() {
    let mut s = legacy_setup();
    legacy_open_bank(&mut s);
    legacy_approve(&mut s);
    advance(&mut s, FIVE_MINUTES);
    legacy_confirm(&mut s);
    s.end();
}

#[test]
/// At `expires_at` exactly, anyone may mark the intent expired; one ms before,
/// `is_expired` says no. The boundary is the same one settlement uses, so
/// there is no instant at which an intent is both payable and expirable.
fun anyone_can_expire_an_intent_at_exactly_expires_at() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    advance(&mut s, FIVE_MINUTES - 1);
    s.next_tx(STRANGER);
    {
        let intent = s.take_shared_by_id<PaymentIntent>(id);
        let c = s.take_shared<Clock>();
        assert!(!payment_intent::is_expired(&intent, &c));
        ts::return_shared(c);
        ts::return_shared(intent);
    };
    advance(&mut s, 1);
    s.next_tx(STRANGER);
    {
        let mut intent = s.take_shared_by_id<PaymentIntent>(id);
        let c = s.take_shared<Clock>();
        assert_eq!(c.timestamp_ms(), payment_intent::expires_at(&intent));
        assert!(payment_intent::is_expired(&intent, &c));
        payment_intent::cancel_payment_intent(&mut intent, &c, s.ctx());
        assert_eq!(payment_intent::status(&intent), STATUS_EXPIRED);
        ts::return_shared(c);
        ts::return_shared(intent);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_NOT_YET_EXPIRED)]
/// One millisecond early, no one can expire an intent the owners still mean to
/// pay. Otherwise a stranger could kill any payment just before it settles.
fun an_intent_cannot_be_expired_one_ms_early() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    advance(&mut s, FIVE_MINUTES - 1);
    s.next_tx(STRANGER);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let c = s.take_shared<Clock>();
    payment_intent::cancel_payment_intent(&mut intent, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(intent);
    s.end();
}

// ═══ Kinds ═════════════════════════════════════════════════════════════════

#[test]
/// Kinds 1, 2 and 3 land on Sui: domain 8, no bridge parameters, and a
/// beneficiary on the bank payout only.
fun kinds_one_to_three_open_on_sui() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut kind = 1;
    while (kind <= 3) {
        let intent = by_wallet(&mut account, &config, of_kind(kind, kind, &c), &c, s.ctx());
        assert_eq!(payment_intent::kind(&intent), kind);
        assert_eq!(payment_intent::destination_domain(&intent), payment_intent::sui_domain());
        assert_eq!(payment_intent::destination_domain(&intent), 8);
        assert_eq!(payment_intent::bridge_max_fee(&intent), 0);
        assert_eq!(payment_intent::bridge_min_finality(&intent), 0);
        if (kind == payment_intent::kind_bank_payout()) {
            assert_eq!(payment_intent::beneficiary_ref(&intent), h::beneficiary());
        } else {
            assert_eq!(payment_intent::beneficiary_ref(&intent), vector[]);
        };
        assert_eq!(payment_intent::rail_commitment(&intent), h::rail());
        payment_intent::share_intent(intent);
        kind = kind + 1;
    };
    assert_eq!(payment_intent::kind_bank_payout(), 1);
    assert_eq!(payment_intent::kind_splash_business(), 2);
    assert_eq!(payment_intent::kind_wallet(), 3);
    assert_eq!(payment_intent::kind_cross_chain_wallet(), 4);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INVALID_KIND)]
/// Zero is never a kind, so a field left unset cannot read as one.
fun kind_zero_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    payment_intent::share_intent(by_wallet(&mut account, &config, of_kind(1, 0, &c), &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INVALID_KIND)]
/// Five is past the last kind. An unknown kind has no delivery rule, no
/// verification rule in a spending policy, and no floor rule.
fun kind_five_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    payment_intent::share_intent(by_wallet(&mut account, &config, of_kind(1, 5, &c), &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INVALID_KIND)]
/// `create_for_wallet` lands on Sui. A kind-4 intent opened there would have
/// domain 8 and no bridge parameters, a cross-chain payment with nowhere to go.
fun wallet_create_refuses_the_cross_chain_kind() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let d = of_kind(1, payment_intent::kind_cross_chain_wallet(), &c);
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INVALID_KIND)]
/// The same on the app path.
fun app_create_refuses_the_cross_chain_kind() {
    let mut s = h::setup();
    register_app(&mut s);
    s.next_tx(STAFF);
    let (mut account, config, c) = take(&s);
    let d = of_kind(1, payment_intent::kind_cross_chain_wallet(), &c);
    payment_intent::share_intent(by_app(&mut account, &config, STAFF, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_DOMAIN)]
/// A cross-chain payment to domain 8 is a Sui payment wearing a bridge's
/// clothes: it would route a Sui recipient through a CCTP burn.
fun cross_chain_wallet_create_refuses_the_sui_domain() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let expires_at = c.timestamp_ms() + FIVE_MINUTES;
    let intent = cross_chain_by_wallet(&mut account, &config, 1, 8, expires_at, &c, s.ctx());
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
/// A cross-chain create records kind 4, its domain and mint recipient, the
/// bridge limits the owners signed, and no beneficiary.
fun cross_chain_create_records_kind_four() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let expires_at = c.timestamp_ms() + FIVE_MINUTES;
    let intent = cross_chain_by_wallet(&mut account, &config, 1, BASE_DOMAIN, expires_at, &c, s.ctx());
    assert_eq!(payment_intent::kind(&intent), payment_intent::kind_cross_chain_wallet());
    assert_eq!(payment_intent::destination_domain(&intent), BASE_DOMAIN);
    assert_eq!(payment_intent::recipient(&intent), MINT_RECIPIENT);
    assert_eq!(payment_intent::beneficiary_ref(&intent), vector[]);
    assert_eq!(payment_intent::bridge_max_fee(&intent), BRIDGE_FEE);
    assert_eq!(payment_intent::bridge_min_finality(&intent), BRIDGE_FINALITY);
    assert_eq!(payment_intent::payment_ref(&intent), h::payment_ref(1));
    assert_eq!(*payment_intent::settlement_asset(&intent), compliance_config::type_string<USDC>());
    assert_eq!(payment_intent::sender(&intent), h::wallet());
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

// ─── Beneficiary: 32 bytes on a bank payout, empty on every other kind ──────

#[test]
#[expected_failure(abort_code = payment_intent::E_BENEFICIARY_REQUIRED)]
/// A bank payout with no beneficiary cannot be checked against the policy's
/// beneficiary binding, so it cannot be opened at all.
fun bank_payout_without_a_beneficiary_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.beneficiary_ref = vector[];
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BENEFICIARY_REQUIRED)]
/// 31 bytes is a mis-encoding, never a commitment.
fun bank_payout_with_a_31_byte_beneficiary_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.beneficiary_ref = BYTES_31;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BENEFICIARY_REQUIRED)]
/// And so is 33.
fun bank_payout_with_a_33_byte_beneficiary_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.beneficiary_ref = BYTES_33;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BENEFICIARY_REQUIRED)]
/// A wallet transfer names no beneficiary. One that did would carry a bank
/// beneficiary's commitment onto a payment no beneficiary rule checks.
fun wallet_transfer_with_a_beneficiary_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = of_kind(1, payment_intent::kind_wallet(), &c);
    d.beneficiary_ref = h::beneficiary();
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BENEFICIARY_REQUIRED)]
/// Nor does a payment to another Splash business.
fun splash_business_payment_with_a_beneficiary_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = of_kind(1, payment_intent::kind_splash_business(), &c);
    d.beneficiary_ref = h::beneficiary();
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

// ─── Rail commitment and payment reference: 32 bytes ───────────────────────

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_RAIL_COMMITMENT)]
/// The rail commitment is frozen into every lifecycle event at publish. A
/// short one is not a commitment to anything.
fun a_31_byte_rail_commitment_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.rail = BYTES_31;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_RAIL_COMMITMENT)]
/// Nor is a long one.
fun a_33_byte_rail_commitment_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.rail = BYTES_33;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_PAYMENT_REF)]
/// An empty reference would make every untagged create collide with the
/// first, or worse, give legacy-shaped intents a v2 identity.
fun an_empty_payment_ref_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.payment_ref = vector[];
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_PAYMENT_REF)]
/// The reference is a 32-byte commitment over the business's invoice id; a
/// raw or truncated id must not be accepted as one.
fun a_31_byte_payment_ref_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.payment_ref = BYTES_31;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_PAYMENT_REF)]
/// Nor a long one: otherwise one invoice could be opened twice under two
/// encodings of the same id.
fun a_33_byte_payment_ref_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.payment_ref = BYTES_33;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_BAD_COMMITMENT)]
/// The event commitment is 32 bytes too (WS5).
fun a_short_event_commitment_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut d = bank(1, &c);
    d.commitment = BYTES_31;
    payment_intent::share_intent(by_wallet(&mut account, &config, d, &c, s.ctx()));
    give(account, config, c);
    s.end();
}

// ═══ Idempotency: one payment reference, one intent, for ever ══════════════

#[test]
/// A v2 intent records its account, its maker and its reference, and the
/// account then reports the reference as used.
fun a_v2_intent_records_its_account_maker_and_reference() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    assert!(!payment_intent::payment_ref_used(&account, h::payment_ref(1)));
    let intent = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
    assert_eq!(payment_intent::account(&intent), option::some(object::id(&account)));
    assert!(payment_intent::is_account_bound(&intent));
    assert_eq!(payment_intent::sender(&intent), h::wallet());
    assert_eq!(payment_intent::payment_ref(&intent), h::payment_ref(1));
    assert!(payment_intent::payment_ref_used(&account, h::payment_ref(1)));
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = derived_object::EObjectAlreadyExists)]
/// A double-submitted create, in one transaction, cannot open a second
/// payable intent for one invoice.
fun the_same_payment_ref_twice_in_one_transaction_aborts() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let first = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
    let second = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
    payment_intent::share_intent(first);
    payment_intent::share_intent(second);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = derived_object::EObjectAlreadyExists)]
/// A retried create, in a later transaction, while the first intent is still
/// open, cannot either. This is the backend retry that would otherwise pay an
/// invoice twice.
fun the_same_payment_ref_in_a_later_transaction_aborts() {
    let mut s = h::setup();
    wallet_opens(&mut s, 1);
    wallet_opens(&mut s, 1);
    s.end();
}

#[test]
/// The reference stays used after the intent is settled and deleted: deleting
/// the object frees its storage, not its invoice.
fun a_payment_ref_stays_used_after_settle_and_delete() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let mut intent = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
    let payment = h::usdc(h::amount(), s.ctx());
    let receipt = payment_intent::confirm_from_business_wallet(
        &mut intent, &mut account, &config, payment, h::settle_by(&c), &c, s.ctx(),
    );
    audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
    payment_intent::delete_finalized(intent);
    assert!(payment_intent::payment_ref_used(&account, h::payment_ref(1)));
    assert!(!payment_intent::payment_ref_used(&account, h::payment_ref(2)));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = derived_object::EObjectAlreadyExists)]
/// And a create after that settle-and-delete aborts. Create, settle, anchor and
/// delete in one transaction is the batch shape (R2); repeating the batch must
/// not pay the invoice again.
fun a_payment_ref_cannot_reopen_after_settle_and_delete() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    {
        let (mut account, config, c) = take(&s);
        let mut intent = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
        let payment = h::usdc(h::amount(), s.ctx());
        let receipt = payment_intent::confirm_from_business_wallet(
            &mut intent, &mut account, &config, payment, h::settle_by(&c), &c, s.ctx(),
        );
        audit_anchor::anchor(receipt, HASH, BLOB, &c, s.ctx());
        payment_intent::delete_finalized(intent);
        give(account, config, c);
    };
    wallet_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = derived_object::EObjectAlreadyExists)]
/// Cancelling and destroying the intent does not free the reference either,
/// so a cancelled invoice cannot be quietly re-opened under the same id.
fun a_payment_ref_cannot_reopen_after_cancel() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    {
        let (mut account, config, c) = take(&s);
        let intent = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
        payment_intent::cancel(intent, &c, s.ctx());
        give(account, config, c);
    };
    wallet_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = derived_object::EObjectAlreadyExists)]
/// Nor does expiring and deleting it.
fun a_payment_ref_cannot_reopen_after_expiry_and_delete() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    advance(&mut s, FIVE_MINUTES);
    s.next_tx(STRANGER);
    {
        let mut intent = s.take_shared_by_id<PaymentIntent>(id);
        let c = s.take_shared<Clock>();
        payment_intent::cancel_payment_intent(&mut intent, &c, s.ctx());
        ts::return_shared(c);
        ts::return_shared(intent);
    };
    s.next_tx(STRANGER);
    {
        let intent = s.take_shared_by_id<PaymentIntent>(id);
        payment_intent::delete_finalized(intent);
    };
    wallet_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = derived_object::EObjectAlreadyExists)]
/// The reference is per account, not per path: a staff member cannot open a
/// second payable intent for an invoice the owners already opened.
fun the_app_cannot_reuse_a_ref_the_wallet_used() {
    let mut s = h::setup();
    register_app(&mut s);
    wallet_opens(&mut s, 1);
    staff_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = derived_object::EObjectAlreadyExists)]
/// And a cross-chain create shares the same namespace.
fun a_cross_chain_create_cannot_reuse_a_ref() {
    let mut s = h::setup();
    wallet_opens(&mut s, 1);
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let expires_at = c.timestamp_ms() + FIVE_MINUTES;
    let intent = cross_chain_by_wallet(&mut account, &config, 1, BASE_DOMAIN, expires_at, &c, s.ctx());
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
/// Two businesses may happen to use the same invoice number. The reference is
/// derived under the account, so one business's references never block
/// another's, and `payment_ref_used` answers per account.
fun another_account_may_reuse_a_ref() {
    let mut s = h::setup();
    let (a, b, wallet_b) = second_account(&mut s);
    s.next_tx(h::wallet());
    let id_a;
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(a);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let intent = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
        id_a = object::id(&intent);
        payment_intent::share_intent(intent);
        give(account, config, c);
    };
    s.next_tx(wallet_b);
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(b);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        assert!(!payment_intent::payment_ref_used(&account, h::payment_ref(1)));
        let intent = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
        assert!(object::id(&intent) != id_a);
        assert_eq!(payment_intent::account(&intent), option::some(b));
        assert_eq!(payment_intent::sender(&intent), wallet_b);
        assert!(payment_intent::payment_ref_used(&account, h::payment_ref(1)));
        payment_intent::share_intent(intent);
        give(account, config, c);
    };
    s.next_tx(h::wallet());
    {
        let account = s.take_shared_by_id<BusinessAccount>(a);
        assert!(payment_intent::payment_ref_used(&account, h::payment_ref(1)));
        ts::return_shared(account);
    };
    s.end();
}

// ═══ Who and what a create accepts ═════════════════════════════════════════

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
/// An intent in an asset that is not on the registry is refused when it is
/// opened, not only when it is paid.
fun an_asset_off_the_registry_is_refused_at_create() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let d = bank(1, &c);
    let intent = payment_intent::create_for_wallet<SCAM>(
        &mut account, &config, d.payment_ref, h::recipient(), d.beneficiary_ref, h::amount(),
        b"PHP".to_string(), FX, d.commitment, d.kind, d.rail, d.expires_at, &c, s.ctx(),
    );
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
/// Removal is immediate: once compliance takes USDC off the registry, no new
/// USDC intent opens, while the asset that replaced it does.
fun a_removed_asset_is_refused_at_create() {
    let mut s = h::setup();
    register<SCAM>(&mut s, compliance_config::registry_asset());
    s.next_tx(h::wallet());
    {
        let (mut account, config, c) = take(&s);
        let d = bank(1, &c);
        let intent = payment_intent::create_for_wallet<SCAM>(
            &mut account, &config, d.payment_ref, h::recipient(), d.beneficiary_ref, h::amount(),
            b"PHP".to_string(), FX, d.commitment, d.kind, d.rail, d.expires_at, &c, s.ctx(),
        );
        assert_eq!(*payment_intent::settlement_asset(&intent), compliance_config::type_string<SCAM>());
        payment_intent::share_intent(intent);
        give(account, config, c);
    };
    compliance_removes<USDC>(&mut s, compliance_config::registry_asset());
    wallet_opens(&mut s, 2);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_ACCOUNT_NOT_PAYABLE)]
/// Any one owner can pull the brake, and a frozen account opens nothing.
fun an_owner_frozen_account_is_refused_at_create() {
    let mut s = h::setup();
    s.next_tx(h::owner_2());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::freeze_account(&mut account, s.ctx());
        ts::return_shared(account);
    };
    wallet_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_ACCOUNT_NOT_PAYABLE)]
/// A compliance freeze stops intent creation too.
fun an_admin_frozen_account_is_refused_at_create() {
    let mut s = h::setup();
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        business_account::admin_freeze(&admin, &mut account, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    wallet_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_ACCOUNT_NOT_PAYABLE)]
/// An account whose KYB was withdrawn opens nothing, even from its own wallet.
fun an_unverified_account_is_refused_at_create() {
    let mut s = h::setup();
    s.next_tx(h::founder());
    {
        let mut account = s.take_shared<BusinessAccount>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        business_account::revoke_verification(&admin, &mut account, s.ctx());
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    wallet_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_ACCOUNT_NOT_PAYABLE)]
/// A freeze stops every Splash path, staff spending rules included: a staff
/// member cannot queue intents on a frozen account.
fun the_app_path_is_refused_for_a_frozen_account() {
    let mut s = h::setup();
    register_app(&mut s);
    s.next_tx(h::owner_3());
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::freeze_account(&mut account, s.ctx());
        ts::return_shared(account);
    };
    staff_opens(&mut s, 1);
    s.end();
}

// ─── create_for_wallet: the wallet only ────────────────────────────────────

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// An owner is one of the wallet's signers, not the wallet. One owner alone
/// cannot open an intent in the business's name on the wallet path.
fun an_owner_cannot_create_as_the_wallet() {
    let mut s = h::setup();
    s.next_tx(h::founder());
    let (mut account, config, c) = take(&s);
    payment_intent::share_intent(by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NO_WALLET)]
/// Before a wallet is registered there is no wallet path at all.
fun the_wallet_path_needs_a_registered_wallet() {
    let mut s = h::setup_without_wallet();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    payment_intent::share_intent(by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// Another business's wallet, even one with the same signers, cannot open
/// intents in this business's name.
fun another_businesss_wallet_cannot_create() {
    let mut s = h::setup();
    let (a, _b, wallet_b) = second_account(&mut s);
    s.next_tx(wallet_b);
    let mut account = s.take_shared_by_id<BusinessAccount>(a);
    let config = s.take_shared<ComplianceConfig>();
    let c = s.take_shared<Clock>();
    payment_intent::share_intent(by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// A wallet proposed by rotation is not the wallet until it confirms. Until
/// then it has proved nothing, and must not open intents.
fun a_pending_wallet_cannot_create_before_it_confirms() {
    let mut s = h::setup();
    let new_wallet = propose_rotation(&mut s);
    s.next_tx(new_wallet);
    let (mut account, config, c) = take(&s);
    payment_intent::share_intent(by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// Once a rotation is confirmed, the old wallet (perhaps rotated out because a
/// signer was compromised) can no longer open intents.
fun a_rotated_out_wallet_cannot_create() {
    let mut s = h::setup();
    let new_wallet = propose_rotation(&mut s);
    confirm_rotation(&mut s, new_wallet);
    wallet_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = derived_object::EObjectAlreadyExists)]
/// The reference belongs to the account, not to the wallet generation: the new
/// wallet can open intents, but not re-open an invoice the old wallet opened.
fun a_payment_ref_stays_used_across_a_wallet_rotation() {
    let mut s = h::setup();
    wallet_opens(&mut s, 1);
    let new_wallet = propose_rotation(&mut s);
    confirm_rotation(&mut s, new_wallet);
    s.next_tx(new_wallet);
    let (mut account, config, c) = take(&s);
    let fresh = by_wallet(&mut account, &config, bank(2, &c), &c, s.ctx());
    assert_eq!(payment_intent::sender(&fresh), new_wallet);
    payment_intent::share_intent(fresh);
    payment_intent::share_intent(by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx()));
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// The cross-chain wallet create is the wallet's only, too.
fun a_stranger_cannot_create_cross_chain_as_the_wallet() {
    let mut s = h::setup();
    s.next_tx(STRANGER);
    let (mut account, config, c) = take(&s);
    let expires_at = c.timestamp_ms() + FIVE_MINUTES;
    let intent = cross_chain_by_wallet(&mut account, &config, 1, BASE_DOMAIN, expires_at, &c, s.ctx());
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

// ─── create_for_app: a registered settlement app only ──────────────────────

#[test]
/// A settlement app that took the 24-hour path opens an intent for the maker
/// it vouches for, bound to the account.
fun a_registered_app_opens_an_intent_for_its_maker() {
    let mut s = h::setup();
    register_app(&mut s);
    s.next_tx(STAFF);
    let (mut account, config, c) = take(&s);
    let intent = by_app(&mut account, &config, STAFF, bank(1, &c), &c, s.ctx());
    assert_eq!(payment_intent::sender(&intent), STAFF);
    assert_eq!(payment_intent::account(&intent), option::some(object::id(&account)));
    assert_eq!(payment_intent::kind(&intent), payment_intent::kind_bank_payout());
    assert_eq!(payment_intent::payment_ref(&intent), h::payment_ref(1));
    assert_eq!(payment_intent::status(&intent), STATUS_PENDING);
    assert!(payment_intent::payment_ref_used(&account, h::payment_ref(1)));
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_SETTLEMENT_APP)]
/// Registering one app admits that one app. Any other witness, which any
/// package can define, is refused.
fun an_unregistered_app_is_refused() {
    let mut s = h::setup();
    register_app(&mut s);
    s.next_tx(STAFF);
    let (mut account, config, c) = take(&s);
    let d = bank(1, &c);
    let intent = payment_intent::create_for_app<USDC, OtherApp>(
        OtherApp {}, &mut account, &config, STAFF, d.payment_ref, h::recipient(), d.beneficiary_ref,
        h::amount(), b"PHP".to_string(), FX, d.commitment, d.kind, d.rail, d.expires_at, &c, s.ctx(),
    );
    payment_intent::share_intent(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_SETTLEMENT_APP)]
/// A proposal is not a registration. Even after its 24 hours have run, an app
/// nobody activated cannot open intents.
fun a_proposed_but_unactivated_app_is_refused() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        compliance_config::propose_addition<TestApp>(
            &admin, &mut config, compliance_config::registry_settlement_app(),
            h::keys(), h::weights(), h::threshold(), &c, s.ctx(),
        );
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(c);
        ts::return_shared(config);
    };
    advance(&mut s, DAY);
    staff_opens(&mut s, 1);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_NOT_A_SETTLEMENT_APP)]
/// Removing an app is immediate: the next create through it is refused.
fun a_removed_app_is_refused() {
    let mut s = h::setup();
    register_app(&mut s);
    staff_opens(&mut s, 1);
    compliance_removes<TestApp>(&mut s, compliance_config::registry_settlement_app());
    staff_opens(&mut s, 2);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INVALID_RECIPIENT)]
/// An app must vouch for someone. An intent made by @0x0 could never be
/// cancelled by its maker.
fun an_app_cannot_vouch_for_the_zero_address() {
    let mut s = h::setup();
    register_app(&mut s);
    s.next_tx(STAFF);
    let (mut account, config, c) = take(&s);
    payment_intent::share_intent(by_app(&mut account, &config, @0x0, bank(1, &c), &c, s.ctx()));
    give(account, config, c);
    s.end();
}

// ═══ Cancelling ════════════════════════════════════════════════════════════

#[test]
/// `cancel` stamps its event with the clock, as every other lifecycle event
/// does, not with the start of the epoch, which can be up to a day earlier.
/// Opened and cancelled in one transaction, the two events carry the same
/// time, so nothing that orders events by time shows the cancel first.
fun cancel_stamps_its_event_with_the_clock() {
    let mut s = h::setup();
    s.next_tx(h::wallet());
    let (mut account, config, c) = take(&s);
    let intent = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
    payment_intent::cancel(intent, &c, s.ctx());
    let created = event::events_by_type<payment_intent::IntentCreated>();
    let canceled = event::events_by_type<payment_intent::IntentCanceled>();
    assert_eq!(created.length(), 1);
    assert_eq!(canceled.length(), 1);
    let (_, _, _, _, _, _, _, created_at) = payment_intent::unpack_intent_created_for_testing(created[0]);
    let (_, _, _, _, _, status, canceled_at) = payment_intent::unpack_intent_canceled_for_testing(canceled[0]);
    assert_eq!(status, STATUS_CANCELED);
    assert_eq!(created_at, c.timestamp_ms());
    assert_eq!(canceled_at, c.timestamp_ms());
    give(account, config, c);
    s.end();
}

#[test]
/// The owners can stop any pending payment in their account's name, including
/// one a staff member opened.
fun the_wallet_cancels_a_staff_intent() {
    let mut s = h::setup();
    register_app(&mut s);
    let id = staff_opens(&mut s, 1);
    s.next_tx(h::wallet());
    let (account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    payment_intent::cancel_by_wallet(&mut intent, &account, &c, s.ctx());
    assert_eq!(payment_intent::status(&intent), STATUS_CANCELED);
    let canceled = event::events_by_type<payment_intent::IntentCanceled>();
    assert_eq!(canceled.length(), 1);
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_NOT_PENDING)]
/// A cancelled intent stays cancelled: the wallet path cannot pay it after all.
fun a_cancelled_intent_cannot_be_settled() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    s.next_tx(h::wallet());
    {
        let (account, config, c) = take(&s);
        let mut intent = s.take_shared_by_id<PaymentIntent>(id);
        payment_intent::cancel_by_wallet(&mut intent, &account, &c, s.ctx());
        ts::return_shared(intent);
        give(account, config, c);
    };
    wallet_pays(&mut s, id);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// One owner is not the wallet and cannot cancel on its behalf.
fun an_owner_cannot_cancel_by_wallet() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    s.next_tx(h::owner_2());
    let (account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    payment_intent::cancel_by_wallet(&mut intent, &account, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = business_account::E_NOT_THE_WALLET)]
/// The staff maker is not the wallet either; its own cancel is `cancel_by_sender`.
fun the_staff_maker_cannot_cancel_by_wallet() {
    let mut s = h::setup();
    register_app(&mut s);
    let id = staff_opens(&mut s, 1);
    s.next_tx(STAFF);
    let (account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    payment_intent::cancel_by_wallet(&mut intent, &account, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_WRONG_BUSINESS_ACCOUNT)]
/// A wallet cancels its own account's intents only. Business B's wallet,
/// passing its own account, cannot cancel business A's payment.
fun a_wallet_cannot_cancel_another_accounts_intent() {
    let mut s = h::setup();
    let (a, b, wallet_b) = second_account(&mut s);
    s.next_tx(h::wallet());
    let id;
    {
        let mut account = s.take_shared_by_id<BusinessAccount>(a);
        let config = s.take_shared<ComplianceConfig>();
        let c = s.take_shared<Clock>();
        let intent = by_wallet(&mut account, &config, bank(1, &c), &c, s.ctx());
        id = object::id(&intent);
        payment_intent::share_intent(intent);
        give(account, config, c);
    };
    s.next_tx(wallet_b);
    let account_b = s.take_shared_by_id<BusinessAccount>(b);
    let c = s.take_shared<Clock>();
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    payment_intent::cancel_by_wallet(&mut intent, &account_b, &c, s.ctx());
    ts::return_shared(intent);
    ts::return_shared(c);
    ts::return_shared(account_b);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_NOT_PENDING)]
/// A settled intent cannot be "cancelled" afterwards; that would emit an
/// `IntentCanceled` for a payment that happened.
fun cancel_by_wallet_refuses_a_settled_intent() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    wallet_pays(&mut s, id);
    s.next_tx(h::wallet());
    let (account, config, c) = take(&s);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    payment_intent::cancel_by_wallet(&mut intent, &account, &c, s.ctx());
    ts::return_shared(intent);
    give(account, config, c);
    s.end();
}

#[test]
/// The maker can withdraw their own intent before it expires.
fun the_maker_cancels_by_sender() {
    let mut s = h::setup();
    register_app(&mut s);
    let id = staff_opens(&mut s, 1);
    s.next_tx(STAFF);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let c = s.take_shared<Clock>();
    payment_intent::cancel_by_sender(&mut intent, &c, s.ctx());
    assert_eq!(payment_intent::status(&intent), STATUS_CANCELED);
    ts::return_shared(c);
    ts::return_shared(intent);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_UNAUTHORIZED)]
/// A stranger who can name the shared intent cannot cancel it.
fun a_stranger_cannot_cancel_by_sender() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    s.next_tx(STRANGER);
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let c = s.take_shared<Clock>();
    payment_intent::cancel_by_sender(&mut intent, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(intent);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_UNAUTHORIZED)]
/// One owner is not the maker of a wallet intent, and cannot use the maker's
/// cancel to stop what the quorum opened.
fun an_owner_cannot_cancel_a_wallet_intent_by_sender() {
    let mut s = h::setup();
    let id = wallet_opens(&mut s, 1);
    s.next_tx(h::founder());
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let c = s.take_shared<Clock>();
    payment_intent::cancel_by_sender(&mut intent, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(intent);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_UNAUTHORIZED)]
/// `cancel_by_sender` is the maker's only. The wallet stops a staff intent
/// through `cancel_by_wallet`, which checks the account.
fun the_wallet_is_not_the_maker_of_a_staff_intent() {
    let mut s = h::setup();
    register_app(&mut s);
    let id = staff_opens(&mut s, 1);
    s.next_tx(h::wallet());
    let mut intent = s.take_shared_by_id<PaymentIntent>(id);
    let c = s.take_shared<Clock>();
    payment_intent::cancel_by_sender(&mut intent, &c, s.ctx());
    ts::return_shared(c);
    ts::return_shared(intent);
    s.end();
}

// ═══ The legacy path, and how it closes ════════════════════════════════════

#[test]
/// Before migration the deprecated path still works: maker opens, approver
/// approves, maker settles, and the confirmation says which path released it.
/// Without this, every legacy refusal below could pass for the wrong reason.
fun the_legacy_path_settles_before_migration() {
    let mut s = legacy_setup();
    legacy_open_bank(&mut s);
    legacy_approve(&mut s);
    legacy_confirm(&mut s);
    let confirmed = event::events_by_type<payment_intent::IntentConfirmed>();
    assert_eq!(confirmed.length(), 1);
    let (_, _, _, _, _, status, path, _) = payment_intent::unpack_intent_confirmed_for_testing(confirmed[0]);
    assert_eq!(status, STATUS_CONFIRMED);
    assert_eq!(path, payment_intent::path_legacy_approval());
    assert_eq!(path, 3);
    s.next_tx(h::recipient());
    {
        let paid = s.take_from_sender<Coin<USDC>>();
        assert_eq!(coin::value(&paid), h::amount());
        s.return_to_sender(paid);
        let intent = s.take_shared<PaymentIntent>();
        assert_eq!(payment_intent::status(&intent), STATUS_CONFIRMED);
        ts::return_shared(intent);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_LEGACY_CLOSED)]
/// Registering a wallet is migrating: the account can no longer open legacy
/// intents.
fun legacy_create_is_refused_once_a_wallet_is_registered() {
    let mut s = legacy_setup();
    h::register_wallet(&mut s);
    legacy_open_bank(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_LEGACY_CLOSED)]
/// An approver cannot approve a legacy intent opened before migration.
fun legacy_approve_is_refused_once_a_wallet_is_registered() {
    let mut s = legacy_setup();
    legacy_open_bank(&mut s);
    h::register_wallet(&mut s);
    legacy_approve(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_LEGACY_CLOSED)]
/// And an approval minted before migration cannot be cashed after it: once the
/// owners' multisig exists, one maker and one approver no longer move money.
fun legacy_confirm_is_refused_once_a_wallet_is_registered() {
    let mut s = legacy_setup();
    legacy_open_bank(&mut s);
    legacy_approve(&mut s);
    h::register_wallet(&mut s);
    legacy_confirm(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_LEGACY_DISABLED)]
/// Compliance may switch the legacy path off (subtractive). No new intents.
fun legacy_create_is_refused_after_compliance_disables_it() {
    let mut s = legacy_setup();
    compliance_disables_legacy(&mut s);
    legacy_open_bank(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_LEGACY_DISABLED)]
/// So may the cold multisig. No new approvals.
fun legacy_approve_is_refused_after_admin_disables_it() {
    let mut s = legacy_setup();
    legacy_open_bank(&mut s);
    admin_disables_legacy(&mut s);
    legacy_approve(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_LEGACY_DISABLED)]
/// And an approval already in hand cannot settle once the switch is off.
fun legacy_confirm_is_refused_after_compliance_disables_it() {
    let mut s = legacy_setup();
    legacy_open_bank(&mut s);
    legacy_approve(&mut s);
    compliance_disables_legacy(&mut s);
    legacy_confirm(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_LEGACY_DISABLED)]
/// The cold multisig's switch closes settlement too.
fun legacy_confirm_is_refused_after_admin_disables_it() {
    let mut s = legacy_setup();
    legacy_open_bank(&mut s);
    legacy_approve(&mut s);
    admin_disables_legacy(&mut s);
    legacy_confirm(&mut s);
    s.end();
}

#[test]
/// The switch is one-way. After it is off, every loosening the cold multisig
/// has (unpausing, relaxing parameters, adding an asset) leaves it off, and
/// switching it off again changes nothing. Migration, once declared complete,
/// stays complete.
fun the_legacy_switch_never_turns_back_on() {
    let mut s = legacy_setup();
    s.next_tx(h::founder());
    {
        let config = s.take_shared<ComplianceConfig>();
        assert!(compliance_config::legacy_enabled(&config));
        ts::return_shared(config);
    };
    compliance_disables_legacy(&mut s);
    s.next_tx(h::founder());
    {
        let mut config = s.take_shared<ComplianceConfig>();
        let admin = business_account::admin_cap_for_testing(s.ctx());
        assert!(!compliance_config::legacy_enabled(&config));
        compliance_config::admin_set_paused(&admin, &mut config, true);
        compliance_config::admin_set_paused(&admin, &mut config, false);
        compliance_config::admin_set_parameters(&admin, &mut config, 10_000, 600_000, 1_000, 1, 1);
        compliance_config::admin_disable_legacy(&admin, &mut config);
        assert!(!compliance_config::legacy_enabled(&config));
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(config);
    };
    register<SCAM>(&mut s, compliance_config::registry_asset());
    s.next_tx(h::founder());
    {
        let config = s.take_shared<ComplianceConfig>();
        assert!(!compliance_config::legacy_enabled(&config));
        ts::return_shared(config);
    };
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_SETTLEMENT_PAUSED)]
/// `confirm_with_approval` takes the config so it honours the pause: a pause
/// that stopped the v2 paths but not the deprecated one would stop nothing.
fun legacy_confirm_is_refused_while_paused() {
    let mut s = legacy_setup();
    legacy_open_bank(&mut s);
    legacy_approve(&mut s);
    compliance_pauses(&mut s);
    legacy_confirm(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_SETTLEMENT_PAUSED)]
/// The legacy create has "the same closing rules as `confirm_with_approval`",
/// and the first of those is the pause.
fun legacy_create_is_refused_while_paused() {
    let mut s = legacy_setup();
    compliance_pauses(&mut s);
    legacy_open_bank(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
/// The legacy path honours the asset registry: an approval for a USDC intent
/// cannot settle once USDC is off the list.
fun legacy_confirm_is_refused_once_the_asset_is_removed() {
    let mut s = legacy_setup();
    register<SCAM>(&mut s, compliance_config::registry_asset());
    legacy_open_bank(&mut s);
    legacy_approve(&mut s);
    admin_removes<USDC>(&mut s, compliance_config::registry_asset());
    legacy_confirm(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_ASSET_NOT_ACCEPTED)]
/// Nor can a legacy intent be opened in a removed asset.
fun legacy_create_is_refused_once_the_asset_is_removed() {
    let mut s = legacy_setup();
    register<SCAM>(&mut s, compliance_config::registry_asset());
    compliance_removes<USDC>(&mut s, compliance_config::registry_asset());
    legacy_open_bank(&mut s);
    s.end();
}

#[test]
#[expected_failure(abort_code = compliance_config::E_LAST_ASSET)]
/// Why the tests above add a second asset first: the last accepted asset
/// cannot be removed, because `pause` is the halt and an empty list could only
/// be refilled after 24 hours.
fun the_last_accepted_asset_cannot_be_removed() {
    let mut s = legacy_setup();
    admin_removes<USDC>(&mut s, compliance_config::registry_asset());
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INVALID_KIND)]
/// The legacy path refuses cross-chain intents, so it cannot even open one.
fun legacy_create_refuses_the_cross_chain_kind() {
    let mut s = legacy_setup();
    legacy_open(&mut s, payment_intent::kind_cross_chain_wallet(), FIVE_MINUTES);
    s.end();
}

#[test]
#[expected_failure(abort_code = payment_intent::E_INVALID_KIND)]
/// Nor an intent of no kind.
fun legacy_create_refuses_kind_zero() {
    let mut s = legacy_setup();
    legacy_open(&mut s, 0, FIVE_MINUTES);
    s.end();
}

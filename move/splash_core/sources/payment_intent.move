/// PaymentIntent — atomic payment flow with sender-bound authorization.
///
/// Replaces the Phase 1 scaffold which accepted a spoofable `sender`
/// argument (C-03), used the slow `epoch_timestamp_ms` for expiration
/// (H-01), allowed any third party to confirm a shared intent (H-02),
/// and over-charged the caller by forwarding the entire coin even when
/// it exceeded the requested amount (H-03).
///
/// Design:
///   * `sender` (the maker) is set by the module, never a free argument: the
///     transaction's sender, or the maker a registered settlement app vouches
///     for.
///   * Expiration uses `&Clock` (real wall-clock ms), not epoch boundaries.
///   * Overpay is refunded to whoever paid it.
///   * Named abort codes registered in `lib/server/sui-settlement.ts`.
///   * Events carry a 32-byte commitment, never the payment (WS5). What an
///     event carries freezes at publish; see docs/commitments.md.
///
/// ─── v2: the three paths that pay an account's intent ───────────────────────
///
///   * `confirm_from_business_wallet` (and `_balance`, and the cross-chain
///     form): the business multisig signs. Its signature IS the approval; the
///     protocol enforces it before this module runs.
///   * `settle_from_app` (and the cross-chain form): a registered settlement
///     app, which is `splash_spend`, settles funds it drew under an app-bound
///     allowance from the business wallet and checked against the business's
///     `SpendPolicy`.
///   * `confirm_with_approval`: the legacy per-person approval path,
///     DEPRECATED. It closes for an account once that account registers a
///     business wallet, and for everyone once governance or compliance turns
///     `legacy_enabled` off.
///
/// There is no fourth. The unbound path (`create_payment_intent`, `create`,
/// `confirm_payment_intent`) let any signer pay a recipient out of its own
/// coin; on the testnet flow that signer was Splash's operator, which D3 rules
/// out, and an additive upgrade policy could never take it away again. So it
/// is not in this package. See docs/v2/phase1-move-design.md.
///
/// Every path checks that settlement is not paused, that the asset is still
/// accepted, and the account's KYB, freeze flags and ceilings. An intent lives
/// at most 30 days. The v2 settle paths take `settle_by_ms`, the quote's own
/// deadline, so a transaction signed against a quote cannot be submitted after
/// the quote lapsed.
module splash_core::payment_intent;

use splash_core::business_account::{Self, BusinessAccount, PayoutApproval};
use splash_core::compliance_config::{Self, ComplianceConfig};
use std::string::String;
use std::type_name;
use sui::balance::{Self, Balance};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::derived_object;
use sui::event;

// ─── Abort codes ───────────────────────────────────────────────────────────
const E_NOT_PENDING:           u64 = 400;
const E_EXPIRED:               u64 = 401;
const E_INSUFFICIENT_PAYMENT:  u64 = 402;
const E_NOT_YET_EXPIRED:       u64 = 403;
const E_UNAUTHORIZED:          u64 = 404;
const E_INVALID_AMOUNT:        u64 = 405;
const E_INVALID_RECIPIENT:     u64 = 406;
const E_EMPTY_TARGET_CURRENCY: u64 = 407;
const E_INVALID_FX_RATE:       u64 = 408;
const E_STILL_PENDING:         u64 = 412;
/// A module other than `audit_anchor` tried to consume a `SettleReceipt`.
const E_UNAUTHORIZED_RECEIPT_CONSUMER: u64 = 413;
/// The coin type offered does not match the asset the intent was created for.
const E_WRONG_SETTLEMENT_ASSET: u64 = 414;
/// `confirm_with_approval` on an intent that is not bound to any account.
const E_NOT_ACCOUNT_BOUND: u64 = 416;
/// The account passed is not the account the intent was opened against.
const E_WRONG_BUSINESS_ACCOUNT: u64 = 417;
/// The initiator is neither an owner nor an approver of the account.
const E_NOT_A_MEMBER: u64 = 418;
/// The account is frozen, or not KYB-verified.
const E_ACCOUNT_NOT_PAYABLE: u64 = 419;
/// WS5. A commitment is thirty-two bytes, computed off-chain as
/// blake2b256(tag || bcs(payload) || salt) — see docs/commitments.md. Any
/// other length is a mis-encoding, never a commitment, and is refused before
/// an intent exists.
const E_BAD_COMMITMENT:        u64 = 420;

// ─── v2 ────────────────────────────────────────────────────────────────────
/// `expires_at` is not in the future, or is more than 30 days away.
const E_BAD_EXPIRY: u64 = 421;
/// `kind` is not BANK_PAYOUT, SPLASH_BUSINESS or WALLET (or CROSS_CHAIN_WALLET
/// on a cross-chain path), or this path does not take that kind.
const E_INVALID_KIND: u64 = 422;
/// The destination domain does not fit: a cross-chain payment lands anywhere
/// but domain 8 (Sui).
const E_BAD_DOMAIN: u64 = 423;
/// The rail commitment is not 32 bytes.
const E_BAD_RAIL_COMMITMENT: u64 = 424;
/// A cross-chain intent settles only through a cross-chain path, which hands
/// the coin to a bridge adapter instead of to an address.
const E_CROSS_CHAIN_ONLY: u64 = 425;
/// A cross-chain path was given an intent that lands on Sui.
const E_NOT_CROSS_CHAIN: u64 = 426;
/// Funds drawn under a spending rule must equal the intent exactly.
const E_EXACT_AMOUNT_REQUIRED: u64 = 427;
/// A bank payout names its beneficiary by a 32-byte commitment; other kinds
/// name none.
const E_BENEFICIARY_REQUIRED: u64 = 428;
/// A payment reference is a 32-byte commitment over the business's own
/// invoice or payment id.
const E_BAD_PAYMENT_REF: u64 = 429;
/// The quote this transaction was signed against has lapsed.
const E_SETTLE_BY_PASSED: u64 = 430;
/// This account has a business wallet, so the legacy approval path is closed
/// for it.
const E_LEGACY_CLOSED: u64 = 431;
/// The coin handed to the bridge adapter is not the coin the settlement
/// released, or not its type or amount.
const E_WRONG_BRIDGE_COIN: u64 = 432;
/// The CCTP fee ceiling would take the whole payment.
const E_BAD_BRIDGE_FEE: u64 = 433;

/// The only module permitted to destroy a `SettleReceipt`. Bound by module name
/// because Move forbids the circular import that naming the type would require —
/// see `unpack_settle_receipt`.
const ANCHOR_MODULE: vector<u8> = b"audit_anchor";

// ─── Constants ─────────────────────────────────────────────────────────────
/// The longest an intent may stay open: 30 days (D11). Its creator picks
/// `expires_at` inside that.
const MAX_INTENT_LIFETIME_MS: u64 = 2_592_000_000;
/// Length of a commitment in bytes. The off-chain library
/// (lib/evidence/commitment.ts) produces exactly this; Move checks the length
/// and carries the bytes, and never sees the payload or the salt behind them.
const COMMITMENT_BYTES: u64 = 32;
/// A cross-chain payment is USDC to USDC: no conversion, so its rate is 1.
const UNIT_FX_RATE: u64 = 1_000_000;

// ─── Status constants ──────────────────────────────────────────────────────
const STATUS_PENDING:   u8 = 0;
const STATUS_CONFIRMED: u8 = 1;
const STATUS_EXPIRED:   u8 = 2;
const STATUS_CANCELED:  u8 = 3;

// ─── Kinds (v2). Zero is never a kind, so a missing value cannot read as one.
const KIND_BANK_PAYOUT: u8 = 1;
const KIND_SPLASH_BUSINESS: u8 = 2;
const KIND_WALLET: u8 = 3;
const KIND_CROSS_CHAIN_WALLET: u8 = 4;

/// Sui's CCTP domain. Every payment that is not cross-chain lands here.
const SUI_DOMAIN: u32 = 8;

// ─── Settlement paths, as `IntentConfirmed.path` reports them ──────────────
const PATH_BUSINESS_WALLET: u8 = 1;
const PATH_SETTLEMENT_APP: u8 = 2;
const PATH_LEGACY_APPROVAL: u8 = 3;

public struct PaymentIntent has key {
    id: UID,
    /// The business account this intent draws authority from. `none` only
    /// on an intent no v2 or legacy path can settle; every create in this
    /// package binds one.
    account: Option<ID>,
    /// The maker: who opened the intent.
    sender: address,
    /// Where the funds land. For a cross-chain intent, CCTP's 32-byte
    /// `mint_recipient` on `destination_domain`.
    recipient: address,
    /// v2: a 32-byte beneficiary commitment (`splash:beneficiary:v1`) on a
    /// bank payout, empty otherwise.
    beneficiary_ref: vector<u8>,
    amount_usd: u64,
    target_currency: String,
    /// Fully-qualified type of the coin this intent must be settled in, e.g.
    /// `…::usdc::USDC`. Bound at creation and asserted at confirmation.
    ///
    /// Without this, a settle path generic over `Coin<T>` would let ANY coin
    /// type satisfy an intent, and a payer could discharge a 100 USDC
    /// obligation with 100_000_000 units of a worthless token.
    settlement_asset: String,
    /// USD→local FX rate scaled by 1e6, as quoted when the intent opened.
    fx_rate_usd_local: u64,
    created_at: u64,
    created_epoch: u64,
    expires_at: u64,
    status: u8,
    /// WS5. The 32-byte commitment every lifecycle event of this intent
    /// carries: blake2b256(tag || bcs(payload) || salt), computed off-chain.
    /// The payload and the salt live in the Seal bundle, never here.
    commitment: vector<u8>,
    /// v2. BANK_PAYOUT, SPLASH_BUSINESS, WALLET or CROSS_CHAIN_WALLET.
    kind: u8,
    /// v2. The CCTP domain the funds land on: 8 for Sui.
    destination_domain: u32,
    /// v2. A 32-byte commitment (`splash:rail:v1`) to the rail and the
    /// partner's reference for this payment. See docs/commitments.md.
    rail_commitment: vector<u8>,
    /// v2. The business's own reference for the payment, 32 bytes. The
    /// intent's UID is derived from it, so one reference opens one intent.
    /// Empty on a legacy intent.
    payment_ref: vector<u8>,
    /// v2, cross-chain only: the most CCTP may take as its fee, in minor units.
    bridge_max_fee: u64,
    /// v2, cross-chain only: the finality CCTP must wait for on Sui.
    bridge_min_finality: u32,
}

/// A cross-chain payment the coin has been released for but not yet burned.
///
/// No abilities: it cannot be stored, dropped or copied, so the transaction
/// that settles a cross-chain intent cannot finish until a registered bridge
/// adapter discharges it, and the adapter is the code that burns the coin
/// through CCTP with exactly this domain, recipient, fee ceiling and finality.
/// Until an adapter is registered (the 24-hour path), a cross-chain intent
/// cannot settle at all.
///
/// The coin travels beside the obligation, so no struct in this package holds
/// value (`check:core`), but the obligation names it by ID and discharge
/// checks it: the transaction cannot keep the business's coin and burn
/// another.
public struct BridgeObligation {
    intent_id: ID,
    coin_id: ID,
    asset: String,
    amount: u64,
    destination_domain: u32,
    mint_recipient: address,
    max_fee: u64,
    min_finality_threshold: u32,
}

/// The key a v2 intent's UID is derived from, under its account: the
/// business's own reference for the payment.
public struct PaymentRef(vector<u8>) has copy, drop, store;

/// Non-droppable receipt that must be consumed by audit_anchor::anchor.
///
/// It carries what the anchor event needs and nothing the event must not
/// carry: the intent, its commitment, and when it settled.
public struct SettleReceipt {
    intent_id: ID,
    commitment: vector<u8>,
    settled_at: u64,
}

// ─── Events ────────────────────────────────────────────────────────────────

/// WS5. Event structs freeze at publish, so what they carry is decided once.
/// Every lifecycle event carries the intent, the commitment the intent was
/// opened with, the status it is now in, and the clock — and nothing about who
/// paid whom how much. Whoever the Seal policy admits to the bundle can open
/// the commitment; see docs/commitments.md.
///
/// v2 adds what an indexer needs without reading the intent, which
/// `delete_finalized` may already have removed: the settlement asset's type
/// name, the kind, and the rail commitment. None of these is an amount, an
/// address or the account.
public struct IntentCreated has copy, drop {
    intent_id: ID,
    commitment: vector<u8>,
    rail_commitment: vector<u8>,
    settlement_asset: String,
    kind: u8,
    status: u8,
    expires_at_ms: u64,
    timestamp_ms: u64,
}

/// `path` is which settlement path released it: 1 business wallet,
/// 2 settlement app (a spending rule), 3 legacy approval. On a cross-chain
/// intent, CONFIRMED means burned for CCTP; the mint completes off Sui.
public struct IntentConfirmed has copy, drop {
    intent_id: ID,
    commitment: vector<u8>,
    rail_commitment: vector<u8>,
    settlement_asset: String,
    kind: u8,
    status: u8,
    path: u8,
    timestamp_ms: u64,
}

/// `status` is the reason: STATUS_EXPIRED (2) or STATUS_CANCELED (3).
public struct IntentCanceled has copy, drop {
    intent_id: ID,
    commitment: vector<u8>,
    rail_commitment: vector<u8>,
    settlement_asset: String,
    kind: u8,
    status: u8,
    timestamp_ms: u64,
}

fun emit_created(intent: &PaymentIntent, now: u64) {
    event::emit(IntentCreated {
        intent_id: object::id(intent),
        commitment: intent.commitment,
        rail_commitment: intent.rail_commitment,
        settlement_asset: intent.settlement_asset,
        kind: intent.kind,
        status: STATUS_PENDING,
        expires_at_ms: intent.expires_at,
        timestamp_ms: now,
    });
}

fun emit_confirmed(intent: &PaymentIntent, path: u8, now: u64) {
    event::emit(IntentConfirmed {
        intent_id: object::id(intent),
        commitment: intent.commitment,
        rail_commitment: intent.rail_commitment,
        settlement_asset: intent.settlement_asset,
        kind: intent.kind,
        status: STATUS_CONFIRMED,
        path,
        timestamp_ms: now,
    });
}

fun emit_canceled(intent: &PaymentIntent, status: u8, now: u64) {
    event::emit(IntentCanceled {
        intent_id: object::id(intent),
        commitment: intent.commitment,
        rail_commitment: intent.rail_commitment,
        settlement_asset: intent.settlement_asset,
        kind: intent.kind,
        status,
        timestamp_ms: now,
    });
}

/// The one check Move makes on a commitment. The bytes are opaque here.
fun assert_commitment(commitment: &vector<u8>) {
    assert!(commitment.length() == COMMITMENT_BYTES, E_BAD_COMMITMENT);
}

fun assert_rail_commitment(rail_commitment: &vector<u8>) {
    assert!(rail_commitment.length() == COMMITMENT_BYTES, E_BAD_RAIL_COMMITMENT);
}

/// `now < expires_at <= now + 30 days`. At `expires_at` exactly, the intent
/// is already expired, matching every settle path's `now < expires_at`.
fun assert_lifetime(expires_at: u64, now: u64) {
    assert!(expires_at > now, E_BAD_EXPIRY);
    assert!(expires_at - now <= MAX_INTENT_LIFETIME_MS, E_BAD_EXPIRY);
}

/// A kind that lands on Sui: bank payout, Splash business or wallet.
fun assert_sui_kind(kind: u8) {
    assert!(kind >= KIND_BANK_PAYOUT && kind <= KIND_WALLET, E_INVALID_KIND);
}

/// Paying an address on Sui needs an intent that lands on Sui.
fun assert_lands_on_sui(intent: &PaymentIntent) {
    assert!(intent.kind != KIND_CROSS_CHAIN_WALLET, E_CROSS_CHAIN_ONLY);
    assert!(intent.destination_domain == SUI_DOMAIN, E_CROSS_CHAIN_ONLY);
}

fun assert_cross_chain(intent: &PaymentIntent) {
    assert!(intent.kind == KIND_CROSS_CHAIN_WALLET, E_NOT_CROSS_CHAIN);
    assert!(intent.destination_domain != SUI_DOMAIN, E_NOT_CROSS_CHAIN);
}

// ─── Legacy (DEPRECATED): intents opened by an owner or approver ───────────

/// The legacy path is open only while compliance has not switched it off, the
/// account has no business wallet (registering one is migrating), and
/// settlement is not paused. Its create, approve and confirm all check it.
fun assert_legacy_open(account: &BusinessAccount, config: &ComplianceConfig) {
    compliance_config::assert_legacy_enabled(config);
    assert!(!business_account::has_wallet(account), E_LEGACY_CLOSED);
    compliance_config::assert_active(config);
}

/// Create an intent that draws its authority from a business account, on
/// the DEPRECATED per-person path.
///
/// The initiator must be an owner or an approver of that account — a shared
/// object anyone can name would otherwise let a stranger open intents in a
/// tenant's name, and even though they could never be approved, the tenant's
/// event stream would fill with payments they did not propose.
///
/// Verification and both freeze flags are checked HERE as well as at approval
/// and at settlement. That is deliberate redundancy on the cheapest step: a
/// frozen account should not accumulate a queue of intents waiting for the
/// thaw.
public fun create_payment_intent_for_account<T>(
    account: &BusinessAccount,
    config: &ComplianceConfig,
    recipient: address,
    amount_usd: u64,
    target_currency: String,
    fx_rate_usd_local: u64,
    commitment: vector<u8>,
    kind: u8,
    rail_commitment: vector<u8>,
    expires_at: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_legacy_open(account, config);
    let maker = tx_context::sender(ctx);
    assert!(
        business_account::is_owner(account, maker) || business_account::is_approver(account, maker),
        E_NOT_A_MEMBER,
    );
    assert!(business_account::is_verified(account), E_ACCOUNT_NOT_PAYABLE);
    assert!(!business_account::is_frozen(account), E_ACCOUNT_NOT_PAYABLE);
    let asset = compliance_config::type_string<T>();
    compliance_config::assert_asset_accepted(config, &asset);
    assert!(amount_usd > 0, E_INVALID_AMOUNT);
    assert!(recipient != @0x0, E_INVALID_RECIPIENT);
    assert!(std::string::length(&target_currency) > 0, E_EMPTY_TARGET_CURRENCY);
    assert!(fx_rate_usd_local > 0, E_INVALID_FX_RATE);
    assert_commitment(&commitment);
    assert_rail_commitment(&rail_commitment);
    assert_sui_kind(kind);

    let now = clock::timestamp_ms(clock);
    assert_lifetime(expires_at, now);

    let intent = PaymentIntent {
        id: object::new(ctx),
        account: option::some(object::id(account)),
        sender: maker,
        recipient,
        beneficiary_ref: vector[],
        amount_usd,
        target_currency,
        settlement_asset: asset,
        fx_rate_usd_local,
        created_at: now,
        created_epoch: ctx.epoch(),
        expires_at,
        status: STATUS_PENDING,
        commitment,
        kind,
        destination_domain: SUI_DOMAIN,
        rail_commitment,
        payment_ref: vector[],
        bridge_max_fee: 0,
        bridge_min_finality: 0,
    };

    emit_created(&intent, now);

    transfer::share_object(intent);
}

/// Approve a payout, as an approver of the account the intent is bound to.
/// DEPRECATED, with the rest of the legacy path.
///
/// Everything the approval binds to is read off the intent: its id, its
/// amount, and the maker — so an approver cannot be handed a transaction that
/// approves one invoice while naming another's number, and cannot mis-address
/// the approval to someone who was not the intent's opener. The four-eyes
/// check, the approver-set check, verification and the freeze flags are in
/// `business_account::mint_approval`, which owns those sets.
///
/// The intent's own state is checked here, where it is visible: approving a
/// cancelled or expired intent produces an approval that can never settle, and
/// silently minting one is worse than refusing.
public fun approve_payout(
    intent: &PaymentIntent,
    account: &BusinessAccount,
    config: &ComplianceConfig,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_legacy_open(account, config);
    assert!(intent.account.is_some(), E_NOT_ACCOUNT_BOUND);
    assert!(*intent.account.borrow() == object::id(account), E_WRONG_BUSINESS_ACCOUNT);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);
    assert!(clock::timestamp_ms(clock) < intent.expires_at, E_EXPIRED);
    assert_lands_on_sui(intent);

    business_account::mint_approval(
        account,
        object::id(intent),
        intent.sender,
        intent.amount_usd,
        intent.commitment,
        clock,
        ctx,
    );
}

/// Confirm an intent bound to a business account, releasing an approval.
///
/// DEPRECATED (v2). This is the legacy per-person path: the maker pays out of
/// their own coin with an approver's approval. It now honours the pause and
/// the asset registry, refuses cross-chain intents, and closes for an account
/// once it registers a business wallet, and for everyone once
/// `legacy_enabled` is off. See SECURITY.md.
///
/// The approval carries its own account, intent, amount and authority epoch,
/// and `business_account::consume_approval` checks every one of them plus the
/// freeze flags, KYB status and the 24h ceiling. This function's own job is
/// narrow: prove the caller is the maker the intent was opened by, and prove
/// the account passed is the account the intent named.
public fun confirm_with_approval<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    approval: PayoutApproval,
    mut payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    assert_legacy_open(account, config);
    assert!(intent.account.is_some(), E_NOT_ACCOUNT_BOUND);
    assert!(*intent.account.borrow() == object::id(account), E_WRONG_BUSINESS_ACCOUNT);
    // The maker. The approval is transferred to an address named by the
    // APPROVER, and an approver naming the wrong address must not be able to
    // hand release authority to someone the intent never authorised.
    let caller = tx_context::sender(ctx);
    assert!(caller == intent.sender, E_UNAUTHORIZED);

    // The approval first, as before v2, so its own refusals (stale, expired,
    // wrong intent) keep their codes.
    business_account::consume_approval(
        account,
        approval,
        object::id(intent),
        intent.amount_usd,
        intent.commitment,
        clock,
    );

    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);
    let now = clock::timestamp_ms(clock);
    assert!(now < intent.expires_at, E_EXPIRED);
    assert_lands_on_sui(intent);
    assert!(compliance_config::type_string<T>() == intent.settlement_asset, E_WRONG_SETTLEMENT_ASSET);
    compliance_config::assert_active(config);
    compliance_config::assert_asset_accepted(config, &intent.settlement_asset);
    assert!(coin::value(&payment) >= intent.amount_usd, E_INSUFFICIENT_PAYMENT);

    let paid = coin::split(&mut payment, intent.amount_usd, ctx);
    deliver_coin(intent, paid);
    // The legacy refund goes back to the maker, who paid it.
    refund_coin(payment, caller);

    intent.status = STATUS_CONFIRMED;
    emit_confirmed(intent, PATH_LEGACY_APPROVAL, now);
    receipt(intent, now)
}

// ─── v2: intents opened by the business wallet or a registered app ─────────
//
// Each returns the intent BY VALUE. The same transaction can then settle it,
// anchor the receipt, and either `delete_finalized` it or `share_intent` it
// for approvals that come later — so the owners sign a whole batch once.

/// Open an intent in an account's name, signed by the account's wallet.
public fun create_for_wallet<T>(
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
    let wallet = business_account::assert_wallet(account, ctx);
    assert_sui_kind(kind);
    open<T>(
        account, config, wallet, payment_ref, recipient, beneficiary_ref, amount, target_currency,
        fx_rate_usd_local, commitment, kind, SUI_DOMAIN, rail_commitment, 0, 0, expires_at, clock, ctx,
    )
}

/// Open a cross-chain intent in an account's name, signed by its wallet.
///
/// `mint_recipient` is CCTP's 32-byte recipient on `destination_domain`: an
/// EVM address left-padded, or on Solana the recipient's USDC token account,
/// never their wallet key. `bridge_max_fee` and `bridge_min_finality` bound
/// what the bridge adapter may ask CCTP for; they are fixed here, where the
/// owners sign them, not chosen later by whoever builds the burn.
public fun create_cross_chain_for_wallet<T>(
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
    let wallet = business_account::assert_wallet(account, ctx);
    assert!(destination_domain != SUI_DOMAIN, E_BAD_DOMAIN);
    open<T>(
        account, config, wallet, payment_ref, mint_recipient, vector[], amount, b"USDC".to_string(),
        UNIT_FX_RATE, commitment, KIND_CROSS_CHAIN_WALLET, destination_domain, rail_commitment,
        bridge_max_fee, bridge_min_finality, expires_at, clock, ctx,
    )
}

/// Open an intent in an account's name for `maker`, vouched for by a
/// registered settlement app.
///
/// `W` is the app's witness. Only the app's own module can construct one, and
/// only a type on `ComplianceConfig.settlement_apps` is accepted — an entry
/// that took 24 hours' public notice to get there. `splash_spend` calls this
/// after checking that `maker` is one of the business's staff and that the
/// destination is on its verified list.
public fun create_for_app<T, W: drop>(
    _witness: W,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    maker: address,
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
    compliance_config::assert_settlement_app<W>(config);
    assert!(maker != @0x0, E_INVALID_RECIPIENT);
    assert_sui_kind(kind);
    open<T>(
        account, config, maker, payment_ref, recipient, beneficiary_ref, amount, target_currency,
        fx_rate_usd_local, commitment, kind, SUI_DOMAIN, rail_commitment, 0, 0, expires_at, clock, ctx,
    )
}

/// The cross-chain form of `create_for_app`.
public fun create_cross_chain_for_app<T, W: drop>(
    _witness: W,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    maker: address,
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
    compliance_config::assert_settlement_app<W>(config);
    assert!(maker != @0x0, E_INVALID_RECIPIENT);
    assert!(destination_domain != SUI_DOMAIN, E_BAD_DOMAIN);
    open<T>(
        account, config, maker, payment_ref, mint_recipient, vector[], amount, b"USDC".to_string(),
        UNIT_FX_RATE, commitment, KIND_CROSS_CHAIN_WALLET, destination_domain, rail_commitment,
        bridge_max_fee, bridge_min_finality, expires_at, clock, ctx,
    )
}

fun open<T>(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    maker: address,
    payment_ref: vector<u8>,
    recipient: address,
    beneficiary_ref: vector<u8>,
    amount: u64,
    target_currency: String,
    fx_rate_usd_local: u64,
    commitment: vector<u8>,
    kind: u8,
    destination_domain: u32,
    rail_commitment: vector<u8>,
    bridge_max_fee: u64,
    bridge_min_finality: u32,
    expires_at: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    let asset = compliance_config::type_string<T>();
    compliance_config::assert_asset_accepted(config, &asset);
    // Refused here as well as at settlement, so a stopped account does not
    // collect a queue of intents waiting for the thaw.
    assert!(business_account::is_verified(account), E_ACCOUNT_NOT_PAYABLE);
    assert!(!business_account::is_frozen(account), E_ACCOUNT_NOT_PAYABLE);
    assert!(amount > 0, E_INVALID_AMOUNT);
    assert!(recipient != @0x0, E_INVALID_RECIPIENT);
    assert!(std::string::length(&target_currency) > 0, E_EMPTY_TARGET_CURRENCY);
    assert!(fx_rate_usd_local > 0, E_INVALID_FX_RATE);
    assert_commitment(&commitment);
    assert_rail_commitment(&rail_commitment);
    assert!(payment_ref.length() == COMMITMENT_BYTES, E_BAD_PAYMENT_REF);
    // A beneficiary is named by commitment only, and only on a bank payout,
    // which is the case a spending rule checks it against.
    if (kind == KIND_BANK_PAYOUT) {
        assert!(beneficiary_ref.length() == COMMITMENT_BYTES, E_BENEFICIARY_REQUIRED);
    } else {
        assert!(beneficiary_ref.is_empty(), E_BENEFICIARY_REQUIRED);
    };
    // Nothing but a cross-chain intent carries bridge parameters, and its fee
    // ceiling must leave something to arrive.
    if (kind == KIND_CROSS_CHAIN_WALLET) {
        assert!(bridge_max_fee < amount, E_BAD_BRIDGE_FEE);
    };

    let now = clock::timestamp_ms(clock);
    assert_lifetime(expires_at, now);

    let intent = PaymentIntent {
        // One reference, one intent, for ever: a second claim aborts, and a
        // claimed key stays claimed after the intent is deleted, so a retried
        // or double-submitted create can never open a second payable intent
        // for one invoice.
        id: derived_object::claim(business_account::uid_mut(account), PaymentRef(payment_ref)),
        account: option::some(object::id(account)),
        sender: maker,
        recipient,
        beneficiary_ref,
        amount_usd: amount,
        target_currency,
        settlement_asset: asset,
        fx_rate_usd_local,
        created_at: now,
        created_epoch: ctx.epoch(),
        expires_at,
        status: STATUS_PENDING,
        commitment,
        kind,
        destination_domain,
        rail_commitment,
        payment_ref,
        bridge_max_fee,
        bridge_min_finality,
    };
    emit_created(&intent, now);
    intent
}

/// Share an intent a v2 create returned, so others can approve or pay it in
/// later transactions.
public fun share_intent(intent: PaymentIntent) {
    transfer::share_object(intent);
}

// ─── v2 settlement ─────────────────────────────────────────────────────────

/// Pay an account's intent from the business wallet, in a coin.
///
/// The sender must be the account's wallet: the business multisig. Its
/// signature is the approval, and the protocol enforced it before this ran.
/// Whoever opened the intent (the wallet, or a staff member under a spending
/// rule), the owners can pay it themselves. An overpayment goes back to the
/// wallet's address balance.
public fun confirm_from_business_wallet<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    mut payment: Coin<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    let wallet = business_account::assert_wallet(account, ctx);
    assert_lands_on_sui(intent);
    assert!(coin::value(&payment) >= intent.amount_usd, E_INSUFFICIENT_PAYMENT);
    let now = settle_for_account<T>(intent, account, config, PATH_BUSINESS_WALLET, settle_by_ms, clock);

    let paid = coin::split(&mut payment, intent.amount_usd, ctx);
    deliver_coin(intent, paid);
    refund_coin(payment, wallet);
    receipt(intent, now)
}

/// Pay an account's intent from the business wallet's address balance.
///
/// Takes the `Balance<T>` a funds-withdrawal input redeems to
/// (`balance::redeem_funds`), so the transaction needs no coin selection.
public fun confirm_from_business_wallet_balance<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    mut payment: Balance<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    let wallet = business_account::assert_wallet(account, ctx);
    assert_lands_on_sui(intent);
    assert!(payment.value() >= intent.amount_usd, E_INSUFFICIENT_PAYMENT);
    let now = settle_for_account<T>(intent, account, config, PATH_BUSINESS_WALLET, settle_by_ms, clock);

    let paid = payment.split(intent.amount_usd);
    deliver_balance(intent, paid, ctx);
    refund_balance(payment, wallet);
    receipt(intent, now)
}

/// Pay an account's cross-chain intent from the business wallet.
///
/// Nothing is sent to an address here. The exact amount comes back as a coin,
/// beside a `BridgeObligation` naming that coin, which only a registered
/// bridge adapter can discharge: the same transaction must burn this coin
/// through CCTP to the intent's domain and recipient, or abort.
public fun confirm_cross_chain_from_business_wallet<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    mut payment: Coin<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (SettleReceipt, Coin<T>, BridgeObligation) {
    let wallet = business_account::assert_wallet(account, ctx);
    assert_cross_chain(intent);
    assert!(coin::value(&payment) >= intent.amount_usd, E_INSUFFICIENT_PAYMENT);
    let now = settle_for_account<T>(intent, account, config, PATH_BUSINESS_WALLET, settle_by_ms, clock);

    let to_bridge = coin::split(&mut payment, intent.amount_usd, ctx);
    refund_coin(payment, wallet);
    let obligation = obligation(intent, object::id(&to_bridge));
    (receipt(intent, now), to_bridge, obligation)
}

/// Settle an account's intent with funds a registered settlement app drew.
///
/// `W` is the app's witness, accepted only from a type on
/// `ComplianceConfig.settlement_apps`. The app is `splash_spend`, which drew
/// `funds` under an app-bound allowance from the business wallet and checked
/// them against the business's `SpendPolicy` before calling this. The amount
/// must be exact: there is nowhere to "refund" allowance money to without
/// moving it twice.
public fun settle_from_app<T, W: drop>(
    _witness: W,
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    funds: Balance<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    compliance_config::assert_settlement_app<W>(config);
    assert_lands_on_sui(intent);
    assert!(funds.value() == intent.amount_usd, E_EXACT_AMOUNT_REQUIRED);
    let now = settle_for_account<T>(intent, account, config, PATH_SETTLEMENT_APP, settle_by_ms, clock);

    deliver_balance(intent, funds, ctx);
    receipt(intent, now)
}

/// The cross-chain form of `settle_from_app`: the coin comes back for a
/// registered bridge adapter to burn, beside the obligation that names it.
public fun settle_cross_chain_from_app<T, W: drop>(
    _witness: W,
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    funds: Balance<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (SettleReceipt, Coin<T>, BridgeObligation) {
    compliance_config::assert_settlement_app<W>(config);
    assert_cross_chain(intent);
    assert!(funds.value() == intent.amount_usd, E_EXACT_AMOUNT_REQUIRED);
    let now = settle_for_account<T>(intent, account, config, PATH_SETTLEMENT_APP, settle_by_ms, clock);

    let to_bridge = coin::from_balance(funds, ctx);
    let obligation = obligation(intent, object::id(&to_bridge));
    (receipt(intent, now), to_bridge, obligation)
}

/// Discharge a bridge obligation. Only a registered bridge adapter can, and
/// only with the very coin the settlement released, in its type and amount.
/// It gets back exactly what it must burn: the amount, the domain, the
/// recipient, the fee ceiling and the finality threshold.
public fun discharge_bridge_obligation<W: drop, T>(
    _witness: W,
    config: &ComplianceConfig,
    obligation: BridgeObligation,
    coin: &Coin<T>,
): (ID, u64, u32, address, u64, u32) {
    compliance_config::assert_bridge_adapter<W>(config);
    let BridgeObligation {
        intent_id,
        coin_id,
        asset,
        amount,
        destination_domain,
        mint_recipient,
        max_fee,
        min_finality_threshold,
    } = obligation;
    assert!(object::id(coin) == coin_id, E_WRONG_BRIDGE_COIN);
    assert!(compliance_config::type_string<T>() == asset, E_WRONG_BRIDGE_COIN);
    assert!(coin::value(coin) == amount, E_WRONG_BRIDGE_COIN);
    (intent_id, amount, destination_domain, mint_recipient, max_fee, min_finality_threshold)
}

/// The checks every v2 settlement makes, and the state change.
///
/// The account named is the account the intent is bound to; the intent is
/// pending, unexpired and in this coin; the quote it was signed against has
/// not lapsed; settlement is not paused and the asset is still accepted; and
/// the account passes KYB, both freeze flags and its ceilings, which are
/// charged here (the 99 USDC floor on bank payouts only).
fun settle_for_account<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    path: u8,
    settle_by_ms: u64,
    clock: &Clock,
): u64 {
    assert!(intent.account.is_some(), E_NOT_ACCOUNT_BOUND);
    assert!(*intent.account.borrow() == object::id(account), E_WRONG_BUSINESS_ACCOUNT);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);
    let now = clock::timestamp_ms(clock);
    assert!(now < intent.expires_at, E_EXPIRED);
    assert!(now < settle_by_ms, E_SETTLE_BY_PASSED);
    assert!(compliance_config::type_string<T>() == intent.settlement_asset, E_WRONG_SETTLEMENT_ASSET);
    compliance_config::assert_active(config);
    compliance_config::assert_asset_accepted(config, &intent.settlement_asset);
    business_account::charge_payout(account, intent.amount_usd, intent.kind == KIND_BANK_PAYOUT, clock);

    intent.status = STATUS_CONFIRMED;
    emit_confirmed(intent, path, now);
    now
}

/// Hand the funds to the recipient, in the form the recipient can use.
///
/// Another Splash business (kind 2) is credited to its address balance, where
/// its own spending rules draw from. A partner or exchange deposit address,
/// or a wallet (kinds 1 and 3), receives a coin object, which every deposit
/// system recognises; address-balance deposit detection is not confirmed for
/// them.
fun deliver_coin<T>(intent: &PaymentIntent, paid: Coin<T>) {
    if (intent.kind == KIND_SPLASH_BUSINESS) coin::send_funds(paid, intent.recipient)
    else transfer::public_transfer(paid, intent.recipient)
}

fun deliver_balance<T>(intent: &PaymentIntent, paid: Balance<T>, ctx: &mut TxContext) {
    if (intent.kind == KIND_SPLASH_BUSINESS) balance::send_funds(paid, intent.recipient)
    else transfer::public_transfer(coin::from_balance(paid, ctx), intent.recipient)
}

fun receipt(intent: &PaymentIntent, settled_at: u64): SettleReceipt {
    SettleReceipt { intent_id: object::id(intent), commitment: intent.commitment, settled_at }
}

fun obligation(intent: &PaymentIntent, coin_id: ID): BridgeObligation {
    BridgeObligation {
        intent_id: object::id(intent),
        coin_id,
        asset: intent.settlement_asset,
        amount: intent.amount_usd,
        destination_domain: intent.destination_domain,
        mint_recipient: intent.recipient,
        max_fee: intent.bridge_max_fee,
        min_finality_threshold: intent.bridge_min_finality,
    }
}

/// Change goes to the payer's address balance, where a business wallet keeps
/// its funds (D1) and its spending rules can reach them.
fun refund_coin<T>(rest: Coin<T>, to: address) {
    if (coin::value(&rest) > 0) coin::send_funds(rest, to) else coin::destroy_zero(rest)
}

fun refund_balance<T>(rest: Balance<T>, to: address) {
    if (rest.value() > 0) balance::send_funds(rest, to) else rest.destroy_zero()
}

// ─── Cancelling and cleaning up ────────────────────────────────────────────

/// Cancel a pending intent of the account, signed by its wallet.
///
/// The owners can stop any payment opened in their account's name, including
/// one a staff member opened, and with it any second approval bound to it.
public fun cancel_by_wallet(
    intent: &mut PaymentIntent,
    account: &BusinessAccount,
    clock: &Clock,
    ctx: &TxContext,
) {
    business_account::assert_wallet(account, ctx);
    assert!(intent.account.is_some(), E_NOT_ACCOUNT_BOUND);
    assert!(*intent.account.borrow() == object::id(account), E_WRONG_BUSINESS_ACCOUNT);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);

    intent.status = STATUS_CANCELED;
    emit_canceled(intent, STATUS_CANCELED, clock::timestamp_ms(clock));
}

/// Consume an owned pending intent without settlement. The maker only.
public fun cancel(intent: PaymentIntent, ctx: &mut TxContext) {
    assert!(tx_context::sender(ctx) == intent.sender, E_UNAUTHORIZED);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);

    emit_canceled(&intent, STATUS_CANCELED, ctx.epoch_timestamp_ms());
    destroy(intent);
}

/// Cancel an expired intent. Anyone can call after the deadline.
public fun cancel_payment_intent(
    intent: &mut PaymentIntent,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);
    let now = clock::timestamp_ms(clock);
    assert!(now >= intent.expires_at, E_NOT_YET_EXPIRED);

    intent.status = STATUS_EXPIRED;

    emit_canceled(intent, STATUS_EXPIRED, now);
}

/// Maker-initiated cancel before expiration. Only the maker can call.
public fun cancel_by_sender(
    intent: &mut PaymentIntent,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(tx_context::sender(ctx) == intent.sender, E_UNAUTHORIZED);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);

    intent.status = STATUS_CANCELED;

    emit_canceled(intent, STATUS_CANCELED, clock::timestamp_ms(clock));
}

/// Delete a finalized (confirmed, expired, or canceled) intent to reclaim
/// storage — shared intents otherwise live forever (audit fix S-04). Pending
/// intents must be resolved through confirm/cancel first so their terminal
/// state is evented before the object disappears.
///
/// A v2 intent's payment reference stays claimed after deletion, so the same
/// reference can never open a second intent.
public fun delete_finalized(intent: PaymentIntent) {
    assert!(intent.status != STATUS_PENDING, E_STILL_PENDING);
    destroy(intent);
}

fun destroy(intent: PaymentIntent) {
    let PaymentIntent {
        id,
        account: _,
        sender: _,
        recipient: _,
        beneficiary_ref: _,
        amount_usd: _,
        target_currency: _,
        settlement_asset: _,
        fx_rate_usd_local: _,
        created_at: _,
        created_epoch: _,
        expires_at: _,
        status: _,
        commitment: _,
        kind: _,
        destination_domain: _,
        rail_commitment: _,
        payment_ref: _,
        bridge_max_fee: _,
        bridge_min_finality: _,
    } = intent;
    id.delete();
}

// ─── Views ─────────────────────────────────────────────────────────────────

public fun account(intent: &PaymentIntent): Option<ID>      { intent.account }
public fun is_account_bound(intent: &PaymentIntent): bool   { intent.account.is_some() }
public fun sender(intent: &PaymentIntent): address          { intent.sender }
public fun recipient(intent: &PaymentIntent): address       { intent.recipient }
public fun amount_usd(intent: &PaymentIntent): u64          { intent.amount_usd }
public fun status(intent: &PaymentIntent): u8               { intent.status }
/// The commitment this intent was opened with; what every lifecycle event carries.
public fun commitment(intent: &PaymentIntent): vector<u8>   { intent.commitment }
/// STATUS_CONFIRMED, for the anchor event that follows a settlement.
public fun status_confirmed(): u8                           { STATUS_CONFIRMED }
public fun expires_at(intent: &PaymentIntent): u64          { intent.expires_at }
public fun target_currency(intent: &PaymentIntent): &String { &intent.target_currency }
public fun settlement_asset(intent: &PaymentIntent): &String { &intent.settlement_asset }
public fun beneficiary_ref(intent: &PaymentIntent): vector<u8> { intent.beneficiary_ref }
public fun kind(intent: &PaymentIntent): u8                 { intent.kind }
public fun destination_domain(intent: &PaymentIntent): u32  { intent.destination_domain }
public fun rail_commitment(intent: &PaymentIntent): vector<u8> { intent.rail_commitment }
public fun payment_ref(intent: &PaymentIntent): vector<u8>  { intent.payment_ref }
public fun bridge_max_fee(intent: &PaymentIntent): u64      { intent.bridge_max_fee }
public fun bridge_min_finality(intent: &PaymentIntent): u32 { intent.bridge_min_finality }
public fun is_pending(intent: &PaymentIntent): bool         { intent.status == STATUS_PENDING }

/// Whether a payment reference has already opened an intent on this account.
public fun payment_ref_used(account: &BusinessAccount, payment_ref: vector<u8>): bool {
    derived_object::exists(business_account::uid(account), PaymentRef(payment_ref))
}

public fun is_expired(intent: &PaymentIntent, clock: &Clock): bool {
    clock::timestamp_ms(clock) >= intent.expires_at
}

public fun kind_bank_payout(): u8          { KIND_BANK_PAYOUT }
public fun kind_splash_business(): u8      { KIND_SPLASH_BUSINESS }
public fun kind_wallet(): u8               { KIND_WALLET }
public fun kind_cross_chain_wallet(): u8   { KIND_CROSS_CHAIN_WALLET }
public fun sui_domain(): u32               { SUI_DOMAIN }
public fun max_intent_lifetime_ms(): u64   { MAX_INTENT_LIFETIME_MS }
public fun path_business_wallet(): u8      { PATH_BUSINESS_WALLET }
public fun path_settlement_app(): u8       { PATH_SETTLEMENT_APP }
public fun path_legacy_approval(): u8      { PATH_LEGACY_APPROVAL }

/// Consume a settlement receipt. THE ONLY function that destroys a
/// `SettleReceipt`, and it may only be called from `audit_anchor`.
///
/// `SettleReceipt` is a hot potato — no `drop`, no `store`, no `key` — so a PTB
/// that produces one must consume it here or abort. That already guaranteed
/// "every settlement is anchored *or the transaction fails*". What it did NOT
/// guarantee was WHO does the anchoring: `public(package)` meant any future
/// module in this package could unpack a receipt and discard the fields without
/// ever emitting an anchor event, silently breaking the audit trail.
///
/// The witness closes that. `audit_anchor::AnchorWitness` can only be
/// constructed inside `audit_anchor` (Move permits struct construction only in
/// the defining module), so holding one proves the caller IS the anchoring path.
///
/// Why the witness is generic + checked at runtime rather than named directly:
/// `audit_anchor` already depends on `payment_intent`, and Move forbids circular
/// module dependencies, so this module cannot import `AnchorWitness` by name.
/// Binding on the module identity of the witness type achieves the same
/// restriction — the assert cannot be satisfied by any type outside
/// `audit_anchor`, because no other module can construct one.
public(package) fun unpack_settle_receipt<W: drop>(
    _witness: W,
    receipt: SettleReceipt,
): (ID, vector<u8>, u64) {
    assert!(
        type_name::with_defining_ids<W>().module_string() == std::ascii::string(ANCHOR_MODULE),
        E_UNAUTHORIZED_RECEIPT_CONSUMER,
    );
    let SettleReceipt { intent_id, commitment, settled_at } = receipt;
    (intent_id, commitment, settled_at)
}

// ─── Test-only ─────────────────────────────────────────────────────────────
// Event fields are private to this module. These unpackers let the tests read
// what an event carries — and, because each returns every field, a field added
// to an event changes a tuple and fails the test build.

#[test_only]
public fun unpack_intent_created_for_testing(
    e: IntentCreated,
): (ID, vector<u8>, vector<u8>, String, u8, u8, u64, u64) {
    let IntentCreated {
        intent_id,
        commitment,
        rail_commitment,
        settlement_asset,
        kind,
        status,
        expires_at_ms,
        timestamp_ms,
    } = e;
    (intent_id, commitment, rail_commitment, settlement_asset, kind, status, expires_at_ms, timestamp_ms)
}

#[test_only]
public fun unpack_intent_confirmed_for_testing(
    e: IntentConfirmed,
): (ID, vector<u8>, vector<u8>, String, u8, u8, u8, u64) {
    let IntentConfirmed {
        intent_id,
        commitment,
        rail_commitment,
        settlement_asset,
        kind,
        status,
        path,
        timestamp_ms,
    } = e;
    (intent_id, commitment, rail_commitment, settlement_asset, kind, status, path, timestamp_ms)
}

#[test_only]
public fun unpack_intent_canceled_for_testing(
    e: IntentCanceled,
): (ID, vector<u8>, vector<u8>, String, u8, u8, u64) {
    let IntentCanceled { intent_id, commitment, rail_commitment, settlement_asset, kind, status, timestamp_ms } = e;
    (intent_id, commitment, rail_commitment, settlement_asset, kind, status, timestamp_ms)
}

#[test_only]
/// Lets a test stand in for a bridge adapter's burn: the obligation's fields,
/// and the coin destroyed.
public fun unpack_bridge_obligation_for_testing(
    o: BridgeObligation,
): (ID, ID, String, u64, u32, address, u64, u32) {
    let BridgeObligation {
        intent_id,
        coin_id,
        asset,
        amount,
        destination_domain,
        mint_recipient,
        max_fee,
        min_finality_threshold,
    } = o;
    (intent_id, coin_id, asset, amount, destination_domain, mint_recipient, max_fee, min_finality_threshold)
}

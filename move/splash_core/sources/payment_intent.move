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
///   * Splash's fee is computed on chain from the derived kind and the
///     principal, bounded by the payer's `max_fee`, and paid as its own leg;
///     every remainder goes to the account's business wallet (A1).
///   * Named abort codes registered in `lib/server/sui-settlement.ts`.
///   * Events carry a 32-byte commitment, never the payment (WS5). What an
///     event carries freezes at publish; see docs/commitments.md.
///
/// ─── v2: the two paths that pay an account's intent ─────────────────────────
///
///   * `confirm_from_business_wallet` (and `_balance`, and the cross-chain
///     form): the business multisig signs. Its signature IS the approval; the
///     protocol enforces it before this module runs.
///   * `settle_from_app`: a registered settlement app, which is
///     `splash_spend`, settles funds it drew under an app-bound allowance from
///     the business wallet and checked against the business's `SpendPolicy`,
///     and the recipient is paid in the same call. An app opens and settles
///     intents that land on Sui only: a cross-chain settlement hands a coin
///     back to the transaction for a bridge to burn, and only the owners'
///     own transaction may hold the business's coin, so cross-chain intents
///     are opened and paid by the business wallet alone.
///
/// There is no third. The unbound path (`create_payment_intent`, `create`,
/// `confirm_payment_intent`) let any signer pay a recipient out of its own
/// coin; on the testnet flow that signer was Splash's operator, which D3 rules
/// out, and an additive upgrade policy could never take it away again. The
/// legacy per-person approval path (`create_payment_intent_for_account`,
/// `approve_payout`, `confirm_with_approval`) let one maker and one approver
/// pay out of the maker's own coin; it is not published to mainnet either
/// (decision 3), because a public function, however firmly closed, can never
/// be removed once published. Neither is in this package. See
/// docs/v2/phase1-move-design.md.
///
/// ─── Splash's fee (Amendment A1) ─────────────────────────────────────────────
///
/// No intent carries a fee. Each settle path derives the payment's kind from
/// where it goes (`address_registry`), computes the fee from that kind and the
/// principal (`fee_config::splash_fee`), refuses it above the payer's
/// `max_fee`, and splits it inside Move to `FeeConfig.fee_recipient`.
///
/// Every path checks that settlement is not paused, that the asset is still
/// accepted, and the account's KYB, freeze flags and ceilings. A bank payout
/// must also reach its floor, the larger of 99 USDC and
/// `ComplianceConfig.min_settlement_amount`, when it opens and when it
/// settles. An intent lives at most 30 days. The settle paths take
/// `settle_by_ms`, the quote's own deadline, so a transaction signed against
/// a quote cannot be submitted after the quote lapsed.
module splash_core::payment_intent;

use splash_core::address_registry::{Self, Registry};
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::fee_config::{Self, FeeConfig};
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
/// A settle or cancel path was given an intent bound to no account.
const E_NOT_ACCOUNT_BOUND: u64 = 416;
/// The account passed is not the account the intent was opened against.
const E_WRONG_BUSINESS_ACCOUNT: u64 = 417;
// 418 (E_NOT_A_MEMBER) is retired with the legacy create, its only user.
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
/// `kind` is not SPLASH_BUSINESS, WALLET, EXCHANGE or BANK_PAYOUT (or
/// CROSS_CHAIN on a cross-chain path), or this path does not take that kind.
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
/// Funds drawn under a spending rule must be exactly the principal plus
/// `max_fee`.
const E_EXACT_AMOUNT_REQUIRED: u64 = 427;
/// A bank payout names its beneficiary by a 32-byte commitment; other kinds
/// name none.
const E_BENEFICIARY_REQUIRED: u64 = 428;
/// A payment reference is a 32-byte commitment over the business's own
/// invoice or payment id.
const E_BAD_PAYMENT_REF: u64 = 429;
/// The quote this transaction was signed against has lapsed.
const E_SETTLE_BY_PASSED: u64 = 430;
// 431 (E_LEGACY_CLOSED) is retired with the legacy approval path.
/// The coin handed to the bridge adapter is not the coin the settlement
/// released, or not its type or amount.
const E_WRONG_BRIDGE_COIN: u64 = 432;
/// The CCTP fee ceiling would take the whole payment.
const E_BAD_BRIDGE_FEE: u64 = 433;
/// A bank payout is below its floor: the larger of the 99 USDC platform
/// minimum and `ComplianceConfig.min_settlement_amount`.
const E_BELOW_SETTLEMENT_FLOOR: u64 = 434;
/// A1 §2.6. Splash's fee on this payment is above `max_fee`, the most the
/// payer was shown and signed for.
const E_FEE_ABOVE_MAX: u64 = 435;

/// The only module permitted to destroy a `SettleReceipt`. Bound by module name
/// because Move forbids the circular import that naming the type would require —
/// see `unpack_settle_receipt` for what that name check does and does not bind.
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

// ─── Kinds (Amendment A1) ──────────────────────────────────────────────────
// Defined once, in `fee_config`, whose schedule is indexed by them: Splash
// business 0, wallet 1, exchange 2, cross-chain 3, bank payout 4. Read here
// through `fee_config::kind_*()`.

/// Sui's CCTP domain. Every payment that is not cross-chain lands here.
const SUI_DOMAIN: u32 = 8;

// ─── Settlement paths, as `IntentConfirmed.path` reports them ──────────────
const PATH_BUSINESS_WALLET: u8 = 1;
const PATH_SETTLEMENT_APP: u8 = 2;

public struct PaymentIntent has key {
    id: UID,
    /// The business account this intent draws authority from. Every create
    /// in this package binds one; an intent with `none` could not be settled
    /// or cancelled by any path here.
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
    /// v2. SPLASH_BUSINESS (0), WALLET (1), EXCHANGE (2), CROSS_CHAIN (3) or
    /// BANK_PAYOUT (4), as the intent declares it.
    kind: u8,
    /// v2. The CCTP domain the funds land on: 8 for Sui.
    destination_domain: u32,
    /// v2. A 32-byte commitment (`splash:rail:v1`) to the rail and the
    /// partner's reference for this payment. See docs/commitments.md.
    rail_commitment: vector<u8>,
    /// v2. The business's own reference for the payment, 32 bytes. The
    /// intent's UID is derived from it, so one reference opens one intent.
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
/// 2 settlement app (a spending rule). On a cross-chain intent, CONFIRMED
/// means burned for CCTP; the mint completes off Sui.
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

/// A kind that lands on Sui: Splash business, wallet, exchange or bank
/// payout. Every kind but cross-chain.
fun assert_sui_kind(kind: u8) {
    assert!(kind <= fee_config::kind_bank_payout() && kind != fee_config::kind_cross_chain(), E_INVALID_KIND);
}

/// Paying an address on Sui needs an intent that lands on Sui.
fun assert_lands_on_sui(intent: &PaymentIntent) {
    assert!(intent.kind != fee_config::kind_cross_chain(), E_CROSS_CHAIN_ONLY);
    assert!(intent.destination_domain == SUI_DOMAIN, E_CROSS_CHAIN_ONLY);
}

fun assert_cross_chain(intent: &PaymentIntent) {
    assert!(intent.kind == fee_config::kind_cross_chain(), E_NOT_CROSS_CHAIN);
    assert!(intent.destination_domain != SUI_DOMAIN, E_NOT_CROSS_CHAIN);
}

/// The least a bank payout (kind 4) may be on the v2 paths: the larger of the
/// platform minimum (`business_account::min_transfer_minor`, 99 USDC) and the
/// compliance floor (`ComplianceConfig.min_settlement_amount`), which
/// `ComplianceCap` can only raise and `AdminCap` can lower. Wallet transfers,
/// Splash-business and cross-chain payments carry no floor beyond
/// `amount > 0`: they have none of a partner payout's fixed costs.
fun assert_bank_payout_floor(config: &ComplianceConfig, amount: u64) {
    let platform = business_account::min_transfer_minor();
    let compliance = compliance_config::min_settlement_amount(config);
    let floor = if (compliance > platform) compliance else platform;
    assert!(amount >= floor, E_BELOW_SETTLEMENT_FLOOR);
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
        UNIT_FX_RATE, commitment, fee_config::kind_cross_chain(), destination_domain, rail_commitment,
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
    if (kind == fee_config::kind_bank_payout()) {
        assert!(beneficiary_ref.length() == COMMITMENT_BYTES, E_BENEFICIARY_REQUIRED);
        // Checked again at settlement. Refused here as well because a bank
        // payout that can never settle would otherwise be opened, possibly
        // shared, and its payment reference claimed for good: the business
        // could never open that invoice's payout again.
        assert_bank_payout_floor(config, amount);
        business_account::assert_within_per_transfer_cap(account, amount);
    } else {
        assert!(beneficiary_ref.is_empty(), E_BENEFICIARY_REQUIRED);
    };
    // Nothing but a cross-chain intent carries bridge parameters, and its fee
    // ceiling must leave something to arrive.
    if (kind == fee_config::kind_cross_chain()) {
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
//
// Amendment A1 §2.6. Every path computes Splash's fee from the DERIVED kind
// (`address_registry::derive_kind`) and the principal (`fee_config::
// splash_fee`); nothing the intent or the PTB says sets it. The payer bounds
// it: `max_fee` is the fee the UI showed, and a higher fee aborts
// (E_FEE_ABOVE_MAX), so a schedule raised after the quote was rendered cannot
// charge the signer more. The fee leg is split here, inside Move, and sent to
// `FeeConfig.fee_recipient` (`fee_config::take_fee`); a fee of 0 sends
// nothing. The principal reaches the recipient as before, and every remainder
// (an overpayment, the unused part of `max_fee`) goes to the account's
// business wallet, never to the transaction's sender.

/// Pay an account's intent from the business wallet, in a coin.
///
/// The sender must be the account's wallet: the business multisig. Its
/// signature is the approval, and the protocol enforced it before this ran.
/// Whoever opened the intent (the wallet, or a staff member under a spending
/// rule), the owners can pay it themselves. The kind is derived from the
/// intent's kind and recipient; `payment` must cover the principal and the
/// fee; the fee leg goes to the fee recipient and the rest to the wallet.
public fun confirm_from_business_wallet<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    fee_cfg: &FeeConfig,
    registry: &Registry,
    payment: Coin<T>,
    max_fee: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    business_account::assert_wallet(account, ctx);
    assert_lands_on_sui(intent);
    let declared = intent.kind;
    let (kind, fee) = kind_and_fee(intent, account, fee_cfg, registry, declared, false, max_fee);
    assert_covers(coin::value(&payment), intent.amount_usd, fee);
    let now = settle_for_account<T>(intent, account, config, PATH_BUSINESS_WALLET, settle_by_ms, clock);

    let mut funds = payment.into_balance();
    let paid = funds.split(intent.amount_usd);
    deliver(kind, intent.recipient, paid, ctx);
    fee_config::take_fee(fee_cfg, &mut funds, fee, object::id(intent), object::id(account), kind);
    to_wallet(funds, account);
    receipt(intent, now)
}

/// Pay an account's intent from the business wallet's address balance.
///
/// Takes the `Balance<T>` a funds-withdrawal input redeems to
/// (`balance::redeem_funds`), so the transaction needs no coin selection.
/// The fee leg and the remainder as on the coin path.
public fun confirm_from_business_wallet_balance<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    fee_cfg: &FeeConfig,
    registry: &Registry,
    mut payment: Balance<T>,
    max_fee: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    business_account::assert_wallet(account, ctx);
    assert_lands_on_sui(intent);
    let declared = intent.kind;
    let (kind, fee) = kind_and_fee(intent, account, fee_cfg, registry, declared, false, max_fee);
    assert_covers(payment.value(), intent.amount_usd, fee);
    let now = settle_for_account<T>(intent, account, config, PATH_BUSINESS_WALLET, settle_by_ms, clock);

    let paid = payment.split(intent.amount_usd);
    deliver(kind, intent.recipient, paid, ctx);
    fee_config::take_fee(fee_cfg, &mut payment, fee, object::id(intent), object::id(account), kind);
    to_wallet(payment, account);
    receipt(intent, now)
}

/// Pay an account's cross-chain intent from the business wallet.
///
/// The principal is sent to no address here. Exactly the principal comes back
/// as a coin, beside a `BridgeObligation` naming that coin, which only a
/// registered bridge adapter can discharge: the same transaction must burn
/// this coin through CCTP to the intent's domain and recipient, or abort.
/// Splash's fee is the cross-chain kind's, paid here in the asset on Sui
/// before the burn; CCTP's own fee is the intent's `bridge_max_fee`, shown
/// separately. The rest goes to the wallet.
public fun confirm_cross_chain_from_business_wallet<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    fee_cfg: &FeeConfig,
    registry: &Registry,
    payment: Coin<T>,
    max_fee: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (SettleReceipt, Coin<T>, BridgeObligation) {
    business_account::assert_wallet(account, ctx);
    assert_cross_chain(intent);
    let declared = intent.kind;
    let (kind, fee) = kind_and_fee(intent, account, fee_cfg, registry, declared, true, max_fee);
    assert_covers(coin::value(&payment), intent.amount_usd, fee);
    let now = settle_for_account<T>(intent, account, config, PATH_BUSINESS_WALLET, settle_by_ms, clock);

    let mut funds = payment.into_balance();
    let to_bridge = coin::from_balance(funds.split(intent.amount_usd), ctx);
    fee_config::take_fee(fee_cfg, &mut funds, fee, object::id(intent), object::id(account), kind);
    to_wallet(funds, account);
    let obligation = obligation(intent, object::id(&to_bridge));
    (receipt(intent, now), to_bridge, obligation)
}

/// Settle an account's intent with funds a registered settlement app drew.
///
/// `W` is the app's witness, accepted only from a type on
/// `ComplianceConfig.settlement_apps`. The app is `splash_spend`, which drew
/// `funds` under an app-bound allowance from the business wallet and checked
/// them against the business's `SpendPolicy` before calling this.
///
/// `declared_kind` is what the app says the recipient is (in `splash_spend`,
/// the recipient's tag in the policy), and goes through `derive_kind` like
/// the intent's kind on the owners' path. `funds` must be exactly the
/// principal plus `max_fee`, the fee the spender was shown: the fee charged
/// is at most `max_fee`, and the unused part goes to the account's business
/// wallet's address balance, which is the wallet the allowance drew from, and
/// never to the spender. Returns the receipt, the derived kind and the fee
/// charged, so the app can check the fee against its own ceiling and report
/// both.
public fun settle_from_app<T, W: drop>(
    _witness: W,
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    fee_cfg: &FeeConfig,
    registry: &Registry,
    declared_kind: u8,
    mut funds: Balance<T>,
    max_fee: u64,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (SettleReceipt, u8, u64) {
    compliance_config::assert_settlement_app<W>(config);
    assert_lands_on_sui(intent);
    let drawn = funds.value();
    assert!(drawn >= intent.amount_usd && drawn - intent.amount_usd == max_fee, E_EXACT_AMOUNT_REQUIRED);
    let (kind, fee) = kind_and_fee(intent, account, fee_cfg, registry, declared_kind, false, max_fee);
    let now = settle_for_account<T>(intent, account, config, PATH_SETTLEMENT_APP, settle_by_ms, clock);

    let paid = funds.split(intent.amount_usd);
    deliver(kind, intent.recipient, paid, ctx);
    fee_config::take_fee(fee_cfg, &mut funds, fee, object::id(intent), object::id(account), kind);
    // Only an unused part of max_fee is left. The wallet is looked up only
    // then, so an exact settlement never depends on it.
    if (funds.value() > 0) balance::send_funds(funds, business_account::wallet(account))
    else funds.destroy_zero();
    (receipt(intent, now), kind, fee)
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
/// not lapsed; settlement is not paused and the asset is still accepted; a
/// bank payout still reaches its floor, which compliance may have raised
/// since the intent opened; and the account passes KYB, both freeze flags and
/// its ceilings, which are charged here.
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
    let bank_payout = intent.kind == fee_config::kind_bank_payout();
    if (bank_payout) assert_bank_payout_floor(config, intent.amount_usd);
    // `charge_payout`'s own 99 USDC floor is kept for bank payouts as a second
    // check; the floor above is never lower, so it is the one that refuses.
    business_account::charge_payout(account, intent.amount_usd, bank_payout, clock);

    intent.status = STATUS_CONFIRMED;
    emit_confirmed(intent, path, now);
    now
}

/// The derived kind and Splash's fee for this settlement, refused above the
/// payer's `max_fee`. `declared` is the intent's kind on the owners' paths
/// and the app's tag on the app path; `via_cctp` is the cross-chain path.
/// The business a discount is looked up for is the account the intent is
/// bound to, which `settle_for_account` checks is this one.
///
/// The derived kind must fit what was declared, and the intent's own kind
/// (`address_registry::assert_kind_fits`): equal to it, or a free
/// Splash-business payment declared a wallet or an exchange. On the owners'
/// paths the two are the same; on the app path both the app's tag and the
/// intent's kind must fit. So a payment to a partner deposit address is
/// always an intent opened as a bank payout, which carries a beneficiary
/// commitment and met the bank floor at opening, and meets it again in
/// `settle_for_account`.
fun kind_and_fee(
    intent: &PaymentIntent,
    account: &BusinessAccount,
    fee_cfg: &FeeConfig,
    registry: &Registry,
    declared: u8,
    via_cctp: bool,
    max_fee: u64,
): (u8, u64) {
    let kind = address_registry::derive_kind(registry, intent.recipient, declared, via_cctp);
    address_registry::assert_kind_fits(declared, kind);
    if (declared != intent.kind) address_registry::assert_kind_fits(intent.kind, kind);
    let fee = fee_config::splash_fee(fee_cfg, object::id(account), kind, intent.amount_usd);
    assert!(fee <= max_fee, E_FEE_ABOVE_MAX);
    (kind, fee)
}

/// `paid` covers the principal and the fee, written so it cannot overflow.
fun assert_covers(paid: u64, principal: u64, fee: u64) {
    assert!(paid >= principal && paid - principal >= fee, E_INSUFFICIENT_PAYMENT);
}

/// Hand the principal to the recipient, in the form the recipient can use,
/// by the DERIVED kind.
///
/// Another Splash business (kind 0: a registered business wallet, declared a
/// Splash business, a wallet or an exchange) is credited to its address balance, where its own
/// spending rules draw from. A wallet, an exchange or a partner deposit
/// address (kinds 1, 2 and 4) receives a coin object, which every deposit
/// system recognises; address-balance deposit detection is not confirmed for
/// them.
fun deliver<T>(kind: u8, recipient: address, paid: Balance<T>, ctx: &mut TxContext) {
    if (kind == fee_config::kind_splash_business()) balance::send_funds(paid, recipient)
    else transfer::public_transfer(coin::from_balance(paid, ctx), recipient)
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

/// Every remainder goes to the account's business wallet's address balance,
/// where it keeps its funds (D1) and its spending rules can reach them, and
/// never to the transaction's sender. Nothing at all when there is none.
fun to_wallet<T>(rest: Balance<T>, account: &BusinessAccount) {
    if (rest.value() > 0) balance::send_funds(rest, business_account::wallet(account)) else rest.destroy_zero()
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
///
/// The event is stamped with the clock, like every other lifecycle event, so
/// an intent opened and cancelled in one transaction never shows its cancel
/// before its create.
public fun cancel(intent: PaymentIntent, clock: &Clock, ctx: &mut TxContext) {
    assert!(tx_context::sender(ctx) == intent.sender, E_UNAUTHORIZED);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);

    emit_canceled(&intent, STATUS_CANCELED, clock::timestamp_ms(clock));
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

public fun kind_splash_business(): u8      { fee_config::kind_splash_business() }
public fun kind_wallet(): u8               { fee_config::kind_wallet() }
public fun kind_exchange(): u8             { fee_config::kind_exchange() }
public fun kind_cross_chain(): u8          { fee_config::kind_cross_chain() }
public fun kind_bank_payout(): u8          { fee_config::kind_bank_payout() }
public fun sui_domain(): u32               { SUI_DOMAIN }
public fun max_intent_lifetime_ms(): u64   { MAX_INTENT_LIFETIME_MS }
public fun path_business_wallet(): u8      { PATH_BUSINESS_WALLET }
public fun path_settlement_app(): u8       { PATH_SETTLEMENT_APP }

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
/// The witness narrows that. `audit_anchor::AnchorWitness` can only be
/// constructed inside `audit_anchor` (Move permits struct construction only in
/// the defining module), so a caller holding one IS the anchoring path.
///
/// Why the witness is generic + checked at runtime rather than named directly:
/// `audit_anchor` already depends on `payment_intent`, and Move forbids circular
/// module dependencies, so this module cannot import `AnchorWitness` by name.
/// The assert binds the witness type's module NAME, not its package: a type
/// in a module called `audit_anchor` in any package would pass it. What
/// confines it is the visibility. `public(package)` means only `splash_core`
/// code can call this, its one caller is `audit_anchor::anchor`, which passes
/// its own `AnchorWitness`, and any new caller arrives through a governed
/// core upgrade, which could equally add a function to `audit_anchor` itself.
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

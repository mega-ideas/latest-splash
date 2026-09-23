/// PaymentIntent — atomic payment flow with sender-bound authorization.
///
/// Replaces the Phase 1 scaffold which accepted a spoofable `sender`
/// argument (C-03), used the slow `epoch_timestamp_ms` for expiration
/// (H-01), allowed any third party to confirm a shared intent (H-02),
/// and over-charged the caller by forwarding the entire coin even when
/// it exceeded the requested amount (H-03).
///
/// Design:
///   * `sender` is always `tx_context::sender(ctx)` at creation — never an
///     argument.
///   * Confirmation requires `tx_context::sender == intent.sender`.
///   * Expiration uses `&Clock` (real wall-clock ms), not epoch boundaries.
///   * Overpay is refunded to the sender via `coin::split`.
///   * Named abort codes registered in `lib/server/sui-settlement.ts`.
///   * Events carry a 32-byte commitment, never the payment (WS5). What an
///     event carries freezes at the immutable publish; see docs/commitments.md.
module splash_core::payment_intent;

use splash_core::business_account::{Self, BusinessAccount, PayoutApproval};
use std::string::String;
use std::type_name;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
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
const E_EMPTY_BENEFICIARY_REF: u64 = 409;
const E_EMPTY_CURRENCY:        u64 = 410;
const E_EMPTY_CORRIDOR:        u64 = 411;
const E_STILL_PENDING:         u64 = 412;
/// A module other than `audit_anchor` tried to consume a `SettleReceipt`.
const E_UNAUTHORIZED_RECEIPT_CONSUMER: u64 = 413;
/// The coin type offered does not match the asset the intent was created for.
const E_WRONG_SETTLEMENT_ASSET: u64 = 414;
/// This intent is bound to a business account, so it settles only through
/// `confirm_with_approval`. `confirm_payment_intent` would bypass the
/// approver, the freeze flags and the 24h ceiling.
const E_APPROVAL_REQUIRED: u64 = 415;
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

/// The only module permitted to destroy a `SettleReceipt`. Bound by module name
/// because Move forbids the circular import that naming the type would require —
/// see `unpack_settle_receipt`.
const ANCHOR_MODULE: vector<u8> = b"audit_anchor";

// ─── Constants ─────────────────────────────────────────────────────────────
/// 5-minute expiration window.
const EXPIRATION_WINDOW_MS: u64 = 300_000;
/// Length of a commitment in bytes. The off-chain library
/// (lib/evidence/commitment.ts) produces exactly this; Move checks the length
/// and carries the bytes, and never sees the payload or the salt behind them.
const COMMITMENT_BYTES: u64 = 32;

// ─── Status constants ──────────────────────────────────────────────────────
const STATUS_PENDING:   u8 = 0;
const STATUS_CONFIRMED: u8 = 1;
const STATUS_EXPIRED:   u8 = 2;
const STATUS_CANCELED:  u8 = 3;

public struct PaymentIntent has key {
    id: UID,
    /// The business account this intent draws authority from, if any.
    ///
    /// `none` is a plain intent: one address paying another out of its own
    /// coin, authorised by being the sender. `some` binds it to a tenant, and
    /// then settlement REQUIRES an approval from that tenant's approver set —
    /// `confirm_payment_intent` refuses a bound intent outright, so the
    /// unapproved path is not a fallback, it is a different product.
    account: Option<ID>,
    sender: address,
    recipient: address,
    /// Hash/reference of the verified counterparty record. Never raw PII.
    beneficiary_ref: vector<u8>,
    amount_usd: u64,
    currency: vector<u8>,
    corridor: vector<u8>,
    target_currency: String,
    /// Fully-qualified type of the coin this intent must be settled in, e.g.
    /// `…::usdc::USDC`. Bound at creation and asserted at confirmation.
    ///
    /// Without this, making `confirm_payment_intent` generic over `Coin<T>` —
    /// which it must be, since hardcoding `Coin<SUI>` settles a USD corridor in
    /// a volatile asset — would let ANY coin type satisfy an intent. The
    /// contract compares `coin::value(&payment)` against `amount_usd`, so a
    /// payer could discharge a 100 USDC obligation with 100_000_000 units of a
    /// worthless token and the recipient would receive exactly that.
    settlement_asset: String,
    /// USD→local FX rate scaled by 1e6.
    fx_rate_usd_local: u64,
    created_at: u64,
    created_epoch: u64,
    expires_at: u64,
    status: u8,
    /// WS5. The 32-byte commitment every lifecycle event of this intent
    /// carries: blake2b256(tag || bcs(payload) || salt), computed off-chain.
    /// The payload and the salt live in the Seal bundle, never here.
    commitment: vector<u8>,
}

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

/// WS5. Event structs freeze at the immutable publish, so what they carry is
/// decided once. Every lifecycle event carries the intent, the commitment the
/// intent was opened with, the status it is now in, and the clock — and
/// nothing about who paid whom how much. Whoever the Seal policy admits to the
/// bundle can open the commitment; see docs/commitments.md.
public struct IntentCreated has copy, drop {
    intent_id: ID,
    commitment: vector<u8>,
    status: u8,
    timestamp_ms: u64,
}

public struct IntentConfirmed has copy, drop {
    intent_id: ID,
    commitment: vector<u8>,
    status: u8,
    timestamp_ms: u64,
}

/// `status` is the reason: STATUS_EXPIRED (2) or STATUS_CANCELED (3).
public struct IntentCanceled has copy, drop {
    intent_id: ID,
    commitment: vector<u8>,
    status: u8,
    timestamp_ms: u64,
}

fun emit_created(intent: &PaymentIntent, now: u64) {
    event::emit(IntentCreated {
        intent_id: object::id(intent),
        commitment: intent.commitment,
        status: STATUS_PENDING,
        timestamp_ms: now,
    });
}

fun emit_canceled(intent: &PaymentIntent, status: u8, now: u64) {
    event::emit(IntentCanceled {
        intent_id: object::id(intent),
        commitment: intent.commitment,
        status,
        timestamp_ms: now,
    });
}

/// The one check Move makes on a commitment. The bytes are opaque here.
fun assert_commitment(commitment: &vector<u8>) {
    assert!(commitment.length() == COMMITMENT_BYTES, E_BAD_COMMITMENT);
}

// ─── Entry / public functions ──────────────────────────────────────────────

/// Create a new intent. `sender` is bound to `tx_context::sender(ctx)` —
/// no longer a caller-supplied argument (C-03 fix).
public fun create_payment_intent<T>(
    recipient: address,
    amount_usd: u64,
    target_currency: String,
    fx_rate_usd_local: u64,
    commitment: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(amount_usd > 0, E_INVALID_AMOUNT);
    assert!(recipient != @0x0, E_INVALID_RECIPIENT);
    assert!(std::string::length(&target_currency) > 0, E_EMPTY_TARGET_CURRENCY);
    assert!(fx_rate_usd_local > 0, E_INVALID_FX_RATE);
    assert_commitment(&commitment);

    let sender = tx_context::sender(ctx);
    let now = clock::timestamp_ms(clock);
    let expires_at = now + EXPIRATION_WINDOW_MS;

    let intent = PaymentIntent {
        id: object::new(ctx),
        account: option::none(),
        sender,
        recipient,
        beneficiary_ref: vector[],
        amount_usd,
        // Was hardcoded b"SUI". The corridor is USD-denominated, so the
        // settlement asset is now whatever `T` the caller opened the intent in,
        // recorded verbatim rather than asserted to be SUI.
        currency: type_name::with_defining_ids<T>().into_string().into_bytes(),
        corridor: vector[],
        target_currency,
        settlement_asset: type_name::with_defining_ids<T>().into_string().to_string(),
        fx_rate_usd_local,
        created_at: now,
        created_epoch: ctx.epoch(),
        expires_at,
        status: STATUS_PENDING,
        commitment,
    };

    emit_created(&intent, now);

    transfer::share_object(intent);
}

/// Create an intent that draws its authority from a business account.
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
    recipient: address,
    amount_usd: u64,
    target_currency: String,
    fx_rate_usd_local: u64,
    commitment: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let maker = tx_context::sender(ctx);
    assert!(
        business_account::is_owner(account, maker) || business_account::is_approver(account, maker),
        E_NOT_A_MEMBER,
    );
    assert!(business_account::is_verified(account), E_ACCOUNT_NOT_PAYABLE);
    assert!(!business_account::is_frozen(account), E_ACCOUNT_NOT_PAYABLE);
    assert!(amount_usd > 0, E_INVALID_AMOUNT);
    assert!(recipient != @0x0, E_INVALID_RECIPIENT);
    assert!(std::string::length(&target_currency) > 0, E_EMPTY_TARGET_CURRENCY);
    assert!(fx_rate_usd_local > 0, E_INVALID_FX_RATE);
    assert_commitment(&commitment);

    let now = clock::timestamp_ms(clock);
    let expires_at = now + EXPIRATION_WINDOW_MS;

    let intent = PaymentIntent {
        id: object::new(ctx),
        account: option::some(object::id(account)),
        sender: maker,
        recipient,
        beneficiary_ref: vector[],
        amount_usd,
        currency: type_name::with_defining_ids<T>().into_string().into_bytes(),
        corridor: vector[],
        target_currency,
        settlement_asset: type_name::with_defining_ids<T>().into_string().to_string(),
        fx_rate_usd_local,
        created_at: now,
        created_epoch: ctx.epoch(),
        expires_at,
        status: STATUS_PENDING,
        commitment,
    };

    emit_created(&intent, now);

    transfer::share_object(intent);
}

/// Create an owned intent plus a non-droppable receipt that must be anchored
/// in the same PTB. The caller can share the returned intent with share_intent.
public fun create<T>(
    recipient: address,
    beneficiary_ref: vector<u8>,
    amount: u64,
    currency: vector<u8>,
    corridor: vector<u8>,
    target_currency: String,
    fx_rate_usd_local: u64,
    commitment: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    assert!(amount > 0, E_INVALID_AMOUNT);
    assert!(recipient != @0x0, E_INVALID_RECIPIENT);
    assert!(beneficiary_ref.length() > 0, E_EMPTY_BENEFICIARY_REF);
    assert!(currency.length() > 0, E_EMPTY_CURRENCY);
    assert!(corridor.length() > 0, E_EMPTY_CORRIDOR);
    assert!(std::string::length(&target_currency) > 0, E_EMPTY_TARGET_CURRENCY);
    assert!(fx_rate_usd_local > 0, E_INVALID_FX_RATE);
    assert_commitment(&commitment);

    let sender = tx_context::sender(ctx);
    let now = clock::timestamp_ms(clock);
    let created_epoch = ctx.epoch();
    let expires_at = now + EXPIRATION_WINDOW_MS;

    let intent = PaymentIntent {
        id: object::new(ctx),
        account: option::none(),
        sender,
        recipient,
        beneficiary_ref,
        amount_usd: amount,
        currency,
        corridor,
        target_currency,
        settlement_asset: type_name::with_defining_ids<T>().into_string().to_string(),
        fx_rate_usd_local,
        created_at: now,
        created_epoch,
        expires_at,
        status: STATUS_PENDING,
        commitment,
    };
    let intent_id = object::id(&intent);

    emit_created(&intent, now);

    // M1 FIX — `create` used to mint a `SettleReceipt` right here, with
    // `settled_at: now` and no `Coin` anywhere in the function. The type asserted
    // that a settlement had occurred while no value had moved, and
    // `audit_anchor` would then anchor that assertion on chain as if it were
    // proof of payment. A receipt is now minted in exactly one place —
    // `confirm_payment_intent`, which takes a `Coin<T>`, asserts it covers the
    // intent, splits it, and transfers to the recipient. No coin, no receipt.
    let _ = intent_id;
    intent
}

/// Share an owned intent returned by create.
public fun share_intent(intent: PaymentIntent) {
    transfer::share_object(intent);
}

/// Confirm an UNBOUND intent — one address paying another out of its own coin.
/// Only the original sender can call (H-02 fix). Excess payment is split off
/// and returned to the sender so the recipient receives exactly
/// `intent.amount_usd` (H-03 fix).
///
/// An intent bound to a business account is refused here. That refusal is what
/// makes the Phase 6 authority real rather than advisory: without it, every
/// approver check, freeze flag and daily ceiling would be one function call
/// away from being skipped, and a control with a documented bypass is not a
/// control.
public fun confirm_payment_intent<T>(
    intent: &mut PaymentIntent,
    payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    assert!(intent.account.is_none(), E_APPROVAL_REQUIRED);
    settle(intent, payment, clock, ctx)
}

/// Approve a payout, as an approver of the account the intent is bound to.
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
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(intent.account.is_some(), E_NOT_ACCOUNT_BOUND);
    assert!(*intent.account.borrow() == object::id(account), E_WRONG_BUSINESS_ACCOUNT);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);
    assert!(clock::timestamp_ms(clock) < intent.expires_at, E_EXPIRED);

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
/// The approval carries its own account, intent, amount and authority epoch,
/// and `business_account::consume_approval` checks every one of them plus the
/// freeze flags, KYB status and the 24h ceiling. This function's own job is
/// narrow: prove the caller is the maker the intent was opened by, and prove
/// the account passed is the account the intent named.
public fun confirm_with_approval<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    approval: PayoutApproval,
    payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    assert!(intent.account.is_some(), E_NOT_ACCOUNT_BOUND);
    assert!(*intent.account.borrow() == object::id(account), E_WRONG_BUSINESS_ACCOUNT);
    // The maker. Asserted here as well as in `settle`, because the approval is
    // transferred to an address named by the APPROVER, and an approver naming
    // the wrong address must not be able to hand release authority to someone
    // the intent never authorised.
    assert!(tx_context::sender(ctx) == intent.sender, E_UNAUTHORIZED);

    business_account::consume_approval(
        account,
        approval,
        object::id(intent),
        intent.amount_usd,
        intent.commitment,
        clock,
    );

    settle(intent, payment, clock, ctx)
}

fun settle<T>(
    intent: &mut PaymentIntent,
    mut payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    let caller = tx_context::sender(ctx);
    assert!(caller == intent.sender, E_UNAUTHORIZED);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);
    assert!(clock::timestamp_ms(clock) < intent.expires_at, E_EXPIRED);
    // The asset is bound to the one the intent was opened in. Generic-without-
    // binding would be strictly WORSE than the hardcoded `Coin<SUI>` it
    // replaces: any coin type could discharge the obligation, because the only
    // amount check is `coin::value(&payment) >= intent.amount_usd` and unit
    // counts are meaningless across assets.
    assert!(
        type_name::with_defining_ids<T>().into_string().to_string() == intent.settlement_asset,
        E_WRONG_SETTLEMENT_ASSET,
    );

    let provided = coin::value(&payment);
    assert!(provided >= intent.amount_usd, E_INSUFFICIENT_PAYMENT);

    let overpay = provided - intent.amount_usd;

    // Split off the exact amount; refund the rest if any.
    let to_recipient = coin::split(&mut payment, intent.amount_usd, ctx);
    transfer::public_transfer(to_recipient, intent.recipient);

    if (overpay > 0) {
        transfer::public_transfer(payment, caller);
    } else {
        // `payment` is now zero-value; destroy it safely.
        coin::destroy_zero(payment);
    };

    intent.status = STATUS_CONFIRMED;
    let confirmed_at = clock::timestamp_ms(clock);

    event::emit(IntentConfirmed {
        intent_id: object::id(intent),
        commitment: intent.commitment,
        status: STATUS_CONFIRMED,
        timestamp_ms: confirmed_at,
    });

    SettleReceipt {
        intent_id: object::id(intent),
        commitment: intent.commitment,
        settled_at: confirmed_at,
    }
}

/// Consume an owned pending intent without settlement.
public fun cancel(intent: PaymentIntent, ctx: &mut TxContext) {
    assert!(tx_context::sender(ctx) == intent.sender, E_UNAUTHORIZED);
    assert!(intent.status == STATUS_PENDING, E_NOT_PENDING);

    emit_canceled(&intent, STATUS_CANCELED, ctx.epoch_timestamp_ms());

    let PaymentIntent {
        id,
        account: _,
        sender: _,
        recipient: _,
        beneficiary_ref: _,
        amount_usd: _,
        currency: _,
        corridor: _,
        target_currency: _,
        settlement_asset: _,
        fx_rate_usd_local: _,
        created_at: _,
        created_epoch: _,
        expires_at: _,
        status: _,
        commitment: _,
    } = intent;
    id.delete();
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

/// Sender-initiated cancel before expiration. Only the original sender can call.
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
public fun delete_finalized(intent: PaymentIntent) {
    assert!(intent.status != STATUS_PENDING, E_STILL_PENDING);

    let PaymentIntent {
        id,
        account: _,
        sender: _,
        recipient: _,
        beneficiary_ref: _,
        amount_usd: _,
        currency: _,
        corridor: _,
        target_currency: _,
        settlement_asset: _,
        fx_rate_usd_local: _,
        created_at: _,
        created_epoch: _,
        expires_at: _,
        status: _,
        commitment: _,
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

public fun is_expired(intent: &PaymentIntent, clock: &Clock): bool {
    clock::timestamp_ms(clock) >= intent.expires_at
}

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
public fun unpack_intent_created_for_testing(e: IntentCreated): (ID, vector<u8>, u8, u64) {
    let IntentCreated { intent_id, commitment, status, timestamp_ms } = e;
    (intent_id, commitment, status, timestamp_ms)
}

#[test_only]
public fun unpack_intent_confirmed_for_testing(e: IntentConfirmed): (ID, vector<u8>, u8, u64) {
    let IntentConfirmed { intent_id, commitment, status, timestamp_ms } = e;
    (intent_id, commitment, status, timestamp_ms)
}

#[test_only]
public fun unpack_intent_canceled_for_testing(e: IntentCanceled): (ID, vector<u8>, u8, u64) {
    let IntentCanceled { intent_id, commitment, status, timestamp_ms } = e;
    (intent_id, commitment, status, timestamp_ms)
}

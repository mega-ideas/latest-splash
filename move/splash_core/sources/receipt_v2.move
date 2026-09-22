/// ReceiptV2 — immutable settlement receipts with USD-first amounts.
///
/// Replaces the Phase 1 scaffold which let any caller mutate the
/// `audit_anchor_id` of any receipt (M-03) and had no authorization on
/// `create_receipt` (L-05). Now receipts are AdminCap-gated and the audit
/// anchor link is set at creation time and immutable thereafter.
///
/// Design:
///   * `create_receipt` is AdminCap-gated. Off-chain settlement layer holds
///     the cap and mints receipts after on-chain settlement events fire.
///   * `audit_anchor_id` is set at creation. The `link_audit_anchor`
///     post-hoc mutator is REMOVED. If a receipt later needs to point at
///     a different anchor, create a new receipt; the old one stays as a
///     tamper-evident historical record.
///   * Verification emits a `VerificationChecked` event so off-chain
///     auditors can prove a digest was checked.
module splash_core::receipt_v2;

use splash_core::business_account::{Self, AnchorCap};
use splash_core::cap_registry::CapRegistry;
use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;

// ─── Abort codes ───────────────────────────────────────────────────────────
const E_EMPTY_RECEIPT_ID:  u64 = 800;
const E_EMPTY_TX_DIGEST:   u64 = 801;
const E_ZERO_AMOUNT:       u64 = 802;
const E_INVALID_RECIPIENT: u64 = 803;
/// WS5. See payment_intent::E_BAD_COMMITMENT: a commitment is 32 bytes.
const E_BAD_COMMITMENT:    u64 = 804;

public struct ReceiptV2 has key {
    id: UID,
    receipt_id: String,
    sender: address,
    recipient: address,
    amount_usd: u64,
    target_currency: String,
    target_amount: u64,
    /// USD→local FX rate scaled by 1e6.
    fx_rate_usd_local: u64,
    /// WS5. The 32-byte commitment the ReceiptIssued event carries.
    commitment: vector<u8>,
    settled_at: u64,
    tx_digest: String,
    audit_anchor_id: Option<String>,
    /// Tenant tag — typically the BusinessAccount object address whose
    /// payment this receipt records. `@0x0` for protocol-level receipts.
    business_account_id: address,
    /// Capability holder who minted this receipt. Aids forensic review.
    minter: address,
}

// ─── Events ────────────────────────────────────────────────────────────────

/// WS5: the receipt's commitment where the counterparties and amounts were.
public struct ReceiptIssued has copy, drop {
    receipt_object: address,
    receipt_id: String,
    commitment: vector<u8>,
    settled_at: u64,
    tx_digest: String,
    business_account_id: address,
    minter: address,
}

public struct ReceiptVerificationChecked has copy, drop {
    receipt_object: address,
    matched: bool,
    checker: address,
    timestamp_ms: u64,
}

// ─── Entry / public functions ──────────────────────────────────────────────

/// AnchorCap-gated receipt minting (L-05 fix; cap split S-10). The cap
/// holder is the only party that can record settlement receipts on-chain,
/// preventing forged receipts from showing up in indexer queries.
///
/// Minting a receipt records history; it moves no value, so it runs on the hot
/// operator key's `AnchorCap` rather than the cold-multisig `AdminCap`.
///
/// `audit_anchor_id` is fixed at creation. The post-hoc `link_audit_anchor`
/// mutator from the scaffold is removed (M-03 fix) — receipts are now truly
/// immutable.
public fun create_receipt(
    cap: &AnchorCap,
    registry: &CapRegistry,
    receipt_id: String,
    sender: address,
    recipient: address,
    amount_usd: u64,
    target_currency: String,
    target_amount: u64,
    fx_rate_usd_local: u64,
    commitment: vector<u8>,
    tx_digest: String,
    audit_anchor_id: Option<String>,
    business_account_id: address,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    // A revoked cap mints nothing.
    business_account::assert_anchor_cap(registry, cap);
    assert!(std::string::length(&receipt_id) > 0, E_EMPTY_RECEIPT_ID);
    assert!(std::string::length(&tx_digest)  > 0, E_EMPTY_TX_DIGEST);
    assert!(amount_usd > 0,                       E_ZERO_AMOUNT);
    assert!(recipient != @0x0,                    E_INVALID_RECIPIENT);
    assert!(commitment.length() == 32,            E_BAD_COMMITMENT);

    let minter = tx_context::sender(ctx);
    let receipt = ReceiptV2 {
        id: object::new(ctx),
        receipt_id,
        sender,
        recipient,
        amount_usd,
        target_currency,
        target_amount,
        fx_rate_usd_local,
        commitment,
        settled_at: clock::timestamp_ms(clock),
        tx_digest,
        audit_anchor_id,
        business_account_id,
        minter,
    };

    event::emit(ReceiptIssued {
        receipt_object: object::uid_to_address(&receipt.id),
        receipt_id: receipt.receipt_id,
        commitment: receipt.commitment,
        settled_at: receipt.settled_at,
        tx_digest: receipt.tx_digest,
        business_account_id,
        minter,
    });

    transfer::share_object(receipt);
}

/// Verify a receipt's tx_digest matches an expected value. Emits a
/// traceable event so off-chain auditors can prove the check ran.
public fun verify_receipt(
    receipt: &ReceiptV2,
    expected_tx_digest: String,
    clock: &Clock,
    ctx: &TxContext,
): bool {
    let matched = receipt.tx_digest == expected_tx_digest;

    event::emit(ReceiptVerificationChecked {
        receipt_object: object::id_address(receipt),
        matched,
        checker: tx_context::sender(ctx),
        timestamp_ms: clock::timestamp_ms(clock),
    });

    matched
}

#[test_only]
public fun unpack_receipt_issued_for_testing(
    e: ReceiptIssued,
): (address, String, vector<u8>, u64, String, address, address) {
    let ReceiptIssued { receipt_object, receipt_id, commitment, settled_at, tx_digest, business_account_id, minter } = e;
    (receipt_object, receipt_id, commitment, settled_at, tx_digest, business_account_id, minter)
}

// ─── Views ─────────────────────────────────────────────────────────────────

public fun receipt_id(receipt: &ReceiptV2): &String              { &receipt.receipt_id }
public fun sender(receipt: &ReceiptV2): address                  { receipt.sender }
public fun recipient(receipt: &ReceiptV2): address               { receipt.recipient }
public fun amount_usd(receipt: &ReceiptV2): u64                  { receipt.amount_usd }
public fun target_currency(receipt: &ReceiptV2): &String         { &receipt.target_currency }
public fun target_amount(receipt: &ReceiptV2): u64               { receipt.target_amount }
public fun fx_rate(receipt: &ReceiptV2): u64                     { receipt.fx_rate_usd_local }
public fun settled_at(receipt: &ReceiptV2): u64                  { receipt.settled_at }
public fun tx_digest(receipt: &ReceiptV2): &String               { &receipt.tx_digest }
public fun audit_anchor_id(receipt: &ReceiptV2): &Option<String> { &receipt.audit_anchor_id }
public fun business_account_id(receipt: &ReceiptV2): address     { receipt.business_account_id }
public fun minter(receipt: &ReceiptV2): address                  { receipt.minter }

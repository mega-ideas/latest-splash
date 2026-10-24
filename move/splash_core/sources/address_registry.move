/// The address registries, and the kind a payment is charged as (Amendment
/// A1 §2.3).
///
/// A payment's kind decides its fee (`fee_config`), so the kind is DERIVED
/// from where the money goes, not taken from what the intent declares. Two
/// registries classify addresses:
///
///   * business wallets: every account's current business wallet, written by
///     `business_account::register_wallet` and by a confirmed rotation
///     (`confirm_wallet_rotation`), which clears the old wallet. Nothing else
///     writes it. A payment to one is a Splash-business payment, free inside
///     the network, whatever it declared.
///   * partner deposit addresses: the payout partners' fixed deposit
///     addresses, managed by Splash's ops capability (`OpsCap`). A change
///     takes effect at once and emits an event. A payment to one is a bank
///     payout whatever it declared, so the bank fee cannot be dodged by
///     declaring a wallet.
///
/// The registries only classify. They hold no address any payment is sent
/// to: every settle path pays the intent's own recipient, so the worst a
/// stolen OpsCap can do is change which schedule a payment is charged on
/// (still under the 100 bps ceiling and the payer's `max_fee`) or make a
/// declared bank payout to a removed address abort. It can never redirect
/// funds.
///
/// One `Registry`, shared at publish. Settlement reads it (`&`), so payments
/// do not contend on it; only registrations, rotations and ops changes write.
module splash_core::address_registry;

use splash_core::fee_config;
use sui::event;
use sui::table::{Self, Table};

// ─── Abort codes (1400-block) ──────────────────────────────────────────────
/// The kind the payment declares does not fit where it goes: a CCTP payment
/// that is not cross-chain, a bank payout to an address that is not a partner
/// deposit address, a Splash-business payment to an address that is not a
/// business wallet, or a cross-chain kind outside CCTP.
const E_KIND_MISMATCH: u64 = 1400;
/// The address is already a partner deposit address.
const E_ALREADY_A_PARTNER_ADDRESS: u64 = 1401;
/// The address is not a partner deposit address.
const E_NOT_A_PARTNER_ADDRESS: u64 = 1402;
/// The zero address is never a partner deposit address.
const E_INVALID_ADDRESS: u64 = 1403;

public struct Registry has key {
    id: UID,
    /// Each address that is some account's current business wallet, with the
    /// number of accounts it is the wallet of (one, in practice).
    business_wallets: Table<address, u64>,
    /// The payout partners' deposit addresses.
    partner_addresses: Table<address, bool>,
}

/// Splash's ops authority over the partner deposit-address registry. Minted
/// once, at publish; `store` so it can be transferred to the ops multisig.
public struct OpsCap has key, store {
    id: UID,
}

public struct PartnerAddressAdded has copy, drop {
    partner_address: address,
}

public struct PartnerAddressRemoved has copy, drop {
    partner_address: address,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(new(ctx));
    transfer::transfer(OpsCap { id: object::new(ctx) }, ctx.sender());
}

fun new(ctx: &mut TxContext): Registry {
    Registry { id: object::new(ctx), business_wallets: table::new(ctx), partner_addresses: table::new(ctx) }
}

// ─── The kind (A1 §2.3) ────────────────────────────────────────────────────

/// The kind a payment to `recipient` is charged as.
///
/// `declared` is what the payer says it is: on the owners' own path the
/// intent's kind; under a spending rule the recipient's tag in the
/// `SpendPolicy`. `via_cctp` is true on the cross-chain path.
public fun derive_kind(reg: &Registry, recipient: address, declared: u8, via_cctp: bool): u8 {
    if (via_cctp) {
        assert!(declared == fee_config::kind_cross_chain(), E_KIND_MISMATCH);
        return fee_config::kind_cross_chain()
    };
    // Free inside the network.
    if (is_business_wallet(reg, recipient)) return fee_config::kind_splash_business();
    // Cannot be dodged by declaring a wallet.
    if (is_partner_address(reg, recipient)) return fee_config::kind_bank_payout();
    assert!(declared == fee_config::kind_wallet() || declared == fee_config::kind_exchange(), E_KIND_MISMATCH);
    declared
}

// ─── Partner deposit addresses: Splash ops, immediate, evented ─────────────

public fun add_partner_address(_: &OpsCap, reg: &mut Registry, partner_address: address) {
    assert!(partner_address != @0x0, E_INVALID_ADDRESS);
    assert!(!reg.partner_addresses.contains(partner_address), E_ALREADY_A_PARTNER_ADDRESS);
    reg.partner_addresses.add(partner_address, true);
    event::emit(PartnerAddressAdded { partner_address });
}

public fun remove_partner_address(_: &OpsCap, reg: &mut Registry, partner_address: address) {
    assert!(reg.partner_addresses.contains(partner_address), E_NOT_A_PARTNER_ADDRESS);
    let _ = reg.partner_addresses.remove(partner_address);
    event::emit(PartnerAddressRemoved { partner_address });
}

// ─── Business wallets: written only by business_account ────────────────────

/// `wallet` became an account's business wallet.
public(package) fun add_business_wallet(reg: &mut Registry, wallet: address) {
    if (reg.business_wallets.contains(wallet)) {
        let n = reg.business_wallets.borrow_mut(wallet);
        *n = *n + 1;
    } else {
        reg.business_wallets.add(wallet, 1);
    }
}

/// `wallet` stopped being an account's business wallet. An address not in
/// the registry is left alone rather than aborting, so a rotation can never
/// be blocked here.
public(package) fun remove_business_wallet(reg: &mut Registry, wallet: address) {
    if (!reg.business_wallets.contains(wallet)) return;
    let n = *reg.business_wallets.borrow(wallet);
    if (n <= 1) {
        let _ = reg.business_wallets.remove(wallet);
    } else {
        *reg.business_wallets.borrow_mut(wallet) = n - 1;
    }
}

// ─── Views ─────────────────────────────────────────────────────────────────

public fun is_business_wallet(reg: &Registry, addr: address): bool { reg.business_wallets.contains(addr) }
public fun is_partner_address(reg: &Registry, addr: address): bool { reg.partner_addresses.contains(addr) }

// ─── Test-only ─────────────────────────────────────────────────────────────

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }

#[test_only]
public fun new_for_testing(ctx: &mut TxContext): Registry { new(ctx) }

#[test_only]
public fun share_for_testing(reg: Registry) { transfer::share_object(reg) }

#[test_only]
public fun destroy_for_testing(reg: Registry) {
    let Registry { id, business_wallets, partner_addresses } = reg;
    business_wallets.drop();
    partner_addresses.drop();
    id.delete();
}

#[test_only]
public fun ops_cap_for_testing(ctx: &mut TxContext): OpsCap { OpsCap { id: object::new(ctx) } }

#[test_only]
public fun destroy_ops_cap_for_testing(cap: OpsCap) {
    let OpsCap { id } = cap;
    id.delete();
}

/// For tests, in this package and in splash_spend, that need an address to
/// be a business wallet without registering an account's wallet.
#[test_only]
public fun add_business_wallet_for_testing(reg: &mut Registry, wallet: address) { add_business_wallet(reg, wallet) }

#[test_only]
public fun remove_business_wallet_for_testing(reg: &mut Registry, wallet: address) {
    remove_business_wallet(reg, wallet)
}

#[test_only]
public fun unpack_partner_address_added_for_testing(e: PartnerAddressAdded): address {
    let PartnerAddressAdded { partner_address } = e;
    partner_address
}

#[test_only]
public fun unpack_partner_address_removed_for_testing(e: PartnerAddressRemoved): address {
    let PartnerAddressRemoved { partner_address } = e;
    partner_address
}

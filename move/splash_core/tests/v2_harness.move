/// Shared set-up for the v2 tests: a verified account whose owners are the
/// three Phase 0 passkeys, its 2-of-3 business wallet registered, the one
/// `ComplianceConfig` accepting a test USDC, the `FeeConfig` at A1's launch
/// schedule paying `fee_recipient()`, the address `Registry`, and a shared
/// clock.
///
/// Tests that are not about Splash's fee settle through `confirm`,
/// `confirm_balance`, `confirm_cross_chain` and `settle_app` below: each
/// passes a scratch FeeConfig that charges nothing and a scratch Registry that
/// classifies the intent's recipient as the kind it declares, so the
/// settlement under test is exactly the one it was before the fee. The fee
/// tests (`fee_settle_tests`) use the shared FeeConfig and Registry.
///
/// Move tests do not check signatures, so a test acts as the multisig simply
/// by sending as its address. What the chain would check (that the sender is
/// the address these members derive) is exactly what the code under test
/// asserts.
#[test_only]
#[allow(implicit_const_copy)]
module splash_core::v2_harness;

use splash_core::address_registry::{Self, Registry};
use splash_core::business_account::{Self, BusinessAccount};
use splash_core::cap_registry;
use splash_core::compliance_config::{Self, ComplianceConfig};
use splash_core::fee_config::{Self, FeeConfig};
use splash_core::payment_intent::{Self, BridgeObligation, PaymentIntent, SettleReceipt};
use std::string::String;
use sui::balance::Balance;
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts, Scenario};

/// The settlement asset under test. Six decimals, like USDC.
public struct USDC has drop {}

// The Phase 0 passkeys (flag || compressed key) and their own addresses.
const PASSKEY_1: vector<u8> = x"060355969b344645e48573e045cdbf4cbb0adb4369d411962cfc8a6ae3c33b8acf16";
const PASSKEY_2: vector<u8> = x"06025cb0f7961afbdc293a3cd22290d86697bcceb402011804a4e72119960f2741f9";
const PASSKEY_3: vector<u8> = x"060399ca5c2f751fbe57d9e493e174085dee6144965b20fd5895e28902fb1148e04a";
const OWNER_1: address = @0xf22bbbc884a1184c6f3da3fff986c2f05c977e70a142ee8e2550b22a33890253;
const OWNER_2: address = @0xed53becafe1911c288e33fa008d03e86b63131e55e226abe103e47dce34e61fa;
const OWNER_3: address = @0xcfbaedef6b0b04e2fa6e40f6981aa3257e9cdbc097738346e75533f423fff067;
/// The 2-of-3 of the three passkeys (`multisig_tests::PHASE0_PASSKEY_2_OF_3`).
const WALLET: address = @0xafea5352bb6313c6af89594eac518d24049e5bc6dfd4bbc18a14bf191f82b6b5;

const RECIPIENT: address = @0xB0B;
const DAY: u64 = 86_400_000;
const COMMITMENT: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const RAIL: vector<u8> = x"ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";
const BENEFICIARY: vector<u8> = x"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/// 100 USDC: above the 99 USDC bank-payout floor, under every Tier 3 ceiling.
const AMOUNT: u64 = 100_000_000;
const QUOTE_MS: u64 = 300_000;
/// Where the shared FeeConfig sends Splash's fee: the finance multisig.
const FEE_RECIPIENT: address = @0xFEE5;

public fun owner_1(): address { OWNER_1 }
public fun owner_2(): address { OWNER_2 }
public fun owner_3(): address { OWNER_3 }
public fun founder(): address { OWNER_1 }
public fun wallet(): address { WALLET }
public fun recipient(): address { RECIPIENT }
public fun day(): u64 { DAY }
public fun commitment(): vector<u8> { COMMITMENT }
public fun rail(): vector<u8> { RAIL }
public fun beneficiary(): vector<u8> { BENEFICIARY }
public fun amount(): u64 { AMOUNT }
public fun keys(): vector<vector<u8>> { vector[PASSKEY_1, PASSKEY_2, PASSKEY_3] }
public fun passkey(i: u64): vector<u8> { keys()[i] }
public fun weights(): vector<u8> { vector[1, 1, 1] }
public fun threshold(): u16 { 2 }
public fun fee_recipient(): address { FEE_RECIPIENT }

/// A distinct 32-byte payment reference for each `n`.
public fun payment_ref(n: u8): vector<u8> {
    let mut r = x"0000000000000000000000000000000000000000000000000000000000000000";
    *&mut r[31] = n;
    *&mut r[0] = 0xAA;
    r
}

/// Clock at day one; the account submitted by the founder, verified, with
/// owners 2 and 3 added; the config and the address registry created; NO
/// wallet yet.
public fun setup_without_wallet(): Scenario {
    let mut s = ts::begin(OWNER_1);
    {
        let ctx = s.ctx();
        let mut c = clock::create_for_testing(ctx);
        c.set_for_testing(DAY);
        clock::share_for_testing(c);
    };
    s.next_tx(OWNER_1);
    {
        let c = s.take_shared<Clock>();
        business_account::submit_application(b"SSM-202401012345".to_string(), b"bafy-kyb".to_string(), &c, s.ctx());
        ts::return_shared(c);
    };
    s.next_tx(OWNER_1);
    {
        let mut account = s.take_shared<BusinessAccount>();
        let ctx = s.ctx();
        let admin = business_account::admin_cap_for_testing(ctx);
        business_account::verify_business(&admin, &mut account, 20);
        business_account::add_owner(&mut account, OWNER_2, ctx);
        business_account::add_owner(&mut account, OWNER_3, ctx);
        let registry = cap_registry::new_for_testing(ctx);
        compliance_config::create<USDC>(
            compliance_config::ticket_for_testing(ctx),
            &admin,
            &registry,
            5_000,
            60_000,
            50,
            1_000_000,
            1_000_000,
            vector[object::id_from_address(@0xF001)],
            ctx,
        );
        cap_registry::share_for_testing(registry);
        address_registry::share_for_testing(address_registry::new_for_testing(ctx));
        fee_config::share_for_testing(fee_config::new_for_testing(FEE_RECIPIENT, ctx));
        business_account::destroy_admin_cap_for_testing(admin);
        ts::return_shared(account);
    };
    s
}

/// `setup_without_wallet`, then the founder nominates and the 2-of-3
/// registers itself.
public fun setup(): Scenario {
    let mut s = setup_without_wallet();
    register_wallet(&mut s);
    s
}

public fun register_wallet(s: &mut Scenario) {
    s.next_tx(OWNER_1);
    {
        let mut account = s.take_shared<BusinessAccount>();
        business_account::nominate_wallet(&mut account, WALLET, false, s.ctx());
        ts::return_shared(account);
    };
    s.next_tx(WALLET);
    {
        let mut account = s.take_shared<BusinessAccount>();
        let mut reg = s.take_shared<Registry>();
        business_account::register_wallet(&mut account, &mut reg, keys(), weights(), threshold(), false, s.ctx());
        ts::return_shared(reg);
        ts::return_shared(account);
    };
}

/// `new_wallet` confirms the pending rotation of the (most recent) account.
public fun confirm_rotation(s: &mut Scenario, new_wallet: address) {
    s.next_tx(new_wallet);
    let mut account = s.take_shared<BusinessAccount>();
    let mut reg = s.take_shared<Registry>();
    business_account::confirm_wallet_rotation(&mut account, &mut reg, s.ctx());
    ts::return_shared(reg);
    ts::return_shared(account);
}

/// The wallet opens a bank payout for `amount` and returns it by value.
public fun wallet_intent(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    payment_intent::create_for_wallet<USDC>(
        account,
        config,
        payment_ref(n),
        RECIPIENT,
        BENEFICIARY,
        amount,
        b"PHP".to_string(),
        56_000_000,
        COMMITMENT,
        payment_intent::kind_bank_payout(),
        RAIL,
        clock.timestamp_ms() + QUOTE_MS,
        clock,
        ctx,
    )
}

/// The wallet opens an intent of any Sui kind to `to`.
public fun wallet_intent_of_kind(
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    n: u8,
    kind: u8,
    to: address,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): PaymentIntent {
    let beneficiary = if (kind == payment_intent::kind_bank_payout()) BENEFICIARY else vector[];
    let currency: String = if (kind == payment_intent::kind_bank_payout()) b"PHP".to_string() else b"USDC".to_string();
    payment_intent::create_for_wallet<USDC>(
        account,
        config,
        payment_ref(n),
        to,
        beneficiary,
        amount,
        currency,
        56_000_000,
        COMMITMENT,
        kind,
        RAIL,
        clock.timestamp_ms() + QUOTE_MS,
        clock,
        ctx,
    )
}

public fun usdc(amount: u64, ctx: &mut TxContext): Coin<USDC> {
    coin::mint_for_testing<USDC>(amount, ctx)
}

/// Settle-by a little in the future of `clock`: the quote is still good.
public fun settle_by(clock: &Clock): u64 { clock.timestamp_ms() + QUOTE_MS }

// ─── Settling with no fee (tests not about the fee) ────────────────────────

/// A FeeConfig that charges nothing on any kind.
public fun scratch_fees(ctx: &mut TxContext): FeeConfig { fee_config::zero_for_testing(FEE_RECIPIENT, ctx) }

/// A Registry in which `recipient` is what `kind` says it is: a partner
/// deposit address for a bank payout, a business wallet for a Splash-business
/// payment, and nothing for the rest.
public fun scratch_registry(kind: u8, recipient: address, ctx: &mut TxContext): Registry {
    let mut reg = address_registry::new_for_testing(ctx);
    if (kind == payment_intent::kind_bank_payout()) {
        let cap = address_registry::ops_cap_for_testing(ctx);
        address_registry::add_partner_address(&cap, &mut reg, recipient);
        address_registry::destroy_ops_cap_for_testing(cap);
    } else if (kind == payment_intent::kind_splash_business()) {
        address_registry::add_business_wallet_for_testing(&mut reg, recipient);
    };
    reg
}

/// The scratch Registry for `intent`.
public fun scratch_registry_for(intent: &PaymentIntent, ctx: &mut TxContext): Registry {
    scratch_registry(payment_intent::kind(intent), payment_intent::recipient(intent), ctx)
}

public fun drop_scratch(fees: FeeConfig, reg: Registry) {
    fee_config::destroy_for_testing(fees);
    address_registry::destroy_for_testing(reg);
}

/// `confirm_from_business_wallet` with no fee (max_fee 0).
public fun confirm<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    payment: Coin<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    let fees = scratch_fees(ctx);
    let reg = scratch_registry_for(intent, ctx);
    let receipt = payment_intent::confirm_from_business_wallet(
        intent, account, config, &fees, &reg, payment, 0, settle_by_ms, clock, ctx,
    );
    drop_scratch(fees, reg);
    receipt
}

/// `confirm_from_business_wallet_balance` with no fee (max_fee 0).
public fun confirm_balance<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    payment: Balance<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    let fees = scratch_fees(ctx);
    let reg = scratch_registry_for(intent, ctx);
    let receipt = payment_intent::confirm_from_business_wallet_balance(
        intent, account, config, &fees, &reg, payment, 0, settle_by_ms, clock, ctx,
    );
    drop_scratch(fees, reg);
    receipt
}

/// `confirm_cross_chain_from_business_wallet` with no fee (max_fee 0).
public fun confirm_cross_chain<T>(
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    payment: Coin<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): (SettleReceipt, Coin<T>, BridgeObligation) {
    let fees = scratch_fees(ctx);
    let reg = scratch_registry_for(intent, ctx);
    let (receipt, coin, obligation) = payment_intent::confirm_cross_chain_from_business_wallet(
        intent, account, config, &fees, &reg, payment, 0, settle_by_ms, clock, ctx,
    );
    drop_scratch(fees, reg);
    (receipt, coin, obligation)
}

/// `settle_from_app` with no fee: the app declares the intent's own kind and
/// draws exactly the principal (max_fee 0).
public fun settle_app<T, W: drop>(
    witness: W,
    intent: &mut PaymentIntent,
    account: &mut BusinessAccount,
    config: &ComplianceConfig,
    funds: Balance<T>,
    settle_by_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SettleReceipt {
    let fees = scratch_fees(ctx);
    let reg = scratch_registry_for(intent, ctx);
    let declared = payment_intent::kind(intent);
    let (receipt, _, _) = payment_intent::settle_from_app<T, W>(
        witness, intent, account, config, &fees, &reg, declared, funds, 0, settle_by_ms, clock, ctx,
    );
    drop_scratch(fees, reg);
    receipt
}

// ─── The shared FeeConfig and Registry (the fee tests) ─────────────────────

/// Splash ops registers `addr` as a payout partner's deposit address.
public fun add_partner(s: &mut Scenario, addr: address) {
    s.next_tx(OWNER_1);
    let mut reg = s.take_shared<Registry>();
    let cap = address_registry::ops_cap_for_testing(s.ctx());
    address_registry::add_partner_address(&cap, &mut reg, addr);
    address_registry::destroy_ops_cap_for_testing(cap);
    ts::return_shared(reg);
}

public fun remove_partner(s: &mut Scenario, addr: address) {
    s.next_tx(OWNER_1);
    let mut reg = s.take_shared<Registry>();
    let cap = address_registry::ops_cap_for_testing(s.ctx());
    address_registry::remove_partner_address(&cap, &mut reg, addr);
    address_registry::destroy_ops_cap_for_testing(cap);
    ts::return_shared(reg);
}

/// `addr` counts as another account's business wallet. Returns it.
public fun add_business_wallet(s: &mut Scenario, addr: address): address {
    s.next_tx(OWNER_1);
    let mut reg = s.take_shared<Registry>();
    address_registry::add_business_wallet_for_testing(&mut reg, addr);
    ts::return_shared(reg);
    addr
}

/// Governance gives `business` a discount, at once.
public fun set_discount(s: &mut Scenario, business: ID, discount_bps: u16) {
    s.next_tx(OWNER_1);
    let mut fees = s.take_shared<FeeConfig>();
    let cap = fee_config::fee_admin_cap_for_testing(s.ctx());
    fee_config::set_discount(&cap, &mut fees, business, discount_bps);
    fee_config::destroy_fee_admin_cap_for_testing(cap);
    ts::return_shared(fees);
}

/// Put the shared FeeConfig back in its state at publish: no fee recipient
/// applied, so Splash's fees are off (FIXUP 1). The schedule is untouched.
public fun turn_fees_off(s: &mut Scenario) {
    s.next_tx(OWNER_1);
    let mut fees = s.take_shared<FeeConfig>();
    fee_config::clear_fee_recipient_for_testing(&mut fees);
    ts::return_shared(fees);
}

/// Governance changes the fee recipient through the 24-hour path. Moves the
/// clock on 24 hours.
public fun change_fee_recipient(s: &mut Scenario, recipient: address) {
    s.next_tx(OWNER_1);
    {
        let mut fees = s.take_shared<FeeConfig>();
        let mut c = s.take_shared<Clock>();
        let cap = fee_config::fee_admin_cap_for_testing(s.ctx());
        fee_config::propose_fee_recipient(&cap, &mut fees, recipient, &c);
        c.increment_for_testing(fee_config::fee_notice_ms());
        fee_config::apply_fee_recipient(&cap, &mut fees, &c);
        fee_config::destroy_fee_admin_cap_for_testing(cap);
        ts::return_shared(c);
        ts::return_shared(fees);
    };
}

/// Governance changes `kind`'s schedule through the 24-hour path. Moves the
/// clock on 24 hours.
public fun change_schedule(
    s: &mut Scenario,
    kind: u8,
    uppers: vector<u64>,
    rates: vector<u64>,
    min_minor: u64,
    max_minor: u64,
) {
    s.next_tx(OWNER_1);
    {
        let mut fees = s.take_shared<FeeConfig>();
        let mut c = s.take_shared<Clock>();
        let cap = fee_config::fee_admin_cap_for_testing(s.ctx());
        fee_config::propose_schedule(&cap, &mut fees, kind, uppers, rates, min_minor, max_minor, &c);
        c.increment_for_testing(fee_config::fee_notice_ms());
        fee_config::apply_schedule(&cap, &mut fees, kind, &c);
        fee_config::destroy_fee_admin_cap_for_testing(cap);
        ts::return_shared(c);
        ts::return_shared(fees);
    };
}
